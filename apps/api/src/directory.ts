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
import { getSettings, saveSettings, type LdapSettings } from './settings-store';

type Input = Record<string, unknown>;

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
  const groupRoles = Array.isArray(body.groupRoles) ? (body.groupRoles as Input[]).map((g) => ({ group: String(g?.group ?? '').trim().slice(0, 500), roles: Array.isArray(g?.roles) ? [...new Set(g.roles.map(String))] : [] }))
    .filter((g) => g.group) : [];
  if (groupRoles.length > 50 || groupRoles.some((g) => !g.roles.length || g.roles.some((r) => !roles.has(r)))) fields.groupRoles = 'INVALID_VALUE';
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
    const { bindPasswordEnc, ...ldap } = (await getSettings('directory')).ldap;
    const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM users WHERE auth_source = 'ldap'");
    return { ldap: { ...ldap, bindPasswordSet: !!bindPasswordEnc }, directoryUsers: n.n };
  }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Input) {
    await ensureRoles();
    const { value } = readLdap((body?.ldap ?? {}) as Input, (await getSettings('directory')).ldap);
    await saveSettings('directory', { ldap: value });
    await audit(req, 'settings.directory', 'success', req.user.id, { enabled: value.enabled, url: value.url, groups: value.groupRoles.length });
    return this.get();
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
