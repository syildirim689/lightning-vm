// Server lifecycle through the API, the real worker (worker-test), the Go adapter and the simulated
// vCenter. Simulated infrastructure: this proves orchestration, idempotency, locking, recovery and
// release rules, not real VMware behaviour. Destructive: wipes the *_test database and Redis DB 15.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
const vcenter = process.env.VCSIM_VCENTER;
const skip = !vcenter || !process.env.VMWARE_SERVICE_URL || !process.env.WORKER_TEST ? 'needs the simulator, the adapter and a worker on the test databases (run-it.sh)' : false;
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { encryptSecret } = await import('../../dist/secrets.js');
const { Queue } = await import('bullmq');

let queueRedis, app, admin, user, other, connectionId, poolId, imageId, packageId, keyId, queue, target, serverId;
const password = 'correct horse battery staple';
const send = (method, path, payload, session = admin, headers = {}) => app.inject({
  method, url: path, payload, headers: { 'x-lightning-csrf': '1', ...headers, ...(session && { cookie: `lvm_session=${session}` }) } });
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm_session=([^;]+)/)?.[1];
const order = (name, extra = {}) => ({ type: 'package', poolId, packageId, imageId, name, sshKeyIds: [keyId], ...extra });
const create = (body, key = randomUUID(), session = user) => send('POST', '/servers', body, session, { 'idempotency-key': key });
const adapter = async (path, body) => (await fetch(`${process.env.VMWARE_SERVICE_URL}${path}`, { method: 'POST',
  headers: { authorization: `Bearer ${readFileSync(process.env.VMWARE_SERVICE_TOKEN_FILE, 'utf8').trim()}`, 'content-type': 'application/json' },
  body: JSON.stringify({ ...target, ...body }) })).json();
