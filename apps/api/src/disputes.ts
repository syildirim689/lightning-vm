// Invoice disputes (migration 044): a customer contests an invoice or some of its lines; the conversation is a Billing
// support ticket, the case is kept here. Staff take it into review and decide: accepted (fully or in part, credited to the
// balance, refunded, or the unpaid invoice withdrawn) or rejected. While open, the invoice is not collected.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { fromCents, toCents } from './billing-rules';
import { refundInvoice, withdrawInvoice } from './billing';
import { pool, redis } from './db';
import { apiError } from './errors';
import { notify } from './notify';
import { Can, PermissionGuard } from './rbac';
import { getSettings } from './settings-store';
import { addMessage, readBody, readFiles } from './support';

type Input = Record<string, unknown>;
export const reasons = ['wrong_amount', 'not_used', 'duplicate', 'service_problem', 'cancelled', 'tax_details', 'other'] as const;
const open = ['open', 'under_review'];

const columns = `d.id, d.number, d.invoice_id AS "invoiceId", i.number AS "invoiceNumber", i.total::text AS "invoiceTotal", i.status AS "invoiceStatus", d.ticket_id AS "ticketId",
  d.reason, d.amount::text, d.currency, d.line_ids AS "lineIds", d.status, d.remedy, d.resolved_amount::text AS "resolvedAmount", d.resolution,
  d.due_at AS "dueAt", d.decided_at AS "decidedAt", d.created_at AS "createdAt", (d.status IN ('open', 'under_review') AND d.due_at < now()) AS overdue`;

async function decisionDays() {
  const s = await getSettings('billing');
  return { window: s.disputeWindowDays ?? 60, answer: s.disputeAnswerDays ?? 7 };
}

@Controller('billing') @UseGuards(SessionGuard)
export class DisputesController {
  @Get('disputes')
  async mine(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${columns} FROM invoice_disputes d JOIN invoices i ON i.id = d.invoice_id WHERE d.owner_id = $1 ORDER BY d.created_at DESC`, [req.user.id]);
    return { disputes: rows, reasons };
  }

  @Get('invoices/:id/disputes')
  async ofInvoice(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows } = await pool.query(`SELECT ${columns} FROM invoice_disputes d JOIN invoices i ON i.id = d.invoice_id WHERE d.invoice_id = $1 AND (d.owner_id = $2 OR $3) ORDER BY d.created_at DESC`,
      [id, req.user.id, req.user.permissions.includes('*') || req.user.permissions.includes('billing.view')]);
    const { window } = await decisionDays();
    return { disputes: rows, reasons, windowDays: window };
  }

  // Opens a dispute: the reason, the lines and amount contested, and a message (attachments allowed).
  @Post('invoices/:id/disputes') @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const { rows: [inv] } = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND owner_id = $2`, [id, req.user.id]);
    if (!inv) throw apiError(404, 'NOT_FOUND', 'Unknown invoice');
    const days = await decisionDays();
    if (inv.kind === 'topup' || !['unpaid', 'paid', 'partially_refunded'].includes(inv.status)) throw apiError(409, 'DISPUTE_NOT_POSSIBLE', 'This invoice cannot be disputed');
    if (Date.now() - new Date(inv.issued_at ?? inv.created_at).getTime() > days.window * 86_400_000) throw apiError(409, 'DISPUTE_TOO_LATE', 'The time to dispute this invoice has passed');
    // A dispute stops collection while it is open: after a rejection the invoice is settled, not disputed again and again.
    if ((await pool.query("SELECT 1 FROM invoice_disputes WHERE invoice_id = $1 AND status = 'rejected'", [id])).rowCount) throw apiError(409, 'DISPUTE_NOT_POSSIBLE', 'A dispute on this invoice was already rejected');
    const fields: Record<string, string> = {};
    const reason = reasons.includes(body?.reason as (typeof reasons)[number]) ? String(body.reason) : (fields.reason = 'REQUIRED', '');
    const lineIds = Array.isArray(body?.lineIds) ? [...new Set(body.lineIds.map(String))] : [];
    const { rows: lines } = lineIds.length ? await pool.query('SELECT id, gross::text FROM invoice_lines WHERE invoice_id = $1 AND id = ANY($2::uuid[])', [id, lineIds]).catch(() => ({ rows: [] })) : { rows: [] };
    if (lines.length !== lineIds.length) fields.lineIds = 'INVALID_VALUE';
    // The amount: as given, else the chosen lines, else the whole invoice; never more than is left of it.
    const left = toCents(inv.total) - toCents(inv.refunded_total ?? '0');
    let cents = 0;
    try { cents = body?.amount ? toCents(String(body.amount)) : lines.length ? lines.reduce((a, l) => a + toCents(l.gross), 0) : left; } catch { fields.amount = 'INVALID_AMOUNT'; }
    if (!fields.amount && (cents <= 0 || cents > left)) fields.amount = 'OUT_OF_RANGE';
    const text = (() => { try { return readBody(body?.message); } catch { fields.message = typeof body?.message === 'string' && body.message.trim() ? 'TOO_LONG' : 'REQUIRED'; return ''; } })();
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const files = readFiles(body?.attachments);
    const n = await redis.incr(`rl:disputes:${req.user.id}`); if (n === 1) await redis.expire(`rl:disputes:${req.user.id}`, 3600);
    if (n > 5) throw apiError(429, 'RATE_LIMITED', 'Too many disputes');
    const label = inv.number ?? `#${String(inv.id).slice(0, 8)}`;
    // The conversation: a ticket in the Billing department (the first one by order when none is called so).
    const { rows: [dep] } = await pool.query("SELECT id FROM support_departments WHERE active ORDER BY (name_en = 'Billing') DESC, sort LIMIT 1");
    const client = await pool.connect();
    let d: { id: string; number: number };
    try {
      await client.query('BEGIN');
      const { rows: [t] } = await client.query(`INSERT INTO tickets (owner_id, department_id, subject, priority, due_at) VALUES ($1, $2, $3, 'high', now() + interval '4 hours') RETURNING id`,
        [req.user.id, dep?.id ?? null, `Fatura itirazı / Invoice dispute: ${label}`]);
      ({ rows: [d] } = await client.query(`INSERT INTO invoice_disputes (invoice_id, owner_id, ticket_id, reason, amount, currency, line_ids, due_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) RETURNING id, number`, [id, req.user.id, t.id, reason, fromCents(cents), inv.currency, lineIds, days.answer]));
      await client.query('UPDATE invoices SET disputed = true WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { constraint?: string }).constraint === 'invoice_disputes_one_open') throw apiError(409, 'DISPUTE_ALREADY_OPEN', 'This invoice already has an open dispute');
      throw err;
    } finally { client.release(); }
    const { rows: [t] } = await pool.query('SELECT ticket_id FROM invoice_disputes WHERE id = $1', [d.id]);
    await addMessage(t.ticket_id, req.user.id, false, false, text, files);
    await audit(req, 'billing.dispute_opened', 'success', req.user.id, { disputeId: d.id, invoiceId: id, reason, amount: fromCents(cents) });
    await notify('billing.dispute_opened', 'staff:billing.manage', { disputeId: d.id, number: String(d.number), invoice: label, amount: fromCents(cents), currency: inv.currency, email: req.user.email });
    return { id: d.id, number: d.number, ticketId: t.ticket_id };
  }

