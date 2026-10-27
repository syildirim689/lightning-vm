// HTTP side of the runtime settings: public branding and config, and the admin pages (branding, mail, captcha).
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { audit, type AuthedRequest } from './auth';
import { config } from './config';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret } from './secrets';
import { decryptCredentials, encryptCredentials, providers, sendWith } from './sms';
import { emailPattern, getSettings, imagePattern, mailErrorCode, mailReady, mailSecrets, publicConfig, readBranding, readCaptcha, readMail, saveSettings, sendViaProvider, transportFor, verifyCaptcha, type SmsSettings } from './settings-store';
import { mailProviders } from './mail-providers';
import { usableApps } from './chat-delivery';
import { pool } from './db';
import { summary } from './maintenance';
import { policies } from './notify';
import { publishLive } from './live-bus';
import { smsReady } from './sms';

type Input = Record<string, unknown>;

@Controller('public')
export class PublicController {
  // What every page needs before sign-in: branding, which auth features exist, the captcha to show. No secrets.
  @Get('config')
  config() { return publicConfig(); }

  // Logo and favicon as real images (cacheable, usable in <link rel="icon">). Data URLs were validated on save.
  @Get('branding/:kind')
  async image(@Param('kind') kind: string, @Res() reply: FastifyReply) {
    if (kind !== 'logo' && kind !== 'favicon') throw apiError(404, 'NOT_FOUND', 'Unknown image');
    const b = await getSettings('branding');
    const m = b[kind] ? imagePattern.exec(b[kind]!) : null;
    if (!m) throw apiError(404, 'NOT_FOUND', 'No image');
    reply.header('content-type', m[1] === 'jpeg' ? 'image/jpeg' : m[1] === 'png' || m[1] === 'webp' ? `image/${m[1]}` : 'image/x-icon')
      .header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff').send(Buffer.from(m[2], 'base64'));
  }
}

@Controller('admin/settings') @UseGuards(PermissionGuard)
export class SettingsController {
  @Get('branding') @Can('settings.view', 'settings.manage')
  branding() { return getSettings('branding'); }

  @Put('branding') @Can('settings.manage')
  async saveBranding(@Req() req: AuthedRequest, @Body() body: Input) {
    const value = readBranding(body ?? {});
    await saveSettings('branding', value);
    await audit(req, 'settings.branding', 'success', req.user.id, { name: value.name, accent: value.accent, logo: !!value.logo, favicon: !!value.favicon });
    return value;
  }

  // The stored password and secret never leave the server; the panel only learns whether one is set.
  @Get('mail') @Can('settings.view', 'settings.manage')
  async mail() {
    const saved = await getSettings('mail');
    const { passwordEnc, apiSecretEnc, ...m } = saved;
    return { ...m, passwordSet: !!passwordEnc, secretsSet: apiSecretEnc ? Object.keys(mailSecrets(saved)) : [], envFallback: !m.enabled && !!(config.SMTP_URL && config.MAIL_FROM),
      providers: Object.entries(mailProviders).map(([id, p]) => ({ id, name: p.name, website: p.website, docs: p.docs, fields: p.fields })) };
  }

  @Put('mail') @Can('settings.manage')
  async saveMail(@Req() req: AuthedRequest, @Body() body: Input) {
    const { value } = readMail(body ?? {}, await getSettings('mail'));
    await saveSettings('mail', value);
    await audit(req, 'settings.mail', 'success', req.user.id, { enabled: value.enabled, provider: value.provider, host: value.provider === 'smtp' ? value.host : undefined, use: value.use });
    return this.mail();
  }

