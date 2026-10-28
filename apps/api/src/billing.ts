// Billing: subscriptions, invoices, payments, the balance and saved cards, and the collection run (renewal invoices,
// automatic charges, reminders, overdue notices, suspension and termination). Rules without I/O are in billing-rules.ts,
// payment providers in billing-gateways.ts. An invoice awaits payment (a pro forma without a legal number) until it is
// paid; then it gets its number in the year's series and is issued (e-Fatura / e-Arşiv in einvoice.ts).
import { All, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { notify } from './notify';
import { activeGateway } from './payments';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, saveSettings, type BillingSettings } from './settings-store';
import { enqueue, startOperation } from './servers';
import { gateways, sandboxPay, type Result } from './billing-gateways';
import { renewalPrice, type CouponUse } from './coupons';
import { addDays, addMonths, cleanProfile, collectionStep, daysBetween, fromCents, hoursDue, invoiceNumber, lineAmounts, prorate, taxFor, toCents, totals, validPrefix } from './billing-rules';

type Db = Pick<Pool, 'query'> | PoolClient;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// shortcut: billing days are Istanbul calendar days (Turkey is UTC+3 all year); make it a setting for other countries.
const zone = 'Europe/Istanbul';
export const today = (at = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(at);
const endOfDay = (day: string) => `${day}T23:59:59+03:00`;
const settings = () => getSettings('billing');
// Acting for nobody in particular (the collection run): audit rows have no actor.
const system = { id: 'billing', ip: null, user: { id: null, permissions: [] } } as unknown as AuthedRequest;

// ---- Buyer, seller, invoices ----

// The buyer as printed on the invoice: the billing profile, or (none yet) the account, as an unnamed Turkish buyer.
async function buyerOf(db: Db, ownerId: string) {
  const { rows: [u] } = await db.query(`SELECT u.email AS account_email, u.name AS account_name, b.kind, b.name, b.tax_id, b.tax_office, b.country, b.city, b.district, b.address,
    b.postal_code, b.email, b.phone, b.einvoice_registered, b.einvoice_alias FROM users u LEFT JOIN billing_profiles b ON b.user_id = u.id WHERE u.id = $1`, [ownerId]);
  if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown user');
  return u.kind ? { kind: u.kind, name: u.name, taxId: u.tax_id, taxOffice: u.tax_office ?? '', country: u.country, city: u.city ?? '', district: u.district ?? '',
    address: u.address ?? '', postalCode: u.postal_code ?? '', email: u.email || u.account_email, phone: u.phone ?? '', einvoiceAlias: u.einvoice_registered ? u.einvoice_alias : null }
    : { kind: 'individual', name: u.account_name || u.account_email, taxId: '11111111111', taxOffice: '', country: 'TR', city: '', district: '', address: '', postalCode: '', email: u.account_email, phone: '', einvoiceAlias: null };
}

export type LineIn = { description: string; unitCents: number; quantity?: number; unit?: string; subscriptionId?: string; periodStart?: string; periodEnd?: string };
export async function createInvoice(db: Db, o: { ownerId: string; kind: 'order' | 'renewal' | 'topup' | 'manual' | 'usage'; currency: string; lines: LineIn[]; dueAt: string; note?: string; createdBy?: string | null }) {
  const s = await settings();
  const buyer = await buyerOf(db, o.ownerId);
  // A top-up is money held for later, not a sale: no tax, and no legal invoice (the invoices it pays are the sales).
  const tax = o.kind === 'topup' ? { rate: 0, exemption: null } : taxFor(buyer.country, s);
  const lines = o.lines.map((l) => ({ ...l, quantity: l.quantity ?? 1, ...lineAmounts(l.unitCents, l.quantity ?? 1, tax.rate, s.pricesIncludeTax && o.kind !== 'topup') }));
  const t = totals(lines);
  const { rows: [inv] } = await db.query(`INSERT INTO invoices (owner_id, kind, status, currency, subtotal, tax_total, total, tax_exemption, due_at, buyer, seller, note, created_by, next_charge_at)
    VALUES ($1, $2, 'unpaid', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $2 IN ('renewal', 'manual') THEN now() END) RETURNING id`,
    [o.ownerId, o.kind, o.currency, fromCents(t.net), fromCents(t.tax), fromCents(t.gross), tax.exemption, o.dueAt, buyer, s.company, o.note ?? null, o.createdBy ?? null]);
  for (const [i, l] of lines.entries()) {
    await db.query(`INSERT INTO invoice_lines (invoice_id, subscription_id, description, quantity, unit, unit_price, tax_rate, net, tax, gross, period_start, period_end, sort)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [inv.id, l.subscriptionId ?? null, l.description, l.quantity, l.unit ?? 'C62', fromCents(l.unitCents), tax.rate, fromCents(l.net), fromCents(l.tax), fromCents(l.gross), l.periodStart ?? null, l.periodEnd ?? null, i]);
  }
  return inv.id as string;
}

export async function balanceOf(db: Db, ownerId: string) {
  const { rows } = await db.query('SELECT currency, sum(amount)::text AS amount FROM balance_entries WHERE owner_id = $1 GROUP BY currency HAVING sum(amount) <> 0 ORDER BY currency', [ownerId]);
  return rows as { currency: string; amount: string }[];
}

type After = { enqueue: string[]; powerOn: { id: string; owner_id: string }[]; paid: Row[] };
// Paid in full: the number of the year's series, then what the invoice was for: the order's server is built, a renewal
// moves the period on (and lifts a hold), a top-up becomes balance. Runs inside the payment's transaction.
async function markPaid(db: PoolClient, invoiceId: string, after: After) {
  const s = await settings();
  const { rows: [inv] } = await db.query("SELECT * FROM invoices WHERE id = $1 AND status = 'unpaid' FOR UPDATE", [invoiceId]);
  if (!inv) return;
  // With an e-invoice integrator the number comes from the e-Fatura or e-Arşiv series when it is sent (einvoice.ts).
  const einvoice = await einvoiceOn();
  let number: string | null = null;
  if (inv.kind !== 'topup' && !einvoice) {
    const year = Number(today().slice(0, 4));
    const { rows: [q] } = await db.query(`INSERT INTO invoice_sequences (prefix, year, last) VALUES ($1, $2, 1)
      ON CONFLICT (prefix, year) DO UPDATE SET last = invoice_sequences.last + 1 RETURNING last`, [s.invoicePrefix, year]);
    number = invoiceNumber(s.invoicePrefix, year, q.last);
  }
  await db.query(`UPDATE invoices SET status = 'paid', paid_at = now(), number = $2, issued_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
    einvoice_status = CASE WHEN $3 AND $4 <> 'topup' THEN 'queued' ELSE 'none' END WHERE id = $1`, [invoiceId, number, einvoice, inv.kind]);
  if (inv.kind === 'topup') {
    await db.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id) VALUES ($1, $2, $3, 'topup', $4)", [inv.owner_id, inv.total, inv.currency, invoiceId]);
  }
  const { rows: lines } = await db.query('SELECT *, period_start::text AS ps, period_end::text AS pe FROM invoice_lines WHERE invoice_id = $1 AND subscription_id IS NOT NULL', [invoiceId]);
  for (const l of lines) {
    const { rows: [sub] } = await db.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [l.subscription_id]);
    if (!sub || ['cancelled', 'ended'].includes(sub.status)) continue;
    const start = l.ps ?? null;
    const end = l.pe ?? null;
    await db.query(`UPDATE subscriptions SET status = 'active', period_start = coalesce($2, period_start), period_end = greatest(coalesce($3, period_end), period_end),
      suspended_at = NULL, updated_at = now() WHERE id = $1`, [sub.id, start, end]);
    if (sub.status === 'pending' && sub.server_id) {
      // The order's server waited for this payment: it is built now (with a fresh deadline).
      const { rows } = await db.query(`UPDATE operations SET step = 'queued', deadline_at = now() + interval '45 minutes', updated_at = now()
        WHERE server_id = $1 AND kind = 'create' AND status = 'pending' AND step = 'awaiting_payment' RETURNING id`, [sub.server_id]);
      after.enqueue.push(...rows.map((r) => r.id));
    }
    if (sub.status === 'suspended' && sub.server_id) {
      const { rows: [srv] } = await db.query(`UPDATE servers SET billing_hold = false, updated_at = now() WHERE id = $1 AND billing_hold
        RETURNING id, owner_id, state, power_state`, [sub.server_id]);
      if (srv?.state === 'ready' && srv.power_state === 'poweredOff') after.powerOn.push(srv);
    }
  }
  after.paid.push({ ...inv, number });
}

// What a payment set in motion, after its transaction committed.
async function finish(after: After) {
  for (const id of after.enqueue) await enqueue(id);
  for (const srv of after.powerOn) {
    await startOperation(system, srv, 'power_on', `billing:unhold:${srv.id}:${Date.now()}`, `billing:${srv.id}`).catch(() => undefined);
  }
  for (const inv of after.paid) {
    if (inv.kind !== 'topup') await notify('billing.paid', [inv.owner_id], { invoiceId: inv.id, number: inv.number ?? '', total: inv.total, currency: inv.currency });
    await notify('billing.payment_received', 'staff:billing.view', { invoiceId: inv.id, number: inv.number ?? '', total: inv.total, currency: inv.currency, email: inv.buyer?.email ?? '' });
  }
  if (after.paid.length) void import('./einvoice').then((e) => e.sendQueued()).catch(() => undefined);
}

// Whether paid invoices go to an e-invoice integrator (einvoice.ts sets it up).
async function einvoiceOn() {
  return (await getSettings('einvoice')).provider !== 'none';
}

// A payment came back from the provider (or the sandbox page): recorded once, the invoice paid when covered.
export async function settlePayment(paymentId: string, r: Result) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  let p: Row | undefined;
  try {
    await client.query('BEGIN');
    ({ rows: [p] } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]));
    if (!p || p.status !== 'pending') { await client.query('ROLLBACK'); return p?.status ?? 'missing'; }
    if (!r.ok) {
      await client.query("UPDATE payments SET status = 'failed', error_code = $2, error_message = $3, provider_ref = coalesce($4, provider_ref), completed_at = now() WHERE id = $1",
        [paymentId, r.code.slice(0, 60), (r.message ?? '').slice(0, 300), r.ref ?? null]);
      await client.query('COMMIT');
      await notify('billing.payment_failed', [p.owner_id], { invoiceId: p.invoice_id, amount: p.amount, currency: p.currency, code: r.code });
      return 'failed';
    }
    await client.query("UPDATE payments SET status = 'succeeded', provider_ref = coalesce(nullif($2, ''), provider_ref), completed_at = now() WHERE id = $1", [paymentId, r.ref]);
    if (r.card && p.save_card) {
      const { rows: [d] } = await client.query('SELECT 1 FROM saved_cards WHERE owner_id = $1 AND is_default', [p.owner_id]);
      await client.query(`INSERT INTO saved_cards (owner_id, provider, mode, token_enc, brand, last4, exp_month, exp_year, holder, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [p.owner_id, p.provider, p.mode, encryptSecret(r.card.token, 'billing:card'), r.card.brand ?? null, r.card.last4 ?? null, r.card.expMonth ?? null, r.card.expYear ?? null, r.card.holder ?? null, !d]);
    }
    const { rows: [inv] } = await client.query('UPDATE invoices SET paid_total = paid_total + $2 WHERE id = $1 RETURNING paid_total >= total AS covered', [p.invoice_id, p.amount]);
    if (inv.covered) await markPaid(client, p.invoice_id, after);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
  return 'succeeded';
}

// Pays what is left of an invoice from the owner's balance in its currency, if the balance covers it.
export async function payFromBalance(invoiceId: string, automatic = false, by: string | null = null) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  try {
    await client.query('BEGIN');
    const { rows: [inv] } = await client.query("SELECT * FROM invoices WHERE id = $1 AND status = 'unpaid' AND kind <> 'topup' FOR UPDATE", [invoiceId]);
    if (!inv) { await client.query('ROLLBACK'); return false; }
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [inv.owner_id]); // one balance spend at a time
    const due = toCents(inv.total) - toCents(inv.paid_total);
    const { rows: [b] } = await client.query('SELECT coalesce(sum(amount), 0)::text AS amount FROM balance_entries WHERE owner_id = $1 AND currency = $2', [inv.owner_id, inv.currency]);
    if (due <= 0 || toCents(b.amount) < due) { await client.query('ROLLBACK'); return false; }
    const { rows: [p] } = await client.query(`INSERT INTO payments (invoice_id, owner_id, provider, method, status, amount, currency, automatic, created_by, completed_at)
      VALUES ($1, $2, 'balance', 'balance', 'succeeded', $3, $4, $5, $6, now()) RETURNING id`, [invoiceId, inv.owner_id, fromCents(due), inv.currency, automatic, by]);
    await client.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, payment_id) VALUES ($1, $2, $3, 'invoice', $4, $5)",
      [inv.owner_id, fromCents(-due), inv.currency, invoiceId, p.id]);
    await client.query('UPDATE invoices SET paid_total = total WHERE id = $1', [invoiceId]);
    await markPaid(client, invoiceId, after);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
  return true;
}

