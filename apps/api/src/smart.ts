// Smart features: a server's health score with its reasons and right-sizing advice, the customer's cost
// forecast for this month, and the admin's getting-started checklist. The rules are in smart-rules.ts.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { usageOf } from './catalog';
import { pool } from './db';
import { apiError } from './errors';
import { summary as maintenance } from './maintenance';
import { Can, PermissionGuard } from './rbac';
import { findServer } from './servers';
import { mailReady } from './settings-store';
import { budgetState, checkBudget } from './budget';
import { cleanLabels, health, monthCost, sizing, type CpuStats } from './smart-rules';
import { publishLive } from './live-bus';
import { endSession, sessionsOf } from './presence';
import { validTimeZone } from './time-zone';

// CPU of the servers given over the last 7 days (server_cpu_samples, written with each energy sample).
export async function cpuStats(ids: string[]): Promise<Map<string, CpuStats>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT server_id AS id, avg(cpu_pct)::float8 AS avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_pct)::float8 AS p95,
      count(*)::int AS samples, (EXTRACT(EPOCH FROM max(at) - min(at)) / 86400)::float8 AS days
    FROM server_cpu_samples WHERE server_id = ANY($1::uuid[]) AND at > now() - interval '7 days' GROUP BY server_id`, [ids]);
  return new Map(rows.map((r) => [r.id, { avg: r.avg, p95: r.p95, samples: r.samples, days: r.days }]));
}

@Controller() @UseGuards(SessionGuard)
export class SmartController {
  @Get('servers/:id/health')
  async serverHealth(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const [stats, { rows: [x] }] = await Promise.all([cpuStats([id]), pool.query(`SELECT
      (SELECT count(*)::int FROM abuse_findings WHERE server_id = $1 AND resolved_at IS NULL) AS abuse,
      (SELECT count(*)::int FROM operations WHERE server_id = $1 AND status = 'failed' AND created_at > now() - interval '24 hours') AS failed`, [id])]);
    const cpu = stats.get(id) ?? null;
    const size = sizing(s.vcpu, cpu);
    return { ...health({ state: s.state, powerState: s.power_state, abuseOpen: x.abuse, failedOps24h: x.failed, cpuP95: cpu && cpu.samples >= 24 ? cpu.p95 : null, advice: size.advice }),
      cpu: cpu && { avg: Math.round(cpu.avg * 10) / 10, p95: Math.round(cpu.p95 * 10) / 10, samples: cpu.samples, days: Math.round(cpu.days * 10) / 10 }, vcpu: s.vcpu, ...size };
  }

  // The owner's tags and notes (staff need servers.manage_all to change someone else's).
  @Put('servers/:id/labels')
  async labels(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    const v = cleanLabels(body);
    if ('fields' in v) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', v.fields);
    await pool.query('UPDATE servers SET tags = $2, notes = $3, updated_at = now() WHERE id = $1', [id, v.tags, v.notes]);
    await audit(req, 'server.labels', 'success', req.user.id, { id, tags: v.tags });
    return v;
  }

  // Spending of this month per currency (servers and virtual data centers), with the resources in use.
  @Get('usage/summary')
  async usage(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT price_monthly::float8 AS price, currency, created_at FROM servers WHERE owner_id = $1 AND state <> 'deleted' AND price_monthly > 0
      UNION ALL SELECT price_monthly::float8, currency, created_at FROM vdcs WHERE owner_id = $1 AND active AND price_monthly > 0`, [req.user.id]);
    const now = new Date();
    const currencies = [...new Set(rows.map((r) => r.currency.trim()))].sort();
    return {
      costs: currencies.map((c) => ({ currency: c, ...monthCost(rows.filter((r) => r.currency.trim() === c).map((r) => ({ price: r.price, createdAt: new Date(r.created_at) })), now) })),
      usage: await usageOf(req.user.id),
      budget: await budgetState(req.user.id),
    };
  }

  // The monthly budget: an amount and a currency, or null to remove it.
  @Put('usage/budget')
  async setBudget(@Req() req: AuthedRequest, @Body() body: { amount?: unknown; currency?: unknown }) {
    if (body?.amount === null || body?.amount === '' || body?.amount === undefined) {
      await pool.query('UPDATE users SET budget_monthly = NULL, budget_currency = NULL, budget_alerted = NULL WHERE id = $1', [req.user.id]);
    } else {
      const amount = Number(String(body.amount).replace(',', '.'));
      const currency = String(body?.currency ?? '').toUpperCase();
      const fields: Record<string, string> = {};
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) fields.amount = 'INVALID_AMOUNT';
      if (!/^[A-Z]{3}$/.test(currency)) fields.currency = 'INVALID_CURRENCY';
      if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
      // A new amount may be exceeded again this month: the notice can go out again.
      await pool.query('UPDATE users SET budget_monthly = $2, budget_currency = $3, budget_alerted = NULL WHERE id = $1', [req.user.id, amount.toFixed(2), currency]);
      await checkBudget(req.user.id);
    }
    await audit(req, 'usage.budget', 'success', req.user.id, { amount: body?.amount ?? null, currency: body?.currency ?? null });
    return { budget: await budgetState(req.user.id) };
  }

  // Starred servers (any server the person can see).
  @Put('servers/:id/favorite')
  async star(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id);
    await pool.query('INSERT INTO server_favorites (user_id, server_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, id]);
    return { favorite: true };
  }

  @Delete('servers/:id/favorite')
  async unstar(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await pool.query('DELETE FROM server_favorites WHERE user_id = $1 AND server_id = $2', [req.user.id, id]);
    return { favorite: false };
  }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class OnboardingController {
  // What a new installation still needs before customers can order, in the order it is usually done.
  @Get('onboarding') @Can('dashboard.view')
  async steps(@Req() req: AuthedRequest) {
    const { rows: [n] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM vmware_connections) AS connection, (SELECT count(*)::int FROM locations) AS location,
      (SELECT count(*)::int FROM resource_pools WHERE active) AS pool, (SELECT count(*)::int FROM os_images WHERE active) AS image,
      (SELECT count(*)::int FROM packages WHERE active) + (SELECT count(*)::int FROM custom_rules WHERE active) AS package,
      (SELECT count(*)::int FROM ip_pools) AS ip, (SELECT two_factor_enabled FROM users WHERE id = $1) AS twofa`, [req.user.id]);
    const done: [string, boolean, string][] = [
      ['connection', n.connection > 0, '/admin/vmware'],
      ['location', n.location > 0, '/admin/catalog?tab=locations'],
      ['pool', n.pool > 0, '/admin/catalog?tab=pools'],
      ['image', n.image > 0, '/admin/catalog?tab=images'],
      ['package', n.package > 0, '/admin/catalog?tab=packages'],
      ['ip', n.ip > 0, '/admin/catalog?tab=ip'],
      ['mail', await mailReady(), '/admin/settings?tab=mail'],
      ['backup', !!maintenance().lastSuccessfulBackup, '/admin/system'],
      ['twoFactor', !!n.twofa, '/account?tab=security'],
    ];
    return { steps: done.map(([key, ok, link]) => ({ key, done: ok, link })) };
  }
}

// Admin dashboard: what happened since the person last looked (the panel sends the time; at most 30 days back).
@Controller('admin') @UseGuards(PermissionGuard)
export class DigestController {
  @Get('digest') @Can('dashboard.view')
  async digest(@Req() req: AuthedRequest, @Query('since') since?: string) {
    const floor = Date.now() - 30 * 86_400_000;
    const t = Date.parse(since ?? '');
    const from = new Date(Number.isFinite(t) ? Math.min(Date.now(), Math.max(floor, t)) : Date.now() - 86_400_000);
    const { rows: [c] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM users WHERE created_at > $1) AS users,
      (SELECT count(*)::int FROM servers WHERE created_at > $1) AS servers,
      (SELECT count(*)::int FROM operations WHERE created_at > $1 AND status = 'failed') AS "failedOperations",
      (SELECT count(*)::int FROM operations WHERE created_at > $1 AND status = 'succeeded') AS "doneOperations",
      (SELECT count(*)::int FROM abuse_findings WHERE first_seen > $1) AS abuse,
      (SELECT count(*)::int FROM notifications WHERE user_id = $2 AND event = 'admin.alert' AND created_at > $1) AS alerts,
      (SELECT count(*)::int FROM audit_events WHERE created_at > $1 AND outcome = 'denied') AS denied,
      (SELECT count(*)::int FROM audit_events WHERE created_at > $1 AND action = 'auth.login' AND outcome = 'failure') AS "failedSignIns"`, [from, req.user.id]);
    return { since: from.toISOString(), counts: c };
  }
}

