// The power schedule suggestion against real PostgreSQL and Redis: nothing is concluded without three weeks of
// history or on a platform without CPU figures; an office-hours history gives the nightly schedule in the caller's
// time zone, says that the price does not change and estimates the energy where it is measured; the schedules are
// created only by the owner's own request, through the schedules' checks (the administrator's switch, the limit,
// the audit record), from what the server works out and not from what the request says; afterwards the suggestion
// is gone, also from the insights; hiding it is the insights' dismissal.
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
const { encryptSecret } = await import('../../dist/secrets.js');

let app, admin, a, aId, b, site, blind;
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
const server = async (ownerId, name, poolId = site.pool) => (await one(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state, vm_moref)
  VALUES ($1, $2, $3, $4, 2, 2048, 20, 80, 'TRY', 'ready', 'poweredOn', $5) RETURNING id`, [ownerId, poolId, site.image, name, `vm-${name}`])).id;
// Hourly rows for the last `days` days: busy from 08:00 to 17:59 UTC on working days, idle otherwise.
const office = (serverId, days = 28) => pool.query(`INSERT INTO server_cpu_hourly (server_id, hour, avg_pct, max_pct, samples)
  SELECT $1, h, CASE WHEN busy THEN 40 ELSE 0.5 END, CASE WHEN busy THEN 80 ELSE 2 END, 12
  FROM (SELECT h, EXTRACT(ISODOW FROM h AT TIME ZONE 'UTC') <= 5 AND EXTRACT(HOUR FROM h AT TIME ZONE 'UTC') BETWEEN 8 AND 17 AS busy
    FROM generate_series(date_trunc('hour', now(), 'UTC') - make_interval(days => $2), date_trunc('hour', now(), 'UTC') - interval '1 hour', interval '1 hour') h) x`, [serverId, days]);
const advice = async (id, cookie, zone = 'UTC') => (await get(`/servers/${id}/schedule-suggestion?timezone=${encodeURIComponent(zone)}`, cookie)).json();
const cards = async (cookie) => (await get('/insights', cookie)).json().insights.filter((i) => i.code === 'SCHEDULE_SUGGESTED');
const schedules = (id) => pool.query(`SELECT action, days, to_char(at_time, 'HH24:MI') AS time, timezone, enabled FROM power_schedules WHERE server_id = $1 ORDER BY action DESC`, [id]).then((r) => r.rows);
const forgetCache = async () => { for (const k of await redis.keys('insight:schedule:*')) await redis.del(k); };

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
    VALUES ($1, $2, $3, $4, 'root', $5, 'system', '{}', 'unknown')`, [id, `it-schedule-${kind}`, kind, `${kind}.schedule.test`, encryptSecret('pw', 'not-this-connection')]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-schedule', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
  blind = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-schedule-xcp', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [xcp])).id;
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-schedule', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  site = { pool: rp.id, image: img.id };
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('no history, a short history and a platform without CPU figures: nothing is suggested, and the reason is said', async () => {
  const fresh = await server(aId, 'fresh');
  assert.equal((await get(`/servers/${fresh}/schedule-suggestion`)).statusCode, 401);
  assert.equal((await get(`/servers/${fresh}/schedule-suggestion`, b)).statusCode, 404, 'another customer');
  assert.equal((await get(`/servers/${fresh}/schedule-suggestion?timezone=Mars/Olympus`, a)).statusCode, 400);
  assert.deepEqual(await advice(fresh, a), { timezone: 'UTC', days: 0, minDays: 21, weeks: 4, savesMoney: false, energyKwhPerWeek: null, hidden: false, state: 'not_enough_data' });
  await office(fresh, 14);
  const short = await advice(fresh, a);
  assert.deepEqual([short.state, short.days], ['not_enough_data', 14]);
  const x = await server(aId, 'xcp', blind);
  await office(x); // even with rows there (an older worker stored zeros), the platform is not believed
  assert.equal((await advice(x, a)).state, 'not_measured');
  assert.equal((await post(`/servers/${fresh}/schedule-suggestion`, { timezone: 'UTC' }, a)).statusCode, 409);
  assert.equal((await post(`/servers/${fresh}/schedule-suggestion`, { timezone: 'UTC' }, a)).json().code, 'NO_SUGGESTION');
  assert.deepEqual(await cards(a), []);
  await pool.query('DELETE FROM servers WHERE id = ANY($1::uuid[])', [[fresh, x]]);
  await forgetCache();
});

test('office hours give the nightly schedule in the caller\'s zone; the price is said not to change; energy where measured', async () => {
  const s = await server(aId, 'office');
  await office(s);
  const utc = await advice(s, a);
  assert.deepEqual([utc.state, utc.kind, utc.offHours, utc.idleHours, utc.savesMoney, utc.energyKwhPerWeek, utc.hidden], ['suggested', 'nightly', 108, 118, false, null, false]);
  assert.deepEqual(utc.schedules, [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '07:00' }]);
  const ist = await advice(s, a, 'Europe/Istanbul');
  assert.deepEqual([ist.timezone, ist.schedules.map((x) => x.time)], ['Europe/Istanbul', ['22:00', '10:00']]);
  // 50 W on average over the last week: 108 hours off are about 5.4 kWh.
  await pool.query(`INSERT INTO power_server_samples (server_id, at, watts, minutes) SELECT $1, now() - make_interval(hours => n), 50, 5 FROM generate_series(1, 48) n`, [s]);
  assert.equal((await advice(s, a)).energyKwhPerWeek, 5.4);
  // The insight names the server and the hours; staff looking at the server get the same answer.
  const [card] = await cards(a);
  assert.deepEqual([card.severity, card.params, card.link, card.key], ['info', { name: 'office', hours: 108 }, `/servers/${s}`, `schedule:${s}`]);
  assert.equal((await advice(s, admin)).state, 'suggested');
  assert.deepEqual(await cards(b), []);

  // Hidden for a week: off the insights, marked on the server's page.
  assert.equal((await put('/insights/dismissals', { key: `schedule:${s}`, days: 7 }, a)).statusCode, 204);
  assert.equal((await advice(s, a)).hidden, true);
  assert.deepEqual(await cards(a), []);
  assert.equal((await call('DELETE', '/insights/dismissals', a)).statusCode, 204);
  assert.equal((await advice(s, a)).hidden, false);
});

