// Payment risk, as the panel shows it (the rules: payment-risk-rules.ts).
// The customer: an insight when the next renewal will not be collected as things stand, because every saved card
// expires before it or the balance the account holds does not cover it. Only where the panel collects automatically
// (billing settings, autoCharge): an account that pays its invoices by hand is told nothing.
// Staff (billing.view): the accounts with overdue invoices or repeated failed charges, ordered by the money at risk.
// Nothing here charges, suspends or contacts anyone; the dunning steps stay where they are (billing.ts).
import { Controller, Get, UseGuards } from '@nestjs/common';
import { balanceOf, upcomingRenewal } from './billing';
import { pool } from './db';
import { rankRisk, renewalRisks, riskRule, type RenewalRisk, type RiskFacts } from './payment-risk-rules';
import { Can, PermissionGuard } from './rbac';

export async function renewalRisksOf(userId: string, now = new Date()): Promise<RenewalRisk[]> {
  const up = await upcomingRenewal(userId);
  if (!up?.autoCharge || !up.renewal) return [];
  const r = up.renewal;
  const [{ rows: cards }, balances] = await Promise.all([
    pool.query('SELECT last4, exp_month AS "expMonth", exp_year AS "expYear", is_default AS "isDefault" FROM saved_cards WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC', [userId]),
    up.balance ? balanceOf(pool, userId) : Promise.resolve([]),
  ]);
  const balance = Number(balances.find((b) => b.currency.trim() === r.currency)?.amount ?? 0);
  return renewalRisks({ renewal: { at: new Date(r.at), amount: Number(r.amount), currency: r.currency, invoiced: r.invoiced }, cards, balance, now });
}

// Per account and currency: what is overdue (unpaid, past its due date, not disputed, top-ups left out), how much of
// it became overdue in the last days, and the failed charges of the last 30 days with the open amount they were for.
// Two grouped statements over indexed columns; at most 200 rows are returned.
export async function riskAccounts(): Promise<ReturnType<typeof rankRisk>> {
  const { rows } = await pool.query(`WITH due AS (
      SELECT owner_id, trim(currency) AS currency, sum(total - paid_total)::float8 AS overdue, count(*)::int AS n,
        floor(extract(epoch FROM now() - min(due_at)) / 86400)::int AS oldest,
        coalesce(sum(total - paid_total) FILTER (WHERE due_at > now() - make_interval(days => $1)), 0)::float8 AS fresh
      FROM invoices WHERE status = 'unpaid' AND kind <> 'topup' AND NOT disputed AND due_at < now() GROUP BY owner_id, trim(currency)),
    failed AS (
      SELECT x.owner_id, x.currency, x.n,
        coalesce((SELECT sum(i.total - i.paid_total) FROM invoices i WHERE i.owner_id = x.owner_id AND trim(i.currency) = x.currency AND i.status = 'unpaid' AND i.kind <> 'topup'
          AND EXISTS (SELECT 1 FROM payments f WHERE f.invoice_id = i.id AND f.status = 'failed' AND f.created_at > now() - make_interval(days => $2))), 0)::float8 AS amount
      FROM (SELECT owner_id, trim(currency) AS currency, count(*)::int AS n FROM payments WHERE status = 'failed' AND created_at > now() - make_interval(days => $2) GROUP BY owner_id, trim(currency)) x)
    SELECT u.id AS "userId", u.email, coalesce(d.currency, f.currency) AS currency, coalesce(d.overdue, 0) AS overdue, coalesce(d.n, 0) AS "overdueCount", coalesce(d.oldest, 0) AS "oldestDays",
      coalesce(d.fresh, 0) AS "newOverdue", coalesce(f.n, 0) AS "failedCharges", coalesce(f.amount, 0) AS "failedAmount"
    FROM due d FULL JOIN failed f ON f.owner_id = d.owner_id AND f.currency = d.currency JOIN users u ON u.id = coalesce(d.owner_id, f.owner_id)
    WHERE coalesce(d.overdue, 0) > 0 OR coalesce(f.n, 0) >= $3`, [riskRule.growthDays, riskRule.failedDays, riskRule.minFailures]);
  return rankRisk(rows as RiskFacts[]).slice(0, 200);
}

@Controller('admin/billing') @UseGuards(PermissionGuard)
export class PaymentRiskController {
  @Get('risk') @Can('billing.view')
  async risk() { return { accounts: await riskAccounts(), rule: riskRule }; }
}
