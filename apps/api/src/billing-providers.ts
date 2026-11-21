// Real card payments (billing-gateways.ts interface) with iyzico, PayTR, Stripe, Craftgate and Param, from
// docs/research-payment-flows.md. Every flow sends the customer to the provider's own page (3D Secure there; the panel never
// sees a card number) and confirms the result with a server-side query to the provider (PayTR: its keyed notification)
// before anything is marked paid. Param's return can be confirmed neither way, so it never marks a payment paid: staff do
// (and once it has put a payment under review, no later return changes that payment: Gateway.unsigned).
// Stored cards are charged without the customer only where the provider stores them from its hosted page (iyzico,
// Stripe, Craftgate) and the merchant account allows non-3D charges; PayTR and Param store cards only through direct card
// forms, so their invoices are paid by the customer on the hosted page. None of these was run against a real merchant
// account during development: try one payment in test mode first.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Gateway, Result } from './billing-gateways';

const timeout = 30_000;
const hmacHex = (key: string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest('hex');
const hmacB64 = (key: string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest('base64');
const cents = (amount: string) => Math.round(Number(amount) * 100);
// Signatures are compared in constant time.
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const fail = (code: string, message?: string, ref?: string): Result => ({ ok: false, code, message: message?.slice(0, 300), ref });
const esc = (s = '') => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const tag = (xml: string, n: string) => new RegExp(`<(?:\\w+:)?${n}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${n}>`).exec(xml)?.[1] ?? '';
const nameParts = (full: string) => { const p = full.trim().split(/\s+/); return { name: p.length > 1 ? p.slice(0, -1).join(' ') : p[0] || 'Müşteri', surname: p.length > 1 ? p.at(-1)! : p[0] || 'Müşteri' }; };
const oid = (paymentId: string) => paymentId.replace(/-/g, ''); // PayTR: letters and digits only
const fromOid = (o: string) => (/^[0-9a-f]{32}$/i.test(o) ? `${o.slice(0, 8)}-${o.slice(8, 12)}-${o.slice(12, 16)}-${o.slice(16, 20)}-${o.slice(20)}` : null);

async function json(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) as Record<string, any> }; } // eslint-disable-line @typescript-eslint/no-explicit-any
  catch { return { status: res.status, body: { raw: text.slice(0, 300) } as Record<string, any> }; } // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---- iyzico: Checkout Form (hosted, 3DS), card storage through it, non-3D charge of a stored card, refunds ----
