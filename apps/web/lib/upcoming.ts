// What the customer will be charged next, picked from what the API already answers: the billing summary
// (subscriptions, pay-as-you-go balance and burn rate) and the invoice list. Plain data in, plain data out.
export type UpcomingSubscription = { id: string; serverId: string | null; description: string; amount: string; currency: string; periodMonths: number; status: string;
  periodEnd: string | null; cancelAtPeriodEnd: boolean };
export type UpcomingInvoice = { id: string; number: string | null; kind: string; status: string; currency: string; total: string; paidTotal: string; dueAt: string; overdue: boolean };
export type UpcomingHourly = { servers: unknown[]; available: { currency: string; amount: string; perHour: string }[] };

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type Renewal = { at: string; amount: number; currency: string; items: { id: string; serverId: string | null; description: string }[] };
// The next renewal: the earliest period end among subscriptions that will renew (not cancelled at period end),
// together with every other one in the same currency that renews within a day of it. A period that ends today
// still counts; one that ended earlier has its invoice already.
export function nextRenewal(subscriptions: UpcomingSubscription[], now: number): Renewal | null {
  const live = subscriptions
    .filter((s) => ['active', 'past_due', 'suspended'].includes(s.status) && !s.cancelAtPeriodEnd && s.periodEnd)
    .map((s) => ({ s, at: Date.parse(s.periodEnd!) }))
    .filter((x) => Number.isFinite(x.at) && x.at >= now - DAY && Number.isFinite(Number(x.s.amount)))
    .sort((a, b) => a.at - b.at);
  const first = live[0];
  if (!first) return null;
  const group = live.filter((x) => x.s.currency === first.s.currency && x.at - first.at < DAY);
  return { at: first.s.periodEnd!, currency: first.s.currency, amount: group.reduce((n, x) => n + Number(x.s.amount) * (x.s.periodMonths || 1), 0),
    items: group.map((x) => ({ id: x.s.id, serverId: x.s.serverId, description: x.s.description })) };
}

// What the API itself says the next renewal will charge (billing summary, newer APIs): the amount as it will be
// invoiced (`gross`: tax included), how many servers it covers, and whether its invoice already exists.
export type ApiRenewal = { at: string; amount: number | string; currency: string; gross: boolean; servers: number; invoiced: boolean };
export type RenewalLine = Renewal & { gross: boolean; servers: number };
// The renewal line of "upcoming charges". With the API's own answer: that amount and date, and no line at all once
// the renewal is invoiced (the due invoice is listed instead) or when the API says nothing renews (null). Without
// it (an older API, or an answer that cannot be read): the calculation from the subscriptions, as before.
export function renewalLine(api: ApiRenewal | null | undefined, subscriptions: UpcomingSubscription[], now: number): RenewalLine | null {
  const own = nextRenewal(subscriptions, now);
  const amount = api ? Number(api.amount) : NaN;
  if (api === undefined || (api && (!Number.isFinite(amount) || !Number.isFinite(Date.parse(api.at)) || !api.currency)))
    return own && { ...own, gross: false, servers: own.items.length };
  if (!api || api.invoiced) return null;
  // The names come from the subscriptions when they are about the same charge (same currency, within a day).
  const same = !!own && own.currency === api.currency && Math.abs(Date.parse(own.at) - Date.parse(api.at)) < DAY;
  const items = same ? own.items : [];
  return { at: api.at, amount, currency: api.currency, items, gross: !!api.gross, servers: Number(api.servers) > 0 ? Number(api.servers) : items.length };
}

export type DueInvoice = { id: string; number: string | null; amount: number; currency: string; dueAt: string; overdue: boolean };
// Invoices waiting for payment that are overdue or fall due within `days`, the most pressing first. A balance
// top-up is not a debt and stays out (as in the summary's count).
export function dueInvoices(invoices: UpcomingInvoice[], now: number, days = 7): DueInvoice[] {
  return invoices
    .filter((i) => i.status === 'unpaid' && i.kind !== 'topup')
    .map((i) => ({ id: i.id, number: i.number, amount: Number(i.total) - Number(i.paidTotal || 0), currency: i.currency, dueAt: i.dueAt, overdue: !!i.overdue || Date.parse(i.dueAt) < now }))
    .filter((i) => i.overdue || Date.parse(i.dueAt) <= now + days * DAY)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export type RunOut = { currency: string; amount: number; perHour: number; hours: number; at: number; soon: boolean; empty: boolean };
// Pay as you go: when what is left runs out at the current hourly rate, per currency. `soon` (under three days by
// default) is when a top-up is worth offering; `empty` when nothing is left already.
export function runOut(hourly: UpcomingHourly | null | undefined, now: number, soonHours = 72): RunOut[] {
  if (!hourly?.servers.length) return [];
  return hourly.available.flatMap((a) => {
    const amount = Number(a.amount), perHour = Number(a.perHour);
    if (!Number.isFinite(amount) || !Number.isFinite(perHour) || perHour <= 0) return [];
    const hours = Math.max(0, amount / perHour);
    return [{ currency: a.currency, amount, perHour, hours, at: now + hours * HOUR, soon: hours < soonHours, empty: amount <= 0 }];
  });
}
