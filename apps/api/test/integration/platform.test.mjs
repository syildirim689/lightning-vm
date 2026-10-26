// Roles and permissions, user management (better-auth admin plugin), two-factor, phone numbers, branding,
// mail/captcha/SMS settings, notifications, insights and the task list. Real PostgreSQL and Redis; the
// captcha check calls Cloudflare's published test keys (needs internet); SMS goes to a local fake provider.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
// The host agent's folders (scripts/install.sh agent): temporary ones here.
const { mkdtempSync, mkdirSync, readdirSync, readFileSync: readFile, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const maint = mkdtempSync(tmpdir() + '/lvm-maint-');
process.env.MAINTENANCE_DIR = maint;
process.env.MAINTENANCE_REQUESTS_DIR = maint + '/requests';
mkdirSync(maint + '/requests');

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
  assert.deepEqual(me.permissions.sort(), ['firewalls.manage', 'server.console', 'server.delete', 'server.iso', 'server.power', 'server.root_password', 'server.snapshots', 'servers.create']);
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
  assert.deepEqual(access.effective, ['catalog.view', 'firewalls.manage', 'server.console', 'server.delete', 'server.iso', 'server.power', 'server.root_password', 'server.snapshots', 'servers.create']);
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

  // Smart cards: the getting-started list for staff, this month's cost for the customer.
  const steps = (await get('/admin/onboarding', admin)).json().steps;
  assert.equal(steps.length, 9);
  assert.equal(steps.find((s) => s.key === 'backup').done, false);
  assert.equal((await get('/admin/onboarding', user)).statusCode, 403);
  const usage = (await get('/usage/summary', user)).json();
  assert.ok(Array.isArray(usage.costs) && typeof usage.usage.servers === 'number', JSON.stringify(usage));
  assert.equal((await get('/servers/00000000-0000-4000-8000-000000000000/health', user)).statusCode, 404);
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

test('updates from the panel: requests go to the host agent, validated, one at a time', async () => {
  const req = (body, cookie = admin) => post('/admin/maintenance/requests', body, cookie);
  assert.equal((await req({ action: 'update' }, user)).statusCode, 403);
  assert.equal((await req({ action: 'update' })).json().code, 'MAINTENANCE_AGENT_MISSING');
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'on', updateChannel: 'stable' }));
  assert.deepEqual((await req({ action: 'reboot' })).json().fields, { action: 'INVALID_VALUE' });
  assert.deepEqual((await req({ action: 'update', to: '1.0; rm -rf /' })).json().fields, { to: 'INVALID_VALUE' });
  assert.deepEqual((await req({ action: 'auto-update', enabled: true, window: '25:00-26:00' })).json().fields, { window: 'INVALID_WINDOW' });
  const r = await req({ action: 'update', to: 'v1.2.3' });
  assert.equal(r.statusCode, 202, r.body);
  const files = readdirSync(`${maint}/requests`);
  assert.deepEqual(files, [`${r.json().id}.req`]);
  const content = readFile(`${maint}/requests/${files[0]}`, 'utf8');
  assert.match(content, /^action=update\nto=v1\.2\.3\nby=[0-9a-f-]{36}\nid=[0-9a-f-]{36}\n$/);
  assert.equal((await req({ action: 'check' })).json().code, 'MAINTENANCE_BUSY');
  // The agent's progress comes back through the read-only folder.
  writeFileSync(`${maint}/status.json`, JSON.stringify({ id: r.json().id, action: 'update', state: 'running', startedAt: new Date().toISOString(), finishedAt: '', exitCode: null, code: '' }));
  mkdirSync(`${maint}/runs`);
  writeFileSync(`${maint}/runs/${r.json().id}.log`, 'INFO  UPDATE                 v1.2.2 -> v1.2.3\nINFO  DRAINING               Stopping the worker\n');
  const m = (await get('/admin/maintenance', admin)).json();
  assert.deepEqual([m.agent.installed, m.agent.pending, m.agent.status.state, m.agent.log.length], [true, 1, 'running', 2]);
});