// Staff record money that arrived outside the panel (bank transfer, cash): the invoice is paid with it.
async function recordManual(invoiceId: string, method: string, reference: string, by: string) {
  const { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND status = 'unpaid'", [invoiceId]);
  if (!inv) throw apiError(409, 'INVOICE_NOT_PAYABLE', 'Only an unpaid invoice can be paid');
  const due = toCents(inv.total) - toCents(inv.paid_total);
  const { rows: [p] } = await pool.query(`INSERT INTO payments (invoice_id, owner_id, provider, method, status, amount, currency, reference, created_by)
    VALUES ($1, $2, 'manual', $3, 'pending', $4, $5, $6, $7) RETURNING id`, [invoiceId, inv.owner_id, method, fromCents(due), inv.currency, reference || null, by]);
  await settlePayment(p.id, { ok: true, ref: '' });
  return p.id as string;
}

// Starts a card payment at the chosen provider; returns where the customer goes to finish it (3D Secure).
async function startCardPayment(req: AuthedRequest, inv: Row, provider: string, saveCard: boolean) {
  const s = await settings();
  const gw = provider === 'sandbox' ? (s.sandbox ? { mode: 'test' as const, creds: {} } : null) : await activeGateway(provider);
  const impl = gateways[provider];
  if (!gw || !impl) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available');
  const due = toCents(inv.total) - toCents(inv.paid_total);
  const { rows: [p] } = await pool.query(`INSERT INTO payments (invoice_id, owner_id, provider, mode, method, status, amount, currency, save_card, created_by)
    VALUES ($1, $2, $3, $4, 'card', 'pending', $5, $6, $7, $8) RETURNING id`, [inv.id, inv.owner_id, provider, gw.mode, fromCents(due), inv.currency, saveCard, req.user.id]);
  const origin = typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : `${req.protocol}://${req.headers.host}`;
  const b = inv.buyer;
  try {
    const out = await impl.checkout({ paymentId: p.id, amount: fromCents(due), currency: inv.currency, description: inv.number ?? `#${String(inv.id).slice(0, 8)}`, saveCard,
      buyer: { id: inv.owner_id, name: b.name, email: b.email, taxId: b.taxId, phone: b.phone, address: b.address, city: b.city, country: b.country, ip: req.ip },
      returnUrl: `${origin}/billing/invoices/${inv.id}?payment=${p.id}`, callbackUrl: `${origin}/api/billing/callback/${provider}/${p.id}` }, gw.creds, gw.mode);
    if (out.providerRef) await pool.query('UPDATE payments SET provider_ref = $2 WHERE id = $1', [p.id, out.providerRef]);
    const { providerRef: _, ...rest } = out; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { paymentId: p.id, ...rest };
  } catch (e) {
    await settlePayment(p.id, { ok: false, code: 'PROVIDER_ERROR', message: String((e as Error)?.message ?? e).slice(0, 200) });
    throw apiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider did not answer');
  }
}

// Tries a stored card for an unpaid invoice without the customer (automatic collection).
async function chargeSavedCard(inv: Row) {
  const { rows: [card] } = await pool.query('SELECT * FROM saved_cards WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC LIMIT 1', [inv.owner_id]);
  const impl = card && gateways[card.provider];
  if (!card || !impl?.chargeSaved) return false;
  const gw = card.provider === 'sandbox' ? { mode: 'test' as const, creds: {} } : await activeGateway(card.provider);
  if (!gw) return false;
  const due = toCents(inv.total) - toCents(inv.paid_total);
  const { rows: [p] } = await pool.query(`INSERT INTO payments (invoice_id, owner_id, provider, mode, method, status, amount, currency, automatic)
    VALUES ($1, $2, $3, $4, 'saved_card', 'pending', $5, $6, true) RETURNING id`, [inv.id, inv.owner_id, card.provider, gw.mode, fromCents(due), inv.currency]);
  const b = inv.buyer;
  const r = await impl.chargeSaved(decryptSecret(card.token_enc, 'billing:card'), { paymentId: p.id, amount: fromCents(due), currency: inv.currency, description: `#${String(inv.id).slice(0, 8)}`,
    buyer: { id: inv.owner_id, name: b.name, email: b.email, taxId: b.taxId, phone: b.phone, address: b.address, city: b.city, country: b.country, ip: '127.0.0.1' } }, gw.creds, gw.mode)
    .catch((e: Error) => ({ ok: false as const, code: 'PROVIDER_ERROR', message: String(e?.message ?? e).slice(0, 200) }));
  return (await settlePayment(p.id, r)) === 'succeeded';
}

// ---- Orders (servers.ts) ----

// A server ordered while billing is on: its subscription and first invoice, in the order's transaction. With
// "payment before setup" the build waits (operation step awaiting_payment) until the invoice is paid.
// A coupon prices the first invoice (and keeps discounting the renewals it covers); a first period it makes free has no invoice.
export async function billOrder(db: PoolClient, o: { ownerId: string; serverId: string; name: string; monthly: string; currency: string; coupon?: CouponUse | null }) {
  const s = await settings();
  if (!s.enabled || toCents(o.monthly) <= 0) return null;
  const start = today();
  const end = addMonths(start, 1);
  const first = o.coupon ? o.coupon.monthly : o.monthly;
  const free = toCents(first) <= 0;
  const { rows: [sub] } = await db.query(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_start, period_end, coupon_id, coupon_left)
    VALUES ($1, 'server', $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [o.ownerId, o.serverId, `Sunucu ${o.name}`, o.monthly, o.currency, s.requirePayment && !free ? 'pending' : 'active', start, end,
    o.coupon?.id ?? null, o.coupon?.periods != null ? o.coupon.periods - 1 : null]);
  if (free) return null;
  const invoiceId = await createInvoice(db, { ownerId: o.ownerId, kind: 'order', currency: o.currency,
    dueAt: s.requirePayment ? new Date(Date.now() + s.orderExpiryHours * 3600_000).toISOString() : endOfDay(addDays(start, s.invoiceDaysBefore)),
    lines: [{ description: `Sunucu ${o.name} (${start} – ${end})${o.coupon ? ` · kupon ${o.coupon.code}` : ''}`, unitCents: toCents(first), unit: 'MON', subscriptionId: sub.id, periodStart: start, periodEnd: end }] });
  return { invoiceId, awaitingPayment: s.requirePayment };
}

// ---- The collection run ----

// Servers and data centers billed before billing was on (or by staff) get a subscription on their anniversary day.
async function adopt() {
  // A reseller's customer's server is billed to the reseller.
  const { rows } = await pool.query(`SELECT 'server' AS kind, s.id, coalesce((SELECT u.reseller_id FROM users u WHERE u.id = s.owner_id), s.owner_id) AS owner_id, s.name, s.price_monthly::text AS amount, trim(s.currency) AS currency, s.created_at FROM servers s
      WHERE s.state IN ('ready', 'error', 'provisioning') AND s.vdc_id IS NULL AND s.price_monthly > 0 AND s.billing_mode = 'monthly' AND s.external_source IS NULL
        AND NOT EXISTS (SELECT 1 FROM subscriptions b WHERE b.server_id = s.id AND b.status NOT IN ('cancelled', 'ended'))
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.step = 'awaiting_payment')
    UNION ALL SELECT 'vdc', v.id, v.owner_id, v.name, v.price_monthly::text, trim(v.currency), v.created_at FROM vdcs v
      WHERE v.active AND v.price_monthly > 0 AND NOT EXISTS (SELECT 1 FROM subscriptions b WHERE b.vdc_id = v.id AND b.status NOT IN ('cancelled', 'ended'))`);
  const now = today();
  for (const r of rows) {
    let start = today(r.created_at);
    while (addMonths(start, 1) <= now) start = addMonths(start, 1);
    await pool.query(`INSERT INTO subscriptions (owner_id, kind, server_id, vdc_id, description, amount, currency, status, period_start, period_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9) ON CONFLICT DO NOTHING`,
      [r.owner_id, r.kind, r.kind === 'server' ? r.id : null, r.kind === 'vdc' ? r.id : null, `${r.kind === 'server' ? 'Sunucu' : 'Sanal veri merkezi'} ${r.name}`, r.amount, r.currency, start, addMonths(start, 1)]);
  }
  return rows.length;
}

// A server deleted (or data center switched off) ends its subscription; open renewal invoices of it are withdrawn.
async function closeEnded() {
  const { rows } = await pool.query(`UPDATE subscriptions b SET status = 'ended', updated_at = now() WHERE b.status NOT IN ('cancelled', 'ended') AND (
      (b.kind = 'server' AND (b.server_id IS NULL OR EXISTS (SELECT 1 FROM servers s WHERE s.id = b.server_id AND s.state IN ('deleted', 'deleting'))))
      OR (b.kind = 'vdc' AND (b.vdc_id IS NULL OR EXISTS (SELECT 1 FROM vdcs v WHERE v.id = b.vdc_id AND NOT v.active)))) RETURNING id`);
  if (rows.length) {
    await pool.query(`UPDATE invoices i SET status = 'cancelled', cancelled_at = now() WHERE i.status = 'unpaid' AND i.paid_total = 0 AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN subscriptions b ON b.id = l.subscription_id WHERE l.invoice_id = i.id AND b.status NOT IN ('ended', 'cancelled'))`);
  }
  return rows.length;
}

// Deletes a server for billing (cancelled at period end, or terminated unpaid): as the owner's delete would.
async function removeServer(serverId: string, reason: string) {
  const { rows: [s] } = await pool.query("UPDATE servers SET locked = false, state = 'deleting', updated_at = now() WHERE id = $1 AND state IN ('ready', 'error') RETURNING id, owner_id", [serverId]);
  if (!s) return;
  await startOperation(system, s, 'delete', `billing:${reason}:${serverId}`, `billing:${serverId}:delete`).catch(async () => {
    await pool.query("UPDATE servers SET state = 'error', updated_at = now() WHERE id = $1 AND state = 'deleting'", [serverId]);
  });
}

export async function runBilling(now = new Date()) {
  const s = await settings();
  if (!s.enabled) return { skipped: true };
  const day = today(now);
  const out = { adopted: await adopt(), ended: await closeEnded(), cancelled: 0, renewals: 0, charged: 0, reminded: 0, overdue: 0, suspended: 0, terminated: 0, expired: 0,
    hourly: await runHourly(now), disputesEscalated: await (await import('./disputes')).escalateDisputes() };

  // Cancelled at the period's end: the server goes.
  const { rows: leaving } = await pool.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now()
    WHERE cancel_at_period_end AND status IN ('active', 'past_due', 'suspended') AND period_end <= $1 RETURNING id, server_id`, [day]);
  for (const b of leaving) if (b.server_id) await removeServer(b.server_id, 'cancel');
  out.cancelled = leaving.length;

  // Renewal invoices N days before the period ends, one per subscription and period.
  const { rows: due } = await pool.query(`SELECT b.*, b.period_end::text AS pe FROM subscriptions b WHERE b.status IN ('active', 'past_due', 'suspended') AND b.auto_renew AND NOT b.cancel_at_period_end
      AND b.period_end - $2::int <= $1::date
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.subscription_id = b.id AND l.period_start = b.period_end AND i.status <> 'cancelled')`,
    [day, s.invoiceDaysBefore]);
  for (const b of due) {
    const start = b.pe;
    const end = addMonths(start, b.period_months);
    // The current price of a server (it may have been resized) or the subscription's own amount.
    const { rows: [srv] } = b.server_id ? await pool.query('SELECT price_monthly::text AS price FROM servers WHERE id = $1', [b.server_id]) : { rows: [] };
    const monthly = srv?.price ?? b.amount;
    if (srv && srv.price !== b.amount) await pool.query('UPDATE subscriptions SET amount = $2, updated_at = now() WHERE id = $1', [b.id, monthly]);
    const coupon = await renewalPrice(pool, b, monthly);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await createInvoice(client, { ownerId: b.owner_id, kind: 'renewal', currency: b.currency, dueAt: endOfDay(start),
        lines: [{ description: `${b.description} (${start} – ${end})${coupon ? ` · kupon ${coupon.code}` : ''}`, unitCents: toCents(coupon?.monthly ?? monthly), quantity: b.period_months, unit: 'MON', subscriptionId: b.id, periodStart: start, periodEnd: end }] });
      if (coupon) await client.query('UPDATE subscriptions SET coupon_left = coupon_left - 1 WHERE id = $1 AND coupon_left IS NOT NULL', [b.id]);
      await client.query('COMMIT');
      out.renewals++;
    } catch (e) { await client.query('ROLLBACK'); if ((e as { code?: string }).code !== '23505') throw e; } finally { client.release(); }
  }
  for (const inv of (await pool.query("SELECT id, owner_id, total, currency, due_at FROM invoices WHERE status = 'unpaid' AND kind = 'renewal' AND created_at > now() - interval '10 minutes' AND reminded_at IS NULL AND charge_attempts = 0")).rows) {
    await notify('billing.invoice', [inv.owner_id], { invoiceId: inv.id, total: inv.total, currency: inv.currency, due: today(inv.due_at) });
  }

  // Automatic collection: the balance first, then the saved card; a few tries a day apart.
  if (s.autoCharge) {
    const { rows: open } = await pool.query(`SELECT * FROM invoices WHERE status = 'unpaid' AND kind IN ('renewal', 'manual') AND NOT disputed AND next_charge_at <= now() AND charge_attempts < $1`, [s.chargeRetries]);
    for (const inv of open) {
      await pool.query("UPDATE invoices SET charge_attempts = charge_attempts + 1, next_charge_at = now() + interval '1 day' WHERE id = $1", [inv.id]);
      if ((s.balance && await payFromBalance(inv.id, true)) || await chargeSavedCard(inv)) out.charged++;
    }
  }

  // Reminders, overdue notices, suspension and termination of unpaid renewals.
  const { rows: unpaid } = await pool.query(`SELECT i.*, b.id AS sub_id, b.status AS sub_status, b.suspended_at, b.server_id FROM invoices i
      JOIN invoice_lines l ON l.invoice_id = i.id JOIN subscriptions b ON b.id = l.subscription_id
      WHERE i.status = 'unpaid' AND i.kind = 'renewal' AND NOT i.disputed AND b.status IN ('active', 'past_due', 'suspended')`);
  for (const i of unpaid) {
    const step = collectionStep(daysBetween(today(i.due_at), day), s, { reminded: !!i.reminded_at && today(i.reminded_at) === day, overdueNotified: !!i.overdue_notified_at,
      suspended: i.sub_status === 'suspended', suspendedDays: i.suspended_at ? daysBetween(today(i.suspended_at), day) : 0 });
    const d = { invoiceId: i.id, total: i.total, currency: i.currency, due: today(i.due_at) };
    if (step === 'remind') {
      await pool.query('UPDATE invoices SET reminded_at = now() WHERE id = $1', [i.id]);
      await notify('billing.reminder', [i.owner_id], d); out.reminded++;
    } else if (step === 'overdue') {
      await pool.query('UPDATE invoices SET overdue_notified_at = now() WHERE id = $1', [i.id]);
      await pool.query("UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1 AND status = 'active'", [i.sub_id]);
      await notify('billing.overdue', [i.owner_id], { ...d, days: String(s.suspendAfterDays) }); out.overdue++;
    } else if (step === 'suspend') {
      await pool.query("UPDATE subscriptions SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = $1", [i.sub_id]);
      if (i.server_id) {
        const { rows: [srv] } = await pool.query("UPDATE servers SET billing_hold = true, updated_at = now() WHERE id = $1 AND state = 'ready' RETURNING id, owner_id, power_state", [i.server_id]);
        if (srv?.power_state === 'poweredOn') await startOperation(system, srv, 'power_off', `billing:hold:${srv.id}:${day}`, `billing:${srv.id}:hold`).catch(() => undefined);
      }
      await notify('billing.suspended', [i.owner_id], { ...d, days: String(s.terminateAfterDays) }); out.suspended++;
    } else if (step === 'terminate') {
      await pool.query("UPDATE subscriptions SET status = 'ended', updated_at = now() WHERE id = $1", [i.sub_id]);
      await pool.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND paid_total = 0", [i.id]);
      if (i.server_id) await removeServer(i.server_id, 'terminate');
      await notify('billing.terminated', [i.owner_id], d); out.terminated++;
    }
  }

  // Orders not paid in time: the invoice is withdrawn and the waiting build cancelled (its address and capacity freed).
  const { rows: stale } = await pool.query(`UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE status = 'unpaid' AND kind = 'order' AND NOT disputed AND paid_total = 0 AND due_at < now() RETURNING id`);
  for (const inv of stale) {
    const { rows: subs } = await pool.query(`UPDATE subscriptions b SET status = 'cancelled', cancelled_at = now(), updated_at = now() FROM invoice_lines l
      WHERE l.invoice_id = $1 AND l.subscription_id = b.id AND b.status = 'pending' RETURNING b.server_id`, [inv.id]);
    for (const b of subs) {
      await pool.query('DELETE FROM coupon_redemptions WHERE server_id = $1', [b.server_id]); // an order never paid gives its coupon use back
      const { rows } = await pool.query(`UPDATE operations SET cancel_requested = true, step = 'queued', updated_at = now()
        WHERE server_id = $1 AND kind = 'create' AND status = 'pending' AND step = 'awaiting_payment' RETURNING id`, [b.server_id]);
      for (const r of rows) await enqueue(r.id);
    }
    out.expired++;
  }
  return out;
}

// Gives money back on a paid invoice (staff refund, or an accepted dispute): to the card at the provider, or to the balance.
export async function refundInvoice(req: AuthedRequest, id: string, body: Record<string, unknown>) {
  const { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND status IN ('paid', 'partially_refunded')", [id]);
  if (!inv) throw apiError(409, 'INVOICE_NOT_REFUNDABLE', 'Only a paid invoice can be refunded');
  let cents = 0; try { cents = toCents(String(body?.amount ?? inv.total)); } catch { /* below */ }
  const left = toCents(inv.total) - toCents(inv.refunded_total);
  if (cents <= 0 || cents > left) throw apiError(400, 'VALIDATION_FAILED', 'Invalid amount', { amount: 'OUT_OF_RANGE' });
  const toBalance = body?.toBalance === true;
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
  // A top-up refunded to the card takes the money out of the balance it became (refunding it to the balance changes nothing).
  if (inv.kind === 'topup') {
    if (toBalance) throw apiError(409, 'REFUND_NOT_SUPPORTED', 'A top-up is already balance');
    const { rows: [b] } = await pool.query('SELECT coalesce(sum(amount), 0)::text AS amount FROM balance_entries WHERE owner_id = $1 AND currency = $2', [inv.owner_id, inv.currency]);
    if (toCents(b.amount) < cents) throw apiError(409, 'INSUFFICIENT_BALANCE', 'That much of the top-up was already spent');
  }
  let remaining = cents;
  if (!toBalance) {
    // Back through the payments that brought the money in, newest first.
    const { rows: pays } = await pool.query("SELECT * FROM payments WHERE invoice_id = $1 AND status IN ('succeeded', 'partially_refunded') ORDER BY completed_at DESC", [id]);
    for (const p of pays) {
      if (!remaining) break;
      const part = Math.min(remaining, toCents(p.amount) - toCents(p.refunded));
      if (part <= 0) continue;
      if (p.provider === 'balance' || p.provider === 'manual') {
        if (p.provider === 'manual') continue; // money that came outside the panel goes back outside it (or to the balance)
        await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, payment_id, note, created_by) VALUES ($1, $2, $3, 'refund', $4, $5, $6, $7)",
          [inv.owner_id, fromCents(part), inv.currency, id, p.id, reason || null, req.user.id]);
      } else {
        const impl = gateways[p.provider];
        const gw = p.provider === 'sandbox' ? { mode: 'test' as const, creds: {} } : await activeGateway(p.provider, p.mode);
        if (!impl?.refund || !gw) throw apiError(409, 'REFUND_NOT_SUPPORTED', 'This provider cannot refund from the panel; refund it in the provider panel or to the balance');
        const r = await impl.refund(p.provider_ref, fromCents(part), p.currency, gw.creds, gw.mode);
        if (!r.ok) throw apiError(502, 'REFUND_FAILED', r.message ?? r.code);
      }
      await pool.query("UPDATE payments SET refunded = refunded + $2, status = CASE WHEN refunded + $2 >= amount THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1", [p.id, fromCents(part)]);
      remaining -= part;
    }
    if (remaining) throw apiError(409, 'REFUND_NOT_SUPPORTED', 'Part of this was paid outside the panel; refund that part to the balance');
    if (inv.kind === 'topup') await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, note, created_by) VALUES ($1, $2, $3, 'refund', $4, $5, $6)",
      [inv.owner_id, fromCents(-cents), inv.currency, id, reason || null, req.user.id]);
  } else {
    await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, note, created_by) VALUES ($1, $2, $3, 'refund', $4, $5, $6)",
      [inv.owner_id, fromCents(cents), inv.currency, id, reason || null, req.user.id]);
  }
  await pool.query(`UPDATE invoices SET refunded_total = refunded_total + $2, status = CASE WHEN refunded_total + $2 >= total THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1`,
    [id, fromCents(cents)]);
  await audit(req, 'billing.refunded', 'success', req.user.id, { invoiceId: id, amount: fromCents(cents), toBalance, reason });
  void import('./einvoice').then((e) => e.creditNote(id, fromCents(cents), reason)).catch(() => undefined);
  await notify('billing.refunded', [inv.owner_id], { invoiceId: id, amount: fromCents(cents), currency: inv.currency });
  return { ok: true };
}

// ---- Pay as you go ----

const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;

// What the owner can still spend in one currency: the balance, less hourly usage not invoiced yet and unpaid usage invoices.
export async function available(db: Db, ownerId: string, currency: string) {
  const { rows: [a] } = await db.query(`SELECT
      coalesce((SELECT sum(amount) FROM balance_entries WHERE owner_id = $1 AND currency = $2), 0)
      - coalesce((SELECT sum(amount) FROM server_usage WHERE owner_id = $1 AND currency = $2 AND invoice_id IS NULL), 0)
      - coalesce((SELECT sum(total - paid_total) FROM invoices WHERE owner_id = $1 AND currency = $2 AND kind = 'usage' AND status = 'unpaid'), 0) AS v`, [ownerId, currency]);
  return Number(a.v);
}

// One hour of a new hourly server, in the order's transaction (servers.ts).
export async function startHourly(db: PoolClient, o: { serverId: string; ownerId: string; hourly: string; currency: string }) {
  await db.query("UPDATE servers SET billing_mode = 'hourly', price_hourly = $2, billed_until = now() + interval '1 hour' WHERE id = $1", [o.serverId, o.hourly]);
  await db.query('INSERT INTO server_usage (server_id, owner_id, month, hours, amount, currency) VALUES ($1, $2, $3, 1, $4, $5)', [o.serverId, o.ownerId, firstOfMonth(today()), o.hourly, o.currency]);
}

// Each run: started hours are added to the month's usage; owners who ran out are held (and released after a top-up), warned
// once a day when less than a day is left; last month's usage becomes an invoice paid from the balance.
async function runHourly(now: Date) {
  const s = await settings();
  const out = { hours: 0, held: 0, released: 0, warned: 0, invoiced: 0 };
  const { rows } = await pool.query(`SELECT id, owner_id, price_hourly::text AS price, trim(currency) AS currency, billed_until, billed_until::text AS billed_text FROM servers
    WHERE billing_mode = 'hourly' AND state <> 'deleted' AND billed_until < $1`, [now]);
  for (const r of rows) {
    const h = hoursDue(new Date(r.billed_until), now);
    // Guarded by billed_until (compared as PostgreSQL's own text: a JavaScript date drops the microseconds): a second run adds nothing.
    const { rowCount } = await pool.query(`WITH up AS (UPDATE servers SET billed_until = billed_until + make_interval(hours => $2) WHERE id = $1 AND billed_until = $3::timestamptz RETURNING id)
      INSERT INTO server_usage (server_id, owner_id, month, hours, amount, currency) SELECT $1, $4, $5, $2, $2 * $6::numeric, $7 FROM up
      ON CONFLICT (server_id, month) DO UPDATE SET hours = server_usage.hours + EXCLUDED.hours, amount = server_usage.amount + EXCLUDED.amount`,
    [r.id, h, r.billed_text, r.owner_id, firstOfMonth(today(now)), r.price, r.currency]);
    if (rowCount) out.hours += h;
  }

  // Last month's (and older) usage: one invoice per owner and currency, paid from the balance when it covers it.
  const { rows: due } = await pool.query(`SELECT owner_id, currency, array_agg(server_id) AS servers FROM server_usage
    WHERE invoice_id IS NULL AND month < $1::date AND amount > 0 GROUP BY owner_id, currency`, [firstOfMonth(today(now))]);
  for (const d of due) {
    const client = await pool.connect();
    let invoiceId: string | null = null;
    try {
      await client.query('BEGIN');
      const { rows: lines } = await client.query(`SELECT u.server_id, u.month::text AS month, u.hours, round(u.amount, 2)::text AS amount, s.name FROM server_usage u JOIN servers s ON s.id = u.server_id
        WHERE u.owner_id = $1 AND u.currency = $2 AND u.invoice_id IS NULL AND u.month < $3::date AND u.amount > 0 ORDER BY u.month, s.name FOR UPDATE OF u`, [d.owner_id, d.currency, firstOfMonth(today(now))]);
      if (lines.length) {
        invoiceId = await createInvoice(client, { ownerId: d.owner_id, kind: 'usage', currency: d.currency, dueAt: new Date().toISOString(),
          lines: lines.map((l) => ({ description: `Sunucu ${l.name} kullanımı (${l.month.slice(0, 7)}): ${l.hours} saat`, unitCents: toCents(l.amount) })) });
        await client.query('UPDATE server_usage SET invoice_id = $3 WHERE owner_id = $1 AND currency = $2 AND invoice_id IS NULL AND month < $4::date AND amount > 0',
          [d.owner_id, d.currency, invoiceId, firstOfMonth(today(now))]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (invoiceId) {
      out.invoiced++;
      if (!(await payFromBalance(invoiceId, true))) {
        const { rows: [inv] } = await pool.query('SELECT total::text, currency FROM invoices WHERE id = $1', [invoiceId]);
        await notify('billing.invoice', [d.owner_id], { invoiceId, total: inv.total, currency: inv.currency, due: today(now) });
      }
    }
  }

  // Hold, release and warn, per owner and currency of hourly servers.
  const { rows: owners } = await pool.query(`SELECT owner_id, trim(currency) AS currency, sum(price_hourly) FILTER (WHERE state NOT IN ('deleted', 'deleting'))::float8 AS burn
    FROM servers WHERE billing_mode = 'hourly' AND state <> 'deleted' GROUP BY owner_id, trim(currency)`);
  for (const o of owners) {
    const left = await available(pool, o.owner_id, o.currency);
    if (left < 0) {
      const { rows: held } = await pool.query(`UPDATE servers SET billing_hold = true, updated_at = now() WHERE owner_id = $1 AND trim(currency) = $2 AND billing_mode = 'hourly'
        AND state = 'ready' AND NOT billing_hold RETURNING id, owner_id, power_state`, [o.owner_id, o.currency]);
      for (const srv of held) if (srv.power_state === 'poweredOn') await startOperation(system, srv, 'power_off', `billing:hourly-hold:${srv.id}:${now.getTime()}`, `billing:${srv.id}:hold`).catch(() => undefined);
      if (held.length) { out.held += held.length; await notify('billing.hourly_hold', [o.owner_id], { amount: left.toFixed(2), currency: o.currency }); }
      continue;
    }
    const { rows: freed } = await pool.query(`UPDATE servers SET billing_hold = false, updated_at = now() WHERE owner_id = $1 AND trim(currency) = $2 AND billing_mode = 'hourly'
      AND billing_hold RETURNING id, owner_id, state, power_state`, [o.owner_id, o.currency]);
    for (const srv of freed) if (srv.state === 'ready' && srv.power_state === 'poweredOff') await startOperation(system, srv, 'power_on', `billing:hourly-release:${srv.id}:${now.getTime()}`, `billing:${srv.id}`).catch(() => undefined);
    out.released += freed.length;
    if (o.burn > 0 && left < o.burn * 24) {
      const { rowCount } = await pool.query('UPDATE users SET balance_warned_on = $2 WHERE id = $1 AND balance_warned_on IS DISTINCT FROM $2', [o.owner_id, today(now)]);
      if (rowCount) { out.warned++; await notify('billing.balance_low', [o.owner_id], { amount: left.toFixed(2), currency: o.currency, hours: String(Math.floor(left / o.burn)) }); }
    }
  }
  void s;
  return out;
}

export function startBilling() {
  const tick = async () => {
    if (!(await redis.set('lock:billing', '1', 'EX', 240, 'NX').catch(() => null))) return;
    await runBilling().catch((e) => logEvent('error', 'billing_run_failed', { error: String(e?.message ?? e).slice(0, 200) }));
  };
  return setInterval(tick, 5 * 60_000).unref();
}

// ---- Views ----

const invoiceColumns = `i.id, i.number, i.kind, i.status, i.currency, i.subtotal::text, i.tax_total::text AS "taxTotal", i.total::text, i.paid_total::text AS "paidTotal",
  i.refunded_total::text AS "refundedTotal", i.due_at AS "dueAt", i.paid_at AS "paidAt", i.issued_at AS "issuedAt", i.created_at AS "createdAt", i.tax_exemption AS "taxExemption",
  i.einvoice_status AS "einvoiceStatus", i.einvoice_profile AS "einvoiceProfile", i.einvoice_error AS "einvoiceError", i.buyer->>'name' AS "buyerName", i.buyer->>'email' AS "buyerEmail", i.owner_id AS "ownerId",
  (i.status = 'unpaid' AND i.due_at < now()) AS overdue`;
async function invoiceDetail(id: string, ownerId?: string) {
  const { rows: [inv] } = await pool.query(`SELECT ${invoiceColumns}, i.buyer, i.seller, i.note, i.related_invoice_id AS "relatedInvoiceId" FROM invoices i WHERE i.id = $1 AND ($2::uuid IS NULL OR i.owner_id = $2)`, [id, ownerId ?? null]);
  if (!inv) throw apiError(404, 'NOT_FOUND', 'Unknown invoice');
  const { rows: lines } = await pool.query(`SELECT id, description, quantity::text, unit, unit_price::text AS "unitPrice", tax_rate::text AS "taxRate", net::text, tax::text, gross::text,
    period_start AS "periodStart", period_end AS "periodEnd" FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort`, [id]);
  const { rows: payments } = await pool.query(`SELECT id, provider, mode, method, status, amount::text, currency, refunded::text, error_code AS "errorCode", error_message AS "errorMessage",
    reference, automatic, created_at AS "createdAt", completed_at AS "completedAt" FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC`, [id]);
  return { invoice: inv, lines, payments };
}
const subscriptionColumns = `b.id, b.kind, b.server_id AS "serverId", b.vdc_id AS "vdcId", b.description, b.amount::text, b.currency, b.period_months AS "periodMonths", b.status,
  b.period_start AS "periodStart", b.period_end AS "periodEnd", b.auto_renew AS "autoRenew", b.cancel_at_period_end AS "cancelAtPeriodEnd", b.suspended_at AS "suspendedAt", b.created_at AS "createdAt"`;

// What a customer may pay with now.
async function methods() {
  const s = await settings();
  const { activePaymentMethods } = await import('./payments');
  const cards = (await activePaymentMethods()).filter((m) => gateways[m.id]).map((m) => ({ id: m.id, name: m.name, mode: m.mode, saved: !!gateways[m.id].chargeSaved }));
  if (s.sandbox) cards.push({ id: 'sandbox', name: 'Sandbox', mode: 'test', saved: true });
  return { cards, balance: s.balance, bankTransfer: s.bankTransfer.enabled ? s.bankTransfer : null, topup: { min: s.topupMin, max: s.topupMax } };
}

// ---- Customer ----

@Controller('billing') @UseGuards(SessionGuard)
export class BillingController {
  @Get('summary')
  async summary(@Req() req: AuthedRequest) {
    const s = await settings();
    if (!s.enabled) return { enabled: false };
    const id = req.user.id;
    const [balance, open, subs, cards, profile] = await Promise.all([
      balanceOf(pool, id),
      pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE due_at < now())::int AS overdue, coalesce(sum(total - paid_total), 0)::text AS amount, min(currency) AS currency
        FROM invoices WHERE owner_id = $1 AND status = 'unpaid' AND kind <> 'topup'`, [id]),
      pool.query(`SELECT ${subscriptionColumns} FROM subscriptions b WHERE b.owner_id = $1 AND b.status IN ('active', 'past_due', 'suspended') ORDER BY b.period_end`, [id]),
      pool.query('SELECT id, provider, mode, brand, last4, exp_month AS "expMonth", exp_year AS "expYear", is_default AS "isDefault" FROM saved_cards WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC', [id]),
      pool.query('SELECT 1 FROM billing_profiles WHERE user_id = $1', [id]),
    ]);
    // Pay as you go: hourly servers, this month's usage so far, and what is left to spend.
    const { rows: hourly } = await pool.query(`SELECT s.id, s.name, s.price_hourly::text AS "priceHourly", trim(s.currency) AS currency, s.billing_hold AS "billingHold",
        coalesce((SELECT u.hours FROM server_usage u WHERE u.server_id = s.id AND u.month = $2::date), 0) AS hours,
        coalesce((SELECT u.amount FROM server_usage u WHERE u.server_id = s.id AND u.month = $2::date), 0)::text AS amount
      FROM servers s WHERE s.owner_id = $1 AND s.billing_mode = 'hourly' AND s.state NOT IN ('deleted', 'deleting') ORDER BY s.name`, [id, firstOfMonth(today())]);
    const currencies = [...new Set(hourly.map((h) => h.currency))];
    const left = await Promise.all(currencies.map(async (c) => ({ currency: c, amount: (await available(pool, id, c)).toFixed(2),
      perHour: hourly.filter((h) => h.currency === c).reduce((a, h) => a + Number(h.priceHourly), 0).toFixed(4) })));
    return { enabled: true, balance, open: open.rows[0], subscriptions: subs.rows, cards: cards.rows, profileComplete: !!profile.rowCount, methods: await methods(),
      autoCharge: s.autoCharge, requirePayment: s.requirePayment, hourly: { enabled: s.hourly && s.balance, minHours: s.hourlyMinHours, servers: hourly, available: left } };
  }

  @Get('profile')
  async profile(@Req() req: AuthedRequest) {
    const { rows: [p] } = await pool.query(`SELECT kind, name, tax_id AS "taxId", tax_office AS "taxOffice", country, city, district, address, postal_code AS "postalCode", email, phone,
      einvoice_registered AS "einvoiceRegistered" FROM billing_profiles WHERE user_id = $1`, [req.user.id]);
    return { profile: p ?? null };
  }

  @Put('profile')
  async saveProfile(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const r = cleanProfile(body ?? {});
    if ('fields' in r) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', r.fields);
    const p = r.profile;
    await pool.query(`INSERT INTO billing_profiles (user_id, kind, name, tax_id, tax_office, country, city, district, address, postal_code, email, phone)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (user_id) DO UPDATE SET kind = $2, name = $3, tax_id = $4, tax_office = $5, country = $6, city = $7,
      district = $8, address = $9, postal_code = $10, email = $11, phone = $12, updated_at = now(),
      einvoice_registered = CASE WHEN billing_profiles.tax_id = $4 THEN billing_profiles.einvoice_registered END,
      einvoice_alias = CASE WHEN billing_profiles.tax_id = $4 THEN billing_profiles.einvoice_alias END`,
      [req.user.id, p.kind, p.name, p.taxId, p.taxOffice || null, p.country, p.city || null, p.district || null, p.address, p.postalCode || null, p.email || null, p.phone || null]);
    await audit(req, 'billing.profile_saved', 'success', req.user.id, { kind: p.kind, country: p.country });
    // Unpaid invoices take the new details (paid ones keep what they were issued with).
    const buyer = await buyerOf(pool, req.user.id);
    await pool.query("UPDATE invoices SET buyer = $2 WHERE owner_id = $1 AND status = 'unpaid'", [req.user.id, buyer]);
    void import('./einvoice').then((e) => e.lookupProfile(req.user.id)).catch(() => undefined);
    return { ok: true };
  }

  @Get('invoices')
  async invoices(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${invoiceColumns} FROM invoices i WHERE i.owner_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [req.user.id]);
    return { invoices: rows };
  }

  @Get('invoices/:id')
  invoice(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) { return invoiceDetail(id, req.user.id); }

  // Pay an invoice: from the balance, or by card at a provider (3D Secure on its page; a saved card is offered later).
  @Post('invoices/:id/pay') @HttpCode(200)
  async pay(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND owner_id = $2", [id, req.user.id]);
    if (!inv) throw apiError(404, 'NOT_FOUND', 'Unknown invoice');
    if (inv.status !== 'unpaid') throw apiError(409, 'INVOICE_NOT_PAYABLE', 'This invoice is not awaiting payment');
    const s = await settings();
    if (body?.method === 'balance') {
      if (!s.balance || inv.kind === 'topup') throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available');
      if (!(await payFromBalance(id, false, req.user.id))) throw apiError(409, 'INSUFFICIENT_BALANCE', 'The balance does not cover this invoice');
      await audit(req, 'billing.paid_from_balance', 'success', req.user.id, { invoiceId: id });
      return { paid: true };
    }
    if (body?.method === 'saved_card') {
      const ok = await chargeSavedCard(inv);
      await audit(req, 'billing.paid_saved_card', ok ? 'success' : 'failure', req.user.id, { invoiceId: id });
      if (!ok) throw apiError(402, 'PAYMENT_FAILED', 'The saved card was not charged');
      return { paid: true };
    }
    if (body?.method !== 'card' || typeof body.provider !== 'string') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { method: 'INVALID_VALUE' });
    const out = await startCardPayment(req, inv, body.provider, body.saveCard === true);
    await audit(req, 'billing.payment_started', 'success', req.user.id, { invoiceId: id, provider: body.provider, paymentId: out.paymentId });
    return out;
  }

  // The sandbox provider's page: a test card settles the payment at once.
  @Get('payments/:id')
  async payment(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [p] } = await pool.query(`SELECT p.id, p.invoice_id AS "invoiceId", p.provider, p.status, p.amount::text, p.currency, p.save_card AS "saveCard", p.error_code AS "errorCode"
      FROM payments p WHERE p.id = $1 AND p.owner_id = $2`, [id, req.user.id]);
    if (!p) throw apiError(404, 'NOT_FOUND', 'Unknown payment');
    return { payment: p };
  }

  @Post('payments/:id/sandbox') @HttpCode(200)
  async sandboxPay(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const { rows: [p] } = await pool.query("SELECT * FROM payments WHERE id = $1 AND owner_id = $2 AND provider = 'sandbox'", [id, req.user.id]);
    if (!p) throw apiError(404, 'NOT_FOUND', 'Unknown payment');
    const cancel = body?.cancel === true;
    const r = cancel ? { ok: false as const, code: 'CANCELLED_BY_CUSTOMER' } : sandboxPay(String(body?.card ?? ''), p.save_card);
    const status = await settlePayment(id, r);
    return { status, ...(!r.ok && { code: r.code }) };
  }

  // Money held for later invoices.
  @Post('topup') @HttpCode(201)
  async topup(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const s = await settings();
    if (!s.enabled || !s.balance) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'Balance is turned off');
    const currency = typeof body?.currency === 'string' && /^[A-Z]{3}$/.test(body.currency) ? body.currency : 'TRY';
    let cents = 0;
    try { cents = toCents(String(body?.amount ?? '')); } catch { /* checked below */ }
    if (cents < s.topupMin * 100 || cents > s.topupMax * 100) throw apiError(400, 'VALIDATION_FAILED', 'Invalid amount', { amount: 'OUT_OF_RANGE' });
    const id = await createInvoice(pool, { ownerId: req.user.id, kind: 'topup', currency, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      lines: [{ description: 'Bakiye yükleme', unitCents: cents }] });
    await audit(req, 'billing.topup_created', 'success', req.user.id, { invoiceId: id, amount: fromCents(cents), currency });
    return { invoiceId: id };
  }

  @Get('balance')
  async balance(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT id, amount::text, currency, reason, note, invoice_id AS "invoiceId", created_at AS "createdAt" FROM balance_entries
      WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.user.id]);
    return { balance: await balanceOf(pool, req.user.id), entries: rows };
  }

  // The customer cancels at the period's end (the server stays until then) or turns automatic renewal off.
  @Put('subscriptions/:id')
  async subscription(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const sets: string[] = []; const vals: unknown[] = [id, req.user.id];
    if (typeof body?.cancelAtPeriodEnd === 'boolean') { vals.push(body.cancelAtPeriodEnd); sets.push(`cancel_at_period_end = $${vals.length}`); }
    if (typeof body?.autoRenew === 'boolean') { vals.push(body.autoRenew); sets.push(`auto_renew = $${vals.length}`); }
    if (!sets.length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { cancelAtPeriodEnd: 'INVALID_VALUE' });
    const { rows: [b] } = await pool.query(`UPDATE subscriptions b SET ${sets.join(', ')}, updated_at = now() WHERE b.id = $1 AND b.owner_id = $2 AND b.status IN ('active', 'past_due', 'suspended')
      RETURNING ${subscriptionColumns}`, vals);
    if (!b) throw apiError(404, 'NOT_FOUND', 'Unknown subscription');
    await audit(req, 'billing.subscription_changed', 'success', req.user.id, { subscriptionId: id, ...body });
    return { subscription: b };
  }

  @Delete('cards/:id') @HttpCode(204)
  async removeCard(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query('DELETE FROM saved_cards WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown card');
    await pool.query('UPDATE saved_cards SET is_default = true WHERE id = (SELECT id FROM saved_cards WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM saved_cards WHERE owner_id = $1 AND is_default)', [req.user.id]);
    await audit(req, 'billing.card_removed', 'success', req.user.id, { cardId: id });
  }

  @Put('cards/:id/default') @HttpCode(204)
  async defaultCard(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE saved_cards SET is_default = false WHERE owner_id = $1', [req.user.id]);
      const { rowCount } = await client.query('UPDATE saved_cards SET is_default = true WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
      if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown card');
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
}

// The provider's answer (no session, no CSRF header: it comes from the provider or the customer's browser on its way back).
// Nothing in it is trusted: each provider is asked (or its signature checked) before the payment is recorded. A browser is
// then sent to the invoice; a server notification gets the text the provider expects.
@Controller('billing/callback')
export class BillingCallbackController {
  @All(':provider/:id')
  async back(@Res() reply: FastifyReply, @Param('provider') provider: string, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.handle(reply, provider, id, query ?? {}, body ?? {});
  }

  @Post(':provider')
  async notification(@Res() reply: FastifyReply, @Param('provider') provider: string, @Body() body: Record<string, unknown>) {
    const id = gateways[provider]?.paymentIdFrom?.(body ?? {});
    if (!id) throw apiError(404, 'NOT_FOUND', 'Unknown payment');
    return this.handle(reply, provider, id, {}, body ?? {});
  }

  private async handle(reply: FastifyReply, provider: string, id: string, query: Record<string, string>, body: Record<string, unknown>) {
    const { rows: [p] } = await pool.query('SELECT id, invoice_id, amount::text, currency, provider_ref, status, mode FROM payments WHERE id = $1 AND provider = $2', [id, provider]);
    const impl = gateways[provider];
    if (!p || !impl) throw apiError(404, 'NOT_FOUND', 'Unknown payment');
    if (p.status === 'pending') {
      const gw = await activeGateway(provider, p.mode);
      if (!gw) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'Provider not active');
      const r = await impl.verify({ query, body, payment: { id: p.id, amount: p.amount, currency: p.currency, providerRef: p.provider_ref } }, gw.creds, gw.mode)
        .catch((e: Error) => ({ ok: false as const, code: 'PROVIDER_ERROR', message: String(e?.message ?? e).slice(0, 200) }));
      // A provider that did not answer leaves the payment open (its notification or the customer may come back); a forged
      // or foreign answer changes nothing.
      if (r.ok || !['PROVIDER_ERROR', 'BAD_SIGNATURE'].includes(r.code)) await settlePayment(id, r);
      logEvent(r.ok ? 'info' : 'warn', 'payment_callback', { provider, paymentId: id, ok: r.ok, ...(!r.ok && { code: r.code }) });
    }
    if (impl.reply) return reply.code(200).type('text/plain').send(impl.reply);
    return reply.code(303).header('location', `/billing/invoices/${p.invoice_id}?payment=${id}`).send();
  }
}

