// The audit log as a screen: staff with audit.view search everyone's events; every user sees their own account
// activity (sign-ins, changes, server actions), including what their power schedules did on their servers.
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { Can, PermissionGuard } from './rbac';

const page = 50;
const columns = `e.id::text, e.created_at AS "at", e.action, e.outcome, host(e.ip) AS ip, e.metadata, u.email AS "actorEmail", e.actor_id AS "actorId"`;
const before = (v?: string) => (v && /^\d{1,19}$/.test(v) ? v : null);
const more = (rows: { id: string }[]) => ({ events: rows.slice(0, page), nextBefore: rows.length > page ? rows[page - 1].id : null });

@Controller('admin') @UseGuards(PermissionGuard)
export class AuditController {
  @Get('audit') @Can('audit.view')
  async list(@Query('before') b?: string, @Query('q') q?: string, @Query('outcome') outcome?: string, @Query('category') category?: string) {
    const needle = (q ?? '').trim().slice(0, 100);
    const { rows } = await pool.query(`SELECT ${columns} FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE ($1::bigint IS NULL OR e.id < $1) AND ($2 = '' OR e.action ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%' OR host(e.ip) LIKE $2 || '%' OR e.metadata::text ILIKE '%' || $2 || '%')
        AND ($3 = '' OR e.outcome = $3) AND ($4 = '' OR split_part(e.action, '.', 1) = $4)
      ORDER BY e.id DESC LIMIT ${page + 1}`,
      [before(b), needle, ['success', 'failure', 'denied'].includes(outcome ?? '') ? outcome : '', /^[a-z_]{1,40}$/.test(category ?? '') ? category : '']);
    // shortcut: the category list scans the table; an index or a fixed list would be needed for millions of rows.
    const { rows: cats } = await pool.query("SELECT DISTINCT split_part(action, '.', 1) AS c FROM audit_events ORDER BY 1");
    return { ...more(rows), categories: cats.map((r) => r.c) };
  }
}

@Controller() @UseGuards(SessionGuard)
export class ActivityController {
  @Get('activity')
  async mine(@Req() req: AuthedRequest, @Query('before') b?: string) {
    const { rows } = await pool.query(`SELECT ${columns} FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE ($2::bigint IS NULL OR e.id < $2) AND (e.actor_id = $1 OR (e.actor_id IS NULL AND e.request_id LIKE 'schedule:%'
        AND e.metadata->>'serverId' IN (SELECT id::text FROM servers WHERE owner_id = $1)))
      ORDER BY e.id DESC LIMIT ${page + 1}`, [req.user.id, before(b)]);
    return more(rows);
  }
}
