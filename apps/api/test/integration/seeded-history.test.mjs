// The rule-based helpers on a realistic amount of history instead of a handful of rows: 200 servers of 20 customers
// with 14 days of five-minute CPU samples (about 800 000 rows), four weeks of hourly rows and 16 days of traffic
// (seed-history.mjs). The hourly roll-up, the usage watch, the schedule suggestion, the quietest hours and the
// insights are run end to end; their results are checked against what the seeded shapes of use must give, and how
// many statements and how long each takes is printed (docs/validation.md keeps the numbers) and held under a bound.
//
// It takes minutes and writes a million rows, so it runs only when asked for:
//   SEEDED=1 node --test --test-concurrency=1 test/integration/seeded-history.test.mjs
// TEST ONLY: like every file here it wipes the database it is given, and refuses one not named *_test.
// LVM_DIST / LVM_WORKER point it at another build (an earlier commit's), to compare numbers before and after a change.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
const wanted = process.env.SEEDED === '1';
const from = (dir, file) => pathToFileURL(resolve(dir, file)).href;
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = process.env.LVM_DIST ? resolve(process.env.LVM_DIST) : resolve(here, '../../dist');
const workerDir = process.env.LVM_WORKER ? resolve(process.env.LVM_WORKER) : resolve(here, '../../../worker');

const { createApp, closeConnections } = await import(from(dist, 'main.js'));
const { pool, redis } = await import(from(dist, 'db.js'));
const { issueBootstrapToken } = await import(from(dist, 'setup.js'));
const { runMigrations } = await import(from(dist, 'migrate.js'));
const { notificationQueue } = await import(from(dist, 'notify.js'));
const { encryptSecret } = await import(from(dist, 'secrets.js'));
const { rollupCpu, detectAnomalies } = await import(from(workerDir, 'anomalies.mjs'));
const { seedSite, seedServers, seedSamples, seedHourly, seedTraffic, counted, SHAPES } = await import('./seed-history.mjs');

