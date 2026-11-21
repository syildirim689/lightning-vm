// Per-project quotas, against a real PostgreSQL and Redis (destructive, like the other files here: it wipes the test
// database and Redis DB). What is checked: only catalog managers define them, for projects that exist, and it is
// audited; the staff list and the owner's project list show the limits with what is used; the quote and the
// availability follow the chosen project; an order into a project is refused by its own quota with its own code, and
// two orders at once cannot both take the last place; a project quota replaces the account's (wider or narrower)
// while orders outside it stay under the account's; a resize is held to it too; removing the quota or the project
// puts the servers back under the account's quota, and nobody reaches another account's project.
// Nothing here builds a server: the location is a fixture without a hypervisor behind it, as in security-servers.
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

let app, admin, viewer, a, aId, b, poolId, imageId, small, large, keyA, keyB;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload, headers = {}) => app.inject({ method, url: path, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const post = (path, payload, cookie, headers) => call('POST', path, cookie, payload, headers);
const put = (path, payload, cookie) => call('PUT', path, cookie, payload);
const del = (path, cookie) => call('DELETE', path, cookie);
const key = () => ({ 'idempotency-key': randomUUID() });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); return [cookieOf(r), r.json().user.id]; };
const project = async (name, cookie = a) => (await post('/projects', { name }, cookie)).json().id;
let n = 0;
const order = (cookie, extra = {}) => post('/servers', { type: 'package', poolId, packageId: small, imageId, name: `q-${++n}`, sshKeyIds: [cookie === b ? keyB : keyA], ...extra }, cookie, key());
const quote = (cookie, extra = {}) => post('/catalog/quote', { type: 'package', poolId, packageId: small, imageId, ...extra }, cookie);
const liveServers = async (where = '') => (await one(`SELECT count(*)::int AS n FROM servers WHERE state <> 'deleted' ${where}`)).n;
const refused = (r, code, fields) => { assert.deepEqual([r.statusCode, r.json().code], [409, code], r.body); if (fields) assert.deepEqual(r.json().fields, fields); };

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
  // Staff who may look at the catalog and nothing more.
  assert.equal((await post('/admin/roles', { key: 'catalog-viewer', name: 'Catalog viewer', permissions: ['catalog.view'] }, admin)).statusCode, 201);
  const viewerId = (await post('/auth/admin/create-user', { email: 'viewer@example.test', password, name: 'Viewer', role: 'user' }, admin)).json().user.id;
  assert.equal((await put(`/admin/users/${viewerId}/access`, { roles: ['catalog-viewer'], overrides: [] }, admin)).statusCode, 200);
  viewer = cookieOf(await post('/auth/sign-in/email', { email: 'viewer@example.test', password }));
  // A location nobody can build on (see security-servers.test.mjs): the worker, if one runs, cannot read its password.
  const connectionId = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, product, write_api, operations)
    VALUES ($1, 'Fixture', 'vcenter', 'vc.example.test', 443, 'svc', $2, 'system', '{}', 'available', '{"cloneFromImage": true}')`, [connectionId, encryptSecret('pw', 'not-this-connection')]);
  await pool.query(`INSERT INTO vmware_hosts (connection_id, moref, name, hardware_uuid, cpu_cores, memory_bytes, parent) VALUES ($1, 'host-1', 'esx1', 'hw-1', 64, $2, 'cluster-1')`, [connectionId, 512 * 2 ** 30]);
  await pool.query(`INSERT INTO vmware_datastores (connection_id, moref, name, capacity_bytes, free_bytes, accessible) VALUES ($1, 'ds-1', 'ds1', $2, $2, true)`, [connectionId, 8000 * 2 ** 30]);
  poolId = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('Fixture', $1, 'cluster-1', '{ds-1}', 'net-1') RETURNING id`, [connectionId])).id;
  imageId = (await one("INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('Public Debian', 'linux', $1, 'tpl-1') RETURNING id", [connectionId])).id;
  small = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('small', 2, 2048, 40, 30, 'TRY') RETURNING id")).id;
  large = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('large', 8, 16384, 40, 80, 'TRY') RETURNING id")).id;
  await pool.query('INSERT INTO package_pools (package_id, pool_id) VALUES ($1, $3), ($2, $3)', [small, large, poolId]);
  await pool.query("INSERT INTO ip_pools (name, pool_id, cidr, gateway, range_start, range_end) VALUES ('fixture', $1, '203.0.113.0/24', '203.0.113.1', '203.0.113.10', '203.0.113.200')", [poolId]);
  const keyOf = async (ownerId, tag) => (await one("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'k', $2, $3) RETURNING id",
    [ownerId, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixtureFix ${tag}@x`, `fp-${tag}`])).id;
  keyA = await keyOf(aId, 'a');
  keyB = await keyOf((await one("SELECT id FROM users WHERE email = 'b@example.test'")).id, 'b');
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('only catalog managers define a project quota, for a project that exists, and it is audited', async () => {
  const p = await project('Staging');
  const limits = { maxServers: 2, maxVcpu: 8, maxMemoryMb: 8192, maxDiskGb: 200 };
  for (const who of [undefined, a, viewer]) {
    const expected = who ? 403 : 401;
    assert.equal((await put(`/admin/quotas/projects/${p}`, limits, who)).statusCode, expected);
    assert.equal((await del(`/admin/quotas/projects/${p}`, who)).statusCode, expected);
  }
  assert.equal((await get('/admin/quotas/projects', a)).statusCode, 403);
  assert.equal((await get('/admin/quotas/projects', viewer)).statusCode, 200, 'catalog.view reads the list');
  assert.equal((await one("SELECT count(*)::int AS n FROM quotas WHERE scope = 'project'")).n, 0);
  assert.deepEqual([(await put(`/admin/quotas/projects/${randomUUID()}`, limits, admin)).statusCode, (await put('/admin/quotas/projects/not-a-uuid', limits, admin)).statusCode], [404, 400]);
  assert.equal((await put(`/admin/quotas/projects/${aId}`, limits, admin)).statusCode, 404, 'a user id is not a project');
  assert.equal((await put(`/admin/quotas/projects/${p}`, { ...limits, maxServers: -1 }, admin)).json().fields.maxServers, 'OUT_OF_RANGE');
  const saved = await put(`/admin/quotas/projects/${p}`, limits, admin);
  assert.deepEqual([saved.statusCode, saved.json()], [200, { max_servers: 2, max_vcpu: 8, max_memory_mb: 8192, max_disk_gb: 200 }]);
  // Saving again replaces it (one row per project); an empty limit is unlimited.
  assert.equal((await put(`/admin/quotas/projects/${p}`, { ...limits, maxDiskGb: null }, admin)).statusCode, 200);
  assert.deepEqual(await one("SELECT count(*)::int AS n, max(max_disk_gb) AS disk FROM quotas WHERE scope = 'project' AND subject_id = $1", [p]), { n: 1, disk: null });
  const audit = await one("SELECT metadata FROM audit_events WHERE action = 'catalog.quota_set' AND metadata->>'scope' = 'project' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([audit.metadata.subjectId, audit.metadata.ownerId, audit.metadata.max_servers], [p, aId, 2]);
  // The lists: staff see the project with its owner and what it uses; the picker has every project.
  const row = (await get('/admin/quotas', viewer)).json().quotas.find((q) => q.scope === 'project');
  assert.deepEqual(row, { scope: 'project', subjectId: p, email: 'a@example.test', projectName: 'Staging', ownerId: aId, maxServers: 2, maxVcpu: 8, maxMemoryMb: 8192, maxDiskGb: null,
    usage: { servers: 0, vcpu: 0, memoryMb: 0, diskGb: 0 } });
  assert.deepEqual((await get('/admin/quotas/projects', admin)).json().projects, [{ id: p, name: 'Staging', ownerId: aId, email: 'a@example.test', servers: 0 }]);
  // The owner sees the limits on the project; another account sees nothing of it.
  assert.deepEqual((await get('/projects', a)).json().projects.find((x) => x.id === p).quota, { maxServers: 2, maxVcpu: 8, maxMemoryMb: 8192, maxDiskGb: null, usage: { servers: 0, vcpu: 0, memoryMb: 0, diskGb: 0 } });
  assert.deepEqual((await get('/projects', b)).json().projects, []);
  const removed = await del(`/admin/quotas/projects/${p}`, admin);
  assert.equal(removed.statusCode, 204);
  assert.equal((await del(`/admin/quotas/projects/${p}`, admin)).statusCode, 404);
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_events WHERE action = 'catalog.quota_removed' AND metadata->>'scope' = 'project'")).n, 1);
  assert.equal((await get('/projects', a)).json().projects.find((x) => x.id === p).quota, null);
  await del(`/projects/${p}`, a);
});

test('an order into a project is held to the project\'s own quota: counted per project, refused with its own code, never two for the last place', async () => {
  const p = await project('Narrow');
  assert.equal((await put(`/admin/quotas/projects/${p}`, { maxServers: 2, maxVcpu: 6, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  // The quote says whose quota it is and what is used; the availability follows the project.
  let q = (await quote(a, { projectId: p })).json().quota;
  assert.deepEqual([q.scope, q.usage, q.exceeded], ['project', { servers: 0, vcpu: 0, memoryMb: 0, diskGb: 0 }, []]);
  assert.equal((await quote(a)).json().quota.scope, 'account');
  assert.deepEqual((await quote(a, { projectId: p, packageId: large })).json().quota.exceeded, ['vcpu'], '8 vCPU do not fit 6');
  const avail = async (query) => (await get(`/catalog/availability?poolId=${poolId}${query}`, a)).json().packages;
  assert.deepEqual([(await avail(`&projectId=${p}`))[large].quota, (await avail(''))[large].quota], [['vcpu'], []]);
  // A package over the project's vCPU: refused, and it names the limit.
  refused(await order(a, { projectId: p, packageId: large }), 'PROJECT_QUOTA_EXCEEDED', { vcpu: 'QUOTA_EXCEEDED' });
  assert.equal((await order(a, { projectId: p })).statusCode, 202);
  // One place left: two orders at once take it once.
  const pair = await Promise.all([order(a, { projectId: p }), order(a, { projectId: p })]);
  assert.deepEqual(pair.map((r) => r.statusCode).sort(), [202, 409], pair.map((r) => r.body).join(' '));
  refused(pair.find((r) => r.statusCode === 409), 'PROJECT_QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' });
  assert.equal(await liveServers(`AND project_id = '${p}'`), 2);
  refused(await order(a, { projectId: p }), 'PROJECT_QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' });
  q = (await quote(a, { projectId: p })).json().quota;
  assert.deepEqual([q.scope, q.usage, q.exceeded], ['project', { servers: 2, vcpu: 4, memoryMb: 4096, diskGb: 80 }, ['servers']]);
  assert.deepEqual((await get('/projects', a)).json().projects.find((x) => x.id === p).quota.usage, { servers: 2, vcpu: 4, memoryMb: 4096, diskGb: 80 });
  assert.deepEqual((await get('/admin/quotas', admin)).json().quotas.find((x) => x.subjectId === p).usage, { servers: 2, vcpu: 4, memoryMb: 4096, diskGb: 80 });
  // Outside the project the account's quota decides (default: 5 servers), counted over all the account's servers.
  assert.equal((await order(a)).statusCode, 202);
  assert.deepEqual((await quote(a)).json().quota.usage.servers, 3);
  // Another project of the same account without a quota of its own: the account's quota, not this project's.
  const other = await project('Plain');
  assert.equal((await quote(a, { projectId: other })).json().quota.scope, 'account');
  assert.equal((await order(a, { projectId: other })).statusCode, 202);
  // A server of the project grows only within the project's quota (6 vCPU: 2 + 2 used, large would need 6 more).
  const serverId = (await one('SELECT id FROM servers WHERE project_id = $1 LIMIT 1', [p])).id;
  await pool.query("UPDATE servers SET state = 'ready', power_state = 'poweredOff', vm_moref = 'vm-quota' WHERE id = $1", [serverId]);
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE server_id = $1", [serverId]);
  refused(await post(`/servers/${serverId}/resize`, { type: 'package', packageId: large }, a, key()), 'PROJECT_QUOTA_EXCEEDED', { vcpu: 'QUOTA_EXCEEDED' });
});

test('nobody orders into, or asks about, another account\'s project', async () => {
  const p = (await one("SELECT id FROM projects WHERE name = 'Narrow'")).id;
  assert.equal((await order(b, { projectId: p })).statusCode, 404);
  assert.equal((await quote(b, { projectId: p })).statusCode, 404);
  // The availability ignores a project that is not the caller's: the caller's own account quota answers.
  assert.deepEqual((await get(`/catalog/availability?poolId=${poolId}&projectId=${p}`, b)).json().packages[large].quota, []);
  assert.equal(await liveServers("AND owner_id <> '" + aId + "'"), 0);
});

test('a project quota replaces the account\'s: wider than it inside the project, the account\'s own outside', async () => {
  // b's account: one server. b's project: three.
  const bId = (await one("SELECT id FROM users WHERE email = 'b@example.test'")).id;
  assert.equal((await put(`/admin/quotas/users/${bId}`, { maxServers: 1, maxVcpu: null, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  const wide = await project('Wide', b);
  assert.equal((await put(`/admin/quotas/projects/${wide}`, { maxServers: 3, maxVcpu: null, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  for (let i = 0; i < 3; i++) assert.equal((await order(b, { projectId: wide })).statusCode, 202, `order ${i + 1} into the project`);
  refused(await order(b, { projectId: wide }), 'PROJECT_QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' });
  // Outside it the account's one server is long used up (the project's servers are the account's too).
  refused(await order(b), 'QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' });
  assert.deepEqual((await quote(b)).json().quota.usage.servers, 3);
  // The quota removed: the project is under the account's quota again, which is exceeded.
  assert.equal((await del(`/admin/quotas/projects/${wide}`, admin)).statusCode, 204);
  refused(await order(b, { projectId: wide }), 'QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' });
  // Given again and the project deleted by its owner: the quota goes with it, the servers stay and count for the account.
  assert.equal((await put(`/admin/quotas/projects/${wide}`, { maxServers: 10, maxVcpu: null, maxMemoryMb: null, maxDiskGb: null }, admin)).statusCode, 200);
  assert.equal((await del(`/projects/${wide}`, b)).statusCode, 204);
  assert.equal((await one("SELECT count(*)::int AS n FROM quotas WHERE scope = 'project' AND subject_id = $1", [wide])).n, 0);
  assert.equal((await one("SELECT metadata->>'quotaRemoved' AS q FROM audit_events WHERE action = 'project.deleted' AND metadata->>'id' = $1", [wide])).q, 'true');
  assert.equal(await liveServers(`AND owner_id = '${bId}' AND project_id IS NULL`), 3);
  assert.equal((await get('/admin/quotas', admin)).json().quotas.filter((x) => x.subjectId === wide).length, 0);
  // A new project of the same name starts without a quota: no way back to the old allowance.
  const again = await project('Wide', b);
  assert.equal((await get('/projects', b)).json().projects.find((x) => x.id === again).quota, null);
  refused(await order(b, { projectId: again }), 'QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' });
});
