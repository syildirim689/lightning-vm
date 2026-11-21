// Billing: subscriptions, invoices, payments, the balance and saved cards, and the collection run (renewal invoices,
// automatic charges, reminders, overdue notices, suspension and termination). Rules without I/O are in billing-rules.ts,
// payment providers in billing-gateways.ts. An invoice awaits payment (a pro forma without a legal number) until it is
// paid; then it gets its number in the year's series and is issued (e-Fatura / e-Arşiv in einvoice.ts).
import { providers } from './payment-providers';
import { randomBytes } from 'node:crypto';
import { All, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { stripeEventPayment, stripeEventResult, stripeSignature } from './billing-providers';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool, redis, foldSql, foldText } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { notify } from './notify';
import { activeGateway, testModeOver } from './payments';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { rateLimit } from './security';
import { getSettings, saveSettings, type BillingSettings } from './settings-store';
import { enqueue, startOperation } from './servers';
import { finalResult, gateways, needsReview, reviewCodes, sandboxPay, underReview, type Result } from './billing-gateways';
import { restoreHold } from './restore-hold';
import { renewalPrice, type CouponUse } from './coupons';
import { addDays, addMonths, cleanProfile, collectionStep, daysBetween, fromCents, dueDay, hoursDue, invoiceNumber, lineAmounts, nextRenewalOf, periodMonths, prorate, renewalDue, settleSplit, taxFor, toCents, totals, validPrefix } from './billing-rules';

type Db = Pick<Pool, 'query'> | PoolClient;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// shortcut: billing days are Istanbul calendar days (Turkey is UTC+3 all year); make it a setting for other countries.
const zone = 'Europe/Istanbul';
export const today = (at = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(at);
const endOfDay = (day: string) => `${day}T23:59:59+03:00`;
const settings = () => getSettings('billing');
// Acting for nobody in particular (the collection run): audit rows have no actor. `billing` tells startOperation that
// the hold on a server is billing's own (servers.ts).
const system = { id: 'billing', ip: null, billing: true, user: { id: null, permissions: [] } } as unknown as AuthedRequest;

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

// A cancelled invoice gives its subscription periods back (migration 070): its lines stay, marked withdrawn, so the same
// period can be invoiced again. Called wherever an invoice is cancelled.
export async function withdrawLines(db: Db, invoiceIds: string[]) {
  if (invoiceIds.length) await db.query('UPDATE invoice_lines SET withdrawn = true WHERE invoice_id = ANY($1::uuid[]) AND NOT withdrawn', [invoiceIds]);
}

export type After = { enqueue: string[]; powerOn: { id: string; owner_id: string }[]; paid: Row[] };
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
  await grant(db, invoiceId, after);
  after.paid.push({ ...inv, number });
}

// What an invoice was for is given: its subscriptions run (for the period on the line), a waiting build starts, a hold
// is lifted. For a paid invoice (markPaid), and for one staff withdraw: the customer owes nothing for it either way.
async function grant(db: PoolClient, invoiceId: string, after: After) {
  const { rows: lines } = await db.query('SELECT *, period_start::text AS ps, period_end::text AS pe FROM invoice_lines WHERE invoice_id = $1 AND subscription_id IS NOT NULL', [invoiceId]);
  for (const l of lines) {
    const { rows: [sub] } = await db.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [l.subscription_id]);
    if (!sub || ['cancelled', 'ended'].includes(sub.status)) continue;
    const start = l.ps ?? null;
    const end = l.pe ?? null;
    // Several invoices of one subscription can be open (the order, a renewal, a resize): while another is still unpaid
    // past its due date the period moves on, but the subscription stays overdue or suspended and the hold stays on.
    const { rows: [owing] } = ['past_due', 'suspended'].includes(sub.status) ? await db.query(`SELECT 1 FROM invoices i JOIN invoice_lines o ON o.invoice_id = i.id
      WHERE o.subscription_id = $1 AND i.id <> $2 AND i.status = 'unpaid' AND greatest(i.due_at, coalesce(i.dunning_from, i.due_at)) < now() LIMIT 1`, [sub.id, invoiceId]) : { rows: [] };
    await db.query(`UPDATE subscriptions SET status = CASE WHEN $4::boolean THEN status ELSE 'active' END, period_start = coalesce($2, period_start), period_end = greatest(coalesce($3, period_end), period_end),
      suspended_at = CASE WHEN $4::boolean THEN suspended_at END, updated_at = now() WHERE id = $1`, [sub.id, start, end, !!owing]);
    if (sub.status === 'pending' && sub.server_id) {
      // The order's server waited for this payment: it is built now (with a fresh deadline).
      const { rows } = await db.query(`UPDATE operations SET step = 'queued', deadline_at = now() + interval '45 minutes', updated_at = now()
        WHERE server_id = $1 AND kind = 'create' AND status = 'pending' AND step = 'awaiting_payment' RETURNING id`, [sub.server_id]);
      after.enqueue.push(...rows.map((r) => r.id));
    }
    if (sub.status === 'suspended' && !owing && (sub.server_id || sub.vdc_id)) {
      // The subscription's server, or every server of its data center.
      const { rows: freed } = await db.query(`UPDATE servers SET billing_hold = false, updated_at = now() WHERE (id = $1 OR vdc_id = $2) AND billing_hold
        RETURNING id, owner_id, state, power_state`, [sub.server_id, sub.vdc_id]);
      for (const srv of freed) if (srv.state === 'ready' && srv.power_state === 'poweredOff') after.powerOn.push(srv);
    }
  }
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