// iyzico's price format: a decimal without trailing zeros ("10.0" for 10, "10.5" for 10.50), as its SDKs send.
export const iyziPrice = (amount: string) => { const s = Number(amount).toFixed(2).replace(/0+$/, ''); return s.endsWith('.') ? `${s}0` : s; };
async function iyzi(c: Record<string, string>, path: string, payload: object) {
  const body = JSON.stringify(payload);
  const rnd = `${Date.now()}${randomBytes(4).toString('hex')}`;
  const auth = Buffer.from(`apiKey:${c.apiKey}&randomKey:${rnd}&signature:${hmacHex(c.secretKey, rnd + path + body)}`).toString('base64');
  return (await json(c.endpoint + path, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-iyzi-rnd': rnd, authorization: `IYZWSv2 ${auth}` } })).body;
}
const iyziParties = (b: { name: string; email: string; taxId: string; phone: string; address: string; city: string; country: string; ip: string; id: string }) => {
  const n = nameParts(b.name);
  const address = { contactName: b.name, city: b.city || 'Istanbul', country: b.country === 'TR' ? 'Turkey' : b.country, address: b.address || '-' };
  return { buyer: { id: b.id, ...n, identityNumber: /^\d{11}$/.test(b.taxId) ? b.taxId : '11111111111', email: b.email, gsmNumber: b.phone || undefined,
    registrationAddress: address.address, city: address.city, country: address.country, ip: b.ip }, billingAddress: address, shippingAddress: address };
};
export const iyzico: Gateway = {
  recheck: true,
  async checkout(c, creds) {
    const price = iyziPrice(c.amount);
    const r = await iyzi(creds, '/payment/iyzipos/checkoutform/initialize/auth/ecom', { locale: 'tr', conversationId: c.paymentId, price, paidPrice: price, currency: c.currency,
      basketId: c.paymentId, paymentGroup: 'SUBSCRIPTION', callbackUrl: c.callbackUrl, enabledInstallments: [1], forceThreeDS: 1, ...iyziParties(c.buyer),
      basketItems: [{ id: c.paymentId, name: c.description, category1: 'Hosting', itemType: 'VIRTUAL', price }] });
    if (r.status !== 'success' || !r.paymentPageUrl) throw new Error(`iyzico: ${r.errorCode ?? ''} ${r.errorMessage ?? r.raw ?? ''}`.trim());
    // The form's token is kept with the payment: the result can be asked for later without the browser (the billing run).
    return { redirect: r.paymentPageUrl as string, ...(typeof r.token === 'string' && r.token && { providerRef: r.token }) };
  },
  async verify({ body, payment }, creds) {
    // iyzico posts the token back when the form is finished; without that post (the billing run asking) the stored one is used.
    const posted = String(body.token ?? '');
    if (posted && payment.providerRef && posted !== payment.providerRef) return fail('BAD_SIGNATURE', 'Another form’s token');
    const token = posted || payment.providerRef || '';
    if (!token) return fail('NO_TOKEN');
    const r = await iyzi(creds, '/payment/iyzipos/checkoutform/auth/ecom/detail', { locale: 'tr', conversationId: payment.id, token });
    const sig = hmacHex(creds.secretKey, [r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId, r.paidPrice, r.price, r.token].join(':'));
    if (r.signature && !same(String(r.signature), sig)) return fail('BAD_SIGNATURE', 'iyzico signature mismatch');
    // Not paid: final when iyzico says so, or when iyzico itself sent the customer back (the form is finished then).
    // Asked on our own, anything else means the customer has not finished.
    if ((r.status !== 'success' || r.paymentStatus !== 'SUCCESS') && !posted && r.paymentStatus !== 'FAILURE') return fail('PENDING');
    if (r.status !== 'success' || r.paymentStatus !== 'SUCCESS') return fail(r.errorCode ? `IYZICO_${r.errorCode}` : 'CARD_DECLINED', r.errorMessage, r.paymentId);
    if (r.basketId !== payment.id || Math.abs(Number(r.paidPrice) - Number(payment.amount)) > 0.001 || r.currency !== payment.currency) return fail('AMOUNT_MISMATCH', 'The provider reported a different payment', r.paymentId);
    if (r.fraudStatus !== undefined && Number(r.fraudStatus) !== 1) return fail('FRAUD_REVIEW', 'iyzico holds the payment for review', r.paymentId);
    return { ok: true, ref: String(r.paymentId), ...(r.cardUserKey && r.cardToken && { card: { token: `${r.cardUserKey}|${r.cardToken}`, brand: r.cardAssociation, last4: r.lastFourDigits } }) };
  },
  async chargeSaved(token, c, creds) {
    const [cardUserKey, cardToken] = token.split('|');
    const price = iyziPrice(c.amount);
    const r = await iyzi(creds, '/payment/auth', { locale: 'tr', conversationId: c.paymentId, price, paidPrice: price, currency: c.currency, installment: 1, basketId: c.paymentId,
      paymentChannel: 'WEB', paymentGroup: 'SUBSCRIPTION', paymentCard: { cardUserKey, cardToken }, ...iyziParties(c.buyer),
      basketItems: [{ id: c.paymentId, name: c.description, category1: 'Hosting', itemType: 'VIRTUAL', price }] });
    return r.status === 'success' ? { ok: true, ref: String(r.paymentId) } : fail(r.errorCode ? `IYZICO_${r.errorCode}` : 'CARD_DECLINED', r.errorMessage);
  },
  async refund(ref, amount, currency, creds) {
    const r = await iyzi(creds, '/v2/payment/refund', { locale: 'tr', conversationId: `rf${Date.now()}`, paymentId: ref, price: iyziPrice(amount), currency, ip: '127.0.0.1' });
    return r.status === 'success' ? { ok: true, ref: String(r.paymentId ?? ref) } : { ok: false, code: String(r.errorCode ?? 'REFUND_FAILED'), message: r.errorMessage };
  },
};

// ---- PayTR: iFrame API (hosted, 3DS); the result comes to the notification URL set in the PayTR panel ----
export const paytrToken = (key: string, salt: string, parts: (string | number)[]) => hmacB64(key, parts.join('') + salt);
export const paytr: Gateway & { paymentIdFrom(body: Record<string, unknown>): string | null; reply: string } = {
  reply: 'OK',
  paymentIdFrom: (body) => fromOid(String(body.merchant_oid ?? '')),
  async checkout(c, creds, mode) {
    const basket = Buffer.from(JSON.stringify([[c.description, Number(c.amount).toFixed(2), 1]])).toString('base64');
    const f = { merchant_id: creds.merchant_id, user_ip: c.buyer.ip, merchant_oid: oid(c.paymentId), email: c.buyer.email, payment_amount: String(cents(c.amount)), user_basket: basket,
      no_installment: '1', max_installment: '0', currency: c.currency === 'TRY' ? 'TL' : c.currency, test_mode: mode === 'test' ? '1' : '0' };
    const token = paytrToken(creds.merchant_key, creds.merchant_salt, [f.merchant_id, f.user_ip, f.merchant_oid, f.email, f.payment_amount, f.user_basket, f.no_installment, f.max_installment, f.currency, f.test_mode]);
    const res = await fetch(`${creds.endpoint}/odeme/api/get-token`, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...f, paytr_token: token, user_name: c.buyer.name, user_address: c.buyer.address || '-', user_phone: c.buyer.phone || '0000000000',
        merchant_ok_url: c.returnUrl, merchant_fail_url: c.returnUrl, timeout_limit: '30', debug_on: mode === 'test' ? '1' : '0', lang: 'tr' }) });
    const r = await res.json().catch(() => ({})) as { status?: string; token?: string; reason?: string };
    if (r.status !== 'success' || !r.token) throw new Error(`PayTR: ${r.reason ?? `HTTP ${res.status}`}`);
    // PayTR's page lives in an iframe on ours.
    return { html: `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayTR</title>`
      + `<style>body{margin:0;font-family:system-ui;background:#f6f6f6}main{max-width:720px;margin:24px auto;padding:0 12px}iframe{width:100%;border:0;min-height:640px;background:#fff;border-radius:12px}</style></head>`
      + `<body><main><iframe src="https://www.paytr.com/odeme/guvenli/${esc(r.token)}" id="paytriframe" scrolling="no"></iframe></main>`
      + `<script src="https://www.paytr.com/js/iframeResizer.min.js"></script><script>iFrameResize({},'#paytriframe');</script></body></html>` };
  },
  async verify({ body, payment }, creds) {
    // hash = base64(HMAC(merchant_key, merchant_oid + merchant_salt + status + total_amount))
    const hash = hmacB64(creds.merchant_key, `${body.merchant_oid}${creds.merchant_salt}${body.status}${body.total_amount}`);
    if (!same(String(body.hash ?? ''), hash)) return fail('BAD_SIGNATURE', 'PayTR hash mismatch');
    // The notification of another payment (genuine, but sent to this one's address) is not this payment's result.
    if (String(body.merchant_oid ?? '') !== oid(payment.id)) return fail('BAD_SIGNATURE', 'Another payment’s notification');
    if (body.status !== 'success') return fail(`PAYTR_${body.failed_reason_code ?? 'FAILED'}`, String(body.failed_reason_msg ?? ''));
    // total_amount (what was collected) is the figure the hash covers; payment_amount (the order's) is not signed, so it
    // can only lower the verdict, never stand in for the signed one.
    const paid = Math.min(Number(body.total_amount), Number(body.payment_amount ?? body.total_amount));
    if (!Number.isFinite(paid) || paid < cents(payment.amount)) return fail('AMOUNT_MISMATCH', 'PayTR reported a smaller amount');
    return { ok: true, ref: String(body.merchant_oid) };
  },
  async refund(ref, amount, _currency, creds) {
    const r = await fetch(`${creds.endpoint}/odeme/iade`, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ merchant_id: creds.merchant_id, merchant_oid: ref, return_amount: Number(amount).toFixed(2),
        paytr_token: paytrToken(creds.merchant_key, creds.merchant_salt, [creds.merchant_id, ref, Number(amount).toFixed(2)]) }) }).then((x) => x.json()).catch(() => ({})) as { status?: string; err_no?: string; err_msg?: string };
    return r.status === 'success' ? { ok: true, ref } : { ok: false, code: String(r.err_no ?? 'REFUND_FAILED'), message: r.err_msg };
  },
};

