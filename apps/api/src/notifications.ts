// HTTP side of notifications: the user's inbox, preferences, browser push subscriptions and tests,
// and the admin's per-event policy.
import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { all, catalog, deliver, policies, vapid } from './notify';
import { can } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { getSettings, mailReady, saveSettings, type Channel, type NotificationPolicy } from './settings-store';
import { smsReady } from './sms';

const channelList = (v: unknown, from: Channel[]) => (Array.isArray(v) ? [...new Set(v.map(String))] : []).filter((c): c is Channel => from.includes(c as Channel));
async function availability() {
  return { inApp: true, push: true, email: await mailReady(), sms: await smsReady() };
}

@Controller('notifications') @UseGuards(SessionGuard)
export class NotificationsController {
  @Get()
  async list(@Req() req: AuthedRequest) {
    const [{ rows }, { rows: [c] }] = await Promise.all([
      pool.query('SELECT id, event, title, body, link, created_at AS "createdAt", read_at AS "readAt" FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]),
      pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]),
    ]);
    return { notifications: rows, unread: c.n };
  }

  @Post('read') @HttpCode(204)
  async read(@Req() req: AuthedRequest, @Body() body: { ids?: unknown }) {
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter((x) => /^[0-9a-f-]{36}$/.test(x)) : null;
    if (ids) await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL', [req.user.id, ids]);
    else await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  }

  // Events this user can receive, with what the admin allows and what the user chose.
  @Get('preferences')
  async preferences(@Req() req: AuthedRequest) {
    const p = await policies();
    const { rows } = await pool.query('SELECT event, channels FROM notification_preferences WHERE user_id = $1', [req.user.id]);
    const chosen = Object.fromEntries(rows.map((r) => [r.event, r.channels]));
    const events = Object.entries(catalog).filter(([, e]) => e.audience === 'user' || (e.permission && can(req.user.permissions, e.permission)))
      .filter(([k]) => p[k].enabled)
      .map(([k]) => ({ event: k, allowed: p[k].allowed, locked: !p[k].userCanChange, channels: !p[k].userCanChange ? p[k].defaults : (chosen[k] ?? p[k].defaults).filter((c: Channel) => p[k].allowed.includes(c)) }));
    const { rows: [push] } = await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
    return { events, available: await availability(), pushDevices: push.n, phoneVerified: req.user.phoneNumberVerified };
  }

  @Put('preferences')
  async savePreferences(@Req() req: AuthedRequest, @Body() body: { event?: unknown; channels?: unknown }) {
    const event = String(body?.event ?? '');
    const p = (await policies())[event];
    if (!p || !p.enabled) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { event: 'INVALID_VALUE' });
    if (!p.userCanChange) throw apiError(409, 'NOTIFICATION_LOCKED', 'The administrator fixed this notification');
    const channels = channelList(body?.channels, p.allowed);
    await pool.query(`INSERT INTO notification_preferences (user_id, event, channels) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, event) DO UPDATE SET channels = $3`, [req.user.id, event, channels]);
    return { event, channels };
  }

  @Get('push-key')
  async pushKey() { return { publicKey: (await vapid()).publicKey }; }

  @Post('push-subscriptions') @HttpCode(201)
  async subscribe(@Req() req: AuthedRequest, @Body() body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }) {
    const endpoint = typeof body?.endpoint === 'string' && /^https:\/\/[^\s]{10,2000}$/.test(body.endpoint) ? body.endpoint : null;
    const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : null;
    const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : null;
    if (!endpoint || !p256dh || !auth) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { endpoint: 'INVALID_VALUE' });
    await pool.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`, [req.user.id, endpoint, p256dh, auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
    return { subscribed: true };
  }

  @Delete('push-subscriptions') @HttpCode(204)
  async unsubscribe(@Req() req: AuthedRequest, @Body() body: { endpoint?: unknown }) {
    await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.user.id, String(body?.endpoint ?? '')]);
  }

  // Sends a test through one channel to the caller, so they can see it arrives.
  @Post('test') @HttpCode(200)
  async test(@Req() req: AuthedRequest, @Body() body: { channel?: unknown }) {
    const channel = String(body?.channel ?? '') as Channel;
    if (!all.includes(channel)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { channel: 'INVALID_VALUE' });
    const avail = await availability();
    if (!avail[channel]) throw apiError(409, 'CHANNEL_UNAVAILABLE', 'This channel is not configured');
    if (channel === 'sms' && !req.user.phoneNumberVerified) throw apiError(409, 'PHONE_NOT_VERIFIED', 'Verify your phone number first');
    if (channel === 'push') {
      const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
      if (!n.n) throw apiError(409, 'PUSH_NOT_SUBSCRIBED', 'Allow notifications in this browser first');
    }
    const t = req.user.locale === 'tr' ? { title: 'Test bildirimi', body: 'Bu kanal çalışıyor.' } : { title: 'Test notification', body: 'This channel works.' };
    try {
      await deliver({ id: req.user.id, email: req.user.email, locale: req.user.locale, phone_number: req.user.phoneNumber, phone_number_verified: req.user.phoneNumberVerified }, channel, t, '/account?tab=notifications', 'system.test');
    } catch (err) {
      throw apiError(422, 'NOTIFICATION_TEST_FAILED', 'Delivery failed', undefined, { detail: String((err as Error)?.message ?? '').slice(0, 300) });
    }
    return { sent: true, channel };
  }
}

@Controller('admin/settings/notifications') @UseGuards(PermissionGuard)
export class NotificationPolicyController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() {
    const p = await policies();
    return { events: Object.entries(catalog).map(([k, e]) => ({ event: k, audience: e.audience, permission: e.permission ?? null, channels: e.channels, ...p[k] })), available: await availability() };
  }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: { event?: unknown; enabled?: unknown; allowed?: unknown; defaults?: unknown; userCanChange?: unknown }) {
    const event = String(body?.event ?? '');
    const def = catalog[event];
    if (!def) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { event: 'INVALID_VALUE' });
    const allowed = channelList(body.allowed, def.channels);
    const policy: NotificationPolicy = { enabled: body.enabled === true, allowed, defaults: channelList(body.defaults, allowed), userCanChange: body.userCanChange === true };
    const saved = await getSettings('notifications');
    await saveSettings('notifications', { ...saved, [event]: policy });
    await audit(req, 'settings.notifications', 'success', req.user.id, { event, ...policy });
    return { event, ...policy };
  }
}
