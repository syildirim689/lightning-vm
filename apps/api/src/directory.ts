// Settings → Directory: the LDAP connection, its test and the group-to-role mapping. Sign-in itself is directory-signin.ts.
import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, type AuthedRequest } from './auth';
import { bindPassword, secretCtx } from './directory-signin';
import { pool } from './db';
import { apiError } from './errors';
import { ldapTest, rolesFromGroups } from './ldap';
import { ensureRoles, roles } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { encryptSecret } from './secrets';
import { getSettings, saveSettings, type LdapSettings, type OidcSettings } from './settings-store';
import { reloadAuth } from './better-auth';
import { discoveryUrl, ssoSecretCtx } from './sso';

type Input = Record<string, unknown>;

function readGroupRoles(v: unknown) {
  return Array.isArray(v) ? (v as Input[]).map((g) => ({ group: String(g?.group ?? '').trim().slice(0, 500), roles: Array.isArray(g?.roles) ? [...new Set(g.roles.map(String))] : [] }))
    .filter((g) => g.group) : [];
}
const badMapping = (m: { roles: string[] }[]) => m.length > 50 || m.some((g) => !g.roles.length || g.roles.some((r) => !roles.has(r)));

function readOidc(body: Input, saved: OidcSettings): OidcSettings {
  const fields: Record<string, string> = {};
  const str = (k: string, max = 500) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const enabled = body.enabled === true;
  const issuer = str('issuer').replace(/\/+$/, '');
  // https only; plain http is for a provider on this machine (tests, a local Keycloak).
  if ((enabled || issuer) && !/^(https:\/\/[^\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]*)?)$/i.test(issuer)) fields.issuer = 'INVALID_URL';
  const clientId = str('clientId', 300);
  if (enabled && !clientId) fields.clientId = 'REQUIRED';
  const scopes = str('scopes', 300) || saved.scopes;
  if (!scopes.split(/\s+/).includes('openid') || !/^[\w:./ -]+$/.test(scopes)) fields.scopes = 'INVALID_VALUE';
  const groupsClaim = str('groupsClaim', 100) || 'groups';
  if (!/^[\w:./-]+$/.test(groupsClaim)) fields.groupsClaim = 'INVALID_VALUE';
  const groupRoles = readGroupRoles(body.groupRoles);
  if (badMapping(groupRoles)) fields.groupRoles = 'INVALID_VALUE';
  const defaultRole = str('defaultRole', 32) || 'user';
  if (!roles.has(defaultRole)) fields.defaultRole = 'INVALID_VALUE';
  const typed = typeof body.clientSecret === 'string' ? body.clientSecret : '';
  if (typed.length > 500) fields.clientSecret = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { enabled, name: str('name', 40) || 'SSO', issuer, clientId, clientSecretEnc: typed ? encryptSecret(typed, ssoSecretCtx) : saved.clientSecretEnc, scopes, groupsClaim,
    groupRoles, defaultRole, autoCreate: body.autoCreate !== false };
}

function readLdap(body: Input, saved: LdapSettings): { value: LdapSettings; bindPassword: string } {
  const fields: Record<string, string> = {};
  const str = (k: string, max = 500) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const enabled = body.enabled === true;
  const url = str('url');
  if ((enabled || url) && !/^ldaps?:\/\/[^\s/]+(:\d{1,5})?\/?$/i.test(url)) fields.url = 'INVALID_URL';
  const baseDn = str('baseDn'), bindDn = str('bindDn');
  if (enabled && !baseDn) fields.baseDn = 'REQUIRED';
  const userFilter = str('userFilter', 1000) || saved.userFilter;
  if (!userFilter.includes('{email}') || !/^\(.*\)$/.test(userFilter)) fields.userFilter = 'INVALID_VALUE';
  const caPem = typeof body.caPem === 'string' ? body.caPem.trim().slice(0, 20_000) : '';
  if (caPem && !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(caPem)) fields.caPem = 'INVALID_CERTIFICATE';
  const attr = (k: string, d: string) => { const v = str(k, 64) || d; if (!/^[A-Za-z][\w-]*$/.test(v)) fields[k] = 'INVALID_VALUE'; return v; };
  const groupRoles = readGroupRoles(body.groupRoles);
  if (badMapping(groupRoles)) fields.groupRoles = 'INVALID_VALUE';
  const defaultRole = str('defaultRole', 32) || 'user';
  if (!roles.has(defaultRole)) fields.defaultRole = 'INVALID_VALUE';
  const typed = typeof body.bindPassword === 'string' ? body.bindPassword : '';
  if (typed.length > 500) fields.bindPassword = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const bindPasswordEnc = !bindDn ? null : typed ? encryptSecret(typed, secretCtx) : saved.bindPasswordEnc;
  return { value: { enabled, url, startTls: body.startTls === true, caPem, bindDn, bindPasswordEnc, baseDn, userFilter, emailAttribute: attr('emailAttribute', 'mail'),
    nameAttribute: attr('nameAttribute', 'displayName'), groupAttribute: attr('groupAttribute', 'memberOf'), groupRoles, defaultRole, autoCreate: body.autoCreate !== false }, bindPassword: typed || bindPassword(saved) };
}

