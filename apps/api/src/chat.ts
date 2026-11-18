// The "chat" notification channel: messaging apps each user connects (chat-apps.ts), and the admin's page
// that picks which apps are offered and holds the Telegram bot, WhatsApp Cloud API and Pushover accounts.
// A connection is saved only after a first message got through, so a wrong URL or token never sits silently.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { chatApps, readTarget, type Message } from './chat-apps';
import { adminAccounts, ctx, sendOne, usableApps } from './chat-delivery';
import { pool, redis } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { rateLimit } from './security';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, saveSettings, type ChatSettings } from './settings-store';

type Input = Record<string, unknown>;
const MAX_CONNECTIONS = 10;
// Connecting and testing make the panel send a request to an address the user chose: so many an hour per account,
// counted when a request is about to be made (input that is refused before that is not counted).
const sendBudget = (userId: string) => rateLimit(`chat-send:${userId}`, 20, 3600);
const welcome = (locale: string, brand: string): Message => (locale === 'tr'
  ? { title: 'Bildirimler bağlandı', body: `${brand} bildirimleri artık buraya da gelecek.`, link: null, brand, event: 'system.test' }
  : { title: 'Notifications connected', body: `${brand} notifications will arrive here too.`, link: null, brand, event: 'system.test' });

@Controller('chat') @UseGuards(SessionGuard)
export class ChatController {
  @Get()
  async list(@Req() req: AuthedRequest) {
    const s = await getSettings('chat');
    const { rows } = await pool.query(`SELECT id, app, label, hint, enabled, last_sent_at AS "lastSentAt", last_error AS "lastError", created_at AS "createdAt"
      FROM chat_connections WHERE user_id = $1 ORDER BY created_at`, [req.user.id]);
    return { apps: usableApps(s).map((id) => ({ id, name: chatApps[id].name, website: chatApps[id].website, docs: chatApps[id].docs, fields: chatApps[id].fields, needs: chatApps[id].needs ?? null })),
      connections: rows, telegramBot: s.telegram.username || null, phone: req.user.phoneNumberVerified ? req.user.phoneNumber : null, max: MAX_CONNECTIONS };
  }