// ---- Staff ----

@Controller('admin/billing') @UseGuards(PermissionGuard)
export class BillingAdminController {
  @Get('overview') @Can('billing.view')
  async overview() {
    const [mrr, open, month, series, subs, recent] = await Promise.all([
      pool.query(`SELECT currency, sum(amount / period_months)::text AS amount FROM subscriptions WHERE status IN ('active', 'past_due') GROUP BY currency ORDER BY currency`),
      pool.query(`SELECT currency, count(*)::int AS n, count(*) FILTER (WHERE due_at < now())::int AS overdue, sum(total - paid_total)::text AS amount
        FROM invoices WHERE status = 'unpaid' AND kind <> 'topup' GROUP BY currency ORDER BY currency`),
      pool.query(`SELECT currency, sum(amount - refunded)::text AS amount, count(*)::int AS n FROM payments WHERE status IN ('succeeded', 'partially_refunded') AND provider <> 'balance'
        AND completed_at >= date_trunc('month', now()) GROUP BY currency ORDER BY currency`),
      pool.query(`SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS month, currency, sum(amount - refunded)::text AS amount FROM payments
        WHERE status IN ('succeeded', 'partially_refunded') AND provider <> 'balance' AND completed_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1, 2 ORDER BY 1`),
      pool.query(`SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status`),
      pool.query(`SELECT p.id, p.provider, p.method, p.status, p.amount::text, p.currency, p.error_code AS "errorCode", p.created_at AS "createdAt", u.email
        FROM payments p JOIN users u ON u.id = p.owner_id ORDER BY p.created_at DESC LIMIT 10`),
    ]);
    return { mrr: mrr.rows, open: open.rows, collectedThisMonth: month.rows, series: series.rows,
      subscriptions: Object.fromEntries(subs.rows.map((r) => [r.status, r.n])), recentPayments: recent.rows };
  }

