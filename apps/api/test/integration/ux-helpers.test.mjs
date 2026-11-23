// The everyday helpers' API against real PostgreSQL and Redis: when a browser session ends and "stay signed in"
// (only for a renewable end, the same cookie with a new lifetime, audited), the operation time estimates (durations
// only, nothing with too little history) and the setup checklist's health steps.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
const { notificationQueue } = await import('../../dist/notify.js');

let app, admin;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookies = (res) => [res.headers['set-cookie'] ?? []].flat().map(String);
const cookieHeader = (res) => cookies(res).map((c) => c.split(';')[0]).join('; ');
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie) => call('POST', url, cookie, payload);
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signIn = async (email, rememberMe = true) => { await freshLimits(); const r = await post('/auth/sign-in/email', { email, password, rememberMe }); assert.equal(r.statusCode, 200, r.body); return cookieHeader(r); };
const h = 3_600_000;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await post('/setup/admin', { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = await signIn('boss@example.test');
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('a remembered sign-in ends with its cookie; "stay signed in" renews the session and the same cookie, audited', async () => {
  await freshLimits();
  await post('/auth/sign-up/email', { name: '', email: 'stay@example.test', password });
  const cookie = await signIn('stay@example.test');
  const me = (await get('/auth/me', cookie)).json();
  assert.equal(me.session.kind, 'renewable');
  assert.equal(me.session.why, 'cookie');
  assert.ok(me.session.msLeft > 11.9 * h && me.session.msLeft <= 12 * h, String(me.session.msLeft));
  // Twelve hours less two minutes later (the row is aged instead of waiting): the cookie runs out in two minutes.
  await pool.query("UPDATE auth_sessions SET created_at = now() - interval '11 hours 58 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'stay@example.test')");
  const soon = (await get('/auth/me', cookie)).json().session;
  assert.ok(soon.msLeft < 3 * 60_000 && soon.msLeft > 0, String(soon.msLeft));
  // Staying: the stored session and the cookie get twelve hours from now; the cookie is the one the browser sent.
  const stayed = await post('/auth/stay', undefined, cookie);
  assert.equal(stayed.statusCode, 200, stayed.body);
  assert.ok(stayed.json().session.msLeft > 11.9 * h);
  const set = cookies(stayed).find((c) => /lvm\.session_token=/.test(c));
  assert.ok(set, 'the session cookie is written again');
  assert.equal(set.split(';')[0], cookie.split('; ').find((c) => c.includes('session_token')));
  assert.match(set, /Max-Age=43200/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.ok((await get('/auth/me', cookie)).json().session.msLeft > 11.9 * h, 'the end moved for later answers too');
  const { rows: [a] } = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'session.extended'");
  assert.equal(a.n, 1);
  // Without the session nothing happens.
  assert.equal((await post('/auth/stay')).statusCode, 401);
});

test('a sign-in that was not remembered keeps a browser-session cookie when it stays', async () => {
  const cookie = await signIn('stay@example.test', false);
  assert.match(cookie, /dont_remember=/);
  assert.equal((await get('/auth/me', cookie)).json().session.why, 'idle');
  const stayed = await post('/auth/stay', undefined, cookie);
  assert.equal(stayed.statusCode, 200, stayed.body);
  const set = cookies(stayed).find((c) => /lvm\.session_token=/.test(c));
  assert.ok(set && !/Max-Age/.test(set), set);
});

test('a fixed end is said and cannot be extended', async () => {
  const cookie = await signIn('stay@example.test');
  await pool.query("UPDATE users SET auth_source = 'oidc' WHERE email = 'stay@example.test'");
  try {
    const me = (await get('/auth/me', cookie)).json();
    assert.deepEqual([me.session.kind, me.session.why], ['fixed', 'directory']);
    const r = await post('/auth/stay', undefined, cookie);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, 'SESSION_FIXED');
  } finally { await pool.query("UPDATE users SET auth_source = 'local' WHERE email = 'stay@example.test'"); }
});

test('operation estimates are durations only, by kind and disk size, and nothing with fewer than five', async () => {
  await redis.del('eta:v1');
  const add = (kind, seconds, extra = {}) => pool.query(`INSERT INTO operations (id, kind, status, idempotency_key, attempts, created_at, finished_at, params, held_since)
    VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6 + 60), now() - interval '60 seconds', $7, $8)`,
  [randomUUID(), kind, extra.status ?? 'succeeded', randomUUID(), extra.attempts ?? 1, seconds, JSON.stringify({ diskGb: extra.diskGb ?? 20 }), extra.held ? new Date() : null]);
  for (const s of [100, 110, 120, 130, 140]) await add('create', s);
  for (const s of [30, 40, 50, 60]) await add('resize', s);
  // Not durations: a failure, a retried run, one that waited for a payment.
  await add('create', 9000, { status: 'failed' });
  await add('create', 9000, { attempts: 2 });
  await add('create', 9000, { held: true });
  const r = await get('/operations/estimates', admin);
  assert.equal(r.statusCode, 200, r.body);
  const e = r.json();
  assert.equal(e.minSamples, 5);
  assert.deepEqual(e.estimates.create.all, { median: 120, p90: 140, n: 5 });
  assert.deepEqual(e.estimates.create.sizes, { s: { median: 120, p90: 140, n: 5 } });
  assert.equal(e.estimates.resize, undefined, 'four resizes are too few');
  assert.ok(!/serverId|owner|name/.test(r.body), 'no server, owner or name leaves the query');
  assert.equal((await get('/operations/estimates')).statusCode, 401);
});

test('the setup checklist adds health steps from the real state, each with its group, link and basis', async () => {
  const r = await get('/admin/onboarding', admin);
  assert.equal(r.statusCode, 200, r.body);
  const steps = r.json().steps;
  const by = Object.fromEntries(steps.map((s) => [s.key, s]));
  assert.equal(by.connection.group, 'start');
  assert.equal(by.backupSchedule.group, 'health');
  assert.equal(by.backupSchedule.done, false, 'no host timer in a test');
  // The administrator itself is staff without two-factor.
  assert.equal(by.staffTwoFactor.done, false);
  assert.ok(by.staffTwoFactor.detail.n >= 1);
  assert.equal(by.staffTwoFactor.link, '/admin/users');
  assert.equal(by.mailDelivers, undefined, 'mail is not set up: the start step says so');
  assert.equal(by.payments, undefined, 'billing is off');
  // A customer has no checklist.
  const customer = await signIn('stay@example.test');
  assert.equal((await get('/admin/onboarding', customer)).statusCode, 403);
});