// ---- Stripe: Checkout Session (hosted, 3DS), the card kept for off-session charges, refunds ----
async function stripeApi(creds: Record<string, string>, method: string, path: string, form?: Record<string, string>, idem?: string) {
  return (await json(`https://api.stripe.com${path}`, { method, body: form ? new URLSearchParams(form) : undefined,
    headers: { authorization: `Bearer ${creds.secretKey}`, ...(form && { 'content-type': 'application/x-www-form-urlencoded' }), ...(idem && { 'idempotency-key': idem }) } })).body;
}
export const stripe: Gateway = {
  recheck: true,
  async checkout(c, creds) {
    const r = await stripeApi(creds, 'POST', '/v1/checkout/sessions', {
      mode: 'payment', 'line_items[0][price_data][currency]': c.currency.toLowerCase(), 'line_items[0][price_data][unit_amount]': String(cents(c.amount)),
      'line_items[0][price_data][product_data][name]': c.description, 'line_items[0][quantity]': '1', customer_email: c.buyer.email, client_reference_id: c.paymentId,
      'metadata[payment_id]': c.paymentId, 'payment_intent_data[metadata][payment_id]': c.paymentId, customer_creation: 'always',
      ...(c.saveCard && { 'payment_intent_data[setup_future_usage]': 'off_session' }),
      success_url: `${c.callbackUrl}?session_id={CHECKOUT_SESSION_ID}`, cancel_url: c.returnUrl }, c.paymentId);
    if (!r.url) throw new Error(`Stripe: ${r.error?.message ?? 'no checkout url'}`);
    // The session id is kept with the payment: a customer who pays and closes the tab never reaches success_url, and the
    // billing run asks Stripe with it.
    return { redirect: r.url as string, ...(typeof r.id === 'string' && { providerRef: r.id }) };
  },
  async verify({ query, payment }, creds) {
    const id = String(query.session_id ?? payment.providerRef ?? '');
    if (!/^cs_[\w]+$/.test(id)) return fail('NO_SESSION');
    const s = await stripeApi(creds, 'GET', `/v1/checkout/sessions/${id}?expand[]=payment_intent`);
    if (!s.id) return fail('PROVIDER_ERROR', s.error?.message);
    if (s.client_reference_id !== payment.id) return fail('BAD_SIGNATURE', 'Another payment’s session');
    // Not paid: over only when the session expired; while it is open the customer may still pay (or try another card).
    if (s.payment_status !== 'paid') return s.status === 'expired' ? fail('EXPIRED', 'The payment page expired') : fail('PENDING', s.payment_intent?.last_payment_error?.message);
    if (s.amount_total !== cents(payment.amount) || String(s.currency).toUpperCase() !== payment.currency) return fail('AMOUNT_MISMATCH', 'Stripe reported a different amount');
    const pi = s.payment_intent;
    const pm = typeof pi?.payment_method === 'string' ? pi.payment_method : pi?.payment_method?.id;
    return { ok: true, ref: String(pi?.id ?? id), ...(s.customer && pm && pi?.setup_future_usage && { card: { token: `${s.customer}|${pm}` } }) };
  },
  async chargeSaved(token, c, creds) {
    const [customer, pm] = token.split('|');
    const r = await stripeApi(creds, 'POST', '/v1/payment_intents', { amount: String(cents(c.amount)), currency: c.currency.toLowerCase(), customer, payment_method: pm,
      off_session: 'true', confirm: 'true', 'metadata[payment_id]': c.paymentId }, c.paymentId);
    if (r.status === 'succeeded') return { ok: true, ref: String(r.id) };
    return fail(String(r.error?.code ?? r.error?.decline_code ?? 'CARD_DECLINED').toUpperCase(), r.error?.message);
  },
  async refund(ref, amount, _currency, creds) {
    const r = await stripeApi(creds, 'POST', '/v1/refunds', { payment_intent: ref, amount: String(cents(amount)) }, `rf_${ref}_${cents(amount)}_${Date.now()}`);
    return r.id ? { ok: true, ref: String(r.id) } : { ok: false, code: String(r.error?.code ?? 'REFUND_FAILED'), message: r.error?.message };
  },
};

