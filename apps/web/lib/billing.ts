// Billing as the API returns it (apps/api/src/billing.ts), shared by the customer's and the staff's pages.
import type { Tone } from '../components/ui';

export type InvoiceStatus = 'unpaid' | 'paid' | 'cancelled' | 'refunded' | 'partially_refunded';
export type Invoice = { id: string; number: string | null; kind: 'order' | 'renewal' | 'topup' | 'manual' | 'credit_note' | 'usage'; status: InvoiceStatus; currency: string;
  subtotal: string; taxTotal: string; total: string; paidTotal: string; refundedTotal: string; dueAt: string; paidAt: string | null; issuedAt: string | null; createdAt: string;
  taxExemption: string | null; einvoiceStatus: string; einvoiceProfile: string | null; einvoiceError: string | null; buyerName: string; buyerEmail: string; ownerId: string; overdue: boolean };
export type Party = { kind?: string; name: string; taxId: string; taxOffice: string; address: string; district: string; city: string; country: string; postalCode?: string;
  email?: string; phone?: string; website?: string; mersis?: string; tradeRegistry?: string };
export type Line = { id?: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; net: string; tax: string; gross: string; periodStart: string | null; periodEnd: string | null };
export type Payment = { id: string; provider: string; mode: string; method: string; status: string; amount: string; currency: string; refunded: string; errorCode: string | null;
  errorMessage: string | null; reference: string | null; automatic: boolean; createdAt: string; completedAt: string | null; email?: string; invoiceId?: string; number?: string | null;
  // Staff lists only: whether the payment waits for a person (review), since when, and what its invoice is now.
  review?: boolean; reviewSince?: string | null; since?: string | null; invoiceStatus?: InvoiceStatus };
// payBlockedUntil: until when a payment under review keeps the invoice from being paid again (null: nothing does).
export type InvoiceDetail = { invoice: Invoice & { buyer: Party; seller: Party; note: string | null; payBlockedUntil?: string | null }; lines: Line[]; payments: Payment[] };
// Whether paying is refused now (the API would answer PAYMENT_IN_REVIEW), by the invoice's own answer.
export const payBlocked = (i: { payBlockedUntil?: string | null }, now = Date.now()) => !!i.payBlockedUntil && Date.parse(i.payBlockedUntil) > now;
export type Subscription = { id: string; kind: 'server' | 'vdc'; serverId: string | null; vdcId: string | null; description: string; amount: string; currency: string; periodMonths: number;
  status: 'pending' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'ended'; periodStart: string | null; periodEnd: string | null; autoRenew: boolean; cancelAtPeriodEnd: boolean;
  suspendedAt: string | null; createdAt: string; email?: string };
export type Card = { id: string; provider: string; providerName?: string; mode: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean };
export type Methods = { cards: { id: string; name: string; mode: string; saved: boolean }[]; balance: boolean; bankTransfer: { bank: string; holder: string; iban: string } | null; topup: { min: number; max: number } };
export type Summary = { enabled: false } | { enabled: true; balance: { currency: string; amount: string }[]; open: { n: number; overdue: number; amount: string; currency: string | null };
  subscriptions: Subscription[]; cards: Card[]; profileComplete: boolean; methods: Methods; autoCharge: boolean; requirePayment: boolean; hourly?: Hourly;
  // The next renewal as the API will invoice it (newer APIs; absent on an older one, null when nothing renews).
  nextRenewal?: { at: string; amount: number | string; currency: string; gross: boolean; servers: number; invoiced: boolean } | null };
// Pay as you go: hourly servers with this month's hours and cost, and what is left to spend per currency.
export type Hourly = { enabled: boolean; minHours: number; servers: { id: string; name: string; priceHourly: string; currency: string; billingHold: boolean; hours: number; amount: string }[];
  available: { currency: string; amount: string; perHour: string }[] };

// What an invoice's status looks like: awaiting payment (overdue in red), paid, cancelled, refunded.
export const invoiceTone = (i: Pick<Invoice, 'status' | 'overdue'>): Tone =>
  i.status === 'unpaid' ? (i.overdue ? 'danger' : 'warning') : i.status === 'paid' ? 'success' : i.status === 'cancelled' ? 'default' : 'accent';
export const invoiceState = (i: Pick<Invoice, 'status' | 'overdue'>) => (i.status === 'unpaid' && i.overdue ? 'overdue' : i.status);
export const subscriptionTone = (s: Subscription['status']): Tone =>
  ({ active: 'success', pending: 'warning', past_due: 'danger', suspended: 'danger', cancelled: 'default', ended: 'default' } as const)[s];

// A payment that waits for staff: the provider holds it, reported another amount, or its return is unconfirmed. It is
// still "pending" in the data; the API marks it (review), and an older API is read from the reason code.
export const reviewCodes = ['NEEDS_CONFIRMATION', 'AMOUNT_MISMATCH', 'FRAUD_REVIEW'] as const;
export type ReviewCode = (typeof reviewCodes)[number];
export const isReviewCode = (c: string | null | undefined): c is ReviewCode => (reviewCodes as readonly string[]).includes(c ?? '');
export const isReview = (p: Pick<Payment, 'status' | 'errorCode' | 'review'>) => p.status === 'pending' && (p.review ?? isReviewCode(p.errorCode));
// What the status chip says: "review" instead of "pending" for those.
export const paymentState = (p: Pick<Payment, 'status' | 'errorCode' | 'review'>) => (isReview(p) ? 'review' : p.status);
// 'review' and 'pending' are both amber (the label tells them apart); a refund reads as neutral news.
export const paymentTone = (s: string): Tone => (s === 'succeeded' ? 'success' : s === 'failed' ? 'danger' : s === 'pending' || s === 'review' ? 'warning' : 'accent');
// Since when a payment waits: the time the API gives, else when the payment was made.
export const waitingSince = (p: Pick<Payment, 'createdAt' | 'reviewSince' | 'since'>) => p.reviewSince ?? p.since ?? p.createdAt;
// How long something has waited, in the largest whole unit ("45 minutes", "3 hours", "2 days"); null when the time
// cannot be read. A moment ahead of this clock (skew) counts as just now.
export function waitedFor(since: string | number | Date | null | undefined, now: number = Date.now()): { unit: 'minute' | 'hour' | 'day'; n: number } | null {
  const at = since == null ? NaN : new Date(since).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return { unit: 'minute', n: minutes };
  if (minutes < 48 * 60) return { unit: 'hour', n: Math.floor(minutes / 60) };
  return { unit: 'day', n: Math.floor(minutes / 1440) };
}

// A subscription's description is written once by the API, with the kind of thing in Turkish before its name
// ("Sunucu web-1", "Sanal veri merkezi Ankara"). What kind it is and the name alone, so the page can say the kind in
// the reader's language; a description of another shape (older data, a manual one) has no kind and is shown as it is.
export function subscriptionName(description: string): { kind: 'server' | 'vdc' | null; name: string } {
  const m = /^(Sunucu|Server|Sanal veri merkezi|Virtual data center) (.+)$/s.exec(description);
  return m ? { kind: m[1] === 'Sunucu' || m[1] === 'Server' ? 'server' : 'vdc', name: m[2] } : { kind: null, name: description };
}
