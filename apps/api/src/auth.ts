import { CanActivate, Controller, ExecutionContext, Get, Injectable, Req, UseGuards } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { getAuth } from './better-auth';
import { captchaEnabled, config, mailEnabled } from './config';
import { pool } from './db';
import { apiError } from './errors';

export type User = { id: string; email: string; role: 'admin' | 'user'; locale: 'tr' | 'en' };
// sessionToken: better-auth's stored token; the console gateway keys its revocations on its hash.
export type AuthedRequest = FastifyRequest & { user: User; sessionToken: string };

export async function audit(req: FastifyRequest, action: string, outcome: 'success' | 'failure' | 'denied', actorId: string | null, metadata: object = {}) {
  await pool.query('INSERT INTO audit_events (actor_id, action, outcome, request_id, ip, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [actorId, action, outcome, req.id, req.ip, metadata]);
}

// Validation runs on the server whatever the browser checked. Field codes are translated by the web UI.
export function readCredentials(body: unknown) {
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'INVALID_EMAIL';
  if (typeof password !== 'string' || password.length < 12) fields.password = 'PASSWORD_TOO_SHORT';
  else if (password.length > 256) fields.password = 'PASSWORD_TOO_LONG';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { email: (email as string).trim().toLowerCase(), password: password as string };
}

// The signed-in user from better-auth's session cookie (always read from the database: revocation is immediate).
export async function currentSession(req: FastifyRequest): Promise<{ user: User; token: string } | null> {
  const s = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!s) return null;
  const u = s.user as typeof s.user & { role?: string; locale?: string; disabledAt?: Date | null; banned?: boolean | null };
  if (u.disabledAt || u.banned) return null;
  return { user: { id: u.id, email: u.email, role: u.role === 'admin' ? 'admin' : 'user', locale: u.locale === 'tr' ? 'tr' : 'en' }, token: s.session.token };
}
export const currentUser = async (req: FastifyRequest) => (await currentSession(req))?.user ?? null;

@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = await currentSession(req);
    if (!s) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    req.user = s.user; req.sessionToken = s.token;
    return true;
  }
}

@Injectable()
export class AdminGuard extends SessionGuard {
  async canActivate(ctx: ExecutionContext) {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.user.role === 'admin') return true;
    await audit(req, 'admin.access', 'denied', req.user.id, { path: req.routeOptions.url });
    throw apiError(403, 'FORBIDDEN', 'Admin role required');
  }
}

// Sign-in, sign-up, sign-out and the rest are better-auth's routes under /auth/* (registered in main.ts).
@Controller('auth')
export class AuthController {
  @Get('me') @UseGuards(SessionGuard)
  me(@Req() req: AuthedRequest) { return req.user; }
}

// What the sign-in page may offer; no secrets.
@Controller('public')
export class PublicController {
  @Get('config')
  publicConfig() {
    return { passwordReset: mailEnabled(), turnstileSiteKey: captchaEnabled() ? config.TURNSTILE_SITE_KEY : null };
  }
}