// One payment's result, inside the caller's transaction: recorded once, the invoice paid when covered. `settled`: this
// call changed it (a payment that already has its result is left as it is). `held`: the result is one nobody vouches for
// (Param's return): as a failure it does not close a payment that an earlier answer put under review.
async function settleIn(client: PoolClient, paymentId: string, r: Result, after: After, held = false): Promise<{ p?: Row; status: string; settled: boolean }> {
  const { rows: [p] } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!p || p.status !== 'pending') return { p, status: p?.status ?? 'missing', settled: false };
  if (!r.ok) {
    if (held && underReview(p.error_code)) return { p, status: 'pending', settled: false };
    await client.query("UPDATE payments SET status = 'failed', error_code = $2, error_message = $3, provider_ref = coalesce($4, provider_ref), completed_at = now() WHERE id = $1",
      [paymentId, r.code.slice(0, 60), (r.message ?? '').slice(0, 300), r.ref ?? null]);
    return { p, status: 'failed', settled: true };
  }
  await client.query("UPDATE payments SET status = 'succeeded', provider_ref = coalesce(nullif($2, ''), provider_ref), completed_at = now() WHERE id = $1", [paymentId, r.ref]);
  if (r.card && p.save_card) {
    const { rows: [d] } = await client.query('SELECT 1 FROM saved_cards WHERE owner_id = $1 AND is_default', [p.owner_id]);
    await client.query(`INSERT INTO saved_cards (owner_id, provider, mode, token_enc, brand, last4, exp_month, exp_year, holder, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.owner_id, p.provider, p.mode, encryptSecret(r.card.token, 'billing:card'), r.card.brand ?? null, r.card.last4 ?? null, r.card.expMonth ?? null, r.card.expYear ?? null, r.card.holder ?? null, !d]);
  }
  // A renewal is paid at its server's price of now: a payment begun for an earlier, lower total leaves the rest owed.
  await priceRenewal(client, p.invoice_id, after);
  // The money is the customer's wherever it lands: what the invoice still needs goes to it; the rest, or all of it when the
  // invoice was cancelled or paid meanwhile (two payments open at once, an order that expired on the provider's page), becomes balance.
  const { rows: [inv] } = await client.query('SELECT status, total::text AS total, paid_total::text AS paid FROM invoices WHERE id = $1 FOR UPDATE', [p.invoice_id]);
  const to = settleSplit(inv.status === 'unpaid', toCents(inv.total), toCents(inv.paid), toCents(String(p.amount)));
  if (inv.status === 'unpaid') {
    const { rows: [now] } = await client.query('UPDATE invoices SET paid_total = paid_total + $2 WHERE id = $1 RETURNING paid_total >= total AS covered', [p.invoice_id, fromCents(to.invoice)]);
    if (now.covered) await markPaid(client, p.invoice_id, after);
  }
  if (to.balance > 0) {
    await client.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, payment_id, note) VALUES ($1, $2, $3, 'adjustment', $4, $5, $6)",
      [p.owner_id, fromCents(to.balance), p.currency, p.invoice_id, paymentId, 'Faturaya sayılmayan ödeme / Payment not applied to the invoice']);
  }
  return { p, status: 'succeeded', settled: true };
}

// A payment came back from the provider (or the sandbox page).
export async function settlePayment(paymentId: string, r: Result, held = false) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  let out: Awaited<ReturnType<typeof settleIn>>;
  try {
    await client.query('BEGIN');
    out = await settleIn(client, paymentId, r, after, held);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  if (out.settled && !r.ok) await notify('billing.payment_failed', [out.p!.owner_id], { invoiceId: out.p!.invoice_id, amount: out.p!.amount, currency: out.p!.currency, code: r.code });
  await finish(after);
  return out.status;
}

// An answer that settles nothing but needs a person (needsReview): the payment stays open with the reason on it, where
// staff see it (Admin → Billing → Payments, status "review") and settle the invoice by hand. Logged once per reason. A
// provider's later, different explanation replaces the note; with `first` (an answer nobody vouches for: Param's return)
// only the first one is kept, so whoever posts the form again cannot rewrite what staff confirm from.
async function noteReview(paymentId: string, r: Result, first = false) {
  if (r.ok || !needsReview(r)) return;
  const message = (r.message ?? '').slice(0, 300);
  const client = await pool.connect();
  let noted = false;
  let entered: Record<string, unknown> | undefined;
  try {
    await client.query('BEGIN');
    // The payment is locked while it is looked at, so two answers arriving together are told apart: one of them
    // puts it under review, the other finds it there.
    const { rows: [was] } = await client.query("SELECT error_code, error_message FROM payments WHERE id = $1 AND status = 'pending' FOR UPDATE", [paymentId]);
    if (was && (first ? was.error_code === null : was.error_code !== r.code || was.error_message !== message)) {
      // review_since: when it began to wait for staff; a later, different reason does not start the wait again.
      const { rows: [p] } = await client.query(`UPDATE payments p SET error_code = $2, error_message = $3, review_since = CASE WHEN $4::boolean THEN coalesce(p.review_since, now()) ELSE now() END
        FROM invoices i, users u WHERE p.id = $1 AND i.id = p.invoice_id AND u.id = p.owner_id
        RETURNING p.invoice_id AS "invoiceId", coalesce(i.number, '') AS number, p.amount::text AS amount, trim(p.currency) AS currency, p.provider, u.email`, [paymentId, r.code, message, underReview(was.error_code)]);
      noted = true;
      if (p && !underReview(was.error_code)) entered = p;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
  if (noted) logEvent('warn', 'payment_needs_review', { paymentId, code: r.code });
  // Staff are told once, when the payment begins to wait for them: not again for a later answer about the same payment.
  if (entered) await notify('billing.payment_review', 'staff:billing.manage', { ...entered, paymentId, code: r.code });
}

// A renewal invoice is never paid below its server's current price for the period it covers, whatever the order of
// resize, run and payment: before a payment is taken for it (balance, staff's "mark paid", a provider's settlement), in
// that payment's transaction, the invoice follows the server (repriceOpenRenewal). Returns how many invoices changed.
async function priceRenewal(db: PoolClient, invoiceId: string, after: After) {
  const { rows } = await db.query(`SELECT DISTINCT b.server_id FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id JOIN subscriptions b ON b.id = l.subscription_id
    WHERE i.id = $1 AND i.kind = 'renewal' AND i.status = 'unpaid' AND NOT l.withdrawn AND b.server_id IS NOT NULL`, [invoiceId]);
  let changed = 0;
  for (const r of rows) changed += await repriceOpenRenewal(r.server_id, db, after);
  return changed;
}
// The same before a payment is begun at a provider, so the amount it asks for is the one owed now.
async function priceNow(invoiceId: string) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  try {
    await client.query('BEGIN');
    await priceRenewal(client, invoiceId, after);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
}

// Pays what is left of an invoice from the owner's balance in its currency, if the balance covers it.
export async function payFromBalance(invoiceId: string, automatic = false, by: string | null = null) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  let paid = false;
  try {
    await client.query('BEGIN');
    const open = "SELECT * FROM invoices WHERE id = $1 AND status = 'unpaid' AND kind <> 'topup' FOR UPDATE";
    let { rows: [inv] } = await client.query(open, [invoiceId]);
    // A renewal is paid at its server's price of now (priceRenewal); what that changed stays, whether or not the balance
    // then covers the invoice.
    if (inv && await priceRenewal(client, invoiceId, after)) ({ rows: [inv] } = await client.query(open, [invoiceId]));
    // Not while a payment for it is being reviewed (reviewWindow): the customer is told so, an automatic try just waits.
    if (inv && await reviewWindow(client, invoiceId)) {
      if (!automatic) throw inReview();
      inv = undefined;
    }
    if (inv) {
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [inv.owner_id]); // one balance spend at a time
      const due = toCents(inv.total) - toCents(inv.paid_total);
      const { rows: [b] } = await client.query('SELECT coalesce(sum(amount), 0)::text AS amount FROM balance_entries WHERE owner_id = $1 AND currency = $2', [inv.owner_id, inv.currency]);
      if (due > 0 && toCents(b.amount) >= due) {
        const { rows: [p] } = await client.query(`INSERT INTO payments (invoice_id, owner_id, provider, method, status, amount, currency, automatic, created_by, completed_at)
          VALUES ($1, $2, 'balance', 'balance', 'succeeded', $3, $4, $5, $6, now()) RETURNING id`, [invoiceId, inv.owner_id, fromCents(due), inv.currency, automatic, by]);
        await client.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, payment_id) VALUES ($1, $2, $3, 'invoice', $4, $5)",
          [inv.owner_id, fromCents(-due), inv.currency, invoiceId, p.id]);
        await client.query('UPDATE invoices SET paid_total = total WHERE id = $1', [invoiceId]);
        await markPaid(client, invoiceId, after);
        paid = true;
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
  return paid;
}

// Staff record money that arrived outside the panel (bank transfer, cash): the invoice is paid with it. It is also how
// staff settle a payment under review (noteReview): they found the money at the provider and mark the invoice paid. The
// invoice's payments that wait for staff end there, in the same transaction (status cancelled, their reason kept, the
// manual payment named in `reference`): the money is counted once, by the manual payment. Left open, such a payment
// stayed on the staff's list for good, and a provider's later "paid" for it (a fraud review that ended, asked again by
// the run or by anyone opening its return address) settled it a second time, as balance on top of the paid invoice.
async function recordManual(invoiceId: string, method: string, reference: string, by: string) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  let id = '';
  let repriced = false;
  let closed: string[] = [];
  try {
    await client.query('BEGIN');
    // Locked before the invoice, the order a provider's answer takes them in (settleIn: the payment, then its invoice).
    const { rows: waiting } = await client.query("SELECT id FROM payments WHERE invoice_id = $1 AND status = 'pending' AND error_code = ANY($2) ORDER BY created_at FOR UPDATE", [invoiceId, reviewCodes]);
    // The invoice stays locked until the payment is settled: a second "mark paid" waits here, then finds it paid.
    const { rows: [inv] } = await client.query("SELECT * FROM invoices WHERE id = $1 AND status = 'unpaid' FOR UPDATE", [invoiceId]);
    if (!inv) throw apiError(409, 'INVOICE_NOT_PAYABLE', 'Only an unpaid invoice can be paid');
    // Staff confirm the amount they saw. A renewal that first has to follow its server's price (priceRenewal) keeps its
    // new amount and staff are asked again, rather than money being recorded that did not arrive.
    repriced = (await priceRenewal(client, invoiceId, after)) > 0;
    if (!repriced) {
      const due = toCents(inv.total) - toCents(inv.paid_total);
      const { rows: [p] } = await client.query(`INSERT INTO payments (invoice_id, owner_id, provider, method, status, amount, currency, reference, created_by)
        VALUES ($1, $2, 'manual', $3, 'pending', $4, $5, $6, $7) RETURNING id`, [invoiceId, inv.owner_id, method, fromCents(due), inv.currency, reference || null, by]);
      id = p.id;
      await settleIn(client, id, { ok: true, ref: '' }, after);
      closed = await closeReviews(client, waiting.map((w) => w.id as string), `Closed by staff: invoice marked paid (payment ${id})`);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
  if (repriced) throw apiError(409, 'INVOICE_AMOUNT_CHANGED', 'The invoice now follows the server\'s current price; check the new amount and mark it paid again');
  return { id, closed };
}

// Ends the wait of payments under review without settling them: cancelled, with the reason they were held kept on the
// row and `note` saying how staff decided. From then on no return, notification or re-check changes them (each acts on
// a pending payment only). Returns the ids it closed.
async function closeReviews(db: Db, ids: string[], note: string) {
  if (!ids.length) return [];
  const { rows } = await db.query("UPDATE payments SET status = 'cancelled', completed_at = now(), reference = $3 WHERE id = ANY($1::uuid[]) AND status = 'pending' AND error_code = ANY($2) RETURNING id",
    [ids, reviewCodes, note.slice(0, 200)]);
  return rows.map((r) => r.id as string);
}

// The review window (billing-rules.ts, inReviewWindow) as SQL, for an invoice id expression: a payment of the invoice
// waits for staff and began to wait less than `days` days ago (Settings → Billing, reviewHoldDays). While it holds, the
// invoice is not suspended, terminated or expired, nobody is reminded to pay it, and the customer cannot pay it again;
// after it, with the review still open, the invoice is collected like any other unpaid one and may be paid again (a
// server held or deleted for it must have a way out that does not wait for staff).
const reviewWindowFrom = (invoice: string, codes: string, days: string) => `FROM payments rw WHERE rw.invoice_id = ${invoice} AND rw.status = 'pending' AND rw.error_code = ANY(${codes})
  AND coalesce(rw.review_since, rw.created_at) > now() - make_interval(days => ${days}::int)`;
const reviewWindowSql = (invoice: string, codes: string, days: string) => `EXISTS (SELECT 1 ${reviewWindowFrom(invoice, codes, days)})`;
// Until when the window holds for one invoice (null: it does not hold): the latest wait inside it, plus the days. The
// refusal to pay (reviewWindow) and what the invoice's answer tells the customer (payBlockedUntil) are this one query.
export async function reviewWindowUntil(db: Db, invoiceId: string): Promise<Date | null> {
  const { rows: [r] } = await db.query(`SELECT max(coalesce(rw.review_since, rw.created_at)) + make_interval(days => $3::int) AS until ${reviewWindowFrom('$1', '$2', '$3')}`,
    [invoiceId, reviewCodes, (await settings()).reviewHoldDays ?? 7]);
  return r?.until ?? null;
}
export const reviewWindow = async (db: Db, invoiceId: string) => (await reviewWindowUntil(db, invoiceId)) !== null;
// A second payment for an invoice whose payment is being reviewed could take the money twice: refused while the
// review window holds, at every way a customer pays (the invoice's pay route: balance, saved card, a provider's page).
// Card payments one account may start in an hour (startCardPayment): far more than paying one's invoices takes.
export const paymentsPerHour = 20;
const inReview = () => apiError(409, 'PAYMENT_IN_REVIEW', 'A payment for this invoice is being reviewed; it cannot be paid again until that is decided');

// Starts a card payment at the chosen provider; returns where the customer goes to finish it (3D Secure).
async function startCardPayment(req: AuthedRequest, inv: Row, provider: string, saveCard: boolean) {
  const s = await settings();
  const gw = provider === 'sandbox' ? (s.sandbox ? { mode: 'test' as const, creds: {} } : null) : await activeGateway(provider);
  const impl = gateways[provider];
  if (!gw || !impl) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available');
  // A provider that collects only some currencies (Param: lira) would take this invoice's number in its own.
  if (impl.currencies && !impl.currencies.includes(String(inv.currency).trim())) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available');
  // Here, where every card payment begins, whichever route asked: none while one for the invoice is being reviewed.
  if (await reviewWindow(pool, inv.id)) throw inReview();
  // Each started payment is a row staff may have to look at, and one that comes under review tells everybody who
  // manages billing (noteReview): an account starts only so many an hour, across its invoices.
  await rateLimit(`pay-start:${inv.owner_id}`, paymentsPerHour, 3600);
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
async function chargeSavedCard(seen: Row) {
  // The amount is read after the invoice took its server's price of now (priceNow); the caller's row may be older.
  await priceNow(seen.id);
  const { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND status = 'unpaid'", [seen.id]);
  if (!inv || await reviewWindow(pool, inv.id)) return false;
  const { rows: [card] } = await pool.query('SELECT * FROM saved_cards WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC LIMIT 1', [inv.owner_id]);
  const impl = card && gateways[card.provider];
  if (!card || !impl?.chargeSaved || (impl.currencies && !impl.currencies.includes(String(inv.currency).trim()))) return false;
  // A card saved in the sandbox is a test card: with the sandbox switched off it pays nothing.
  if (card.provider === 'sandbox' && !(await settings()).sandbox) return false;
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

// Servers and data centers billed before billing was on (or by staff) get a subscription on their anniversary day. Not
// one whose subscription staff cancelled on purpose ("Cancel now": it runs unbilled until staff resume it), nor a server
// billing is still trying to delete.
async function adopt() {
  // A reseller's customer's server is billed to the reseller.
  const { rows } = await pool.query(`SELECT 'server' AS kind, s.id, coalesce((SELECT u.reseller_id FROM users u WHERE u.id = s.owner_id), s.owner_id) AS owner_id, s.name, s.price_monthly::text AS amount, trim(s.currency) AS currency, s.created_at FROM servers s
      WHERE s.state IN ('ready', 'error', 'provisioning') AND s.vdc_id IS NULL AND s.price_monthly > 0 AND s.billing_mode = 'monthly' AND s.external_source IS NULL
        AND NOT EXISTS (SELECT 1 FROM subscriptions b WHERE b.server_id = s.id AND (b.status NOT IN ('cancelled', 'ended') OR b.staff_cancelled))
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.step = 'awaiting_payment')
        AND s.billing_remove IS NULL
    UNION ALL SELECT 'vdc', v.id, v.owner_id, v.name, v.price_monthly::text, trim(v.currency), v.created_at FROM vdcs v
      WHERE v.active AND v.price_monthly > 0 AND NOT EXISTS (SELECT 1 FROM subscriptions b WHERE b.vdc_id = v.id AND (b.status NOT IN ('cancelled', 'ended') OR b.staff_cancelled))`);
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
    const { rows: gone } = await pool.query(`UPDATE invoices i SET status = 'cancelled', cancelled_at = now() WHERE i.status = 'unpaid' AND i.paid_total = 0 AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN subscriptions b ON b.id = l.subscription_id WHERE l.invoice_id = i.id AND b.status NOT IN ('ended', 'cancelled')) RETURNING i.id`);
    await withdrawLines(pool, gone.map((g) => g.id));
  }
  return rows.length;
}

// Deletes a server for billing (cancelled at period end, or terminated unpaid): as the owner's delete would. The decision
// stays on the server (billing_remove, migration 071): one that is busy with another operation, or still being built, keeps
// its state and is tried again by the following runs (retryRemovals) instead of running on with its subscription ended.
async function removeServer(serverId: string, reason: 'cancel' | 'terminate') {
  await pool.query("UPDATE servers SET billing_remove = $2 WHERE id = $1 AND state NOT IN ('deleted', 'deleting')", [serverId, reason]);
  // The self-join reads the state before the update, to put it back when the delete cannot start.
  const { rows: [s] } = await pool.query(`UPDATE servers n SET locked = false, state = 'deleting', updated_at = now() FROM servers o
    WHERE n.id = $1 AND o.id = n.id AND n.state IN ('ready', 'error') RETURNING n.id, n.owner_id, o.state AS was`, [serverId]);
  if (!s) return;
  await startOperation(system, s, 'delete', `billing:${reason}:${serverId}:${Date.now()}`, `billing:${serverId}:delete`).catch(async () => {
    await pool.query("UPDATE servers SET state = $2, updated_at = now() WHERE id = $1 AND state = 'deleting'", [serverId, s.was]);
  });
}
// Each run: servers billing decided to delete that are still there and free now. After a delete that failed in the
// worker, not more than once an hour (staff can retry the operation meanwhile).
async function retryRemovals() {
  const { rows } = await pool.query(`SELECT s.id, s.billing_remove FROM servers s WHERE s.billing_remove IS NOT NULL AND s.state IN ('ready', 'error')
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND (o.status IN ('pending', 'running') OR (o.kind = 'delete' AND o.created_at > now() - interval '1 hour')))`);
  for (const r of rows) await removeServer(r.id, r.billing_remove);
  return rows.length;
}
// A data center that ends (cancelled at its period's end, or terminated unpaid) goes with its servers; switched off, it
// reserves nothing and is not adopted again.
async function endVdc(vdcId: string, reason: 'cancel' | 'terminate') {
  const { rows } = await pool.query("SELECT id FROM servers WHERE vdc_id = $1 AND state NOT IN ('deleted', 'deleting')", [vdcId]);
  for (const srv of rows) await removeServer(srv.id, reason);
  await pool.query('UPDATE vdcs SET active = false, updated_at = now() WHERE id = $1', [vdcId]);
}

// A held server is powered off. When that cannot start (another operation is open) the server remembers it
// (hold_power_off) and the following runs try again (retryHolds).
export async function powerOffHeld(srv: { id: string; owner_id: string }, key: string) {
  await startOperation(system, srv, 'power_off', key, `billing:${srv.id}:hold`).then(
    () => pool.query('UPDATE servers SET hold_power_off = false WHERE id = $1 AND hold_power_off', [srv.id]),
    () => pool.query('UPDATE servers SET hold_power_off = true WHERE id = $1 AND billing_hold', [srv.id]));
}
// Suspended for non-payment: the subscription's server, or every server of its data center, is held and powered off.
async function hold(b: { server_id: string | null; vdc_id: string | null }, key: string | number) {
  if (!b.server_id && !b.vdc_id) return;
  const { rows } = await pool.query("UPDATE servers SET billing_hold = true, updated_at = now() WHERE (id = $1 OR vdc_id = $2) AND state = 'ready' AND NOT billing_hold RETURNING id, owner_id, power_state", [b.server_id, b.vdc_id]);
  for (const srv of rows) if (srv.power_state === 'poweredOn') await powerOffHeld(srv, `billing:hold:${srv.id}:${key}`);
}
// Each run: suspended subscriptions whose server was not ready when the hold was set (being resized, say) are held now;
// and (also with the panel's own billing off, for holds an outside billing system set) power-offs that could not start are issued again.
async function retryHolds(now: Date) {
  const { rows: late } = await pool.query(`SELECT b.server_id, b.vdc_id FROM subscriptions b WHERE b.status = 'suspended'
    AND EXISTS (SELECT 1 FROM servers s WHERE (s.id = b.server_id OR s.vdc_id = b.vdc_id) AND s.state = 'ready' AND NOT s.billing_hold)`);
  for (const b of late) await hold(b, now.getTime());
}
async function retryPowerOffs(now: Date) {
  await pool.query("UPDATE servers SET hold_power_off = false WHERE hold_power_off AND (NOT billing_hold OR state = 'deleted' OR (state = 'ready' AND power_state <> 'poweredOn'))");
  const { rows } = await pool.query(`SELECT s.id, s.owner_id FROM servers s WHERE s.hold_power_off AND s.billing_hold AND s.state = 'ready' AND s.power_state = 'poweredOn'
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running'))`);
  for (const srv of rows) await powerOffHeld(srv, `billing:hold:${srv.id}:${now.getTime()}`);
}
// An order that will not be paid (expired, or its invoice withdrawn by staff): the subscription ends, the coupon use is
// given back and the waiting build is cancelled (its address and capacity freed). Returns the operations to enqueue.
async function dropOrder(db: Db, invoiceId: string) {
  const ops: string[] = [];
  const { rows: subs } = await db.query(`UPDATE subscriptions b SET status = 'cancelled', cancelled_at = now(), updated_at = now() FROM invoice_lines l
    WHERE l.invoice_id = $1 AND l.subscription_id = b.id AND b.status = 'pending' RETURNING b.server_id`, [invoiceId]);
  for (const b of subs) {
    await db.query('DELETE FROM coupon_redemptions WHERE server_id = $1', [b.server_id]); // an order never paid gives its coupon use back
    const { rows } = await db.query(`UPDATE operations SET cancel_requested = true, step = 'queued', updated_at = now()
      WHERE server_id = $1 AND kind = 'create' AND status = 'pending' AND step = 'awaiting_payment' RETURNING id`, [b.server_id]);
    ops.push(...rows.map((r) => r.id as string));
  }
  return ops;
}

