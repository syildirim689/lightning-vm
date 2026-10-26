// Notifications (no HTTP here; the controllers are in notifications.ts): one catalog of events, four channels (in-app inbox, browser push, e-mail, SMS).
// The admin decides per event which channels exist, the defaults and whether users may change them;
// users then choose within that (Account → Notifications). Every new feature that informs someone
// adds its event here. The API and the worker only enqueue; the consumer below delivers.
import { Queue, Worker } from 'bullmq';
import webpush from 'web-push';
import { pool, redis } from './db';
import { logEvent } from './log';
import { can, permissionsOf, type Permission } from './permissions';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, mailReady, saveSettings, sendMail, type Channel, type NotificationPolicy } from './settings-store';
import { sendSms, smsReady } from './sms';
import { deliverChat } from './chat-delivery';
import { publishLive } from './live-bus';
import { alwaysSent, inQuietHours, loudChannels } from './quiet-hours';

export type Text = { title: string; body: string };
type EventDef = {
  audience: 'user' | 'staff';
  permission?: Permission; // staff events: who receives them
  channels: Channel[];     // channels that make sense for this event
  defaults: Channel[];
  link?: (d: Record<string, string>) => string;
  text: { tr: (d: Record<string, string>) => Text; en: (d: Record<string, string>) => Text };
};

