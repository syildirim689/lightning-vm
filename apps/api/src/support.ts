// Support tickets. Customers open tickets (optionally about one of their servers), write to them, close and rate
// them; staff with support.view see the queue and with support.manage answer, add internal notes, assign and change
// status or priority. Deadlines and status changes follow support-rules.ts. Notifications go through notify.ts.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { notify } from './notify';
import { can } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { afterMessage, dueFrom, priorities, readAttachments, reopenable, statuses, type Priority, type Status, type Upload } from './support-rules';

type Input = Record<string, unknown>;
const staffOf = (req: AuthedRequest) => can(req.user.permissions, 'support.view');
const manager = (req: AuthedRequest) => can(req.user.permissions, 'support.manage');

const ticketColumns = `t.id, t.number, t.subject, t.status, t.priority, t.due_at AS "dueAt", t.first_response_at AS "firstResponseAt", t.created_at AS "createdAt",
  t.updated_at AS "updatedAt", t.closed_at AS "closedAt", t.rating, t.rating_comment AS "ratingComment", t.last_customer_at AS "lastCustomerAt",
  t.department_id AS "departmentId", d.name_tr AS "departmentTr", d.name_en AS "departmentEn", t.server_id AS "serverId", s.name AS "serverName",
  t.owner_id AS "ownerId", t.assignee_id AS "assigneeId", a.email AS "assigneeEmail"`;
const ticketJoins = `FROM tickets t LEFT JOIN support_departments d ON d.id = t.department_id LEFT JOIN servers s ON s.id = t.server_id LEFT JOIN users a ON a.id = t.assignee_id`;

// The ticket if the caller may see it: its owner, or support staff.
async function ticketFor(req: AuthedRequest, id: string) {
  const { rows: [t] } = await pool.query(`SELECT ${ticketColumns}, o.email AS "ownerEmail", o.name AS "ownerName" ${ticketJoins} JOIN users o ON o.id = t.owner_id WHERE t.id = $1`, [id]);
  if (!t || (t.ownerId !== req.user.id && !staffOf(req))) throw apiError(404, 'NOT_FOUND', 'Unknown ticket');
  return t;
}

export const readBody = (v: unknown) => {
  const body = typeof v === 'string' ? v.trim() : '';
  if (!body || body.length > 20_000) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { body: body ? 'TOO_LONG' : 'REQUIRED' });
  return body;
};
export function readFiles(v: unknown): Upload[] {
  const { files, error } = readAttachments(v);
  if (error) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { attachments: error });
  return files;
}

