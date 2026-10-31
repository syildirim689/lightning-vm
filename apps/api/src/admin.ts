import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { can, ensureRoles, limitsOf } from './permissions';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { assertCovers, Can, PermissionGuard } from './rbac';
import { endSession, onlineUsers, sessionsOf, statusOf } from './presence';
import { publishLive } from './live-bus';
import { notify } from './notify';
import { agentStatus, hostInfo, pendingRequests, queueRequest, releases, runLog, settings as maintenanceSettings, summary } from './maintenance';
import { readHostChange } from './host-rules';
import { reloadAuth } from './better-auth';

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

  // This server's own settings: what the agent last recorded, and the agent's state.
  @Get('host') @Can('system.view')
  host() {
    const status = agentStatus();
    // serverTime: this machine's clock now (the API shares it), to compare with the viewer's.
    return { host: hostInfo(), serverTime: Date.now(), agent: { installed: maintenanceSettings().agent === 'on', pending: Math.max(0, pendingRequests()), status: status?.action === 'host' ? status : null,
      log: status?.action === 'host' ? runLog(status.id) : [] } };
  }

  // Changes the server's name, time zone, time servers or DNS servers through the host agent (it checks again).
  // Without changes it only refreshes the recorded details.
  @Post('host') @HttpCode(202) @Can('system.update')
  async changeHost(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const { change, fields } = readHostChange(body ?? {});
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if (maintenanceSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed (sudo sh scripts/install.sh agent on)');
    const status = agentStatus();
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    if (pendingRequests() > 0 || running) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    const id = queueRequest({ action: 'host', ...change, by: req.user.id });
    await audit(req, 'system.host', 'success', req.user.id, { id, ...change });
    return { id };
  }

  @Get('users') @Can('users.view', 'catalog.manage')
  async users(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT u.id, u.email, u.name, coalesce(u.role, 'user') AS role, u.locale, u.disabled_at, u.created_at AS "createdAt",
      coalesce(u.banned, false) AS banned, u.ban_reason AS "banReason", u.ban_expires AS "banExpires", u.two_factor_enabled AS "twoFactorEnabled", u.auth_source AS "authSource",
      u.last_login_method AS "lastLoginMethod", u.phone_number AS "phoneNumber", u.phone_number_verified AS "phoneNumberVerified",
      (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id AND s.state <> 'deleted') AS servers,
      (SELECT count(*)::int FROM auth_sessions a WHERE a.user_id = u.id AND a.expires_at > now()) AS sessions,
      coalesce(u.last_seen_at, (SELECT max(coalesce(a.last_active_at, a.created_at)) FROM auth_sessions a WHERE a.user_id = u.id)) AS "lastSeen",
      (SELECT count(*)::int FROM user_permission_overrides o WHERE o.user_id = u.id) AS overrides,
      (SELECT count(*)::int FROM staff_notes n WHERE n.user_id = u.id) AS notes,
      (SELECT n.body FROM staff_notes n WHERE n.user_id = u.id AND n.pinned ORDER BY n.created_at DESC LIMIT 1) AS "pinnedNote"
      FROM users u ORDER BY u.created_at`);
    // Notes are for people who may see users (this list is also open to catalog managers for owner pickers).
    if (!can(req.user.permissions, 'users.view')) for (const r of rows) { r.notes = 0; r.pinnedNote = null; }
    // Online now (a panel tab open), recently active or offline.
    const online = await onlineUsers(rows.map((r) => r.id));
    return { users: rows.map((r) => ({ ...r, presence: statusOf(online.has(r.id), r.lastSeen) })) };
  }

  // A person's sessions: device, addresses, start, last activity, end, and whether a tab has it open now.
  @Get('users/:id/sessions') @Can('users.view')
  async userSessions(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [u] } = await pool.query('SELECT id, last_seen_at AS "lastSeen" FROM users WHERE id = $1', [id]);
    if (!u) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    const sessions = await sessionsOf(id);
    const online = sessions.some((s) => s.online);
    return { presence: statusOf(online, u.lastSeen), lastSeen: u.lastSeen, sessions };
  }

  // Ends one session of a person whose permissions are within the caller's; their tab learns at once.
  @Delete('users/:id/sessions/:sid') @HttpCode(204) @Can('users.sessions')
  async endUserSession(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('sid') sid: string) {
    await assertCovers(req, id);
    if (!/^[\w-]{1,64}$/.test(sid) || !(await endSession(id, sid))) throw apiError(404, 'NOT_FOUND', 'Unknown session');
    await audit(req, 'admin.user.revoke_session', 'success', req.user.id, { target: id, session: sid });
    await publishLive(id, 'sessions');
  }

  // One action for many people (the users list as filtered, up to 200): end all their sessions, or send them a message
  // through their notification channels. The caller and people with permissions beyond the caller's are skipped.
  @Post('users/actions') @Can('users.sessions', 'users.manage')
  async bulk(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = (body ?? {}) as { action?: unknown; userIds?: unknown; subject?: unknown; message?: unknown };
    const ids = Array.isArray(b.userIds) ? [...new Set(b.userIds)] : [];
    const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    const fields: Record<string, string> = {};
    if (b.action !== 'end_sessions' && b.action !== 'message') fields.action = 'INVALID_VALUE';
    if (!ids.length || ids.length > 200 || !ids.every((x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x))) fields.userIds = 'INVALID_VALUE';
    if (b.action === 'message') {
      if (!subject || subject.length > 120) fields.subject = subject ? 'TOO_LONG' : 'REQUIRED';
      if (!message || message.length > 2000) fields.message = message ? 'TOO_LONG' : 'REQUIRED';
    }
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if (!can(req.user.permissions, b.action === 'message' ? 'users.manage' : 'users.sessions')) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const { rows: found } = await pool.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) AND id <> $2', [ids, req.user.id]);
    const targets: string[] = [];
    for (const { id } of found) await assertCovers(req, id).then(() => targets.push(id), () => undefined);
    if (b.action === 'message') {
      // {name} and {email} make it personal: one message each then (a name not given falls back to the e-mail).
      if (targets.length && /\{(name|email)\}/.test(subject + message)) {
        const { rows: people } = await pool.query('SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])', [targets]);
        for (const u of people) {
          const fill = (s: string) => s.replace(/\{name\}/g, u.name?.trim() || u.email).replace(/\{email\}/g, u.email);
          await notify('account.message', [u.id], { subject: fill(subject).slice(0, 120), message: fill(message) });
        }
      } else if (targets.length) await notify('account.message', targets, { subject, message });
    } else {
      const { rows } = await pool.query('SELECT id, user_id FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [targets]);
      for (const s of rows) await endSession(s.user_id, s.id);
      for (const id of targets) await publishLive(id, 'sessions');
    }
    await audit(req, `admin.users.${b.action}`, 'success', req.user.id, { count: targets.length, skipped: ids.length - targets.length, ...(b.action === 'message' && { subject }) });
    return { done: targets.length, skipped: ids.length - targets.length };
  }

  // Staff notes on a person, pinned first: who wrote what and when. The person never sees them.
  @Get('users/:id/notes') @Can('users.view')
  async notes(@Param('id', ParseUUIDPipe) id: string) {
    const { rows } = await pool.query(`SELECT n.id, n.body, n.pinned, n.created_at AS "createdAt", n.author_id AS "authorId", a.name AS "authorName", a.email AS "authorEmail"
      FROM staff_notes n LEFT JOIN users a ON a.id = n.author_id WHERE n.user_id = $1 ORDER BY n.pinned DESC, n.created_at DESC LIMIT 100`, [id]);
    return { notes: rows };
  }

  @Post('users/:id/notes') @HttpCode(201) @Can('users.manage')
  async addNote(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = (body ?? {}) as { body?: unknown; pinned?: unknown };
    const text = typeof b.body === 'string' ? b.body.trim() : '';
    if (!text || text.length > 2000) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { body: text ? 'TOO_LONG' : 'REQUIRED' });
    const { rows: [n] } = await pool.query(`INSERT INTO staff_notes (user_id, author_id, body, pinned) SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM users WHERE id = $1) RETURNING id`,
      [id, req.user.id, text, b.pinned === true]);
    if (!n) throw apiError(404, 'NOT_FOUND', 'Unknown user');
    await audit(req, 'admin.user.note_added', 'success', req.user.id, { target: id, note: n.id });
    return { id: n.id };
  }

  @Patch('users/:id/notes/:nid') @HttpCode(204) @Can('users.manage')
  async pinNote(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('nid', ParseUUIDPipe) nid: string, @Body() body: unknown) {
    const pinned = (body as { pinned?: unknown })?.pinned;
    if (typeof pinned !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { pinned: 'INVALID_VALUE' });
    const r = await pool.query('UPDATE staff_notes SET pinned = $3 WHERE id = $2 AND user_id = $1', [id, nid, pinned]);
    if (!r.rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown note');
    await audit(req, 'admin.user.note_pinned', 'success', req.user.id, { target: id, note: nid, pinned });
  }

  @Delete('users/:id/notes/:nid') @HttpCode(204) @Can('users.manage')
  async removeNote(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('nid', ParseUUIDPipe) nid: string) {
    const r = await pool.query('DELETE FROM staff_notes WHERE id = $2 AND user_id = $1', [id, nid]);
    if (!r.rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown note');
    await audit(req, 'admin.user.note_removed', 'success', req.user.id, { target: id, note: nid });
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
    await reloadAuth(); // social sign-up follows registration

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