  // Webhook apps and WhatsApp: a first message is sent, and the connection is kept only if it arrived.
  @Post('connections') @HttpCode(201)
  async connect(@Req() req: AuthedRequest, @Body() body: Input) {
    const s = await getSettings('chat');
    const app = String(body?.app ?? '');
    if (!usableApps(s).includes(app) || app === 'telegram') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { app: 'INVALID_VALUE' });
    await this.room(req.user.id);
    let target: Record<string, string>, hint: string;
    if (app === 'whatsapp') {
      if (!req.user.phoneNumberVerified || !req.user.phoneNumber) throw apiError(409, 'PHONE_NOT_VERIFIED', 'Verify your phone number first');
      target = { phone: req.user.phoneNumber }; hint = req.user.phoneNumber;
    } else {
      const r = await readTarget(app, (body?.fields ?? {}) as Input);
      if (Object.keys(r.fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [`fields.${k}`, v])));
      target = r.target; hint = r.hint;
    }
    return this.save(req, app, target, hint, typeof body?.label === 'string' ? body.label : '', s);
  }

  // Telegram: the user opens t.me/<bot>?start=<code> and presses Start; verify then finds that message.
  @Post('telegram/link')
  async telegramLink(@Req() req: AuthedRequest) {
    const s = await getSettings('chat');
    if (!usableApps(s).includes('telegram')) throw apiError(409, 'CHAT_APP_UNAVAILABLE', 'Telegram is not set up');
    await this.room(req.user.id);
    const code = randomBytes(12).toString('base64url');
    await redis.set(`chat:tg:${code}`, req.user.id, 'EX', 900);
    return { code, url: `https://t.me/${s.telegram.username}?start=${code}`, expiresIn: 900 };
  }

  @Post('telegram/verify') @HttpCode(200)
  async telegramVerify(@Req() req: AuthedRequest, @Body() body: Input) {
    const code = String(body?.code ?? '');
    if (!/^[\w-]{16}$/.test(code) || (await redis.get(`chat:tg:${code}`)) !== req.user.id) throw apiError(410, 'CHAT_LINK_EXPIRED', 'The link expired; start again');
    const s = await getSettings('chat');
    await pullTelegramStarts((await adminAccounts(s)).telegramToken);
    const chat = await redis.get(`chat:tg:done:${code}`);
    if (!chat) throw apiError(409, 'CHAT_TELEGRAM_WAITING', 'Press Start in Telegram first');
    const { id, name } = JSON.parse(chat) as { id: string; name: string };
    await redis.del(`chat:tg:${code}`, `chat:tg:done:${code}`);
    return this.save(req, 'telegram', { chatId: id }, name, typeof body?.label === 'string' ? body.label : '', s);
  }

  @Patch('connections/:id')
  async update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: Input) {
    const { rows: [c] } = await pool.query(`UPDATE chat_connections SET enabled = coalesce($3, enabled), label = coalesce($4, label) WHERE id = $1 AND user_id = $2
      RETURNING id, app, label, hint, enabled`, [uuid(id), req.user.id, typeof body?.enabled === 'boolean' ? body.enabled : null, typeof body?.label === 'string' ? body.label.trim().slice(0, 60) : null]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Not found');
    return c;
  }

  @Delete('connections/:id') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { rows: [c] } = await pool.query('DELETE FROM chat_connections WHERE id = $1 AND user_id = $2 RETURNING app', [uuid(id), req.user.id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Not found');
    await audit(req, 'chat.disconnect', 'success', req.user.id, { app: c.app });
  }

  @Post('connections/:id/test') @HttpCode(200)
  async test(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { rows: [c] } = await pool.query('SELECT id, app, target_enc FROM chat_connections WHERE id = $1 AND user_id = $2', [uuid(id), req.user.id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Not found');
    const s = await getSettings('chat');
    if (!usableApps(s).includes(c.app)) throw apiError(409, 'CHAT_APP_UNAVAILABLE', 'This app is switched off');
    await sendBudget(req.user.id);
    const brand = (await getSettings('branding')).name;
    const m: Message = req.user.locale === 'tr' ? { title: 'Test bildirimi', body: 'Bu kanal çalışıyor.', link: null, brand, event: 'system.test' }
      : { title: 'Test notification', body: 'This channel works.', link: null, brand, event: 'system.test' };
    const r = await sendOne(c.app, JSON.parse(decryptSecret(c.target_enc, ctx)), m, await adminAccounts(s));
    await pool.query('UPDATE chat_connections SET last_sent_at = CASE WHEN $2 THEN now() ELSE last_sent_at END, last_error = $3 WHERE id = $1', [c.id, r.ok, r.ok ? null : r.code]);
    if (!r.ok) throw apiError(422, r.code, 'Delivery failed', undefined, { detail: r.detail });
    return { sent: true };
  }

  private async room(userId: string) {
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM chat_connections WHERE user_id = $1', [userId]);
    if (n.n >= MAX_CONNECTIONS) throw apiError(409, 'CHAT_LIMIT', 'Too many connections');
  }
  private async save(req: AuthedRequest, app: string, target: Record<string, string>, hint: string, label: string, s: ChatSettings) {
    // A connection keeps receiving the account's notifications: not for staff acting as someone (as with API tokens).
    if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
    await sendBudget(req.user.id);
    const r = await sendOne(app, target, welcome(req.user.locale, (await getSettings('branding')).name), await adminAccounts(s));
    if (!r.ok) {
      await audit(req, 'chat.connect', 'failure', req.user.id, { app, code: r.code });
      throw apiError(422, r.code, 'The first message did not arrive', undefined, { detail: r.detail });
    }
    const { rows: [c] } = await pool.query(`INSERT INTO chat_connections (user_id, app, label, hint, target_enc, last_sent_at) VALUES ($1, $2, $3, $4, $5, now())
      RETURNING id, app, label, hint, enabled`, [req.user.id, app, label.trim().slice(0, 60) || chatApps[app].name, hint.slice(0, 120), encryptSecret(JSON.stringify(target), ctx)]);
    await audit(req, 'chat.connect', 'success', req.user.id, { app });
    return c;
  }
}
const uuid = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? id : '00000000-0000-0000-0000-000000000000');

// Reads the bot's pending messages once: each "/start <code>" for a live code is recorded, then all are marked read,
// so one user's verify never loses another user's start.
async function pullTelegramStarts(token: string) {
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.timeout(15_000) });
  const b = await r.json().catch(() => null) as { ok?: boolean; description?: string; result?: { update_id: number; message?: { text?: string; chat?: { id: number; username?: string; first_name?: string; title?: string } } }[] } | null;
  if (!b?.ok) throw apiError(422, 'CHAT_TELEGRAM_FAILED', 'Telegram did not answer', undefined, { detail: b?.description ?? `HTTP ${r.status}` });
  let last = 0;
  for (const u of b.result ?? []) {
    last = Math.max(last, u.update_id);
    const code = /^\/start ([\w-]{16})$/.exec(u.message?.text?.trim() ?? '')?.[1];
    const chat = u.message?.chat;
    if (code && chat && (await redis.exists(`chat:tg:${code}`))) {
      await redis.set(`chat:tg:done:${code}`, JSON.stringify({ id: String(chat.id), name: chat.username ? `@${chat.username}` : chat.first_name ?? chat.title ?? String(chat.id) }), 'EX', 900);
    }
  }
  if (last) await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${last + 1}&timeout=0`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
}

@Controller('admin/settings/chat') @UseGuards(PermissionGuard)
export class ChatSettingsController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() {
    const s = await getSettings('chat');
    return { apps: s.apps, usable: usableApps(s), catalog: Object.entries(chatApps).map(([id, a]) => ({ id, name: a.name, website: a.website, docs: a.docs, needs: a.needs ?? null })),
      telegram: { username: s.telegram.username, tokenSet: !!s.telegram.tokenEnc },
      whatsapp: { phoneNumberId: s.whatsapp.phoneNumberId, template: s.whatsapp.template, language: s.whatsapp.language, tokenSet: !!s.whatsapp.tokenEnc },
      pushover: { tokenSet: !!s.pushover.tokenEnc } };
  }

  // Empty secret fields keep the saved ones. A new Telegram token is checked with getMe, which also gives the bot's name.
  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Input) {
    const s = await getSettings('chat');
    const fields: Record<string, string> = {};
    const str = (o: unknown, k: string, max = 300) => (o && typeof (o as Input)[k] === 'string' ? ((o as Input)[k] as string).trim().slice(0, max) : '');
    const apps = Array.isArray(body?.apps) ? [...new Set(body.apps.map(String))].filter((a) => chatApps[a]) : s.apps;
    const tgToken = str(body?.telegram, 'token');
    const telegram = { ...s.telegram };
    if (tgToken) {
      if (!/^\d+:[\w-]{30,}$/.test(tgToken)) fields['telegram.token'] = 'INVALID_VALUE';
      else {
        const me = await fetch(`https://api.telegram.org/bot${tgToken}/getMe`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null) as { ok?: boolean; result?: { username?: string } } | null;
        if (!me?.ok || !me.result?.username) fields['telegram.token'] = 'CHAT_AUTH_FAILED';
        else Object.assign(telegram, { tokenEnc: encryptSecret(tgToken, ctx), username: me.result.username });
      }
    }
    const waToken = str(body?.whatsapp, 'token', 1000);
    const whatsapp = { tokenEnc: waToken ? encryptSecret(waToken, ctx) : s.whatsapp.tokenEnc, phoneNumberId: str(body?.whatsapp, 'phoneNumberId', 40),
      template: str(body?.whatsapp, 'template', 512), language: str(body?.whatsapp, 'language', 10) || 'tr' };
    if (whatsapp.phoneNumberId && !/^\d{5,30}$/.test(whatsapp.phoneNumberId)) fields['whatsapp.phoneNumberId'] = 'INVALID_VALUE';
    if (whatsapp.template && !/^[a-z0-9_]{1,512}$/.test(whatsapp.template)) fields['whatsapp.template'] = 'INVALID_VALUE';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(whatsapp.language)) fields['whatsapp.language'] = 'INVALID_VALUE';
    const poToken = str(body?.pushover, 'token', 100);
    if (poToken && !/^[A-Za-z0-9]{30}$/.test(poToken)) fields['pushover.token'] = 'INVALID_VALUE';
    const pushover = { tokenEnc: poToken ? encryptSecret(poToken, ctx) : s.pushover.tokenEnc };
    // An app that needs an account cannot be offered without it.
    if (apps.includes('telegram') && !telegram.tokenEnc && !fields['telegram.token']) fields['telegram.token'] = 'REQUIRED';
    if (apps.includes('whatsapp')) for (const [k, ok] of [['token', !!whatsapp.tokenEnc], ['phoneNumberId', !!whatsapp.phoneNumberId], ['template', !!whatsapp.template]] as const) if (!ok) fields[`whatsapp.${k}`] ??= 'REQUIRED';
    if (apps.includes('pushover') && !pushover.tokenEnc) fields['pushover.token'] ??= 'REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await saveSettings('chat', { apps, telegram, whatsapp, pushover });
    await audit(req, 'settings.chat', 'success', req.user.id, { apps });
    return this.get();
  }
}