export async function addMessage(ticketId: string, authorId: string, staff: boolean, internal: boolean, body: string, files: Upload[]) {
  const { rows: [m] } = await pool.query('INSERT INTO ticket_messages (ticket_id, author_id, staff, internal, body) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [ticketId, authorId, staff, internal, body]);
  for (const f of files) await pool.query('INSERT INTO ticket_attachments (message_id, name, type, size, data) VALUES ($1, $2, $3, $4, $5)', [m.id, f.name, f.type, f.data.length, f.data]);
  return m.id as string;
}

// A ticket someone else closed (staff, or the janitor): its owner is asked to rate it.
const askRating = (t: { id: string; number: number; subject: string; ownerId: string }) =>
  notify('support.rate', [t.ownerId], { ticketId: t.id, number: String(t.number), subject: t.subject });

// Who on staff hears about a ticket: its assignee, or everyone who can see support.
const tellStaff = (t: { assigneeId: string | null }, data: Record<string, unknown>) =>
  notify('support.customer_message', t.assigneeId ? [t.assigneeId] : 'staff:support.view', data);

async function messagesOf(ticketId: string, withInternal: boolean) {
  const { rows } = await pool.query(`SELECT m.id, m.staff, m.internal, m.body, m.created_at AS "createdAt", coalesce(nullif(u.name, ''), u.email) AS author,
      coalesce((SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'type', a.type, 'size', a.size)) FROM ticket_attachments a WHERE a.message_id = m.id), '[]') AS attachments
    FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = $1 AND ($2 OR NOT m.internal) ORDER BY m.created_at`, [ticketId, withInternal]);
  // Customers see "Support" rather than a staff member's address.
  return withInternal ? rows : rows.map((r) => (r.staff ? { ...r, author: null } : r));
}

@Controller('support') @UseGuards(SessionGuard)
export class SupportController {
  @Get('departments')
  async departments() {
    const { rows } = await pool.query('SELECT id, name_tr AS "nameTr", name_en AS "nameEn" FROM support_departments WHERE active ORDER BY sort, name_en');
    return { departments: rows };
  }

  // The menu's counts: the caller's tickets waiting for them and, for staff, tickets waiting for support.
  @Get('summary')
  async summary(@Req() req: AuthedRequest) {
    const { rows: [m] } = await pool.query("SELECT count(*)::int AS n FROM tickets WHERE owner_id = $1 AND status = 'answered'", [req.user.id]);
    const queue = staffOf(req) ? (await pool.query("SELECT count(*)::int AS n FROM tickets WHERE status IN ('open', 'customer_reply')")).rows[0].n as number : null;
    return { waiting: m.n as number, queue };
  }

  @Get('tickets')
  async mine(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${ticketColumns} ${ticketJoins} WHERE t.owner_id = $1 ORDER BY (t.status = 'answered') DESC, t.updated_at DESC LIMIT 200`, [req.user.id]);
    return { tickets: rows };
  }

  @Post('tickets') @HttpCode(201)
  async open(@Req() req: AuthedRequest, @Body() body: Input) {
    const fields: Record<string, string> = {};
    const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
    if (subject.length < 3 || subject.length > 160) fields.subject = 'INVALID_VALUE';
    const priority = priorities.includes(body?.priority as Priority) ? body.priority as Priority : 'normal';
    const departmentId = typeof body?.departmentId === 'string' ? body.departmentId : '';
    const { rowCount: dep } = await pool.query('SELECT 1 FROM support_departments WHERE id = $1 AND active', [departmentId]).catch(() => ({ rowCount: 0 }));
    if (!dep) fields.departmentId = 'REQUIRED';
    let serverId: string | null = null;
    if (body?.serverId) {
      const { rows: [s] } = await pool.query("SELECT id FROM servers WHERE id = $1 AND owner_id = $2 AND state <> 'deleted'", [String(body.serverId), req.user.id]).catch(() => ({ rows: [] }));
      if (!s) fields.serverId = 'INVALID_VALUE'; else serverId = s.id;
    }
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const text = readBody(body?.body);
    const files = readFiles(body?.attachments);
    // At most 10 new tickets an hour per person.
    const n = await redis.incr(`rl:tickets:${req.user.id}`); if (n === 1) await redis.expire(`rl:tickets:${req.user.id}`, 3600);
    if (n > 10) throw apiError(429, 'RATE_LIMITED', 'Too many tickets');
    const { rows: [t] } = await pool.query(`INSERT INTO tickets (owner_id, department_id, server_id, subject, priority, due_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number`,
      [req.user.id, departmentId, serverId, subject, priority, dueFrom(new Date(), priority)]);
    await addMessage(t.id, req.user.id, false, false, text, files);
    await audit(req, 'support.ticket_opened', 'success', req.user.id, { ticketId: t.id, number: t.number, priority });
    await notify('support.ticket_opened', 'staff:support.view', { ticketId: t.id, number: t.number, subject, priority, email: req.user.email });
    return { id: t.id, number: t.number };
  }

  @Get('tickets/:id')
  async get(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const t = await ticketFor(req, id);
    const staff = staffOf(req);
    return { ticket: staff ? t : { ...t, assigneeEmail: null, ownerEmail: undefined }, messages: await messagesOf(id, staff), staff };
  }

  @Post('tickets/:id/messages') @HttpCode(201)
  async reply(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const t = await ticketFor(req, id);
    const byStaff = t.ownerId !== req.user.id;
    if (byStaff && !manager(req)) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const internal = byStaff && body?.internal === true;
    if (t.status === 'closed' && !byStaff && !reopenable(t.closedAt ? new Date(t.closedAt) : null)) throw apiError(409, 'TICKET_CLOSED', 'This ticket is closed; open a new one');
    const text = readBody(body?.body);
    const files = readFiles(body?.attachments);
    await addMessage(id, req.user.id, byStaff, internal, text, files);
    const next = afterMessage({ status: t.status as Status, priority: t.priority as Priority }, byStaff ? 'staff' : 'customer', internal);
    if (next) {
      await pool.query(`UPDATE tickets SET status = $2, due_at = $3, closed_at = NULL, updated_at = now(),
          ${byStaff ? 'last_staff_at = now(), first_response_at = coalesce(first_response_at, now())' : 'last_customer_at = now()'} WHERE id = $1`, [id, next.status, next.dueAt]);
    } else await pool.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [id]);
    if (byStaff && !internal) await notify('support.reply', [t.ownerId], { ticketId: id, number: t.number, subject: t.subject });
    if (!byStaff) await tellStaff(t, { ticketId: id, number: t.number, subject: t.subject, email: req.user.email });
    await audit(req, internal ? 'support.note' : 'support.reply', 'success', req.user.id, { ticketId: id });
    return { ok: true };
  }

  @Post('tickets/:id/close') @HttpCode(200)
  async close(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const t = await ticketFor(req, id);
    if (t.ownerId !== req.user.id && !manager(req)) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const { rowCount } = await pool.query("UPDATE tickets SET status = 'closed', closed_at = now(), due_at = NULL, updated_at = now() WHERE id = $1 AND status <> 'closed'", [id]);
    await audit(req, 'support.closed', 'success', req.user.id, { ticketId: id });
    if (rowCount && t.ownerId !== req.user.id) await askRating(t);
    return { ok: true };
  }

  // The owner rates a closed ticket once (1–5, with an optional comment).
  @Post('tickets/:id/rating') @HttpCode(200)
  async rate(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const t = await ticketFor(req, id);
    if (t.ownerId !== req.user.id) throw apiError(403, 'FORBIDDEN', 'Only the person who opened it');
    if (t.status !== 'closed') throw apiError(409, 'TICKET_NOT_CLOSED', 'Rate it once it is closed');
    const rating = Number(body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { rating: 'OUT_OF_RANGE' });
    const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 1000) : null;
    await pool.query('UPDATE tickets SET rating = $2, rating_comment = $3 WHERE id = $1', [id, rating, comment || null]);
    // A poor rating (1–2) reaches whoever handled it, or the team, once.
    if (rating <= 2 && !(t.rating && t.rating <= 2)) await notify('support.low_rating', t.assigneeId ? [t.assigneeId] : 'staff:support.view',
      { ticketId: id, number: String(t.number), subject: t.subject, rating: String(rating), comment: comment ?? '' });
    return { rating };
  }

  // Attachments are always downloaded (never rendered here), with their checked type.
  @Get('attachments/:id')
  async attachment(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { rows: [a] } = await pool.query(`SELECT a.name, a.type, a.data, m.ticket_id, m.internal FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id WHERE a.id = $1`, [id]);
    if (!a) throw apiError(404, 'NOT_FOUND', 'Unknown attachment');
    await ticketFor(req, a.ticket_id);
    if (a.internal && !staffOf(req)) throw apiError(404, 'NOT_FOUND', 'Unknown attachment');
    reply.header('content-type', a.type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    return a.data;
  }
}

@Controller('admin/support') @UseGuards(PermissionGuard)
export class SupportAdminController {
  // The queue: filters, search by number / subject / e-mail; overdue first, then by deadline.
  @Get('tickets') @Can('support.view')
  async queue(@Req() req: AuthedRequest, @Query('status') status?: string, @Query('priority') priority?: string, @Query('department') department?: string,
    @Query('assignee') assignee?: string, @Query('q') q?: string) {
    const where = ['true'], args: unknown[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (status === 'active') where.push("t.status <> 'closed'");
    else if (statuses.includes(status as Status)) add('t.status = ?', status);
    if (priorities.includes(priority as Priority)) add('t.priority = ?', priority);
    if (department && /^[0-9a-f-]{36}$/.test(department)) add('t.department_id = ?', department);
    if (assignee === 'me') add('t.assignee_id = ?', req.user.id);
    if (assignee === 'none') where.push('t.assignee_id IS NULL');
    if (q?.trim()) {
      args.push(`%${q.trim()}%`, q.trim().replace(/^#/, ''));
      where.push(`(t.subject ILIKE $${args.length - 1} OR o.email ILIKE $${args.length - 1} OR t.number::text = $${args.length})`);
    }
    const { rows } = await pool.query(`SELECT ${ticketColumns}, o.email AS "ownerEmail",
        (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.internal) AS messages
      ${ticketJoins} JOIN users o ON o.id = t.owner_id WHERE ${where.join(' AND ')}
      ORDER BY (t.status = 'closed'), (t.due_at < now()) DESC NULLS LAST, t.due_at ASC NULLS LAST, t.updated_at DESC LIMIT 300`, args);
    return { tickets: rows };
  }

  @Get('stats') @Can('support.view')
  async stats() {
    const { rows: [s] } = await pool.query(`SELECT
      count(*) FILTER (WHERE status <> 'closed')::int AS active,
      count(*) FILTER (WHERE status IN ('open', 'customer_reply'))::int AS waiting,
      count(*) FILTER (WHERE status <> 'closed' AND due_at < now())::int AS overdue,
      count(*) FILTER (WHERE status <> 'closed' AND assignee_id IS NULL)::int AS unassigned,
      round(avg(extract(epoch FROM first_response_at - created_at) / 3600) FILTER (WHERE created_at > now() - interval '30 days')::numeric, 1)::float8 AS "firstResponseHours",
      round(avg(rating) FILTER (WHERE rating IS NOT NULL AND closed_at > now() - interval '90 days')::numeric, 2)::float8 AS rating
      FROM tickets`);
    return s;
  }

  @Patch('tickets/:id') @Can('support.manage')
  async change(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const { rows: [t] } = await pool.query('SELECT id, number, subject, status, priority, assignee_id, owner_id, created_at FROM tickets WHERE id = $1', [id]);
    if (!t) throw apiError(404, 'NOT_FOUND', 'Unknown ticket');
    const fields: Record<string, string> = {};
    const status = body?.status === undefined ? t.status : statuses.includes(body.status as Status) ? body.status as Status : (fields.status = 'INVALID_VALUE', t.status);
    const priority = body?.priority === undefined ? t.priority : priorities.includes(body.priority as Priority) ? body.priority as Priority : (fields.priority = 'INVALID_VALUE', t.priority);
    let assignee = t.assignee_id as string | null;
    if (body?.assigneeId !== undefined) {
      if (body.assigneeId === null) assignee = null;
      else {
        const { rows: [u] } = await pool.query('SELECT id, role FROM users WHERE id = $1', [String(body.assigneeId)]).catch(() => ({ rows: [] }));
        if (!u) fields.assigneeId = 'INVALID_VALUE'; else assignee = u.id;
      }
    }
    const departmentId = body?.departmentId === undefined ? undefined : String(body.departmentId);
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    // A new priority moves an open deadline; closing clears it.
    await pool.query(`UPDATE tickets SET status = $2, priority = $3, assignee_id = $4, department_id = coalesce($5, department_id), updated_at = now(),
        closed_at = CASE WHEN $2 = 'closed' THEN coalesce(closed_at, now()) ELSE NULL END,
        due_at = CASE WHEN $2 IN ('closed', 'answered', 'on_hold') THEN NULL WHEN due_at IS NOT NULL AND $3 <> priority THEN $6 ELSE due_at END WHERE id = $1`,
      [id, status, priority, assignee, departmentId ?? null, dueFrom(new Date(), priority as Priority)]);
    if (status === 'closed' && t.status !== 'closed' && t.owner_id !== req.user.id) await askRating({ id, number: t.number, subject: t.subject, ownerId: t.owner_id });
    if (assignee && assignee !== t.assignee_id && assignee !== req.user.id) await notify('support.assigned', [assignee], { ticketId: id, number: t.number, subject: t.subject });
    await audit(req, 'support.changed', 'success', req.user.id, { ticketId: id, status, priority, assignee });
    return { ok: true };
  }

  // Who has this ticket open: each staff page says so every 15 s; the others seen in the last 40 s are returned,
  // so two people do not answer the same customer at once. typing: they are writing a reply.
  @Post('tickets/:id/presence') @HttpCode(200) @Can('support.view')
  async presence(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const key = `support:presence:${id}`, now = Date.now();
    await redis.multi().zadd(key, now, `${req.user.id}|${body?.typing === true ? 1 : 0}`).zrem(key, `${req.user.id}|${body?.typing === true ? 0 : 1}`)
      .zremrangebyscore(key, 0, now - 40_000).expire(key, 120).exec();
    const others = (await redis.zrange(key, 0, -1)).map((m) => m.split('|')).filter(([u]) => u !== req.user.id);
    if (!others.length) return { others: [] };
    const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = ANY($1::uuid[])', [others.map(([u]) => u)]);
    return { others: rows.map((u) => ({ email: u.email, name: u.name ?? '', typing: others.some(([x, t]) => x === u.id && t === '1') })) };
  }

  // Staff who can answer, for the assignee picker.
  @Get('agents') @Can('support.view')
  async agents() {
    const { rows } = await pool.query(`SELECT u.id, u.email, u.name FROM users u WHERE NOT coalesce(u.banned, false) AND EXISTS (SELECT 1 FROM roles r
      WHERE r.key = ANY(string_to_array(coalesce(u.role, 'user'), ',')) AND ('*' = ANY(r.permissions) OR 'support.manage' = ANY(r.permissions))) ORDER BY u.email`);
    return { agents: rows };
  }

  // The customer next to the ticket: their servers and what they cost, and their other tickets.
  @Get('customers/:id') @Can('support.view')
  async customer(@Param('id', ParseUUIDPipe) id: string) {
    const [servers, tickets] = await Promise.all([
      pool.query(`SELECT id, name, state, power_state AS "powerState", price_monthly::float8 AS price, trim(currency) AS currency FROM servers WHERE owner_id = $1 AND state <> 'deleted' ORDER BY created_at DESC LIMIT 20`, [id]),
      pool.query(`SELECT id, number, subject, status, created_at AS "createdAt" FROM tickets WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
    ]);
    return { servers: servers.rows, tickets: tickets.rows };
  }

  @Get('canned') @Can('support.view')
  async canned() {
    const { rows } = await pool.query('SELECT id, title, body FROM canned_responses ORDER BY title');
    return { canned: rows };
  }

  @Post('canned') @HttpCode(201) @Can('support.manage')
  async addCanned(@Req() req: AuthedRequest, @Body() body: Input) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '', text = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!title || title.length > 80 || !text || text.length > 5000) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { ...((!title || title.length > 80) && { title: 'INVALID_VALUE' }), ...((!text || text.length > 5000) && { body: 'INVALID_VALUE' }) });
    const { rows: [c] } = await pool.query('INSERT INTO canned_responses (title, body, created_by) VALUES ($1, $2, $3) RETURNING id', [title, text, req.user.id]);
    return { id: c.id };
  }

  @Delete('canned/:id') @HttpCode(204) @Can('support.manage')
  async removeCanned(@Param('id', ParseUUIDPipe) id: string) { await pool.query('DELETE FROM canned_responses WHERE id = $1', [id]); }

  // Departments (Settings): names in both languages, order, on/off.
  @Get('departments') @Can('support.view', 'settings.view')
  async departments() {
    const { rows } = await pool.query(`SELECT d.id, d.name_tr AS "nameTr", d.name_en AS "nameEn", d.sort, d.active,
      (SELECT count(*)::int FROM tickets t WHERE t.department_id = d.id AND t.status <> 'closed') AS open FROM support_departments d ORDER BY d.sort, d.name_en`);
    return { departments: rows };
  }

  @Put('departments') @Can('settings.manage')
  async saveDepartments(@Req() req: AuthedRequest, @Body() body: Input) {
    const list = Array.isArray(body?.departments) ? body.departments as Input[] : null;
    const bad = !list || list.length > 30 || list.some((d) => typeof d.nameTr !== 'string' || typeof d.nameEn !== 'string' || !d.nameTr.trim() || !d.nameEn.trim() || d.nameTr.length > 60 || d.nameEn.length > 60);
    if (bad) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { departments: 'INVALID_VALUE' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const keep: string[] = [];
      for (const [i, d] of list!.entries()) {
        const id = typeof d.id === 'string' && /^[0-9a-f-]{36}$/.test(d.id) ? d.id : null;
        const { rows: [r] } = id
          ? await client.query('UPDATE support_departments SET name_tr = $2, name_en = $3, sort = $4, active = $5 WHERE id = $1 RETURNING id', [id, String(d.nameTr).trim(), String(d.nameEn).trim(), i, d.active !== false])
          : await client.query('INSERT INTO support_departments (name_tr, name_en, sort, active) VALUES ($1, $2, $3, $4) RETURNING id', [String(d.nameTr).trim(), String(d.nameEn).trim(), i, d.active !== false]);
        if (r) keep.push(r.id);
      }
      // Removed departments: tickets keep their history with no department.
      await client.query('DELETE FROM support_departments WHERE NOT (id = ANY($1::uuid[]))', [keep]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await audit(req, 'settings.support_departments', 'success', req.user.id, { count: list!.length });
    return this.departments();
  }
}

// Tickets past their deadline: their assignee (or the team) is told once per deadline.
export async function alertOverdue() {
  const { rows } = await pool.query(`UPDATE tickets SET overdue_alerted_at = now()
    WHERE status <> 'closed' AND due_at < now() AND (overdue_alerted_at IS NULL OR overdue_alerted_at < due_at)
    RETURNING id, number, subject, priority, assignee_id AS "assigneeId"`);
  for (const t of rows) await notify('support.overdue', t.assigneeId ? [t.assigneeId] : 'staff:support.view', { ticketId: t.id, number: String(t.number), subject: t.subject, priority: t.priority });
  return rows.length;
}

// Hourly: tickets answered by staff with no customer reply for 7 days are closed.
export function startSupportJanitor() {
  const tick = async () => {
    if (!(await redis.set('lock:support-janitor', '1', 'EX', 3000, 'NX').catch(() => null))) return;
    const { rows } = await pool.query(`UPDATE tickets SET status = 'closed', closed_at = now(), updated_at = now() WHERE status = 'answered' AND last_staff_at < now() - interval '7 days'
      RETURNING id, number, subject, owner_id AS "ownerId"`).catch(() => { logEvent('error', 'support_janitor_failed'); return { rows: [] }; });
    for (const t of rows) await askRating(t);
  };
  // Every 5 minutes: overdue tickets (an urgent one is due within the hour).
  const overdue = async () => {
    if (!(await redis.set('lock:support-overdue', '1', 'EX', 240, 'NX').catch(() => null))) return;
    await alertOverdue().catch(() => logEvent('error', 'support_overdue_failed'));
  };
  setInterval(tick, 3_600_000).unref();
  setInterval(overdue, 300_000).unref();
}
