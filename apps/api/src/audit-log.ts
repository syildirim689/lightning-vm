// The audit log as a screen: staff with audit.view search everyone's events; every user sees their own account
// activity (sign-ins, changes, server actions), including what their power schedules did on their servers.
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { Can, PermissionGuard } from './rbac';

const page = 50;
// Events whose metadata was, in earlier versions, the request body as it came (billing.ts): a "forOwner" in one of
// them was typed by its actor, so they are only ever part of the actor's own activity.
const ownActions = ['billing.subscription_changed', 'billing.subscription_updated'];
const columns = `e.id::text, e.created_at AS "at", e.action, e.outcome, host(e.ip) AS ip, e.metadata, u.email AS "actorEmail", e.actor_id AS "actorId"`;
const before = (v?: string) => (v && /^\d{1,19}$/.test(v) ? v : null);
const more = (rows: { id: string }[]) => ({ events: rows.slice(0, page), nextBefore: rows.length > page ? rows[page - 1].id : null });

// The category filter's choices scan the whole table, so they are read at most every 10 minutes per process
// (a new kind of event shows up in the filter within that time). One read is shared by concurrent callers.
const categoriesTtl = 10 * 60_000;
let categoryCache: { at: number; list: Promise<string[]> } | null = null;
function categories() {
  if (!categoryCache || Date.now() - categoryCache.at > categoriesTtl) {
    const list = pool.query("SELECT DISTINCT split_part(action, '.', 1) AS c FROM audit_events ORDER BY 1").then(({ rows }) => rows.map((r) => r.c as string));
    const entry = { at: Date.now(), list };
    categoryCache = entry;
    list.catch(() => { if (categoryCache === entry) categoryCache = null; }); // a failed read is not kept
  }
  return categoryCache.list;
}

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
    return { ...more(rows), categories: await categories() };
  }
}

@Controller() @UseGuards(SessionGuard)
export class ActivityController {
  @Get('activity')
  async mine(@Req() req: AuthedRequest, @Query('before') b?: string) {
    // Also what somebody else did for this account and recorded as such (metadata.forOwner): a reseller acting on the
    // customer's servers or account (operations, the console, schedules, labels, disks, an order), the account leaving
    // a reseller. Of those the customer sees what and when, and who only when it was their reseller (actingAs): the
    // reseller's address and its name (actorName: the brand it set, else its account name); never another person's
    // IP address. forOwner is written by the panel alone (auth.ts, auditMetadata); the events of the two routes that
    // once stored a request body as it came (ownActions) are never shown to anybody but their actor.
    const { rows } = await pool.query(`SELECT ${columns.replace('host(e.ip) AS ip', () => 'CASE WHEN e.actor_id = $1 OR e.actor_id IS NULL THEN host(e.ip) END AS ip')
        .replace('u.email AS "actorEmail"', () => `CASE WHEN e.actor_id = $1 OR e.metadata->>'actingAs' = 'reseller' THEN u.email END AS "actorEmail",
          CASE WHEN e.actor_id = $1 THEN nullif(u.name, '') WHEN e.metadata->>'actingAs' = 'reseller' THEN coalesce((SELECT nullif(x.brand_name, '') FROM resellers x WHERE x.user_id = e.actor_id), nullif(u.name, '')) END AS "actorName"`)}
      FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE ($2::bigint IS NULL OR e.id < $2) AND (e.actor_id = $1 OR (e.actor_id IS NULL AND e.request_id LIKE 'schedule:%'
        AND e.metadata->>'serverId' IN (SELECT id::text FROM servers WHERE owner_id = $1)) OR (e.metadata->>'forOwner' = ($1::uuid)::text AND e.action <> ALL($3::text[])))
      ORDER BY e.id DESC LIMIT ${page + 1}`, [req.user.id, before(b), ownActions]);
    return more(rows);
  }
}
