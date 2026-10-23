import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db';
import { apiError } from './errors';
import { dummyHash, hashPassword, newToken, rateLimit, sha256, verifyPassword } from './security';

export type User = { id: string; email: string; role: 'admin' | 'user'; locale: 'tr' | 'en' };
export type AuthedRequest = FastifyRequest & { user: User };

export const sessionCookie = 'lvm_session';
const sessionHours = Number(process.env.SESSION_TTL_HOURS) || 12;

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
  return { email: (email as string).trim(), password: password as string };
}

export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = newToken();
  await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)",
    [sha256(token), userId, sessionHours, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
  reply.setCookie(sessionCookie, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: sessionHours * 3600 });
}

export async function currentUser(req: FastifyRequest): Promise<User | null> {
  const token = req.cookies[sessionCookie];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.locale FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`, [sha256(token)]);
  return rows[0] ?? null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = await currentUser(req);
    if (!user) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    req.user = user;
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

@Controller('auth')
export class AuthController {
  @Post('login') @HttpCode(200)
  async login(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    const { email, password } = readCredentials(body);
    await rateLimit(`login:ip:${req.ip}`, 30, 900);
    await rateLimit(`login:email:${email.toLowerCase()}`, 10, 900);
    const { rows: [user] } = await pool.query('SELECT id, email, role, locale, password_hash, disabled_at FROM users WHERE lower(email) = lower($1)', [email]);
    const ok = await verifyPassword(password, user?.password_hash ?? await dummyHash);
    if (!user || !ok || user.disabled_at) {
      await audit(req, 'auth.login', 'failure', user?.id ?? null, { email: email.toLowerCase() });
      throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    await startSession(req, reply, user.id);
    await audit(req, 'auth.login', 'success', user.id);
    return { id: user.id, email: user.email, role: user.role, locale: user.locale };
  }

  @Post('register') @HttpCode(201)
  async register(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    const { rows: [setting] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
    if (setting?.value !== true) throw apiError(403, 'REGISTRATION_CLOSED', 'Registration is closed');
    const { email, password } = readCredentials(body);
    await rateLimit(`register:ip:${req.ip}`, 5, 3600);
    const locale = (body as { locale?: string }).locale === 'tr' ? 'tr' : 'en';
    const hash = await hashPassword(password);
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (email, password_hash, role, locale) VALUES ($1, $2, 'user', $3) ON CONFLICT DO NOTHING RETURNING id, email, role, locale",
      [email, hash, locale]);
    if (!user) throw apiError(409, 'EMAIL_TAKEN', 'Email already registered');
    await startSession(req, reply, user.id);
    await audit(req, 'auth.register', 'success', user.id);
    return user;
  }

  @Post('logout') @HttpCode(204) @UseGuards(SessionGuard)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(req.cookies[sessionCookie]!)]);
    reply.clearCookie(sessionCookie, { path: '/' });
    await audit(req, 'auth.logout', 'success', req.user.id);
  }

  @Get('me') @UseGuards(SessionGuard)
  me(@Req() req: AuthedRequest) { return req.user; }
}