  // Connects, authenticates and sends one message with the values in the form (saved or not).
  @Post('mail/test') @HttpCode(200) @Can('settings.manage')
  async testMail(@Req() req: AuthedRequest, @Body() body: Input) {
    const to = typeof body?.to === 'string' && emailPattern.test(body.to) ? body.to : null;
    if (!to) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { to: 'INVALID_EMAIL' });
    const saved = await getSettings('mail');
    const { value, password, secrets } = readMail({ ...body, enabled: true }, saved);
    const name = (await getSettings('branding')).name;
    const subject = `${name}: ${value.provider === 'smtp' ? 'SMTP' : mailProviders[value.provider].name} test`;
    const text = `This test message from ${name} confirms that outgoing mail works.\n\nBu test iletisi ${name} e-posta gönderiminin çalıştığını doğrular.`;
    try {
      if (value.provider !== 'smtp') await sendViaProvider(value, secrets, to, subject, text);
      else {
        const t = await transportFor(value, password);
        await t!.transport.verify();
        await t!.transport.sendMail({ from: t!.from, to, subject, text });
      }
    } catch (err) {
      const code = mailErrorCode(err);
      await audit(req, 'settings.mail_test', 'failure', req.user.id, { code });
      throw apiError(422, code, 'SMTP test failed', undefined, { detail: String((err as Error)?.message ?? '').slice(0, 300) });
    }
    await audit(req, 'settings.mail_test', 'success', req.user.id, { provider: value.provider, host: value.provider === 'smtp' ? value.host : undefined });
    return { sent: true, to };
  }

  @Get('servers') @Can('settings.view', 'settings.manage')
  servers() { return getSettings('servers'); }

  @Put('servers') @Can('settings.manage')
  async saveServers(@Req() req: AuthedRequest, @Body() body: Input) {
    const pick = <T extends Record<string, boolean>>(given: unknown, defaults: T): T => {
      const g = (given ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, typeof g[k] === 'boolean' ? g[k] : d])) as T;
    };
    const current = await getSettings('servers');
    const t = (body?.traffic ?? {}) as Record<string, unknown>;
    const mbps = t.throttleMbps === undefined ? current.traffic.throttleMbps : Number(t.throttleMbps);
    if (!Number.isInteger(mbps) || mbps < 1 || mbps > 10_000) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { 'traffic.throttleMbps': 'OUT_OF_RANGE' });
    const traffic = { overLimit: t.overLimit === 'notify' || t.overLimit === 'throttle' ? t.overLimit : current.traffic.overLimit, throttleMbps: mbps };
    const maxBackups = (body?.backups as { maxPerServer?: unknown } | undefined)?.maxPerServer === undefined ? current.backups?.maxPerServer ?? 7 : Number((body.backups as { maxPerServer: unknown }).maxPerServer);
    if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 50) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { 'backups.maxPerServer': 'OUT_OF_RANGE' });
    const value = { customer: pick(body?.customer, current.customer), hardware: pick(body?.hardware, current.hardware), traffic, backups: { maxPerServer: maxBackups } };
    await saveSettings('servers', value);
    await audit(req, 'settings.servers', 'success', req.user.id, value);
    return value;
  }

  @Get('security') @Can('settings.view', 'settings.manage')
  security() { return getSettings('security'); }

  @Put('security') @Can('settings.manage')
  async saveSecurity(@Req() req: AuthedRequest, @Body() body: Input) {
    const require2fa = ['none', 'staff', 'all'].includes(String(body?.require2fa)) ? String(body.require2fa) as 'none' | 'staff' | 'all' : null;
    if (!require2fa) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { require2fa: 'INVALID_VALUE' });
    const current = await getSettings('security');
    const apiTokens = body?.apiTokens === undefined ? current.apiTokens : ['everyone', 'staff', 'off'].includes(String(body.apiTokens)) ? String(body.apiTokens) as 'everyone' | 'staff' | 'off' : null;
    if (!apiTokens) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { apiTokens: 'INVALID_VALUE' });
    const value = { require2fa, emailCodeSignIn: body?.emailCodeSignIn === true, apiTokens };
    await saveSettings('security', value);
    await publishLive(null, 'policy');
    await audit(req, 'settings.security', 'success', req.user.id, value);
    return value;
  }

  @Get('captcha') @Can('settings.view', 'settings.manage')
  async captcha() {
    const { secretEnc, ...c } = await getSettings('captcha');
    return { ...c, secretSet: !!secretEnc, envFallback: c.provider === 'none' && !!(config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY) };
  }

  @Put('captcha') @Can('settings.manage')
  async saveCaptcha(@Req() req: AuthedRequest, @Body() body: Input) {
    const { value } = readCaptcha(body ?? {}, await getSettings('captcha'));
    await saveSettings('captcha', value);
    await audit(req, 'settings.captcha', 'success', req.user.id, { provider: value.provider, use: value.use });
    return this.captcha();
  }

  // The admin solves the widget with the entered site key; the token is checked with the entered secret.
  @Post('captcha/test') @HttpCode(200) @Can('settings.manage')
  async testCaptcha(@Req() req: AuthedRequest, @Body() body: Input) {
    const saved = await getSettings('captcha');
    const { value, secret } = readCaptcha(body ?? {}, saved);
    const token = typeof body?.token === 'string' ? body.token : '';
    if (value.provider === 'none' || !token) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { token: 'REQUIRED' });
    const verdict = await verifyCaptcha(value.provider, secret ?? decryptSecret(value.secretEnc!, 'settings:captcha'), token, req.ip, value.minScore);
    await audit(req, 'settings.captcha_test', verdict.ok ? 'success' : 'failure', req.user.id, { provider: value.provider, errors: verdict.errors });
    return verdict;
  }
}

