// Runs against a real PostgreSQL and Redis. Destructive: it wipes the test database
// and Redis DB, so it refuses to start unless both are clearly marked as test targets.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { hashPassword } = await import('../../dist/security.js');

let app;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const post = (url, payload, cookie, headers = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie: `lvm.session_token=${cookie}` } : {} });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
after(async () => { await app?.close(); await closeConnections(); });

test('migrations apply once and are idempotent', async () => {
  assert.deepEqual(await runMigrations(pool), ['001_init', '002_auth', '003_setup_wizard', '004_vmware', '005_catalog', '006_servers', '007_better_auth', '008_two_factor_branding', '009_firewalls', '010_payments']);
  assert.deepEqual(await runMigrations(pool), []);
});

test('setup admin cannot be created without a valid bootstrap token', async () => {
  assert.deepEqual((await get('/setup/status')).json(), { adminCreated: false, completed: false });
  const none = await post('/setup/admin', { token: 'guess', email: 'admin@example.test', password });
  assert.equal(none.json().code, 'BOOTSTRAP_TOKEN_INVALID');

  await issueBootstrapToken();
  const wrong = await post('/setup/admin', { token: 'guess', email: 'admin@example.test', password });
  assert.equal(wrong.statusCode, 403);

  const { token } = await issueBootstrapToken();
  await pool.query("UPDATE setup_state SET bootstrap_expires_at = now() - interval '1 second'");
  const expired = await post('/setup/admin', { token, email: 'admin@example.test', password });
  assert.equal(expired.json().code, 'BOOTSTRAP_TOKEN_INVALID');
});

test('concurrent setup requests create exactly one admin, then setup closes', async () => {
  const { token } = await issueBootstrapToken();
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => post('/setup/admin', { token, email: `admin${i}@example.test`, password })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409, 409, 409]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n, 1);
  assert.equal((await pool.query('SELECT bootstrap_token_hash FROM setup_state')).rows[0].bootstrap_token_hash, null);
  assert.equal(await issueBootstrapToken(), null);
  const again = await post('/setup/admin', { token, email: 'late@example.test', password });
  assert.equal(again.json().code, 'SETUP_CLOSED');
  assert.equal((await get('/setup/status')).json().adminCreated, true);
});

let adminEmail, adminCookie, userCookie;

test('sign-in rejects wrong passwords and unknown emails with the same answer, and audits both', async () => {
  adminEmail = (await pool.query("SELECT email FROM users WHERE role = 'admin'")).rows[0].email;
  const wrong = await post('/auth/sign-in/email', { email: adminEmail, password: 'wrong password here' });
  const unknown = await post('/auth/sign-in/email', { email: 'nobody@example.test', password });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().code, 'INVALID_EMAIL_OR_PASSWORD');
  assert.deepEqual(wrong.json(), unknown.json());
  const failures = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login' AND outcome = 'failure'");
  assert.equal(failures.rows[0].n, 2);
});