const SERVERS = 200, OWNERS = 20, DAYS = 14;
let app, admin, owners = [], servers = [], site;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload) => app.inject({ method, url: path, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const say = (what, x) => console.log(`# seeded: ${what}: ${typeof x === 'string' ? x : JSON.stringify(x)}`);
const plan = async (sql, args = []) => (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, args)).rows[0]['QUERY PLAN'][0];
const nodes = (p, out = []) => { out.push(p['Node Type'] + (p['Index Name'] ? `(${p['Index Name']})` : p['Relation Name'] ? `(${p['Relation Name']})` : '')); for (const c of p.Plans ?? []) nodes(c, out); return out; };
const planned = async (label, sql, args) => { const p = await plan(sql, args); say(`plan ${label}`, { ms: Math.round(p['Execution Time'] * 10) / 10, buffers: (p.Plan['Shared Hit Blocks'] ?? 0) + (p.Plan['Shared Read Blocks'] ?? 0), nodes: nodes(p.Plan).join(' > ') }); return p; };
const clearCaches = async () => { for (const pattern of ['insight:*', 'insights:*', 'quiet:*']) for (const k of await redis.keys(pattern)) await redis.del(k); };
const shapeOf = (name) => servers.filter((s) => SHAPES[s.shape] === name);
// The pool's connections are opened before a measurement begins: on a slow machine opening one can take longer than
// the pool waits (3 s), and what is measured here is the statements, not the handshake.
const warm = async () => { for (let i = 0; i < 5; i++) { const r = await Promise.allSettled(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.05)'))); if (r.every((x) => x.status === 'fulfilled')) return; } };

before(async () => {
  if (!wanted) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await call('POST', '/setup/admin', undefined, { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email: 'boss@example.test', password }));
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
  for (let i = 0; i < OWNERS; i++) {
    for (const k of await redis.keys('rl:*')) await redis.del(k);
    const r = await call('POST', '/auth/sign-up/email', undefined, { name: '', email: `owner-${i}@example.test`, password });
    assert.equal(r.statusCode, 200, r.body);
    owners.push({ id: r.json().user.id, cookie: cookieOf(r) });
  }
  site = await seedSite(pool, encryptSecret, { name: 'seeded' });
  servers = await seedServers(pool, site, owners.map((o) => o.id), SERVERS);
  // Four hosts, the servers spread over them, as the inventory would have them.
  for (let h = 0; h < 4; h++) await pool.query('INSERT INTO vmware_hosts (connection_id, moref, name, hardware_uuid) VALUES ($1, $2, $3, $4)', [site.connection, `host-${h}`, `esx-${h}`, `hw-${h}`]);
  await pool.query(`INSERT INTO vmware_vms (connection_id, moref, name, host_moref) SELECT $1, s.vm_moref, s.name, 'host-' || (row_number() OVER (ORDER BY s.name) % 4) FROM servers s WHERE s.pool_id = $2`, [site.connection, site.pool]);
  let t = performance.now();
  const samples = await seedSamples(pool, servers, DAYS);
  const traffic = await seedTraffic(pool, servers);
  // The two weeks before the samples, as the hourly rows earlier roll-ups left behind.
  const older = await seedHourly(pool, servers, 28, DAYS);
  // Two weeks of running bring autovacuum round more than once: the tables are in that state, not freshly loaded.
  await pool.query('VACUUM ANALYZE');
  say('seeded', { servers: servers.length, owners: owners.length, samples, traffic, olderHourlyRows: older, seconds: Math.round((performance.now() - t) / 1000) });
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('the roll-up: all there is the first time, only what is new afterwards', { skip: !wanted }, async () => {
  const had = (await one('SELECT count(*)::int AS n FROM server_cpu_hourly')).n;
  const first = await counted(pool, () => rollupCpu(pool));
  const rows = (await one(`SELECT count(*)::int AS n, count(DISTINCT server_id)::int AS servers, max(samples) AS most FROM server_cpu_hourly WHERE hour >= date_trunc('hour', now(), 'UTC') - make_interval(days => $1)`, [DAYS]));
  say('roll-up, first run over 14 days', { queries: first.queries, ms: first.ms, hourlyRows: rows.n });
  // Every server has every hour of the 14 days (and the hour in progress), twelve samples in each full hour; the older weeks are untouched.
  assert.equal(rows.servers, SERVERS);
  assert.ok(rows.n >= SERVERS * DAYS * 24 && rows.n <= SERVERS * (DAYS * 24 + 2), String(rows.n));
  assert.equal(rows.most, 12);
  assert.ok((await one('SELECT count(*)::int AS n FROM server_cpu_hourly')).n >= had + SERVERS * DAYS * 24 - SERVERS);
  await pool.query('ANALYZE server_cpu_hourly');
  const again = await counted(pool, () => rollupCpu(pool));
  say('roll-up, the hourly run (nothing new but the newest hour)', { queries: again.queries, ms: again.ms });
  assert.equal(again.queries, 2);
  assert.equal((await one(`SELECT count(*)::int AS n FROM server_cpu_hourly WHERE hour >= date_trunc('hour', now(), 'UTC') - make_interval(days => $1)`, [DAYS])).n, rows.n, 'nothing doubled');
  // What the hourly run reads: the samples since the newest rolled-up hour, found through the index on their time.
  const p = await planned('roll-up read of the newest hour', `SELECT server_id, date_trunc('hour', at, 'UTC'), avg(cpu_pct), max(cpu_pct), count(*) FROM server_cpu_samples
    WHERE at >= coalesce((SELECT max(hour) FROM server_cpu_hourly), '-infinity'::timestamptz) GROUP BY 1, 2`);
  const pages = (await one("SELECT relpages FROM pg_class WHERE relname = 'server_cpu_samples'")).relpages;
  const read = (x) => (x.Plan['Shared Hit Blocks'] ?? 0) + (x.Plan['Shared Read Blocks'] ?? 0);
  say('table pages', pages);
  assert.ok(read(p) < pages / 4, `the hourly read touched ${read(p)} of ${pages} pages`);
  // The samples are kept 14 days and the oldest are deleted, their room is used again: the index must go on finding
  // "the newest hour" without reading the table. A day is removed, the room reclaimed, an hour of new samples added.
  await pool.query("DELETE FROM server_cpu_samples WHERE at < now() - interval '13 days'");
  await pool.query('VACUUM server_cpu_samples');
  await pool.query(`INSERT INTO server_cpu_samples (server_id, at, cpu_pct) SELECT s.id, t, 5 FROM servers s, generate_series(now() + interval '1 minute', now() + interval '56 minutes', interval '5 minutes') t ORDER BY t`);
  await pool.query('ANALYZE server_cpu_samples');
  // Asked of the block range index itself (PostgreSQL 18 would rather skip through the primary key; the panel's
  // PostgreSQL 17 has no such way): the ranges it must read for "since now" are the ones just written.
  const db = await pool.connect();
  let churned;
  try {
    await db.query('SET enable_indexonlyscan = off; SET enable_indexscan = off');
    churned = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM server_cpu_samples WHERE at >= now()')).rows[0]['QUERY PLAN'][0];
    await db.query('RESET enable_indexonlyscan; RESET enable_indexscan');
  } finally { db.release(); }
  say('plan the same read after a day was deleted and its room used again', { ms: Math.round(churned['Execution Time'] * 10) / 10, buffers: read(churned), nodes: nodes(churned.Plan).join(' > ') });
  assert.ok(read(churned) < pages / 4, `after the churn the read touched ${read(churned)} of ${pages} pages`);
  await pool.query('DELETE FROM server_cpu_samples WHERE at > now()');
  await pool.query('VACUUM ANALYZE server_cpu_samples');
  say('hourly rows in all', (await one('SELECT count(*)::int AS n FROM server_cpu_hourly')).n);
});

test('the usage watch: ordinary rhythms of use are not findings, real departures are, in a bounded number of statements', { skip: !wanted }, async () => {
  const sent = [];
  const notify = async (event, to, data) => { sent.push({ event, to, data }); };
  await warm();
  const quiet = await counted(pool, () => detectAnomalies(pool, notify, () => {}, new Date()));
  const open = async () => (await pool.query(`SELECT s.name, a.metric, a.direction, a.detail FROM usage_anomalies a JOIN servers s ON s.id = a.server_id WHERE a.resolved_at IS NULL ORDER BY s.name, a.metric`)).rows;
  say('usage watch on ordinary use', { ...quiet.result, queries: quiet.queries, ms: quiet.ms, when: new Date().toISOString(), findings: (await open()).map((f) => `${f.name} ${f.metric} ${f.direction} ${JSON.stringify(f.detail)}`).slice(0, 6) });
  // Office servers idle at weekends and at night, a nightly batch, a daily wave, flat and idle servers: every one of
  // them is doing what it does every week. Nothing is unusual, whatever the hour and weekday this runs at.
  assert.deepEqual(await open(), [], 'ordinary weekly and daily rhythms must not be findings');
  assert.equal(quiet.result.servers, SERVERS);
  // One batch of 200 servers: the list, three reads, the two clean-ups, and "today".
  assert.ok(quiet.queries <= 8, `${quiet.queries} statements for a run without findings`);

  // Real departures: an idle server pinned for the last three hours, a flat one gone silent, a day of traffic far above usual.
  const [pinned] = shapeOf('idle'), [silent] = shapeOf('flat'), [flood] = shapeOf('web');
  await pool.query("UPDATE server_cpu_hourly SET avg_pct = 97, max_pct = 100 WHERE server_id = $1 AND hour >= date_trunc('hour', now(), 'UTC') - interval '3 hours'", [pinned.id]);
  await pool.query("UPDATE server_cpu_hourly SET avg_pct = 0.4, max_pct = 1 WHERE server_id = $1 AND hour >= date_trunc('hour', now(), 'UTC') - interval '3 hours'", [silent.id]);
  await pool.query('UPDATE server_traffic SET rx_bytes = 2e9, tx_bytes = 78e9 WHERE server_id = $1 AND day = current_date - 1', [flood.id]);
  const found = await counted(pool, () => detectAnomalies(pool, notify, () => {}, new Date()));
  say('usage watch with three departures', { ...found.result, queries: found.queries, ms: found.ms });
  assert.deepEqual((await open()).map((f) => [f.name, f.metric, f.direction, f.detail.hint]), [[pinned.name, 'cpu', 'high', 'cpu_pinned'], [silent.name, 'cpu', 'low', null], [flood.name, 'network', 'high', 'outbound']].sort((x, y) => x[0].localeCompare(y[0])));
  assert.equal(sent.length, 3, 'each owner told once');
  assert.ok(found.queries <= 8 + 3, `${found.queries} statements with three findings`);
  const again = await detectAnomalies(pool, notify, () => {}, new Date());
  assert.deepEqual([again.opened, again.resolved, sent.length], [0, 0, 3]);
  await planned('usage watch, hourly rows of 200 servers over 15 days', 'SELECT server_id, hour, avg_pct::float8 AS v FROM server_cpu_hourly WHERE server_id = ANY($1::uuid[]) AND hour >= $2', [servers.map((s) => s.id), new Date(Date.now() - 15 * 86_400_000)]);
});

test('the schedule suggestion: an office server gets its nights and weekends, the others get none, and why is said', { skip: !wanted }, async () => {
  const ownerOf = async (s) => owners.find((o) => o.id === s.owner).cookie;
  for (const s of servers) s.owner ??= (await one('SELECT owner_id FROM servers WHERE id = $1', [s.id])).owner_id;
  const advice = async (s) => (await get(`/servers/${s.id}/schedule-suggestion?timezone=UTC`, await ownerOf(s))).json();
  const timedServer = shapeOf('office')[1];
  await warm();
  const timed = await counted(pool, async () => get(`/servers/${timedServer.id}/schedule-suggestion?timezone=Europe/Istanbul`, await ownerOf(timedServer)));
  say('schedule suggestion, one server (GET)', { queries: timed.queries, ms: timed.ms, state: timed.result.json().state });
  const office = await advice(shapeOf('office')[0]);
  // Busy 08:00-17:59 UTC on working days: off at 19:00, on at 07:00, Monday to Friday; 108 hours a week off.
  assert.deepEqual([office.state, office.kind, office.offHours, office.schedules], ['suggested', 'nightly', 108, [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '07:00' }]]);
  // (The first server of these shapes had its last hours changed by the usage watch test above; the second is untouched.)
  assert.deepEqual([(await advice(shapeOf('idle')[1])).state, (await advice(shapeOf('flat')[1])).state, (await advice(shapeOf('web')[1])).state], ['always_idle', 'no_window', 'no_window']);
  // The idle server that was pinned for three hours an hour ago is no longer "idle around the clock": it has a window now.
  assert.equal((await advice(shapeOf('idle')[0])).state, 'suggested');
  // A nightly batch on an otherwise lightly used server is "in use" around the clock by the rule's thresholds (5-7 %).
  assert.equal((await advice(shapeOf('batch')[0])).state, 'no_window');
  assert.ok(timed.queries <= 20, `${timed.queries} statements`);
});

// (Skipped against a build from before the quietest hours existed.)
test('the quietest hours: the night between the batch and the working day, for the installation, the connection and each host', { skip: !wanted || !existsSync(resolve(dist, 'maintenance-hours.js')) }, async () => {
  await clearCaches();
  const cold = await counted(pool, () => get('/admin/maintenance/quiet-hours', admin));
  const a = cold.result.json();
  say('quietest hours, whole installation (cold)', { queries: cold.queries, ms: cold.ms, window: a.window, daily: a.daily, weekly: a.weekly, usual: a.usual, peak: a.peak, servers: a.servers });
  assert.deepEqual([a.state, a.days, a.weeks, a.servers], ['suggested', 28, 4, SERVERS]);
  // The batch runs 01:00-03:59 UTC, offices work 08:00-17:59, the daily wave is lowest at 02:00 and highest at 14:00:
  // the quietest two hours are right after the batch (04:00) or right before it (23:00), where the wave is as low.
  assert.ok(['04:00', '23:00'].includes(a.daily.time), a.daily.time);
  assert.ok(a.daily.load < a.usual && a.usual < a.peak);
  // The quietest of the week is at a weekend, when the offices are idle around the clock... at night they are idle anyway: any night will do.
  assert.ok(a.weekly.load <= a.daily.load + 1e-9);
  const warm = await counted(pool, () => get('/admin/maintenance/quiet-hours', admin));
  say('quietest hours, whole installation (kept answer)', { queries: warm.queries, ms: warm.ms });
  assert.ok(warm.queries < cold.queries);
  const conn = await counted(pool, () => get(`/admin/vmware/connections/${site.connection}/quiet-hours?timezone=UTC`, admin));
  const c = conn.result.json();
  say('quietest hours, connection and 4 hosts (cold)', { queries: conn.queries, ms: conn.ms, connection: c.connection.daily, hosts: c.hosts.map((h) => `${h.name} ${h.servers} ${h.daily?.time}`) });
  assert.deepEqual([c.connection.state, c.connection.daily.time, c.hosts.length, c.hosts.map((h) => h.servers)], ['suggested', a.daily.time, 4, [50, 50, 50, 50]]);
  await planned('quietest hours, grouped read of 4 weeks', `SELECT h.hour, sum(h.avg_pct * s.vcpu / 100)::float8, count(*)::int FROM server_cpu_hourly h JOIN servers s ON s.id = h.server_id JOIN resource_pools p ON p.id = s.pool_id
    JOIN vmware_connections c ON c.id = p.connection_id WHERE h.hour >= date_trunc('hour', now()) - make_interval(days => 28) AND h.hour < date_trunc('hour', now()) AND s.deleted_at IS NULL GROUP BY 1`);
});

test('the insights a page asks for every minute: what one customer\'s and the staff\'s cost', { skip: !wanted }, async () => {
  const o = owners[0];
  const samples = (x) => x.statements.filter((q) => q.includes('server_cpu_samples')).length;
  const cost = (x) => ({ queries: x.queries, ms: x.ms, readsOfTheSamples: samples(x) });
  await clearCaches();
  for (const k of await redis.keys('cpustats:*')) await redis.del(k);
  const cold = await counted(pool, () => get('/insights', o.cookie));
  assert.equal(cold.result.statusCode, 200);
  const codes = cold.result.json().insights.map((i) => i.code);
  const polls = [];
  for (let i = 0; i < 5; i++) polls.push(await counted(pool, () => get('/insights', o.cookie)));
  say('GET /insights, a customer with 10 servers, first call', { ...cost(cold), codes: [...new Set(codes)] });
  say('GET /insights, the same customer, the calls of the following minutes', { ...cost(polls[0]), ms: polls.map((w) => w.ms) });
  // The staff list: nothing kept; then the list run out (every minute while a dashboard is open, every ten for the
  // alerts) with the week's CPU figures still kept; then the kept list itself.
  await redis.del('insights:staff');
  for (const k of await redis.keys('cpustats:*')) await redis.del(k);
  const staffCold = await counted(pool, () => get('/admin/insights', admin));
  await redis.del('insights:staff');
  const staffAgain = await counted(pool, () => get('/admin/insights', admin));
  const staffKept = await counted(pool, () => get('/admin/insights', admin));
  say('GET /admin/insights with 200 servers', { nothingKept: cost(staffCold), listWorkedOutAgain: cost(staffAgain), keptList: cost(staffKept), codes: staffCold.result.json().insights.map((i) => i.code) });
  await planned('a week of samples of 10 servers (one customer)', `SELECT server_id, avg(cpu_pct), percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_pct), count(*) FROM server_cpu_samples WHERE server_id = ANY($1::uuid[]) AND at > now() - interval '7 days' GROUP BY server_id`,
    [(await pool.query('SELECT id FROM servers WHERE owner_id = $1', [o.id])).rows.map((r) => r.id)]);
  await planned('a week of samples of 200 servers (the staff list)', `SELECT server_id, avg(cpu_pct), percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_pct), count(*) FROM server_cpu_samples WHERE server_id = ANY($1::uuid[]) AND at > now() - interval '7 days' GROUP BY server_id`, [servers.map((x) => x.id)]);

  // Two servers of every shape: the two office servers are offered a schedule, the two idle ones are called idle.
  assert.equal(codes.filter((c) => c === 'SCHEDULE_SUGGESTED').length, 2);
  assert.equal(codes.filter((c) => c === 'IDLE_SERVER').length, 2);
  // A poll is a bounded number of small statements, and it does not read the week of samples again.
  assert.ok(polls[0].queries <= 32, `${polls[0].queries} statements for a poll`);
  assert.equal(samples(cold), 1, 'read once');
  assert.equal(samples(polls[0]), 0, 'the week of samples is not read again by the next polls');
  assert.equal(samples(staffAgain), 0, 'nor by the staff list while the figures are kept');
  assert.ok(staffKept.queries <= 6);
});

// Last, because it takes the helpers' tables away first: the database as an installation of 0.4.0 has it (migration
// 087), with its users, servers and 14 days of samples in place, is brought up to date as an upgrade would do it.
test('the migrations after 0.4.0 apply to a database that already has data, once', { skip: !wanted || !existsSync(resolve(dist, 'maintenance-hours.js')) }, async () => {
  const samples = (await one('SELECT count(*)::int AS n FROM server_cpu_samples')).n, users = (await one('SELECT count(*)::int AS n FROM users')).n;
  await pool.query('DROP TABLE IF EXISTS digest_preferences, usage_anomalies, server_cpu_hourly');
  await pool.query('DROP INDEX IF EXISTS server_cpu_samples_at');
  await pool.query('ALTER TABLE users DROP COLUMN IF EXISTS budget_forecast_alerted');
  await pool.query("DELETE FROM schema_migrations WHERE version >= '088'");
  const before = (await one('SELECT count(*)::int AS n, max(version) AS last FROM schema_migrations'));
  assert.equal(before.last.slice(0, 3), '087');
  const run = await counted(pool, () => runMigrations(pool));
  say('migrations 088-091 on a database with data', { applied: run.result, ms: run.ms, samples, users });
  assert.deepEqual(run.result.map((v) => v.slice(0, 3)), ['088', '089', '090', '091']);
  assert.match((await one("SELECT array_to_string(reloptions, ',') AS o FROM pg_class WHERE relname = 'server_cpu_samples_at'")).o ?? '', /autosummarize=on/);
  // Nothing that was there is lost or rewritten; the new tables are empty; each migration is recorded once.
  assert.deepEqual([(await one('SELECT count(*)::int AS n FROM server_cpu_samples')).n, (await one('SELECT count(*)::int AS n FROM users')).n], [samples, users]);
  assert.deepEqual((await pool.query('SELECT (SELECT count(*)::int FROM usage_anomalies) AS a, (SELECT count(*)::int FROM server_cpu_hourly) AS h, (SELECT count(*)::int FROM digest_preferences) AS d')).rows[0], { a: 0, h: 0, d: 0 });
  assert.deepEqual((await pool.query("SELECT version, count(*)::int AS n FROM schema_migrations WHERE version >= '088' GROUP BY 1 ORDER BY 1")).rows.map((r) => [r.version.slice(0, 3), r.n]), [['088', 1], ['089', 1], ['090', 1], ['091', 1]]);
  assert.deepEqual(await runMigrations(pool), [], 'a second start applies nothing');
  assert.equal((await one('SELECT count(*)::int AS n FROM schema_migrations')).n, before.n + 4);
  // The first hourly run after the upgrade rolls up everything the samples hold, once.
  const first = await counted(pool, () => rollupCpu(pool));
  say('the first roll-up after the upgrade', { ms: first.ms, hourlyRows: (await one('SELECT count(*)::int AS n FROM server_cpu_hourly')).n });
});