  @Get('invoices') @Can('billing.view')
  async invoices(@Query('status') status?: string, @Query('q') q?: string) {
    const st = ['unpaid', 'paid', 'cancelled', 'refunded', 'partially_refunded', 'overdue'].includes(status ?? '') ? status : null;
    const { rows } = await pool.query(`SELECT ${invoiceColumns} FROM invoices i WHERE ($1::text IS NULL OR ($1 = 'overdue' AND i.status = 'unpaid' AND i.due_at < now()) OR i.status = $1)
      AND ($2::text IS NULL OR i.number ILIKE '%' || $2 || '%' OR i.buyer->>'email' ILIKE '%' || $2 || '%' OR i.buyer->>'name' ILIKE '%' || $2 || '%' OR i.buyer->>'taxId' = $2)
      ORDER BY i.created_at DESC LIMIT 300`, [st, q?.trim() || null]);
    return { invoices: rows };
  }

  @Get('invoices/:id') @Can('billing.view')
  invoice(@Param('id', ParseUUIDPipe) id: string) { return invoiceDetail(id); }

  // An invoice staff write by hand (a setup fee, a service): lines with prices before tax.
  @Post('invoices') @HttpCode(201) @Can('billing.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const fields: Record<string, string> = {};
    const ownerId = typeof body?.userId === 'string' && /^[0-9a-f-]{36}$/i.test(body.userId) ? body.userId : (fields.userId = 'REQUIRED', '');
    const currency = typeof body?.currency === 'string' && /^[A-Z]{3}$/.test(body.currency) ? body.currency : (fields.currency = 'INVALID_CURRENCY', '');
    const raw = Array.isArray(body?.lines) ? body.lines.slice(0, 50) : [];
    const lines: LineIn[] = [];
    raw.forEach((l: Record<string, unknown>, i: number) => {
      const description = typeof l?.description === 'string' ? l.description.trim().slice(0, 300) : '';
      let unitCents = -1; try { unitCents = toCents(String(l?.unitPrice ?? '')); } catch { /* below */ }
      const quantity = Number(l?.quantity ?? 1);
      if (!description) fields[`lines.${i}.description`] = 'REQUIRED';
      if (unitCents < 0) fields[`lines.${i}.unitPrice`] = 'INVALID_AMOUNT';
      if (!(quantity > 0 && quantity <= 10000)) fields[`lines.${i}.quantity`] = 'OUT_OF_RANGE';
      lines.push({ description, unitCents, quantity });
    });
    if (!lines.length) fields.lines = 'REQUIRED';
    const days = Number(body?.dueDays ?? 7);
    if (!(Number.isInteger(days) && days >= 0 && days <= 90)) fields.dueDays = 'OUT_OF_RANGE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const id = await createInvoice(pool, { ownerId, kind: 'manual', currency, lines, dueAt: endOfDay(addDays(today(), days)), createdBy: req.user.id,
      note: typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) || undefined : undefined });
    const { rows: [inv] } = await pool.query('SELECT total::text, currency FROM invoices WHERE id = $1', [id]);
    await notify('billing.invoice', [ownerId], { invoiceId: id, total: inv.total, currency: inv.currency, due: addDays(today(), days) });
    await audit(req, 'billing.invoice_created', 'success', req.user.id, { invoiceId: id, target: ownerId });
    return { invoiceId: id };
  }

  @Post('invoices/:id/mark-paid') @HttpCode(200) @Can('billing.manage')
  async markPaid(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const method = ['bank_transfer', 'cash', 'other'].includes(String(body?.method)) ? String(body.method) : 'bank_transfer';
    const reference = typeof body?.reference === 'string' ? body.reference.trim().slice(0, 200) : '';
    const paymentId = await recordManual(id, method, reference, req.user.id);
    await audit(req, 'billing.marked_paid', 'success', req.user.id, { invoiceId: id, method, reference });
    return { paymentId };
  }

  @Post('invoices/:id/cancel') @HttpCode(200) @Can('billing.manage')
  async cancel(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [inv] } = await pool.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'unpaid' AND paid_total = 0 RETURNING kind", [id]);
    if (!inv) throw apiError(409, 'INVOICE_NOT_CANCELLABLE', 'Only an unpaid invoice with nothing paid can be cancelled');
    await audit(req, 'billing.invoice_cancelled', 'success', req.user.id, { invoiceId: id });
    return { ok: true };
  }

  // Gives money back: to the card at the provider, or to the customer's balance. A paid invoice stays issued; the
  // e-invoice side issues the return invoice (einvoice.ts).
  @Post('invoices/:id/refund') @HttpCode(200) @Can('billing.manage')
  async refund(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    return refundInvoice(req, id, body);
  }

  @Get('subscriptions') @Can('billing.view')
  async subscriptions(@Query('status') status?: string) {
    const { rows } = await pool.query(`SELECT ${subscriptionColumns}, u.email FROM subscriptions b JOIN users u ON u.id = b.owner_id
      WHERE ($1::text IS NULL OR b.status = $1) ORDER BY b.period_end NULLS LAST LIMIT 500`, [status || null]);
    return { subscriptions: rows };
  }

  // Staff change a subscription: its price, period, the next renewal date, or suspend / resume / cancel it now.
  @Put('subscriptions/:id') @Can('billing.manage')
  async subscription(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const { rows: [b] } = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    if (!b) throw apiError(404, 'NOT_FOUND', 'Unknown subscription');
    const fields: Record<string, string> = {};
    if (body?.amount !== undefined) { try { toCents(String(body.amount)); } catch { fields.amount = 'INVALID_AMOUNT'; } }
    if (body?.periodMonths !== undefined && ![1, 3, 6, 12].includes(Number(body.periodMonths))) fields.periodMonths = 'INVALID_VALUE';
    if (body?.periodEnd !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.periodEnd))) fields.periodEnd = 'INVALID_VALUE';
    const action = body?.action;
    if (action !== undefined && !['suspend', 'resume', 'cancel'].includes(String(action))) fields.action = 'INVALID_VALUE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await pool.query(`UPDATE subscriptions SET amount = coalesce($2, amount), period_months = coalesce($3, period_months), period_end = coalesce($4::date, period_end), updated_at = now() WHERE id = $1`,
      [id, body?.amount !== undefined ? String(body.amount) : null, body?.periodMonths !== undefined ? Number(body.periodMonths) : null, body?.periodEnd ?? null]);
    if (action === 'suspend') {
      await pool.query("UPDATE subscriptions SET status = 'suspended', suspended_at = now() WHERE id = $1", [id]);
      if (b.server_id) {
        const { rows: [srv] } = await pool.query("UPDATE servers SET billing_hold = true WHERE id = $1 AND state = 'ready' RETURNING id, owner_id, power_state", [b.server_id]);
        if (srv?.power_state === 'poweredOn') await startOperation(system, srv, 'power_off', `billing:hold:${srv.id}:${Date.now()}`, `billing:${srv.id}:hold`).catch(() => undefined);
      }
    } else if (action === 'resume') {
      await pool.query("UPDATE subscriptions SET status = 'active', suspended_at = NULL WHERE id = $1", [id]);
      if (b.server_id) await pool.query('UPDATE servers SET billing_hold = false WHERE id = $1', [b.server_id]);
    } else if (action === 'cancel') {
      await pool.query("UPDATE subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [id]);
      if (b.server_id) await pool.query('UPDATE servers SET billing_hold = false WHERE id = $1', [b.server_id]);
    }
    await audit(req, 'billing.subscription_updated', 'success', req.user.id, { subscriptionId: id, ...body });
    const { rows: [row] } = await pool.query(`SELECT ${subscriptionColumns} FROM subscriptions b WHERE b.id = $1`, [id]);
    return { subscription: row };
  }

  @Get('payments') @Can('billing.view')
  async payments(@Query('status') status?: string) {
    const { rows } = await pool.query(`SELECT p.id, p.invoice_id AS "invoiceId", i.number, p.provider, p.mode, p.method, p.status, p.amount::text, p.currency, p.refunded::text,
      p.error_code AS "errorCode", p.error_message AS "errorMessage", p.automatic, p.reference, p.created_at AS "createdAt", p.completed_at AS "completedAt", u.email
      FROM payments p JOIN users u ON u.id = p.owner_id JOIN invoices i ON i.id = p.invoice_id WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.created_at DESC LIMIT 300`, [status || null]);
    return { payments: rows };
  }

  // A balance correction (a goodwill credit, a fix): positive adds, negative takes away.
  @Post('balance') @HttpCode(201) @Can('billing.manage')
  async adjust(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const fields: Record<string, string> = {};
    const userId = typeof body?.userId === 'string' && /^[0-9a-f-]{36}$/i.test(body.userId) ? body.userId : (fields.userId = 'REQUIRED', '');
    const currency = typeof body?.currency === 'string' && /^[A-Z]{3}$/.test(body.currency) ? body.currency : (fields.currency = 'INVALID_CURRENCY', '');
    let cents = 0; try { cents = toCents(String(body?.amount ?? '')); } catch { fields.amount = 'INVALID_AMOUNT'; }
    if (!cents && !fields.amount) fields.amount = 'INVALID_AMOUNT';
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) : '';
    if (!note) fields.note = 'REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, note, created_by) VALUES ($1, $2, $3, 'adjustment', $4, $5)", [userId, fromCents(cents), currency, note, req.user.id]);
    await audit(req, 'billing.balance_adjusted', 'success', req.user.id, { target: userId, amount: fromCents(cents), currency, note });
    return { balance: await balanceOf(pool, userId) };
  }

  @Get('users/:id') @Can('billing.view')
  async user(@Param('id', ParseUUIDPipe) id: string) {
    const [balance, invoices, subs] = await Promise.all([balanceOf(pool, id),
      pool.query(`SELECT ${invoiceColumns} FROM invoices i WHERE i.owner_id = $1 ORDER BY i.created_at DESC LIMIT 50`, [id]),
      pool.query(`SELECT ${subscriptionColumns} FROM subscriptions b WHERE b.owner_id = $1 ORDER BY b.created_at DESC`, [id])]);
    return { balance, invoices: invoices.rows, subscriptions: subs.rows };
  }

  @Post('run') @HttpCode(200) @Can('billing.manage')
  async run(@Req() req: AuthedRequest) {
    const r = await runBilling();
    await audit(req, 'billing.run', 'success', req.user.id, r);
    return r;
  }
}

