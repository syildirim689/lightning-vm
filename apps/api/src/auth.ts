import { CanActivate, Controller, ExecutionContext, Get, Injectable, Req, UseGuards } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { getAuth } from './better-auth';
import { pool } from './db';
import { apiError } from './errors';
import { customerLevel, limitsOf, permissionsOf, splitRoles } from './permissions';
import { ipAllowed } from './role-limits';
import { getSettings } from './settings-store';

// roles: the role keys; permissions: the effective set ('*' for administrators). impersonatedBy: the staff
// member signed in as this user, if any.
// timeZone: the person's chosen zone, or null for their browser's.
export type User = { id: string; email: string; name: string; roles: string[]; permissions: string[]; locale: 'tr' | 'en'; timeZone: string | null; twoFactorRequired?: boolean;
  impersonatedBy: string | null; twoFactorEnabled: boolean; phoneNumber: string | null; phoneNumberVerified: boolean };
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
  const u = s.user as typeof s.user & { role?: string; locale?: string; disabledAt?: Date | null; banned?: boolean | null; twoFactorEnabled?: boolean;
    phoneNumber?: string | null; phoneNumberVerified?: boolean };
  if (u.disabledAt || u.banned) return null;
  const impersonatedBy = (s.session as { impersonatedBy?: string | null }).impersonatedBy ?? null;
  const permissions = await permissionsOf(u.id, u.role ?? null);
  // The role's sign-in rules: only from its addresses, and a session ends after its length (it is removed).
  const limits = limitsOf(u.role ?? null);
  if (!ipAllowed(limits.allowedIps, req.ip)) return null;
  if (limits.sessionHours && Date.now() - new Date(s.session.createdAt).getTime() > limits.sessionHours * 3_600_000) {
    await pool.query('DELETE FROM auth_sessions WHERE token = $1', [s.session.token]).catch(() => undefined);
    return null;
  }
  // The admin's sign-in policy: without two-factor, such an account may only set it up (impersonation is exempt).
  const policy = (await getSettings('security')).require2fa;
  // Customer permissions (their own servers and firewalls) do not make anyone staff.
  const staff = permissions.some((p) => !customerLevel(p));
  // Single sign-on accounts have no panel password: their provider does the second factor.
  const twoFactorRequired = !u.twoFactorEnabled && !impersonatedBy && (u as { authSource?: string }).authSource !== 'oidc' && (policy === 'all' || (policy === 'staff' && staff) || !!limits.require2fa);
  return { user: { id: u.id, email: u.email, name: u.name ?? '', roles: splitRoles(u.role), permissions,
    locale: u.locale === 'tr' ? 'tr' : 'en', timeZone: (u as { timeZone?: string | null }).timeZone ?? null, impersonatedBy, twoFactorEnabled: !!u.twoFactorEnabled, twoFactorRequired, phoneNumber: u.phoneNumber ?? null,
    phoneNumberVerified: !!u.phoneNumberVerified }, token: s.session.token };
}
export const currentUser = async (req: FastifyRequest) => (await currentSession(req))?.user ?? null;

@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = await currentSession(req);
    if (!s) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    req.user = s.user; req.sessionToken = s.token;
    // Two-factor required but not set up: only "who am I" answers (the panel then shows the setup; better-auth's
    // own routes for it are not behind this guard).
    if (s.user.twoFactorRequired && req.routeOptions.url !== '/auth/me') throw apiError(403, 'TWO_FACTOR_SETUP_REQUIRED', 'Set up two-factor authentication first');
    return true;
  }
}

// Sign-in, sign-up, sign-out and the rest are better-auth's routes under /auth/* (registered in main.ts).
@Controller('auth')
export class AuthController {
  @Get('me') @UseGuards(SessionGuard)
  me(@Req() req: AuthedRequest) { return req.user; }
}

