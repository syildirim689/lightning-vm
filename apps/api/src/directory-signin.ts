// Directory sign-in (no HTTP here; the settings page is directory.ts), wired into better-auth's e-mail sign-in (better-auth.ts) so two-factor, sessions, rate limits
// and the audit stay the same for everyone. Before better-auth checks the password: if the account comes from the
// directory (or does not exist yet and the admin lets the directory create it), the directory decides; on success
// the account's name and roles follow the directory and better-auth's password hash is replaced with this one,
// so better-auth then accepts it. A wrong directory password is refused even if an older hash would match.
import { APIError } from 'better-auth/api';
import { getAuth } from './better-auth';
import { pool } from './db';
import { ldapAuthenticate, rolesFromGroups } from './ldap';
import { publishLive } from './live-bus';
import { logEvent } from './log';
import { ensureRoles, roles } from './permissions';
import { decryptSecret } from './secrets';
import { getSettings, type LdapSettings } from './settings-store';

export type Input = Record<string, unknown>;
export const secretCtx = 'settings:ldap';
export const bindPassword = (s: LdapSettings) => (s.bindPasswordEnc ? decryptSecret(s.bindPasswordEnc, secretCtx) : '');
const refused = () => new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });

// better-auth's middleware context, as far as it is used here.
type Ctx = { request?: object; context: { internalAdapter: { createUser: (u: object) => Promise<{ id: string }>; linkAccount: (a: object) => Promise<unknown>; updatePassword: (id: string, hash: string) => Promise<unknown>;
  findCredentialAccount: (id: string) => Promise<unknown> }; password: { hash: (p: string) => Promise<string> } } };

// The requests in which the directory accepted the password: only these may end in a session for a directory account
// (better-auth.ts checks it where sessions are made, so no other route gets one from the cached hash).
export const directoryAccepted = new WeakSet<object>();

export async function directorySignIn(ctx: unknown, body: Input) {
  if (typeof body.email !== 'string' || typeof body.password !== 'string') return;
  const s = (await getSettings('directory')).ldap;
  const email = body.email.trim().toLowerCase();
  const { rows: [u] } = await pool.query('SELECT id, role, auth_source FROM users WHERE lower(email) = $1', [email]);
  if (u && u.auth_source !== 'ldap') return;            // panel accounts keep their own password
  // Directory sign-in was turned off: its accounts have nowhere to prove a password (the cached hash is not one).
  if (!s.enabled) { if (u) throw refused(); return; }
  if (!u && !s.autoCreate) return;                      // better-auth answers "wrong e-mail or password"
  const r = await ldapAuthenticate(s, bindPassword(s), email, body.password);
  if (!r.ok) {
    if (r.code !== 'LDAP_AUTH_FAILED' && r.code !== 'LDAP_USER_NOT_FOUND') logEvent('error', 'ldap_failed', { code: r.code, detail: r.detail });
    if (u) throw refused();
    return;
  }
  await ensureRoles();
  const wanted = rolesFromGroups(s, r.user.groups).filter((k) => roles.has(k));
  const role = (wanted.length ? wanted : ['user']).join(',');
  const { context: c, request } = ctx as Ctx;
  if (request) directoryAccepted.add(request);
  const hash = await c.password.hash(body.password);
  if (!u) {
    const created = await c.internalAdapter.createUser({ email, name: r.user.name || email, emailVerified: true, role });
    await c.internalAdapter.linkAccount({ userId: created.id, providerId: 'credential', accountId: created.id, password: hash });
    await pool.query("UPDATE users SET auth_source = 'ldap', external_id = $2 WHERE id = $1", [created.id, r.user.dn]);
    await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'auth.directory_user_created', 'success', $2)", [created.id, { dn: r.user.dn, role }]);
    return;
  }
  // Roles follow the directory only when groups are mapped; otherwise the panel's roles stay.
  const nextRole = s.groupRoles.length ? role : u.role;
  await pool.query('UPDATE users SET name = coalesce(nullif($2, \'\'), name), role = $3, external_id = $4, updated_at = now() WHERE id = $1', [u.id, r.user.name, nextRole, r.user.dn]);
  if (await c.internalAdapter.findCredentialAccount(u.id)) await c.internalAdapter.updatePassword(u.id, hash);
  else await c.internalAdapter.linkAccount({ userId: u.id, providerId: 'credential', accountId: u.id, password: hash });
  if (nextRole !== u.role) await publishLive(u.id, 'access');
}

// The directory (or the single sign-on provider) owns these passwords: they are not changed or reset in the panel.
const passwordPaths = new Set(['/change-password', '/request-password-reset', '/admin/set-user-password']);
export async function refuseForDirectory(path: string, headers: Headers, body: Input) {
  if (!passwordPaths.has(path)) return;
  let sql = '', arg: string | undefined;
  if (path === '/request-password-reset' && typeof body.email === 'string') { sql = 'SELECT auth_source FROM users WHERE lower(email) = lower($1)'; arg = body.email; }
  else if (path === '/admin/set-user-password' && typeof body.userId === 'string') { sql = 'SELECT auth_source FROM users WHERE id = $1'; arg = body.userId; }
  else if (path === '/change-password') {
    const session = await getAuth().api.getSession({ headers }).catch(() => null);
    if (session) { sql = 'SELECT auth_source FROM users WHERE id = $1'; arg = session.user.id; }
  }
  if (!sql) return;
  const { rows: [u] } = await pool.query(sql, [arg]).catch(() => ({ rows: [] }));
  // A reset request for a directory account gets the same answer as any other (no account enumeration): it just sends nothing.
  if (u?.auth_source === 'ldap' || u?.auth_source === 'oidc') {
    if (path === '/request-password-reset') throw new APIError('OK', { code: 'OK', message: 'If the account exists, an e-mail was sent' });
    throw new APIError('BAD_REQUEST', { code: 'PASSWORD_MANAGED_BY_DIRECTORY', message: 'This password is managed in the directory' });
  }
}

