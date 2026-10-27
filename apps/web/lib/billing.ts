// Billing as the API returns it (apps/api/src/billing.ts), shared by the customer's and the staff's pages.
import type { Tone } from '../components/ui';

export type InvoiceStatus = 'unpaid' | 'paid' | 'cancelled' | 'refunded' | 'partially_refunded';
export type Invoice = { id: string; number: string | null; kind: 'order' | 'renewal' | 'topup' | 'manual' | 'credit_note'; status: InvoiceStatus; currency: string;
  subtotal: string; taxTotal: string; total: string; paidTotal: string; refundedTotal: string; dueAt: string; paidAt: string | null; issuedAt: string | null; createdAt: string;
  taxExemption: string | null; einvoiceStatus: string; einvoiceProfile: string | null; einvoiceError: string | null; buyerName: string; buyerEmail: string; ownerId: string; overdue: boolean };
export type Party = { kind?: string; name: string; taxId: string; taxOffice: string; address: string; district: string; city: string; country: string; postalCode?: string;
  email?: string; phone?: string; website?: string; mersis?: string; tradeRegistry?: string };
export type Line = { description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; net: string; tax: string; gross: string; periodStart: string | null; periodEnd: string | null };
export type Payment = { id: string; provider: string; mode: string; method: string; status: string; amount: string; currency: string; refunded: string; errorCode: string | null;
  errorMessage: string | null; reference: string | null; automatic: boolean; createdAt: string; completedAt: string | null; email?: string; invoiceId?: string; number?: string | null };
export type InvoiceDetail = { invoice: Invoice & { buyer: Party; seller: Party; note: string | null }; lines: Line[]; payments: Payment[] };
export type Subscription = { id: string; kind: 'server' | 'vdc'; serverId: string | null; vdcId: string | null; description: string; amount: string; currency: string; periodMonths: number;
  status: 'pending' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'ended'; periodStart: string | null; periodEnd: string | null; autoRenew: boolean; cancelAtPeriodEnd: boolean;
  suspendedAt: string | null; createdAt: string; email?: string };
export type Card = { id: string; provider: string; mode: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean };
export type Methods = { cards: { id: string; name: string; mode: string; saved: boolean }[]; balance: boolean; bankTransfer: { bank: string; holder: string; iban: string } | null; topup: { min: number; max: number } };
export type Summary = { enabled: false } | { enabled: true; balance: { currency: string; amount: string }[]; open: { n: number; overdue: number; amount: string; currency: string | null };
  subscriptions: Subscription[]; cards: Card[]; profileComplete: boolean; methods: Methods; autoCharge: boolean; requirePayment: boolean };

// What an invoice's status looks like: awaiting payment (overdue in red), paid, cancelled, refunded.
export const invoiceTone = (i: Pick<Invoice, 'status' | 'overdue'>): Tone =>
  i.status === 'unpaid' ? (i.overdue ? 'danger' : 'warning') : i.status === 'paid' ? 'success' : i.status === 'cancelled' ? 'default' : 'accent';
export const invoiceState = (i: Pick<Invoice, 'status' | 'overdue'>) => (i.status === 'unpaid' && i.overdue ? 'overdue' : i.status);
export const subscriptionTone = (s: Subscription['status']): Tone =>
  ({ active: 'success', pending: 'warning', past_due: 'danger', suspended: 'danger', cancelled: 'default', ended: 'default' } as const)[s];
export const paymentTone = (s: string): Tone => (s === 'succeeded' ? 'success' : s === 'failed' ? 'danger' : s === 'pending' ? 'warning' : 'accent');
