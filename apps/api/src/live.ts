// A live line from the API to each open panel tab (Server-Sent Events at GET /live): when an account changes
// (banned, password changed, sessions revoked, roles or permissions edited) its tabs learn at once instead of on
// their next request, and new notifications ring the bell without waiting for the poll. Changes are announced on
// Redis, so every API copy reaches the tabs connected to it. The server re-reads the session before telling a tab
// anything: a tab whose session is gone is told to sign out and the stream ends.
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { currentSession, SessionGuard, type AuthedRequest } from './auth';
import { listen, type LiveKind } from './live-bus';
import { holdOnline } from './presence';

// Why a tab was signed out, for the sign-in page.
const reasonOf = (kind: LiveKind) => (kind === 'ban' ? 'banned' : kind === 'password' ? 'password' : kind === 'removed' ? 'removed' : 'revoked');

@Controller('live') @UseGuards(SessionGuard)
export class LiveController {
  @Get()
  stream(@Req() req: AuthedRequest, @Res() reply: FastifyReply) {
    const res = reply.raw;
    reply.hijack();
    // no-transform and X-Accel-Buffering keep proxies from holding events back.
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 5000\n\n');
    send('ready', { userId: req.user.id });
    let busy = Promise.resolve();
    const stop = listen((m) => {
      if (m.userId !== null && m.userId !== req.user.id) return;
      // In order, one at a time: a ban followed by an unban must not be read the other way round.
      busy = busy.then(async () => {
        if (m.kind === 'notification') { send('notification', {}); return; }
        const s = await currentSession(req).catch(() => null);
        if (!s) { send('signed-out', { reason: reasonOf(m.kind) }); end(); return; }
        send('changed', { kind: m.kind });
      });
    });
    // While this line is open the person (and this session) counts as online.
    const here = holdOnline(req.user.id, req.sessionId);
    const beat = setInterval(() => { res.write(': ping\n\n'); void here(); }, 25_000);
    const end = () => { clearInterval(beat); stop(); if (!res.writableEnded) res.end(); };
    req.raw.on('close', end);
  }
}