  @Post('disputes/:id/withdraw') @HttpCode(200)
  async withdraw(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [d] } = await pool.query(`UPDATE invoice_disputes SET status = 'withdrawn', decided_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND status IN ('open', 'under_review')
      RETURNING invoice_id, ticket_id`, [id, req.user.id]);
    if (!d) throw apiError(409, 'DISPUTE_CLOSED', 'This dispute is already closed');
    await pool.query('UPDATE invoices SET disputed = false WHERE id = $1', [d.invoice_id]);
    if (d.ticket_id) await addMessage(d.ticket_id, req.user.id, false, false, 'İtiraz geri çekildi. / The dispute was withdrawn.', []);
    await audit(req, 'billing.dispute_withdrawn', 'success', req.user.id, { disputeId: id });
    return { ok: true };
  }
}

@Controller('admin/billing') @UseGuards(PermissionGuard)
export class DisputesAdminController {
  @Get('disputes') @Can('billing.view')
  async list(@Query('status') status?: string) {
    const { rows } = await pool.query(`SELECT ${columns}, u.email FROM invoice_disputes d JOIN invoices i ON i.id = d.invoice_id JOIN users u ON u.id = d.owner_id
      WHERE ($1::text IS NULL OR ($1 = 'open' AND d.status IN ('open', 'under_review')) OR d.status = $1) ORDER BY (d.status IN ('open', 'under_review')) DESC, d.due_at LIMIT 500`, [status || null]);
    const { rows: [c] } = await pool.query(`SELECT count(*) FILTER (WHERE status IN ('open', 'under_review'))::int AS open, count(*) FILTER (WHERE status IN ('open', 'under_review') AND due_at < now())::int AS overdue,
      count(*) FILTER (WHERE status IN ('accepted', 'partially_accepted'))::int AS accepted, count(*) FILTER (WHERE status = 'rejected')::int AS rejected FROM invoice_disputes`);
    return { disputes: rows, counts: c };
  }