test('sign-in sets a signed, hardened session cookie and never returns the password hash', async () => {
  const res = await post('/auth/sign-in/email', { email: adminEmail.toUpperCase(), password });
  assert.equal(res.statusCode, 200);
  const header = res.headers['set-cookie'].toString();
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  // Plain HTTP install (PANEL_TLS unset): the Secure flag would make browsers drop the cookie.
  assert.doesNotMatch(header, /Secure/);
  adminCookie = cookieOf(res);
  // The cookie is token.signature: the stored token alone, without the server's signature, is not accepted.
  const { rows: [s] } = await pool.query('SELECT token FROM auth_sessions ORDER BY created_at DESC LIMIT 1');
  assert.equal((await get('/auth/me', s.token)).statusCode, 401);
  assert.deepEqual((await get('/auth/me', adminCookie)).json().roles, ['admin']);
  assert.deepEqual((await get('/auth/me', adminCookie)).json().permissions, ['*']);
  const users = await get('/admin/users', adminCookie);
  assert.equal(users.statusCode, 200);
  assert.doesNotMatch(users.body, /scrypt|password/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login' AND outcome = 'success'")).rows[0].n, 1);
});

test('accounts with a password hash from before better-auth still sign in', async () => {
  const { rows: [u] } = await pool.query("INSERT INTO users (email, role, locale) VALUES ('legacy@example.test', 'user', 'en') RETURNING id");
  await pool.query("INSERT INTO auth_accounts (account_id, provider_id, user_id, password, updated_at) VALUES ($1, 'credential', $2, $3, now())", [u.id, u.id, await hashPassword(password)]);
  assert.equal((await post('/auth/sign-in/email', { email: 'legacy@example.test', password })).statusCode, 200);
});

test('registration is closed until an admin opens it', async () => {
  const closed = await post('/auth/sign-up/email', { name: '', email: 'user@example.test', password });
  assert.equal(closed.statusCode, 403);
  assert.equal(closed.json().code, 'REGISTRATION_CLOSED');
  const open = await app.inject({ method: 'PUT', url: '/admin/settings', payload: { registrationOpen: true }, headers: { ...csrf, cookie: `lvm.session_token=${adminCookie}` } });
  assert.equal(open.statusCode, 200);
  // The role cannot be chosen at sign-up.
  const elevated = await post('/auth/sign-up/email', { name: '', email: 'sneaky@example.test', password, role: 'admin' });
  assert.equal(elevated.statusCode, 400);
  const short = await post('/auth/sign-up/email', { name: '', email: 'short@example.test', password: 'too short' });
  assert.equal(short.json().code, 'PASSWORD_TOO_SHORT');
  const res = await post('/auth/sign-up/email', { name: '', email: 'user@example.test', password, locale: 'tr' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.role, 'user');
  userCookie = cookieOf(res);
  assert.deepEqual((await get('/auth/me', userCookie)).json().locale, 'tr');
  const dup = await post('/auth/sign-up/email', { name: '', email: 'USER@example.test', password });
  assert.match(dup.json().code, /^USER_ALREADY_EXISTS/);
});

test('a normal user cannot reach admin APIs and the denial is audited', async () => {
  assert.equal((await get('/auth/me', userCookie)).json().email, 'user@example.test');
  for (const url of ['/admin/users', '/admin/system', '/admin/settings']) {
    const res = await get(url, userCookie);
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.json().code, 'FORBIDDEN');
  }
  const put = await app.inject({ method: 'PUT', url: '/admin/settings', payload: { registrationOpen: false }, headers: { ...csrf, cookie: `lvm.session_token=${userCookie}` } });
  assert.equal(put.statusCode, 403);
  const denied = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'admin.access' AND outcome = 'denied'");
  assert.equal(denied.rows[0].n, 4);
});

test('sessions can be listed, and sign-out revokes the session server-side', async () => {
  const list = await get('/auth/list-sessions', userCookie);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().length, 1);
  assert.equal((await post('/auth/sign-out', {}, userCookie)).statusCode, 200);
  assert.equal((await get('/auth/me', userCookie)).statusCode, 401);
});

test('a cross-site request is refused before reaching better-auth', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in/email', payload: { email: adminEmail, password }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.statusCode, 403);
});

test('expired sessions and disabled users are rejected', async () => {
  const login = cookieOf(await post('/auth/sign-in/email', { email: 'user@example.test', password }));
  assert.equal((await get('/auth/me', login)).statusCode, 200);
  await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.test')");
  assert.equal((await get('/auth/me', login)).statusCode, 401);

  const fresh = cookieOf(await post('/auth/sign-in/email', { email: 'user@example.test', password }));
  await pool.query("UPDATE users SET disabled_at = now() WHERE email = 'user@example.test'");
  assert.equal((await get('/auth/me', fresh)).statusCode, 401);
  const again = await post('/auth/sign-in/email', { email: 'user@example.test', password });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().code, 'FAILED_TO_CREATE_SESSION');
});

test('passkey registration needs a session and follows the request host', async () => {
  assert.equal((await get('/auth/passkey/generate-register-options')).statusCode, 401);
  const res = await app.inject({ method: 'GET', url: '/auth/passkey/generate-register-options', headers: { host: 'panel.example.test', cookie: `lvm.session_token=${adminCookie}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().rp.id, 'panel.example.test');
});

test('repeated sign-in failures for one email are rate limited', async () => {
  await redis.flushdb();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post('/auth/sign-in/email', { email: 'target@example.test', password: 'wrong password here' })).json().code);
  assert.equal(codes.slice(0, 10).every((c) => c === 'INVALID_EMAIL_OR_PASSWORD'), true);
  assert.equal(codes[10], 'RATE_LIMITED');
});