// A customer stops being a reseller's (reseller.ts: the reseller is removed, staff take the customer out, or the customer
// leaves): from then on the reseller cannot act on the customer's servers, so who pays follows who controls, as it does
// when a server changes hands (transfers.ts, moveServer). In the caller's transaction, which holds the customer's row:
//   - the running subscriptions of the customer's servers that the reseller pays become the customer's, without what
//     the reseller booked on them (a cancellation at the period's end, the auto-renew choice), and a removal billing
//     had marked for one of those servers is taken back;
//   - the reseller's unpaid renewal invoices for them, with nothing paid, are cancelled and give their periods back
//     (withdrawLines), so the next run invoices the customer for the first period nobody paid: direct billing starts
//     there, at the server's price. The subscription starts it with a clean slate (active, the hold lifted): the
//     reseller's arrears are not the customer's, and the new invoice has its own due date and reminders;
//   - an order of the reseller's that still waits for payment (nothing built) is dropped with its invoice, like an
//     order that expired (dropOrder);
//   - any other unpaid invoice of the reseller that names these servers (a built server's first invoice, a resize or
//     disk charge, one partly paid or shared with other servers) stays the reseller's debt and is returned as `left`
//     for staff: it is collected from the reseller, and while it is open it still counts against the subscription.
// Prices are not changed here; reseller.ts (listPrices) then takes the reseller's discount off the servers whose
// subscription moved, so the customer's first invoice and every renewal are at the list price, while the period the
// reseller already paid stays as it is. Returns what changed; `enqueue`: operations to queue once the transaction is committed.
export async function directBilling(db: PoolClient, customerId: string, resellerId: string) {
  const theirs = `SELECT 1 FROM invoice_lines l JOIN subscriptions b ON b.id = l.subscription_id JOIN servers s ON s.id = b.server_id
    WHERE l.invoice_id = i.id AND NOT l.withdrawn AND s.owner_id = $1 AND b.owner_id = $2`;
  // Invoices first, subscriptions after them: the order a payment locks them in (markPaid, grant).
  const { rows: invoices } = await db.query(`SELECT i.id, i.kind, i.paid_total::text AS paid, EXISTS (${theirs} AND b.status = 'pending') AS waiting,
      NOT EXISTS (SELECT 1 FROM invoice_lines x WHERE x.invoice_id = i.id AND NOT x.withdrawn AND NOT EXISTS (SELECT 1 FROM subscriptions xb JOIN servers xs ON xs.id = xb.server_id
        WHERE xb.id = x.subscription_id AND xs.owner_id = $1 AND xb.owner_id = $2)) AS only_theirs
    FROM invoices i WHERE i.owner_id = $2 AND i.status = 'unpaid' AND EXISTS (${theirs}) ORDER BY i.created_at FOR UPDATE OF i`, [customerId, resellerId]);
  const withdrawn: string[] = [], left: string[] = [], queue: string[] = [];
  for (const i of invoices) {
    if (toCents(i.paid) === 0 && i.only_theirs && (i.kind === 'renewal' || (i.kind === 'order' && i.waiting))) {
      await db.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [i.id]);
      await withdrawLines(db, [i.id]);
      if (i.kind === 'order') queue.push(...await dropOrder(db, i.id));
      withdrawn.push(i.id);
    } else left.push(i.id);
  }
  const { rows: subs } = await db.query(`UPDATE subscriptions b SET owner_id = $1, status = 'active', suspended_at = NULL, cancel_at_period_end = false, auto_renew = true, updated_at = now()
    FROM servers s WHERE s.id = b.server_id AND s.owner_id = $1 AND b.owner_id = $2 AND b.status IN ('active', 'past_due', 'suspended') RETURNING b.id, b.server_id`, [customerId, resellerId]);
  await db.query(`UPDATE servers SET billing_hold = false, updated_at = now() WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND billing_hold`, [customerId, subs.map((b) => b.server_id)]);
  // Only those servers: one whose subscription had already ended or been cancelled (by the customer for a server they
  // paid themselves, or by the reseller before the release) keeps billing's decision to delete it; cleared, the next
  // run would give it a fresh subscription (adopt) and it would live on, billed, against that decision.
  await db.query("UPDATE servers SET billing_remove = NULL, updated_at = now() WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND billing_remove IS NOT NULL AND state IN ('ready', 'error')",
    [customerId, subs.map((b) => b.server_id)]);
  return { subscriptions: subs.map((b) => b.id as string), servers: subs.map((b) => b.server_id as string), withdrawn, left, enqueue: queue };
}