export const all: Channel[] = ['inApp', 'push', 'email', 'sms', 'chat'];
export const catalog: Record<string, EventDef> = {
  'server.ready': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name} hazır`, body: `Sunucunuz kuruldu ve çalışıyor. IP: ${d.address || '-'}` }),
      en: (d) => ({ title: `${d.name} is ready`, body: `Your server is set up and running. IP: ${d.address || '-'}` }) } },
  'server.failed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: işlem başarısız`, body: `${d.kind} işlemi tamamlanamadı (${d.code}).` }),
      en: (d) => ({ title: `${d.name}: operation failed`, body: `The ${d.kind} operation could not finish (${d.code}).` }) } },
  'server.deleted': { audience: 'user', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'],
    text: { tr: (d) => ({ title: `${d.name} silindi`, body: 'Sunucu ve diskleri kaldırıldı; IP adresi serbest bırakıldı.' }),
      en: (d) => ({ title: `${d.name} deleted`, body: 'The server and its disks were removed; its IP address was released.' }) } },
  'server.power': { audience: 'user', channels: ['inApp', 'push', 'chat'], defaults: ['inApp'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: ${d.kind} tamamlandı`, body: 'Güç işlemi tamamlandı.' }),
      en: (d) => ({ title: `${d.name}: ${d.kind} done`, body: 'The power operation finished.' }) } },
  'server.snapshot': { audience: 'user', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: anlık görüntü ${({ snapshot_create: 'alındı', snapshot_revert: 'geri yüklendi', snapshot_delete: 'silindi' } as Record<string, string>)[String(d.kind)] ?? 'işlendi'}`, body: String(d.snapshot ?? '') }),
      en: (d) => ({ title: `${d.name}: snapshot ${({ snapshot_create: 'taken', snapshot_revert: 'restored', snapshot_delete: 'removed' } as Record<string, string>)[String(d.kind)] ?? 'done'}`, body: String(d.snapshot ?? '') }) } },
  'server.firewall_failed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: firewall uygulanamadı`, body: `Kurallar sunucuya yazılamadı (${d.code}). Önceki kurallar geçerli olabilir.` }),
      en: (d) => ({ title: `${d.name}: firewall not applied`, body: `The rules could not be written to the server (${d.code}). Earlier rules may still apply.` }) } },
  'server.app_installed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => '/servers/' + d.serverId,
    text: { tr: (d) => ({ title: d.name + ': uygulama kuruldu', body: 'Seçtiğiniz uygulamanın kurulumu tamamlandı.' }),
      en: (d) => ({ title: d.name + ': application installed', body: 'The application you chose has been installed.' }) } },
  'server.app_failed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => '/servers/' + d.serverId,
    text: { tr: (d) => ({ title: d.name + ': uygulama kurulamadı', body: 'Kurulum başarısız oldu (' + (d.message || '-') + '). Ayrıntı sunucuda /var/log/lightning-app.log dosyasında.' }),
      en: (d) => ({ title: d.name + ': application not installed', body: 'The installation failed (' + (d.message || '-') + '). Details on the server in /var/log/lightning-app.log.' }) } },
  'billing.budget_exceeded': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/',
    text: { tr: (d) => ({ title: 'Aylık bütçeniz aşıldı', body: `Sunucularınızın aylık tutarı ${d.monthly} ${d.currency}; belirlediğiniz bütçe ${d.amount} ${d.currency}.` }),
      en: (d) => ({ title: 'Your monthly budget is exceeded', body: `Your servers cost ${d.monthly} ${d.currency} a month; your budget is ${d.amount} ${d.currency}.` }) } },
  'auth.sign_in': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=security',
    text: { tr: (d) => ({ title: 'Hesabınıza yeni giriş', body: `IP ${d.ip || '-'} · ${d.agent?.slice(0, 80) || '-'}. Siz değilseniz parolanızı değiştirin.` }),
      en: (d) => ({ title: 'New sign-in to your account', body: `IP ${d.ip || '-'} · ${d.agent?.slice(0, 80) || '-'}. If this was not you, change your password.` }) } },
  'auth.password_changed': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=security',
    text: { tr: () => ({ title: 'Parolanız değişti', body: 'Bu değişikliği siz yapmadıysanız hemen yöneticinize başvurun.' }),
      en: () => ({ title: 'Your password changed', body: 'If you did not make this change, contact your administrator now.' }) } },
  'auth.two_factor_changed': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=security',
    text: { tr: (d) => ({ title: d.enabled === 'true' ? 'İki adımlı doğrulama açıldı' : 'İki adımlı doğrulama kapatıldı', body: 'Hesap güvenlik ayarınız değişti.' }),
      en: (d) => ({ title: d.enabled === 'true' ? 'Two-factor authentication on' : 'Two-factor authentication off', body: 'Your account security setting changed.' }) } },
  'admin.user_registered': { audience: 'staff', permission: 'users.view', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: () => '/admin/users',
    text: { tr: (d) => ({ title: 'Yeni kullanıcı kaydı', body: d.email }), en: (d) => ({ title: 'New user registered', body: d.email }) } },
  'admin.operation_failed': { audience: 'staff', permission: 'servers.view_all', channels: all, defaults: ['inApp', 'push'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `İşlem başarısız: ${d.name}`, body: `${d.kind} · ${d.code} · ${d.owner}` }),
      en: (d) => ({ title: `Operation failed: ${d.name}`, body: `${d.kind} · ${d.code} · ${d.owner}` }) } },
  'admin.abuse': { audience: 'staff', permission: 'servers.view_all', channels: all, defaults: ['inApp', 'push', 'email'], link: () => '/admin/abuse',
    text: { tr: (d) => ({ title: d.kind === 'cpu' ? 'Madencilik şüphesi: ' + d.name : 'Açık port: ' + d.name + ' ' + d.address + ':' + d.port,
        body: d.kind === 'cpu' ? 'CPU uzun süredir ortalama %' + d.cpu + ' (' + d.owner + ').' : (d.label || 'Port') + ' internete açık (' + d.owner + ').' }),
      en: (d) => ({ title: d.kind === 'cpu' ? 'Mining suspected: ' + d.name : 'Open port: ' + d.name + ' ' + d.address + ':' + d.port,
        body: d.kind === 'cpu' ? 'CPU has averaged ' + d.cpu + '% for hours (' + d.owner + ').' : (d.label || 'Port') + ' is open to the Internet (' + d.owner + ').' }) } },
  'server.port_open': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => '/servers/' + d.serverId,
    text: { tr: (d) => ({ title: d.name + ': ' + (d.label || 'port') + ' internete açık', body: d.address + ':' + d.port + ' herkese açık görünüyor. Gerekmiyorsa kapatın veya bir firewall uygulayın.' }),
      en: (d) => ({ title: d.name + ': ' + (d.label || 'port') + ' open to the Internet', body: d.address + ':' + d.port + ' is reachable by anyone. Close it or apply a firewall if it is not needed.' }) } },
  'admin.iso_ready': { audience: 'staff', permission: 'catalog.manage', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: () => '/admin/catalog?tab=isos',
    text: { tr: (d) => ({ title: 'ISO hazır: ' + d.name, body: d.pool + ' konumunda müşterilerin kullanımına açık.' }),
      en: (d) => ({ title: 'ISO ready: ' + d.name, body: 'Available in ' + d.pool + '.' }) } },
  'admin.iso_failed': { audience: 'staff', permission: 'catalog.manage', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp', 'push'], link: () => '/admin/catalog?tab=isos',
    text: { tr: (d) => ({ title: 'ISO kopyalanamadı: ' + d.name, body: d.error }), en: (d) => ({ title: 'ISO copy failed: ' + d.name, body: d.error }) } },
  // From Alertmanager (alerts.ts): the monitoring stack's alert rules, firing and resolved.
  'admin.alert': { audience: 'staff', permission: 'system.view', channels: all, defaults: ['inApp', 'email', 'push'], link: () => '/admin/system',
    text: { tr: (d) => ({ title: d.titleTr, body: d.bodyTr }), en: (d) => ({ title: d.titleEn, body: d.bodyEn }) } },
  'admin.insight': { audience: 'staff', permission: 'dashboard.view', channels: all, defaults: ['inApp', 'email'], link: () => '/admin',
    text: { tr: (d) => ({ title: d.titleTr, body: d.bodyTr }), en: (d) => ({ title: d.titleEn, body: d.bodyEn }) } },
};
export type EventKey = keyof typeof catalog;