// ---- Stripe webhook: the signed notification of a payment's outcome (billing.ts has the route) ----
// Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]; a v1 is HMAC-SHA256(endpoint secret, "<t>.<body>") over
// the body's bytes exactly as they arrived. The signature is checked first; only a body that carries a good one is
// then held to the clock: outside the tolerance it is a replay ('stale'), whoever sends it. Stripe signs every
// delivery attempt anew, so its own retries are never stale.
export const stripeTolerance = 300;
export function stripeSignature(raw: Buffer, header: unknown, secret: string, nowMs = Date.now(), toleranceSeconds = stripeTolerance): 'ok' | 'invalid' | 'stale' {
  if (typeof header !== 'string' || header.length > 2000 || !secret) return 'invalid';
  const parts = header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; });
  const t = parts.find(([k]) => k === 't')?.[1] ?? '';
  const given = parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => Buffer.from(v, 'hex'));
  if (!/^\d{1,12}$/.test(t) || !given.length) return 'invalid';
  const expected = createHmac('sha256', secret).update(`${t}.`, 'utf8').update(raw).digest();
  if (!given.some((g) => timingSafeEqual(g, expected))) return 'invalid';
  return Math.abs(nowMs / 1000 - Number(t)) > toleranceSeconds ? 'stale' : 'ok';
}
// The events that say how one of our payments ended, and which payment: payment_intent.succeeded carries our id in
// its metadata (checkout() and chargeSaved() both put it there) with the amount, and the customer and card for later
// charges; checkout.session.expired closes a payment page nobody paid on. Every other event is acknowledged and
// left alone (null): a declined try on the hosted page is not the end, the customer may still pay there.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StripeEvent = { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
export function stripeEventPayment(event: StripeEvent): string | null {
  const o = event?.data?.object;
  const id = event?.type === 'payment_intent.succeeded' ? o?.metadata?.payment_id : event?.type === 'checkout.session.expired' ? o?.client_reference_id : null;
  return typeof id === 'string' && uuidPattern.test(id) ? id.toLowerCase() : null;
}
// The same Result verify() gives for that outcome when it asks Stripe itself, so whichever of the three arrives first
// (the browser's return, the billing run's question, this event) records the same thing and the others find it done.
export function stripeEventResult(event: StripeEvent, payment: { amount: string; currency: string }): Result {
  const o = event.data?.object ?? {};
  if (event.type === 'checkout.session.expired') return o.payment_status === 'paid' ? fail('PENDING') : fail('EXPIRED', 'The payment page expired');
  if (o.status !== 'succeeded' || typeof o.id !== 'string' || !/^pi_\w+$/.test(o.id)) return fail('PENDING');
  if (o.amount_received !== cents(payment.amount) || String(o.currency).toUpperCase() !== payment.currency.trim()) return fail('AMOUNT_MISMATCH', 'Stripe reported a different amount');
  const pm = typeof o.payment_method === 'string' ? o.payment_method : o.payment_method?.id;
  const customer = typeof o.customer === 'string' ? o.customer : o.customer?.id;
  return { ok: true, ref: o.id, ...(customer && pm && o.setup_future_usage && { card: { token: `${customer}|${pm}` } }) };
}

