// The quietest hours against real PostgreSQL and Redis: who may read them; without a platform that reports CPU
// figures, and with too short a history, the answer is "not measured" / "not enough data" and no window is offered;
// four weeks of history give the quietest two hours in the panel server's own time zone (UTC, marked as not
// applicable, when the agent has not recorded it) with the numbers behind them; a connection's page gets the
// connection as a whole and each host that runs panel servers, in the viewer's zone; and the window only changes
// through the existing maintenance request (system.update), whose audit record says that it was the suggested one.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const maint = mkdtempSync(tmpdir() + '/lvm-quiet-');
process.env.MAINTENANCE_DIR = maint;
process.env.MAINTENANCE_REQUESTS_DIR = maint + '/requests';
mkdirSync(maint + '/requests');

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { notificationQueue } = await import('../../dist/notify.js');
const { encryptSecret } = await import('../../dist/secrets.js');
const { seedSite } = await import('./seed-history.mjs');

let app, admin, adminId, customer, customerId, viewer, site, blind;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload) => app.inject({ method, url: path, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const forget = async () => { for (const k of await redis.keys('quiet:*')) await redis.del(k); };
const panel = async (cookie = admin) => { await forget(); return (await get('/admin/maintenance/quiet-hours', cookie)).json(); };
const ofConnection = async (id, zone, cookie = admin) => { await forget(); return get(`/admin/vmware/connections/${id}/quiet-hours${zone ? `?timezone=${encodeURIComponent(zone)}` : ''}`, cookie); };
const server = async (name, poolId = site.pool, vcpu = 2) => (await one(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state, vm_moref)
  VALUES ($1, $2, $3, $4, $5, 2048, 20, 80, 'TRY', 'ready', 'poweredOn', $6) RETURNING id`, [customerId, poolId, site.image, name, vcpu, `vm-${name}`])).id;
// Hourly rows for the last `days` days: `busy` (SQL over h, a timestamptz) says when the server works at 40 %; idle is 0.5 %.
const history = (serverId, busy, days = 28) => pool.query(`INSERT INTO server_cpu_hourly (server_id, hour, avg_pct, max_pct, samples)
  SELECT $1, h, CASE WHEN ${busy} THEN 40 ELSE 0.5 END, CASE WHEN ${busy} THEN 80 ELSE 2 END, 12
  FROM generate_series(date_trunc('hour', now(), 'UTC') - make_interval(days => $2), date_trunc('hour', now(), 'UTC') - interval '1 hour', interval '1 hour') h`, [serverId, days]);
const office = "EXTRACT(ISODOW FROM h AT TIME ZONE 'UTC') <= 5 AND EXTRACT(HOUR FROM h AT TIME ZONE 'UTC') BETWEEN 8 AND 17";
const evening = "EXTRACT(HOUR FROM h AT TIME ZONE 'UTC') BETWEEN 21 AND 23";
const staff = async (email, permissions) => {
  const key = `quiet-${email.split('@')[0]}`;
  assert.equal((await call('POST', '/admin/roles', admin, { key, name: key, permissions })).statusCode, 201);
  const id = (await call('POST', '/auth/admin/create-user', admin, { email, password, name: key, role: 'user' })).json().user.id;
  assert.equal((await call('PUT', `/admin/users/${id}/access`, admin, { roles: [key], overrides: [] })).statusCode, 200);
  return cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email, password }));
};
const hostSays = (timezone) => (timezone ? writeFileSync(`${maint}/host.json`, JSON.stringify({ checkedAt: new Date().toISOString(), time: Date.now(), hostname: 'panel', timezone })) : rmSync(`${maint}/host.json`, { force: true }));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await call('POST', '/setup/admin', undefined, { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email: 'boss@example.test', password }));
  adminId = (await get('/auth/me', admin)).json().id;
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
  for (const k of await redis.keys('rl:*')) await redis.del(k);
  const r = await call('POST', '/auth/sign-up/email', undefined, { name: '', email: 'a@example.test', password });
  assert.equal(r.statusCode, 200, r.body);
  [customer, customerId] = [cookieOf(r), r.json().user.id];
  viewer = await staff('viewer@example.test', ['system.view']);
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'on', autoUpdate: 'on', updateChannel: 'stable', updateWindow: '01:00-03:00' }));
  hostSays('Europe/Istanbul');
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); rmSync(maint, { recursive: true, force: true }); });

test('only staff who may open the page read them; nothing measured and too little history are said as such', async () => {
  assert.equal((await get('/admin/maintenance/quiet-hours')).statusCode, 401);
  assert.equal((await get('/admin/maintenance/quiet-hours', customer)).statusCode, 403);
  assert.equal((await get('/admin/maintenance/quiet-hours', viewer)).statusCode, 200);
  // No connection at all, then only a platform whose CPU figures are not believed.
  assert.deepEqual(await panel(), { days: 0, minDays: 21, weeks: 4, state: 'not_measured', timezone: 'Europe/Istanbul', zoneKnown: true, window: null, current: '01:00-03:00' });
  blind = await seedSite(pool, encryptSecret, { name: 'quiet-xcp', kind: 'xcpng' });
  site = blind;
  const x = await server('xcp');
  await history(x, office);
  assert.equal((await panel()).state, 'not_measured');
  const xr = await ofConnection(blind.connection, 'UTC');
  assert.deepEqual([xr.statusCode, xr.json().connection.state, xr.json().hosts], [200, 'not_measured', []]);

  site = await seedSite(pool, encryptSecret, { name: 'quiet-esxi' });
  assert.deepEqual([(await panel()).state, (await panel()).days], ['not_enough_data', 0]);
  const young = await server('young');
  await history(young, office, 14);
  const short = await panel();
  assert.deepEqual([short.state, short.days, short.window], ['not_enough_data', 14, null]);
  await pool.query('DELETE FROM servers WHERE id = $1', [young]);
});

test('four weeks give the quietest two hours in the panel server\'s zone, with the numbers; UTC and not applicable without one', async () => {
  // Three office servers (busy 08:00-17:59 UTC on working days) and one that works every evening from 21:00 to 23:59 UTC.
  const ids = [await server('office-1'), await server('office-2'), await server('office-3'), await server('evening')];
  for (const id of ids.slice(0, 3)) await history(id, office);
  await history(ids[3], evening);
  // A server that is gone, and the one on the platform without figures, count for nothing however busy they were.
  const gone = await server('gone');
  await history(gone, 'true');
  await pool.query("UPDATE servers SET state = 'deleted', deleted_at = now() WHERE id = $1", [gone]);

  const a = await panel();
  // In Istanbul (UTC+3) the evening server is busy from 00:00 to 02:59, the offices from 11:00 to 20:59: the first
  // two hours in which nothing works on any day begin at 03:00. Idle: 4 servers x 2 vCPU x 0.5 % = 0.04 busy vCPUs.
  assert.deepEqual([a.state, a.timezone, a.zoneKnown, a.window, a.current], ['suggested', 'Europe/Istanbul', true, '03:00-05:00', '01:00-03:00']);
  assert.deepEqual([a.days, a.weeks, a.servers], [28, 4, 4]);
  assert.deepEqual(a.daily, { day: 0, time: '03:00', end: '05:00', hours: 2, load: 0.04, worst: 0.04 });
  assert.deepEqual([a.weekly.day, a.weekly.time, a.weekly.end, a.weekly.load], [1, '03:00', '05:00', 0.04]);
  // The busiest hour: three offices at 40 % of 2 vCPUs, the evening server idle.
  assert.equal(a.peak, 2.41);
  assert.ok(a.usual > 0.04 && a.usual < 2.41, String(a.usual));

  // The agent has not recorded the server's zone: the hours are UTC and the page is told not to offer them.
  hostSays(null);
  const utc = await panel();
  assert.deepEqual([utc.timezone, utc.zoneKnown, utc.window], ['UTC', false, '00:00-02:00']);
  hostSays('Not/AZone');
  assert.deepEqual([(await panel()).timezone, (await panel()).zoneKnown], ['UTC', false]);
  hostSays('Europe/Istanbul');

  // Kept for half an hour: a second read costs no statement on the history.
  await forget();
  await get('/admin/maintenance/quiet-hours', admin);
  await pool.query('DELETE FROM server_cpu_hourly WHERE server_id = $1', [ids[3]]);
  assert.equal((await get('/admin/maintenance/quiet-hours', admin)).json().window, '03:00-05:00', 'the kept answer');
  assert.equal((await panel()).window, '00:00-02:00', 'worked out again without the evening server');
  await history(ids[3], evening);
});

test('a connection and its hosts, in the viewer\'s zone; who may read them', async () => {
  const c = site.connection;
  assert.equal((await ofConnection(c, 'UTC', null)).statusCode, 401);
  assert.equal((await ofConnection(c, 'UTC', customer)).statusCode, 403);
  assert.equal((await ofConnection(c, 'UTC', viewer)).statusCode, 403, 'system.view does not open a connection');
  assert.equal((await ofConnection(c, 'Mars/Olympus')).statusCode, 400);
  assert.equal((await ofConnection('00000000-0000-4000-8000-000000000000', 'UTC')).statusCode, 404);
  assert.equal((await ofConnection('nope', 'UTC')).statusCode, 400);

  // Inventory: the offices run on host-a, the evening server on host-b, host-c is empty.
  for (const [moref, name] of [['host-a', 'esx-a'], ['host-b', 'esx-b'], ['host-c', 'esx-c']]) await pool.query('INSERT INTO vmware_hosts (connection_id, moref, name, hardware_uuid) VALUES ($1, $2, $3, $4)', [c, moref, name, `hw-${moref}`]);
  for (const [vm, host] of [['office-1', 'host-a'], ['office-2', 'host-a'], ['office-3', 'host-a'], ['evening', 'host-b']]) await pool.query('INSERT INTO vmware_vms (connection_id, moref, name, host_moref) VALUES ($1, $2, $2, $3)', [c, `vm-${vm}`, host]);
  const r = (await ofConnection(c, 'UTC')).json();
  assert.equal(r.timezone, 'UTC');
  assert.deepEqual([r.connection.state, r.connection.servers, r.connection.daily.time, r.connection.daily.load], ['suggested', 4, '00:00', 0.04]);
  assert.deepEqual(r.hosts.map((h) => [h.moref, h.name, h.state, h.servers, h.daily.time, h.daily.load, h.peak]), [['host-a', 'esx-a', 'suggested', 3, '00:00', 0.03, 2.4], ['host-b', 'esx-b', 'suggested', 1, '00:00', 0.01, 0.8]]);
  // The evening host is busy from 21:00 UTC: in Istanbul its quiet hours begin at 03:00, the offices' at 00:00.
  const ist = (await ofConnection(c, 'Europe/Istanbul')).json();
  assert.deepEqual(ist.hosts.map((h) => [h.moref, h.daily.time]), [['host-a', '00:00'], ['host-b', '03:00']]);
  // Without a zone in the request: the account's own, else UTC.
  assert.equal((await ofConnection(c)).json().timezone, 'UTC');
  await pool.query("UPDATE users SET time_zone = 'Europe/Berlin' WHERE id = $1", [adminId]);
  assert.equal((await ofConnection(c)).json().timezone, 'Europe/Berlin');
});

test('the window changes only by the existing request, and the record says it was the suggested one', async () => {
  const a = await panel();
  const body = { action: 'auto-update', enabled: true, channel: 'stable', window: a.window, suggested: true };
  assert.equal((await call('POST', '/admin/maintenance/requests', customer, body)).statusCode, 403);
  assert.equal((await call('POST', '/admin/maintenance/requests', viewer, body)).statusCode, 403, 'reading is not changing');
  assert.deepEqual(readdirSync(`${maint}/requests`), []);
  const done = await call('POST', '/admin/maintenance/requests', admin, body);
  assert.equal(done.statusCode, 202, done.body);
  const [file] = readdirSync(`${maint}/requests`);
  const sent = readFileSync(`${maint}/requests/${file}`, 'utf8');
  assert.match(sent, /^window=03:00-05:00$/m);
  assert.doesNotMatch(sent, /suggested/, 'the agent is not told more than before');
  const { rows: [audit] } = await pool.query("SELECT actor_id, metadata FROM audit_events WHERE action = 'maintenance.request' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([audit.actor_id, audit.metadata.window, audit.metadata.suggested], [adminId, '03:00-05:00', true]);
  rmSync(`${maint}/requests/${file}`);
  // A window typed by hand is recorded without the mark; the mark alone changes nothing else.
  assert.equal((await call('POST', '/admin/maintenance/requests', admin, { action: 'auto-update', enabled: true, window: '04:00-06:00' })).statusCode, 202);
  const { rows: [plain] } = await pool.query("SELECT metadata FROM audit_events WHERE action = 'maintenance.request' ORDER BY created_at DESC LIMIT 1");
  assert.equal(plain.metadata.suggested, undefined);
});
