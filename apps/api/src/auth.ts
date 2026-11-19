import { CanActivate, Controller, ExecutionContext, Get, Injectable, Req, SetMetadata, UseGuards } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { countRequest } from './api-rate';
import { getAuth } from './better-auth';
import { config } from './config';
import { pool } from './db';
import { directorySessionOver, tokenAsleep } from './ldap';
import { apiError } from './errors';
import { can, covers, customerLevel, limitsOf, permissionsOf, permissionsOfMany, splitRoles } from './permissions';
import { ipAllowed, narrowedTokenMay } from './role-limits';
import { getSettings } from './settings-store';
import { endSession, touch } from './presence';

// roles: the role keys; permissions: the effective set ('*' for administrators). impersonatedBy: the staff
// member signed in as this user, if any.
// timeZone: the person's chosen zone, or null for their browser's.
export type User = { id: string; email: string; name: string; roles: string[]; permissions: string[]; locale: 'tr' | 'en'; timeZone: string | null; username: string | null; twoFactorRequired?: boolean;
  impersonatedBy: string | null; twoFactorEnabled: boolean; phoneNumber: string | null; phoneNumberVerified: boolean };
// sessionToken: better-auth's stored token; the console gateway keys its revocations on its hash. sessionId: its row.
export type AuthedRequest = FastifyRequest & { user: User; sessionToken: string; sessionId: string };

// Audit details often repeat request input, and the audit log is kept: no single text in them is longer than this.
const auditTextMax = 1000;
export function capped(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > auditTextMax ? v.slice(0, auditTextMax) : v;
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => capped(x, depth + 1));
  // Plain objects only: a Date (or anything else with its own JSON form) is stored as it is.
  return Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capped(x, depth + 1)])) : v;
}

// An event somebody recorded for another account (metadata.forOwner, with actingAs 'reseller' when it was that
// account's reseller) is shown in that account's own activity (audit-log.ts). Those two fields are therefore never
// taken from a caller's metadata, which often repeats request input: they are written only from actingFor() (a key no
// request body can carry) or from what findServer noted on the request (actedOn).
const ACTED = Symbol('lvm.actedFor');
type Acted = { forOwner: string; actingAs?: 'reseller' };
export const actingFor = (forOwner: string, actingAs?: 'reseller'): object => ({ [ACTED]: { forOwner, ...(actingAs && { actingAs }) } });
// findServer (servers.ts) answered for a server that is not the caller's and not through a staff permission: the
// caller is the owner's reseller. Whatever this request audits about that server is the owner's to see as well:
// opening the console, a schedule, labels, a disk, an image made from it, not only the operations.
export function actedOn(req: FastifyRequest, serverId: string, ownerId: string) {
  const r = req as FastifyRequest & { actedOn?: Map<string, string> };
  (r.actedOn ??= new Map()).set(serverId, ownerId);
}
export function auditMetadata(req: FastifyRequest, metadata: object): Record<string, unknown> {
  const { forOwner: _f, actingAs: _a, ...plain } = metadata as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars
  let mark = (metadata as Record<symbol, Acted | undefined>)[ACTED];
  const noted = (req as { actedOn?: Map<string, string> }).actedOn;
  if (!mark && noted?.size) {
    // The event names the server, or the request touched exactly one such server and the event names none.
    const serverId = typeof plain.serverId === 'string' ? plain.serverId : plain.serverId === undefined && noted.size === 1 ? [...noted.keys()][0] : null;
    const owner = serverId ? noted.get(serverId) : undefined;
    if (owner) { mark = { forOwner: owner, actingAs: 'reseller' }; plain.serverId = serverId; }
  }
  return { ...(capped(plain) as Record<string, unknown>), ...mark };
}