@Controller('admin/settings/directory') @UseGuards(PermissionGuard)
export class DirectorySettingsController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() {
    const d = await getSettings('directory');
    const { bindPasswordEnc, ...ldap } = d.ldap;
    const { clientSecretEnc, ...oidc } = d.oidc;
    const { rows: [n] } = await pool.query("SELECT count(*) FILTER (WHERE auth_source = 'ldap')::int AS n, count(*) FILTER (WHERE auth_source = 'oidc')::int AS sso FROM users");
    return { ldap: { ...ldap, bindPasswordSet: !!bindPasswordEnc }, oidc: { ...oidc, clientSecretSet: !!clientSecretEnc }, directoryUsers: n.n, ssoUsers: n.sso };
  }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Input) {
    await ensureRoles();
    const { value } = readLdap((body?.ldap ?? {}) as Input, (await getSettings('directory')).ldap);
    await saveSettings('directory', { ...(await getSettings('directory')), ldap: value });
    await audit(req, 'settings.directory', 'success', req.user.id, { enabled: value.enabled, url: value.url, groups: value.groupRoles.length });
    return this.get();
  }

  // Single sign-on: saved, then better-auth is set up again with the new provider (no restart).
  @Put('sso') @Can('settings.manage')
  async saveSso(@Req() req: AuthedRequest, @Body() body: Input) {
    await ensureRoles();
    const d = await getSettings('directory');
    const value = readOidc((body?.oidc ?? {}) as Input, d.oidc);
    await saveSettings('directory', { ...d, oidc: value });
    await reloadAuth();
    await audit(req, 'settings.sso', 'success', req.user.id, { enabled: value.enabled, issuer: value.issuer, groups: value.groupRoles.length });
    return this.get();
  }

  // Reads the provider's discovery document with the issuer in the form: it must name the same issuer.
  @Post('sso/test') @HttpCode(200) @Can('settings.manage')
  async testSso(@Req() req: AuthedRequest, @Body() body: Input) {
    await ensureRoles();
    const value = readOidc({ ...((body?.oidc ?? {}) as Input), enabled: true }, (await getSettings('directory')).oidc);
    const doc = await fetch(discoveryUrl(value.issuer), { signal: AbortSignal.timeout(10_000), redirect: 'error' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .catch((err: Error) => { throw apiError(422, 'SSO_DISCOVERY_FAILED', 'Discovery failed', undefined, { detail: String(err?.message ?? '').slice(0, 200) }); }) as Record<string, unknown>;
    const ok = String(doc.issuer ?? '').replace(/\/+$/, '') === value.issuer && typeof doc.authorization_endpoint === 'string' && typeof doc.token_endpoint === 'string' && typeof doc.jwks_uri === 'string';
    await audit(req, 'settings.sso_test', ok ? 'success' : 'failure', req.user.id, { issuer: value.issuer });
    if (!ok) throw apiError(422, 'SSO_DISCOVERY_INVALID', 'Not an OpenID provider for this issuer', undefined, { detail: String(doc.issuer ?? '') });
    return { ok: true, issuer: doc.issuer, scopes: Array.isArray(doc.scopes_supported) ? doc.scopes_supported.slice(0, 30) : [], claims: Array.isArray(doc.claims_supported) ? doc.claims_supported.slice(0, 50) : [] };
  }

  // With the values in the form (saved or not): the service account binds and, with an e-mail, finds that person;
  // with their password too, they sign in. Nothing is created or changed.
  @Post('test') @HttpCode(200) @Can('settings.manage')
  async test(@Req() req: AuthedRequest, @Body() body: Input) {
    await ensureRoles();
    const { value, bindPassword: pw } = readLdap((body?.ldap ?? {}) as Input, (await getSettings('directory')).ldap);
    const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : undefined;
    const r = await ldapTest(value, pw, email, typeof body?.password === 'string' ? body.password : undefined);
    await audit(req, 'settings.directory_test', r.ok ? 'success' : 'failure', req.user.id, { code: r.ok ? null : r.code });
    if (!r.ok) throw apiError(422, r.code, 'Directory test failed', undefined, { detail: r.detail });
    return 'user' in r && r.user ? { ok: true, user: { dn: r.user.dn, email: r.user.email, name: r.user.name, groups: r.user.groups.slice(0, 50), roles: rolesFromGroups(value, r.user.groups) } } : { ok: true };
  }
}
