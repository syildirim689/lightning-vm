// Messaging apps: user-given addresses must be public HTTPS (and on the service's own hosts), and each app sends
// the documented request. fetch is replaced and addresses are IP literals: no network, no DNS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const chatAppsModule = await import('../dist/chat-apps.js');
const { chatApps, privateAddress, publicUrl, readTarget } = chatAppsModule;
const m = { title: 'Ready', body: 'web-1 is up', link: 'https://panel.example.com/servers/1', brand: 'Acme', event: 'server.ready' };
const a = { telegramToken: '123:abc', whatsappToken: 'wa', whatsappPhoneId: '1055', whatsappTemplate: 'alert', whatsappLanguage: 'tr', pushoverToken: 'po' };
let seen;
function reply(status, body = '') {
  globalThis.fetch = async (url, init = {}) => { seen = { url: String(url), init, body: init.body ? String(init.body) : '' }; return new Response(status === 204 ? null : body, { status }); };
}

test('private, loopback and link-local addresses are refused; public ones pass', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '203.0.113.10', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  assert.equal(await publicUrl('http://203.0.113.10/hook'), null, 'plain HTTP');
  assert.equal(await publicUrl('https://user:pw@203.0.113.10/hook'), null, 'credentials in the URL');
  assert.equal(await publicUrl('https://169.254.169.254/latest'), null, 'metadata address');
  assert.equal(await publicUrl('https://[::1]/x'), null);
  assert.ok(await publicUrl('https://203.0.113.10/hook'));
  assert.equal(await publicUrl('https://203.0.113.10/services/x', chatApps.slack.hosts), null, 'Slack URL must be on hooks.slack.com');
});

test('fields: required ones, URL checks and a hint that never shows the secret path', async () => {
  let r = await readTarget('webhook', {});
  assert.deepEqual(r.fields, { url: 'REQUIRED' });
  r = await readTarget('webhook', { url: 'https://10.0.0.5/x' });
  assert.equal(r.fields.url, 'CHAT_INVALID_URL');
  r = await readTarget('webhook', { url: 'https://203.0.113.10/hooks/very-secret', secret: 's' });
  assert.deepEqual(r.fields, {});
  assert.equal(r.hint, '203.0.113.10');
  r = await readTarget('matrix', { homeserver: 'https://203.0.113.10', roomId: 'general', accessToken: 't' });
  assert.equal(r.fields.roomId, 'INVALID_VALUE');
});

test('webhook: JSON body signed with HMAC-SHA256 when a secret is set; redirects are not followed', async () => {
  reply(204);
  assert.deepEqual(await chatApps.webhook.send({ url: 'https://203.0.113.10/h', secret: 'k' }, m, a), { ok: true });
  const body = JSON.parse(seen.body);
  assert.equal(body.title, 'Ready'); assert.equal(body.event, 'server.ready');
  assert.equal(seen.init.headers['x-lightning-signature'], `sha256=${createHmac('sha256', 'k').update(seen.body).digest('hex')}`);
  assert.equal(seen.init.redirect, 'manual');
  reply(302);
  assert.equal((await chatApps.webhook.send({ url: 'https://203.0.113.10/h' }, m, a)).ok, false);
});

test('Telegram: HTML-escaped sendMessage; a blocked bot is reported', async () => {
  reply(200, '{"ok":true}');
  assert.deepEqual(await chatApps.telegram.send({ chatId: '42' }, { ...m, title: 'a<b>' }, a), { ok: true });
  assert.equal(seen.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  const b = JSON.parse(seen.body);
  assert.equal(b.chat_id, '42'); assert.equal(b.parse_mode, 'HTML'); assert.match(b.text, /^<b>a&lt;b&gt;<\/b>/);
  reply(403, '{"ok":false,"description":"Forbidden: bot was blocked by the user"}');
  assert.equal((await chatApps.telegram.send({ chatId: '42' }, m, a)).code, 'CHAT_TELEGRAM_BLOCKED');
});

test('WhatsApp: an approved template with the title and text as body parameters, no line breaks', async () => {
  reply(200, '{"messages":[{"id":"wamid.1"}]}');
  assert.deepEqual(await chatApps.whatsapp.send({ phone: '+905321234567' }, { ...m, body: 'line1\nline2' }, a), { ok: true });
  assert.equal(seen.url, 'https://graph.facebook.com/v21.0/1055/messages');
  const b = JSON.parse(seen.body);
  assert.equal(b.to, '905321234567'); assert.equal(b.template.name, 'alert'); assert.equal(b.template.language.code, 'tr');
  assert.deepEqual(b.template.components[0].parameters.map((p) => p.text), ['Acme: Ready', `line1 line2 ${m.link}`]);
  assert.equal(seen.init.headers.authorization, 'Bearer wa');
});

test('Pushover, ntfy, Gotify and Matrix send what their docs describe', async () => {
  reply(200, '{"status":1}');
  assert.equal((await chatApps.pushover.send({ userKey: 'u1' }, m, a)).ok, true);
  const p = new URLSearchParams(seen.body);
  assert.equal(p.get('token'), 'po'); assert.equal(p.get('user'), 'u1'); assert.equal(p.get('url'), m.link);

  reply(200, '{}');
  assert.equal((await chatApps.ntfy.send({ url: 'https://203.0.113.10/alerts', token: 'tk' }, m, a)).ok, true);
  assert.equal(seen.url, 'https://203.0.113.10/');
  assert.deepEqual(JSON.parse(seen.body), { topic: 'alerts', title: 'Ready', message: 'web-1 is up', click: m.link, tags: ['zap'] });
  assert.equal(seen.init.headers.authorization, 'Bearer tk');

  assert.equal((await chatApps.gotify.send({ url: 'https://203.0.113.10/gotify', token: 'gt' }, m, a)).ok, true);
  assert.equal(seen.url, 'https://203.0.113.10/gotify/message');
  assert.equal(seen.init.headers['x-gotify-key'], 'gt');

  assert.equal((await chatApps.matrix.send({ homeserver: 'https://203.0.113.10', roomId: '!r:example.org', accessToken: 'mx' }, m, a)).ok, true);
  assert.match(seen.url, /^https:\/\/203\.0\.113\.10\/_matrix\/client\/v3\/rooms\/!r%3Aexample\.org\/send\/m\.room\.message\/lvm/);
  assert.equal(seen.init.method, 'PUT');
});

test('errors are told apart: rejected token, missing target, anything else', async () => {
  reply(401, 'bad token');
  assert.equal((await chatApps.webhook.send({ url: 'https://203.0.113.10/h' }, m, a)).code, 'CHAT_AUTH_FAILED');
  reply(404, 'no such hook');
  assert.equal((await chatApps.webhook.send({ url: 'https://203.0.113.10/h' }, m, a)).code, 'CHAT_TARGET_NOT_FOUND');
  reply(500, 'oops');
  assert.equal((await chatApps.webhook.send({ url: 'https://203.0.113.10/h' }, m, a)).code, 'CHAT_REJECTED');
});

test('IPv4-mapped IPv6 addresses are judged as the IPv4 address they carry, in both spellings', () => {
  const { mappedV4 } = chatAppsModule;
  assert.equal(mappedV4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(mappedV4('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(mappedV4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(mappedV4('::ffff:a00:1'), '10.0.0.1');
  assert.equal(mappedV4('0:0:0:0:0:ffff:c0a8:0101'), '192.168.1.1');
  assert.equal(mappedV4('2606:4700::1111'), null);
  assert.equal(mappedV4('8.8.8.8'), null);
  for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:c0a8:0101']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808']) assert.equal(privateAddress(ip), false, ip);
});
