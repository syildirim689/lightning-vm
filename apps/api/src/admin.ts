import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ensureRoles, limitsOf } from './permissions';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { agentStatus, pendingRequests, queueRequest, releases, runLog, settings as maintenanceSettings, summary } from './maintenance';

@Controller('admin') @UseGuards(PermissionGuard)
export class AdminController {
  @Get('system') @Can('system.view', 'dashboard.view')
  async system() {
    const rows = await pool.query("SELECT name, last_seen, last_seen > now() - interval '90 seconds' AS healthy FROM worker_heartbeats")
      .then((r) => r.rows, () => { throw apiError(503, 'DEPENDENCY_UNAVAILABLE', 'Dependencies unavailable'); });
    return { worker: rows };
  }

  @Get('maintenance') @Can('system.view', 'dashboard.view')
  maintenance() {
    const status = agentStatus();
    return { ...summary(), releases: releases(),
      agent: { installed: maintenanceSettings().agent === 'on', pending: Math.max(0, pendingRequests()), status, log: status ? runLog(status.id) : [] } };
  }

  // Asks the host agent to check for updates, update, back up or change the automatic-update settings.
  // One request at a time; the agent validates everything again before running scripts/install.sh.
  @Post('maintenance/requests') @HttpCode(202) @Can('system.update')
  async request(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const action = String(body?.action ?? '');
    const fields: Record<string, string> = {};
    const out: Record<string, string> = { action };
    if (!['check', 'update', 'backup', 'auto-update'].includes(action)) fields.action = 'INVALID_VALUE';
    if (action === 'update' && body?.to) {
      if (/^(v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?|[0-9a-f]{7,40})$/.test(String(body.to))) out.to = String(body.to); else fields.to = 'INVALID_VALUE';
    }
    if (action === 'auto-update') {
      out.switch = body?.enabled === true ? 'on' : 'off';
      if (body?.channel !== undefined) { if (['stable', 'beta', 'edge'].includes(String(body.channel))) out.channel = String(body.channel); else fields.channel = 'INVALID_VALUE'; }
      if (body?.window !== undefined) { if (/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(String(body.window))) out.window = String(body.window); else fields.window = 'INVALID_WINDOW'; }
    }
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if (maintenanceSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed (sudo sh scripts/install.sh agent on)');
    const status = agentStatus();
    // A run older than three hours is treated as dead (the agent's own limit), not as busy.
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    if (pendingRequests() > 0 || running) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    const id = queueRequest({ ...out, by: req.user.id });
    await audit(req, 'maintenance.request', 'success', req.user.id, { id, ...out });
    return { id };
  }

  @Get('users') @Can('users.view', 'catalog.manage')
  async users() {
    const { rows } = await pool.query(`SELECT u.id, u.email, u.name, coalesce(u.role, 'user') AS role, u.locale, u.disabled_at, u.created_at AS "createdAt",
      coalesce(u.banned, false) AS banned, u.ban_reason AS "banReason", u.ban_expires AS "banExpires", u.two_factor_enabled AS "twoFactorEnabled", u.auth_source AS "authSource",
      u.last_login_method AS "lastLoginMethod", u.phone_number AS "phoneNumber", u.phone_number_verified AS "phoneNumberVerified",
      (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS servers,
      (SELECT count(*)::int FROM auth_sessions a WHERE a.user_id = u.id AND a.expires_at > now()) AS sessions,
      (SELECT max(a.created_at) FROM auth_sessions a WHERE a.user_id = u.id) AS "lastSeen",
      (SELECT count(*)::int FROM user_permission_overrides o WHERE o.user_id = u.id) AS overrides
      FROM users u ORDER BY u.created_at`);
    return { users: rows };
  }

  @Get('settings') @Can('settings.view', 'settings.manage')
  async settings() {
    const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
    return { registrationOpen: s?.value === true };
  }

  @Put('settings') @Can('settings.manage')
  async updateSettings(@Req() req: AuthedRequest, @Body() body: unknown) {
    const open = (body as { registrationOpen?: unknown })?.registrationOpen;
    if (typeof open !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { registrationOpen: 'INVALID_VALUE' });
    await pool.query("UPDATE settings SET value = $1, updated_at = now() WHERE key = 'registration_open'", [JSON.stringify(open)]);
    await audit(req, 'settings.registration_open', 'success', req.user.id, { value: open });
    return { registrationOpen: open };
  }
}

// One person at a glance for staff: their servers and what they cost, sessions, recent activity, budget and the
// limits their roles put on them.
@Controller('admin') @UseGuards(PermissionGuard)
export class UserSummaryController {
  @Get('users/:id/summary') @Can('users.view')
  async summary(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [u] } = await pool.query(`SELECT id, email, name, coalesce(role, 'user') AS role, locale, created_at AS "createdAt", two_factor_enabled AS "twoFactorEnabled",
      coalesce(banned, false) AS banned, auth_source AS "authSource", budget_monthly::float8 AS "budgetMonthly", budget_currency AS "budgetCurrency" FROM users WHERE id = $1`, [id]);
    if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    const [servers, spend, sessions, activity] = await Promise.all([
      pool.query(`SELECT id, name, state, power_state AS "powerState", vcpu, memory_mb AS "memoryMb", disk_gb AS "diskGb", price_monthly::float8 AS price, trim(currency) AS currency, locked
        FROM servers WHERE owner_id = $1 AND state <> 'deleted' ORDER BY created_at DESC LIMIT 50`, [id]),
      pool.query(`SELECT trim(currency) AS currency, sum(price_monthly)::float8 AS monthly FROM (
          SELECT currency, price_monthly FROM servers WHERE owner_id = $1 AND state <> 'deleted'
          UNION ALL SELECT currency, price_monthly FROM vdcs WHERE owner_id = $1 AND active) x GROUP BY 1 ORDER BY 1`, [id]),
      pool.query(`SELECT count(*) FILTER (WHERE expires_at > now())::int AS active, max(created_at) AS "lastSeen" FROM auth_sessions WHERE user_id = $1`, [id]),
      pool.query(`SELECT action, outcome, created_at AS at FROM audit_events WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 12`, [id]),
    ]);
    await ensureRoles();
    return { user: u, servers: servers.rows, spend: spend.rows, sessions: sessions.rows[0], activity: activity.rows, limits: limitsOf(u.role) };
  }
}
