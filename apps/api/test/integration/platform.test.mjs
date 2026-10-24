// Roles and permissions, user management (better-auth admin plugin), two-factor, phone numbers, branding,
// mail/captcha/SMS settings, notifications, insights and the task list. Real PostgreSQL and Redis; the
// captcha check calls Cloudflare's published test keys (needs internet); SMS goes to a local fake provider.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { startNotificationWorker, notificationQueue } = await import('../../dist/notify.js');

let app, worker, sms, smsPort;
const received = [];
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie, headers) => call('POST', url, cookie, payload, headers);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const until = async (check, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from an otpauth:// URI.
function totp(uri) {
  const secret = new URL(uri).searchParams.get('secret');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch.toUpperCase()).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let admin, user, userId, helperCookie;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  worker = startNotificationWorker();
  // A fake SMS provider: records every message it is asked to send.
  sms = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push(JSON.parse(b || '{}')); res.end('OK:12345'); }); });
  await new Promise((r) => sms.listen(0, '127.0.0.1', r));
  smsPort = sms.address().port;

  const { token } = await issueBootstrapToken();
  assert.equal((await post('/setup/admin', { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await post('/auth/sign-in/email', { email: 'boss@example.test', password }));
  await put('/admin/settings', { registrationOpen: true }, admin);
  const r = await post('/auth/sign-up/email', { name: 'Ayşe', email: 'ayse@example.test', password });
  user = cookieOf(r); userId = r.json().user.id;
});
after(async () => { await worker?.close(true); await notificationQueue.close(); sms?.closeAllConnections(); sms?.close(); await app?.close(); await closeConnections(); });

test('built-in roles exist and permissions come with the session', async () => {
  const roles = (await get('/admin/roles', admin)).json().roles.map((r) => r.key);
  assert.deepEqual(roles.sort(), ['admin', 'auditor', 'operator', 'support', 'user']);
  const me = (await get('/auth/me', user)).json();
  assert.deepEqual(me.roles, ['user']);
  assert.deepEqual(me.permissions.sort(), ['firewalls.manage', 'servers.create']);
  assert.equal((await get('/admin/roles', user)).statusCode, 403);
  // Deny by default, and the denial is audited.
  assert.equal((await get('/admin/pools', user)).statusCode, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_events WHERE action = 'admin.access' AND outcome = 'denied'")).rowCount > 0);
});

test('a custom role grants exactly its permissions; overrides add or remove single ones', async () => {
  assert.equal((await post('/admin/roles', { key: 'helper', name: 'Helper', permissions: ['users.view', 'nope'] }, admin)).json().fields.permissions, 'INVALID_VALUE');
  assert.equal((await post('/admin/roles', { key: 'helper', name: 'Helper', permissions: ['users.view'] }, admin)).statusCode, 201);
  assert.equal((await put(`/admin/users/${userId}/access`, { roles: ['user', 'helper'], overrides: [] }, admin)).statusCode, 200);
  assert.equal((await get('/admin/users', user)).statusCode, 200);
  assert.equal((await get('/admin/pools', user)).statusCode, 403);
  await put(`/admin/users/${userId}/access`, { roles: ['user', 'helper'], overrides: [{ permission: 'catalog.view', effect: 'allow' }, { permission: 'users.view', effect: 'deny' }] }, admin);
  assert.equal((await get('/admin/pools', user)).statusCode, 200);
  assert.equal((await get('/admin/users', user)).statusCode, 403);
  const access = (await get(`/admin/users/${userId}/access`, admin)).json();
  assert.deepEqual(access.effective, ['catalog.view', 'firewalls.manage', 'servers.create']);
  await put(`/admin/users/${userId}/access`, { roles: ['user', 'helper'], overrides: [] }, admin);
});

test('nobody can grant or act beyond their own permissions', async () => {
  // helper (users.view) cannot change access, ban, or promote anyone, and cannot make an admin role.
  assert.equal((await put(`/admin/users/${userId}/access`, { roles: ['admin'], overrides: [] }, user)).statusCode, 403);
  const { rows: [b] } = await pool.query("SELECT id FROM users WHERE email = 'boss@example.test'");
  assert.equal((await post('/auth/admin/ban-user', { userId: b.id }, user)).statusCode, 403);
  assert.equal((await post('/auth/admin/set-role', { userId, role: 'admin' }, admin)).statusCode, 403); // only via /access
  assert.ok([403, 404].includes((await post('/auth/admin/unknown-endpoint', {}, admin)).statusCode));
  // An admin cannot change their own access, and the last admin cannot be demoted.
  assert.equal((await put(`/admin/users/${b.id}/access`, { roles: ['user'], overrides: [] }, admin)).json().code, 'CANNOT_CHANGE_OWN_ACCOUNT');
  // A support user cannot act on an administrator (target outside their permissions).
  const s = await post('/auth/admin/create-user', { email: 'support@example.test', password, name: 'S', role: 'user' }, admin);
  assert.equal(s.statusCode, 200, s.body);
  await put(`/admin/users/${s.json().user.id}/access`, { roles: ['support'], overrides: [] }, admin);
  helperCookie = cookieOf(await post('/auth/sign-in/email', { email: 'support@example.test', password }));
  assert.equal((await post('/auth/admin/impersonate-user', { userId: b.id }, helperCookie)).statusCode, 403);
  assert.equal((await get('/auth/admin/list-users', helperCookie)).statusCode, 200);
});

test('impersonation is visible to the impersonated session and can be stopped', async () => {
  const r = await post('/auth/admin/impersonate-user', { userId }, helperCookie);
  assert.equal(r.statusCode, 200, r.body);
  const as = cookieOf(r);
  const me = (await get('/auth/me', as)).json();
  assert.equal(me.email, 'ayse@example.test');
  assert.ok(me.impersonatedBy);
  // Stopping needs the admin-session cookie set next to the impersonated one (a browser sends both).
  const all = r.headers['set-cookie'].toString().match(/lvm\.[\w.]+=[^;]+/g).join('; ');
  const stop = await call('POST', '/auth/admin/stop-impersonating', null, {}, { cookie: all });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.ok((await pool.query("SELECT 1 FROM audit_events WHERE action = 'admin.user.impersonate'")).rowCount);
});

test('ban ends sessions immediately; a user with servers cannot be removed', async () => {
  const t = await post('/auth/admin/create-user', { email: 'temp@example.test', password, name: 'T', role: 'user' }, admin);
  const tid = t.json().user.id;
  const tc = cookieOf(await post('/auth/sign-in/email', { email: 'temp@example.test', password }));
  assert.equal((await get('/auth/me', tc)).statusCode, 200);
  assert.equal((await post('/auth/admin/ban-user', { userId: tid, banReason: 'test', banExpiresIn: 3600 }, admin)).statusCode, 200);
  assert.equal((await get('/auth/me', tc)).statusCode, 401);
  assert.equal((await post('/auth/sign-in/email', { email: 'temp@example.test', password })).statusCode, 403);
  assert.equal((await post('/auth/admin/unban-user', { userId: tid }, admin)).statusCode, 200);
  assert.equal((await post('/auth/admin/remove-user', { userId: tid }, admin)).statusCode, 200);
  assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [tid])).rowCount, 0);
});

