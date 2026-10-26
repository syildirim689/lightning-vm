// Messaging apps a user can route notifications to (the "chat" channel in notify.ts). Each app declares the
// fields the user fills in and how one message is sent. Telegram, WhatsApp and Pushover also need an account the
// admin sets up once (Settings → Messaging); the others are webhooks or servers the user owns.
// Every address the user gives is checked to be a public HTTPS host, so the panel cannot be pointed at itself.
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type Message = { title: string; body: string; link: string | null; brand: string; event: string };
// The admin's accounts (secrets already decrypted).
export type AdminAccounts = { telegramToken: string; whatsappToken: string; whatsappPhoneId: string; whatsappTemplate: string; whatsappLanguage: string; pushoverToken: string };
export type Field = { key: string; secret?: boolean; optional?: boolean; placeholder?: string };
export type SendResult = { ok: true } | { ok: false; code: string; detail?: string };
type App = {
  name: string; website: string; docs: string;
  needs?: 'telegram' | 'whatsapp' | 'pushover';   // admin account required
  fields: Field[];                                  // what the user fills in (Telegram and WhatsApp: none, they are linked)
  hosts?: (host: string) => boolean;                // fixed services: which hosts a URL may point at
  send: (target: Record<string, string>, m: Message, a: AdminAccounts) => Promise<SendResult>;
};

const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) blocked.addSubnet(net, bits, 'ipv6');
// IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it carries.
export const privateAddress = (ip: string) => {
  const v4 = /^::ffff:(d+.d+.d+.d+)$/i.exec(ip)?.[1];
  return v4 ? blocked.check(v4, 'ipv4') : blocked.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
};

// A user-given URL: HTTPS, no credentials in it, and every address its host resolves to is public.
// shortcut: checked before the request, so DNS that changes between check and request is not caught; pin the address if that matters.
export async function publicUrl(raw: string, hosts?: (h: string) => boolean): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || raw.length > 2000) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hosts && !hosts(host)) return null;
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return null;
  } catch { return null; }
  return u;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  const form = body instanceof URLSearchParams;
  const r = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? body.toString() : JSON.stringify(body) });
  return { status: r.status, text: (await r.text()).slice(0, 2000) };
}
const judged = (r: { status: number; text: string }): SendResult => (r.status >= 200 && r.status < 300 ? { ok: true }
  : { ok: false, code: r.status === 401 || r.status === 403 ? 'CHAT_AUTH_FAILED' : r.status === 404 ? 'CHAT_TARGET_NOT_FOUND' : 'CHAT_REJECTED', detail: r.text.slice(0, 300) || `HTTP ${r.status}` });
const plain = (m: Message) => [m.title, m.body, m.link].filter(Boolean).join('\n');
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const url = async (raw: string, hosts?: (h: string) => boolean) => (await publicUrl(raw, hosts))?.toString() ?? null;
const badUrl: SendResult = { ok: false, code: 'CHAT_INVALID_URL' };
// Slack-compatible incoming webhooks (Slack, Mattermost, Rocket.Chat).
const slackLike = async (t: Record<string, string>, m: Message, hosts?: (h: string) => boolean) => {
  const u = await url(t.url, hosts);
  return u ? judged(await post(u, { text: `*${m.title}*\n${m.body}${m.link ? `\n${m.link}` : ''}`, username: m.brand })) : badUrl;
};
const under = (...suffixes: string[]) => (h: string) => suffixes.some((s) => h === s || h.endsWith(`.${s}`));

