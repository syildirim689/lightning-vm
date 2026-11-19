// API access for integrations, beyond the token itself (developer.ts) and its check (auth.ts):
// the administrator's rules (Settings → API), the per-token rate limit with its headers, the request log,
// and the administrator's view of every token.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req, UseGuards } from '@nestjs/common';
import { audit, type AuthedRequest } from './auth';
import { config } from './config';
import { pool } from './db';
import { apiError } from './errors';
import { tokenAsleepSql } from './ldap';
import { Can, PermissionGuard } from './rbac';
import { validCidr } from './role-limits';
import { getSettings, saveSettings } from './settings-store';

export type ApiSettings = { maxDays: number; staffExpiry: boolean; rateLimit: number; networks: string[]; log: boolean; logDays: number };

function readSettings(body: unknown): ApiSettings & { who: 'everyone' | 'staff' | 'off' } {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const int = (v: unknown, min: number, max: number, key: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fields[key] = 'INVALID_VALUE';
    return n;
  };
  const who = b.who as 'everyone' | 'staff' | 'off';
  if (!['everyone', 'staff', 'off'].includes(who)) fields.who = 'INVALID_VALUE';
  const networks = Array.isArray(b.networks) ? b.networks.map((x) => String(x).trim()).filter(Boolean) : [];
  if (networks.length > 50 || networks.some((n) => !validCidr(n))) fields.networks = 'INVALID_ADDRESS';
  const out = { who, maxDays: int(b.maxDays ?? 0, 0, 3650, 'maxDays'), staffExpiry: b.staffExpiry === true, rateLimit: int(b.rateLimit ?? 600, 0, 100_000, 'rateLimit'),
    networks, log: b.log !== false, logDays: int(b.logDays ?? 14, 1, 365, 'logDays') };
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return out;
}

@Controller('admin/api') @UseGuards(PermissionGuard)
export class ApiAdminController {
  // The rules for tokens; "who" is the same switch as Settings → Security → API tokens.
  @Get('settings') @Can('settings.view', 'settings.manage')
  async settings() {
    const [api, security] = await Promise.all([getSettings('api'), getSettings('security')]);
    return { ...api, who: security.apiTokens ?? 'everyone' };
  }

  @Put('settings') @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { who, ...api } = readSettings(body);
    await saveSettings('api', api);
    await saveSettings('security', { ...(await getSettings('security')), apiTokens: who });
    await audit(req, 'settings.api_changed', 'success', req.user.id, { who, maxDays: api.maxDays, rateLimit: api.rateLimit, networks: api.networks.length, log: api.log });
    return { ...api, who };
  }

  // Every token of every account, with its owner and how much it was used today. asleep: the refusal's code while the
  // token of a directory or single sign-on account is not accepted (ldap.ts, tokenAsleep); null otherwise.
  @Get('tokens') @Can('settings.view', 'settings.manage', 'users.view')
  async tokens() {
    const { rows } = await pool.query(`SELECT t.id, t.name, t.hint, t.scope, t.permissions, t.allowed_ips AS "allowedIps", t.expires_at AS "expiresAt",
        t.last_used_at AS "lastUsedAt", host(t.last_used_ip) AS "lastUsedIp", t.created_at AS "createdAt",
        json_build_object('id', u.id, 'email', u.email, 'name', u.name, 'role', coalesce(u.role, 'user')) AS owner,
        (SELECT count(*)::int FROM api_request_log l WHERE l.token_id = t.id AND l.created_at > now() - interval '24 hours') AS "requests24h",
        (SELECT count(*)::int FROM api_request_log l WHERE l.token_id = t.id AND l.created_at > now() - interval '24 hours' AND l.status >= 400) AS "errors24h",
        ${tokenAsleepSql('u', '$1')} AS asleep
      FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC`, [config.DIRECTORY_TOKEN_DAYS]);
    return { tokens: rows };
  }

  @Delete('tokens/:id') @HttpCode(204) @Can('settings.manage')
  async revoke(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [t] } = await pool.query('DELETE FROM api_tokens WHERE id = $1 RETURNING name, user_id', [id]);
    if (!t) throw apiError(404, 'NOT_FOUND', 'Unknown token');
    await audit(req, 'admin.api_token_revoked', 'success', t.user_id, { tokenId: id, name: t.name });
  }

  // The newest requests made with tokens (at most 500), and a summary of the last 24 hours.
  @Get('log') @Can('settings.view', 'settings.manage')
  async log(@Query() q: Record<string, string>) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.token && /^[0-9a-f-]{36}$/.test(q.token)) { args.push(q.token); where.push(`token_id = $${args.length}`); }
    if (q.status === 'errors') where.push('status >= 400');
    if (q.q) { args.push(`%${q.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`); where.push(`(path ILIKE $${args.length} OR route ILIKE $${args.length})`); }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const { rows } = await pool.query(`SELECT l.id, l.token_id AS "tokenId", l.token_name AS "tokenName", u.email AS owner, l.method, l.route, l.path, l.status,
        l.duration_ms AS "durationMs", host(l.ip) AS ip, l.created_at AS "createdAt"
      FROM api_request_log l LEFT JOIN users u ON u.id = l.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC LIMIT ${limit}`, args);
    const { rows: [summary] } = await pool.query(`SELECT count(*)::int AS requests, count(*) FILTER (WHERE status >= 400)::int AS errors,
        count(*) FILTER (WHERE status = 429)::int AS limited, coalesce(round(avg(duration_ms)), 0)::int AS "avgMs", count(DISTINCT token_id)::int AS tokens
      FROM api_request_log WHERE created_at > now() - interval '24 hours'`);
    const { rows: top } = await pool.query(`SELECT method, route, count(*)::int AS n FROM api_request_log WHERE created_at > now() - interval '24 hours'
      GROUP BY method, route ORDER BY n DESC LIMIT 8`);
    return { requests: rows, summary, top };
  }
}
