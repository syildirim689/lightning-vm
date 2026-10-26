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
  if (s.startTls && s.url.startsWith('ldap:')) await c.startTLS(tls);
  await c.bind(dn, password);
  return c;
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