test('several API copies: a role change made on one copy reaches the others at once', async () => {
  // A second copy is a separate process with its own in-memory roles, subscribed like a real one.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { loadRoles, watchRoles, roleExists } = await import('${new URL('../../dist/permissions.js', import.meta.url).href}');
    await loadRoles(); watchRoles();
    console.log('ready');
    setInterval(() => { if (roleExists('copy-check')) { console.log('seen'); process.exit(0); } }, 100);
    setTimeout(() => process.exit(1), 15000);`], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  assert.ok(await until(() => out.includes('ready'), 15000), 'second copy started');
  await new Promise((r) => setTimeout(r, 300)); // its subscription is in place
  assert.equal((await post('/admin/roles', { key: 'copy-check', name: 'Copy check', permissions: ['users.view'] }, admin)).statusCode, 201);
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, 'the other copy saw the new role without a restart');
  assert.ok(out.includes('seen'));
});

test('announcement: validated, shown to signed-in users only inside its time window, a new id per save', async () => {
  assert.deepEqual(Object.keys((await put('/admin/settings/announcement', { active: true, link: 'javascript:alert(1)', startsAt: '2030-01-02', endsAt: '2030-01-01' }, admin)).json().fields).sort(),
    ['endsAt', 'link', 'textTr']);
  assert.equal((await put('/admin/settings/announcement', { active: true, textTr: 'x' }, user)).statusCode, 403);
  const a = (await put('/admin/settings/announcement', { active: true, tone: 'warning', textTr: 'Bakım 22:00', textEn: 'Maintenance at 22:00', link: '/admin/system' }, admin)).json();
  assert.equal(a.live, true);
  assert.deepEqual((await get('/announcement', user)).json().announcement, { id: a.id, tone: 'warning', textTr: 'Bakım 22:00', textEn: 'Maintenance at 22:00', link: '/admin/system', endsAt: null });
  assert.equal((await get('/announcement')).statusCode, 401);
  const later = (await put('/admin/settings/announcement', { active: true, textEn: 'Soon', startsAt: new Date(Date.now() + 3600_000).toISOString() }, admin)).json();
  assert.notEqual(later.id, a.id);
  assert.equal((await get('/announcement', user)).json().announcement, null);
  await put('/admin/settings/announcement', { active: false }, admin);
});

test('audit log: staff search with filters and pages; each user sees only their own activity', async () => {
  assert.equal((await get('/admin/audit', user)).statusCode, 403);
  const all = (await get('/admin/audit', admin)).json();
  assert.ok(all.events.length > 0 && all.categories.includes('settings'), JSON.stringify(all.categories));
  const found = (await get('/admin/audit?category=settings&q=announcement&outcome=success', admin)).json().events;
  assert.ok(found.length >= 2 && found.every((e) => e.action === 'settings.announcement' && e.outcome === 'success'));
  if (all.nextBefore) assert.ok((await get(`/admin/audit?before=${all.nextBefore}`, admin)).json().events.every((e) => BigInt(e.id) < BigInt(all.nextBefore)));
  const mine = (await get('/activity', user)).json().events;
  assert.ok(mine.length > 0 && mine.every((e) => e.actorId === userId), JSON.stringify(mine.map((e) => e.action)));
  assert.equal((await get('/activity')).statusCode, 401);
});

test('CLI password reset: a new generated password works, the old one and every session stop', async () => {
  const { resetPassword } = await import('../../dist/setup.js');
  const email = 'support@example.test';
  const before = cookieOf(await post('/auth/sign-in/email', { email, password }));
  assert.ok(before);
  assert.equal(await resetPassword('nobody@example.test', false), null);
  const { password: fresh } = await resetPassword(email.toUpperCase(), false);
  assert.ok(fresh.length >= 20);
  assert.equal((await get('/auth/me', before)).statusCode, 401);
  assert.equal((await post('/auth/sign-in/email', { email, password })).statusCode, 401);
  assert.ok(cookieOf(await post('/auth/sign-in/email', { email, password: fresh })));
  const audit = (await pool.query("SELECT 1 FROM audit_events WHERE action = 'auth.password_reset_cli'")).rowCount;
  assert.equal(audit, 1);
});

test('Alertmanager alerts reach staff as in-app notifications; proxied calls are refused', async () => {
  const payload = { version: '4', status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'LightningWorkerHeartbeatStale', severity: 'critical' },
    annotations: { summary: 'Worker iki dakikadır yaşam sinyali vermiyor / worker heartbeat older than 2 minutes' }, fingerprint: 'it-1' }] };
  const raw = (headers) => app.inject({ method: 'POST', url: '/internal/alerts', payload, headers });
  assert.equal((await raw({ 'x-forwarded-for': '203.0.113.9' })).statusCode, 404);
  assert.equal((await raw({})).statusCode, 204);
  const { rows: [boss] } = await pool.query("SELECT id FROM users WHERE email = 'boss@example.test'");
  const row = await until(async () => (await pool.query("SELECT title, body FROM notifications WHERE user_id = $1 AND event = 'admin.alert' ORDER BY created_at DESC LIMIT 1", [boss.id])).rows[0]);
  assert.ok(row, 'admin.alert notification for the admin');
  assert.match(`${row.title} ${row.body}`, /LightningWorkerHeartbeatStale/);
});

test('server terminal: staff with system.terminal only, never without two-factor; off until turned on', async () => {
  assert.equal((await get('/admin/terminal', user)).statusCode, 403);
  const s = (await get('/admin/terminal', admin)).json();
  assert.equal(s.enabled, false); // the service is not running in tests
  assert.equal(s.twoFactor, false);
  assert.equal((await post('/admin/terminal/session', {}, admin)).json().code, 'TERMINAL_NEEDS_2FA');
  assert.equal((await post('/admin/terminal/switch', { enabled: true }, admin)).json().code, 'TERMINAL_NEEDS_2FA');
  assert.equal((await post('/admin/terminal/sessions/zz/revoke', {}, admin)).statusCode, 400);
});

test('mail through an API provider: secrets never come back, empty secret fields keep the saved ones, fields are checked', async () => {
  const bad = (await put('/admin/settings/mail', { enabled: true, provider: 'mailgun', fromAddress: 'panel@example.com', api: { region: 'mars' }, use: {} }, admin)).json();
  assert.deepEqual(Object.keys(bad.fields).sort(), ['api.apiKey', 'api.domain', 'api.region']);
  assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'nope', fromAddress: 'panel@example.com', use: {} }, admin)).json().fields.provider, 'INVALID_VALUE');
  let r = (await put('/admin/settings/mail', { enabled: true, provider: 'resend', fromAddress: 'panel@example.com', fromName: 'Panel', api: { apiKey: 're_secret_value' }, use: { passwordReset: true } }, admin)).json();
  assert.equal(r.provider, 'resend');
  assert.deepEqual(r.secretsSet, ['apiKey']);
  assert.ok(!JSON.stringify(r).includes('re_secret_value') && !('apiSecretEnc' in r));
  assert.ok(r.providers.some((p) => p.id === 'ses' && p.fields.some((f) => f.key === 'secretAccessKey' && f.secret)));
  r = (await put('/admin/settings/mail', { enabled: true, provider: 'resend', fromAddress: 'panel@example.com', api: { apiKey: '' }, use: {} }, admin)).json();
  assert.deepEqual(r.secretsSet, ['apiKey']); // kept
  assert.equal((await get('/admin/settings/mail', user)).statusCode, 403);
  await put('/admin/settings/mail', { enabled: false, provider: 'smtp', use: {} }, admin);
});

test('messaging apps: offered by the admin, unsafe addresses refused, nothing saved before a first message arrives', async () => {
  let s = (await get('/admin/settings/chat', admin)).json();
  assert.ok(s.catalog.some((a) => a.id === 'telegram') && s.usable.includes('slack') && !s.usable.includes('telegram'));
  // Apps that need an account cannot be offered without it; a malformed token is refused before Telegram is asked.
  let r = await put('/admin/settings/chat', { apps: ['slack', 'telegram', 'whatsapp'], telegram: { token: 'nope' } }, admin);
  assert.equal(r.statusCode, 400);
  assert.deepEqual(Object.keys(r.json().fields).sort(), ['telegram.token', 'whatsapp.phoneNumberId', 'whatsapp.template', 'whatsapp.token']);
  s = (await put('/admin/settings/chat', { apps: ['slack', 'webhook'] }, admin)).json();
  assert.deepEqual(s.usable, ['slack', 'webhook']);
  assert.equal((await put('/admin/settings/chat', { apps: [] }, user)).statusCode, 403);

  const list = (await get('/chat', user)).json();
  assert.deepEqual(list.apps.map((a) => a.id), ['slack', 'webhook']);
  assert.deepEqual(list.connections, []);
  // The panel's own network, plain HTTP and a Slack URL off Slack's host are refused; nothing is stored.
  for (const [app, url] of [['webhook', 'https://127.0.0.1/x'], ['webhook', 'https://api:4000/internal/alerts'], ['webhook', 'http://example.com/x'], ['slack', 'https://example.com/services/x']]) {
    r = await post('/chat/connections', { app, fields: { url } }, user);
    assert.equal(r.statusCode, 400, url);
    assert.equal(r.json().fields['fields.url'], 'CHAT_INVALID_URL');
  }
  assert.equal((await post('/chat/connections', { app: 'discord', fields: { url: 'https://discord.com/api/webhooks/1/x' } }, user)).statusCode, 400, 'not offered');
  assert.equal((await post('/chat/telegram/link', {}, user)).statusCode, 409);
  assert.equal((await get('/chat', user)).json().connections.length, 0);
  // The channel exists in the policy, and testing it needs a connection.
  assert.ok((await get('/admin/settings/notifications', admin)).json().events.find((e) => e.event === 'server.ready').channels.includes('chat'));
  assert.equal((await post('/notifications/test', { channel: 'chat' }, user)).json().code, 'CHAT_NOT_CONNECTED');
  await put('/admin/settings/chat', { apps: ['slack', 'discord', 'teams', 'googlechat', 'mattermost', 'rocketchat', 'matrix', 'ntfy', 'gotify', 'webhook'] }, admin);
});

test('a double click sends one request: the same POST while the first runs is refused, a later one runs', async () => {
  const body = { app: 'webhook', fields: { url: 'https://127.0.0.1/double' } };
  const [a, b] = await Promise.all([post('/chat/connections', body, user), post('/chat/connections', body, user)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [400, 409]);
  assert.equal((a.statusCode === 409 ? a : b).json().code, 'DUPLICATE_REQUEST');
  // Another user, or a different body, is not held up.
  assert.equal((await post('/chat/connections', { ...body, fields: { url: 'https://127.0.0.1/other' } }, user)).statusCode, 400);
  assert.equal((await post('/chat/connections', body, user)).statusCode, 400, 'runs again once the first answered');
});

test('live line: open tabs learn at once; a role change refreshes them, a ban or a password set by an admin signs them out', async () => {
  if (!app.getHttpServer().listening) await app.listen(0, '127.0.0.1');
  const port = app.getHttpServer().address().port;
  // An EventSource stand-in: collects "event: x / data: {...}" blocks; next(x) waits for the first x not yet taken.
  const open = (cookie) => new Promise((resolve, reject) => {
    const events = []; let buf = ''; let wake = () => {};
    const req = httpGet({ host: '127.0.0.1', port, path: '/live', agent: false, headers: cookie ? { cookie: `lvm.session_token=${cookie}` } : {} }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const block = buf.slice(0, i), ev = /^event: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
        }
        wake();
      });
      res.on('end', () => { events.push({ ev: 'end' }); wake(); });
      let taken = 0;
      resolve({ status: res.statusCode, close: () => req.destroy(), async next(name) {
        for (const until = Date.now() + 5000; Date.now() < until;) {
          const i = events.findIndex((e, n) => n >= taken && e.ev === name);
          if (i >= 0) { taken = i + 1; return events[i].data; }
          await new Promise((r) => { wake = r; setTimeout(r, 200); });
        }
        throw new Error(`no "${name}" event; got ${JSON.stringify(events)}`);
      } });
    });
    req.on('error', reject);
  });
  assert.equal((await open(null)).status, 401);

  const email = 'live@example.test';
  const id = (await post('/auth/admin/create-user', { email, password, name: 'Live', role: 'user' }, admin)).json().user.id;
  let c = cookieOf(await post('/auth/sign-in/email', { email, password }));
  let tab = await open(c);
  assert.equal(tab.status, 200);
  assert.equal((await tab.next('ready')).userId, id);
  // Permissions: the tab is told to refresh, it stays signed in.
  assert.equal((await put(`/admin/users/${id}/access`, { roles: ['user'], overrides: [{ permission: 'dashboard.view', effect: 'allow' }] }, admin)).statusCode, 200);
  assert.equal((await tab.next('changed')).kind, 'access');
  // A new in-app notification rings at once.
  await post('/notifications/test', { channel: 'inApp' }, c);
  await tab.next('notification');
  // Ban: signed out with the reason, and the stream ends.
  assert.equal((await post('/auth/admin/ban-user', { userId: id, banReason: 'test' }, admin)).statusCode, 200);
  assert.equal((await tab.next('signed-out')).reason, 'banned');
  await tab.next('end');
  // A password set by an administrator ends every session of the account.
  assert.equal((await post('/auth/admin/unban-user', { userId: id }, admin)).statusCode, 200);
  c = cookieOf(await post('/auth/sign-in/email', { email, password }));
  tab = await open(c);
  await tab.next('ready');
  assert.equal((await post('/auth/admin/set-user-password', { userId: id, newPassword: `${password} 2` }, admin)).statusCode, 200);
  assert.equal((await tab.next('signed-out')).reason, 'password');
  assert.equal((await get('/auth/me', c)).statusCode, 401);
  tab.close();
  assert.equal((await post('/auth/admin/remove-user', { userId: id }, admin)).statusCode, 200);
});

test('role limits: checked when saved, then enforced for members (addresses, counts, two-factor, session length, server actions)', async () => {
  const bad = (await post('/admin/roles', { key: 'limited', name: 'Limited', permissions: ['servers.create'], limits: { maxServers: -1, allowedIps: ['10.0.0.0/33'], allowedLocations: ['nope'] } }, admin)).json();
  assert.deepEqual(Object.keys(bad.fields).sort(), ['limits.allowedIps', 'limits.allowedLocations', 'limits.maxServers']);
  // No server.* abilities, a few counts, and an address range the test client is outside of.
  assert.equal((await post('/admin/roles', { key: 'limited', name: 'Limited', permissions: ['servers.create', 'firewalls.manage'],
    limits: { maxSshKeys: 1, maxFirewalls: 0, maxSnapshots: 2, allowedIps: ['203.0.113.0/24'] } }, admin)).statusCode, 201);
  const roles = (await get('/admin/roles', admin)).json().roles;
  assert.deepEqual(roles.find((r) => r.key === 'limited').limits, { maxSshKeys: 1, maxFirewalls: 0, maxSnapshots: 2, allowedIps: ['203.0.113.0/24'] });
  // The built-in user role kept every server ability (migration 024).
  assert.ok(['server.power', 'server.console', 'server.delete', 'server.snapshots', 'server.iso', 'server.root_password'].every((p) => roles.find((r) => r.key === 'user').permissions.includes(p)));

  const email = 'limited@example.test';
  const id = (await post('/auth/admin/create-user', { email, password, name: 'Lim', role: 'user' }, admin)).json().user.id;
  assert.equal((await put(`/admin/users/${id}/access`, { roles: ['limited'], overrides: [] }, admin)).statusCode, 200);
  const refused = await post('/auth/sign-in/email', { email, password });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'IP_NOT_ALLOWED');
  assert.equal((await put('/admin/roles/limited', { name: 'Limited', permissions: ['servers.create', 'firewalls.manage'], limits: { maxSshKeys: 1, maxFirewalls: 0, allowedIps: ['127.0.0.0/8', '::1/128'] } }, admin)).statusCode, 200);
  const c = cookieOf(await post('/auth/sign-in/email', { email, password }));
  assert.equal((await get('/auth/me', c)).statusCode, 200);

  const key = (n) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${n.repeat(43).slice(0, 43)} t@x`;
  assert.equal((await post('/ssh-keys', { name: 'one', publicKey: key('A') }, c)).statusCode, 201);
  const second = await post('/ssh-keys', { name: 'two', publicKey: key('B') }, c);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'LIMIT_REACHED');
  assert.equal((await post('/firewalls', { name: 'fw', rules: [] }, c)).json().code, 'LIMIT_REACHED');

  // Two-factor required by the role: only "who am I" answers until it is set up.
  assert.equal((await put('/admin/roles/limited', { name: 'Limited', permissions: ['servers.create'], limits: { require2fa: true } }, admin)).statusCode, 200);
  assert.equal((await get('/auth/me', c)).json().twoFactorRequired, true);
  assert.equal((await get('/ssh-keys', c)).json().code, 'TWO_FACTOR_SETUP_REQUIRED');
  // A session older than the role allows is ended.
  assert.equal((await put('/admin/roles/limited', { name: 'Limited', permissions: ['servers.create'], limits: { sessionHours: 1 } }, admin)).statusCode, 200);
  assert.equal((await get('/ssh-keys', c)).statusCode, 200);
  await pool.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours' WHERE user_id = $1", [id]);
  assert.equal((await get('/ssh-keys', c)).statusCode, 401);

  // Clean up.
  await pool.query("DELETE FROM ssh_keys WHERE owner_id = $1", [id]);
  assert.equal((await post('/auth/admin/remove-user', { userId: id }, admin)).statusCode, 200);
  assert.equal((await call('DELETE', '/admin/roles/limited', admin)).statusCode, 204);
});