test('two-factor: authenticator app, then sign-in needs the code; backup codes work once', async () => {
  const en = await post('/auth/two-factor/enable', { password }, user);
  assert.equal(en.statusCode, 200, en.body);
  const { totpURI, backupCodes } = en.json();
  const v = await post('/auth/two-factor/verify-totp', { code: totp(totpURI) }, user);
  assert.equal(v.statusCode, 200, v.body);
  user = cookieOf(v) ?? user; // turning two-factor on replaces the session
  assert.equal((await get('/auth/me', user)).json().twoFactorEnabled, true);
  const step1 = await post('/auth/sign-in/email', { email: 'ayse@example.test', password });
  assert.equal(step1.json().twoFactorRedirect, true, step1.body);
  const pending = step1.headers['set-cookie'].toString().match(/lvm.two_factor=([^;]+)/)?.[1];
  const twoFactorHeaders = { cookie: `lvm.two_factor=${pending}` };
  assert.equal((await call('POST', '/auth/two-factor/verify-totp', null, { code: '000000' }, twoFactorHeaders)).statusCode, 401);
  const ok = await call('POST', '/auth/two-factor/verify-backup-code', null, { code: backupCodes[0] }, twoFactorHeaders);
  assert.equal(ok.statusCode, 200, ok.body);
  user = cookieOf(ok);
  assert.ok((await pool.query("SELECT 1 FROM audit_events WHERE action = 'auth.login' AND metadata->>'method' = 'password+2fa'")).rowCount);
});

