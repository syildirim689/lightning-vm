// A customer's monthly budget: what their servers cost per month (run rate) against the amount they set, in that
// currency. The order page warns before an order goes over; going over notifies them once per calendar month.
import { pool } from './db';
import { notify } from './notify';

export type Budget = { amount: number; currency: string } | null;
export type BudgetState = { amount: number; currency: string; monthly: number; ratio: number; state: 'ok' | 'near' | 'over' } | null;

export async function budgetOf(userId: string): Promise<Budget> {
  const { rows: [u] } = await pool.query('SELECT budget_monthly::float8 AS amount, budget_currency AS currency FROM users WHERE id = $1', [userId]);
  return u?.amount ? { amount: u.amount, currency: u.currency } : null;
}

// The monthly run rate in the budget's currency (servers and virtual data centers), plus what an order would add.
export async function budgetState(userId: string, extra = 0): Promise<BudgetState> {
  const b = await budgetOf(userId);
  if (!b) return null;
  const { rows: [r] } = await pool.query(`SELECT coalesce(sum(p), 0)::float8 AS monthly FROM (
      SELECT price_monthly AS p FROM servers WHERE owner_id = $1 AND state <> 'deleted' AND trim(currency) = $2
      UNION ALL SELECT price_monthly FROM vdcs WHERE owner_id = $1 AND active AND trim(currency) = $2) x`, [userId, b.currency]);
  const monthly = r.monthly + extra;
  const ratio = monthly / b.amount;
  return { ...b, monthly, ratio, state: ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok' };
}

// After the run rate grew (a new server): over budget notifies, at most once per month.
export async function checkBudget(userId: string) {
  const s = await budgetState(userId).catch(() => null);
  if (!s || s.state !== 'over') return;
  const month = new Date().toISOString().slice(0, 7);
  const { rowCount } = await pool.query('UPDATE users SET budget_alerted = $2 WHERE id = $1 AND budget_alerted IS DISTINCT FROM $2', [userId, month]);
  if (rowCount) await notify('billing.budget_exceeded', [userId], { amount: s.amount.toFixed(2), monthly: s.monthly.toFixed(2), currency: s.currency });
}
