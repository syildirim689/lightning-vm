// The administrators' browser terminal to this host (services/console, "terminal" mode). Off by default: the
// panel turns the service on and off through the host agent. Opening needs system.terminal and two-factor on the
// account (not while impersonating); the browser gets a one-time cookie for /terminal/ws, valid 60 s. The
// gateway audits opening and closing (terminal.*) and drops the shell on sign-out or a revocation.
import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { audit, type AuthedRequest } from './auth';
import { revokeConsoles } from './console';
import { pool, redis } from './db';
import { apiError } from './errors';
import { agentStatus, pendingRequests, queueRequest, settings as hostSettings } from './maintenance';
import { Can, PermissionGuard } from './rbac';
import { newToken, rateLimit, sha256 } from './security';

const cookie = 'lvm_terminal';
const sessionSeconds = 60;

// While the service is off its name does not resolve and the lookup hangs: a short timeout, and the status page
// reuses an answer for 10 s (opening always asks again).
let last = { at: 0, up: false };
async function serviceUp(fresh = false) {
  if (!fresh && Date.now() - last.at < 10_000) return last.up;
  let up = false;
  try { up = (await fetch('http://terminal:8080/healthz', { signal: AbortSignal.timeout(800) })).ok; } catch { up = false; }
  last = { at: Date.now(), up };
  return up;
}
function mayOpen(req: AuthedRequest) {
  // A shell on the host belongs to a signed-in browser (two-factor, revoked with its session), never to an API token.
  if (req.sessionId.startsWith('token:')) throw apiError(403, 'TOKEN_NOT_ALLOWED', 'Open the terminal from the panel');
  if (req.user.impersonatedBy) throw apiError(403, 'TERMINAL_IMPERSONATED', 'Not while acting as another user');
  if (!req.user.twoFactorEnabled) throw apiError(403, 'TERMINAL_NEEDS_2FA', 'Turn on two-factor sign-in first');
}

@Controller('admin/terminal') @UseGuards(PermissionGuard)
export class TerminalController {
  @Get() @Can('system.terminal')
  async status(@Req() req: AuthedRequest) {
    const active = await redis.hgetall('terminal:active').catch(() => ({}));
    const entries = Object.entries(active).map(([key, v]) => ({ key, ...JSON.parse(v) as { userId: string; startedAt: string } }));
    const { rows } = await pool.query('SELECT id, email FROM users WHERE id = ANY($1)', [entries.map((e) => e.userId)]);
    const email = new Map(rows.map((r) => [r.id, r.email]));
    const st = agentStatus();
    return { enabled: await serviceUp(), agent: hostSettings().agent === 'on', twoFactor: req.user.twoFactorEnabled,
      switching: pendingRequests() > 0 || (st?.action === 'terminal' && st.state === 'running'),
      sessions: entries.map((e) => ({ key: e.key, email: email.get(e.userId) ?? null, startedAt: e.startedAt })) };
  }

  // Turns the terminal service on or off on the host (install.sh terminal on|off through the agent).
  @Post('switch') @HttpCode(202) @Can('system.terminal')
  async switch(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    mayOpen(req);
    const enabled = body?.enabled === true;
    if (hostSettings().agent !== 'on' || pendingRequests() < 0) throw apiError(409, 'MAINTENANCE_AGENT_MISSING', 'The host agent is not installed');
    const st = agentStatus();
    if (pendingRequests() > 0 || (st?.state === 'running' && Date.now() - Date.parse(st.startedAt) < 3 * 3600_000)) throw apiError(409, 'MAINTENANCE_BUSY', 'Another maintenance task is queued or running');
    const id = queueRequest({ action: 'terminal', switch: enabled ? 'on' : 'off', by: req.user.id });
    await audit(req, 'terminal.switched', 'success', req.user.id, { id, enabled });
    return { id };
  }

  @Post('session') @HttpCode(201) @Can('system.terminal')
  async open(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    mayOpen(req);
    await rateLimit(`terminal:${req.user.id}`, 20, 600);
    if (!(await serviceUp(true))) throw apiError(409, 'TERMINAL_OFF', 'The terminal is turned off');
    const token = newToken();
    await redis.set(`terminal:session:${sha256(token).toString('hex')}`, JSON.stringify({
      userId: req.user.id, authHash: sha256(req.sessionToken).toString('hex'), vm: 'host', vmName: 'host' }), 'EX', sessionSeconds, 'NX');
    reply.setCookie(cookie, token, { path: '/terminal/ws', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https', maxAge: sessionSeconds });
    await audit(req, 'terminal.session_issued', 'success', req.user.id);
    return { path: '/terminal/ws', expiresInSeconds: sessionSeconds };
  }

  @Post('sessions/:key/revoke') @HttpCode(204) @Can('system.terminal')
  async revoke(@Req() req: AuthedRequest, @Param('key') key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { key: 'INVALID_VALUE' });
    await revokeConsoles({ sessionKey: key });
    await audit(req, 'terminal.revoked', 'success', req.user.id, { sessionKey: key });
  }
}
