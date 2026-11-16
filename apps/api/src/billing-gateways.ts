// Taking money: one interface per payment provider (billing.ts calls it; the provider's credentials come from
// payments.ts). checkout() starts a 3D Secure payment the customer finishes on the provider's page and returns
// where to send them; the provider's callback is verified by verify(); chargeSaved() takes a stored card without the
// customer; refund() gives money back. 'sandbox' is the panel's own test provider (cards below), for trying the
// whole flow without an account anywhere.
import { randomBytes } from 'node:crypto';
import { craftgate, iyzico, param, paytr, stripe } from './billing-providers';

export type Buyer = { id: string; name: string; email: string; taxId: string; phone: string; address: string; city: string; country: string; ip: string };
export type Checkout = { paymentId: string; amount: string; currency: string; description: string; buyer: Buyer; saveCard: boolean; returnUrl: string; callbackUrl: string };
// The outcome of a payment: ok with the provider's reference (and the stored card when one was saved), or why not.
export type Result = { ok: true; ref: string; card?: { token: string; brand?: string; last4?: string; expMonth?: number; expYear?: number; holder?: string } }
  | { ok: false; code: string; message?: string; ref?: string };
export type Gateway = {
  // Where the customer goes (or a page to show), and the provider's own reference when it is known only now (Craftgate's token).
  checkout(c: Checkout, creds: Record<string, string>, mode: 'live' | 'test'): Promise<({ redirect: string } | { html: string }) & { providerRef?: string }>;
  verify(input: { query: Record<string, string>; body: Record<string, unknown>; payment: { id: string; amount: string; currency: string; providerRef: string | null } },
    creds: Record<string, string>, mode: 'live' | 'test'): Promise<Result>;
  chargeSaved?(token: string, c: Omit<Checkout, 'returnUrl' | 'callbackUrl' | 'saveCard'>, creds: Record<string, string>, mode: 'live' | 'test'): Promise<Result>;
  refund?(ref: string, amount: string, currency: string, creds: Record<string, string>, mode: 'live' | 'test'): Promise<{ ok: true; ref: string } | { ok: false; code: string; message?: string }>;
  // A server-to-server notification that does not carry our payment id in its URL (PayTR): find it in the body, and the
  // exact text the provider expects back.
  paymentIdFrom?(body: Record<string, unknown>): string | null;
  reply?: string;
  // verify can ask the provider with what the payment itself stores (providerRef), without the customer's browser coming
  // back: the billing run asks again for payments left open (a closed tab after paying).
  recheck?: boolean;
};

// Test cards of the sandbox: 4242 4242 4242 4242 is approved, 4000 0000 0000 0002 declined, 4000 0000 0000 9995
// declined for insufficient funds. A saved sandbox card keeps its last four digits, so it behaves the same later.
export const sandboxCards: Record<string, Result> = {
  '4242424242424242': { ok: true, ref: '' },
  '4000000000000002': { ok: false, code: 'CARD_DECLINED', message: 'The card was declined' },
  '4000000000009995': { ok: false, code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' },
};
export function sandboxPay(card: string, save: boolean): Result {
  const number = card.replace(/\s/g, '');
  const r = sandboxCards[number] ?? { ok: false, code: 'CARD_DECLINED', message: 'Unknown test card' };
  if (!r.ok) return r;
  const ref = `sbx_${randomBytes(8).toString('hex')}`;
  return { ok: true, ref, ...(save && { card: { token: `sandbox:${number.slice(-4)}`, brand: 'Visa', last4: number.slice(-4), expMonth: 12, expYear: new Date().getFullYear() + 3 } }) };
}
export const sandbox: Gateway = {
  // The panel's own test page plays the provider's 3D page.
  async checkout(c) { return { redirect: `/billing/checkout/${c.paymentId}` }; },
  async verify() { return { ok: false, code: 'NOT_SUPPORTED' }; }, // the sandbox page settles directly (billing.ts)
  async chargeSaved(token) {
    const last4 = token.split(':')[1] ?? '';
    const number = Object.keys(sandboxCards).find((n) => n.endsWith(last4)) ?? '';
    return sandboxPay(number, false);
  },
  async refund() { return { ok: true, ref: `sbx_rf_${randomBytes(6).toString('hex')}` }; },
};

// Real providers register here (billing-providers/*.ts); a provider without an entry can be configured but not charge.
export const gateways: Record<string, Gateway> = { sandbox, iyzico, paytr, stripe, craftgate, param };

// Whether a result settles the payment. It does when the provider said paid or failed. It does not when nothing was
// learned: the provider did not answer, the answer was forged or another payment's, the customer is still on the
// provider's page (PENDING), or the request carried nothing to ask the provider with (NO_TOKEN, NO_SESSION: anybody can
// open a payment's return address). Such a payment stays open for the provider's real answer, or until it expires.
export const finalResult = (r: Result) => r.ok || !['PROVIDER_ERROR', 'BAD_SIGNATURE', 'PENDING', 'NO_TOKEN', 'NO_SESSION'].includes(r.code);