test('the schedules are created only on the owner\'s request, through the schedules\' own checks, and the suggestion is then gone', async () => {
  const s = (await one("SELECT id FROM servers WHERE name = 'office'")).id;
  assert.equal((await post(`/servers/${s}/schedule-suggestion`, { timezone: 'UTC' })).statusCode, 401);
  assert.equal((await post(`/servers/${s}/schedule-suggestion`, { timezone: 'UTC' }, b)).statusCode, 404);
  assert.equal((await post(`/servers/${s}/schedule-suggestion`, { timezone: 'nowhere' }, a)).statusCode, 400);
  // The administrator switched power actions off for customers: no schedule is created for them either.
  assert.equal((await put('/admin/settings/servers', { customer: { power: false } }, admin)).statusCode, 200);
  const refused = await post(`/servers/${s}/schedule-suggestion`, { timezone: 'UTC' }, a);
  assert.deepEqual([refused.statusCode, refused.json().code], [403, 'ACTION_DISABLED']);
  assert.deepEqual(await schedules(s), []);
  assert.equal((await put('/admin/settings/servers', { customer: { power: true } }, admin)).statusCode, 200);

  // What the request says besides the zone decides nothing.
  const made = await post(`/servers/${s}/schedule-suggestion`, { timezone: 'Europe/Istanbul', schedules: [{ action: 'shutdown', days: [1], time: '00:00' }], action: 'power_off' }, a);
  assert.equal(made.statusCode, 201, made.body);
  assert.deepEqual(made.json().schedules.map((x) => [x.action, x.days, x.time, x.timezone, x.enabled]), [['shutdown', [1, 2, 3, 4, 5], '22:00', 'Europe/Istanbul', true], ['power_on', [1, 2, 3, 4, 5], '10:00', 'Europe/Istanbul', true]]);
  assert.deepEqual(await schedules(s), [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '22:00', timezone: 'Europe/Istanbul', enabled: true }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '10:00', timezone: 'Europe/Istanbul', enabled: true }]);
  const { rows: audits } = await pool.query("SELECT actor_id, metadata FROM audit_events WHERE action = 'server.schedule_created' AND metadata->>'serverId' = $1 ORDER BY created_at", [s]);
  assert.deepEqual(audits.map((x) => [x.actor_id, x.metadata.action, x.metadata.suggested, x.metadata.offHours]), [[aId, 'shutdown', true, 108], [aId, 'power_on', true, 108]]);
  // They are ordinary schedules now; the suggestion is not made again, here or in the insights.
  assert.equal((await get(`/servers/${s}/schedules`, a)).json().schedules.length, 2);
  assert.equal((await advice(s, a)).state, 'scheduled');
  assert.deepEqual(await cards(a), []);
  assert.equal((await post(`/servers/${s}/schedule-suggestion`, { timezone: 'UTC' }, a)).statusCode, 409);
  assert.equal((await schedules(s)).length, 2);
});

test('a server at the limit of schedules gets none of the two', async () => {
  const s = await server(aId, 'full');
  await office(s);
  // Nine snapshot schedules: one more would fit, two do not.
  for (let i = 0; i < 9; i++) await pool.query(`INSERT INTO power_schedules (server_id, action, days, at_time, timezone, keep) VALUES ($1, 'snapshot', '{1}', $2, 'UTC', 3)`, [s, `0${i}:30`]);
  assert.equal((await advice(s, a)).state, 'suggested');
  const r = await post(`/servers/${s}/schedule-suggestion`, { timezone: 'UTC' }, a);
  assert.deepEqual([r.statusCode, r.json().fields], [400, { action: 'TOO_MANY' }]);
  assert.equal((await schedules(s)).length, 9);
});
