// Requests run from the API reference page ("Try it"), against a real PostgreSQL and Redis (destructive, like the
// other files here: it wipes the test database and Redis DB). The page sends ordinary requests of the signed-in
// session with one header that says where they come from. What is checked: such a request is counted per person and
// minute against the administrator's limit for API tokens and answered with the same rate headers; over the limit it
// is refused; the count is the person's, not shared with others or with their tokens; and the header opens nothing:
// permissions, the CSRF rule, the two-factor rule and the session itself are checked as for any request.
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
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');

let app, admin, user;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const tryIt = { 'x-lightning-try': '1' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload, headers = {}) => app.inject({ method, url: path, payload, headers: { host: 'localhost', ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const freshMinute = async () => { for (const k of await redis.keys('rl:api:*')) await redis.del(k); };
const settings = (rateLimit) => call('PUT', '/admin/api/settings', admin, { who: 'everyone', maxDays: 0, staffExpiry: false, rateLimit, networks: [], log: true, logDays: 14 }, csrf);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await call('POST', '/setup/admin', undefined, { token, email: 'boss@example.test', password }, csrf)).statusCode, 201);
  admin = cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email: 'boss@example.test', password }, csrf));
  await call('PUT', '/admin/settings', admin, { registrationOpen: true }, csrf);
  user = cookieOf(await call('POST', '/auth/sign-up/email', undefined, { name: '', email: 'user@example.test', password }, csrf));
});
after(async () => { await app?.close(); await closeConnections(); });

test('a request run from the reference is counted like a token\'s: the same limit, the same headers, refused over it', async () => {
  assert.equal((await settings(3)).statusCode, 200);
  await new Promise((r) => setTimeout(r, 0));
  // The panel's own requests carry no such header: not counted, no rate headers (as before).
  const plain = await call('GET', '/auth/me', user);
  assert.deepEqual([plain.statusCode, plain.headers['x-ratelimit-limit']], [200, undefined]);
  // Settings are cached for a few seconds: wait until the new limit is the one in force.
  for (let i = 0; i < 120; i++) { await freshMinute(); if ((await call('GET', '/auth/me', user, undefined, tryIt)).headers['x-ratelimit-limit'] === '3') break; await new Promise((r) => setTimeout(r, 250)); }
  await freshMinute();
  const seen = [];
  for (let i = 0; i < 5; i++) { const r = await call('GET', '/auth/me', user, undefined, tryIt); seen.push([r.statusCode, r.headers['x-ratelimit-limit'], r.headers['x-ratelimit-remaining']]); }
  assert.deepEqual(seen, [[200, '3', '2'], [200, '3', '1'], [200, '3', '0'], [429, '3', '0'], [429, '3', '0']]);
  const over = await call('GET', '/servers', user, undefined, tryIt);
  assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
  assert.ok(Number(over.headers['retry-after']) >= 1 && Number(over.headers['retry-after']) <= 60);
  // The count is the person's: another person starts at the top, and the same person without the header is the panel as always.
  assert.deepEqual([(await call('GET', '/auth/me', admin, undefined, tryIt)).headers['x-ratelimit-remaining'], (await call('GET', '/auth/me', user)).statusCode], ['2', 200]);
  // A token of that person has its own count.
  const made = await call('POST', '/account/api-tokens', user, { name: 'script', scope: 'read' }, csrf);
  assert.equal(made.statusCode, 201, made.body);
  const viaToken = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${made.json().token}`, ...tryIt } });
  assert.deepEqual([viaToken.statusCode, viaToken.headers['x-ratelimit-remaining']], [200, '2']);
  await settings(600);
});

test('the header opens nothing: the session, permissions and the CSRF rule are checked as for any request', async () => {
  await freshMinute();
  for (let i = 0; i < 120; i++) { if ((await call('GET', '/auth/me', user, undefined, tryIt)).headers['x-ratelimit-limit'] === '600') break; await new Promise((r) => setTimeout(r, 250)); }
  // No session: nothing, with or without it.
  assert.equal((await call('GET', '/auth/me', undefined, undefined, tryIt)).statusCode, 401);
  assert.equal((await call('GET', '/auth/me', 'not-a-session', undefined, tryIt)).statusCode, 401);
  // A customer does not reach staff routes through it.
  for (const path of ['/admin/users', '/admin/quotas', '/admin/api/settings', '/admin/settings/payments']) {
    const r = await call('GET', path, user, undefined, tryIt);
    assert.deepEqual([r.statusCode, r.json().code], [403, 'FORBIDDEN'], path);
  }
  // A change still needs the header every change needs; the reference page adds it, a cross-site form cannot.
  const noCsrf = await call('POST', '/projects', user, { name: 'x' }, tryIt);
  assert.deepEqual([noCsrf.statusCode, noCsrf.json().code], [403, 'CSRF_REJECTED']);
  const crossSite = await call('POST', '/projects', user, { name: 'x' }, { ...tryIt, 'x-lightning-csrf': '1', origin: 'https://evil.example' });
  assert.equal(crossSite.statusCode, 403);
  const ok = await call('POST', '/projects', user, { name: 'From the reference' }, { ...tryIt, ...csrf });
  assert.equal(ok.statusCode, 201, ok.body);
  // It is audited as the person's own action, like the same request from the panel.
  const { rows: [a] } = await pool.query("SELECT actor_id, (SELECT id FROM users WHERE email = 'user@example.test') AS id FROM audit_events WHERE action = 'project.created' ORDER BY created_at DESC LIMIT 1");
  assert.equal(a.actor_id, a.id);
  // Routes kept to the panel's own screens for tokens stay with their own rules (here: a token cannot make a token).
  const made = await call('POST', '/account/api-tokens', user, { name: 'second', scope: 'write' }, csrf);
  const viaToken = await app.inject({ method: 'POST', url: '/account/api-tokens', payload: { name: 'third', scope: 'read' }, headers: { authorization: `Bearer ${made.json().token}`, ...tryIt } });
  assert.deepEqual([viaToken.statusCode, viaToken.json().code], [403, 'TOKEN_NOT_ALLOWED']);
});