// SMS: the provider list with its account fields, and the saved choice. Secret fields come back only as "set".
@Controller('admin/settings/sms') @UseGuards(PermissionGuard)
export class SmsSettingsController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() {
    const s = await getSettings('sms');
    const saved = decryptCredentials(s);
    const fields = providers[s.provider]?.fields ?? [];
    const credentials = Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : saved[f.key] ?? '']));
    const secretsSet = Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.key, !!saved[f.key]]));
    return { provider: s.provider, sender: s.sender, commercial: s.commercial, use: s.use, credentials, secretsSet,
      providers: Object.entries(providers).map(([id, p]) => ({ id, name: p.name, website: p.website, docs: p.docs, confidence: p.confidence, fields: p.fields, senderRequired: p.senderRequired, iys: p.iys })) };
  }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Input) {
    const { value } = readSms(body ?? {}, await getSettings('sms'));
    await saveSettings('sms', value);
    await audit(req, 'settings.sms', 'success', req.user.id, { provider: value.provider, use: value.use });
    return this.get();
  }

  // Sends one real message with the values in the form (saved or not).
  @Post('test') @HttpCode(200) @Can('settings.manage')
  async test(@Req() req: AuthedRequest, @Body() body: Input) {
    const to = typeof body?.to === 'string' && /^\+[1-9]\d{7,14}$/.test(body.to) ? body.to : null;
    if (!to) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { to: 'INVALID_PHONE' });
    const { value, credentials } = readSms(body, await getSettings('sms'));
    if (value.provider === 'none') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { provider: 'REQUIRED' });
    const name = (await getSettings('branding')).name;
    const r = await sendWith(value, credentials, to, `${name}: SMS test / SMS testi`);
    await audit(req, 'settings.sms_test', r.ok ? 'success' : 'failure', req.user.id, { provider: value.provider, code: r.code });
    if (!r.ok) throw apiError(422, r.code ?? 'SMS_REJECTED', 'SMS test failed', undefined, { detail: r.detail });
    return { sent: true, to, ref: r.ref };
  }
}

function readSms(body: Input, saved: SmsSettings): { value: SmsSettings; credentials: Record<string, string> } {
  const fields: Record<string, string> = {};
  const provider = typeof body.provider === 'string' && (body.provider === 'none' || providers[body.provider]) ? body.provider : (fields.provider = 'INVALID_VALUE', 'none');
  const p = providers[provider];
  const sender = typeof body.sender === 'string' ? body.sender.trim().slice(0, 20) : '';
  if (p?.senderRequired && !sender) fields.sender = 'REQUIRED';
  const input = (body.credentials ?? {}) as Record<string, unknown>;
  const old = saved.provider === provider ? decryptCredentials(saved) : {};
  const credentials: Record<string, string> = {};
  for (const f of p?.fields ?? []) {
    const v = typeof input[f.key] === 'string' ? (input[f.key] as string).trim() : '';
    // An empty secret keeps the stored one.
    credentials[f.key] = v || (f.secret ? old[f.key] ?? '' : '');
    if (!credentials[f.key] && !f.optional) fields[`credentials.${f.key}`] = 'REQUIRED';
    if (f.options && credentials[f.key] && !f.options.includes(credentials[f.key])) fields[`credentials.${f.key}`] = 'INVALID_VALUE';
    if (credentials[f.key].length > 2000) fields[`credentials.${f.key}`] = 'INVALID_VALUE';
  }
  if (provider === 'custom' && credentials.headers) { try { JSON.parse(credentials.headers); } catch { fields['credentials.headers'] = 'INVALID_JSON'; } }
  if (provider === 'custom' && credentials.successPattern) { try { new RegExp(credentials.successPattern); } catch { fields['credentials.successPattern'] = 'INVALID_VALUE'; } }
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const use = (body.use ?? {}) as Input;
  return { value: { provider, sender, commercial: body.commercial === true, credentialsEnc: provider === 'none' ? null : encryptCredentials(credentials),
    use: { twoFactor: use.twoFactor === true, phoneVerification: use.phoneVerification === true } }, credentials };
}

