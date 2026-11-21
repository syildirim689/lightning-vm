// What this month will cost a customer at the current rate, and the budget measured against that. Servers and
// virtual data centers billed by the month count by the part of the month they exist (smart-rules.ts, monthCost);
// servers billed by the hour count with the usage billing has recorded for this month (server_usage, which keeps the
// hours of servers deleted since) plus their hourly prices for the hours the month still has. Prices are read from
// where billing keeps them; nothing is priced again here.
// A budget is exceeded "by forecast" when that total passes it, which a run rate under the budget does not rule out
// (hourly usage, servers deleted after they cost money): the customer is told once per month, and it is an insight.
import { budgetOf, BUDGET_NEAR, type BudgetState } from './budget';
import { pool, redis } from './db';
import { logEvent } from './log';
import { notify } from './notify';
import { restoreHold } from './restore-hold';
import { budgetLevel, monthForecast, type MonthForecast } from './forecast-rules';

export type CurrencyForecast = MonthForecast & { currency: string };
export type BudgetForecast = NonNullable<BudgetState> & { forecast: number; forecastRatio: number; forecastState: 'ok' | 'near' | 'over' };

export async function costForecast(userId: string, now = new Date()): Promise<CurrencyForecast[]> {
  // The UTC month, as the proration and the hours left below are counted (forecast-rules.ts). Billing books usage by its
  // own calendar (Istanbul days), which is a month ahead for the last three hours of a UTC month: read by billing's
  // month, those hours showed next month's usage (nearly nothing) beside this month's remaining hours.
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const [{ rows: fixed }, { rows: hourly }, { rows: used }] = await Promise.all([
    pool.query(`SELECT price_monthly::float8 AS price, trim(currency) AS currency, created_at FROM servers WHERE owner_id = $1 AND state <> 'deleted' AND price_monthly > 0 AND billing_mode <> 'hourly'
      UNION ALL SELECT price_monthly::float8, trim(currency), created_at FROM vdcs WHERE owner_id = $1 AND active AND price_monthly > 0`, [userId]),
    // A held server that is switched off builds no usage (billing.ts, runHourly): its rate is not projected.
    pool.query(`SELECT price_monthly::float8 AS monthly, price_hourly::float8 AS "perHour", trim(currency) AS currency, (billing_hold AND power_state = 'poweredOff') OR delete_at IS NOT NULL AS stopped
      FROM servers WHERE owner_id = $1 AND billing_mode = 'hourly' AND state NOT IN ('deleted', 'deleting') AND price_hourly IS NOT NULL`, [userId]),
    pool.query('SELECT trim(currency) AS currency, sum(amount)::float8 AS amount, sum(hours)::float8 AS hours FROM server_usage WHERE owner_id = $1 AND month = $2::date GROUP BY 1', [userId, month]),
  ]);
  const currencies = [...new Set([...fixed, ...hourly, ...used].map((r) => r.currency as string))].sort();
  return currencies.map((currency) => {
    const u = used.find((r) => r.currency === currency);
    const live = hourly.filter((r) => r.currency === currency);
    return { currency, ...monthForecast(fixed.filter((r) => r.currency === currency).map((r) => ({ price: r.price, createdAt: new Date(r.created_at) })),
      live.length || u ? { accrued: u?.amount ?? 0, hours: u?.hours ?? 0, perHour: live.filter((r) => !r.stopped).reduce((a, r) => a + r.perHour, 0), monthly: live.reduce((a, r) => a + r.monthly, 0) } : null, now) };
  });
}

// The budget against the run rate (budget.ts, as before) and against the month's forecast in the budget's currency.
export async function budgetForecast(userId: string, state: BudgetState, costs?: CurrencyForecast[]): Promise<BudgetForecast | null> {
  if (!state) return null;
  const forecast = (costs ?? await costForecast(userId)).find((c) => c.currency === state.currency)?.forecast ?? 0;
  return { ...state, forecast, forecastRatio: forecast / state.amount, forecastState: budgetLevel(forecast, state.amount, BUDGET_NEAR) };
}

// Told once per calendar month, and not in a month in which "your budget is exceeded" already went out.
export async function checkBudgetForecast(userId: string, now = new Date()): Promise<boolean> {
  const b = await budgetOf(userId);
  if (!b) return false;
  const c = (await costForecast(userId, now)).find((x) => x.currency === b.currency);
  if (!c || c.forecast <= b.amount) return false;
  const month = now.toISOString().slice(0, 7); // as budget.ts writes budget_alerted
  const { rowCount } = await pool.query('UPDATE users SET budget_forecast_alerted = $2 WHERE id = $1 AND budget_forecast_alerted IS DISTINCT FROM $2 AND budget_alerted IS DISTINCT FROM $2', [userId, month]);
  if (!rowCount) return false;
  await notify('billing.budget_forecast', [userId], { amount: b.amount.toFixed(2), forecast: c.forecast.toFixed(2), accrued: c.accrued.toFixed(2), currency: b.currency, days: String(c.daysLeft) });
  return true;
}

// Every account with a budget that was not warned this month, read 500 at a time in id order. (An account that is
// within its budget is not marked, so "the first 500 not yet warned" was the same 500 at every run: with more
// accounts than that, the rest were never looked at.)
export const BUDGET_FORECAST_HOURS = 6;
export const BUDGET_FORECAST_PAGE = 500;
export async function runBudgetForecasts(now = new Date(), page = BUDGET_FORECAST_PAGE) {
  const month = now.toISOString().slice(0, 7);
  let checked = 0, warned = 0, failed = 0, after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE id > $2 AND budget_monthly IS NOT NULL AND budget_forecast_alerted IS DISTINCT FROM $1 AND budget_alerted IS DISTINCT FROM $1
      AND NOT coalesce(banned, false) AND disabled_at IS NULL ORDER BY id LIMIT $3`, [month, after, page]);
    for (const u of rows) {
      checked++;
      if (await checkBudgetForecast(u.id, now).catch(() => { failed++; return false; })) warned++;
    }
    if (rows.length < page) break;
    after = rows[rows.length - 1].id;
  }
  if (failed) logEvent('error', 'budget_forecast_accounts_failed', { failed });
  return { checked, warned };
}

export function startBudgetForecasts() {
  const run = async () => {
    if (!(await redis.set('lock:budget-forecast', '1', 'EX', 3600, 'NX').catch(() => null))) return;
    // Restored from an older backup: what the database says about this month is from then.
    if (await restoreHold()) return;
    await runBudgetForecasts().catch(() => logEvent('error', 'budget_forecast_failed'));
  };
  setTimeout(run, 5 * 60_000).unref();
  return setInterval(run, BUDGET_FORECAST_HOURS * 3_600_000).unref();
}