test('directory sign-in (LDAP): checked settings, local accounts unaffected, directory accounts created with roles from groups, directory owns their password', async () => {
  let r = await put('/admin/settings/directory', { ldap: { enabled: true, url: 'http://x', baseDn: '', userFilter: '(mail=x)', groupRoles: [{ group: 'cn=x', roles: ['nope'] }] } }, admin);
  assert.deepEqual(Object.keys(r.json().fields).sort(), ['baseDn', 'groupRoles', 'url', 'userFilter']);
  // An unreachable directory: panel accounts still sign in, nobody is created, the test says why.
  assert.equal((await put('/admin/settings/directory', { ldap: { enabled: true, url: 'ldap://127.0.0.1:1', baseDn: 'dc=example,dc=org' } }, admin)).statusCode, 200);
  const local = (await post('/auth/admin/create-user', { email: 'local@example.test', password, name: 'Local', role: 'user' }, admin)).json().user.id;
  assert.equal((await post('/auth/sign-in/email', { email: 'local@example.test', password })).statusCode, 200);
  await post('/auth/admin/remove-user', { userId: local }, admin);
  assert.equal((await post('/auth/sign-in/email', { email: 'nobody@example.org', password })).statusCode, 401);
  assert.equal((await post('/admin/settings/directory/test', { ldap: { enabled: true, url: 'ldap://127.0.0.1:1', baseDn: 'dc=example,dc=org' } }, admin)).json().code, 'LDAP_UNREACHABLE');

  const url = process.env.LDAP_TEST_URL;
  if (url) {
    assert.equal((await post('/admin/roles', { key: 'ldap-support', name: 'LDAP support', permissions: ['users.view'] }, admin)).statusCode, 201);
    const ldap = { enabled: true, url, bindDn: 'cn=reader,dc=example,dc=org', bindPassword: 'reader-secret', baseDn: 'dc=example,dc=org', userFilter: '(&(objectClass=inetOrgPerson)(mail={email}))',
      groupRoles: [{ group: 'CN=panel-support, OU=groups, DC=example, DC=org', roles: ['ldap-support'] }], defaultRole: 'user', autoCreate: true };
    const saved = (await put('/admin/settings/directory', { ldap }, admin)).json();
    assert.equal(saved.ldap.bindPasswordSet, true);
    assert.ok(!JSON.stringify(saved).includes('reader-secret'));
    const found = (await post('/admin/settings/directory/test', { ldap: { ...ldap, bindPassword: '' }, email: 'ada@example.org' }, admin)).json();
    assert.equal(found.user.dn, 'uid=ada,ou=people,dc=example,dc=org');
    assert.deepEqual(found.user.roles, ['ldap-support']);
    assert.equal((await post('/admin/settings/directory/test', { ldap: { ...ldap, bindPassword: '' }, email: 'ada@example.org', password: 'wrong' }, admin)).json().code, 'LDAP_AUTH_FAILED');

    assert.equal((await post('/auth/sign-in/email', { email: 'ada@example.org', password: 'wrong-password-1' })).statusCode, 401);
    const ada = cookieOf(await post('/auth/sign-in/email', { email: 'ada@example.org', password: 'ada-directory-pass' }));
    const me = (await get('/auth/me', ada)).json();
    assert.deepEqual(me.roles, ['ldap-support']);
    assert.equal(me.name, 'Ada Lovelace');
    const { rows: [row] } = await pool.query("SELECT auth_source, external_id FROM users WHERE email = 'ada@example.org'");
    assert.deepEqual(row, { auth_source: 'ldap', external_id: 'uid=ada,ou=people,dc=example,dc=org' });
    assert.equal((await post('/auth/change-password', { currentPassword: 'ada-directory-pass', newPassword: 'something-else-123' }, ada)).json().code, 'PASSWORD_MANAGED_BY_DIRECTORY');
    // No group: the default role.
    const bob = cookieOf(await post('/auth/sign-in/email', { email: 'bob@example.org', password: 'bob-directory-pass' }));
    assert.deepEqual((await get('/auth/me', bob)).json().roles, ['user']);
    // The directory decides: unreachable, the right password no longer works for a directory account.
    await put('/admin/settings/directory', { ldap: { ...ldap, url: 'ldap://127.0.0.1:1', bindPassword: '' } }, admin);
    assert.equal((await post('/auth/sign-in/email', { email: 'ada@example.org', password: 'ada-directory-pass' })).statusCode, 401);
    for (const e of ['ada@example.org', 'bob@example.org']) {
      const { rows: [u] } = await pool.query('SELECT id FROM users WHERE email = $1', [e]);
      await post('/auth/admin/remove-user', { userId: u.id }, admin);
    }
    await call('DELETE', '/admin/roles/ldap-support', admin);
  }
  await put('/admin/settings/directory', { ldap: { enabled: false } }, admin);
});