const defaultPolicy = (e: EventDef): NotificationPolicy => ({ enabled: true, allowed: e.channels, defaults: e.defaults, userCanChange: true });
export async function policies() {
  const saved = await getSettings('notifications');
  return Object.fromEntries(Object.entries(catalog).map(([k, e]) => {
    const p = { ...defaultPolicy(e), ...saved[k] };
    // Channels are always limited to what the event supports; defaults to what is allowed.
    const allowed = p.allowed.filter((c) => e.channels.includes(c));
    return [k, { ...p, allowed, defaults: p.defaults.filter((c) => allowed.includes(c)) }];
  })) as Record<string, NotificationPolicy>;
}

export const notificationQueue = new Queue('notifications', { connection: redis });
const queue = notificationQueue;
// Recipients: user ids, or 'staff:<permission>' for everyone holding it.
export async function notify(event: EventKey, to: string[] | `staff:${Permission}`, data: Record<string, unknown>) {
  const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')]));
  await queue.add('notify', { event, to, data: clean }, { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 })
    .catch(() => logEvent('error', 'notify_enqueue_failed', { event }));
}

async function recipients(to: string[] | string) {
  const { rows } = Array.isArray(to)
    ? await pool.query('SELECT id, email, locale, role, phone_number, phone_number_verified, quiet_hours FROM users WHERE id = ANY($1::uuid[]) AND NOT coalesce(banned, false)', [to])
    : await pool.query('SELECT id, email, locale, role, phone_number, phone_number_verified, quiet_hours FROM users WHERE NOT coalesce(banned, false) AND disabled_at IS NULL');
  if (Array.isArray(to)) return rows;
  const perm = to.replace('staff:', '') as Permission;
  const out = [];
  for (const u of rows) if (can(await permissionsOf(u.id, u.role), perm)) out.push(u);
  return out;
}