// Settings → Billing.
@Controller('admin/settings/billing') @UseGuards(PermissionGuard)
export class BillingSettingsController {
  @Get() @Can('settings.view', 'billing.view')
  async get() { return { billing: await settings() }; }

  @Put() @Can('billing.manage')
  async put(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const cur = await settings();
    const b = (body ?? {}) as Partial<BillingSettings>;
    const fields: Record<string, string> = {};
    const int = (k: keyof BillingSettings, min: number, max: number) => {
      const v = b[k] === undefined ? cur[k] : Number(b[k]);
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fields[k] = 'OUT_OF_RANGE';
      return v as number;
    };
    const bool = (k: keyof BillingSettings) => (typeof b[k] === 'boolean' ? b[k] : cur[k]) as boolean;
    const prefix = typeof b.invoicePrefix === 'string' ? b.invoicePrefix.trim().toUpperCase() : cur.invoicePrefix;
    if (!validPrefix(prefix)) fields.invoicePrefix = 'INVALID_VALUE';
    const reminderDays = Array.isArray(b.reminderDays) ? [...new Set(b.reminderDays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 30).sort((x, y) => y - x) : cur.reminderDays;
    const str = (o: Record<string, unknown> | undefined, k: string, max: number, fallback: string) => (typeof o?.[k] === 'string' ? (o[k] as string).trim().slice(0, max) : fallback);
    const company = Object.fromEntries(Object.entries(cur.company).map(([k, v]) => [k, str(b.company as Record<string, unknown>, k, k === 'address' ? 500 : 200, v)])) as BillingSettings['company'];
    const bank = { enabled: typeof b.bankTransfer?.enabled === 'boolean' ? b.bankTransfer.enabled : cur.bankTransfer.enabled,
      bank: str(b.bankTransfer as Record<string, unknown>, 'bank', 100, cur.bankTransfer.bank), holder: str(b.bankTransfer as Record<string, unknown>, 'holder', 200, cur.bankTransfer.holder),
      iban: str(b.bankTransfer as Record<string, unknown>, 'iban', 40, cur.bankTransfer.iban).replace(/\s/g, '').toUpperCase() };
    if (bank.enabled && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(bank.iban)) fields['bankTransfer.iban'] = 'INVALID_VALUE';
    const next: BillingSettings = { enabled: bool('enabled'), requirePayment: bool('requirePayment'), orderExpiryHours: int('orderExpiryHours', 1, 168),
      taxRate: int('taxRate', 0, 100), pricesIncludeTax: bool('pricesIncludeTax'), exportExempt: bool('exportExempt'), invoicePrefix: prefix,
      invoiceDaysBefore: int('invoiceDaysBefore', 0, 30), reminderDays, suspendAfterDays: int('suspendAfterDays', 1, 90), terminateAfterDays: int('terminateAfterDays', 0, 365),
      autoCharge: bool('autoCharge'), chargeRetries: int('chargeRetries', 1, 10), balance: bool('balance'), topupMin: int('topupMin', 1, 1_000_000), topupMax: int('topupMax', 1, 10_000_000),
      sandbox: bool('sandbox'), hourly: bool('hourly'), hourlyMinHours: b.hourlyMinHours === undefined ? cur.hourlyMinHours ?? 24 : int('hourlyMinHours', 1, 720),
      disputeWindowDays: b.disputeWindowDays === undefined ? cur.disputeWindowDays ?? 60 : int('disputeWindowDays', 1, 730),
      disputeAnswerDays: b.disputeAnswerDays === undefined ? cur.disputeAnswerDays ?? 7 : int('disputeAnswerDays', 1, 90), bankTransfer: bank, company };
    if (next.topupMax < next.topupMin) fields.topupMax = 'MIN_ABOVE_MAX';
    if (next.enabled && (!company.name || !company.taxId || !company.address)) fields['company.name'] = 'COMPANY_REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await saveSettings('billing', next);
    await audit(req, 'settings.billing', 'success', req.user.id, { enabled: next.enabled, requirePayment: next.requirePayment, sandbox: next.sandbox });
    return { billing: next };
  }
}

// What a resize costs now: the monthly increase for the rest of the server's paid period (nothing without billing,
// without a running subscription, or for a decrease, which simply bills less from the next period).
export async function resizeCharge(serverId: string, oldMonthly: string, newMonthly: string) {
  const s = await settings();
  // An hourly server simply costs more per hour from now on.
  const { rows: [sub] } = await pool.query(`SELECT period_start::text AS ps, period_end::text AS pe FROM subscriptions WHERE server_id = $1 AND status IN ('active', 'past_due')
    AND EXISTS (SELECT 1 FROM servers WHERE id = $1 AND billing_mode = 'monthly')`, [serverId]);
  const cents = s.enabled && sub?.ps && sub?.pe ? prorate(toCents(newMonthly) - toCents(oldMonthly), today(), sub.ps, sub.pe) : 0;
  return { chargeNow: fromCents(cents), periodEnd: sub?.pe ?? null };
}

// The invoice for a resize's increase; the balance pays it at once when it covers it, otherwise it waits like any invoice.
export async function billResize(server: { id: string; owner_id: string; name: string }, amount: string, currency: string, shape: { vcpu: number; memoryMb: number; diskGb: number }) {
  const client = await pool.connect();
  let id: string;
  try {
    await client.query('BEGIN');
    id = await createInvoice(client, { ownerId: server.owner_id, kind: 'manual', currency, dueAt: endOfDay(addDays(today(), 7)),
      lines: [{ description: `Sunucu ${server.name}: ${shape.vcpu} vCPU, ${shape.memoryMb / 1024} GB bellek, ${shape.diskGb} GB disk (dönem sonuna kadar fark)`, unitCents: toCents(amount) }] });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  const paid = (await settings()).balance && await payFromBalance(id, true, server.owner_id).catch(() => false);
  if (!paid) await notify('billing.invoice', [server.owner_id], { invoiceId: id, total: amount, currency, due: addDays(today(), 7) });
  return id;
}
