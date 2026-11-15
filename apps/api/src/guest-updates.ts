// Operating system updates inside a customer's server. The panel cannot look into a server by itself, so a small
// reporter runs there (guest-updates-script.ts, installed with one command from the server's page). It posts what
// waits every ten minutes and is answered with the server's policy and, once, the action its owner asked for.
import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { guestScript } from './guest-updates-script';
import { notify } from './notify';
import { findServer } from './servers';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const policies = ['notify', 'security', 'all'];
const actions = ['security', 'upgrade', 'reboot'];
// Silent for this long: the reporter was removed, or the server is off or cannot reach the panel.
const STALE_MS = 45 * 60_000;
type Row = { server_id: string; policy: string; auto_reboot: boolean; reboot_hour: number; pending_action: string | null; action_at: Date | null; reported_at: Date | null; os: string | null;
  manager: string | null; total: number; security: number; reboot_required: boolean; packages: unknown; last_run: unknown; token_hash: string; notified_security_at: Date | null; notified_reboot_at: Date | null };
const row = async (id: string) => (await pool.query<Row>('SELECT * FROM server_updates WHERE server_id = $1', [id])).rows[0];
const view = (u: Row | undefined) => (!u ? { enabled: false } : { enabled: true, reported: !!u.reported_at, reportedAt: u.reported_at, stale: !!u.reported_at && Date.now() - u.reported_at.getTime() > STALE_MS,
  policy: u.policy, autoReboot: u.auto_reboot, rebootHour: u.reboot_hour, pendingAction: u.pending_action, actionAt: u.action_at, os: u.os, manager: u.manager, total: u.total, security: u.security,
  rebootRequired: u.reboot_required, packages: u.packages, lastRun: u.last_run });

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
    await findServer(req, id, true);
    const token = randomBytes(24).toString('base64url');
    await pool.query(`INSERT INTO server_updates (server_id, token_hash) VALUES ($1, $2) ON CONFLICT (server_id) DO UPDATE SET token_hash = $2`, [id, hash(token)]);
    await audit(req, 'server.updates_enabled', 'success', req.user.id, { serverId: id });
    // The reporter answers to the address the panel is reached at.
    const origin = typeof req.headers.origin === 'string' && /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(req.headers.origin) ? req.headers.origin : `${req.protocol}://${req.headers.host}`;
    return { command: `curl -fsSL ${origin}/api/guest/updates.sh | sudo sh -s -- ${origin} ${id} ${token}`, ...view(await row(id)) };
  }

  @Put()
  async change(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    const u = await row(id);
    if (!u) throw apiError(409, 'INVALID_SERVER_STATE', 'Update tracking is off for this server');
    const fields: Record<string, string> = {};
    const policy = body?.policy === undefined ? u.policy : String(body.policy);
    const autoReboot = body?.autoReboot === undefined ? u.auto_reboot : body.autoReboot === true;
    const hour = body?.rebootHour === undefined ? u.reboot_hour : Number(body.rebootHour);
    if (!policies.includes(policy)) fields.policy = 'INVALID_VALUE';
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) fields.rebootHour = 'INVALID_VALUE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await pool.query('UPDATE server_updates SET policy = $2, auto_reboot = $3, reboot_hour = $4 WHERE server_id = $1', [id, policy, autoReboot, hour]);
    await audit(req, 'server.updates_policy', 'success', req.user.id, { serverId: id, policy, autoReboot, rebootHour: hour });
    return view(await row(id));
  }

  // One action waits per server; the reporter picks it up on its next run (within about ten minutes).
  @Post('actions') @HttpCode(202)
  async act(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    const action = String(body?.action ?? '');
    if (!actions.includes(action)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const u = await row(id);
    if (!u?.reported_at || Date.now() - u.reported_at.getTime() > STALE_MS) throw apiError(409, 'INVALID_SERVER_STATE', 'The update reporter in this server is not answering');
    await pool.query('UPDATE server_updates SET pending_action = $2, action_at = now() WHERE server_id = $1', [id, action]);
    await audit(req, 'server.updates_action', 'success', req.user.id, { serverId: id, action });
    return view(await row(id));
  }

  // Turns tracking off: the record goes, and the reporter removes itself from the server on its next run.
  @Delete() @HttpCode(204)
  async disable(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id, true);
    await pool.query('DELETE FROM server_updates WHERE server_id = $1', [id]);
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
    await pool.query(`UPDATE server_updates SET reported_at = now(), os = $2, manager = $3, total = $4, security = $5, reboot_required = $6, packages = $7,
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
