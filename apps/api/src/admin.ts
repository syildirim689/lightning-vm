import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { can, ensureRoles, limitsOf } from './permissions';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { assertAdmin, assertCovers, Can, PermissionGuard } from './rbac';
import { maskSecrets } from './log';
import { endSession, onlineUsers, sessionsOf, statusOf } from './presence';
import { publishLive } from './live-bus';
import { dropPush, notify } from './notify';
import { uptime } from 'node:os';
import { agentStatus, bootId, hostInfo, osInfo, pendingRequests, queueRequest, releases, runLog, runSetUp, settings as maintenanceSettings, summary } from './maintenance';
import { readHostChange } from './host-rules';
import { monitoringChecks } from './checks';
import { hostLive, hostLog, hostState, logSources, serviceDetail } from './host-live';
import { checkServiceRequest, SERVICE_NAME } from './host-services';
import { endImpersonations, reloadAuth } from './better-auth';

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
    const list = releases();
    // stale: the list was written for another version than the one running now (an update from the command line
    // up to 0.5.1 did not rewrite it): the page says so and offers the check.
    return { ...summary(), releases: list && { ...list, stale: !!list.current && list.current !== (process.env.APP_VERSION || 'dev') },
      agent: { installed: maintenanceSettings().agent === 'on', pending: Math.max(0, pendingRequests()), status, log: status ? runLog(status.id) : [] } };
  }

  // The monitoring components (Prometheus, Grafana, Loki; Alertmanager starts and stops with them) as they answer
  // now, and whether the host agent is switching them. state: 'on' when all answer, 'off' when none does, 'partial'
  // otherwise (starting, stopping, or one of them down). Turning them on or off is a maintenance request below.
  @Get('maintenance/monitoring') @Can('system.view', 'dashboard.view')
  async monitoring() {
    const checks = await monitoringChecks();
    const up = checks.filter((c) => c.ok).length;
    const status = agentStatus();
    const mine = status?.action === 'monitoring' ? status : null;
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    return { state: up === checks.length ? 'on' : up === 0 ? 'off' : 'partial', checks,
      agent: { installed: maintenanceSettings().agent === 'on', pending: Math.max(0, pendingRequests()), busy: pendingRequests() > 0 || running, status: mine, log: mine ? runLog(mine.id, 20) : [] } };
  }

  // Asks the host agent to check for updates, update, back up, change the automatic-update settings, turn the
  // monitoring components on or off (install.sh monitoring on|off, as the setup wizard asks for it), or restart one
  // service of the stack / run a one-shot job again (install.sh service restart|run <name>; host-services.ts says
  // which services may be). One request at a time; the agent validates everything again before running scripts/install.sh.
  @Post('maintenance/requests') @HttpCode(202) @Can('system.update')
  async request(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const action = String(body?.action ?? '');
    const fields: Record<string, string> = {};
    const out: Record<string, string> = { action };
    if (!['check', 'update', 'backup', 'auto-update', 'monitoring', 'service'].includes(action)) fields.action = 'INVALID_VALUE';
    // A service by name: only one in the agent's last snapshot of the compose file, and only what the rules allow.
    if (action === 'service') {
      const c = checkServiceRequest(hostState()?.services ?? null, body?.service, body?.act);
      if (!c.ok) throw apiError(c.status, c.code, c.code === 'VALIDATION_FAILED' ? 'Invalid input' : 'This service cannot be restarted from the panel', c.fields);
      out.service = c.service; out.act = c.act;
    }
    // On or off must be said: a missing or mistyped value does not quietly turn monitoring (and its alerts) off.
    if (action === 'monitoring') { if (typeof body?.enabled === 'boolean') out.switch = body.enabled ? 'on' : 'off'; else fields.enabled = 'INVALID_VALUE'; }
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
    // suggested: the window is the one the panel proposed from the usage history (maintenance-hours.ts); the record says so.
    await audit(req, 'maintenance.request', 'success', req.user.id, { id, ...out, ...(action === 'auto-update' && body?.suggested === true && { suggested: true }) });
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

  // The server's state now: processor, memory, load and disk (sampled here every five seconds), the panel's own
  // processes, and the agent's last snapshot of services, file systems and processes.
  @Get('host/live') @Can('system.view')
  async hostLive(@Req() req: AuthedRequest) {
    const status = agentStatus();
    // logs: the list the page offers to read; only administrators read logs (below), so only they get a list.
    return { ...(await hostLive()), ...(!req.user.permissions.includes('*') && { logs: [] }),
      agent: { installed: maintenanceSettings().agent === 'on', busy: pendingRequests() > 0 || status?.state === 'running' } };
  }

  // Asks the agent for a fresh snapshot (services, file systems, processes, logs). It changes nothing on the server.
  @Post('host/state') @HttpCode(202) @Can('system.view')
  refreshState(@Req() req: AuthedRequest) {
    if (maintenanceSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed (sudo sh scripts/install.sh agent on)');
    const status = agentStatus();
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    if (pendingRequests() > 0 || running) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    return { id: queueRequest({ action: 'state', by: req.user.id }) };
  }

  // The last lines of one service's log, or of the system journal (warnings and worse), from the agent's snapshot.
  // Raw service logs (the proxy's access log among them) are for administrators: system.update alone does not read
  // them. What a URL carried as a secret is masked as well (log.ts), for lines written before the API masked its own.
  @Get('host/logs') @Can('system.update')
  async hostLogs(@Req() req: AuthedRequest, @Query('source') source?: string, @Query('lines') lines?: string) {
    await assertAdmin(req);
    const n = Math.min(300, Math.max(10, Number(lines) || 200));
    const found = hostLog(String(source ?? ''), n);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Unknown log');
    return { source, lines: found.map(maskSecrets), sources: logSources() };
  }

  // One service of the stack in detail: its state, whether that is a fault, version, ports, what may be done to it,
  // the last lines of its log (administrators only, secrets masked here: host-services.ts) and the agent's last
  // restart or run of a service with the end of its log.
  @Get('host/services/:name') @Can('system.view')
  async hostService(@Req() req: AuthedRequest, @Param('name') name: string, @Query('lines') lines?: string) {
    if (!SERVICE_NAME.test(name)) throw apiError(404, 'NOT_FOUND', 'Unknown service');
    const found = await serviceDetail(name);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Unknown service');
    const admin = req.user.permissions.includes('*');
    const n = Math.min(300, Math.max(10, Number(lines) || 200));
    const status = agentStatus();
    const mine = status?.action === 'service' ? status : null;
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    return { ...found, logs: admin ? (hostLog(name, n) ?? []).map(maskSecrets) : null,
      agent: { installed: maintenanceSettings().agent === 'on', busy: pendingRequests() > 0 || running, status: mine, log: mine ? runLog(mine.id, 20).map(maskSecrets) : [] } };
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

  // This server's operating system updates: what waits (and what of it is a security update), whether a restart
  // is needed, and automatic security updates. Recorded by the agent; a restart since then clears "restart needed".
  @Get('os') @Can('system.view')
  os() {
    const status = agentStatus();
    const info = osInfo();
    const boot = bootId();
    const rebooted = !!info && !!boot && !!info.bootId && info.bootId !== boot;
    return { os: info && { ...info, rebootRequired: info.rebootRequired && !rebooted, rebooted }, uptime: Math.round(uptime()),
      agent: { installed: maintenanceSettings().agent === 'on', pending: Math.max(0, pendingRequests()), status: status?.action === 'os' ? status : null, log: status?.action === 'os' ? runLog(status.id) : [],
        setUp: status?.action === 'os' ? runSetUp(status.id) : 0 } };
  }

  // Refreshes the package lists, installs all or only security updates, restarts the server, or switches
  // automatic security updates, through the host agent (it checks the request again).
  @Post('os') @HttpCode(202) @Can('system.update')
  async changeOs(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const act = String(body?.act ?? '');
    if (!['check', 'upgrade', 'security', 'reboot', 'auto-on', 'auto-off'].includes(act)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { act: 'INVALID_VALUE' });
    if (maintenanceSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed (sudo sh scripts/install.sh agent on)');
    const status = agentStatus();
    const running = status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < 3 * 3600_000;
    if (pendingRequests() > 0 || running) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    const id = queueRequest({ action: 'os', act, by: req.user.id });
    await audit(req, 'system.os', 'success', req.user.id, { id, act });
    return { id };
  }

  @Get('users') @Can('users.view', 'catalog.manage', 'billing.manage')
  async users(@Req() req: AuthedRequest, @Query('pick') pick?: string) {
    // Owner pickers (catalog, billing, import) only need who is who; billing staff get the picker and nothing more.
    if (pick) return { users: (await pool.query('SELECT id, email, name FROM users ORDER BY email')).rows };
    if (!can(req.user.permissions, 'users.view') && !can(req.user.permissions, 'catalog.manage')) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const { rows } = await pool.query(`WITH
      srv AS (SELECT owner_id, count(*)::int AS n FROM servers WHERE state <> 'deleted' GROUP BY owner_id),
      ses AS (SELECT user_id, count(*) FILTER (WHERE expires_at > now())::int AS n, max(coalesce(last_active_at, created_at)) AS last FROM auth_sessions GROUP BY user_id),
      ovr AS (SELECT user_id, count(*)::int AS n FROM user_permission_overrides GROUP BY user_id),
      nts AS (SELECT user_id, count(*)::int AS n, (array_agg(body ORDER BY created_at DESC) FILTER (WHERE pinned))[1] AS pinned FROM staff_notes GROUP BY user_id)
      SELECT u.id, u.email, u.name, coalesce(u.role, 'user') AS role, u.locale, u.disabled_at, u.created_at AS "createdAt",
      coalesce(u.banned, false) AS banned, u.ban_reason AS "banReason", u.ban_expires AS "banExpires", u.two_factor_enabled AS "twoFactorEnabled", u.auth_source AS "authSource",
      u.last_login_method AS "lastLoginMethod", u.phone_number AS "phoneNumber", u.phone_number_verified AS "phoneNumberVerified",
      coalesce(srv.n, 0) AS servers, coalesce(ses.n, 0) AS sessions, coalesce(u.last_seen_at, ses.last) AS "lastSeen",
      coalesce(ovr.n, 0) AS overrides, coalesce(nts.n, 0) AS notes, nts.pinned AS "pinnedNote"
      FROM users u LEFT JOIN srv ON srv.owner_id = u.id LEFT JOIN ses ON ses.user_id = u.id LEFT JOIN ovr ON ovr.user_id = u.id LEFT JOIN nts ON nts.user_id = u.id
      ORDER BY u.created_at`);
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
    // Which browser the session was in is not recorded: the account's push subscriptions all go (a browser that is
    // still signed in is asked again in Account → Notifications), and so do sessions this person started as others.
    await dropPush(id);
    await endImpersonations(id);
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
      // With the sessions: the browsers' push subscriptions, and sessions these people started as others.
      for (const id of targets) await dropPush(id);
      await endImpersonations(targets);
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
