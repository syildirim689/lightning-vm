// Usage anomalies against real PostgreSQL and Redis: the worker's hourly run (apps/worker/anomalies.mjs, called here
// with this database) rolls the CPU samples up per hour, opens a finding for a server whose use left its own
// baseline, tells the owner once, keeps it while it holds and closes it afterwards; the owner reads it on the server
// and in the insights and can hide it, nobody else's customer sees it, staff see the list with the abuse note, and a
// platform without CPU figures or a server without history is "not enough data", never a guess.
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
const { notificationQueue, catalog } = await import('../../dist/notify.js');
const { encryptSecret } = await import('../../dist/secrets.js');
const { runAnomalies, rollupCpu, ROLLUP_KEEP_DAYS } = await import('../../../worker/anomalies.mjs');

let app, admin, a, aId, b, site, quiet;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie) => call('POST', url, cookie, payload);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); assert.equal(r.statusCode, 200, r.body); return [cookieOf(r), r.json().user.id]; };
const server = async (ownerId, name, poolId = site.pool, extra = {}) => {
  const cols = { owner_id: ownerId, pool_id: poolId, image_id: site.image, name, vcpu: 2, memory_mb: 2048, disk_gb: 20, price_monthly: '80.00', currency: 'TRY', state: 'ready', power_state: 'poweredOn', vm_moref: `vm-${name}`, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO servers (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = new Date();
const end = Math.floor(now.getTime() / HOUR) * HOUR; // the hour in progress
// Two samples in every hour from `from` to `to` (ms), at `pct` percent.
const samples = (serverId, from, to, pct) => pool.query(`INSERT INTO server_cpu_samples (server_id, at, cpu_pct)
  SELECT $1, h + m, $4 FROM generate_series($2::timestamptz, $3::timestamptz - interval '1 hour', interval '1 hour') h, (VALUES (interval '10 minutes'), (interval '40 minutes')) x(m)
  ON CONFLICT (server_id, at) DO UPDATE SET cpu_pct = EXCLUDED.cpu_pct`, [serverId, new Date(from), new Date(to), pct]);
// The last three complete hours as later runs would have rolled them up (hours already rolled up are not read again).
const lately = (serverId, pct) => pool.query('UPDATE server_cpu_hourly SET avg_pct = $2, max_pct = $2 WHERE server_id = $1 AND hour >= $3', [serverId, pct, new Date(end - 3 * HOUR)]);
const sent = [];
const notify = async (event, to, data) => { sent.push({ event, to, data }); };
const run = () => runAnomalies(pool, notify, () => {}, now);
const open = (serverId) => pool.query('SELECT metric, direction, detail FROM usage_anomalies WHERE server_id = $1 AND resolved_at IS NULL ORDER BY metric', [serverId]).then((r) => r.rows);
const mine = async (cookie) => (await get('/insights', cookie)).json().insights.filter((i) => i.code.startsWith('USAGE_ANOMALY'));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await post('/setup/admin', { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await post('/auth/sign-in/email', { email: 'boss@example.test', password }));
  await put('/admin/settings', { registrationOpen: true }, admin);
  [a, aId] = await signUp('a@example.test');
  [b] = await signUp('b@example.test');
  const conn = randomUUID(), xcp = randomUUID();
  for (const [id, kind] of [[conn, 'esxi'], [xcp, 'xcpng']]) await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, $2, $3, $4, 'root', $5, 'system', '{}', 'unknown')`, [id, `it-anomaly-${kind}`, kind, `${kind}.anomaly.test`, encryptSecret('pw', 'not-this-connection')]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-anomaly', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
  quiet = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-anomaly-xcp', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [xcp])).id;
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-anomaly', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  site = { pool: rp.id, image: img.id };
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('without history nothing is concluded, and a platform without CPU figures says so', async () => {
  const fresh = await server(aId, 'fresh');
  const blind = await server(aId, 'blind', quiet);
  assert.deepEqual(await run(), { servers: 2, opened: 0, resolved: 0 });
  assert.equal((await get(`/servers/${fresh}/anomalies`)).statusCode, 401);
  const f = (await get(`/servers/${fresh}/anomalies`, a)).json();
  assert.deepEqual(f, { measured: true, days: 0, minDays: 5, enough: false, anomalies: [], hidden: 0 });
  // Three days of history are still too few, however far the last hours are from them.
  await samples(fresh, end - 3 * DAY, end - 3 * HOUR, 10);
  await samples(fresh, end - 3 * HOUR, end, 95);
  assert.deepEqual(await run(), { servers: 2, opened: 0, resolved: 0 });
  assert.equal((await get(`/servers/${fresh}/anomalies`, a)).json().enough, false);
  const x = (await get(`/servers/${blind}/anomalies`, a)).json();
  assert.deepEqual([x.measured, x.enough, x.anomalies], [false, false, []]);
  assert.deepEqual(await mine(a), []);
  assert.equal(sent.length, 0);
  await pool.query('DELETE FROM servers WHERE id = ANY($1::uuid[])', [[fresh, blind]]);
});

test('the samples are rolled up once per server and hour, again without doubling, and old hours go', async () => {
  const s = await server(aId, 'rollup');
  await samples(s, end - 2 * DAY, end, 20);
  await pool.query('UPDATE server_cpu_samples SET cpu_pct = 60 WHERE server_id = $1 AND at = $2', [s, new Date(end - HOUR + 600_000)]);
  await pool.query('INSERT INTO server_cpu_hourly (server_id, hour, avg_pct, max_pct, samples) VALUES ($1, $2, 1, 1, 1)', [s, new Date(end - (ROLLUP_KEEP_DAYS + 2) * DAY)]);
  await rollupCpu(pool);
  const rows = (await pool.query('SELECT hour, avg_pct::float8 AS avg, max_pct::float8 AS max, samples FROM server_cpu_hourly WHERE server_id = $1 ORDER BY hour', [s])).rows;
  // The pre-existing old row made "since the newest hour" start there, and it is then removed for its age.
  assert.equal(rows.length, 48);
  assert.deepEqual([rows.at(-1).hour.getTime(), rows.at(-1).avg, rows.at(-1).max, rows.at(-1).samples], [end - HOUR, 40, 60, 2]);
  // A later sample in the newest hour is taken in by the next run; nothing is counted twice.
  await pool.query('INSERT INTO server_cpu_samples (server_id, at, cpu_pct) VALUES ($1, $2, 100)', [s, new Date(end - HOUR + 3_000_000)]);
  await rollupCpu(pool);
  const again = (await pool.query('SELECT avg_pct::float8 AS avg, samples FROM server_cpu_hourly WHERE server_id = $1 ORDER BY hour', [s])).rows;
  assert.equal(again.length, 48);
  assert.deepEqual([again.at(-1).avg, again.at(-1).samples, again[0].samples], [60, 3, 2]);
  await pool.query('DELETE FROM servers WHERE id = $1', [s]);
});

test('a departure opens one finding, tells the owner once, and is seen by the owner and staff only', async () => {
  const s = await server(aId, 'web-1');
  const other = await server((await one("SELECT id FROM users WHERE email = 'b@example.test'")).id, 'theirs');
  await samples(s, end - 10 * DAY, end - 3 * HOUR, 10);
  await samples(s, end - 3 * HOUR, end, 96);
  await samples(other, end - 10 * DAY, end, 10);
  sent.length = 0;
  assert.deepEqual(await run(), { servers: 2, opened: 1, resolved: 0 });
  const [f] = await open(s);
  assert.deepEqual([f.metric, f.direction], ['cpu', 'high']);
  assert.deepEqual(f.detail, { recent: 96, usual: 10, scale: 5, z: 17.2, baseline: 46, days: 10, hint: 'cpu_pinned' });
  assert.deepEqual(sent, [{ event: 'server.usage_anomaly', to: [aId], data: { serverId: s, name: 'web-1', metric: 'cpu', direction: 'high', recent: '96', usual: '10' } }]);
  // The notice exists in the catalog, in both languages, and says both numbers.
  for (const l of ['tr', 'en']) { const text = catalog['server.usage_anomaly'].text[l](sent[0].data); assert.match(text.title, /web-1/); assert.match(text.body, /96/); assert.match(text.body, /10/); }
  assert.deepEqual(catalog['server.usage_anomaly'].defaults, ['inApp']);

  // The next run keeps the finding and tells nobody again.
  assert.deepEqual(await run(), { servers: 2, opened: 0, resolved: 0 });
  assert.equal(sent.length, 1);
  assert.equal((await one('SELECT count(*)::int AS n FROM usage_anomalies')).n, 1);

  const seen = (await get(`/servers/${s}/anomalies`, a)).json();
  assert.deepEqual([seen.measured, seen.enough, seen.days >= 10, seen.hidden], [true, true, true, 0]);
  assert.deepEqual(seen.anomalies.map((x) => [x.metric, x.direction, x.detail.recent, x.detail.usual, x.detail.baseline]), [['cpu', 'high', 96, 10, 46]]);
  assert.equal((await get(`/servers/${s}/anomalies`, b)).statusCode, 404, 'another customer');
  const card = (await mine(a))[0];
  assert.deepEqual([card.code, card.severity, card.link, card.key, card.params], ['USAGE_ANOMALY_CPU_HIGH', 'warning', `/servers/${s}`, `anomaly:${seen.anomalies[0].id}`, { name: 'web-1', recent: 96, usual: 10, baseline: 46 }]);
  assert.deepEqual(await mine(b), []);

  // Staff: the list (not for customers), the abuse findings open on the same server, and the summary finding.
  assert.equal((await get('/admin/anomalies', a)).statusCode, 403);
  await pool.query("INSERT INTO abuse_findings (server_id, kind, detail) VALUES ($1, 'cpu', '{}')", [s]);
  const list = (await get('/admin/anomalies', admin)).json().anomalies;
  assert.deepEqual(list.map((x) => [x.serverName, x.owner, x.metric, x.detail.hint, x.abuseOpen, x.resolvedAt]), [['web-1', 'a@example.test', 'cpu', 'cpu_pinned', 1, null]]);
  await redis.del('insights:staff');
  const summary = (await get('/admin/insights', admin)).json().insights.find((i) => i.code === 'USAGE_ANOMALIES');
  assert.deepEqual([summary.severity, summary.params, summary.link], ['warning', { count: 1, suspicious: 1 }, '/admin/abuse?tab=usage']);

  // Hidden by the owner: off the server's page and the insights for that person, still there for staff.
  assert.equal((await put('/insights/dismissals', { key: card.key, days: 7 }, a)).statusCode, 204);
  const hidden = (await get(`/servers/${s}/anomalies`, a)).json();
  assert.deepEqual([hidden.anomalies, hidden.hidden], [[], 1]);
  assert.deepEqual(await mine(a), []);
  assert.equal((await get('/admin/anomalies', admin)).json().anomalies.length, 1);

  // Back to usual: the finding closes; staff still see it as closed, the owner's insights are clean.
  await lately(s, 12);
  assert.deepEqual(await run(), { servers: 2, opened: 0, resolved: 1 });
  assert.deepEqual(await open(s), []);
  assert.equal((await get('/admin/anomalies', admin)).json().anomalies[0].resolvedAt !== null, true);
  // A new departure is a new finding with a new key: what was hidden does not hide it.
  await lately(s, 70);
  sent.length = 0;
  assert.deepEqual(await run(), { servers: 2, opened: 1, resolved: 0 });
  assert.equal(sent.length, 1);
  assert.equal((await mine(a)).length, 1);
  assert.equal((await mine(a))[0].key !== card.key, true);
  await pool.query('DELETE FROM servers WHERE id = ANY($1::uuid[])', [[s, other]]);
});

test('a day of traffic far above the usual, mostly outbound; a deleted server closes its findings', async () => {
  const s = await server(aId, 'mail-1', site.pool, { created_at: new Date(end - 40 * DAY) });
  const GiB = 1024 ** 3;
  await pool.query(`INSERT INTO server_traffic (server_id, day, rx_bytes, tx_bytes) SELECT $1, current_date - n, $2, $2 FROM generate_series(2, 15) n`, [s, 5 * GiB]);
  await pool.query('INSERT INTO server_traffic (server_id, day, rx_bytes, tx_bytes) VALUES ($1, current_date - 1, $2, $3)', [s, 4 * GiB, 76 * GiB]);
  sent.length = 0;
  assert.deepEqual(await run(), { servers: 1, opened: 1, resolved: 0 });
  const [f] = await open(s);
  assert.deepEqual([f.metric, f.direction, f.detail.value, f.detail.usual, f.detail.baseline, f.detail.outShare, f.detail.hint], ['network', 'high', 80 * GiB, 10 * GiB, 14, 0.95, 'outbound']);
  assert.deepEqual(sent[0].data, { serverId: s, name: 'mail-1', metric: 'network', direction: 'high', recent: '85.9', usual: '10.7' });
  const card = (await mine(a))[0];
  assert.deepEqual([card.code, card.params], ['USAGE_ANOMALY_NETWORK_HIGH', { name: 'mail-1', recent: 85.9, usual: 10.7, baseline: 14 }]);
  // Scheduled for deletion: nothing is judged about it any more.
  await pool.query("UPDATE servers SET delete_at = now() + interval '1 day' WHERE id = $1", [s]);
  assert.deepEqual(await run(), { servers: 0, opened: 0, resolved: 1 });
  assert.deepEqual(await open(s), []);
  await pool.query('DELETE FROM servers WHERE id = $1', [s]);
});