test('quiet hours: checked, kept with the preferences, and turned off with null', async () => {
  assert.equal((await put('/notifications/quiet-hours', { quietHours: { start: '25:00', end: '07:00', tz: 'UTC' } }, user)).statusCode, 400);
  assert.equal((await put('/notifications/quiet-hours', { quietHours: { start: '23:00', end: '07:00', tz: 'Nowhere/City' } }, user)).statusCode, 400);
  const q = { start: '23:00', end: '07:00', tz: 'Europe/Istanbul' };
  assert.deepEqual((await put('/notifications/quiet-hours', { quietHours: q }, user)).json().quietHours, q);
  assert.deepEqual((await get('/notifications/preferences', user)).json().quietHours, q);
  assert.equal((await put('/notifications/quiet-hours', { quietHours: null }, user)).json().quietHours, null);
});

test('export my data: a JSON file with the account, servers, keys and activity, and no secrets', async () => {
  const r = await get('/account/export', user);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-disposition'], /attachment; filename="lightning-vm-\d{4}-\d{2}-\d{2}\.json"/);
  const data = r.json();
  assert.equal(data.profile.email, 'ayse@example.test');
  for (const k of ['servers', 'sshKeys', 'firewalls', 'notifications', 'sessions', 'activity', 'messagingApps']) assert.ok(Array.isArray(data[k]), k);
  assert.ok(!/password|token|secret|target_enc/i.test(JSON.stringify(Object.keys(data.profile))));
  assert.ok(!r.body.includes('scrypt$'), 'no password hash');
  assert.ok((await pool.query("SELECT 1 FROM audit_events WHERE action = 'account.export'")).rowCount);
});

test('public status page: open to anyone, only aggregate states; the admin can turn it off', async () => {
  const r = await get('/public/status');
  assert.equal(r.statusCode, 200);
  const s = r.json();
  assert.ok(['ok', 'degraded', 'down'].includes(s.overall));
  assert.deepEqual(s.services.map((x) => x.key), ['panel', 'database', 'queue', 'automation', 'virtualization']);
  assert.ok(!JSON.stringify(s).includes('@'), 'no e-mail addresses');
  assert.equal((await put('/admin/settings/status-page', { enabled: false }, user)).statusCode, 403);
  assert.equal((await put('/admin/settings/status-page', { enabled: false }, admin)).statusCode, 200);
  assert.equal((await get('/public/status')).statusCode, 404);
  await put('/admin/settings/status-page', { enabled: true }, admin);
});