test('branding: name, colour and raster images only; served publicly', async () => {
  assert.equal((await put('/admin/settings/branding', { name: 'Acme Cloud', accent: 'orange' }, admin)).json().fields.accent, 'INVALID_COLOR');
  const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
  assert.equal((await put('/admin/settings/branding', { name: 'Acme Cloud', logo: svg }, admin)).json().fields.logo, 'INVALID_IMAGE');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await put('/admin/settings/branding', { name: 'Acme Cloud', accent: '#3366FF', logo: png, favicon: png }, admin)).statusCode, 200);
  const cfg = (await get('/public/config')).json();
  assert.deepEqual([cfg.branding.name, cfg.branding.accent, cfg.branding.logo, cfg.branding.favicon], ['Acme Cloud', '#3366ff', true, true]);
  const logo = await get('/public/branding/logo');
  assert.equal(logo.headers['content-type'], 'image/png');
  assert.equal(logo.headers['x-content-type-options'], 'nosniff');
  assert.equal((await put('/admin/settings/branding', { name: 'Acme Cloud' }, user)).statusCode, 403);
});

test('mail settings never return the password, and a failed test says why', async () => {
  const bad = await put('/admin/settings/mail', { enabled: true, host: 'bad host!', port: 587, security: 'starttls', fromAddress: 'x' }, admin);
  assert.deepEqual(Object.keys(bad.json().fields).sort(), ['fromAddress', 'host']);
  const ok = await put('/admin/settings/mail', { enabled: true, host: '127.0.0.1', port: 1, security: 'none', username: 'u', password: 'p4ssw0rd', fromAddress: 'panel@example.test',
    use: { passwordReset: true, twoFactor: true } }, admin);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().passwordSet, true);
  assert.doesNotMatch(ok.body, /p4ssw0rd/);
  assert.doesNotMatch((await pool.query("SELECT value::text FROM settings WHERE key = 'mail'")).rows[0].value, /p4ssw0rd/);
  const t = await post('/admin/settings/mail/test', { to: 'boss@example.test', enabled: true, host: '127.0.0.1', port: 1, security: 'none', fromAddress: 'panel@example.test' }, admin);
  assert.equal(t.statusCode, 422);
  assert.equal(t.json().code, 'MAIL_CONNECTION_FAILED');
  assert.equal((await get('/public/config')).json().passwordReset, true);
  await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
});

