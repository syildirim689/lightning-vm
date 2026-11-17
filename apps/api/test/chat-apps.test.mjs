// Messaging apps: user-given addresses must be public HTTPS (and on the service's own hosts), and each app sends
// the documented request. fetch is replaced and addresses are IP literals: no network, no DNS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const chatAppsModule = await import('../dist/chat-apps.js');
const { chatApps, privateAddress, publicOnlyAgent, publicUrl, pushEndpoint, readTarget } = chatAppsModule;
const m = { title: 'Ready', body: 'web-1 is up', link: 'https://panel.example.com/servers/1', brand: 'Acme', event: 'server.ready' };
const a = { telegramToken: '123:abc', whatsappToken: 'wa', whatsappPhoneId: '1055', whatsappTemplate: 'alert', whatsappLanguage: 'tr', pushoverToken: 'po' };
let seen;
function reply(status, body = '') {
  globalThis.fetch = async (url, init = {}) => { seen = { url: String(url), init, body: init.body ? String(init.body) : '' }; return new Response(status === 204 ? null : body, { status }); };
}

test('private, loopback and link-local addresses are refused; public ones pass', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  assert.equal(await publicUrl('http://93.184.216.34/hook'), null, 'plain HTTP');
  assert.equal(await publicUrl('https://user:pw@93.184.216.34/hook'), null, 'credentials in the URL');
  assert.equal(await publicUrl('https://169.254.169.254/latest'), null, 'metadata address');
  assert.equal(await publicUrl('https://[::1]/x'), null);
  assert.ok(await publicUrl('https://93.184.216.34/hook'));
  assert.equal(await publicUrl('https://93.184.216.34/services/x', chatApps.slack.hosts), null, 'Slack URL must be on hooks.slack.com');
});

test('fields: required ones, URL checks and a hint that never shows the secret path', async () => {
  let r = await readTarget('webhook', {});
  assert.deepEqual(r.fields, { url: 'REQUIRED' });
  r = await readTarget('webhook', { url: 'https://10.0.0.5/x' });
  assert.equal(r.fields.url, 'CHAT_INVALID_URL');
  r = await readTarget('webhook', { url: 'https://93.184.216.34/hooks/very-secret', secret: 's' });
  assert.deepEqual(r.fields, {});
  assert.equal(r.hint, '93.184.216.34');
  r = await readTarget('matrix', { homeserver: 'https://93.184.216.34', roomId: 'general', accessToken: 't' });
  assert.equal(r.fields.roomId, 'INVALID_VALUE');
});

test('webhook: JSON body signed with HMAC-SHA256 when a secret is set; redirects are not followed', async () => {
  reply(204);
  assert.deepEqual(await chatApps.webhook.send({ url: 'https://93.184.216.34/h', secret: 'k' }, m, a), { ok: true });
  const body = JSON.parse(seen.body);
  assert.equal(body.title, 'Ready'); assert.equal(body.event, 'server.ready');
  assert.equal(seen.init.headers['x-lightning-signature'], `sha256=${createHmac('sha256', 'k').update(seen.body).digest('hex')}`);
  assert.equal(seen.init.redirect, 'manual');
  reply(302);
  assert.equal((await chatApps.webhook.send({ url: 'https://93.184.216.34/h' }, m, a)).ok, false);
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
  assert.equal((await chatApps.ntfy.send({ url: 'https://93.184.216.34/alerts', token: 'tk' }, m, a)).ok, true);
  assert.equal(seen.url, 'https://93.184.216.34/');
  assert.deepEqual(JSON.parse(seen.body), { topic: 'alerts', title: 'Ready', message: 'web-1 is up', click: m.link, tags: ['zap'] });
  assert.equal(seen.init.headers.authorization, 'Bearer tk');

  assert.equal((await chatApps.gotify.send({ url: 'https://93.184.216.34/gotify', token: 'gt' }, m, a)).ok, true);
  assert.equal(seen.url, 'https://93.184.216.34/gotify/message');
  assert.equal(seen.init.headers['x-gotify-key'], 'gt');

  assert.equal((await chatApps.matrix.send({ homeserver: 'https://93.184.216.34', roomId: '!r:example.org', accessToken: 'mx' }, m, a)).ok, true);
  assert.match(seen.url, /^https:\/\/93\.184\.216\.34\/_matrix\/client\/v3\/rooms\/!r%3Aexample\.org\/send\/m\.room\.message\/lvm/);
  assert.equal(seen.init.method, 'PUT');
});

test('errors are told apart: rejected token, missing target, anything else', async () => {
  reply(401, 'bad token');
  assert.equal((await chatApps.webhook.send({ url: 'https://93.184.216.34/h' }, m, a)).code, 'CHAT_AUTH_FAILED');
  reply(404, 'no such hook');
  assert.equal((await chatApps.webhook.send({ url: 'https://93.184.216.34/h' }, m, a)).code, 'CHAT_TARGET_NOT_FOUND');
  reply(500, 'oops');
  assert.equal((await chatApps.webhook.send({ url: 'https://93.184.216.34/h' }, m, a)).code, 'CHAT_REJECTED');
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

test('the agent for library-made requests (web push) refuses names that resolve to a private address', async () => {
  const { publicOnlyAgent } = chatAppsModule;
  const lookup = publicOnlyAgent.options.lookup;
  const err = await new Promise((resolve) => lookup('localhost', { all: true }, (e) => resolve(e)));
  assert.equal(err?.name, 'NotPublic');
  const one = await new Promise((resolve) => lookup('localhost', {}, (e) => resolve(e)));
  assert.equal(one?.name, 'NotPublic');
});

test('ranges that only look public are refused too: IPv6 forms that carry an IPv4 address, relay, discard and documentation ranges', () => {
  for (const ip of ['::7f00:1', '::a9fe:a9fe', '::', '::ffff:0:7f00:1', '64:ff9b:1::a00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '2002:a00:1::1', '2001:0:4136:e378::1', 'fec0::1', '100::1',
    '2001:db8::1', '3fff::1', '192.0.2.1', '198.51.100.7', '203.0.113.10', '192.88.99.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '2001:4860:4860::8888', '2a00:1450:4001::1', '64:ff9c::1']) assert.equal(privateAddress(ip), false, ip);
});

test('a push endpoint is HTTPS on a plain host name, kept as the address that was checked', async () => {
  // Refused before anything is resolved: an address written as a number, and hosts two URL readers would split differently.
  for (const bad of ['https://93.184.216.34/push/abc', 'https://[2606:4700::1111]/push/abc', 'https://127.0.0.1%2Ename.example/x', 'https://127.0.0.1;name.example/x', 'https://name.example%2F@127.0.0.1/x',
    'https://user:pw@push.example.com/x', 'http://push.example.com/x', 'https://push.example.com', 'https://2130706433/x', 'https://0x7f.1/x', 'https://localhost/x', 'https://push/x', 42, null]) {
    assert.equal(await pushEndpoint(bad), null, String(bad));
  }
});

test('the agent for library requests refuses an internal address written as a number before any socket is made', async () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', '[::ffff:10.0.0.1]', '']) {
    const err = await new Promise((resolve) => publicOnlyAgent.createConnection({ host, port: 443 }, (e) => resolve(e)));
    assert.equal(err?.name, 'NotPublic', host);
    assert.throws(() => publicOnlyAgent.createConnection({ host, port: 443 }), { name: 'NotPublic' }, host);
  }
});