// Staff withdraw an unpaid invoice (or accept a dispute against it in full): what it asked for is waived. A renewal's
// period is free (the subscription moves on as if it were paid, so the run does not invoice that period again); an order
// still waiting for it is dropped with its build. The run's own cancellations (a server gone, a termination, an expired
// order) only release the period (withdrawLines). false: not an unpaid invoice with nothing paid.
export async function withdrawInvoice(id: string) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  try {
    await client.query('BEGIN');
    const { rows: [inv] } = await client.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'unpaid' AND paid_total = 0 RETURNING id", [id]);
    if (!inv) { await client.query('ROLLBACK'); return false; }
    await withdrawLines(client, [id]);
    after.enqueue.push(...await dropOrder(client, id));
    await grant(client, id, after);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
  return true;
}

// Card payments left open at providers that can be asked without the customer's browser (Gateway.recheck: Stripe, iyzico,
// Craftgate): someone who paid and closed the tab never comes back through the return address. From five minutes after
// they began (the return normally settles them first) until a day later, when the provider's page has long expired and
// one still unanswered is closed. settlePayment locks the payment, so this and a return arriving together settle it once.
async function recheckPayments() {
  const providers = Object.entries(gateways).filter(([, g]) => g.recheck).map(([id]) => id);
  const { rows } = await pool.query(`SELECT id, provider, mode, amount::text, currency, provider_ref, created_at < now() - interval '24 hours' AS expired FROM payments
    WHERE status = 'pending' AND method = 'card' AND provider = ANY($1) AND provider_ref IS NOT NULL
      AND created_at < now() - interval '5 minutes' AND created_at > now() - interval '25 hours' ORDER BY created_at LIMIT 100`, [providers]);
  let settled = 0;
  for (const p of rows) {
    const gw = await activeGateway(p.provider, p.mode);
    if (!gw || await testModeOver(p.provider, p.mode)) continue;
    const r = await gateways[p.provider].verify({ query: {}, body: {}, payment: { id: p.id, amount: p.amount, currency: p.currency, providerRef: p.provider_ref } }, gw.creds, gw.mode)
      .catch((e: Error) => ({ ok: false as const, code: 'PROVIDER_ERROR', message: String(e?.message ?? e).slice(0, 200) }));
    await noteReview(p.id, r);
    if (finalResult(r)) { await settlePayment(p.id, r); settled++; }
    else if (!r.ok && p.expired && r.code === 'PENDING') { await settlePayment(p.id, { ok: false, code: 'EXPIRED', message: 'Not paid within a day' }); settled++; }
  }
  return settled;
}

export async function runBilling(now = new Date()) {
  // After a restore of an older backup nothing is invoiced, charged, suspended or deleted until staff release the panel.
  if (await restoreHold()) return { skipped: true, restoreHold: true };
  const s = await settings();
  await retryPowerOffs(now);
  if (!s.enabled) return { skipped: true };
  const day = today(now);
  const out = { adopted: await adopt(), ended: await closeEnded(), cancelled: 0, renewals: 0, repriced: 0, charged: 0, reminded: 0, overdue: 0, suspended: 0, terminated: 0, expired: 0,
    hourly: await runHourly(now), disputesEscalated: await (await import('./disputes')).escalateDisputes(), paymentsRechecked: 0 };

  await retryRemovals();
  await retryHolds(now);
  const rechecked = await recheckPayments();

  out.paymentsRechecked = rechecked;

  // Cancelled at the period's end: the server (or the data center with its servers) goes.
  const { rows: leaving } = await pool.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now()
    WHERE cancel_at_period_end AND status IN ('active', 'past_due', 'suspended') AND period_end <= $1 RETURNING id, server_id, vdc_id`, [day]);
  for (const b of leaving) {
    if (b.server_id) await removeServer(b.server_id, 'cancel');
    if (b.vdc_id) await endVdc(b.vdc_id, 'cancel');
  }
  out.cancelled = leaving.length;

  // A price that changed without an invoice of its own (a smaller shape, a removed disk): the unpaid renewal invoice of a
  // period not begun follows it (repriceOpenRenewal), and so does the subscription's amount. Also looked for by the
  // invoice's own price, in dispute or not (a coupon's line differs for good and is simply found right each time).
  const { rows: moved } = await pool.query(`SELECT b.server_id FROM subscriptions b JOIN servers s ON s.id = b.server_id
    WHERE b.status IN ('active', 'past_due', 'suspended') AND s.billing_mode = 'monthly' AND (s.price_monthly <> b.amount
      OR EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.subscription_id = b.id AND NOT l.withdrawn AND l.period_start >= $1::date
        AND i.kind = 'renewal' AND i.status = 'unpaid' AND i.owner_id = b.owner_id AND l.unit_price <> s.price_monthly))`, [day]);
  for (const m of moved) out.repriced += await repriceOpenRenewal(m.server_id);

  // Renewal invoices N days before the period ends, one per subscription and period. With automatic renewal off the
  // invoice is made all the same; it is only never taken from the balance or the card (below): the customer pays it by
  // hand, and unpaid it is collected like any other. Turning renewal off is not a cancellation.
  const { rows: due } = await pool.query(`SELECT b.*, b.period_end::text AS pe FROM subscriptions b WHERE b.status IN ('active', 'past_due', 'suspended') AND NOT b.cancel_at_period_end
      AND b.period_end - $2::int <= $1::date
      AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = b.server_id AND s.delete_at IS NOT NULL)
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
    const unitCents = toCents(coupon?.monthly ?? monthly);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Nothing to pay (the coupon covers it all): no invoice, which nobody could pay; the period moves on at once, as a free first period does (billOrder).
      if (unitCents <= 0) await client.query('UPDATE subscriptions SET period_start = $2, period_end = $3, updated_at = now() WHERE id = $1 AND period_end = $2', [b.id, start, end]);
      else await createInvoice(client, { ownerId: b.owner_id, kind: 'renewal', currency: b.currency, dueAt: endOfDay(renewalDue(start, day, s.invoiceDaysBefore)),
        lines: [{ description: `${b.description} (${start} – ${end})${coupon ? ` · kupon ${coupon.code}` : ''}`, unitCents, quantity: b.period_months, unit: 'MON', subscriptionId: b.id, periodStart: start, periodEnd: end }] });
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
    // Not for a subscription whose owner turned automatic renewal off: nothing is taken without them.
    // Nor for an invoice with a payment under review: a provider may hold the customer's money for it, and taking the
    // balance or the card as well would collect it twice without them. It is collected again once staff have decided.
    const { rows: open } = await pool.query(`SELECT * FROM invoices i WHERE i.status = 'unpaid' AND i.kind IN ('renewal', 'manual') AND NOT i.disputed AND i.next_charge_at <= now() AND i.charge_attempts < $1
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN subscriptions b ON b.id = l.subscription_id WHERE l.invoice_id = i.id AND NOT b.auto_renew)
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending' AND p.error_code = ANY($2))`, [s.chargeRetries, reviewCodes]);
    for (const inv of open) {
      await pool.query("UPDATE invoices SET charge_attempts = charge_attempts + 1, next_charge_at = now() + interval '1 day' WHERE id = $1", [inv.id]);
      if ((s.balance && await payFromBalance(inv.id, true)) || await chargeSavedCard(inv)) out.charged++;
    }
  }

  // Reminders, overdue notices, suspension and termination for every unpaid invoice of a running subscription: renewals,
  // the first (order) invoice when the server was built before payment, and the invoices of a resize or an extra disk.
  // While a payment for the invoice is being reviewed (reviewWindow) nothing is suspended or terminated for it and
  // nobody is reminded to pay it: the customer may have paid, and staff have not decided yet. For the window only.
  const reviewDays = s.reviewHoldDays ?? 7;
  const { rows: unpaid } = await pool.query(`SELECT i.*, b.id AS sub_id, b.status AS sub_status, b.suspended_at, b.server_id, b.vdc_id, ${reviewWindowSql('i.id', '$1', '$2')} AS in_review FROM invoices i
      JOIN invoice_lines l ON l.invoice_id = i.id JOIN subscriptions b ON b.id = l.subscription_id
      WHERE i.status = 'unpaid' AND i.kind IN ('renewal', 'order', 'manual') AND NOT i.disputed AND b.status IN ('active', 'past_due', 'suspended')`, [reviewCodes, reviewDays]);
  for (const i of unpaid) {
    // Counted from the due date, or from the later day this invoice came under collection (dunning_from, migration 071).
    const dueOn = dueDay(today(i.due_at), i.dunning_from ? today(i.dunning_from) : null);
    const step = collectionStep(daysBetween(dueOn, day), s, { reminded: !!i.reminded_at && today(i.reminded_at) === day, overdueNotified: !!i.overdue_notified_at,
      suspended: i.sub_status === 'suspended', suspendedDays: i.suspended_at ? daysBetween(today(i.suspended_at), day) : 0, sheltered: i.in_review });
    const d = { invoiceId: i.id, total: i.total, currency: i.currency, due: dueOn };
    if (step === 'remind') {
      await pool.query('UPDATE invoices SET reminded_at = now() WHERE id = $1', [i.id]);
      await notify('billing.reminder', [i.owner_id], d); out.reminded++;
    } else if (step === 'overdue') {
      await pool.query('UPDATE invoices SET overdue_notified_at = now() WHERE id = $1', [i.id]);
      await pool.query("UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1 AND status = 'active'", [i.sub_id]);
      // review: the notice says the payment is being checked instead of asking for it again.
      await notify('billing.overdue', [i.owner_id], { ...d, days: String(s.suspendAfterDays), ...(i.in_review && { review: true }) }); out.overdue++;
    } else if (step === 'suspend') {
      // The list was read before this loop began: only if the invoice is still unpaid now, and once per subscription
      // (one with several unpaid invoices is no longer active or overdue the second time).
      // Nor when a payment for it came under review since the list was read.
      const { rowCount } = await pool.query(`UPDATE subscriptions SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = $1 AND status IN ('active', 'past_due')
        AND EXISTS (SELECT 1 FROM invoices x WHERE x.id = $2 AND x.status = 'unpaid' AND NOT ${reviewWindowSql('x.id', '$3', '$4')})`, [i.sub_id, i.id, reviewCodes, reviewDays]);
      if (!rowCount) continue;
      await hold(i, day);
      await notify('billing.suspended', [i.owner_id], { ...d, days: String(s.terminateAfterDays) }); out.suspended++;
    } else if (step === 'terminate') {
      // The list was read before this loop began, and a payment may have arrived since: the invoice is locked (as a payment
      // locks it) and looked at again. Only one still unpaid is cancelled and ends the subscription; nothing is deleted
      // unless that happened here. (A second unpaid invoice of the same subscription finds it ended already.)
      const client = await pool.connect();
      let ended = false;
      try {
        await client.query('BEGIN');
        const { rows: [cur] } = await client.query('SELECT status, paid_total::text AS paid FROM invoices WHERE id = $1 FOR UPDATE', [i.id]);
        if (cur?.status === 'unpaid' && !(await reviewWindow(client, i.id))) {
          if (toCents(cur.paid) === 0) {
            await client.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [i.id]);
            await withdrawLines(client, [i.id]);
          }
          ended = !!(await client.query("UPDATE subscriptions SET status = 'ended', updated_at = now() WHERE id = $1 AND status = 'suspended'", [i.sub_id])).rowCount;
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      if (!ended) continue;
      if (i.server_id) await removeServer(i.server_id, 'terminate');
      if (i.vdc_id) await endVdc(i.vdc_id, 'terminate');
      await notify('billing.terminated', [i.owner_id], d); out.terminated++;
    }
  }

  // Orders not paid in time: the invoice is withdrawn and the waiting build cancelled (its address and capacity freed).
  // Only while the subscription still waits for it: a server built before payment keeps its invoice, collected above.
  // Not while a payment for the order is being reviewed (reviewWindow): the build and its address wait that long too.
  const { rows: stale } = await pool.query(`UPDATE invoices i SET status = 'cancelled', cancelled_at = now() WHERE i.status = 'unpaid' AND i.kind = 'order' AND NOT i.disputed AND i.paid_total = 0 AND i.due_at < now()
    AND EXISTS (SELECT 1 FROM invoice_lines l JOIN subscriptions b ON b.id = l.subscription_id WHERE l.invoice_id = i.id AND b.status = 'pending')
    AND NOT ${reviewWindowSql('i.id', '$1', '$2')} RETURNING i.id`, [reviewCodes, reviewDays]);
  await withdrawLines(pool, stale.map((x) => x.id));
  for (const inv of stale) {
    for (const id of await dropOrder(pool, inv.id)) await enqueue(id);
    out.expired++;
  }
  return out;
}

