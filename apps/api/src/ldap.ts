// Sign-in against a directory (Active Directory, OpenLDAP, FreeIPA...). A service account finds the person by
// e-mail, then their own password is checked by binding as them; groups decide their roles. The panel never
// stores directory passwords in clear: better-auth keeps its own hash, refreshed at each directory sign-in.
import { Client, type ClientOptions } from 'ldapts';
import type { LdapSettings } from './settings-store';

export type LdapUser = { dn: string; email: string; name: string; groups: string[] };
export type LdapResult = { ok: true; user: LdapUser } | { ok: false; code: string; detail?: string };

// RFC 4515: a value placed in a filter cannot change the filter.
export const escapeFilter = (v: string) => v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
export const userFilter = (template: string, email: string) => template.split('{email}').join(escapeFilter(email));

function client(s: LdapSettings) {
  const tls = { minVersion: 'TLSv1.2' as const, ...(s.caPem.trim() && { ca: [s.caPem] }) };
  const opts: ClientOptions = { url: s.url, timeout: 10_000, connectTimeout: 10_000, ...(s.url.startsWith('ldaps:') && { tlsOptions: tls }) };
  return { c: new Client(opts), tls };
}
async function open(s: LdapSettings, dn: string, password: string) {
  const { c, tls } = client(s);
  try {
    if (s.startTls && s.url.startsWith('ldap:')) await c.startTLS(tls);
    await c.bind(dn, password);
    return c;
  } catch (err) {
    // A failed bind (wrong password, unreachable server) must not leave its connection open.
    await c.unbind().catch(() => undefined);
    throw err;
  }
}
const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? '' : String(v));
const many = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);
function code(err: unknown) {
  const name = (err as { name?: string; code?: string })?.name ?? '';
  if (name === 'InvalidCredentialsError') return 'LDAP_AUTH_FAILED';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(String((err as Error)?.message ?? '') + ((err as { code?: string })?.code ?? ''))) return 'LDAP_UNREACHABLE';
  if (/certificate|self.signed|TLS/i.test(String((err as Error)?.message))) return 'LDAP_TLS_FAILED';
  return 'LDAP_FAILED';
}

// Finds one person by e-mail with the service account.
async function find(s: LdapSettings, bindPassword: string, email: string): Promise<LdapUser | { error: string; detail?: string }> {
  let c: Client | null = null;
  try {
    c = await open(s, s.bindDn, bindPassword);
    const { searchEntries } = await c.search(s.baseDn, { scope: 'sub', filter: userFilter(s.userFilter, email), sizeLimit: 2,
      attributes: [s.emailAttribute, s.nameAttribute, s.groupAttribute].filter(Boolean) });
    if (searchEntries.length !== 1) return { error: searchEntries.length ? 'LDAP_AMBIGUOUS' : 'LDAP_USER_NOT_FOUND' };
    const e = searchEntries[0];
    return { dn: e.dn, email: (first(e[s.emailAttribute]) || email).toLowerCase(), name: first(e[s.nameAttribute]), groups: many(e[s.groupAttribute]) };
  } catch (err) {
    return { error: code(err) === 'LDAP_AUTH_FAILED' ? 'LDAP_BIND_FAILED' : code(err), detail: String((err as Error)?.message ?? '').slice(0, 200) };
  } finally { await c?.unbind().catch(() => undefined); }
}

// The same lookup without anybody's password, for asking whether a directory account is still there
// (directory-signin.ts, reconfirmDirectory).
export const ldapLookup = (s: LdapSettings, bindPassword: string, email: string) => find(s, bindPassword, email);

export async function ldapAuthenticate(s: LdapSettings, bindPassword: string, email: string, password: string): Promise<LdapResult> {
  // An empty password is an "unauthenticated bind", which many servers accept: never a sign-in.
  if (!password) return { ok: false, code: 'LDAP_AUTH_FAILED' };
  const found = await find(s, bindPassword, email);
  if ('error' in found) return { ok: false, code: found.error, detail: found.detail };
  let c: Client | null = null;
  try {
    c = await open(s, found.dn, password);
    return { ok: true, user: found };
  } catch (err) {
    return { ok: false, code: code(err), detail: String((err as Error)?.message ?? '').slice(0, 200) };
  } finally { await c?.unbind().catch(() => undefined); }
}

