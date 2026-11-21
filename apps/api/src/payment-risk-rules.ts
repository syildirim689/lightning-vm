// Pure rules of the payment risk helpers (no database; unit-tested in test/payment-risk-rules.test.mjs).
// For the customer: the next renewal will not go through as things stand (the saved card expires before it, or the
// balance the account pays from does not cover it). For staff: which accounts are worth a look, ordered by the money
// at risk. Nothing here charges, suspends or contacts anyone.

export const riskRule = {
  lookaheadDays: 30,   // a renewal further away than this is not warned about yet
  failedDays: 30,      // failed charges are counted over this many days
  minFailures: 2,      // "repeated": at least this many failed charges in that time
  growthDays: 7,       // overdue is "growing" when part of it became overdue within this many days and part is older
};

export type Card = { last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean };
// A card is good through the last day of its expiry month. Without an expiry date nothing is concluded.
export function cardExpiresBefore(c: Pick<Card, 'expMonth' | 'expYear'>, at: Date): boolean {
  if (!c.expMonth || !c.expYear || c.expMonth < 1 || c.expMonth > 12) return false;
  const year = c.expYear < 100 ? 2000 + c.expYear : c.expYear;
  return Date.UTC(year, c.expMonth, 1) <= at.getTime(); // the first moment of the month after it
}

export type RenewalRisk =
  | { at: string; amount: number; currency: string; last4: string; expiry: string; kind: 'CARD_EXPIRES_BEFORE_RENEWAL' }
  | { at: string; amount: number; currency: string; balance: number; short: number; kind: 'RENEWAL_NOT_COVERED' };

// renewal: the next one as billing will invoice it (billing.ts, nextRenewal), null when there is none or its invoice
// exists already (that invoice has its own reminders). balance: what the account holds in the renewal's currency.
// - Saved cards, and every one of them expires before the renewal: the card it would be charged to is named.
// - No card that lasts, and a balance that is there but smaller than the renewal: the shortfall is named.
// An account with neither a card nor a balance pays its invoices by hand; nothing is said to it.
export function renewalRisks(o: { renewal: { at: Date; amount: number; currency: string; invoiced?: boolean } | null; cards: Card[]; balance: number; now: Date }, rule = riskRule): RenewalRisk[] {
  const r = o.renewal;
  if (!r || r.invoiced || !(r.amount > 0)) return [];
  const days = (r.at.getTime() - o.now.getTime()) / 86_400_000;
  if (days > rule.lookaheadDays || days < 0) return [];
  const out: RenewalRisk[] = [];
  const base = { at: r.at.toISOString(), amount: r.amount, currency: r.currency };
  const lasting = o.cards.filter((c) => !cardExpiresBefore(c, r.at));
  const covered = o.balance >= r.amount;
  if (o.cards.length && !lasting.length && !covered) {
    const c = o.cards.find((x) => x.isDefault) ?? o.cards[0];
    const year = (c.expYear ?? 0) < 100 ? 2000 + (c.expYear ?? 0) : c.expYear ?? 0;
    out.push({ ...base, last4: c.last4 ?? '', expiry: `${String(c.expMonth).padStart(2, '0')}/${String(year).slice(-2)}`, kind: 'CARD_EXPIRES_BEFORE_RENEWAL' });
  }
  if (!lasting.length && o.balance > 0 && !covered) out.push({ ...base, balance: Math.round(o.balance * 100) / 100, short: Math.round((r.amount - o.balance) * 100) / 100, kind: 'RENEWAL_NOT_COVERED' });
  return out;
}

// One account and currency as the database counts it (payment-risk.ts).
export type RiskFacts = { userId: string; email: string; currency: string; overdue: number; overdueCount: number; oldestDays: number; newOverdue: number; failedCharges: number; failedAmount: number };
export type RiskRow = RiskFacts & { atRisk: number; reasons: ('OVERDUE' | 'OVERDUE_GROWING' | 'REPEATED_FAILURES')[] };

// Listed: an account with something overdue, or with repeated failed charges. At risk: what is overdue, or, with
// nothing overdue yet, the open amount the failed charges were for. Ordered by that amount, largest first (amounts in
// different currencies are compared as numbers: the list is a queue to look through, not a sum).
export function rankRisk(rows: RiskFacts[], rule = riskRule): RiskRow[] {
  return rows.map((r) => {
    const reasons: RiskRow['reasons'] = [];
    if (r.overdue > 0) reasons.push(r.newOverdue > 0 && r.newOverdue < r.overdue ? 'OVERDUE_GROWING' : 'OVERDUE');
    if (r.failedCharges >= rule.minFailures) reasons.push('REPEATED_FAILURES');
    return { ...r, atRisk: Math.round((r.overdue > 0 ? r.overdue : r.failedAmount) * 100) / 100, reasons };
  }).filter((r) => r.reasons.length > 0).sort((a, b) => b.atRisk - a.atRisk || b.oldestDays - a.oldestDays || a.email.localeCompare(b.email));
}