// The person's own sessions (the one in use marked), and ending one of them.
@Controller('account/sessions') @UseGuards(SessionGuard)
export class MySessionsController {
  @Get()
  async list(@Req() req: AuthedRequest) { return { sessions: await sessionsOf(req.user.id, req.sessionId) }; }

  @Delete(':sid') @HttpCode(204)
  async end(@Req() req: AuthedRequest, @Param('sid') sid: string) {
    if (!/^[\w-]{1,64}$/.test(sid) || !(await endSession(req.user.id, sid))) throw apiError(404, 'NOT_FOUND', 'Unknown session');
    await audit(req, 'account.session_ended', 'success', req.user.id, { session: sid });
    await publishLive(req.user.id, 'sessions');
  }
}

// The person's time zone for dates and times in the panel; null goes back to the browser's.
@Controller('account') @UseGuards(SessionGuard)
export class TimeZoneController {
  @Put('time-zone')
  async set(@Req() req: AuthedRequest, @Body() body: { timeZone?: unknown }) {
    const tz = body?.timeZone === null ? null : validTimeZone(body?.timeZone);
    if (body?.timeZone !== null && !tz) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { timeZone: 'INVALID_VALUE' });
    await pool.query('UPDATE users SET time_zone = $2, updated_at = now() WHERE id = $1', [req.user.id, tz]);
    await audit(req, 'account.time_zone', 'success', req.user.id, { timeZone: tz });
    await publishLive(req.user.id, 'account');
    return { timeZone: tz };
  }
}

