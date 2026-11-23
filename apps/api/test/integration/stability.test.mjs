// Round two of the usability work, against real PostgreSQL and Redis (docs/ux-review.md): the duplicate-request guard
// frees a request whose browser went away before the answer (a reload during a check), so the same request later is
// not refused for two minutes (the cause of the setup wizard browser test's occasional failure); a server page's
// "what next" hints, read from the server's real state for whoever may see it, hidden per viewer; and "while you were
// away", the person's own notifications since they last marked the list as seen.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { notificationQueue } = await import('../../dist/notify.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { encryptSecret } = await import('../../dist/secrets.js');

const password = 'correct horse battery staple';
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const cookieOf = (res) => [res.headers['set-cookie'] ?? []].flat().map(String).map((c) => c.split(';')[0]).join('; ');
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie }) } });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signIn = async (email) => { await freshLimits(); const r = await call('POST', '/auth/sign-in/email', undefined, { email, password }); assert.equal(r.statusCode, 200, r.body); return cookieOf(r); };
let admin, alice, aliceId, bob, serverId;

let app, port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let slowRuns = 0;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  // A state change that takes a moment, as a check of an address does; the panel's own hooks apply to it.
  app.getHttpAdapter().getInstance().post('/__test/slow', async () => { slowRuns++; await sleep(300); return { ok: true }; });
  await app.init();
  await app.listen(0, '127.0.0.1');
  port = app.getHttpAdapter().getInstance().server.address().port;
  const { token } = await issueBootstrapToken();
  assert.equal((await call('POST', '/setup/admin', undefined, { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = await signIn('boss@example.test');
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
  for (const email of ['alice@example.test', 'bob@example.test']) { await freshLimits(); await call('POST', '/auth/sign-up/email', undefined, { name: '', email, password }); }
  alice = await signIn('alice@example.test');
  bob = await signIn('bob@example.test');
  aliceId = (await one("SELECT id FROM users WHERE email = 'alice@example.test'")).id;
  // A location where firewalls can be attached and backups kept, and a server of Alice's ordered ten days ago.
  const conn = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, product, write_api, operations)
    VALUES ($1, 'Fixture', 'vcenter', 'vc.example.test', 443, 'svc', $2, 'system', '{}', 'available', '{"firewall": true}')`, [conn, encryptSecret('pw', 'not-this-connection')]);
  const poolId = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref, backup_datastore_moref)
    VALUES ('Fixture', $1, 'cluster-1', '{ds-1}', 'net-1', 'ds-1') RETURNING id`, [conn])).id;
  const img = (await one("INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('Debian', 'linux', $1, 'tpl-1') RETURNING id", [conn])).id;
  serverId = (await one(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state, created_at, root_password_enc)
    VALUES ($1, $2, $3, 'web-1', 2, 2048, 20, 10, 'TRY', 'ready', 'poweredOn', now() - interval '10 days', 'x') RETURNING id`, [aliceId, poolId, img])).id;
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

// A browser's POST with a session cookie; `leaveAfter` closes the connection before the answer (a reload).
function send(leaveAfter) {
  return new Promise((done) => {
    const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/__test/slow', headers: {
      'content-type': 'application/json', cookie: 'lvm.session_token=abc', 'x-lightning-csrf': '1', origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } },
    (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => done({ status: res.statusCode, body })); });
    req.on('error', (e) => done({ status: 0, error: e.code }));
    req.end('{"publicUrl":"http://127.0.0.1:8080"}');
    if (leaveAfter !== undefined) setTimeout(() => req.destroy(), leaveAfter);
  });
}

test('the same request twice at once: the second is refused while the first runs, and runs once the first has answered', async () => {
  slowRuns = 0;
  const [a, b] = await Promise.all([send(), sleep(50).then(() => send())]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(JSON.parse(b.body).code, 'DUPLICATE_REQUEST');
  assert.equal(slowRuns, 1);
  assert.equal((await send()).status, 200);
});

test('a request whose browser left before the answer does not block the same request afterwards', async () => {
  slowRuns = 0;
  const left = await send(50);
  assert.equal(left.status, 0, 'the connection was closed before the answer');
  // While the first one still runs on the server, the same request is still refused (no second run behind its back).
  const meanwhile = await send();
  assert.equal(meanwhile.status, 409);
  await sleep(400); // the first one has finished on the server
  const again = await send();
  assert.equal(again.status, 200, `refused after the first had finished: ${again.body}`);
  assert.equal(slowRuns, 2);
  assert.deepEqual(await redis.keys('dup:*'), [], 'no claim is left behind');
});

test('a server page says what to do next from the server\'s real state; each hint can be hidden by the one who sees it', async () => {
  const hints = async (cookie = alice) => { const r = await call('GET', `/servers/${serverId}/hints`, cookie); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  const first = await hints();
  // No backup ever, no firewall, the panel still keeps the root password; no snapshot was ever taken through the panel.
  assert.deepEqual(first.hints.map((h) => h.code), ['NO_BACKUP', 'NO_FIREWALL', 'ROOT_PASSWORD_KEPT']);
  assert.deepEqual(first.hints[0].params, { days: null, limit: 30 });
  assert.deepEqual(first.hints[1].action, { href: '/firewalls' });
  // A recent backup and a firewall: those two are gone.
  await pool.query(`INSERT INTO backups (server_id, owner_id, connection_id, datastore_moref, path, kind, status, finished_at)
    SELECT s.id, s.owner_id, p.connection_id, 'ds-1', 'x', 'manual', 'ready', now() - interval '2 days' FROM servers s JOIN resource_pools p ON p.id = s.pool_id WHERE s.id = $1`, [serverId]);
  const fw = (await one("INSERT INTO firewalls (owner_id, name) VALUES ($1, 'web') RETURNING id", [aliceId])).id;
  await pool.query('INSERT INTO firewall_servers (firewall_id, server_id) VALUES ($1, $2)', [fw, serverId]);
  assert.deepEqual((await hints()).hints.map((h) => h.code), ['ROOT_PASSWORD_KEPT']);
  // Hidden by Alice for good: not listed, counted; staff looking at the same server still see it.
  assert.equal((await call('PUT', '/insights/dismissals', alice, { key: `hint:ROOT_PASSWORD_KEPT:${serverId}`, days: null })).statusCode, 204);
  const after = await hints();
  assert.deepEqual([after.hints.length, after.hidden], [0, 1]);
  assert.deepEqual((await hints(admin)).hints.map((h) => h.code), ['ROOT_PASSWORD_KEPT']);
  // Another customer cannot see the server, nor its hints; nobody signed out either.
  assert.equal((await call('GET', `/servers/${serverId}/hints`, bob)).statusCode, 404);
  assert.equal((await call('GET', `/servers/${serverId}/hints`)).statusCode, 401);
  // A customer the admin does not allow backups gets no backup hint; staff may take backups on any server.
  await pool.query('DELETE FROM backups WHERE server_id = $1', [serverId]);
  const settings = (await call('GET', '/admin/settings/servers', admin)).json();
  assert.equal((await call('PUT', '/admin/settings/servers', admin, { ...settings, customer: { ...settings.customer, backups: false } })).statusCode, 200);
  assert.deepEqual((await hints()).hints.map((h) => h.code), []);
  assert.deepEqual((await hints(admin)).hints.map((h) => h.code), ['NO_BACKUP', 'ROOT_PASSWORD_KEPT']);
  assert.equal((await call('PUT', '/admin/settings/servers', admin, settings)).statusCode, 200);
});

test('"while you were away": one\'s own finished and failed operations, invoices and answers since the last "seen"; seen only on request', async () => {
  const add = (userId, event, link, ago = '1 hour') => pool.query(`INSERT INTO notifications (user_id, event, title, body, link, created_at)
    VALUES ($1, $2, $2, '', $3, now() - $4::interval)`, [userId, event, link, ago]);
  // Accounts opened ten days ago (a first visit lists from the account's start).
  await pool.query("UPDATE users SET created_at = now() - interval '10 days'");
  await add(aliceId, 'server.ready', `/servers/${serverId}`);
  await add(aliceId, 'server.failed', `/servers/${serverId}`, '2 hours');
  await add(aliceId, 'billing.overdue', '/billing/invoices/x', '3 hours');
  await add(aliceId, 'support.reply', '/support/y', '4 hours');
  await add(aliceId, 'auth.new_device', null, '5 hours'); // not one of the summary's
  await add(aliceId, 'server.ready', `/servers/${serverId}`, '45 days'); // further back than the list goes
  const bobId = (await one("SELECT id FROM users WHERE email = 'bob@example.test'")).id;
  await add(bobId, 'server.ready', '/servers/other');
  const away = (await call('GET', '/notifications/away', alice)).json();
  assert.deepEqual(away.counts, { done: 1, failed: 1, billing: 1, support: 1 });
  assert.deepEqual(away.items.map((i) => [i.event, i.kind, i.link]), [['server.ready', 'done', `/servers/${serverId}`], ['server.failed', 'failed', `/servers/${serverId}`],
    ['billing.overdue', 'billing', '/billing/invoices/x'], ['support.reply', 'support', '/support/y']]);
  // Reading it changed nothing.
  assert.equal((await call('GET', '/notifications/away', alice)).json().total, 4);
  assert.equal((await one('SELECT away_seen_at FROM users WHERE id = $1', [aliceId])).away_seen_at, null);
  // Marked seen with the ids it showed: empty from now on, and those are read in the inbox; Bob's are not touched.
  const ids = away.items.map((i) => i.id);
  const bobs = (await one('SELECT id FROM notifications WHERE user_id = $1', [bobId])).id;
  assert.equal((await call('POST', '/notifications/away/seen', alice, { ids: [...ids, bobs] })).statusCode, 204);
  assert.equal((await call('GET', '/notifications/away', alice)).json().total, 0);
  assert.equal((await one('SELECT count(*)::int AS n FROM notifications WHERE id = ANY($1) AND read_at IS NULL', [ids])).n, 0);
  assert.equal((await one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [bobId])).n, 1);
  await add(aliceId, 'billing.invoice', '/billing/invoices/z', '0 seconds');
  assert.deepEqual((await call('GET', '/notifications/away', alice)).json().counts, { done: 0, failed: 0, billing: 1, support: 0 });
  assert.equal((await call('GET', '/notifications/away')).statusCode, 401);
});
