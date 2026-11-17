// Operating system updates inside a customer's server. The panel cannot look into a server by itself, so a small
// reporter runs there (guest-updates-script.ts, installed with one command from the server's page). It posts what
// waits every ten minutes and is answered with the server's policy and, once, the action its owner asked for.
import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { panelBase } from './chat-delivery';
import { pool } from './db';
import { apiError } from './errors';
import { guestScript } from './guest-updates-script';
import { notify } from './notify';
import { Can, PermissionGuard } from './rbac';
import { encryptSecret } from './secrets';
import { findServer, ownerWrite } from './servers';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const policies = ['notify', 'security', 'all'];
const actions = ['security', 'upgrade', 'reboot'];
// Silent for this long: the reporter was removed, or the server is off or cannot reach the panel.
const STALE_MS = 45 * 60_000;
type Row = { server_id: string; policy: string; auto_reboot: boolean; reboot_hour: number; pending_action: string | null; action_at: Date | null; reported_at: Date | null; os: string | null;
  manager: string | null; total: number; security: number; reboot_required: boolean; packages: unknown; last_run: unknown; token_hash: string; install_enc: string | null; notified_security_at: Date | null; notified_reboot_at: Date | null };
const row = async (id: string) => (await pool.query<Row>('SELECT * FROM server_updates WHERE server_id = $1', [id])).rows[0];
const view = (u: Row | undefined) => (!u ? { enabled: false } : { enabled: true, auto: !!u.install_enc, reported: !!u.reported_at, reportedAt: u.reported_at, stale: !!u.reported_at && Date.now() - u.reported_at.getTime() > STALE_MS,
  policy: u.policy, autoReboot: u.auto_reboot, rebootHour: u.reboot_hour, pendingAction: u.pending_action, actionAt: u.action_at, os: u.os, manager: u.manager, total: u.total, security: u.security,
  rebootRequired: u.reboot_required, packages: u.packages, lastRun: u.last_run });

const safeOrigin = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/;
// The address the reporter answers to: the panel's public address, else the one this request came through.
export async function reporterOrigin(req: AuthedRequest) {
  const base = (await panelBase())?.replace(/\/+$/, '');
  if (base && safeOrigin.test(base)) return base;
  return typeof req.headers.origin === 'string' && safeOrigin.test(req.headers.origin) ? req.headers.origin : `${req.protocol}://${req.headers.host}`;
}

// A new or reinstalled Linux server installs the reporter by itself on first boot: a fresh token, kept encrypted
// for the worker (it goes into the server's cloud-init) until the first report arrives. An earlier report is
// forgotten (it described the old disk); the owner's policy stays.
export async function prepareGuestUpdates(db: { query: (text: string, values?: unknown[]) => Promise<unknown> }, serverId: string, origin: string) {
  if (!safeOrigin.test(origin)) return false;
  const token = randomBytes(24).toString('base64url');
  await db.query(`INSERT INTO server_updates (server_id, token_hash, install_enc) VALUES ($1, $2, $3) ON CONFLICT (server_id) DO UPDATE SET token_hash = $2, install_enc = $3,
    reported_at = NULL, os = NULL, manager = NULL, total = 0, security = 0, reboot_required = false, packages = '[]', last_run = NULL, pending_action = NULL, action_at = NULL,
    notified_security_at = NULL, notified_reboot_at = NULL`, [serverId, hash(token), encryptSecret(`${origin} ${token}`, 'server-updates-install')]);
  return true;
}

