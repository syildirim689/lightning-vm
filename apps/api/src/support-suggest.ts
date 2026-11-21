// Support help from what the desk already knows (the rule: similarity-rules.ts).
// Staff, on a ticket: the closed tickets most like it, each with the answer that closed it and the words the two share.
// The customer, while writing a new ticket: what may answer it before it is sent, and only from material that is theirs
// or public already: their own earlier tickets with support's answers, and the incidents of the public status page
// (when that page is on). Another customer's ticket is never read for a customer: the statement below names the
// caller as the owner, and there is no other source.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { getSettings } from './settings-store';
import { similar, tokens } from './similarity-rules';
import { publicIncidents } from './status';

// Closed tickets compared for staff: the most recent ones of the last year.
export const SIMILAR_POOL = 300;
export const SIMILAR_DAYS = 365;
// The caller's own tickets compared for a customer, and how often suggestions may be asked for (they are asked while typing).
export const OWN_POOL = 50;
export const SUGGEST_PER_10_MIN = 60;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// A ticket as a text to compare: its subject (twice: it is the summary) and the customer's first message.
const asText = (subject: string, first: string | null) => `${subject} ${subject} ${first ?? ''}`;
const firstCustomer = `(SELECT left(m.body, 2000) FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.staff AND NOT m.internal ORDER BY m.created_at LIMIT 1)`;
const lastAnswer = `(SELECT left(m.body, 1200) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.staff AND NOT m.internal ORDER BY m.created_at DESC LIMIT 1)`;

@Controller('admin/support') @UseGuards(PermissionGuard)
export class SupportSimilarController {
  @Get('tickets/:id/similar') @Can('support.view')
  async list(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [t] } = await pool.query(`SELECT t.subject, ${firstCustomer} AS first FROM tickets t WHERE t.id = $1`, [id]);
    if (!t) throw apiError(404, 'NOT_FOUND', 'Unknown ticket');
    const { rows } = await pool.query(`SELECT t.id, t.number, t.subject, t.closed_at AS "closedAt", t.rating, ${firstCustomer} AS first, ${lastAnswer} AS answer
      FROM tickets t WHERE t.status = 'closed' AND t.id <> $1 AND t.closed_at > now() - make_interval(days => $2)
        AND EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.staff AND NOT m.internal)
      ORDER BY t.closed_at DESC LIMIT $3`, [id, SIMILAR_DAYS, SIMILAR_POOL]);
    const found = similar(asText(t.subject, t.first), rows.map((r) => ({ id: r.id, text: asText(r.subject, r.first) })));
    return { compared: rows.length, similar: found.map((m) => { const r = rows.find((x) => x.id === m.id)!;
      return { id: r.id, number: Number(r.number), subject: r.subject, closedAt: r.closedAt, rating: r.rating, score: m.score, shared: m.shared, answer: clip(String(r.answer ?? ''), 600) }; }) };
  }
}

@Controller('support') @UseGuards(SessionGuard)
export class SupportSuggestController {
  // Asked while a new ticket is being written; nothing is stored. Too little text, or too many questions in ten
  // minutes, answers with nothing rather than with an error: the form goes on working.
  @Post('suggestions') @HttpCode(200)
  async suggest(@Req() req: AuthedRequest, @Body() body: { subject?: unknown; body?: unknown }) {
    const subject = typeof body?.subject === 'string' ? body.subject.slice(0, 160) : '';
    const text = typeof body?.body === 'string' ? body.body.slice(0, 4000) : '';
    const none = { incidents: [], answers: [] };
    if (tokens(`${subject} ${text}`).length < 2) return none;
    const n = await redis.incr(`rl:suggest:${req.user.id}`).catch(() => 0); if (n === 1) await redis.expire(`rl:suggest:${req.user.id}`, 600).catch(() => undefined);
    if (n > SUGGEST_PER_10_MIN) return none;
    const query = asText(subject, text);

    // The public status page's incidents, when the page is on: open ones are always worth reading before writing;
    // resolved ones of the last week only when they are about the same thing.
    let incidents: { id: string; title: string; impact: string; status: string; open: boolean; createdAt: string; resolvedAt: string | null }[] = [];
    if ((await getSettings('statusPage')).enabled) {
      const all = await publicIncidents();
      const about = new Set(similar(query, all.filter((i) => i.resolvedAt).map((i) => ({ id: i.id, text: `${i.title} ${i.title} ${(i.updates as { body?: string }[]).map((u) => u.body ?? '').join(' ')}` }))).map((m) => m.id));
      incidents = all.filter((i) => !i.resolvedAt || about.has(i.id)).slice(0, 3)
        .map((i) => ({ id: i.id, title: i.title, impact: i.impact, status: i.status, open: !i.resolvedAt, createdAt: i.createdAt, resolvedAt: i.resolvedAt }));
    }

    // The caller's own tickets that support has answered, and nobody else's.
    const { rows } = await pool.query(`SELECT t.id, t.number, t.subject, t.status, ${firstCustomer} AS first, ${lastAnswer} AS answer
      FROM tickets t WHERE t.owner_id = $1 AND EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.staff AND NOT m.internal)
      ORDER BY t.updated_at DESC LIMIT $2`, [req.user.id, OWN_POOL]);
    const answers = similar(query, rows.map((r) => ({ id: r.id, text: asText(r.subject, r.first) }))).map((m) => { const r = rows.find((x) => x.id === m.id)!;
      return { id: r.id, number: Number(r.number), subject: r.subject, status: r.status, shared: m.shared, answer: clip(String(r.answer ?? ''), 400) }; });
    return { incidents, answers };
  }
}