// The settings page's test: the service account binds and searches; with a person's credentials, they sign in too.
export async function ldapTest(s: LdapSettings, bindPassword: string, email?: string, password?: string) {
  if (email && password) return ldapAuthenticate(s, bindPassword, email, password);
  if (email) {
    const found = await find(s, bindPassword, email);
    return 'error' in found ? { ok: false as const, code: found.error, detail: found.detail } : { ok: true as const, user: found };
  }
  let c: Client | null = null;
  try { c = await open(s, s.bindDn, bindPassword); return { ok: true as const }; }
  catch (err) { return { ok: false as const, code: code(err) === 'LDAP_AUTH_FAILED' ? 'LDAP_BIND_FAILED' : code(err), detail: String((err as Error)?.message ?? '').slice(0, 200) }; }
  finally { await c?.unbind().catch(() => undefined); }
}

// Roles from groups: every mapping whose group the person is in (DNs compared case-insensitively), else the default.
export function rolesFromGroups(s: Pick<LdapSettings, 'groupRoles' | 'defaultRole'>, groups: string[]) {
  const mine = new Set(groups.map((g) => g.toLowerCase().replace(/\s*,\s*/g, ',')));
  const roles = s.groupRoles.filter((m) => mine.has(m.group.toLowerCase().replace(/\s*,\s*/g, ','))).flatMap((m) => m.roles);
  return roles.length ? [...new Set(roles)] : [s.defaultRole];
}

// A mapping without one role (the role was removed): a group left with no role goes, a default that named it is
// "user" again. Otherwise a role made later under the same key would be handed out by the old mapping.
export function withoutRole<T extends Pick<LdapSettings, 'groupRoles' | 'defaultRole'>>(s: T, key: string): T {
  return { ...s, groupRoles: s.groupRoles.map((g) => ({ ...g, roles: g.roles.filter((r) => r !== key) })).filter((g) => g.roles.length), defaultRole: s.defaultRole === key ? 'user' : s.defaultRole };
}

// Whether an address nobody has an account for may be put to the directory. A directory compares loosely (RFC 4518:
// soft hyphens, zero-width and variation characters count for nothing, every kind of space is one space, compatibility
// forms are folded), so one mailbox could be typed in any number of ways, each with a sign-in limit of its own. Only
// the one plain spelling is asked: no spaces, no control or invisible characters, already in its composed form.
export const spelledOnce = (email: string) => email.length > 2 && email.includes('@') && email === email.normalize('NFKC')
  && !/[\p{C}\p{Z}\s͏᠆᠋-᠍︀-️￼]/u.test(email);

// A directory or single sign-on account is signed in by its directory or provider, and the panel is not told when the
// account is closed there. Its session therefore ends a fixed time after it was made, however much it is used (the
// library would keep extending it), so the directory is asked again at least that often.
export const directorySessionOver = (authSource: string | null | undefined, createdAt: Date | string, ttlHours: number, now = Date.now()) =>
  (authSource === 'ldap' || authSource === 'oidc') && now - new Date(createdAt).getTime() > ttlHours * 3_600_000;

// A personal API token outlives every session, and nobody signs in to use it: the token of a directory or single
// sign-on account is accepted only while its source confirmed the account within `days` days (users.source_confirmed_at:
// the last sign-in the directory or the provider accepted, or the last time the directory still listed the account).
// Older than that, or never confirmed, the token is asleep: refused, not removed, and it works again at the person's
// next sign-in. 0 days: no such rule. Panel accounts (their password is the panel's own) are never asleep.
export const tokenAsleep = (authSource: string | null | undefined, confirmedAt: Date | string | null | undefined, days: number, now = Date.now()) =>
  (authSource === 'ldap' || authSource === 'oidc') && days > 0 && (!confirmedAt || now - new Date(confirmedAt).getTime() > days * 86_400_000);
// The same as an SQL value for a token list: the refusal's code while asleep, else NULL. `u`: the users alias; `days`: a parameter.
export const tokenAsleepSql = (u: string, days: string) => `CASE WHEN ${u}.auth_source IN ('ldap', 'oidc') AND ${days}::int > 0
  AND (${u}.source_confirmed_at IS NULL OR ${u}.source_confirmed_at < now() - make_interval(days => ${days}::int)) THEN 'TOKEN_ACCOUNT_UNCONFIRMED' END`;