// ---- Craftgate: Ortak Ödeme Formu (hosted, 3DS, stores the card), stored-card charge, refunds ----
async function craft(creds: Record<string, string>, method: string, path: string, payload?: object, idem?: string) {
  const url = `${creds.endpoint}${path}`;
  const body = payload ? JSON.stringify(payload) : '';
  const rnd = randomBytes(8).toString('hex');
  const signature = createHash('sha256').update(decodeURIComponent(url) + creds.apiKey + creds.secretKey + rnd + body).digest('base64');
  return (await json(url, { method, body: body || undefined, headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': creds.apiKey, 'x-rnd-key': rnd,
    'x-auth-version': '1', 'x-signature': signature, ...(idem && { 'x-idempotency-key': idem }) } })).body;
}
export const craftgate: Gateway = {
  recheck: true,
  async checkout(c, creds) {
    const amount = Number(c.amount);
    const r = await craft(creds, 'POST', '/payment/v1/checkout-payments/init', { price: amount, paidPrice: amount, currency: c.currency, paymentGroup: 'LISTING_OR_SUBSCRIPTION',
      conversationId: c.paymentId, callbackUrl: c.callbackUrl, items: [{ name: c.description, price: amount, externalId: c.paymentId }], enabledInstallments: [1], forceThreeDS: true,
      alwaysStoreCardAfterPayment: c.saveCard, clientIp: c.buyer.ip }, c.paymentId);
    const d = r.data ?? r;
    if (!d.pageUrl) throw new Error(`Craftgate: ${r.errors?.errorDescription ?? 'no page'}`);
    return { redirect: d.pageUrl as string, providerRef: d.token as string };
  },
  async verify({ payment }, creds) {
    if (!payment.providerRef) return fail('NO_TOKEN');
    const r = await craft(creds, 'GET', `/payment/v1/checkout-payments/${encodeURIComponent(payment.providerRef)}`);
    const d = r.data ?? r;
    // Anyone can open the return address, also before the form is finished: only Craftgate's FAILURE is a failure.
    if (d.paymentStatus !== 'SUCCESS') return d.paymentStatus === 'FAILURE' ? fail('CARD_DECLINED', r.errors?.errorDescription ?? d.paymentError?.errorDescription) : fail('PENDING');
    if (d.conversationId !== payment.id || Math.abs(Number(d.paidPrice) - Number(payment.amount)) > 0.001 || d.currency !== payment.currency) return fail('AMOUNT_MISMATCH', 'Craftgate reported a different payment');
    return { ok: true, ref: String(d.id), ...(d.cardUserKey && d.cardToken && { card: { token: `${d.cardUserKey}|${d.cardToken}`, brand: d.cardAssociation, last4: d.binNumber ? String(d.lastFourDigits ?? '') : undefined } }) };
  },
  async chargeSaved(token, c, creds) {
    const [cardUserKey, cardToken] = token.split('|');
    const amount = Number(c.amount);
    const r = await craft(creds, 'POST', '/payment/v1/card-payments', { price: amount, paidPrice: amount, walletPrice: 0, installment: 1, currency: c.currency, paymentGroup: 'LISTING_OR_SUBSCRIPTION',
      conversationId: c.paymentId, card: { cardUserKey, cardToken }, items: [{ name: c.description, price: amount, externalId: c.paymentId }] }, c.paymentId);
    const d = r.data ?? r;
    return d.paymentStatus === 'SUCCESS' ? { ok: true, ref: String(d.id) } : fail(String(r.errors?.errorCode ?? 'CARD_DECLINED'), r.errors?.errorDescription);
  },
  async refund(ref, amount, _currency, creds) {
    const r = await craft(creds, 'POST', '/payment/v1/refunds', { paymentId: Number(ref), refundDestinationType: 'PROVIDER', refundPrice: Number(amount) }, `rf${ref}${Date.now()}`);
    const d = r.data ?? r;
    return d.id || d.status === 'SUCCESS' ? { ok: true, ref: String(d.id ?? ref) } : { ok: false, code: String(r.errors?.errorCode ?? 'REFUND_FAILED'), message: r.errors?.errorDescription };
  },
};