// Settings → General: every integration's state in one call, for the overview cards and the completion bar.
// state: ok (working), todo (not set up, optional), warn (set up in a risky way or needs attention).
@Controller('admin/settings/overview') @UseGuards(PermissionGuard)
export class SettingsOverviewController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() {
    const [branding, security, captcha, rdns, announcement, chat, notifications] = await Promise.all([getSettings('branding'), getSettings('security'), getSettings('captcha'),
      getSettings('rdns'), getSettings('announcement'), getSettings('chat'), policies()]);
    const dir = await getSettings('directory');
    const signIn = await getSettings('signIn');
    // Ways in besides the password and passkeys: social providers, the e-mail link, user names, single sign-on.
    const methods = (await import('./social-providers')).enabledSocial(signIn).length + Number(signIn.magicLink) + Number(signIn.username) + Number(dir.oidc.enabled);
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    const [reg, url, pay, counts] = await Promise.all([
      one("SELECT value FROM settings WHERE key = 'registration_open'"), one("SELECT value FROM settings WHERE key = 'public_url'"),
      one('SELECT count(*) FILTER (WHERE enabled)::int AS on, count(*)::int AS saved FROM payment_gateways'),
      one(`SELECT (SELECT count(*)::int FROM users WHERE NOT coalesce(banned, false)) AS users,
        (SELECT count(*)::int FROM users WHERE 'admin' = ANY(string_to_array(coalesce(role, ''), ',')) AND NOT two_factor_enabled AND NOT coalesce(banned, false)) AS "adminsNo2fa",
        (SELECT count(*)::int FROM servers WHERE state <> 'deleted') AS servers`)]);
    const registrationOpen = reg?.value === true;
    const address = typeof url?.value === 'string' ? url.value : null;
    const https = config.PANEL_TLS === '1' && (!address || address.startsWith('https://'));
    const now = Date.now();
    const backup = summary().lastSuccessfulBackup;
    const backupAgeH = backup ? Math.round((now - Date.parse(backup.time)) / 3_600_000) : null;
    const events = Object.values(notifications);
    const items = [
      { key: 'branding', tab: 'branding', state: branding.name !== 'Lightning VM' || branding.logo ? 'ok' : 'todo', detail: { name: branding.name, logo: !!branding.logo } },
      { key: 'domain', tab: 'domain', state: https ? 'ok' : 'warn', detail: { url: address, https } },
      { key: 'security', tab: 'security', state: counts.adminsNo2fa ? 'warn' : security.require2fa !== 'none' ? 'ok' : 'todo', detail: { require2fa: security.require2fa, adminsNo2fa: counts.adminsNo2fa } },
      { key: 'mail', tab: 'mail', state: (await mailReady()) ? 'ok' : 'warn', detail: { provider: (await getSettings('mail')).provider } },
      { key: 'directory', tab: 'directory', state: dir.ldap.enabled ? 'ok' : 'todo', detail: { url: dir.ldap.url } },
      { key: 'signin', tab: 'signin', state: methods ? 'ok' : 'todo', detail: { n: methods } },
      { key: 'captcha', tab: 'captcha', state: captcha.provider !== 'none' ? 'ok' : registrationOpen ? 'warn' : 'todo', detail: { provider: captcha.provider } },
      { key: 'sms', tab: 'sms', state: (await smsReady()) ? 'ok' : 'todo', detail: { provider: (await getSettings('sms')).provider } },
      { key: 'chat', tab: 'chat', state: usableApps(chat).length ? 'ok' : 'todo', detail: { apps: usableApps(chat).length } },
      { key: 'payments', tab: 'payments', state: pay.on ? 'ok' : 'todo', detail: { active: pay.on, saved: pay.saved } },
      { key: 'rdns', tab: 'rdns', state: rdns.provider !== 'none' ? 'ok' : 'todo', detail: { provider: rdns.provider } },
      { key: 'notifications', tab: 'notifications', state: 'ok', detail: { enabled: events.filter((e) => e.enabled).length, total: events.length } },
      { key: 'announcement', tab: 'announcement', state: announcement.active ? 'ok' : 'todo', detail: { active: announcement.active } },
      { key: 'backup', tab: null, state: backupAgeH === null || backupAgeH > 48 ? 'warn' : 'ok', detail: { hoursAgo: backupAgeH } },
    ];
    return { items, registrationOpen, version: process.env.APP_VERSION || 'dev', users: counts.users, servers: counts.servers, startedAt: new Date(now - process.uptime() * 1000).toISOString() };
  }
}