// Gives money back on a paid invoice (staff refund, or an accepted dispute): to the card at the provider, or to the balance.
// In one transaction with the invoice locked: a second refund of the same invoice waits, then sees what is left of it.
export async function refundInvoice(req: AuthedRequest, id: string, body: Record<string, unknown>) {
  const toBalance = body?.toBalance === true;
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
  const client = await pool.connect();
  let inv: Row;
  let done = 0; // cents given back
  let failure: unknown = null;
  try {
    await client.query('BEGIN');
    ({ rows: [inv] } = await client.query("SELECT * FROM invoices WHERE id = $1 AND status IN ('paid', 'partially_refunded') FOR UPDATE", [id]));
    if (!inv) throw apiError(409, 'INVOICE_NOT_REFUNDABLE', 'Only a paid invoice can be refunded');
    let cents = 0; try { cents = toCents(String(body?.amount ?? inv.total)); } catch { /* below */ }
    const left = toCents(inv.total) - toCents(inv.refunded_total);
    if (cents <= 0 || cents > left) throw apiError(400, 'VALIDATION_FAILED', 'Invalid amount', { amount: 'OUT_OF_RANGE' });
    // A top-up refunded to the card takes the money out of the balance it became (refunding it to the balance changes nothing).
    if (inv.kind === 'topup') {
      if (toBalance) throw apiError(409, 'REFUND_NOT_SUPPORTED', 'A top-up is already balance');
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [inv.owner_id]); // one balance spend at a time (payFromBalance)
      const { rows: [b] } = await client.query('SELECT coalesce(sum(amount), 0)::text AS amount FROM balance_entries WHERE owner_id = $1 AND currency = $2', [inv.owner_id, inv.currency]);
      if (toCents(b.amount) < cents) throw apiError(409, 'INSUFFICIENT_BALANCE', 'That much of the top-up was already spent');
    }
    if (!toBalance) {
      let remaining = cents;
      try {
        // Back through the payments that brought the money in, newest first.
        const { rows: pays } = await client.query("SELECT * FROM payments WHERE invoice_id = $1 AND status IN ('succeeded', 'partially_refunded') ORDER BY completed_at DESC FOR UPDATE", [id]);
        for (const p of pays) {
          if (!remaining) break;
          const part = Math.min(remaining, toCents(p.amount) - toCents(p.refunded));
          if (part <= 0) continue;
          if (p.provider === 'balance' || p.provider === 'manual') {
            if (p.provider === 'manual') continue; // money that came outside the panel goes back outside it (or to the balance)
            await client.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, payment_id, note, created_by) VALUES ($1, $2, $3, 'refund', $4, $5, $6, $7)",
              [inv.owner_id, fromCents(part), inv.currency, id, p.id, reason || null, req.user.id]);
          } else {
            const impl = gateways[p.provider];
            const gw = p.provider === 'sandbox' ? { mode: 'test' as const, creds: {} } : await activeGateway(p.provider, p.mode);
            if (!impl?.refund || !gw) throw apiError(409, 'REFUND_NOT_SUPPORTED', 'This provider cannot refund from the panel; refund it in the provider panel or to the balance');
            const r = await impl.refund(p.provider_ref, fromCents(part), p.currency, gw.creds, gw.mode);
            if (!r.ok) throw apiError(502, 'REFUND_FAILED', r.message ?? r.code);
          }
          await client.query("UPDATE payments SET refunded = refunded + $2, status = CASE WHEN refunded + $2 >= amount THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1", [p.id, fromCents(part)]);
          remaining -= part;
          done += part;
        }
        if (remaining) throw apiError(409, 'REFUND_NOT_SUPPORTED', 'Part of this was paid outside the panel; refund that part to the balance');
      } catch (e) {
        // What a provider has already given back cannot be rolled back with the transaction: that part is recorded, then the error is reported.
        if (!done) throw e;
        failure = e;
      }
      if (inv.kind === 'topup') await client.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, note, created_by) VALUES ($1, $2, $3, 'refund', $4, $5, $6)",
        [inv.owner_id, fromCents(-done), inv.currency, id, reason || null, req.user.id]);
    } else {
      await client.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, note, created_by) VALUES ($1, $2, $3, 'refund', $4, $5, $6)",
        [inv.owner_id, fromCents(cents), inv.currency, id, reason || null, req.user.id]);
      done = cents;
    }
    await client.query(`UPDATE invoices SET refunded_total = refunded_total + $2, status = CASE WHEN refunded_total + $2 >= total THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1`,
      [id, fromCents(done)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await audit(req, 'billing.refunded', 'success', req.user.id, { invoiceId: id, amount: fromCents(done), toBalance, reason });
  void import('./einvoice').then((e) => e.creditNote(id, fromCents(done), reason)).catch(() => undefined);
  await notify('billing.refunded', [inv.owner_id], { invoiceId: id, amount: fromCents(done), currency: inv.currency });
  if (failure) throw failure;
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
// once a day when less than a day is left; last month's usage becomes an invoice paid from the balance. A server held
// longer than the days a suspended subscription gets, with a usage invoice still unpaid, is terminated like one.
async function runHourly(now: Date) {
  const s = await settings();
  const out = { hours: 0, held: 0, released: 0, warned: 0, invoiced: 0, terminated: 0 };
  // Held and stopped, a server builds no more debt: its clock moves on without usage (a later release does not bill the held time either).
  await pool.query("UPDATE servers SET billed_until = $1 WHERE billing_mode = 'hourly' AND billing_hold AND power_state = 'poweredOff' AND state <> 'deleted' AND billed_until < $1", [now]);
  const { rows } = await pool.query(`SELECT id, owner_id, price_hourly::text AS price, trim(currency) AS currency, billed_until, billed_until::text AS billed_text FROM servers
    WHERE billing_mode = 'hourly' AND state <> 'deleted' AND delete_at IS NULL AND billed_until < $1`, [now]);
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
      const { rows: held } = await pool.query(`UPDATE servers SET billing_hold = true, held_at = now(), updated_at = now() WHERE owner_id = $1 AND trim(currency) = $2 AND billing_mode = 'hourly'
        AND state = 'ready' AND NOT billing_hold RETURNING id, owner_id, power_state`, [o.owner_id, o.currency]);
      for (const srv of held) if (srv.power_state === 'poweredOn') await powerOffHeld(srv, `billing:hourly-hold:${srv.id}:${now.getTime()}`);
      if (held.length) { out.held += held.length; await notify('billing.hourly_hold', [o.owner_id], { amount: left.toFixed(2), currency: o.currency }); }
      // Held for as long as a suspended subscription is kept (held_at; for servers held before migration 072, counted
      // from that migration), and a usage invoice is still unpaid: terminated. The balance is read again first: a
      // top-up that arrived since `left` was read (the same guard as for a subscription's termination) keeps the servers.
      if (s.terminateAfterDays > 0) {
        const { rows: old } = await pool.query(`SELECT id FROM servers WHERE owner_id = $1 AND trim(currency) = $2 AND billing_mode = 'hourly' AND billing_hold AND billing_remove IS NULL
          AND state IN ('ready', 'error') AND held_at <= now() - make_interval(days => $3)`, [o.owner_id, o.currency, s.terminateAfterDays]);
        const { rows: [owed] } = old.length ? await pool.query(`SELECT id, total::text, currency, due_at FROM invoices WHERE owner_id = $1 AND currency = $2 AND kind = 'usage'
          AND status = 'unpaid' AND NOT disputed ORDER BY created_at LIMIT 1`, [o.owner_id, o.currency]) : { rows: [] };
        // Not while a payment for one of the owner's unpaid usage invoices is being reviewed (reviewWindow).
        const { rows: [waits] } = owed ? await pool.query(`SELECT 1 FROM invoices i WHERE i.owner_id = $1 AND i.currency = $2 AND i.kind = 'usage' AND i.status = 'unpaid'
          AND ${reviewWindowSql('i.id', '$3', '$4')} LIMIT 1`, [o.owner_id, o.currency, reviewCodes, s.reviewHoldDays ?? 7]) : { rows: [] };
        if (owed && !waits && await available(pool, o.owner_id, o.currency) < 0) {
          for (const srv of old) await removeServer(srv.id, 'terminate');
          await notify('billing.terminated', [o.owner_id], { invoiceId: owed.id, total: owed.total, currency: owed.currency, due: today(owed.due_at) });
          out.terminated += old.length;
        }
      }
      continue;
    }
    const { rows: freed } = await pool.query(`UPDATE servers SET billing_hold = false, held_at = NULL, hold_power_off = false, billing_remove = NULL, updated_at = now() WHERE owner_id = $1 AND trim(currency) = $2 AND billing_mode = 'hourly'
      AND billing_hold RETURNING id, owner_id, state, power_state`, [o.owner_id, o.currency]);
    for (const srv of freed) if (srv.state === 'ready' && srv.power_state === 'poweredOff') await startOperation(system, srv, 'power_on', `billing:hourly-release:${srv.id}:${now.getTime()}`, `billing:${srv.id}`).catch(() => undefined);
    out.released += freed.length;
    if (o.burn > 0 && left < o.burn * 24) {
      const { rowCount } = await pool.query('UPDATE users SET balance_warned_on = $2 WHERE id = $1 AND balance_warned_on IS DISTINCT FROM $2', [o.owner_id, today(now)]);
      if (rowCount) { out.warned++; await notify('billing.balance_low', [o.owner_id], { amount: left.toFixed(2), currency: o.currency, hours: String(Math.floor(left / o.burn)) }); }
    }
  }
  return out;
}