@Controller('servers/:id/updates') @UseGuards(SessionGuard)
export class ServerUpdatesController {
  @Get()
  async get(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id);
    return view(await row(id));
  }

  // Turns update tracking on (or gives a fresh token) and answers with the command to run in the server, once.
  @Post('enable')
  async enable(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    const token = randomBytes(24).toString('base64url');
    // Only while the server is still this owner's (servers.ts ownerWrite): the token is the requester's way to report for it.
    await ownerWrite(s, (db) => db.query(`INSERT INTO server_updates (server_id, token_hash) VALUES ($1, $2) ON CONFLICT (server_id) DO UPDATE SET token_hash = $2, install_enc = NULL`, [id, hash(token)]));
    await audit(req, 'server.updates_enabled', 'success', req.user.id, { serverId: id });
    const origin = await reporterOrigin(req);
    return { command: `curl -fsSL ${origin}/api/guest/updates.sh | sudo sh -s -- ${origin} ${id} ${token}`, ...view(await row(id)) };
  }

  @Put()
  async change(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    const u = await row(id);
    if (!u) throw apiError(409, 'INVALID_SERVER_STATE', 'Update tracking is off for this server');
    const fields: Record<string, string> = {};
    const policy = body?.policy === undefined ? u.policy : String(body.policy);
    const autoReboot = body?.autoReboot === undefined ? u.auto_reboot : body.autoReboot === true;
    const hour = body?.rebootHour === undefined ? u.reboot_hour : Number(body.rebootHour);
    if (!policies.includes(policy)) fields.policy = 'INVALID_VALUE';
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) fields.rebootHour = 'INVALID_VALUE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await ownerWrite(s, (db) => db.query('UPDATE server_updates SET policy = $2, auto_reboot = $3, reboot_hour = $4 WHERE server_id = $1', [id, policy, autoReboot, hour]));
    await audit(req, 'server.updates_policy', 'success', req.user.id, { serverId: id, policy, autoReboot, rebootHour: hour });
    return view(await row(id));
  }

  // One action waits per server; the reporter picks it up on its next run (within about ten minutes).
  @Post('actions') @HttpCode(202)
  async act(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const s = await findServer(req, id, true);
    const action = String(body?.action ?? '');
    if (!actions.includes(action)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const u = await row(id);
    if (!u?.reported_at || Date.now() - u.reported_at.getTime() > STALE_MS) throw apiError(409, 'INVALID_SERVER_STATE', 'The update reporter in this server is not answering');
    await ownerWrite(s, (db) => db.query('UPDATE server_updates SET pending_action = $2, action_at = now() WHERE server_id = $1', [id, action]));
    await audit(req, 'server.updates_action', 'success', req.user.id, { serverId: id, action });
    return view(await row(id));
  }

  // Turns tracking off: the record goes, and the reporter removes itself from the server on its next run.
  @Delete() @HttpCode(204)
  async disable(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    await ownerWrite(s, (db) => db.query('DELETE FROM server_updates WHERE server_id = $1', [id]));
    await audit(req, 'server.updates_disabled', 'success', req.user.id, { serverId: id });
  }
}

const int = (v: unknown, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : 0; };
const word = (v: unknown, len: number, allow = /[^A-Za-z0-9 ._()/:;,=+~-]/g) => (typeof v === 'string' ? v.replace(allow, '').slice(0, len) : '');

// What the reporter calls. No session: the token from the install command is the credential.
@Controller('guest')
export class GuestUpdatesController {
  @Get('updates.sh') @Header('content-type', 'text/plain; charset=utf-8') @Header('cache-control', 'no-store')
  script() { return guestScript; }

  @Post('updates/report') @HttpCode(200)
  async report(@Body() body: Record<string, unknown>) {
    const id = typeof body?.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : '';
    const token = typeof body?.token === 'string' ? body.token : '';
    const { rows: [s] } = id ? await pool.query(`SELECT s.id, s.name, s.owner_id, u.* FROM server_updates u JOIN servers s ON s.id = u.server_id WHERE u.server_id = $1 AND s.state <> 'deleted'`, [id]) : { rows: [] };
    const given = Buffer.from(hash(token)), stored = Buffer.from(s?.token_hash ?? '');
    if (!s || !token || given.length !== stored.length || !timingSafeEqual(given, stored)) throw apiError(404, 'NOT_FOUND', 'Unknown server');
    const u = s as Row & { id: string; name: string; owner_id: string };
    const packages = (Array.isArray(body.packages) ? body.packages : []).slice(0, 100).map((p: Record<string, unknown>) => ({ name: word(p?.name, 100), to: word(p?.to, 80), security: p?.security === true })).filter((p) => p.name);
    const total = int(body.total, 100_000), security = Math.min(int(body.security, 100_000), total), reboot = body.rebootRequired === true;
    const manager = ['apt', 'dnf', 'yum'].includes(String(body.manager)) ? String(body.manager) : 'none';
    // The result of something the reporter just did (asked for here, or by the policy).
    const run = body.run && typeof body.run === 'object' ? (body.run as Record<string, unknown>) : null;
    const done = run && actions.includes(String(run.action)) ? { action: String(run.action), state: run.ok === true ? 'succeeded' : 'failed', auto: run.auto === true, message: word(run.message, 300), at: new Date().toISOString() } : null;
    // A waiting action is handed over once; until its result arrives it shows as running.
    const handed = !done && u.pending_action ? { action: u.pending_action, state: 'running', auto: false, message: '', at: new Date().toISOString() } : null;
    await pool.query(`UPDATE server_updates SET reported_at = now(), install_enc = NULL, os = $2, manager = $3, total = $4, security = $5, reboot_required = $6, packages = $7,
      last_run = coalesce($8, last_run), pending_action = CASE WHEN $9 THEN NULL ELSE pending_action END WHERE server_id = $1`,
      [id, word(body.os, 80), manager, total, security, reboot, JSON.stringify(packages), done || handed ? JSON.stringify(done ?? handed) : null, !!handed]);

    const base = { serverId: id, name: u.name };
    if (done && done.state === 'failed') await notify('server.updates', [u.owner_id], { ...base, kind: 'failed', message: done.message });
    else if (done && done.auto && done.action !== 'reboot') await notify('server.updates', [u.owner_id], { ...base, kind: 'installed', restart: String(reboot) });
    const day = 86_400_000;
    // Waiting security updates the server will not install by itself: once a day. A needed restart nobody scheduled: every three days.
    if (!done && security > 0 && u.policy === 'notify' && (!u.notified_security_at || Date.now() - u.notified_security_at.getTime() > day)) {
      await pool.query('UPDATE server_updates SET notified_security_at = now() WHERE server_id = $1', [id]);
      await notify('server.updates', [u.owner_id], { ...base, kind: 'security', count: String(security) });
    }
    if (reboot && !u.auto_reboot && (!u.notified_reboot_at || Date.now() - u.notified_reboot_at.getTime() > 3 * day)) {
      await pool.query('UPDATE server_updates SET notified_reboot_at = now() WHERE server_id = $1', [id]);
      await notify('server.updates', [u.owner_id], { ...base, kind: 'restart' });
    }
    return { policy: u.policy, autoReboot: u.auto_reboot, rebootHour: u.reboot_hour, action: handed ? handed.action : '' };
  }
}