export const chatApps: Record<string, App> = {
  telegram: {
    name: 'Telegram', website: 'https://telegram.org', docs: 'https://core.telegram.org/bots/api#sendmessage', needs: 'telegram', fields: [],
    async send(t, m, a) {
      const r = await post(`https://api.telegram.org/bot${a.telegramToken}/sendMessage`, { chat_id: t.chatId, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `<b>${esc(m.title)}</b>\n${esc(m.body)}${m.link ? `\n${esc(m.link)}` : ''}` });
      return r.status === 403 ? { ok: false, code: 'CHAT_TELEGRAM_BLOCKED', detail: r.text.slice(0, 300) } : judged(r);
    },
  },
  whatsapp: {
    name: 'WhatsApp', website: 'https://business.whatsapp.com', docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates', needs: 'whatsapp', fields: [],
    async send(t, m, a) {
      // Messages a business starts must use an approved template; its body takes {{1}} (title) and {{2}} (text).
      const param = (s: string) => ({ type: 'text', text: s.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900) || '-' });
      const r = await post(`https://graph.facebook.com/v21.0/${encodeURIComponent(a.whatsappPhoneId)}/messages`, { messaging_product: 'whatsapp', to: t.phone.replace(/\D/g, ''), type: 'template',
        template: { name: a.whatsappTemplate, language: { code: a.whatsappLanguage || 'tr' }, components: [{ type: 'body', parameters: [param(`${m.brand}: ${m.title}`), param(m.link ? `${m.body} ${m.link}` : m.body)] }] } },
      { authorization: `Bearer ${a.whatsappToken}` });
      return judged(r);
    },
  },
  slack: {
    name: 'Slack', website: 'https://slack.com', docs: 'https://api.slack.com/messaging/webhooks', fields: [{ key: 'url', secret: true, placeholder: 'https://hooks.slack.com/services/…' }],
    hosts: (h) => h === 'hooks.slack.com', send: (t, m) => slackLike(t, m, chatApps.slack.hosts),
  },
  discord: {
    name: 'Discord', website: 'https://discord.com', docs: 'https://support.discord.com/hc/articles/228383668', fields: [{ key: 'url', secret: true, placeholder: 'https://discord.com/api/webhooks/…' }],
    hosts: (h) => ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(h),
    async send(t, m) {
      const u = await url(t.url, chatApps.discord.hosts);
      return u ? judged(await post(u, { username: m.brand.slice(0, 80), content: `**${m.title}**\n${m.body}${m.link ? `\n${m.link}` : ''}`.slice(0, 2000), allowed_mentions: { parse: [] } })) : badUrl;
    },
  },
  teams: {
    name: 'Microsoft Teams', website: 'https://www.microsoft.com/microsoft-teams', docs: 'https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498',
    fields: [{ key: 'url', secret: true, placeholder: 'https://….logic.azure.com/workflows/…' }],
    hosts: under('webhook.office.com', 'logic.azure.com', 'powerplatform.com', 'powerautomate.com'),
    async send(t, m) {
      const u = await url(t.url, chatApps.teams.hosts);
      if (!u) return badUrl;
      const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
        body: [{ type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true }, { type: 'TextBlock', text: m.body, wrap: true }],
        actions: m.link ? [{ type: 'Action.OpenUrl', title: m.brand, url: m.link }] : [] };
      return judged(await post(u, { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] }));
    },
  },
  googlechat: {
    name: 'Google Chat', website: 'https://chat.google.com', docs: 'https://developers.google.com/workspace/chat/quickstart/webhooks', fields: [{ key: 'url', secret: true, placeholder: 'https://chat.googleapis.com/v1/spaces/…' }],
    hosts: (h) => h === 'chat.googleapis.com',
    async send(t, m) {
      const u = await url(t.url, chatApps.googlechat.hosts);
      return u ? judged(await post(u, { text: `*${m.title}*\n${m.body}${m.link ? `\n${m.link}` : ''}` })) : badUrl;
    },
  },
  mattermost: {
    name: 'Mattermost', website: 'https://mattermost.com', docs: 'https://developers.mattermost.com/integrate/webhooks/incoming/', fields: [{ key: 'url', secret: true, placeholder: 'https://mattermost.example.com/hooks/…' }],
    send: (t, m) => slackLike(t, m),
  },
  rocketchat: {
    name: 'Rocket.Chat', website: 'https://www.rocket.chat', docs: 'https://docs.rocket.chat/docs/integrations', fields: [{ key: 'url', secret: true, placeholder: 'https://chat.example.com/hooks/…' }],
    send: (t, m) => slackLike(t, m),
  },
  matrix: {
    name: 'Matrix (Element)', website: 'https://matrix.org', docs: 'https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid',
    fields: [{ key: 'homeserver', placeholder: 'https://matrix.org' }, { key: 'roomId', placeholder: '!abc123:matrix.org' }, { key: 'accessToken', secret: true }],
    async send(t, m) {
      const base = await publicUrl(t.homeserver);
      if (!base || !/^![^:\s]+:\S+$/.test(t.roomId)) return badUrl;
      const txn = `lvm${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const r = await post(new URL(`/_matrix/client/v3/rooms/${encodeURIComponent(t.roomId)}/send/m.room.message/${txn}`, base).toString(),
        { msgtype: 'm.text', body: plain(m), format: 'org.matrix.custom.html', formatted_body: `<b>${esc(m.title)}</b><br>${esc(m.body)}${m.link ? `<br><a href="${esc(m.link)}">${esc(m.link)}</a>` : ''}` },
        { authorization: `Bearer ${t.accessToken}` }, 'PUT');
      return judged(r);
    },
  },
  ntfy: {
    name: 'ntfy', website: 'https://ntfy.sh', docs: 'https://docs.ntfy.sh/publish/#publish-as-json',
    fields: [{ key: 'url', placeholder: 'https://ntfy.sh/my-secret-topic' }, { key: 'token', secret: true, optional: true }],
    async send(t, m) {
      const u = await publicUrl(t.url);
      const topic = u?.pathname.split('/').filter(Boolean).pop();
      if (!u || !topic) return badUrl;
      const base = new URL(u.pathname.replace(/\/[^/]+\/?$/, '/') || '/', u.origin);
      return judged(await post(base.toString(), { topic, title: m.title, message: m.body, ...(m.link && { click: m.link }), tags: ['zap'] }, t.token ? { authorization: `Bearer ${t.token}` } : {}));
    },
  },
  gotify: {
    name: 'Gotify', website: 'https://gotify.net', docs: 'https://gotify.net/docs/pushmsg', fields: [{ key: 'url', placeholder: 'https://gotify.example.com' }, { key: 'token', secret: true }],
    async send(t, m) {
      const u = await publicUrl(t.url);
      if (!u) return badUrl;
      return judged(await post(new URL('message', u.toString().replace(/\/?$/, '/')).toString(),
        { title: m.title, message: m.body, priority: 5, ...(m.link && { extras: { 'client::notification': { click: { url: m.link } } } }) }, { 'x-gotify-key': t.token }));
    },
  },
  pushover: {
    name: 'Pushover', website: 'https://pushover.net', docs: 'https://pushover.net/api', needs: 'pushover', fields: [{ key: 'userKey', secret: true }],
    async send(t, m, a) {
      const r = await post('https://api.pushover.net/1/messages.json', new URLSearchParams({ token: a.pushoverToken, user: t.userKey, title: m.title.slice(0, 250), message: m.body.slice(0, 1024) || '-',
        ...(m.link && { url: m.link, url_title: m.brand }) }));
      return r.status === 400 ? { ok: false, code: 'CHAT_REJECTED', detail: r.text.slice(0, 300) } : judged(r);
    },
  },
  webhook: {
    name: 'Webhook (JSON)', website: '', docs: '', fields: [{ key: 'url', placeholder: 'https://example.com/hooks/lightning' }, { key: 'secret', secret: true, optional: true }],
    async send(t, m) {
      const u = await url(t.url);
      if (!u) return badUrl;
      const body = JSON.stringify({ event: m.event, title: m.title, body: m.body, link: m.link, brand: m.brand, sentAt: new Date().toISOString() });
      // With a secret, the receiver can check X-Lightning-Signature = sha256=HMAC(secret, raw body).
      const sig: Record<string, string> = t.secret ? { 'x-lightning-signature': `sha256=${createHmac('sha256', t.secret).update(body).digest('hex')}` } : {};
      const r = await fetch(u, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'user-agent': 'LightningVM-Webhook/1', ...sig }, body });
      return judged({ status: r.status, text: (await r.text()).slice(0, 2000) });
    },
  },
};

// The user's fields for one app: required ones present, URLs public HTTPS (and on the service's own hosts).
export async function readTarget(app: string, input: Record<string, unknown>): Promise<{ target: Record<string, string>; fields: Record<string, string>; hint: string }> {
  const a = chatApps[app];
  const target: Record<string, string> = {}, fields: Record<string, string> = {};
  for (const f of a.fields) {
    const v = typeof input[f.key] === 'string' ? (input[f.key] as string).trim() : '';
    if (!v) { if (!f.optional) fields[f.key] = 'REQUIRED'; continue; }
    if (v.length > 2000) { fields[f.key] = 'INVALID_VALUE'; continue; }
    target[f.key] = v;
  }
  for (const k of ['url', 'homeserver']) if (target[k] && !(await publicUrl(target[k], k === 'url' ? a.hosts : undefined))) fields[k] = 'CHAT_INVALID_URL';
  if (app === 'matrix' && target.roomId && !/^![^:\s]+:\S+$/.test(target.roomId)) fields.roomId = 'INVALID_VALUE';
  const u = target.url ?? target.homeserver;
  // What the list shows: the host, never the secret path of a webhook.
  const hint = u ? new URL(u).hostname + (app === 'ntfy' ? new URL(u).pathname.replace(/^(.*\/)?([^/]+)\/?$/, '/$2') : '') : '';
  return { target, fields, hint };
}
