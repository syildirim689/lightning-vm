import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { pool, redis } from './db';
import { apiError } from './errors';
import { AdminGuard, audit, sessionCookie, type AuthedRequest } from './auth';
import { newToken, sha256 } from './security';
import { callAdapter, storedTarget } from './vmware';

// The browser gets only this one-time cookie, scoped to the gateway path. The VMware ticket goes
// to Redis for the console gateway and never appears in a response, URL or log.
const consoleCookie = 'lvm_console';
const sessionSeconds = 60;
type Ticket = { url: string; sha1?: string; sha256?: string[]; certPem?: string; vmName: string };

const authHash = (req: AuthedRequest) => sha256(req.cookies[sessionCookie] ?? '').toString('hex');

// Live consoles of a signed-out or disabled user are closed by the gateway.
export async function revokeConsoles(revocation: { authHash?: string; userId?: string; sessionKey?: string; all?: boolean }) {
  await redis.publish('console:revoke', JSON.stringify(revocation)).catch(() => undefined);
}

export async function openConsole(req: AuthedRequest, reply: FastifyReply, connectionId: string, vm: string, ownedServer = false) {
  if (!/^[\w-]{1,80}$/.test(vm)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { vm: 'INVALID_VALUE' });
  const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [connectionId]);
  if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
  if (!c.operations?.console) throw apiError(409, 'CONSOLE_NOT_PERMITTED', 'The service account lacks the console privilege');
  // Admin route: any VM of a connection. Customer route (ownedServer): the caller already proved ownership.
  if (!ownedServer && req.user.role !== 'admin') throw apiError(403, 'FORBIDDEN', 'Admin role required');
  let ticket: Ticket;
  try { ticket = await callAdapter<Ticket>('/v1/console-ticket', { ...storedTarget(c), vm }, 30_000); }
  catch (err) {
    const code = (err as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'VMWARE_ERROR';
    await audit(req, 'console.session_issued', 'failure', req.user.id, { connectionId, vm, code });
    throw err;
  }
  const token = newToken();
  const key = sha256(token).toString('hex');
  await redis.set(`console:session:${key}`, JSON.stringify({
    url: ticket.url, sha1: ticket.sha1 ?? '', sha256: ticket.sha256 ?? [], certPem: ticket.certPem ?? '',
    userId: req.user.id, authHash: authHash(req), vm, vmName: ticket.vmName, connectionId,
  }), 'EX', sessionSeconds, 'NX');
  reply.setCookie(consoleCookie, token, { path: '/console/ws', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https', maxAge: sessionSeconds });
  await audit(req, 'console.session_issued', 'success', req.user.id, { connectionId, vm, vmName: ticket.vmName });
  return { vmName: ticket.vmName, expiresInSeconds: sessionSeconds, path: '/console/ws' };
}

@Controller('admin') @UseGuards(AdminGuard)
export class ConsoleController {
  // Admins may open the console of any VM in a connected inventory. Customer consoles (own servers
  // only) arrive with servers and ownership in the provisioning phase.
  @Post('vmware/connections/:id/vms/:vm/console') @HttpCode(201)
  open(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param('id', ParseUUIDPipe) id: string, @Param('vm') vm: string) {
    return openConsole(req, reply, id, vm);
  }

  @Get('console/sessions')
  async sessions() {
    const active = await redis.hgetall('console:active');
    const entries = Object.entries(active).map(([key, v]) => ({ key, ...JSON.parse(v) }));
    const { rows } = await pool.query('SELECT id, email FROM users WHERE id = ANY($1)', [entries.map((e) => e.userId)]);
    const email = new Map(rows.map((r) => [r.id, r.email]));
    return { sessions: entries.map((e) => ({ ...e, email: email.get(e.userId) ?? null })) };
  }

  @Post('console/sessions/:key/revoke') @HttpCode(204)
  async revoke(@Req() req: AuthedRequest, @Param('key') key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { key: 'INVALID_VALUE' });
    await revokeConsoles({ sessionKey: key });
    await audit(req, 'console.revoked', 'success', req.user.id, { sessionKey: key });
  }
}