// "Export my data": everything the panel keeps about the signed-in person, as one JSON file. No secrets: no
// password hashes, session tokens, root passwords, two-factor secrets or messaging-app addresses.
@Controller('account') @UseGuards(SessionGuard)
export class AccountExportController {
  @Get('export')
  async export(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const id = req.user.id;
    const q = async (sql: string) => (await pool.query(sql, [id])).rows;
    const [profile] = await q(`SELECT email, name, locale, coalesce(role, 'user') AS roles, created_at AS "createdAt", two_factor_enabled AS "twoFactorEnabled", phone_number AS "phoneNumber",
      phone_number_verified AS "phoneNumberVerified", budget_monthly::text AS "budgetMonthly", budget_currency AS "budgetCurrency", quiet_hours AS "quietHours", time_zone AS "timeZone" FROM users WHERE id = $1`);
    const data = {
      exportedAt: new Date().toISOString(),
      profile,
      servers: await q(`SELECT id, name, state, power_state AS "powerState", vcpu, memory_mb AS "memoryMb", disk_gb AS "diskGb", price_monthly::text AS "priceMonthly", currency,
        tags, notes, locked, created_at AS "createdAt" FROM servers WHERE owner_id = $1 ORDER BY created_at`),
      favorites: (await q('SELECT server_id FROM server_favorites WHERE user_id = $1')).map((r) => r.server_id),
      projects: await q('SELECT id, name, created_at AS "createdAt" FROM projects WHERE owner_id = $1 ORDER BY name'),
      sshKeys: await q('SELECT name, fingerprint, public_key AS "publicKey", created_at AS "createdAt" FROM ssh_keys WHERE owner_id = $1 ORDER BY name'),
      firewalls: await q(`SELECT f.name, f.rules, f.created_at AS "createdAt", ARRAY(SELECT s.name FROM firewall_servers fs JOIN servers s ON s.id = fs.server_id WHERE fs.firewall_id = f.id) AS servers
        FROM firewalls f WHERE f.owner_id = $1 ORDER BY f.name`),
      notificationPreferences: await q('SELECT event, channels FROM notification_preferences WHERE user_id = $1 ORDER BY event'),
      notifications: await q('SELECT event, title, body, link, created_at AS "createdAt", read_at AS "readAt" FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500'),
      messagingApps: await q('SELECT app, label, hint, enabled, created_at AS "createdAt" FROM chat_connections WHERE user_id = $1 ORDER BY created_at'),
      sessions: await q('SELECT ip_address AS ip, user_agent AS "userAgent", created_at AS "createdAt", expires_at AS "expiresAt" FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC'),
      activity: await q('SELECT action, outcome, ip, created_at AS "at", metadata FROM audit_events WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 1000'),
    };
    await audit(req, 'account.export', 'success', id);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="lightning-vm-${new Date().toISOString().slice(0, 10)}.json"`);
    reply.header('cache-control', 'no-store');
    return JSON.stringify(data, null, 2);
  }
}