export async function audit(req: FastifyRequest, action: string, outcome: 'success' | 'failure' | 'denied', actorId: string | null, metadata: object = {}) {
  await pool.query('INSERT INTO audit_events (actor_id, action, outcome, request_id, ip, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [actorId, action, outcome, req.id, req.ip, auditMetadata(req, metadata)]);
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
// A personal API token (developer.ts) acts as its owner: their permissions, their role's address rules; read-only
// tokens only read. It is never a browser session (no cookie is involved).
async function tokenSession(req: FastifyRequest, token: string): Promise<{ user: User; token: string; id: string } | null> {
  const { rows: [t] } = await pool.query(`UPDATE api_tokens a SET last_used_at = now(), last_used_ip = $2::inet FROM users u
      WHERE a.token_hash = $1 AND u.id = a.user_id AND (a.expires_at IS NULL OR a.expires_at > now()) AND NOT coalesce(u.banned, false) AND u.disabled_at IS NULL
      RETURNING a.id, a.name AS token_name, a.scope, a.permissions AS token_permissions, a.allowed_ips, u.id AS user_id, u.email, u.name, u.role, u.locale, u.time_zone, u.username, u.two_factor_enabled, u.phone_number, u.phone_number_verified,
        u.auth_source, u.source_confirmed_at`,
  [createHash('sha256').update(token).digest('hex'), req.ip]).catch(() => ({ rows: [] }));
  if (!t) return null;
  // A directory or single sign-on account: the panel is not told when the person leaves, and a token needs no
  // sign-in. It is accepted only while the account's source confirmed it within DIRECTORY_TOKEN_DAYS (ldap.ts,
  // tokenAsleep); a directory with a service account is asked again here (directory-signin.ts, reconfirmDirectory):
  // before a token that sleeps is refused, and in the background once the confirmation is a day old.
  const days = config.DIRECTORY_TOKEN_DAYS;
  if (days > 0 && (t.auth_source === 'ldap' || t.auth_source === 'oidc')) {
    let asleep = tokenAsleep(t.auth_source, t.source_confirmed_at, days);
    if (t.auth_source === 'ldap' && (asleep || Date.now() - new Date(t.source_confirmed_at).getTime() > 86_400_000)) {
      const asked = import('./directory-signin').then((d) => d.reconfirmDirectory(t.user_id, t.email)).catch(() => 'unknown' as const);
      if (asleep) asleep = (await asked) !== 'found';
    }
    if (asleep) throw apiError(401, 'TOKEN_ACCOUNT_UNCONFIRMED', 'This account comes from a directory or single sign-on and was not confirmed there recently; sign in to the panel again to use its API tokens');
  }
  if (!ipAllowed(limitsOf(t.role ?? null).allowedIps, req.ip)) return null;
  // The administrator's addresses for all tokens (Settings → API) and the token's own.
  const api = await getSettings('api');
  if (!ipAllowed(api.networks, req.ip) || !ipAllowed(t.allowed_ips, req.ip)) throw apiError(403, 'TOKEN_ADDRESS_NOT_ALLOWED', 'This API token may not be used from this address');
  (req as FastifyRequest & { apiToken?: { id: string; name: string; narrowed: boolean } }).apiToken = { id: t.id, name: t.token_name, narrowed: !!t.token_permissions };
  await countRequest(req, t.id, api.rateLimit);
  if (t.scope === 'read' && !['GET', 'HEAD'].includes(req.method)) throw apiError(403, 'TOKEN_READ_ONLY', 'This API token can only read');
  // A narrowed token has only those of its owner's permissions it was given.
  const own = await permissionsOf(t.user_id, t.role ?? null);
  const permissions = t.token_permissions ? (own.includes('*') ? t.token_permissions : own.filter((p: string) => t.token_permissions.includes(p))) : own;
  return { user: { id: t.user_id, email: t.email, name: t.name ?? '', roles: splitRoles(t.role), permissions,
    locale: t.locale === 'tr' ? 'tr' : 'en', timeZone: t.time_zone ?? null, username: t.username ?? null, impersonatedBy: null, twoFactorEnabled: !!t.two_factor_enabled,
    twoFactorRequired: false, phoneNumber: t.phone_number ?? null, phoneNumberVerified: !!t.phone_number_verified }, token: '', id: `token:${t.id}` };
}

// Whether the staff member behind an impersonation session may still act as this person: the account exists, is not
// banned or disabled, and holds users.impersonate over the person's permissions (what starting it requires). A yes is
// kept for a few seconds; the session is also ended where that access is taken away (better-auth.ts endImpersonations).
const stillMay = new Map<string, number>();
async function impersonatorMay(by: string, userId: string, target: string[]) {
  const key = `${by}:${userId}`;
  if ((stillMay.get(key) ?? 0) > Date.now()) return true;
  const [staff] = /^[0-9a-f-]{36}$/i.test(by) ? await permissionsOfMany([by]).catch(() => []) : [];
  const ok = !!staff && can(staff.permissions, 'users.impersonate') && covers(staff.permissions, target);
  if (!ok) { stillMay.delete(key); return false; }
  if (stillMay.size > 5000) stillMay.clear();
  stillMay.set(key, Date.now() + 5000);
  return true;
}

export async function currentSession(req: FastifyRequest): Promise<{ user: User; token: string; id: string } | null> {
  const bearer = req.headers.cookie ? null : /^Bearer (lvm_[\w-]{20,100})$/.exec(req.headers.authorization ?? '')?.[1];
  if (bearer) return tokenSession(req, bearer);
  const s = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!s) return null;
  const u = s.user as typeof s.user & { role?: string; locale?: string; disabledAt?: Date | null; banned?: boolean | null; twoFactorEnabled?: boolean;
    phoneNumber?: string | null; phoneNumberVerified?: boolean };
  if (u.disabledAt || u.banned) return null;
  const impersonatedBy = (s.session as { impersonatedBy?: string | null }).impersonatedBy ?? null;
  const permissions = await permissionsOf(u.id, u.role ?? null);
  // Staff signed in as this person: for an hour from its start (whatever the browser sends; the library would let
  // it slide to the normal length), and only while that staff member could still start it.
  if (impersonatedBy && (Date.now() - new Date(s.session.createdAt).getTime() > 3_600_000 || !(await impersonatorMay(impersonatedBy, u.id, permissions)))) {
    await endSession(u.id, s.session.id).catch(() => undefined);
    return null;
  }
  // A directory or single sign-on account: the session ends SESSION_TTL_HOURS after it was made, used or not, so the
  // directory or provider is asked again at least that often (ldap.ts; a session started by staff has its own hour).
  if (!impersonatedBy && directorySessionOver((u as { authSource?: string }).authSource, s.session.createdAt, config.SESSION_TTL_HOURS)) {
    await endSession(u.id, s.session.id).catch(() => undefined);
    return null;
  }
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
  const twoFactorRequired = !u.twoFactorEnabled && !impersonatedBy && !['oidc', 'social'].includes((u as { authSource?: string }).authSource ?? '') && (policy === 'all' || (policy === 'staff' && staff) || !!limits.require2fa);
  return { user: { id: u.id, email: u.email, name: u.name ?? '', roles: splitRoles(u.role), permissions,
    locale: u.locale === 'tr' ? 'tr' : 'en', timeZone: (u as { timeZone?: string | null }).timeZone ?? null, username: (u as { username?: string | null }).username ?? null, impersonatedBy, twoFactorEnabled: !!u.twoFactorEnabled, twoFactorRequired, phoneNumber: u.phoneNumber ?? null,
    phoneNumberVerified: !!u.phoneNumberVerified }, token: s.session.token, id: s.session.id };
}
export const currentUser = async (req: FastifyRequest) => (await currentSession(req))?.user ?? null;

// The permission a route names (@Can, rbac.ts) and the mark for routes any API token may call (@TokenOpen): read here
// for narrowed tokens, and by PermissionGuard for staff routes.
export const PERMISSION = 'lvm:permission';
export const TOKEN_OPEN = 'lvm:token-open';
export const TokenOpen = () => SetMetadata(TOKEN_OPEN, true);

@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = await currentSession(req);
    if (!s) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    req.user = s.user; req.sessionToken = s.token; req.sessionId = s.id;
    // A narrowed token, on every route behind this guard (role-limits.ts has the rule).
    if ((req as { apiToken?: { narrowed?: boolean } }).apiToken?.narrowed) {
      const handler = ctx.getHandler();
      const need = Reflect.getMetadata(PERMISSION, handler) as string[] | undefined;
      if (!narrowedTokenMay(req.method, need, Reflect.getMetadata(TOKEN_OPEN, handler) === true, s.user.permissions)) {
        throw apiError(403, 'FORBIDDEN', 'This API token was not given a permission for this', undefined, { need: need ?? [] });
      }
    }
    if (!s.id.startsWith('token:')) void touch(s.id, s.user.id, req.ip);
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
  me(@Req() req: AuthedRequest) { return { ...req.user, ip: req.ip }; } // ip: the firewall editor's "my IP" shortcut
}

