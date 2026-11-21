// A resize and the quota, against a real PostgreSQL and Redis (destructive, like the other files here: it wipes the
// test database and Redis DB). What is checked: servers of one account grown at the same moment are admitted one after
// the other, so exactly as many are accepted as the quota has room for and the others get the quota's own refusal
// (QUOTA_EXCEEDED, or PROJECT_QUOTA_EXCEEDED where the project has a quota of its own), never a 500; a resize that is
// accepted and not finished counts with the size it grows to, for the next resize, an order and the quote; a failed
// one gives its room back, and staff's retry of it is admitted again like a new resize; a finished one changes
// nothing in the count; two resizes of one server are still refused as an open operation, not by the quota.
// Nothing here builds or resizes a server: the location is a fixture without a hypervisor behind it and no worker
// runs, so an accepted resize stays open (as in project-quota and security-servers).
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

let app, admin, a, aId, b, bId, poolId, imageId, small, large;
const keys = {};
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload, headers = {}) => app.inject({ method, url: path, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const post = (path, payload, cookie, headers) => call('POST', path, cookie, payload, headers);
const put = (path, payload, cookie) => call('PUT', path, cookie, payload);
const key = () => ({ 'idempotency-key': randomUUID() });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); return [cookieOf(r), r.json().user.id]; };
let n = 0;
const order = (cookie, extra = {}) => post('/servers', { type: 'package', poolId, packageId: small, imageId, name: `r-${++n}`, sshKeyIds: [keys[cookie]], ...extra }, cookie, key());
// A small server (2 vCPU) that is built and idle, as far as the panel knows.
const built = async (cookie, extra) => {
  const r = await order(cookie, extra);
  assert.equal(r.statusCode, 202, r.body);
  const id = r.json().serverId;
  await pool.query("UPDATE servers SET state = 'ready', power_state = 'poweredOff', vm_moref = $2 WHERE id = $1", [id, `vm-${n}`]);
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE server_id = $1", [id]);
  return id;
};
// To the large package: 6 vCPU and 14 GB of memory more, the same disk (so no hypervisor is asked about snapshots).
const grow = (id, cookie) => post(`/servers/${id}/resize`, { type: 'package', packageId: large }, cookie, key());
const usage = async (cookie, extra = {}) => (await post('/catalog/quote', { type: 'package', poolId, packageId: small, imageId, ...extra }, cookie)).json().quota.usage;
const openResizes = async (ownerId) => (await pool.query("SELECT id, server_id FROM operations WHERE owner_id = $1 AND kind = 'resize' AND status IN ('pending', 'running') ORDER BY created_at", [ownerId])).rows;
const codes = (answers) => answers.map((r) => (r.statusCode === 202 ? 202 : `${r.statusCode} ${r.json().code}`)).sort((x, y) => String(x).localeCompare(String(y)));

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
  [b, bId] = await signUp('b@example.test');
  // A location nobody can build on (see security-servers.test.mjs): the worker, if one runs, cannot read its password.
  const connectionId = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, product, write_api, operations)
    VALUES ($1, 'Fixture', 'vcenter', 'vc.example.test', 443, 'svc', $2, 'system', '{}', 'available', '{"cloneFromImage": true}')`, [connectionId, encryptSecret('pw', 'not-this-connection')]);
  await pool.query(`INSERT INTO vmware_hosts (connection_id, moref, name, hardware_uuid, cpu_cores, memory_bytes, parent) VALUES ($1, 'host-1', 'esx1', 'hw-1', 256, $2, 'cluster-1')`, [connectionId, 2048 * 2 ** 30]);
  await pool.query(`INSERT INTO vmware_datastores (connection_id, moref, name, capacity_bytes, free_bytes, accessible) VALUES ($1, 'ds-1', 'ds1', $2, $2, true)`, [connectionId, 8000 * 2 ** 30]);
  poolId = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('Fixture', $1, 'cluster-1', '{ds-1}', 'net-1') RETURNING id`, [connectionId])).id;
  imageId = (await one("INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('Public Debian', 'linux', $1, 'tpl-1') RETURNING id", [connectionId])).id;
  small = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('small', 2, 2048, 40, 30, 'TRY') RETURNING id")).id;
  large = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('large', 8, 16384, 40, 80, 'TRY') RETURNING id")).id;
  await pool.query('INSERT INTO package_pools (package_id, pool_id) VALUES ($1, $3), ($2, $3)', [small, large, poolId]);
  await pool.query("INSERT INTO ip_pools (name, pool_id, cidr, gateway, range_start, range_end) VALUES ('fixture', $1, '203.0.113.0/24', '203.0.113.1', '203.0.113.10', '203.0.113.200')", [poolId]);
  const keyOf = async (ownerId, tag) => (await one("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'k', $2, $3) RETURNING id",
    [ownerId, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixtureFix ${tag}@x`, `fp-${tag}`])).id;
  keys[a] = await keyOf(aId, 'a');
  keys[b] = await keyOf(bId, 'b');
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('four servers of one account grown at once: as many are accepted as the quota has room for, the others are refused by the quota', async () => {
  // 20 vCPU for the account. Four small servers use 8; each resize asks for 6 more, so any one fits, and so do two (20),
  // but not three.
  assert.equal((await put(`/admin/quotas/users/${aId}`, { maxServers: null, maxVcpu: 20, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await built(a));
  assert.equal((await usage(a)).vcpu, 8);
  const answers = await Promise.all(ids.map((id) => grow(id, a)));
  assert.deepEqual(codes(answers), [202, 202, '409 QUOTA_EXCEEDED', '409 QUOTA_EXCEEDED'], answers.map((r) => r.body).join(' '));
  for (const r of answers.filter((x) => x.statusCode === 409)) assert.deepEqual(r.json().fields, { vcpu: 'QUOTA_EXCEEDED' });
  const open = await openResizes(aId);
  assert.equal(open.length, 2, 'one open resize per accepted request, none for a refused one');
  // A refused request wrote nothing: its server has the small package and its price.
  const refusedIds = ids.filter((id) => !open.some((o) => o.server_id === id));
  for (const id of refusedIds) assert.deepEqual(await one('SELECT price_monthly::text AS p, package_id FROM servers WHERE id = $1', [id]), { p: '30.00', package_id: small });
  // The accepted growth is counted before any worker has resized anything: the rows still say 2 vCPU each.
  assert.equal((await one("SELECT sum(vcpu)::int AS n FROM servers WHERE owner_id = $1 AND state <> 'deleted'", [aId])).n, 8);
  assert.deepEqual(await usage(a), { servers: 4, vcpu: 20, memoryMb: 4 * 2048 + 2 * 14336, diskGb: 160 });
  // So nothing else takes that room either: not a later resize, not an order.
  const later = await grow(refusedIds[0], a);
  assert.deepEqual([later.statusCode, later.json().code, later.json().fields], [409, 'QUOTA_EXCEEDED', { vcpu: 'QUOTA_EXCEEDED' }]);
  const ordered = await order(a);
  assert.deepEqual([ordered.statusCode, ordered.json().code, ordered.json().fields], [409, 'QUOTA_EXCEEDED', { vcpu: 'QUOTA_EXCEEDED' }]);
});

test('a failed resize gives its room back, a retry of it is admitted like a new resize, and a finished one counts once', async () => {
  const [first, second] = await openResizes(aId);
  const idle = (await one(`SELECT id FROM servers s WHERE owner_id = $1 AND state <> 'deleted' AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) ORDER BY created_at LIMIT 1`, [aId])).id;
  // The worker gave up on the first one: the operation failed, and the server has its old package and price again.
  await pool.query("UPDATE operations SET status = 'failed', error_code = 'TASK_FAILED', finished_at = now() WHERE id = $1", [first.id]);
  await pool.query('UPDATE servers SET price_monthly = 30, package_id = $2 WHERE id = $1', [first.server_id, small]);
  assert.equal((await usage(a)).vcpu, 14);
  // Its room goes to another server.
  assert.equal((await grow(idle, a)).statusCode, 202);
  assert.equal((await usage(a)).vcpu, 20);
  // Staff retry the failed one: there is no room for it any more, and it stays failed.
  const retried = await post(`/admin/operations/${first.id}/retry`, undefined, admin);
  assert.deepEqual([retried.statusCode, retried.json().code, retried.json().fields], [409, 'QUOTA_EXCEEDED', { vcpu: 'QUOTA_EXCEEDED' }], retried.body);
  assert.equal((await one('SELECT status FROM operations WHERE id = $1', [first.id])).status, 'failed');
  // The worker finishes the second: the row has the new size, the operation is over, and the count is the same 20.
  await pool.query('UPDATE servers SET vcpu = 8, memory_mb = 16384 WHERE id = $1', [second.server_id]);
  assert.equal((await usage(a)).vcpu, 20, 'resized and still open: not counted twice');
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE id = $1", [second.id]);
  assert.equal((await usage(a)).vcpu, 20);
  // With more room the retry is accepted.
  assert.equal((await put(`/admin/quotas/users/${aId}`, { maxServers: null, maxVcpu: 26, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  const again = await post(`/admin/operations/${first.id}/retry`, undefined, admin);
  assert.equal(again.statusCode, 202, again.body);
  assert.equal((await usage(a)).vcpu, 26);
});

test('two servers of a project grown at once are held to the project\'s own quota, with its own code', async () => {
  const p = (await post('/projects', { name: 'Narrow' }, b)).json().id;
  // The project: 10 vCPU, two small servers in it (4). One may grow by 6, not both. The account itself has room for both.
  assert.equal((await put(`/admin/quotas/users/${bId}`, { maxServers: null, maxVcpu: 100, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  assert.equal((await put(`/admin/quotas/projects/${p}`, { maxServers: null, maxVcpu: 10, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  const ids = [await built(b, { projectId: p }), await built(b, { projectId: p })];
  const answers = await Promise.all(ids.map((id) => grow(id, b)));
  assert.deepEqual(codes(answers), [202, '409 PROJECT_QUOTA_EXCEEDED'], answers.map((r) => r.body).join(' '));
  assert.deepEqual(answers.find((r) => r.statusCode === 409).json().fields, { vcpu: 'QUOTA_EXCEEDED' });
  assert.equal((await openResizes(bId)).length, 1);
  assert.equal((await usage(b, { projectId: p })).vcpu, 10);
  // A server of the same account outside the project is under the account's quota, which has room.
  const outside = await built(b);
  assert.equal((await grow(outside, b)).statusCode, 202);
});

test('two resizes of one server at once: the second is refused as an open operation, also when the quota has no room for it', async () => {
  const id = await built(b);
  const used = (await usage(b)).vcpu;
  assert.equal((await put(`/admin/quotas/users/${bId}`, { maxServers: null, maxVcpu: used + 6, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  const answers = await Promise.all([grow(id, b), grow(id, b)]);
  assert.deepEqual(codes(answers), [202, '409 OPERATION_IN_PROGRESS'], answers.map((r) => r.body).join(' '));
  assert.equal((await usage(b)).vcpu, used + 6);
});