// The channels one user gets for one event: the admin's policy, then the user's choice within it.
async function channelsFor(userId: string, event: string, p: NotificationPolicy): Promise<Channel[]> {
  if (!p.enabled) return [];
  if (!p.userCanChange) return p.defaults;
  const { rows: [pref] } = await pool.query('SELECT channels FROM notification_preferences WHERE user_id = $1 AND event = $2', [userId, event]);
  return pref ? (pref.channels as Channel[]).filter((c) => p.allowed.includes(c)) : p.defaults;
}

export async function vapid() {
  let v = await getSettings('vapid');
  if (!v.publicKey || !v.privateKeyEnc) {
    const keys = webpush.generateVAPIDKeys();
    v = { publicKey: keys.publicKey, privateKeyEnc: encryptSecret(keys.privateKey, 'settings:vapid') };
    await saveSettings('vapid', v);
  }
  return { publicKey: v.publicKey, privateKey: decryptSecret(v.privateKeyEnc!, 'settings:vapid') };
}

async function sendPush(userId: string, payload: object) {
  const { rows } = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  if (!rows.length) return;
  const keys = await vapid();
  const brand = (await getSettings('branding')).name;
  await Promise.all(rows.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...payload, brand }),
    { vapidDetails: { subject: 'mailto:noreply@lightning-vm.invalid', publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 })
    // Gone or expired subscriptions are removed; anything else is logged.
    .catch(async (err) => {
      if (err?.statusCode === 404 || err?.statusCode === 410) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      else logEvent('error', 'push_failed', { status: err?.statusCode ?? 0 });
    })));
}

type Recipient = { id: string; email: string; locale: string; phone_number: string | null; phone_number_verified: boolean };
export async function deliver(u: Recipient, channel: Channel, t: Text, link: string | null, event: string) {
  const brand = (await getSettings('branding')).name;
  if (channel === 'inApp') {
    await pool.query('INSERT INTO notifications (user_id, event, title, body, link) VALUES ($1, $2, $3, $4, $5)', [u.id, event, t.title, t.body, link]);
    await publishLive(u.id, 'notification');
  }
  if (channel === 'push') await sendPush(u.id, { title: t.title, body: t.body, link });
  if (channel === 'email' && (await mailReady())) await sendMail(u.email, `${brand}: ${t.title}`, `${t.body}${link ? `\n\n${link}` : ''}`);
  if (channel === 'chat') await deliverChat(u.id, t, link, event);
  if (channel === 'sms' && u.phone_number && u.phone_number_verified && (await smsReady())) await sendSms(u.phone_number, `${brand}: ${t.title}. ${t.body}`.slice(0, 300));
}

// One consumer in the API process; failures of one channel never stop the others.
export function startNotificationWorker() {
  const connection = redis.duplicate({ maxRetriesPerRequest: null });
  const worker = new Worker('notifications', async (job) => {
    const { event, to, data } = job.data as { event: string; to: string[] | string; data: Record<string, string> };
    const def = catalog[event];
    if (!def) return;
    const p = (await policies())[event];
    for (const u of await recipients(to)) {
      const t = def.text[u.locale === 'tr' ? 'tr' : 'en'](data);
      // Quiet hours: nothing that buzzes a phone, except security notices; the inbox and e-mail still get it.
      const quiet = !alwaysSent(event) && inQuietHours(u.quiet_hours);
      for (const c of await channelsFor(u.id, event, p)) {
        if (quiet && loudChannels.has(c)) continue;
        await deliver(u, c, t, def.link?.(data) ?? null, event).catch((err) => logEvent('error', 'notification_failed', { event, channel: c, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }));
      }
    }
  }, { connection, concurrency: 2 });
  worker.on('error', () => logEvent('error', 'notification_queue_error'));
  // BullMQ leaves a connection it was given open; this one belongs to the worker alone.
  worker.on('closed', () => connection.disconnect());
  return worker;
}

