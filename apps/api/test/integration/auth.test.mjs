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

let app;
const csrf = { 'x-lightning-csrf': '1' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm_session=([^;]+)/)?.[1];
const post = (url, payload, cookie, headers = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm_session=${cookie}` }) } });
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie: `lvm_session=${cookie}` } : {} });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
after(async () => { await app?.close(); await closeConnections(); });

test('migrations apply once and are idempotent', async () => {
  assert.deepEqual(await runMigrations(pool), ['001_init', '002_auth', '003_setup_wizard']);
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

test('login rejects wrong passwords and unknown emails with the same answer', async () => {
  adminEmail = (await pool.query("SELECT email FROM users WHERE role = 'admin'")).rows[0].email;
  const wrong = await post('/auth/login', { email: adminEmail, password: 'wrong password here' });
  const unknown = await post('/auth/login', { email: 'nobody@example.test', password });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.json(), unknown.json());
  const failures = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login' AND outcome = 'failure'");
  assert.equal(failures.rows[0].n, 2);
});

test('login sets a hardened session cookie and never returns the password hash', async () => {
  const res = await post('/auth/login', { email: adminEmail.toUpperCase(), password });
  assert.equal(res.statusCode, 200);
  const header = res.headers['set-cookie'].toString();
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.doesNotMatch(header, /Secure/);
  adminCookie = cookieOf(res);
  const stored = await pool.query('SELECT token_hash FROM sessions');
  assert.ok(stored.rows.every((r) => !r.token_hash.toString('utf8').includes(adminCookie)), 'raw token must not be stored');
  const users = await get('/admin/users', adminCookie);
  assert.equal(users.statusCode, 200);
  assert.doesNotMatch(users.body, /scrypt|password/);
});

test('cookie is Secure when the trusted proxy reports HTTPS', async () => {
  const res = await post('/auth/login', { email: adminEmail, password }, null, { 'x-forwarded-proto': 'https' });
  assert.match(res.headers['set-cookie'].toString(), /Secure/);
});

test('registration is closed until an admin opens it', async () => {
  const closed = await post('/auth/register', { email: 'user@example.test', password });
  assert.equal(closed.json().code, 'REGISTRATION_CLOSED');
  const open = await app.inject({ method: 'PUT', url: '/admin/settings', payload: { registrationOpen: true }, headers: { ...csrf, cookie: `lvm_session=${adminCookie}` } });
  assert.equal(open.statusCode, 200);
  const res = await post('/auth/register', { email: 'user@example.test', password, locale: 'tr' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().role, 'user');
  userCookie = cookieOf(res);
  const dup = await post('/auth/register', { email: 'USER@example.test', password });
  assert.equal(dup.json().code, 'EMAIL_TAKEN');
});

test('a normal user cannot reach admin APIs and the denial is audited', async () => {
  assert.equal((await get('/auth/me', userCookie)).json().email, 'user@example.test');
  for (const url of ['/admin/users', '/admin/system', '/admin/settings']) {
    const res = await get(url, userCookie);
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.json().code, 'FORBIDDEN');
  }
  const put = await app.inject({ method: 'PUT', url: '/admin/settings', payload: { registrationOpen: false }, headers: { ...csrf, cookie: `lvm_session=${userCookie}` } });
  assert.equal(put.statusCode, 403);
  const denied = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'admin.access' AND outcome = 'denied'");
  assert.equal(denied.rows[0].n, 4);
});

test('logout revokes the session server-side', async () => {
  assert.equal((await post('/auth/logout', {}, userCookie)).statusCode, 204);
  assert.equal((await get('/auth/me', userCookie)).statusCode, 401);
});

test('expired sessions and disabled users are rejected', async () => {
  const login = cookieOf(await post('/auth/login', { email: 'user@example.test', password }));
  assert.equal((await get('/auth/me', login)).statusCode, 200);
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = 'user@example.test')");
  assert.equal((await get('/auth/me', login)).statusCode, 401);

  const fresh = cookieOf(await post('/auth/login', { email: 'user@example.test', password }));
  await pool.query("UPDATE users SET disabled_at = now() WHERE email = 'user@example.test'");
  assert.equal((await get('/auth/me', fresh)).statusCode, 401);
  assert.equal((await post('/auth/login', { email: 'user@example.test', password })).json().code, 'INVALID_CREDENTIALS');
});

test('repeated login failures for one email are rate limited', async () => {
  await redis.flushdb();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post('/auth/login', { email: 'target@example.test', password: 'wrong password here' })).json().code);
  assert.equal(codes.slice(0, 10).every((c) => c === 'INVALID_CREDENTIALS'), true);
  assert.equal(codes[10], 'RATE_LIMITED');
});