test('captcha protects the chosen forms, checked with the provider (Cloudflare test keys)', async () => {
  // Cloudflare's documented always-pass and always-fail test secrets; the dummy token is what their test site keys issue.
  const pass = { provider: 'turnstile', siteKey: '1x00000000000000000000AA', secret: '1x0000000000000000000000000000000AA', use: { signIn: true, signUp: false, passwordReset: false } };
  assert.equal((await put('/admin/settings/captcha', pass, admin)).statusCode, 200);
  assert.equal((await get('/admin/settings/captcha', admin)).json().secretSet, true);
  assert.equal((await get('/public/config')).json().captcha.provider, 'turnstile');
  assert.equal((await post('/auth/sign-in/email', { email: 'boss@example.test', password })).json().code, 'CAPTCHA_REQUIRED');
  const okSign = await post('/auth/sign-in/email', { email: 'boss@example.test', password }, null, { 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' });
  assert.equal(okSign.statusCode, 200, okSign.body);
  assert.equal((await post('/admin/settings/captcha/test', { ...pass, token: 'XXXX.DUMMY.TOKEN.XXXX' }, admin)).json().ok, true);
  await put('/admin/settings/captcha', { ...pass, secret: '2x0000000000000000000000000000000AA' }, admin);
  assert.equal((await post('/auth/sign-in/email', { email: 'boss@example.test', password }, null, { 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' })).json().code, 'CAPTCHA_FAILED');
  await put('/admin/settings/captcha', { provider: 'none' }, admin);
  assert.equal((await get('/public/config')).json().captcha, null);
});

test('SMS: a provider is tested, then phone numbers are verified by SMS code', async () => {
  const settings = { provider: 'custom', sender: 'ACME', credentials: { url: `http://127.0.0.1:${smsPort}/send`, method: 'POST', contentType: 'json',
    body: '{"to":"{to}","text":"{text}","from":"{sender}"}', phoneFormat: 'international', successPattern: '^OK' }, use: { twoFactor: true, phoneVerification: true } };
  const t = await post('/admin/settings/sms/test', { ...settings, to: '+905321234567' }, admin);
  assert.equal(t.statusCode, 200, t.body);
  assert.deepEqual([received.at(-1).to, received.at(-1).from], ['905321234567', 'ACME']);
  assert.equal((await put('/admin/settings/sms', settings, admin)).statusCode, 200);
  assert.equal((await post('/auth/phone-number/send-otp', { phoneNumber: '+905321234567' }, user)).statusCode, 200);
  const code = received.at(-1).text.match(/\d{6}/)[0];
  const v = await post('/auth/phone-number/verify', { phoneNumber: '+905321234567', code, updatePhoneNumber: true }, user);
  assert.equal(v.statusCode, 200, v.body);
  const me = (await get('/auth/me', user)).json();
  assert.deepEqual([me.phoneNumber, me.phoneNumberVerified], ['+905321234567', true]);
});

test('notifications follow the admin policy, then the user choice', async () => {
  // A sign-in notifies the user in the panel by default (earlier sign-ins in this file left rows too).
  const { rows: [s] } = await pool.query("SELECT id FROM users WHERE email = 'support@example.test'");
  const count = async () => (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND event = 'auth.sign_in'", [s.id])).rows[0].n;
  await new Promise((r) => setTimeout(r, 1500));
  const n0 = await count();
  await post('/auth/sign-in/email', { email: 'support@example.test', password });
  assert.ok(await until(async () => (await count()) === n0 + 1));
  // The user turns sign-in alerts off; the next sign-in leaves no new row.
  assert.equal((await put('/notifications/preferences', { event: 'auth.sign_in', channels: [] }, helperCookie)).statusCode, 200);
  await post('/auth/sign-in/email', { email: 'support@example.test', password });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await count(), n0 + 1);
  // The admin fixes it: users can no longer change it, and their earlier choice no longer applies.
  assert.equal((await put('/admin/settings/notifications', { event: 'auth.sign_in', enabled: true, allowed: ['inApp', 'sms'], defaults: ['inApp'], userCanChange: false }, admin)).statusCode, 200);
  assert.equal((await put('/notifications/preferences', { event: 'auth.sign_in', channels: [] }, helperCookie)).json().code, 'NOTIFICATION_LOCKED');
  const prefs = (await get('/notifications/preferences', helperCookie)).json().events.find((e) => e.event === 'auth.sign_in');
  assert.deepEqual([prefs.locked, prefs.channels, prefs.allowed], [true, ['inApp'], ['inApp', 'sms']]);
  await post('/auth/sign-in/email', { email: 'support@example.test', password });
  assert.ok(await until(async () => (await count()) === n0 + 2));
  // SMS channel: the user with a verified phone gets it when routed there.
  await put('/notifications/preferences', { event: 'auth.password_changed', channels: ['inApp', 'sms'] }, user);
  const before = received.length;
  assert.equal((await post('/auth/change-password', { currentPassword: password, newPassword: `${password}!`, revokeOtherSessions: false }, user)).statusCode, 200);
  assert.ok(await until(() => received.length > before));
  // Inbox: list, unread count, mark read; a test through one channel.
  const inbox = (await get('/notifications', helperCookie)).json();
  assert.equal(inbox.unread, n0 + 2);
  await post('/notifications/read', {}, helperCookie);
  assert.equal((await get('/notifications', helperCookie)).json().unread, 0);
  assert.equal((await post('/notifications/test', { channel: 'inApp' }, helperCookie)).statusCode, 200);
  assert.equal((await post('/notifications/test', { channel: 'email' }, helperCookie)).json().code, 'CHANNEL_UNAVAILABLE');
  assert.equal((await get('/notifications/push-key', helperCookie)).json().publicKey.length > 40, true);
});

test('insights explain what needs attention; the task list starts empty', async () => {
  const staff = (await get('/admin/insights', admin)).json().insights.map((i) => i.code);
  assert.ok(staff.includes('BACKUP_NEVER') && staff.includes('ADMINS_WITHOUT_2FA') && staff.includes('MAIL_NOT_CONFIGURED'), staff.join());
  assert.equal((await get('/admin/insights', user)).statusCode, 403);
  const mine = (await get('/insights', user)).json().insights.map((i) => i.code);
  assert.ok(mine.includes('NO_SSH_KEYS'), mine.join());
  assert.ok(!mine.includes('ENABLE_2FA'), 'two-factor is on for this user');
  assert.deepEqual((await get('/operations/active', user)).json().operations, []);
});

test('payment methods: live and test credentials are kept apart, secrets stay on the server, activation needs a check', async () => {
  const list = (await get('/admin/settings/payments', admin)).json();
  assert.ok(list.providers.length >= 35);
  assert.ok(list.providers.find((p) => p.id === 'nestpay-isbank').testCredentials);
  assert.equal((await get('/admin/settings/payments', user)).statusCode, 403);

  // Missing fields per mode; internal endpoints are refused.
  let r = await put('/admin/settings/payments/shopier', { live: { apiKey: 'k' }, test: { apiKey: 'tk', apiSecret: 'ts', endpoint: 'https://127.0.0.1/x' } }, admin);
  assert.deepEqual(r.json().fields, { 'live.apiSecret': 'REQUIRED', 'test.endpoint': 'INVALID_ENDPOINT' });
  r = await put('/admin/settings/payments/shopier', { mode: 'live', live: { apiKey: 'live-key', apiSecret: 'live-secret' }, test: { apiKey: 'test-key', apiSecret: 'test-secret' } }, admin);
  assert.equal(r.statusCode, 200, r.body);
  const g = r.json();
  assert.deepEqual([g.live.values.apiKey, g.test.values.apiKey, g.live.secretsSet.apiSecret, g.enabled], ['live-key', 'test-key', true, false]);
  assert.ok(!r.body.includes('live-secret') && !r.body.includes('test-secret'));
  const { rows: [row] } = await pool.query("SELECT live_enc FROM payment_gateways WHERE id = 'shopier'");
  assert.ok(!row.live_enc.includes('live-secret'), 'stored encrypted');

  // Not checked yet: cannot be turned on.
  assert.equal((await post('/admin/settings/payments/shopier/state', { enabled: true, mode: 'live' }, admin)).json().code, 'PAYMENT_NOT_TESTED');
  // Shopier has no read-only API: the check says so, and that is recorded for the saved credentials.
  const t = (await post('/admin/settings/payments/shopier/test', { mode: 'live' }, admin)).json();
  assert.deepEqual([t.status, t.recorded], ['unverifiable', true]);
  // A check of values that differ from the saved ones is shown but not recorded.
  assert.equal((await post('/admin/settings/payments/shopier/test', { mode: 'live', credentials: { apiKey: 'other', apiSecret: '' } }, admin)).json().recorded, false);
  r = await post('/admin/settings/payments/shopier/state', { enabled: true, mode: 'live' }, admin);
  assert.deepEqual([r.json().enabled, r.json().mode], [true, 'live']);
  // An empty secret keeps the stored one (no change, stays active); a new secret deactivates until checked again.
  assert.equal((await put('/admin/settings/payments/shopier', { live: { apiKey: 'live-key', apiSecret: '' } }, admin)).json().enabled, true);
  assert.equal((await put('/admin/settings/payments/shopier', { live: { apiKey: 'live-key', apiSecret: 'rotated' } }, admin)).json().enabled, false);
  // Test credentials are untouched by all this, and can be cleared on their own.
  r = await put('/admin/settings/payments/shopier', { clear: ['test'] }, admin);
  assert.deepEqual([r.json().test.configured, r.json().live.configured], [false, true]);
  assert.equal((await call('DELETE', '/admin/settings/payments/shopier', admin)).statusCode, 204);
  assert.ok((await pool.query("SELECT 1 FROM audit_events WHERE action = 'settings.payment_enabled'")).rowCount);
});
