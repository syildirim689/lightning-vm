// HTTP side of the runtime settings: public branding and config, and the admin pages (branding, mail, captcha).
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { audit, type AuthedRequest } from './auth';
import { config } from './config';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret } from './secrets';
import { decryptCredentials, encryptCredentials, providers, sendWith } from './sms';
import { emailPattern, getSettings, imagePattern, mailErrorCode, mailSecrets, publicConfig, readBranding, readCaptcha, readMail, saveSettings, sendViaProvider, transportFor, verifyCaptcha, type SmsSettings } from './settings-store';
import { mailProviders } from './mail-providers';

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
    const value = { customer: pick(body?.customer, current.customer), hardware: pick(body?.hardware, current.hardware) };
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
    const value = { require2fa, emailCodeSignIn: body?.emailCodeSignIn === true };
    await saveSettings('security', value);
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