async function until(check, what, seconds = 60) {
  for (let i = 0; i < seconds * 5; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const serverRow = async (id) => (await pool.query('SELECT * FROM servers WHERE id = $1', [id])).rows[0];
const lastOp = async (id) => (await pool.query('SELECT * FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0];
const vmCount = async (id) => (await adapter('/v1/vm/find', { name: `lvm-${id}` })).vm ? 1 : 0;

before(async () => {
  if (skip) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  queueRedis = redis.duplicate({ maxRetriesPerRequest: null });
  queue = new Queue('operations', { connection: queueRedis });
  const { token } = await issueBootstrapToken();
  admin = cookieOf(await send('POST', '/setup/admin', { token, email: 'admin@example.test', password }, null));
  await send('PUT', '/admin/settings', { registrationOpen: true });
  user = cookieOf(await send('POST', '/auth/register', { email: 'user@example.test', password }, null));
  other = cookieOf(await send('POST', '/auth/register', { email: 'other@example.test', password }, null));
  const conn = { name: 'Sim', host: vcenter, port: 8989, username: 'sim-admin', password: 'sim-password-1' };
  const pin = (await send('POST', '/admin/vmware/test', { ...conn, tls: { mode: 'system' } })).json().certificate.sha256;
  connectionId = (await send('POST', '/admin/vmware/connections', { ...conn, tls: { mode: 'pinned', sha256: pin } })).json().id;
  target = { host: vcenter, port: 8989, username: 'sim-admin', password: 'sim-password-1', tls: { mode: 'pinned', sha256: pin } };
  const cluster = (await pool.query("SELECT moref FROM vmware_compute WHERE connection_id = $1 AND kind = 'cluster'", [connectionId])).rows[0].moref;
  const { rows: [vm] } = await pool.query('SELECT moref FROM vmware_vms WHERE connection_id = $1 ORDER BY name LIMIT 1', [connectionId]);
  const datastores = (await pool.query('SELECT moref FROM vmware_datastores WHERE connection_id = $1', [connectionId])).rows.map((r) => r.moref);
  const network = (await pool.query("SELECT moref FROM vmware_networks WHERE connection_id = $1 AND kind = 'standard' LIMIT 1", [connectionId])).rows[0].moref;
  poolId = (await send('POST', '/admin/pools', { name: 'Sim', connectionId, computeMoref: cluster, datastoreMorefs: datastores, networkMoref: network,
    cpuOvercommit: 16, memoryOvercommit: 4, storageOvercommit: 10, reserveCpuPct: 0, reserveMemoryPct: 0, reserveStoragePct: 0 })).json().id;
  await send('POST', '/admin/ip-pools', { name: 'tiny', poolId, cidr: '10.20.0.0/24', gateway: '10.20.0.1', dns: ['10.20.0.53'], rangeStart: '10.20.0.10', rangeEnd: '10.20.0.12', excluded: ['10.20.0.11'] });
  // The simulator has no templates; one inventory VM is marked as one (simulated data).
  await pool.query('UPDATE vmware_vms SET template = true WHERE connection_id = $1 AND moref = $2', [connectionId, vm.moref]);
  imageId = (await send('POST', '/admin/images', { name: 'Sim Linux', family: 'linux', connectionId, templateMoref: vm.moref, minDiskGb: 10 })).json().id;
  packageId = (await send('POST', '/admin/packages', { name: 'Tiny', vcpu: 1, memoryMb: 512, diskGb: 10, priceMonthly: '1.00', currency: 'EUR', poolIds: [poolId], imageIds: [imageId] })).json().id;
});
after(async () => { await queue?.resume(); await queue?.close(); queueRedis?.disconnect(); await app?.close(); await closeConnections(); });

test('SSH keys are validated and owned', { skip }, async () => {
  assert.equal((await send('POST', '/ssh-keys', { name: 'k', publicKey: 'not a key' }, user)).json().fields.publicKey, 'INVALID_SSH_KEY');
  const res = await send('POST', '/ssh-keys', { name: 'laptop', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0iBTtZu9kbSNXzg5M6pZ1rn8F1143iWq3JIcGimfn test' }, user);
  keyId = res.json().id;
  assert.match(res.json().fingerprint, /^SHA256:/);
  assert.equal((await send('GET', '/ssh-keys', undefined, other)).json().keys.length, 0);
});

test('creating needs an Idempotency-Key; repeating it returns the same server, never a second one', { skip }, async () => {
  assert.equal((await send('POST', '/servers', order('web-1'), user)).json().code, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = randomUUID();
  const [a, b] = await Promise.all([create(order('web-1'), key), create(order('web-1'), key)]);
  assert.deepEqual([a.statusCode, b.statusCode], [202, 202]);
  assert.equal(a.json().serverId, b.json().serverId, 'a double click creates one server');
  serverId = a.json().serverId;
  assert.equal((await create(order('web-2'), key)).json().code, 'IDEMPOTENCY_MISMATCH');
  const s = await until(async () => { const r = await serverRow(serverId); return r.state === 'ready' && r; }, 'server ready');
  assert.equal(s.guest_ready, true);
  assert.equal((await lastOp(serverId)).status, 'succeeded');
  assert.equal(await vmCount(serverId), 1);
  const detail = (await send('GET', `/servers/${serverId}`, undefined, user)).json();
  assert.equal(detail.server.address, '10.20.0.10');
  assert.deepEqual(detail.operations.map((o) => [o.kind, o.status]), [['create', 'succeeded']]);
});

test('concurrent orders cannot take the same IP or exceed the pool', { skip }, async () => {
  // Range .10-.12 without .11: only .12 is left.
  const names = ['race-a', 'race-b', 'race-c'];
  const results = await Promise.all(names.map((n) => create(order(n))));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [202, 409, 409]);
  assert.deepEqual(results.filter((r) => r.statusCode === 409).map((r) => r.json().code), ['IP_EXHAUSTED', 'IP_EXHAUSTED']);
  const won = results.find((r) => r.statusCode === 202).json().serverId;
  assert.equal((await pool.query('SELECT host(address) AS a FROM ip_allocations WHERE server_id = $1', [won])).rows[0].a, '10.20.0.12');
  await until(async () => (await serverRow(won)).state === 'ready', 'second server ready');
  const del = await send('DELETE', `/servers/${won}`, { confirm: names[results.findIndex((r) => r.statusCode === 202)] }, user, { 'idempotency-key': randomUUID() });
  assert.equal(del.statusCode, 202, del.body);
  await until(async () => (await serverRow(won)).state === 'deleted', 'second server deleted');
});

test('other customers cannot see or act on a server they do not own', { skip }, async () => {
  for (const [m, p] of [['GET', `/servers/${serverId}`], ['POST', `/servers/${serverId}/actions`], ['POST', `/servers/${serverId}/console`], ['DELETE', `/servers/${serverId}`]]) {
    const res = await send(m, p, { action: 'power_off', confirm: 'web-1' }, other, { 'idempotency-key': randomUUID() });
    assert.equal(res.statusCode, 404, p);
  }
  assert.deepEqual((await send('GET', '/servers', undefined, other)).json().servers, []);
});

test('power actions are separate operations, one at a time per server', { skip }, async () => {
  const act = (action) => send('POST', `/servers/${serverId}/actions`, { action }, user, { 'idempotency-key': randomUUID() });
  const [x, y] = await Promise.all([act('shutdown'), act('reset')]);
  assert.deepEqual([x.statusCode, y.statusCode].sort(), [202, 409]);
  await until(async () => (await lastOp(serverId)).status === 'succeeded', 'first action done');
  const settled = async (want) => until(async () => { const op = await lastOp(serverId); const s = await serverRow(serverId);
    return op.status === 'succeeded' && s.power_state === want; }, `power ${want}`);
  if ((await serverRow(serverId)).power_state !== 'poweredOff') { await act('power_off'); await settled('poweredOff'); }
  assert.equal((await act('power_on')).statusCode, 202);
  await settled('poweredOn');
  assert.equal((await act('reset')).statusCode, 202);
  await settled('poweredOn');
});

test('a VM cloned before a lost response is found, not cloned again', { skip }, async () => {
  await queue.pause();
  const id = (await create(order('lost-1'))).json().serverId;
  await until(async () => (await lastOp(id))?.status === 'pending', 'operation recorded');
  // Simulate vCenter having cloned it although the worker never saw the answer.
  const s = await serverRow(id);
  const tpl = (await pool.query('SELECT template_moref FROM os_images WHERE id = $1', [imageId])).rows[0].template_moref;
  const out = await adapter('/v1/vm/clone', { name: `lvm-${id}`, serverId: id, template: tpl, pool: (await pool.query(
    "SELECT resource_pool FROM vmware_compute WHERE connection_id = $1 AND kind = 'cluster'", [connectionId])).rows[0].resource_pool,
    datastore: (await pool.query('SELECT moref FROM vmware_datastores WHERE connection_id = $1 LIMIT 1', [connectionId])).rows[0].moref,
    network: (await pool.query("SELECT moref FROM vmware_networks WHERE connection_id = $1 AND kind = 'standard' LIMIT 1", [connectionId])).rows[0].moref,
    vcpu: s.vcpu, memoryMb: s.memory_mb, diskGb: s.disk_gb, userdata: '',
    // The allocated address, as the worker would send it, so the guest can become ready.
    metadata: JSON.stringify({ network: { version: 2, ethernets: { nic0: { addresses: [`${(await pool.query('SELECT host(address) AS a FROM ip_allocations WHERE server_id = $1', [id])).rows[0].a}/24`] } } } }) });
  // The worker "died" after saving the task id: the resumed operation must wait on that task.
  await pool.query("UPDATE operations SET status = 'running', provider_task_id = $2, step = 'clone' WHERE server_id = $1", [id, out.task]);
  await queue.resume();
  await until(async () => (await lastOp(id)).status === 'succeeded', 'resumed create');
  assert.equal(await vmCount(id), 1, 'exactly one VM');
  await send('DELETE', `/servers/${id}`, { confirm: 'lost-1' }, user, { 'idempotency-key': randomUUID() });
  await until(async () => (await serverRow(id)).state === 'deleted', 'cleanup');
});

test('an operation whose queue job vanished is recovered from PostgreSQL', { skip }, async () => {
  await queue.pause();
  const id = (await create(order('recover-1'))).json().serverId;
  const op = await lastOp(id);
  await queue.remove(op.id); // as if Redis lost it
  assert.equal(await queue.getJob(op.id), undefined);
  await queue.resume();
  await until(async () => (await lastOp(id)).status === 'succeeded', 'recovered operation', 90);
  await send('DELETE', `/servers/${id}`, { confirm: 'recover-1' }, user, { 'idempotency-key': randomUUID() });
  await until(async () => (await serverRow(id)).state === 'deleted', 'cleanup');
});

test('cancelling a create removes what it built and releases the IP', { skip }, async () => {
  await queue.pause();
  const id = (await create(order('cancel-1'))).json().serverId;
  const op = await lastOp(id);
  assert.equal((await send('POST', `/servers/${id}/operations/${op.id}/cancel`, {}, user)).statusCode, 202);
  await queue.resume();
  await until(async () => (await lastOp(id)).status === 'cancelled', 'cancelled');
  assert.equal((await serverRow(id)).state, 'deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ip_allocations WHERE server_id = $1', [id])).rows[0].n, 0);
  assert.equal(await vmCount(id), 0);
});

test('a permanent VMware error fails at once instead of retrying', { skip }, async () => {
  const { rows: [c] } = await pool.query('SELECT password_enc FROM vmware_connections WHERE id = $1', [connectionId]);
  await pool.query('UPDATE vmware_connections SET password_enc = $2 WHERE id = $1', [connectionId, encryptSecret('wrong-password', connectionId)]);
  await send('POST', `/servers/${serverId}/actions`, { action: 'power_off' }, user, { 'idempotency-key': randomUUID() });
  const op = await until(async () => { const o = await lastOp(serverId); return o.status === 'failed' && o; }, 'failed operation');
  assert.deepEqual([op.error_code, op.attempts], ['INVALID_LOGIN', 1]);
  await pool.query('UPDATE vmware_connections SET password_enc = $2 WHERE id = $1', [connectionId, c.password_enc]);
  // An admin can retry it once the cause is fixed.
  assert.equal((await send('POST', `/admin/operations/${op.id}/retry`)).statusCode, 202);
  await until(async () => (await lastOp(serverId)).status === 'succeeded', 'retried operation');
});

test('quota is enforced at creation', { skip }, async () => {
  const uid = (await pool.query("SELECT id FROM users WHERE email = 'user@example.test'")).rows[0].id;
  await send('PUT', `/admin/quotas/users/${uid}`, { maxServers: 1, maxVcpu: null, maxMemoryMb: null, maxDiskGb: null });
  const res = await create(order('over-1'));
  assert.deepEqual([res.json().code, res.json().fields], ['QUOTA_EXCEEDED', { servers: 'QUOTA_EXCEEDED' }]);
  await send('PUT', `/admin/quotas/users/${uid}`, { maxServers: 10, maxVcpu: null, maxMemoryMb: null, maxDiskGb: null });
});

test('reconciliation reports a VM deleted outside the platform and unknown platform VMs', { skip }, async () => {
  const s = await serverRow(serverId);
  const d = await adapter('/v1/vm/destroy', { vm: s.vm_moref });
  await until(async () => (await adapter('/v1/task', { task: d.task })).state === 'success', 'external delete');
  const orphan = randomUUID();
  const tpl = (await pool.query('SELECT template_moref FROM os_images WHERE id = $1', [imageId])).rows[0].template_moref;
  const c = await adapter('/v1/vm/clone', { name: `lvm-${orphan}`, serverId: orphan, template: tpl,
    pool: (await pool.query("SELECT resource_pool FROM vmware_compute WHERE connection_id = $1 AND kind = 'cluster'", [connectionId])).rows[0].resource_pool,
    datastore: (await pool.query('SELECT moref FROM vmware_datastores WHERE connection_id = $1 LIMIT 1', [connectionId])).rows[0].moref,
    network: (await pool.query("SELECT moref FROM vmware_networks WHERE connection_id = $1 AND kind = 'standard' LIMIT 1", [connectionId])).rows[0].moref,
    vcpu: 1, memoryMb: 512, diskGb: 10, metadata: '{}', userdata: '' });
  await until(async () => (await adapter('/v1/task', { task: c.task })).state === 'success', 'orphan clone');
  assert.equal((await send('POST', '/admin/reconcile')).statusCode, 202);
  // The simulator outlives test runs, so earlier runs may have left other lvm-* VMs: look only at ours.
  const ours = (f) => f.serverId === serverId || f.detail?.name === `lvm-${orphan}`;
  const findings = await until(async () => { const f = (await send('GET', '/admin/reconciliation')).json().findings.filter(ours); return f.length >= 2 && f; }, 'findings');
  assert.deepEqual(findings.map((f) => f.kind).sort(), ['orphan_vm', 'vm_missing']);
  assert.equal((await serverRow(serverId)).state, 'missing');
  assert.equal(await vmCount(orphan), 1, 'reconciliation never deletes by itself');
});

test('deleting releases the IP and reservation only after VMware confirms the VM is gone', { skip }, async () => {
  const id = (await create(order('del-1'))).json().serverId;
  await until(async () => (await serverRow(id)).state === 'ready', 'server ready');
  const reservedBefore = (await send('GET', '/admin/pools')).json().pools[0].capacity.reserved.vcpu;
  assert.equal((await send('DELETE', `/servers/${id}`, { confirm: 'wrong' }, user, { 'idempotency-key': randomUUID() })).json().fields.confirm, 'CONFIRMATION_MISMATCH');
  assert.equal((await send('DELETE', `/servers/${id}`, { confirm: 'del-1' }, user, { 'idempotency-key': randomUUID() })).statusCode, 202);
  await until(async () => (await serverRow(id)).state === 'deleted', 'deleted');
  assert.equal(await vmCount(id), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ip_allocations WHERE server_id = $1', [id])).rows[0].n, 0);
  assert.equal((await send('GET', '/admin/pools')).json().pools[0].capacity.reserved.vcpu, reservedBefore - 1);
  const steps = (await pool.query("SELECT step FROM operations WHERE server_id = $1 AND kind = 'delete'", [id])).rows[0].step;
  assert.equal(steps, 'done');
});