// One run at a time: the periodic one in every API process, and staff's "run now". The lock is held only while a run is
// in progress: it carries its holder's token and is given back when the run ends, by that holder only (expired meanwhile,
// it may be another run's by now). The expiry is for a process that died mid-run.
const lockRun = async () => {
  const token = randomBytes(8).toString('hex');
  return (await redis.set('lock:billing', token, 'EX', 240, 'NX').catch(() => null)) ? token : null;
};
const unlockRun = (token: string) => redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, 'lock:billing', token).catch(() => 0);
export async function billingTick() {
  if (await restoreHold()) return;
  // Once per interval across the API processes: this key is not given back, it expires before the next interval.
  if (!(await redis.set('lock:billing:tick', '1', 'EX', 240, 'NX').catch(() => null))) return;
  const token = await lockRun();
  if (!token) return;
  await runBilling().catch((e) => logEvent('error', 'billing_run_failed', { error: String(e?.message ?? e).slice(0, 200) })).finally(() => unlockRun(token));
}
export function startBilling() {
  return setInterval(billingTick, 5 * 60_000).unref();
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
  // payBlockedUntil: until when a payment under review keeps this invoice from being paid again (the pay route answers
  // PAYMENT_IN_REVIEW until then); null when no review stands in the way. Asked the way the refusal asks.
  inv.payBlockedUntil = inv.status === 'unpaid' ? await reviewWindowUntil(pool, id) : null;
  return { invoice: inv, lines, payments };
}
const subscriptionColumns = `b.id, b.kind, b.server_id AS "serverId", b.vdc_id AS "vdcId", b.description, b.amount::text, b.currency, b.period_months AS "periodMonths", b.status,
  b.period_start AS "periodStart", b.period_end AS "periodEnd", b.auto_renew AS "autoRenew", b.cancel_at_period_end AS "cancelAtPeriodEnd", b.suspended_at AS "suspendedAt", b.created_at AS "createdAt"`;

// What a customer may pay with now.
async function methods() {
  const s = await settings();
  const { activePaymentMethods } = await import('./payments');
  // currencies: the only ones this provider can take (null: any); an invoice in another one is refused at payment.
  const cards = (await activePaymentMethods()).filter((m) => gateways[m.id]).map((m) => ({ id: m.id, name: m.name, mode: m.mode, saved: !!gateways[m.id].chargeSaved, currencies: gateways[m.id].currencies ?? null }));
  if (s.sandbox) cards.push({ id: 'sandbox', name: 'Sandbox', mode: 'test', saved: true, currencies: null });
  return { cards, balance: s.balance, bankTransfer: s.bankTransfer.enabled ? s.bankTransfer : null, topup: { min: s.topupMin, max: s.topupMax } };
}

// The next renewal as the run will invoice it (runBilling): the server's price of now (or the subscription's own
// amount), the coupon if one still applies, for the whole period, with the buyer's tax. A renewal that already has its
// unpaid invoice counts with that invoice's line. Not counted: a subscription that ends with its period, one whose
// server is being deleted, and a period already paid for.
async function nextRenewal(ownerId: string, s: Awaited<ReturnType<typeof settings>>) {
  const { rows } = await pool.query(`SELECT b.period_end AS at, b.period_end::text AS day, b.amount::text AS amount, trim(b.currency) AS currency, b.period_months, b.coupon_id, b.coupon_left,
      (SELECT v.price_monthly::text FROM servers v WHERE v.id = b.server_id) AS price,
      (SELECT sum(l.gross)::numeric(14,2)::text FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        WHERE l.subscription_id = b.id AND l.period_start = b.period_end AND NOT l.withdrawn AND i.kind = 'renewal' AND i.status = 'unpaid') AS invoiced
    FROM subscriptions b WHERE b.owner_id = $1 AND b.status IN ('active', 'past_due', 'suspended') AND NOT b.cancel_at_period_end AND b.period_end IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM servers v WHERE v.id = b.server_id AND v.delete_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.subscription_id = b.id AND l.period_start = b.period_end AND NOT l.withdrawn AND i.status = 'paid')
    ORDER BY b.period_end, b.created_at`, [ownerId]);
  if (!rows.length) return null;
  // The tax rule of the invoices (createInvoice). If the buyer cannot be read the amount is given before tax, and said so.
  const tax = await buyerOf(pool, ownerId).then((b) => taxFor(b.country, s)).catch(() => null);
  const parts = await Promise.all(rows.map(async (b) => {
    if (b.invoiced !== null) return { day: b.day as string, currency: b.currency as string, cents: toCents(b.invoiced), invoiced: true, gross: true };
    const monthly = b.price ?? b.amount;
    const coupon = await renewalPrice(pool, b, monthly).catch(() => null);
    const unit = toCents(coupon?.monthly ?? monthly);
    return { day: b.day as string, currency: b.currency as string, invoiced: false, gross: !!tax,
      cents: tax ? lineAmounts(unit, b.period_months, tax.rate, s.pricesIncludeTax).gross : Math.round(unit * b.period_months) };
  }));
  const next = nextRenewalOf(parts)!;
  const counted = parts.filter((p) => p.day === next.day && p.currency === next.currency && p.invoiced === next.invoiced);
  return { at: rows.find((b) => b.day === next.day)!.at as Date, amount: fromCents(next.cents), currency: next.currency, gross: counted.every((p) => p.gross), servers: next.servers, invoiced: next.invoiced };
}

// ---- Customer ----