// Staff: the update state of every Linux server in one list, and security or full updates started on many at once.
@Controller('admin/server-updates') @UseGuards(PermissionGuard)
export class AdminServerUpdatesController {
  @Get() @Can('servers.view_all', 'servers.manage_all')
  async list() {
    const { rows } = await pool.query(`SELECT s.id, s.name, s.state, o.email AS "ownerEmail", i.name AS image, u.server_id IS NOT NULL AS tracked, u.install_enc IS NOT NULL AS auto,
        u.reported_at AS "reportedAt", u.policy, u.auto_reboot AS "autoReboot", u.os, u.manager, coalesce(u.total, 0) AS total, coalesce(u.security, 0) AS security,
        coalesce(u.reboot_required, false) AS "rebootRequired", u.pending_action AS "pendingAction", u.last_run AS "lastRun"
      FROM servers s JOIN users o ON o.id = s.owner_id JOIN os_images i ON i.id = s.image_id LEFT JOIN server_updates u ON u.server_id = s.id
      WHERE s.state NOT IN ('deleted', 'deleting') AND i.family = 'linux' ORDER BY coalesce(u.security, 0) DESC, coalesce(u.total, 0) DESC, s.name LIMIT 5000`);
    return { servers: rows.map((r) => ({ ...r, reported: !!r.reportedAt, stale: !!r.reportedAt && Date.now() - new Date(r.reportedAt).getTime() > STALE_MS })) };
  }

  // Restarts are left to each server's page (and its policy): a restart on many servers at once is rarely meant.
  @Post('actions') @HttpCode(200) @Can('servers.manage_all')
  async act(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const action = String(body?.action ?? '');
    const ids = Array.isArray(body?.serverIds) ? [...new Set(body.serverIds.map(String))] : [];
    const fields: Record<string, string> = {};
    if (!['security', 'upgrade'].includes(action)) fields.action = 'INVALID_VALUE';
    if (!ids.length || ids.length > 500 || ids.some((i) => !/^[0-9a-f-]{36}$/.test(i))) fields.serverIds = 'INVALID_VALUE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    // Only servers whose reporter answers, with nothing waiting or running, and with something to install.
    const { rows } = await pool.query(`UPDATE server_updates u SET pending_action = $2, action_at = now() FROM servers s WHERE s.id = u.server_id AND s.state = 'ready' AND u.server_id = ANY($1::uuid[])
        AND u.reported_at > now() - make_interval(secs => $3) AND u.pending_action IS NULL AND coalesce(u.last_run->>'state', '') <> 'running'
        AND CASE WHEN $2 = 'security' THEN u.security > 0 ELSE u.total > 0 END RETURNING u.server_id`, [ids, action, STALE_MS / 1000]);
    await audit(req, 'server.updates_bulk', 'success', req.user.id, { action, started: rows.length, asked: ids.length });
    return { started: rows.length, skipped: ids.length - rows.length };
  }
}