  @Post('disputes/:id/review') @HttpCode(200) @Can('billing.manage')
  async review(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [d] } = await pool.query(`UPDATE invoice_disputes SET status = 'under_review', updated_at = now() WHERE id = $1 AND status = 'open' RETURNING owner_id, number, ticket_id`, [id]);
    if (!d) throw apiError(409, 'DISPUTE_CLOSED', 'Only an open dispute can be taken into review');
    if (d.ticket_id) await pool.query('UPDATE tickets SET assignee_id = coalesce(assignee_id, $2), updated_at = now() WHERE id = $1', [d.ticket_id, req.user.id]);
    await notify('billing.dispute_update', [d.owner_id], { disputeId: id, number: String(d.number), status: 'under_review' });
    await audit(req, 'billing.dispute_review', 'success', req.user.id, { disputeId: id });
    return { ok: true };
  }

  // The decision. Accepted (in full or in part): the amount goes back as the remedy says. Rejected: collection resumes.
  @Post('disputes/:id/decide') @HttpCode(200) @Can('billing.manage')
  async decide(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const { rows: [d] } = await pool.query(`SELECT d.*, i.status AS invoice_status, i.total::text AS invoice_total, i.paid_total::text AS invoice_paid, i.refunded_total::text AS invoice_refunded, i.number AS invoice_number
      FROM invoice_disputes d JOIN invoices i ON i.id = d.invoice_id WHERE d.id = $1`, [id]);
    if (!d) throw apiError(404, 'NOT_FOUND', 'Unknown dispute');
    if (!open.includes(d.status)) throw apiError(409, 'DISPUTE_CLOSED', 'This dispute is already decided');
    const fields: Record<string, string> = {};
    const decision = ['accept', 'partial', 'reject'].includes(String(body?.decision)) ? String(body.decision) : (fields.decision = 'REQUIRED', '');
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    if (!note) fields.note = 'REQUIRED';
    let cents = toCents(d.amount);
    if (decision === 'partial') { try { cents = toCents(String(body?.amount ?? '')); } catch { fields.amount = 'INVALID_AMOUNT'; } if (!fields.amount && (cents <= 0 || cents >= toCents(d.amount))) fields.amount = 'OUT_OF_RANGE'; }
    const paid = ['paid', 'partially_refunded'].includes(d.invoice_status);
    // Unpaid: withdraw the invoice (only when all of it is accepted and nothing was paid) or credit the balance. Paid: refund or credit.
    const remedies = paid ? ['refund', 'balance'] : decision === 'accept' && toCents(d.invoice_paid) === 0 && cents >= toCents(d.invoice_total) ? ['cancel', 'balance'] : ['balance'];
    const remedy = decision === 'reject' ? null : remedies.includes(String(body?.remedy)) ? String(body.remedy) : (fields.remedy = 'INVALID_VALUE', null);
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    // An unpaid renewal follows its server's price also while in dispute (repriceOpenRenewal), so the invoice may be for
    // less by now than the amount contested: never more than is left of it goes back.
    cents = Math.min(cents, toCents(d.invoice_total) - toCents(d.invoice_refunded ?? '0'));

    if (remedy === 'refund' || (remedy === 'balance' && paid)) await refundInvoice(req, d.invoice_id, { amount: fromCents(cents), toBalance: remedy === 'balance', reason: `İtiraz / Dispute ${d.number}` });
    else if (remedy === 'balance') await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, invoice_id, note, created_by) VALUES ($1, $2, $3, 'adjustment', $4, $5, $6)",
      [d.owner_id, fromCents(cents), d.currency, d.invoice_id, `İtiraz / Dispute ${d.number}`, req.user.id]);
    else if (remedy === 'cancel') await withdrawInvoice(d.invoice_id); // accepted in full: nothing is owed for it, and it is not invoiced again
    const status = decision === 'reject' ? 'rejected' : decision === 'partial' ? 'partially_accepted' : 'accepted';
    await pool.query(`UPDATE invoice_disputes SET status = $2, remedy = $3, resolved_amount = $4, resolution = $5, decided_by = $6, decided_at = now(), updated_at = now() WHERE id = $1`,
      [id, status, remedy, decision === 'reject' ? null : fromCents(cents), note, req.user.id]);
    await pool.query('UPDATE invoices SET disputed = false WHERE id = $1', [d.invoice_id]);
    if (d.ticket_id) {
      await addMessage(d.ticket_id, req.user.id, true, false, note, []);
      await pool.query("UPDATE tickets SET status = 'answered', due_at = NULL, last_staff_at = now(), first_response_at = coalesce(first_response_at, now()), updated_at = now() WHERE id = $1", [d.ticket_id]);
    }
    await notify('billing.dispute_update', [d.owner_id], { disputeId: id, number: String(d.number), status, amount: decision === 'reject' ? '' : fromCents(cents), currency: d.currency, remedy: remedy ?? '' });
    await audit(req, 'billing.dispute_decided', 'success', req.user.id, { disputeId: id, status, remedy, amount: fromCents(cents) });
    return { ok: true, status };
  }
}

// From the billing run: open disputes past their decision date are raised to staff once.
export async function escalateDisputes() {
  const { rows } = await pool.query(`UPDATE invoice_disputes SET escalated_at = now() WHERE status IN ('open', 'under_review') AND due_at < now() AND escalated_at IS NULL
    RETURNING id, number, amount::text, currency`);
  for (const d of rows) await notify('billing.dispute_overdue', 'staff:billing.manage', { disputeId: d.id, number: String(d.number), amount: d.amount, currency: d.currency });
  return rows.length;
}