@Controller('billing') @UseGuards(SessionGuard)
export class BillingController {
  @Get('summary')
  async summary(@Req() req: AuthedRequest) {
    const s = await settings();
    if (!s.enabled) return { enabled: false };
    const id = req.user.id;
    const [balance, open, subs, cards, profile, renewal] = await Promise.all([
      balanceOf(pool, id),
      pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE due_at < now())::int AS overdue, coalesce(sum(total - paid_total), 0)::text AS amount, min(currency) AS currency
        FROM invoices WHERE owner_id = $1 AND status = 'unpaid' AND kind <> 'topup'`, [id]),
      pool.query(`SELECT ${subscriptionColumns} FROM subscriptions b WHERE b.owner_id = $1 AND b.status IN ('active', 'past_due', 'suspended') ORDER BY b.period_end`, [id]),
      pool.query('SELECT id, provider, mode, brand, last4, exp_month AS "expMonth", exp_year AS "expYear", is_default AS "isDefault" FROM saved_cards WHERE owner_id = $1 ORDER BY is_default DESC, created_at DESC', [id]),
      pool.query('SELECT 1 FROM billing_profiles WHERE user_id = $1', [id]),
      // The one line of the dashboard; a figure that cannot be worked out is left out (null), the rest of the summary stays.
      nextRenewal(id, s).catch(() => { logEvent('error', 'billing_next_renewal_failed'); return null; }),
    ]);
    // Pay as you go: hourly servers, this month's usage so far, and what is left to spend.
    const { rows: hourly } = await pool.query(`SELECT s.id, s.name, s.price_hourly::text AS "priceHourly", trim(s.currency) AS currency, s.billing_hold AS "billingHold",
        coalesce((SELECT u.hours FROM server_usage u WHERE u.server_id = s.id AND u.month = $2::date), 0) AS hours,
        coalesce((SELECT u.amount FROM server_usage u WHERE u.server_id = s.id AND u.month = $2::date), 0)::text AS amount
      FROM servers s WHERE s.owner_id = $1 AND s.billing_mode = 'hourly' AND s.state NOT IN ('deleted', 'deleting') ORDER BY s.name`, [id, firstOfMonth(today())]);
    const currencies = [...new Set(hourly.map((h) => h.currency))];
    const left = await Promise.all(currencies.map(async (c) => ({ currency: c, amount: (await available(pool, id, c)).toFixed(2),
      perHour: hourly.filter((h) => h.currency === c).reduce((a, h) => a + Number(h.priceHourly), 0).toFixed(4) })));
    return { enabled: true, balance, open: open.rows[0], subscriptions: subs.rows,
      cards: cards.rows.map((c) => ({ ...c, providerName: c.provider === 'sandbox' ? 'Sandbox' : providers[c.provider]?.name ?? c.provider })), profileComplete: !!profile.rowCount, methods: await methods(),
      autoCharge: s.autoCharge, requirePayment: s.requirePayment, hourly: { enabled: s.hourly && s.balance, minHours: s.hourlyMinHours, servers: hourly, available: left }, nextRenewal: renewal };
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
    // Where invoices and payment notices are sent is the person's own choice: staff acting as them change the rest only.
    if (req.user.impersonatedBy) {
      const { rows: [cur] } = await pool.query('SELECT email FROM billing_profiles WHERE user_id = $1', [req.user.id]);
      if ((p.email || '') !== (cur?.email ?? '')) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'The billing e-mail cannot be changed while acting as another user');
    }
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
    let { rows: [inv] } = await pool.query("SELECT * FROM invoices WHERE id = $1 AND owner_id = $2", [id, req.user.id]);
    if (!inv) throw apiError(404, 'NOT_FOUND', 'Unknown invoice');
    // A renewal takes its server's price of now before a payment is begun for the amount due.
    if (inv.status === 'unpaid' && inv.kind === 'renewal') { await priceNow(id); ({ rows: [inv] } = await pool.query('SELECT * FROM invoices WHERE id = $1', [id])); }
    if (inv.status !== 'unpaid') throw apiError(409, 'INVOICE_NOT_PAYABLE', 'This invoice is not awaiting payment');
    // Whatever the method: a payment for it waits for staff, and a second one could take the money twice.
    if (await reviewWindow(pool, id)) throw inReview();
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
    // With the sandbox switched off a test card pays nothing, also not a payment begun while it was on (cancelling stays possible).
    if (!cancel && !(await settings()).sandbox) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available');
    const r = cancel ? { ok: false as const, code: 'CANCELLED_BY_CUSTOMER' } : sandboxPay(String(body?.card ?? ''), p.save_card);
    // The test card that is held for review takes the way a real provider's held payment does (the callback below):
    // nothing is settled, the payment stays open with its reason and staff are told (noteReview).
    if (!finalResult(r)) {
      await noteReview(id, r);
      const { rows: [now] } = await pool.query('SELECT status FROM payments WHERE id = $1', [id]);
      return { status: now.status as string, ...(!r.ok && { code: r.code }) };
    }
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
    // Only what was read above, never the body as it came: the audit log is shown to people (audit-log.ts).
    await audit(req, 'billing.subscription_changed', 'success', req.user.id, { subscriptionId: id,
      ...(typeof body?.cancelAtPeriodEnd === 'boolean' && { cancelAtPeriodEnd: body.cancelAtPeriodEnd }), ...(typeof body?.autoRenew === 'boolean' && { autoRenew: body.autoRenew }) });
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

  // Stripe's webhook (Settings → Payments → Stripe shows this address): the signed notification of how a payment
  // ended, for the customer who paid and never came back to the panel, without waiting for the billing run to ask.
  // Nothing here trusts the caller: the body counts only with a signature made with the endpoint's signing secret
  // (the test or the live one, whichever verifies; the event must be of that mode) over the bytes as they arrived,
  // and not older than five minutes. The outcome then takes the one way every outcome takes (settlePayment locks the
  // payment and records a result once), so the return, the billing run and this event can arrive in any order, any
  // number of times, and the invoice is paid once. An event already handled is answered without being handled again.
  @Post('stripe') @HttpCode(200)
  async stripeWebhook(@Req() req: FastifyRequest & { rawBody?: Buffer }, @Body() event: Record<string, unknown>) {
    const secrets: { mode: 'live' | 'test'; secret: string }[] = [];
    for (const mode of ['live', 'test'] as const) {
      const secret = ((await activeGateway('stripe', mode))?.creds as Record<string, string> | undefined)?.webhookSecret;
      if (secret) secrets.push({ mode, secret });
    }
    if (!secrets.length) throw apiError(404, 'WEBHOOK_NOT_CONFIGURED', 'No webhook signing secret is saved for Stripe');
    const checks = req.rawBody ? secrets.map((s) => ({ ...s, verdict: stripeSignature(req.rawBody!, req.headers['stripe-signature'], s.secret) })) : [];
    const signed = checks.find((c) => c.verdict !== 'invalid');
    if (!signed || signed.verdict === 'stale') {
      // Guesses are counted per address (a wrong secret at Stripe's end fails the same way, far below this).
      await rateLimit(`stripe-webhook:${req.ip}`, 120, 60);
      logEvent('warn', 'stripe_webhook_refused', { reason: signed ? 'stale' : 'signature' });
      throw signed ? apiError(400, 'WEBHOOK_TIMESTAMP_OUT_OF_RANGE', 'The signature is older than the tolerance') : apiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'The signature does not match');
    }
    const eventId = typeof event?.id === 'string' && /^evt_\w{1,200}$/.test(event.id) ? event.id : null;
    if (!eventId || typeof event.type !== 'string' || event.livemode !== (signed.mode === 'live')) throw apiError(400, 'WEBHOOK_EVENT_INVALID', 'Not an event of this endpoint');
    const seen = `stripe:event:${eventId}`;
    if (await redis.exists(seen).catch(() => 0)) return { received: true, duplicate: true };
    const paymentId = stripeEventPayment(event);
    const { rows: [p] } = paymentId ? await pool.query("SELECT id, amount::text, currency, status, mode FROM payments WHERE id = $1 AND provider = 'stripe'", [paymentId]) : { rows: [] };
    // Not one of ours, of the other mode, or a test payment after the provider went live: acknowledged, nothing done.
    const ours = p && p.mode === signed.mode && !(await testModeOver('stripe', p.mode));
    if (ours && p.status === 'pending') {
      const r = stripeEventResult(event, p);
      if (finalResult(r)) await settlePayment(p.id, r);
      else await noteReview(p.id, r);
      logEvent(r.ok ? 'info' : 'warn', 'payment_webhook', { provider: 'stripe', paymentId: p.id, event: event.type, ok: r.ok, ...(!r.ok && { code: r.code }) });
    }
    // Remembered only once it was handled: a delivery that failed half way is handled again when Stripe retries.
    await redis.set(seen, '1', 'EX', 3 * 86_400).catch(() => undefined);
    return { received: true, ...(!ours && { ignored: true }) };
  }

  @Post(':provider')
  async notification(@Res() reply: FastifyReply, @Param('provider') provider: string, @Body() body: Record<string, unknown>) {
    const id = gateways[provider]?.paymentIdFrom?.(body ?? {});
    if (!id) throw apiError(404, 'NOT_FOUND', 'Unknown payment');
    return this.handle(reply, provider, id, {}, body ?? {});
  }

  private async handle(reply: FastifyReply, provider: string, id: string, query: Record<string, string>, body: Record<string, unknown>) {
    const { rows: [p] } = await pool.query('SELECT id, invoice_id, amount::text, currency, provider_ref, status, mode, error_code FROM payments WHERE id = $1 AND provider = $2', [id, provider]);
    const impl = gateways[provider];
    if (!p || !impl) throw apiError(404, 'NOT_FOUND', 'Unknown payment');
    // A return nobody vouches for (impl.unsigned: Param): the first well-formed one puts the payment under review, and
    // from then on no return changes it: not the note staff confirm from, and a "declined" form does not close it
    // (settleIn and noteReview hold the same for two returns arriving together).
    if (p.status === 'pending' && !(impl.unsigned && underReview(p.error_code))) {
      const gw = await activeGateway(provider, p.mode);
      if (!gw || await testModeOver(provider, p.mode)) throw apiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'Provider not active');
      const r = await impl.verify({ query, body, payment: { id: p.id, amount: p.amount, currency: p.currency, providerRef: p.provider_ref } }, gw.creds, gw.mode)
        .catch((e: Error) => ({ ok: false as const, code: 'PROVIDER_ERROR', message: String(e?.message ?? e).slice(0, 200) }));
      // Settled only on the provider's word (finalResult): one that did not answer, a forged or foreign answer, a customer
      // still on the provider's page, or a visit to this address with nothing to ask the provider with, leave the payment open.
      if (finalResult(r)) await settlePayment(id, r, !!impl.unsigned);
      else await noteReview(id, r, !!impl.unsigned);
      logEvent(r.ok ? 'info' : 'warn', 'payment_callback', { provider, paymentId: id, ok: r.ok, ...(!r.ok && { code: r.code }) });
    }
    if (impl.reply) return reply.code(200).type('text/plain').send(impl.reply);
    return reply.code(303).header('location', `/billing/invoices/${p.invoice_id}?payment=${id}`).send();
  }
}

// ---- Staff ----

// Since when a payment waits for staff (payments begun before the column existed, or put there by hand: since it began).
const reviewSinceSql = 'coalesce(p.review_since, p.created_at)';
// The open payments that wait for staff (noteReview): nothing closes them by itself. oldest: the longest wait's start.
export async function paymentsInReview(): Promise<{ n: number; oldest: Date | null }> {
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n, min(${reviewSinceSql}) AS oldest FROM payments p WHERE p.status = 'pending' AND p.error_code = ANY($1)`, [reviewCodes]);
  return r;
}

@Controller('admin/billing') @UseGuards(PermissionGuard)
export class BillingAdminController {
  @Get('overview') @Can('billing.view')
  async overview() {
    const [mrr, open, month, series, subs, recent, review] = await Promise.all([
      pool.query(`SELECT currency, sum(amount)::text AS amount FROM subscriptions WHERE status IN ('active', 'past_due') GROUP BY currency ORDER BY currency`),
      pool.query(`SELECT currency, count(*)::int AS n, count(*) FILTER (WHERE due_at < now())::int AS overdue, sum(total - paid_total)::text AS amount
        FROM invoices WHERE status = 'unpaid' AND kind <> 'topup' GROUP BY currency ORDER BY currency`),
      pool.query(`SELECT currency, sum(amount - refunded)::text AS amount, count(*)::int AS n FROM payments WHERE status IN ('succeeded', 'partially_refunded') AND provider <> 'balance'
        AND completed_at >= date_trunc('month', now()) GROUP BY currency ORDER BY currency`),
      pool.query(`SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS month, currency, sum(amount - refunded)::text AS amount FROM payments
        WHERE status IN ('succeeded', 'partially_refunded') AND provider <> 'balance' AND completed_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1, 2 ORDER BY 1`),
      pool.query(`SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status`),
      pool.query(`SELECT p.id, p.provider, p.method, p.status, p.amount::text, p.currency, p.error_code AS "errorCode", p.created_at AS "createdAt", u.email
        FROM payments p JOIN users u ON u.id = p.owner_id ORDER BY p.created_at DESC LIMIT 10`),
      // Open payments that wait for staff (noteReview): nothing closes them by itself.
      paymentsInReview(),
    ]);
    return { mrr: mrr.rows, open: open.rows, collectedThisMonth: month.rows, series: series.rows,
      subscriptions: Object.fromEntries(subs.rows.map((r) => [r.status, r.n])), recentPayments: recent.rows, paymentsInReview: review };
  }

  @Get('invoices') @Can('billing.view')
  async invoices(@Query('status') status?: string, @Query('q') q?: string) {
    const st = ['unpaid', 'paid', 'cancelled', 'refunded', 'partially_refunded', 'overdue'].includes(status ?? '') ? status : null;
    const { rows } = await pool.query(`SELECT ${invoiceColumns} FROM invoices i WHERE ($1::text IS NULL OR ($1 = 'overdue' AND i.status = 'unpaid' AND i.due_at < now()) OR i.status = $1)
      AND ($2::text IS NULL OR ${foldSql('i.number')} LIKE '%' || $3 || '%' OR ${foldSql("i.buyer->>'email'")} LIKE '%' || $3 || '%' OR ${foldSql("i.buyer->>'name'")} LIKE '%' || $3 || '%' OR i.buyer->>'taxId' = $2)
      ORDER BY i.created_at DESC LIMIT 300`, [st, q?.trim() || null, foldText(q?.trim() ?? '')]);
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
    const { id: paymentId, closed } = await recordManual(id, method, reference, req.user.id);
    await audit(req, 'billing.marked_paid', 'success', req.user.id, { invoiceId: id, method, reference, ...(closed.length && { closedReviews: closed }) });
    // closedReviews: the invoice's payments that waited for staff and ended with this (recordManual).
    return { paymentId, closedReviews: closed };
  }

  // A payment under review that "mark paid" does not reach: its invoice was paid another way or cancelled meanwhile, or
  // the money never arrived (a return anybody could post). Staff end its wait here; nothing is settled or credited (money
  // a provider did collect for it is refunded in the provider's panel, or credited with a balance correction).
  @Post('payments/:id/close-review') @HttpCode(200) @Can('billing.manage')
  async closeReview(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 150) : '';
    const [closed] = await closeReviews(pool, [id], `Closed by staff without settling${note ? `: ${note}` : ''}`);
    if (!closed) throw apiError(409, 'PAYMENT_NOT_IN_REVIEW', 'Only a payment that waits for review can be closed');
    const { rows: [p] } = await pool.query('SELECT invoice_id, owner_id, provider, amount::text, error_code FROM payments WHERE id = $1', [id]);
    await audit(req, 'billing.review_closed', 'success', req.user.id, { paymentId: id, invoiceId: p.invoice_id, target: p.owner_id, provider: p.provider, amount: p.amount, code: p.error_code, note });
    return { ok: true };
  }