// ---- Param: Ortak Ödeme Sayfası (hosted, 3DS, lira only); the browser returns with a result; refunds. No stored cards
// (only through a card form on our server, which would put card numbers on it). ----
// The return proves nothing: its hash has no key, and the merchant's GUID and this payment's own Islem_ID are known to
// anyone who has seen one return of this merchant. Param's query (TP_Islem_Sorgulama4) would settle it, but its answer's
// fields (the amount above all) are not in Param's published samples and could not be tried against a merchant account.
// shortcut: so a return that says paid never marks the payment paid; it is left open as NEEDS_CONFIRMATION for staff, who
// look the payment up in the Param panel and mark the invoice paid. Write the query here once its answer is known.
const paramSoap = async (url: string, action: string, ns: string, header: string, body: string) => {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${ns}${action}"` },
    body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header>${header}</soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>` });
  return res.text();
};
const paramMoney = (amount: string) => Number(amount).toFixed(2).replace('.', ',');
// "1.234,56", "1234,56" or "1234.56" in kuruş; null for anything else (never a guess: NaN compares as "not smaller").
export const paramAmount = (v: string) => {
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(v) ?? /^(\d+)\.(\d{2})$/.exec(v);
  return m ? Number(m[1].replace(/\./g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};
// A posted field as staff read it in the review note: its plain characters, cut short, so no field can push the
// instruction or the payment's own id out of the note (300 characters) or dress itself up as part of it.
const paramField = (v: string, max = 24) => v.replace(/[^\w.,-]/g, '').slice(0, max) || '-';
// The note of a payment under review: the panel's own facts and the instruction first, what the form reported after.
const paramNote = (payment: { id: string; amount: string }, g: (k: string) => string) =>
  `Param Islem_ID ${oid(payment.id)}, ${paramMoney(payment.amount)} TL: Param panelinde doğrulayıp faturayı ödendi işaretleyin / Confirm in the Param panel, then mark the invoice paid. `
  + `Bildirilen/Reported: sipariş/order ${paramField(g('Siparis_ID'))}, dekont ${paramField(g('Dekont_ID'))}, ${paramField(g('Tahsilat_Tutari'), 16)} TL.`;
const paramPage = (endpoint: string) => (/testposws|test-dmz/.test(endpoint) ? 'https://testpos.param.com.tr' : 'https://pos.param.com.tr');
export const param: Gateway = {
  unsigned: true,
  currencies: ['TRY'], // the hosted page takes the bare number in lira (another currency needs a card form on our server)
  async checkout(c, creds) {
    if (c.currency.trim() !== 'TRY') throw new Error('Param: only TRY');
    const header = `<ServiceSecuritySoapHeader xmlns="https://turkodeme.com.tr/"><CLIENT_CODE>${esc(creds.CLIENT_CODE)}</CLIENT_CODE><CLIENT_USERNAME>${esc(creds.CLIENT_USERNAME)}</CLIENT_USERNAME>`
      + `<CLIENT_PASSWORD>${esc(creds.CLIENT_PASSWORD)}</CLIENT_PASSWORD></ServiceSecuritySoapHeader>`;
    const x = await paramSoap(`${paramPage(creds.endpoint)}/Tahsilat/to.ws/Service_Odeme.asmx`, 'TO_Pre_Encrypting_OOS', 'https://turkodeme.com.tr/', header,
      `<TO_Pre_Encrypting_OOS xmlns="https://turkodeme.com.tr/"><Borclu_Kisi_TC>${/^\d{11}$/.test(c.buyer.taxId) ? c.buyer.taxId : ''}</Borclu_Kisi_TC><Borclu_Aciklama>r|${esc(c.description)}</Borclu_Aciklama>`
      + `<Borclu_Tutar>r|${paramMoney(c.amount)}</Borclu_Tutar><Borclu_GSM>r|${esc((c.buyer.phone || '').replace(/\D/g, '').slice(-10))}</Borclu_GSM><Borclu_Odeme_Tip>r|</Borclu_Odeme_Tip>`
      + `<Borclu_AdSoyad>r|${esc(c.buyer.name)}</Borclu_AdSoyad><Return_URL>r|${esc(c.callbackUrl)}</Return_URL><Islem_ID>${oid(c.paymentId)}</Islem_ID><Taksit>1</Taksit>`
      + `<Terminal_ID>${esc(creds.CLIENT_CODE)}</Terminal_ID></TO_Pre_Encrypting_OOS>`);
    const s = tag(x, 'TO_Pre_Encrypting_OOSResult');
    if (!s || /hata|error|denied/i.test(s)) throw new Error(`Param: ${s || x.replace(/<[^>]+>/g, ' ').slice(0, 200)}`);
    return { redirect: `${paramPage(creds.endpoint)}/Tahsilat/Default.aspx?s=${encodeURIComponent(s)}` };
  },
  async verify({ body, payment }, creds) {
    const g = (k: string) => String(body[`TURKPOS_RETVAL_${k}`] ?? '');
    const hash = createHash('sha1').update(Buffer.from(creds.CLIENT_CODE + g('GUID') + g('Dekont_ID') + g('Tahsilat_Tutari') + g('Siparis_ID') + g('Islem_ID'), 'latin1')).digest('base64');
    if (!same(g('Hash'), hash)) return fail('BAD_SIGNATURE', 'Param hash mismatch');
    // Every input of that hash is in the posted form, so it proves little by itself: the GUID must be the merchant's own
    // (never taken from the form), and the result must name this payment. Anything else is a foreign answer and changes nothing.
    if (!creds.GUID || !same(g('GUID'), creds.GUID)) return fail('BAD_SIGNATURE', 'Param GUID mismatch');
    if (g('Islem_ID') !== oid(payment.id)) return fail('BAD_SIGNATURE', 'Another payment’s result');
    if (payment.currency.trim() !== 'TRY') return fail('AMOUNT_MISMATCH', 'Param collects TRY only');
    // The result flag and the amount are read strictly: anything that is not a number is no answer at all.
    if (!/^-?\d+$/.test(g('Sonuc'))) return fail('BAD_SIGNATURE', 'Param result unreadable');
    // Declined closes a payment that nothing else was said about; one already under review stays open (billing.ts).
    if (Number(g('Sonuc')) <= 0) return fail('CARD_DECLINED', g('Sonuc_Str').slice(0, 120));
    const paid = paramAmount(g('Tahsilat_Tutari'));
    if (paid === null) return fail('BAD_SIGNATURE', 'Param amount unreadable');
    // Says paid (a smaller amount, or all of it), on the browser's word only (above): not final. Staff confirm it in the
    // Param panel, from a note that names this payment whatever the form says.
    return fail(paid < cents(payment.amount) ? 'AMOUNT_MISMATCH' : 'NEEDS_CONFIRMATION', paramNote(payment, g));
  },
  async refund(ref, amount, _currency, creds) {
    const x = await paramSoap(creds.endpoint, 'TP_Islem_Iptal_Iade_Kismi2', 'https://turkpos.com.tr/', '',
      `<TP_Islem_Iptal_Iade_Kismi2 xmlns="https://turkpos.com.tr/"><G><CLIENT_CODE>${esc(creds.CLIENT_CODE)}</CLIENT_CODE><CLIENT_USERNAME>${esc(creds.CLIENT_USERNAME)}</CLIENT_USERNAME>`
      + `<CLIENT_PASSWORD>${esc(creds.CLIENT_PASSWORD)}</CLIENT_PASSWORD></G><GUID>${esc(creds.GUID)}</GUID><Durum>IADE</Durum><Siparis_ID>${esc(ref)}</Siparis_ID><Tutar>${Number(amount).toFixed(2)}</Tutar></TP_Islem_Iptal_Iade_Kismi2>`);
    return Number(tag(x, 'Sonuc')) > 0 ? { ok: true, ref } : { ok: false, code: 'REFUND_FAILED', message: tag(x, 'Sonuc_Str') };
  },
};