  @Post('invoices/:id/cancel') @HttpCode(200) @Can('billing.manage')
  async cancel(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await withdrawInvoice(id))) throw apiError(409, 'INVOICE_NOT_CANCELLABLE', 'Only an unpaid invoice with nothing paid can be cancelled');
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
      await hold(b, Date.now());
    } else if (action === 'resume') {
      await pool.query("UPDATE subscriptions SET status = 'active', suspended_at = NULL, staff_cancelled = false WHERE id = $1", [id]);
      await pool.query('UPDATE servers SET billing_hold = false, hold_power_off = false, billing_remove = NULL WHERE id = $1 OR vdc_id = $2', [b.server_id, b.vdc_id]);
    } else if (action === 'cancel') {
      // Staff's own decision (the server or data center stays, unbilled): the next run must not give it a new subscription (adopt).
      await pool.query("UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), staff_cancelled = true WHERE id = $1", [id]);
      await pool.query('UPDATE servers SET billing_hold = false, hold_power_off = false WHERE id = $1 OR vdc_id = $2', [b.server_id, b.vdc_id]);
    }
    await audit(req, 'billing.subscription_updated', 'success', req.user.id, { subscriptionId: id, target: b.owner_id,
      ...(body?.amount !== undefined && { amount: String(body.amount) }), ...(body?.periodMonths !== undefined && { periodMonths: Number(body.periodMonths) }),
      ...(body?.periodEnd !== undefined && { periodEnd: String(body.periodEnd) }), ...(action !== undefined && { action: String(action) }) });
    const { rows: [row] } = await pool.query(`SELECT ${subscriptionColumns} FROM subscriptions b WHERE b.id = $1`, [id]);
    return { subscription: row };
  }

  // status=review: the open payments that wait for staff (held by the provider, another amount, or Param's unconfirmed
  // return), oldest first; every row says whether it is one (review), why (errorCode), since when (reviewSince) and
  // what its invoice is now (invoiceStatus). q: part of the invoice number, the customer's e-mail or the provider's
  // reference (or the reference staff typed for a payment recorded by hand).
  @Get('payments') @Can('billing.view')
  async payments(@Query('status') status?: string, @Query('q') q?: string) {
    const { rows } = await pool.query(`SELECT p.id, p.invoice_id AS "invoiceId", i.number, i.status AS "invoiceStatus", p.provider, p.mode, p.method, p.status, p.amount::text, p.currency, p.refunded::text,
      p.error_code AS "errorCode", p.error_message AS "errorMessage", p.automatic, p.reference, p.created_at AS "createdAt", p.completed_at AS "completedAt", u.email,
      (p.status = 'pending' AND p.error_code = ANY($2)) IS TRUE AS review,
      CASE WHEN p.status = 'pending' AND p.error_code = ANY($2) THEN ${reviewSinceSql} END AS "reviewSince"
      FROM payments p JOIN users u ON u.id = p.owner_id JOIN invoices i ON i.id = p.invoice_id
      WHERE ($1::text IS NULL OR p.status = $1 OR ($1 = 'review' AND p.status = 'pending' AND p.error_code = ANY($2)))
        AND ($3::text IS NULL OR ${foldSql("coalesce(i.number, '')")} LIKE '%' || $4 || '%' OR ${foldSql('u.email')} LIKE '%' || $4 || '%'
          OR ${foldSql("coalesce(p.provider_ref, '')")} LIKE '%' || $4 || '%' OR ${foldSql("coalesce(p.reference, '')")} LIKE '%' || $4 || '%')
      ORDER BY CASE WHEN $1 = 'review' THEN p.created_at END, p.created_at DESC LIMIT 300`, [status || null, reviewCodes, q?.trim() || null, foldText(q?.trim() ?? '')]);
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
    // The periodic run's lock: two runs at once would invoice or charge the same thing twice.
    const token = await lockRun();
    if (!token) throw apiError(409, 'BILLING_RUNNING', 'A billing run is in progress; try again in a few minutes');
    const r = await runBilling().finally(() => unlockRun(token));
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
      disputeAnswerDays: b.disputeAnswerDays === undefined ? cur.disputeAnswerDays ?? 7 : int('disputeAnswerDays', 1, 90),
      reviewHoldDays: b.reviewHoldDays === undefined ? cur.reviewHoldDays ?? 7 : int('reviewHoldDays', 0, 90), bankTransfer: bank, company };
    if (next.topupMax < next.topupMin) fields.topupMax = 'MIN_ABOVE_MAX';
    if (next.enabled && (!company.name || !company.taxId || !company.address)) fields['company.name'] = 'COMPANY_REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await saveSettings('billing', next);
    // Switched off, the sandbox pays nothing any more: test payments still open are closed (sandboxPay refuses them too).
    if (cur.sandbox && !next.sandbox) await pool.query(`UPDATE payments SET status = 'failed', error_code = 'TEST_MODE_OFF', error_message = 'The sandbox was switched off', completed_at = now()
      WHERE provider = 'sandbox' AND status = 'pending'`);
    await audit(req, 'settings.billing', 'success', req.user.id, { enabled: next.enabled, requirePayment: next.requirePayment, sandbox: next.sandbox });
    return { billing: next };
  }
}

// What a resize costs now: the monthly increase, for every month of the period that runs today, for the days left of it
// (a 3, 6 or 12 month period was paid ahead as that many months: one month's difference would leave the rest of it at
// the old price). Nothing without billing, without a running subscription, or for a decrease, which simply bills less
// from the next period. Periods invoiced
// ahead and not begun are not charged here: their unpaid renewal invoice takes the new price (repriceOpenRenewal).
export async function resizeCharge(serverId: string, oldMonthly: string, newMonthly: string) {
  const s = await settings();
  // An hourly server simply costs more per hour from now on.
  const { rows: [sub] } = await pool.query(`SELECT id, period_start::text AS ps, period_end::text AS pe FROM subscriptions WHERE server_id = $1 AND status IN ('active', 'past_due')
    AND EXISTS (SELECT 1 FROM servers WHERE id = $1 AND billing_mode = 'monthly')`, [serverId]);
  // A renewal invoiced but still unpaid leaves the subscription on the period before: once that one is over, the period
  // that runs is the invoiced one (at the old price), and the increase is owed for the rest of it.
  const { rows: [run] } = sub ? await pool.query(`SELECT l.period_start::text AS ps, l.period_end::text AS pe FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE l.subscription_id = $1 AND NOT l.withdrawn AND i.kind = 'renewal' AND i.status = 'unpaid' AND l.period_start < $2::date AND l.period_end > $2::date
    ORDER BY l.period_start DESC LIMIT 1`, [sub.id, today()]) : { rows: [] };
  const p = run ?? sub;
  const cents = s.enabled && p?.ps && p?.pe ? prorate((toCents(newMonthly) - toCents(oldMonthly)) * periodMonths(p.ps, p.pe), today(), p.ps, p.pe) : 0;
  return { chargeNow: fromCents(cents), periodEnd: p?.pe ?? null };
}

// A server's price changed (a resize, a disk added or removed) while the renewal invoice of a period that has not begun
// is still unpaid: the invoice takes the new price, so that period is billed for the shape that will run in it. Without
// this a customer could shrink the server just before the invoice is made and enlarge it again right after, each month.
// An unpaid invoice has no legal number yet, so its amounts may still change; its due date and reminders stay. Also one
// in dispute: a dispute pauses collection, it does not freeze the price (the owner opens and withdraws it alone). Left
// alone: a period that has begun (resizeCharge bills the rest of that one). An invoice already paid up to its new total
// (a part payment, then a smaller shape) is settled at that total and the excess goes to the balance; that needs
// `after` (what a paid invoice sets in motion once the transaction commits), so a caller inside its own transaction
// without one leaves such an invoice to the next run. The subscription's amount follows the server. Called after every
// price write (servers.ts, disks.ts, billResize), by every run for the changes billing does not hear of, and before a
// renewal is paid (priceRenewal). Returns how many invoices changed.
export async function repriceOpenRenewal(serverId: string, db?: PoolClient, after?: After): Promise<number> {
  if (!db) {
    const client = await pool.connect();
    const done: After = { enqueue: [], powerOn: [], paid: [] };
    let n: number;
    try {
      await client.query('BEGIN');
      n = await repriceOpenRenewal(serverId, client, done);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await finish(done);
    return n;
  }
  const s = await settings();
  if (!s.enabled) return 0;
  const { rows: subs } = await db.query(`SELECT b.id, b.owner_id, b.coupon_id, b.currency, s.price_monthly::text AS price FROM subscriptions b JOIN servers s ON s.id = b.server_id
    WHERE b.server_id = $1 AND b.status IN ('active', 'past_due', 'suspended') AND s.billing_mode = 'monthly'`, [serverId]);
  let changed = 0;
  for (const b of subs) {
    // The invoice is locked first, the subscription after it, as a payment does (markPaid, grant).
    // Only the invoices of who pays the subscription now: one that stayed with a previous payer (a reseller's partly
    // paid renewal after the customer left: directBilling's `left`) keeps the price it was made at.
    const { rows: lines } = await db.query(`SELECT l.id, l.invoice_id, l.description, l.quantity::float8 AS quantity, l.tax_rate::float8 AS rate, l.unit_price::numeric(14,2)::text AS unit, l.gross::text AS gross,
        i.total::text AS total, i.paid_total::text AS paid, i.owner_id, i.currency FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.subscription_id = $1 AND NOT l.withdrawn AND l.period_start >= $2::date AND i.kind = 'renewal' AND i.status = 'unpaid' AND i.owner_id = $3 FOR UPDATE OF i, l`, [b.id, today(), b.owner_id]);
    for (const l of lines) {
      // A line the coupon discounted (its description says so) keeps the coupon, whatever is left of it by now.
      const coupon = l.description.includes(' · kupon ') ? await renewalPrice(db, { coupon_id: b.coupon_id, coupon_left: null, currency: b.currency }, b.price) : null;
      const unitCents = toCents(coupon?.monthly ?? b.price);
      if (unitCents <= 0 || unitCents === toCents(l.unit)) continue;
      const a = lineAmounts(unitCents, l.quantity, l.rate, s.pricesIncludeTax);
      const excess = toCents(l.paid) - (toCents(l.total) - toCents(l.gross) + a.gross);
      if (excess >= 0 && !after) continue;
      await db.query('UPDATE invoice_lines SET unit_price = $2, net = $3, tax = $4, gross = $5 WHERE id = $1', [l.id, fromCents(unitCents), fromCents(a.net), fromCents(a.tax), fromCents(a.gross)]);
      await db.query(`UPDATE invoices i SET subtotal = x.net, tax_total = x.tax, total = x.gross FROM (SELECT sum(net) AS net, sum(tax) AS tax, sum(gross) AS gross FROM invoice_lines WHERE invoice_id = $1) x
        WHERE i.id = $1`, [l.invoice_id]);
      if (excess >= 0 && after) {
        // Paid already: left unpaid at the old, higher total it would be collected (reminders, suspension) for nothing.
        await db.query('UPDATE invoices SET paid_total = total WHERE id = $1', [l.invoice_id]);
        if (excess > 0) await db.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, note) VALUES ($1, $2, $3, 'adjustment', $4, $5)",
          [l.owner_id, fromCents(excess), l.currency, l.invoice_id, 'Fiyatı düşen faturanın fazla ödemesi / Paid above the invoice\'s new total']);
        await markPaid(db, l.invoice_id, after);
      }
      changed++;
    }
    await db.query('UPDATE subscriptions SET amount = $2, updated_at = now() WHERE id = $1 AND amount <> $2', [b.id, b.price]);
  }
  return changed;
}

// The invoice for a resize's increase; the balance pays it at once when it covers it, otherwise it waits like any invoice.
export async function billResize(server: { id: string; owner_id: string; name: string }, amount: string, currency: string, shape: { vcpu: number; memoryMb: number; diskGb: number }) {
  const client = await pool.connect();
  const after: After = { enqueue: [], powerOn: [], paid: [] };
  let id: string;
  try {
    await client.query('BEGIN');
    // Tied to the server's subscription (without a period of its own): left unpaid, it is collected like the subscription's other invoices.
    const { rows: [sub] } = await client.query("SELECT id FROM subscriptions WHERE server_id = $1 AND status IN ('active', 'past_due') ORDER BY created_at DESC LIMIT 1", [server.id]);
    id = await createInvoice(client, { ownerId: server.owner_id, kind: 'manual', currency, dueAt: endOfDay(addDays(today(), 7)),
      lines: [{ description: `Sunucu ${server.name}: ${shape.vcpu} vCPU, ${shape.memoryMb / 1024} GB bellek, ${shape.diskGb} GB disk (dönem sonuna kadar fark)`, unitCents: toCents(amount), subscriptionId: sub?.id }] });
    // The server already has its new price: a renewal invoiced ahead for the next period takes it too.
    await repriceOpenRenewal(server.id, client, after);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await finish(after);
  const paid = (await settings()).balance && await payFromBalance(id, true, server.owner_id).catch(() => false);
  if (!paid) await notify('billing.invoice', [server.owner_id], { invoiceId: id, total: amount, currency, due: addDays(today(), 7) });
  return id;
}
