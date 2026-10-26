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
  method, url: path, payload, headers: { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost', ...headers, ...(session && { cookie: `lvm.session_token=${session}` }) } });
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm\.session_token=([^;]+)/)?.[1];
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
  user = cookieOf(await send('POST', '/auth/sign-up/email', { name: '', email: 'user@example.test', password }, null));
  other = cookieOf(await send('POST', '/auth/sign-up/email', { name: '', email: 'other@example.test', password }, null));
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
  await send('POST', '/admin/ip-pools', { name: 'tiny', poolId, cidr: '10.20.0.0/24', gateway: '10.20.0.1', dns: ['10.20.0.53'], rangeStart: '10.20.0.10', rangeEnd: '10.20.0.12', excluded: ['10.20.0.11'],
    quarantineHours: 0 }); // these tests reuse the two addresses at once
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

test('favorites and the monthly budget: a starred server is marked; an order over budget is flagged; going over is noted once a month', { skip }, async () => {
  const fav = '/servers/' + serverId + '/favorite';
  assert.equal((await send('PUT', fav, undefined, user)).json().favorite, true);
  assert.equal((await send('GET', '/servers', undefined, user)).json().servers.find((x) => x.id === serverId).favorite, true);
  assert.equal((await send('PUT', fav, undefined, other)).statusCode, 404, 'only servers you can see');
  await send('DELETE', fav, undefined, user);
  assert.equal((await send('GET', '/servers', undefined, user)).json().servers.find((x) => x.id === serverId).favorite, false);

  assert.deepEqual(Object.keys((await send('PUT', '/usage/budget', { amount: -1, currency: 'x' }, user)).json().fields).sort(), ['amount', 'currency']);
  const mine = (await send('GET', '/servers', undefined, user)).json().servers;
  const currency = mine[0].currency.trim();
  const monthly = mine.filter((x) => x.currency.trim() === currency).reduce((a, x) => a + Number(x.priceMonthly), 0);
  // A budget above today's cost: fine now, but the quote shows the next order going over it.
  const roomy = (await send('PUT', '/usage/budget', { amount: monthly + 0.01, currency }, user)).json().budget;
  assert.equal(roomy.currency, currency);
  assert.notEqual(roomy.state, 'over');
  const q = (await send('POST', '/catalog/quote', order('budget-check'), user)).json();
  assert.equal(q.budget.state, 'over');
  assert.ok(q.budget.monthly > roomy.monthly);
  // Below today's cost: over, and the month is recorded so the notice goes out once.
  assert.equal((await send('PUT', '/usage/budget', { amount: Math.max(0.01, monthly / 2), currency }, user)).json().budget.state, 'over');
  const { rows: [u] } = await pool.query("SELECT budget_alerted FROM users WHERE budget_currency IS NOT NULL");
  assert.equal(u.budget_alerted, new Date().toISOString().slice(0, 7));
  assert.equal((await send('GET', '/usage/summary', undefined, user)).json().budget.state, 'over');
  assert.equal((await send('PUT', '/usage/budget', { amount: null }, user)).json().budget, null);
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

test('firewalls: rules are validated and owned, and applied to the distributed port before first boot', { skip }, async () => {
  const bad = await send('POST', '/firewalls', { name: 'web', rules: [{ direction: 'in', protocol: 'tcp', port: '99999', ips: ['0.0.0.0/0'] },
    { direction: 'sideways', protocol: 'tcp', port: '22', ips: ['nope'] }] }, user);
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json().fields, { 'rules.0.port': 'INVALID_PORT', 'rules.1.direction': 'INVALID_VALUE', 'rules.1.ips': 'INVALID_NETWORK' });
  const rules = [{ direction: 'in', protocol: 'tcp', port: '22', ips: ['0.0.0.0/0', '::/0'], description: 'ssh' }, { direction: 'in', protocol: 'icmp', ips: ['0.0.0.0/0'] }];
  const fw = (await send('POST', '/firewalls', { name: 'web', rules }, user)).json();
  assert.equal(fw.rules[1].port, null);
  assert.equal((await send('POST', '/firewalls', { name: 'web', rules: [] }, user)).json().fields.name, 'NAME_TAKEN');
  assert.equal((await send('GET', `/firewalls/${fw.id}`, undefined, other)).statusCode, 404);
  assert.equal((await send('GET', '/firewalls', undefined, other)).json().firewalls.length, 0);

  // A server on a standard switch: the firewall cannot be enforced, and the server shows why.
  const std = (await create(order('fw-std'))).json().serverId;
  await until(async () => (await serverRow(std)).state === 'ready', 'standard-switch server ready');
  assert.equal((await send('POST', `/firewalls/${fw.id}/servers`, { serverIds: [std] }, other)).statusCode, 404);
  assert.equal((await send('POST', `/firewalls/${fw.id}/servers`, { serverIds: [std] }, user)).statusCode, 200);
  const failed = await until(async () => { const s = (await send('GET', `/firewalls/${fw.id}`, undefined, user)).json().servers[0]; return s.status === 'failed' && s; }, 'firewall failure recorded');
  assert.equal(failed.errorCode, 'FIREWALL_NEEDS_DVS');
  assert.equal((await send('DELETE', `/firewalls/${fw.id}`, undefined, user)).json().code, 'FIREWALL_IN_USE');

  // A location on the distributed switch: ordered with the firewall, which is in place before the first boot.
  const { rows: [dv] } = await pool.query("SELECT moref FROM vmware_networks WHERE connection_id = $1 AND kind = 'distributed' AND name NOT ILIKE '%uplink%' LIMIT 1", [connectionId]);
  const p = (await send('GET', '/admin/pools')).json().pools.find((x) => x.id === poolId);
  const dvPool = (await send('POST', '/admin/pools', { name: 'Sim DVS', connectionId, computeMoref: p.computeMoref, datastoreMorefs: p.datastoreMorefs, networkMoref: dv.moref,
    cpuOvercommit: 16, memoryOvercommit: 4, storageOvercommit: 10, reserveCpuPct: 0, reserveMemoryPct: 0, reserveStoragePct: 0 })).json().id;
  await send('POST', '/admin/ip-pools', { name: 'dvs', poolId: dvPool, cidr: '10.40.0.0/24', gateway: '10.40.0.1', dns: ['10.40.0.53'], rangeStart: '10.40.0.10', rangeEnd: '10.40.0.20' });
  const pkg = (await send('POST', '/admin/packages', { name: 'Tiny DVS', vcpu: 1, memoryMb: 512, diskGb: 10, priceMonthly: '1.00', currency: 'EUR', poolIds: [dvPool], imageIds: [imageId] })).json().id;
  const res = await create({ ...order('fw-dvs'), poolId: dvPool, packageId: pkg, firewallIds: [fw.id] });
  assert.equal(res.statusCode, 202, res.body);
  const dvs = res.json().serverId;
  await until(async () => (await serverRow(dvs)).state === 'ready', 'distributed-switch server ready');
  let row = await serverRow(dvs);
  assert.deepEqual([row.firewall_version, row.firewall_applied_version, row.firewall_error], [1, 1, null]);
  assert.ok((await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND kind = 'create' AND status = 'succeeded'", [dvs])).rowCount);

  // Changing the rules or detaching re-applies; each change is a new version.
  assert.equal((await send('PUT', `/firewalls/${fw.id}`, { rules: [rules[0]] }, user)).statusCode, 200);
  await until(async () => (await serverRow(dvs)).firewall_applied_version === 2, 'changed rules applied');
  assert.equal((await send('DELETE', `/firewalls/${fw.id}/servers/${dvs}`, undefined, user)).statusCode, 200);
  await until(async () => (await serverRow(dvs)).firewall_applied_version === 3, 'detach applied');
  row = await serverRow(dvs);
  assert.equal(row.firewall_error, null);
  assert.equal((await send('DELETE', `/firewalls/${fw.id}/servers/${std}`, undefined, user)).statusCode, 200);
  assert.equal((await send('DELETE', `/firewalls/${fw.id}`, undefined, user)).statusCode, 204);
});

test('IP management: extra IPv4 and IPv6 in one order, default PTR in PowerDNS, customer edits, quarantine after delete', { skip: skip || (!process.env.RDNS_TEST_URL && 'needs RDNS_TEST_URL (PowerDNS)') }, async () => {
  const pdnsUrl = process.env.RDNS_TEST_URL, pdnsKey = process.env.RDNS_TEST_KEY;
  const pdns = (path, init = {}) => fetch(`${pdnsUrl}/api/v1/servers/localhost${path}`, { ...init, headers: { 'x-api-key': pdnsKey, 'content-type': 'application/json' } });
  for (const name of ['0.40.10.in-addr.arpa.', '8.b.d.0.1.0.0.2.ip6.arpa.']) {
    await pdns(`/zones/${name}`, { method: 'DELETE' });
    assert.equal((await pdns('/zones', { method: 'POST', body: JSON.stringify({ name, kind: 'Native', nameservers: ['ns1.example.com.'] }) })).status, 201);
  }
  const ptrOf = async (rev, zone) => (await (await pdns(`/zones/${zone}`)).json()).rrsets.find((r) => r.name === rev && r.type === 'PTR')?.records[0]?.content ?? null;
  const { startRdnsWorker } = await import('../../dist/rdns.js');
  const rdnsWorker = startRdnsWorker();
  try {
    // Admin: PowerDNS settings, checked against the server; IPv6 and quarantine on the IP pool; extra IPs for sale.
    let r = await send('PUT', '/admin/settings/rdns', { provider: 'powerdns', apiUrl: pdnsUrl, apiKey: pdnsKey, serverId: 'localhost', template: '{ip-dashed}.static.example.com', ttl: 3600 });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().apiKeySet, true);
    assert.ok(!r.body.includes(pdnsKey));
    const t = (await send('POST', '/admin/settings/rdns/test', { apiUrl: pdnsUrl, serverId: 'localhost' })).json();
    assert.ok(t.zones.includes('0.40.10.in-addr.arpa.'), JSON.stringify(t));
    const ipPool = (await send('GET', '/admin/ip-pools')).json().ipPools.find((p) => p.name === 'dvs');
    assert.equal((await send('PUT', `/admin/ip-pools/${ipPool.id}`, { quarantineHours: 24, ipv6Prefix: '2001:db8:40::/64', ipv6Gateway: '2001:db8:40::1', dns: ['10.40.0.53'], excluded: [] })).statusCode, 200);
    assert.equal((await send('PUT', `/admin/ip-pools/${ipPool.id}`, { ipv6Prefix: '2001:db8:40::/64', ipv6Gateway: '2001:db8:99::1' })).json().fields.ipv6Gateway, 'IPV6_GATEWAY_OUTSIDE');
    await pool.query("UPDATE resource_pools SET extra_ipv4_max = 2, extra_ipv4_price = 2.50 WHERE id = $1", [ipPool.poolId]);
    const pkg = (await pool.query("SELECT id FROM packages WHERE name = 'Tiny DVS'")).rows[0].id;
    const base = { ...order('ip-1'), poolId: ipPool.poolId, packageId: pkg };
    assert.equal((await send('POST', '/catalog/quote', { ...base, extraIpv4: 1 }, user)).json().price.monthly, '3.50');
    assert.equal((await send('POST', '/catalog/quote', { ...base, extraIpv4: 3 }, user)).json().fields.extraIpv4, 'OUT_OF_RANGE');

    const id = (await create({ ...base, extraIpv4: 1 })).json().serverId;
    await until(async () => (await serverRow(id)).state === 'ready', 'server with extra IPs ready');
    const ips = await until(async () => { const x = (await send('GET', `/servers/${id}/ips`, undefined, user)).json().addresses; return x.length === 3 && x.every((a) => a.ptr) && x; }, 'default PTRs');
    assert.deepEqual(ips.map((a) => a.kind), ['primary', 'extra', 'ipv6']);
    const [primary, , v6] = ips;
    assert.match(v6.address, /^2001:db8:40::/);
    const rev = `${primary.address.split('.').reverse().join('.')}.in-addr.arpa.`;
    assert.equal(await ptrOf(rev, '0.40.10.in-addr.arpa.'), `${primary.address.replaceAll('.', '-')}.static.example.com.`);

    // A customer's own name must resolve back to the address; staff may set any valid name.
    assert.equal((await send('PUT', `/servers/${id}/ips/${primary.address}/ptr`, { ptr: 'mail.no-such-name.invalid' }, user)).json().fields.ptr, 'PTR_FORWARD_MISMATCH');
    assert.equal((await send('PUT', `/servers/${id}/ips/${primary.address}/ptr`, { ptr: 'mail.example.com' }, other)).statusCode, 404);
    assert.equal((await send('PUT', `/servers/${id}/ips/${primary.address}/ptr`, { ptr: 'mail.example.com' })).statusCode, 200);
    assert.equal(await ptrOf(rev, '0.40.10.in-addr.arpa.'), 'mail.example.com.');

    // Delete: the PTRs go away and the addresses wait in quarantine; the next order does not get them.
    assert.equal((await send('DELETE', `/servers/${id}`, { confirm: 'ip-1' }, user, { 'idempotency-key': randomUUID() })).statusCode, 202);
    await until(async () => (await serverRow(id)).state === 'deleted', 'deleted');
    await until(async () => (await ptrOf(rev, '0.40.10.in-addr.arpa.')) === null, 'PTR removed');
    const q = (await send('GET', `/admin/ip-addresses?ipPoolId=${ipPool.id}`)).json().addresses.filter((a) => a.state === 'quarantine').map((a) => a.address);
    assert.ok(q.includes(primary.address) && q.includes(v6.address), JSON.stringify(q));
    const next = (await create({ ...base, name: 'ip-2' })).json().serverId;
    const nextIp = (await pool.query("SELECT host(address) AS a FROM ip_allocations WHERE server_id = $1 AND kind = 'primary'", [next])).rows[0].a;
    assert.notEqual(nextIp, primary.address);
    const nextV6 = (await pool.query("SELECT host(address) AS a FROM ip_allocations WHERE server_id = $1 AND kind = 'ipv6'", [next])).rows[0].a;
    assert.notEqual(nextV6, v6.address, 'the quarantined IPv6 is not handed out again');
    assert.equal((await send('DELETE', `/admin/ip-quarantine/${primary.address}`)).statusCode, 204);
  } finally { await rdnsWorker.close(); }
});

test('root password: a weak one is replaced by a branded strong one, shown only to the owner, and can be forgotten', { skip }, async () => {
  await send('PUT', '/admin/settings/branding', { name: 'Lightning VM', passwordPrefix: 'Acme' });
  const pkg = (await pool.query("SELECT id FROM packages WHERE name = 'Tiny DVS'")).rows[0].id;
  const dvPool = (await pool.query("SELECT id FROM resource_pools WHERE name = 'Sim DVS'")).rows[0].id;
  const res = await create({ ...order('pw-1'), poolId: dvPool, packageId: pkg, rootPassword: '123456' });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().passwordReplaced, true);
  const id = res.json().serverId;
  const row = await serverRow(id);
  assert.match(row.root_password_hash, /^\$6\$/);
  const shown = (await send('GET', `/servers/${id}/root-password`, undefined, user)).json().password;
  assert.match(shown, /^Acme(-[A-Za-z2-9]{4}){4}$/);
  assert.ok(!row.root_password_enc.includes(shown), 'stored encrypted');
  assert.equal((await send('GET', `/servers/${id}/root-password`, undefined, other)).statusCode, 404);
  assert.equal((await send('DELETE', `/servers/${id}/root-password`, undefined, user)).statusCode, 204);
  assert.equal((await send('GET', `/servers/${id}/root-password`, undefined, user)).statusCode, 404);
  // A strong password is kept as typed.
  const strong = await create({ ...order('pw-2'), poolId: dvPool, packageId: pkg, rootPassword: 'Tr0ub4dor&3-horse-Battery' });
  assert.equal(strong.json().passwordReplaced, false);
  assert.equal((await send('GET', `/servers/${strong.json().serverId}/root-password`, undefined, user)).json().password, 'Tr0ub4dor&3-horse-Battery');
  for (const s of [id, strong.json().serverId]) {
    await until(async () => (await serverRow(s)).state === 'ready', 'ready');
    await send('DELETE', `/servers/${s}`, { confirm: (await serverRow(s)).name }, user, { 'idempotency-key': randomUUID() });
  }
});

test('applications: a licence from the pool per order, price added, the guest reports back, the licence returns on delete', { skip }, async () => {
  const app_ = await send('POST', '/admin/applications', { name: 'Plesk test', kind: 'plesk', licenseMode: 'pool', priceMonthly: '5.00', minMemoryMb: 512, minDiskGb: 10 });
  assert.equal(app_.statusCode, 201, app_.body);
  const appId = app_.json().id;
  assert.equal((await send('POST', `/admin/applications/${appId}/licenses`, { keys: 'bad key with spaces' })).json().fields.keys, 'INVALID_LICENSE_KEYS');
  assert.equal((await send('POST', `/admin/applications/${appId}/licenses`, { keys: 'PLSK-AAAA-1111\nPLSK-BBBB-2222' })).json().added, 2);
  const pkg = (await pool.query("SELECT id FROM packages WHERE name = 'Tiny DVS'")).rows[0].id;
  const dvPool = (await pool.query("SELECT id FROM resource_pools WHERE name = 'Sim DVS'")).rows[0].id;
  const plain = { ...order('app-1'), poolId: dvPool, packageId: pkg };
  const base = { ...plain, applicationId: appId };
  const monthly = async (body) => Number((await send('POST', '/catalog/quote', body, user)).json().price.monthly);
  assert.equal(await monthly(base), await monthly(plain) + 5);
  assert.equal((await send('GET', '/catalog', undefined, user)).json().applications.find((a) => a.id === appId).available, true);

  const r = await create(base);
  assert.equal(r.statusCode, 202, r.body);
  const id = r.json().serverId;
  let row = await serverRow(id);
  assert.equal(row.app_state, 'pending');
  assert.ok(row.app_script_enc && !row.app_script_enc.includes('PLSK-'), 'the rendered script (with the key) is stored encrypted');
  const lic = (await send('GET', `/admin/applications/${appId}/licenses`)).json().licenses.find((l) => l.serverId === id);
  assert.ok(lic && ['1111', '2222'].includes(lic.hint));

  // The guest's report: only with the token from its script, and without a session.
  const cb = (body) => send('POST', `/servers/${id}/app-callback`, body, null);
  assert.equal((await cb({ token: 'wrong', status: 'installed' })).statusCode, 404);
  const { decryptSecret } = await import('../../dist/secrets.js');
  const script = decryptSecret(row.app_script_enc, 'server-app-script');
  const token = /token\\":\\"([A-Za-z0-9_-]+)/.exec(script)[1];
  assert.match(script, /plesk bin license --install PLSK-[AB]{4}-\d{4}/);
  assert.equal((await cb({ token, status: 'installing' })).statusCode, 204);
  assert.equal((await cb({ token, status: 'installed' })).statusCode, 204);
  row = await serverRow(id);
  assert.equal(row.app_state, 'installed');
  assert.equal((await send('GET', `/servers/${id}`, undefined, user)).json().server.appState, 'installed');

  // Two keys: a second order gets the other one, a third finds none.
  const second = await create({ ...base, name: 'app-2' });
  assert.equal(second.statusCode, 202, second.body);
  assert.equal((await create({ ...base, name: 'app-3' })).json().code, 'LICENSE_EXHAUSTED');
  assert.equal((await send('GET', '/catalog', undefined, user)).json().applications.find((a) => a.id === appId).available, false);
  assert.equal((await send('DELETE', `/admin/applications/${appId}`)).json().code, 'IN_USE');
  for (const s of [id, second.json().serverId]) {
    await until(async () => (await serverRow(s)).state === 'ready', 'ready');
    await send('DELETE', `/servers/${s}`, { confirm: (await serverRow(s)).name }, user, { 'idempotency-key': randomUUID() });
    await until(async () => (await serverRow(s)).state === 'deleted', 'deleted');
  }
  assert.equal((await send('GET', `/admin/applications/${appId}/licenses`)).json().licenses.filter((l) => !l.serverId).length, 2, 'both keys are free again');
});

test('ISO library: storages over WebDAV/FTP/SFTP, copy into a location, insert/boot/eject on a server, delete', { skip: skip || (!process.env.ISO_TEST_HOST && 'needs the iso-src-test storage (run-it.sh)') }, async () => {
  const host = process.env.ISO_TEST_HOST;
  const dav = { name: 'Test DAV', protocol: 'webdav', config: { url: `http://${host}:8080`, user: 'isouser', pass: 'isopass' } };
  assert.equal((await send('POST', '/admin/iso-sources/test', { ...dav, config: { ...dav.config, pass: 'wrong' } })).json().code, 'STORAGE_AUTH_FAILED');
  assert.equal((await send('POST', '/admin/iso-sources/test', { ...dav, config: { url: 'ftp://x' } })).json().fields.url, 'INVALID_URL');
  for (const body of [dav, { protocol: 'ftp', config: { host, port: 2121, user: 'isouser', pass: 'isopass' } }, { protocol: 'sftp', config: { host, port: 2222, user: 'isouser', pass: 'isopass' } }]) {
    const t = await send('POST', '/admin/iso-sources/test', body);
    assert.equal(t.statusCode, 200, `${body.protocol}: ${t.body}`);
  }
  const created = await send('POST', '/admin/iso-sources', { ...dav, basePath: '' });
  assert.equal(created.statusCode, 201, created.body);
  const sourceId = created.json().id;
  const listed = (await send('GET', '/admin/iso-sources')).json().sources.find((s) => s.id === sourceId);
  assert.deepEqual(listed.secretsSet, ['pass']);
  assert.ok(!JSON.stringify(listed).includes('isopass'), 'secrets never leave the API');
  // Saving without the password keeps the stored one.
  assert.equal((await send('PUT', `/admin/iso-sources/${sourceId}`, { ...dav, config: { ...dav.config, pass: '' } })).statusCode, 200);
  const root = (await send('POST', `/admin/iso-sources/${sourceId}/browse`, { path: '' })).json();
  assert.ok(root.entries.some((e) => e.dir && e.name === 'isos'), JSON.stringify(root));
  const dir = (await send('POST', `/admin/iso-sources/${sourceId}/browse`, { path: 'isos' })).json().entries;
  assert.deepEqual(dir.map((e) => e.name), ['sub', 'test-1.iso'], 'folders first, only .iso files');
  assert.equal(dir[1].size, 3145728);
  assert.equal((await send('POST', `/admin/iso-sources/${sourceId}/browse`, { path: '../etc' })).json().fields.path, 'INVALID_VALUE');

  const dvPool = (await pool.query("SELECT id FROM resource_pools WHERE name = 'Sim DVS'")).rows[0].id;
  const imp = await send('POST', '/admin/isos', { sourceId, path: 'isos/test-1.iso', name: 'Test ISO', poolIds: [dvPool] });
  assert.equal(imp.statusCode, 202, imp.body);
  const isoId = imp.json().ids[0];
  await until(async () => (await pool.query('SELECT state FROM isos WHERE id = $1', [isoId])).rows[0].state !== 'copying', 'copied', 120);
  const iso = (await send('GET', '/admin/isos')).json().isos.find((i) => i.id === isoId);
  assert.equal(iso.state, 'ready', iso.error);
  assert.equal(iso.copiedBytes, 3145728);
  assert.equal((await send('POST', '/admin/isos', { sourceId, path: 'isos/test-1.iso', poolIds: [dvPool] })).json().fields.path, 'ISO_EXISTS');
  assert.equal((await send('POST', '/admin/isos', { sourceId, path: 'isos/readme.txt', poolIds: [dvPool] })).json().fields.path, 'NOT_AN_ISO');

  const pkg = (await pool.query("SELECT id FROM packages WHERE name = 'Tiny DVS'")).rows[0].id;
  const r = await create({ ...order('iso-1'), poolId: dvPool, packageId: pkg });
  const id = r.json().serverId;
  await until(async () => (await serverRow(id)).state === 'ready', 'ready');
  assert.ok((await send('GET', `/servers/${id}/isos`, undefined, user)).json().isos.some((i) => i.id === isoId));
  assert.equal((await send('PUT', `/servers/${id}/iso`, { isoId: randomUUID() }, user)).json().fields.isoId, 'NOT_AVAILABLE');
  const ins = await send('PUT', `/servers/${id}/iso`, { isoId, boot: true }, user);
  assert.equal(ins.statusCode, 200, ins.body);
  assert.equal((await serverRow(id)).iso_id, isoId);
  assert.equal((await send('DELETE', `/admin/isos/${isoId}`)).json().code, 'IN_USE');
  assert.equal((await send('PUT', `/servers/${id}/iso`, { isoId: null }, user)).json().inserted, null);
  assert.equal((await serverRow(id)).iso_id, null);
  assert.equal((await send('DELETE', `/admin/isos/${isoId}`)).statusCode, 202);
  await until(async () => !(await pool.query('SELECT 1 FROM isos WHERE id = $1', [isoId])).rowCount, 'ISO removed');
  await send('DELETE', `/servers/${id}`, { confirm: 'iso-1' }, user, { 'idempotency-key': randomUUID() });
  await send('DELETE', `/admin/iso-sources/${sourceId}`);
});

test('locations: details, a pool assigned, maintenance blocks orders, hidden removes it from the catalog', { skip }, async () => {
  assert.equal((await send('POST', '/admin/locations', { name: 'Bad', countryCode: 'TUR', pingUrl: 'ftp://x', latitude: 41 })).json().fields.countryCode, 'INVALID_VALUE');
  const created = await send('POST', '/admin/locations', { name: 'Istanbul DC1', city: 'İstanbul', countryCode: 'tr', datacenter: 'Equinix IL2', latitude: 41.0082, longitude: 28.9784,
    pingUrl: 'https://speed.example.com/ping', testIp: '203.0.113.9', description: '10G uplink' });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const dvPool = (await pool.query("SELECT id FROM resource_pools WHERE name = 'Sim DVS'")).rows[0].id;
  assert.equal((await send('PUT', `/admin/pools/${dvPool}/location`, { locationId: id })).statusCode, 200);
  const cat = (await send('GET', '/catalog', undefined, user)).json();
  const loc = cat.locations.find((l) => l.id === id);
  assert.deepEqual([loc.countryCode, loc.city, loc.testIp, loc.latitude], ['TR', 'İstanbul', '203.0.113.9', 41.0082]);
  assert.equal(cat.pools.find((p) => p.id === dvPool).locationId, id);
  const pkg = (await pool.query("SELECT id FROM packages WHERE name = 'Tiny DVS'")).rows[0].id;
  const body = { ...order('loc-1'), poolId: dvPool, packageId: pkg };
  const edit = (status) => send('PUT', `/admin/locations/${id}`, { name: 'Istanbul DC1', city: 'İstanbul', countryCode: 'TR', status });
  assert.equal((await edit('maintenance')).statusCode, 200);
  assert.equal((await send('POST', '/catalog/quote', body, user)).json().code, 'LOCATION_UNAVAILABLE');
  assert.equal((await edit('hidden')).statusCode, 200);
  assert.ok(!(await send('GET', '/catalog', undefined, user)).json().pools.some((p) => p.id === dvPool), 'pools of a hidden location are not offered');
  assert.equal((await edit('active')).statusCode, 200);
  assert.equal((await send('POST', '/catalog/quote', body, user)).statusCode, 200);
  assert.equal((await send('DELETE', `/admin/locations/${id}`)).json().code, 'IN_USE');
  // The pool keeps showing the location's name, also after a rename.
  await send('PUT', `/admin/locations/${id}`, { name: 'Istanbul-1', countryCode: 'TR' });
  assert.equal((await pool.query('SELECT location FROM resource_pools WHERE id = $1', [dvPool])).rows[0].location, 'Istanbul-1');
  await send('PUT', `/admin/pools/${dvPool}/location`, { locationId: null });
  assert.equal((await send('DELETE', `/admin/locations/${id}`)).statusCode, 204);
});

test('server settings: customers lose actions the admin turns off (staff keep them); ESXi images need a bigger shape', { skip }, async () => {
  const id = serverId;
  const set = (customer) => send('PUT', '/admin/settings/servers', { customer });
  assert.deepEqual((await send('GET', `/servers/${id}`, undefined, user)).json().allowed, { power: true, console: true, iso: true, rootPassword: true, delete: true, snapshots: true });
  assert.equal((await set({ power: false, delete: false, console: false })).statusCode, 200);
  const detail = (await send('GET', `/servers/${id}`, undefined, user)).json();
  assert.equal(detail.allowed.power, false);
  const act = await send('POST', `/servers/${id}/actions`, { action: 'reset' }, user, { 'idempotency-key': randomUUID() });
  assert.equal(act.json().code, 'ACTION_DISABLED');
  assert.equal((await send('DELETE', `/servers/${id}`, { confirm: 'x' }, user, { 'idempotency-key': randomUUID() })).json().code, 'ACTION_DISABLED');
  assert.equal((await send('POST', `/servers/${id}/console`, {}, user)).json().code, 'ACTION_DISABLED');
  assert.equal((await send('GET', `/servers/${id}`)).json().allowed.power, true, 'staff are not limited');
  assert.equal((await set({ power: true, delete: true, console: true })).statusCode, 200);

  const conn = (await pool.query('SELECT connection_id FROM os_images WHERE id = $1', [imageId])).rows[0].connection_id;
  await pool.query("INSERT INTO os_images (name, family, connection_id, template_moref, min_disk_gb) VALUES ('Sim ESXi', 'esxi', $1, 'vm-esxi-tpl', 10)", [conn]);
  const esxi = (await pool.query("SELECT id FROM os_images WHERE name = 'Sim ESXi'")).rows[0].id;
  await pool.query('INSERT INTO package_images (package_id, image_id) VALUES ($1, $2)', [packageId, esxi]);
  const shape = (await send('POST', '/catalog/quote', order('esx-1'), user)).json().shape;
  assert.ok(shape.vcpu < 2 || shape.memoryMb < 4096, 'the test package is smaller than ESXi needs');
  assert.equal((await create({ ...order('esx-1'), imageId: esxi })).json().fields.imageId, 'ESXI_NEEDS_MORE');
  await pool.query('DELETE FROM package_images WHERE image_id = $1', [esxi]);
  await pool.query('DELETE FROM os_images WHERE id = $1', [esxi]);
});

test('energy: samples estimated from a host profile, shares per server, kWh, cost and carbon', { skip }, async () => {
  assert.equal((await send('PUT', '/admin/settings/energy', { pricePerKwh: 'x', currency: 'TL', pue: 5, co2GramsPerKwh: -1 })).json().fields.pricePerKwh, 'INVALID_AMOUNT');
  assert.equal((await send('PUT', '/admin/settings/energy', { pricePerKwh: '3,50', currency: 'try', pue: 1.4, co2GramsPerKwh: 450 })).json().pricePerKwh, '3.50');
  const sample = async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM power_samples')).rows[0].n;
    assert.equal((await send('POST', '/admin/power/sample')).statusCode, 202);
    await until(async () => (await pool.query('SELECT count(*)::int AS n FROM power_samples')).rows[0].n > before, 'a power sample', 60);
  };
  await sample();
  let r = (await send('GET', '/admin/power?range=1d')).json();
  assert.ok(r.hosts.length > 0 && r.now.hosts > 0, JSON.stringify(r.now));
  const h = r.hosts[0];
  assert.equal(h.source, 'estimated', 'the simulator reports no power counter');
  assert.ok(h.watts >= 120 && h.watts <= 400, `default profile: ${h.watts}`);
  assert.equal(r.settings.currency, 'TRY');
  assert.equal(r.now.facilityWatts.toFixed(2), (r.now.watts * 1.4).toFixed(2));

  assert.equal((await send('PUT', '/admin/power/profiles', { connectionId: h.connectionId, hostMoref: h.moref, idleWatts: 500, maxWatts: 100 })).json().fields.maxWatts, 'OUT_OF_RANGE');
  assert.equal((await send('PUT', '/admin/power/profiles', { connectionId: h.connectionId, hostMoref: h.moref, idleWatts: 1000, maxWatts: 1000 })).statusCode, 200);
  await new Promise((res) => setTimeout(res, 1500));
  await sample();
  r = (await send('GET', '/admin/power?range=1d')).json();
  assert.equal(r.hosts.find((x) => x.moref === h.moref).watts, 1000, 'the profile drives the estimate');
  assert.ok(r.energy.rangeKwh > 0 && Number(r.energy.costRange) >= 0);
  // Running servers got a share of their host's watts.
  assert.ok((await pool.query('SELECT count(*)::int AS n FROM power_server_samples')).rows[0].n > 0, 'server shares stored');
  await send('PUT', '/admin/power/profiles', { connectionId: h.connectionId, hostMoref: h.moref, idleWatts: null, maxWatts: null });
});

test('abuse: an open risky port is found and resolved, sustained full CPU is a mining suspicion', { skip: skip || (!process.env.RDNS_TEST_URL && 'needs pdns-test (run-it.sh)') }, async () => {
  const { lookup } = await import('node:dns/promises');
  const target = (await lookup(new URL(process.env.RDNS_TEST_URL).hostname, { family: 4 })).address;
  assert.equal((await send('PUT', '/admin/settings/abuse', { portScan: true, scanMinutes: 30, cpu: true, cpuThreshold: 90, cpuHours: 1, ports: [{ port: 70000 }] })).json().fields.ports, 'INVALID_PORT_LIST');
  assert.equal((await send('PUT', '/admin/settings/abuse', { portScan: true, scanMinutes: 30, cpu: true, cpuThreshold: 90, cpuHours: 1, notifyCustomer: true,
    ports: [{ port: 8081, label: 'PowerDNS API' }] })).statusCode, 200);
  // A ready server pretends to own the PowerDNS container's address (an extra allocation, no pool range needed).
  const s = (await pool.query("SELECT id FROM servers WHERE state = 'ready' LIMIT 1")).rows[0].id;
  const ipPool = (await pool.query('SELECT id FROM ip_pools LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO ip_allocations (ip_pool_id, address, server_id, kind) VALUES ($1, $2, $3, 'extra')", [ipPool, target, s]);
  const scan = async () => { assert.equal((await send('POST', '/admin/abuse/scan')).statusCode, 202); };
  await scan();
  await until(async () => (await pool.query("SELECT 1 FROM abuse_findings WHERE kind = 'port' AND server_id = $1 AND port = 8081 AND resolved_at IS NULL", [s])).rowCount, 'open port found', 90);
  const f = (await send('GET', '/admin/abuse')).json().findings.find((x) => x.serverId === s && x.port === 8081);
  assert.equal(f.address, target);
  assert.equal(f.detail.label, 'PowerDNS API');
  assert.equal((await send('PUT', `/admin/abuse/${f.id}/acknowledge`, { note: 'test container' })).statusCode, 200);
  // Queued for staff (and the customer, notifyCustomer); the API's notification worker delivers them.
  const nq = new Queue('notifications', { connection: queueRedis });
  const events = (await nq.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])).map((j) => j?.data?.event);
  await nq.close();
  assert.ok(events.includes('admin.abuse') && events.includes('server.port_open'), JSON.stringify(events));

  // The address goes away: the next scan resolves the finding.
  await pool.query('DELETE FROM ip_allocations WHERE server_id = $1 AND address = $2', [s, target]);
  await new Promise((r) => setTimeout(r, 1500));
  await scan();
  await until(async () => (await pool.query('SELECT 1 FROM abuse_findings WHERE id = $1 AND resolved_at IS NOT NULL', [f.id])).rowCount, 'port finding resolved', 90);

  // An hour of samples near 100%: the next CPU check (with the energy sample) opens a suspicion.
  await pool.query('DELETE FROM server_cpu_samples WHERE server_id = $1', [s]);
  for (let i = 1; i <= 14; i++) await pool.query("INSERT INTO server_cpu_samples (server_id, at, cpu_pct) VALUES ($1, now() - make_interval(mins => $2), 97)", [s, i * 4]);
  await scan();
  await until(async () => (await pool.query("SELECT 1 FROM abuse_findings WHERE kind = 'cpu' AND server_id = $1 AND resolved_at IS NULL", [s])).rowCount, 'mining suspicion', 90);
  await send('PUT', '/admin/settings/abuse', { portScan: false, scanMinutes: 30, cpu: false, cpuThreshold: 90, cpuHours: 6, ports: [] });
});

test('virtual data center: an allocation reserved in the pool, free shapes inside it, its limits, bulk power', { skip }, async () => {
  const userId = (await pool.query("SELECT id FROM users WHERE email LIKE 'user%' ORDER BY created_at LIMIT 1")).rows[0].id;
  const dvPool = (await pool.query("SELECT id FROM resource_pools WHERE name = 'Sim DVS'")).rows[0];
  const capBefore = (await send('GET', '/admin/pools')).json().pools.find((p) => p.id === dvPool.id).capacity.available;
  const big = await send('POST', '/admin/vdcs', { ownerId: userId, poolId: dvPool.id, name: 'Too big', vcpu: 100000, memoryMb: 512, diskGb: 10, maxServers: 1 });
  assert.equal(big.json().code, 'CAPACITY_EXHAUSTED');
  const made = await send('POST', '/admin/vdcs', { ownerId: userId, poolId: dvPool.id, name: 'Team A', vcpu: 2, memoryMb: 2048, diskGb: 40, maxServers: 2, priceMonthly: '49.90', currency: 'EUR' });
  assert.equal(made.statusCode, 201, made.body);
  const vdcId = made.json().id;
  const capAfter = (await send('GET', '/admin/pools')).json().pools.find((p) => p.id === dvPool.id).capacity.available;
  assert.equal(capBefore.vcpu - capAfter.vcpu, 2, 'the allocation is reserved in the pool');

  const mine = (await send('GET', '/vdcs', undefined, user)).json().vdcs.find((v) => v.id === vdcId);
  assert.equal(mine.priceMonthly, '49.90');
  const img = mine.images[0].id;
  const make = (name, shape) => create({ vdcId, imageId: img, name, sshKeyIds: [keyId], ...shape });
  assert.equal((await make('vdc-x', { vcpu: 3, memoryMb: 1024, diskGb: 10 })).json().fields.vcpu, 'OUT_OF_RANGE');
  const a = await make('vdc-a', { vcpu: 1, memoryMb: 1024, diskGb: 20 });
  assert.equal(a.statusCode, 202, a.body);
  const row = await serverRow(a.json().serverId);
  assert.equal(row.vdc_id, vdcId);
  assert.equal(Number(row.price_monthly), 0, 'no price of its own');
  assert.equal((await make('vdc-b', { vcpu: 1, memoryMb: 1536, diskGb: 10 })).json().fields.memoryMb, 'VDC_LIMIT');
  const b = await make('vdc-b', { vcpu: 1, memoryMb: 1024, diskGb: 20 });
  assert.equal(b.statusCode, 202, b.body);
  assert.equal((await make('vdc-c', { vcpu: 1, memoryMb: 512, diskGb: 10 })).json().code, 'VDC_LIMIT');
  assert.equal((await send('PUT', `/admin/vdcs/${vdcId}`, { name: 'Team A', vcpu: 1, memoryMb: 2048, diskGb: 40, maxServers: 2 })).json().fields.vcpu, 'VDC_BELOW_USAGE');

  for (const id of [a.json().serverId, b.json().serverId]) await until(async () => (await serverRow(id)).state === 'ready', 'ready');
  const bulk = await send('POST', `/vdcs/${vdcId}/actions`, { action: 'reset' }, user, { 'idempotency-key': randomUUID() });
  assert.equal(bulk.statusCode, 202, bulk.body);
  assert.equal(bulk.json().started.length, 2);
  assert.equal((await send('DELETE', `/admin/vdcs/${vdcId}`)).json().code, 'IN_USE');
  for (const id of [a.json().serverId, b.json().serverId]) {
    await until(async () => !(await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id])).rowCount, 'reset done');
    await send('DELETE', `/servers/${id}`, { confirm: (await serverRow(id)).name }, user, { 'idempotency-key': randomUUID() });
    await until(async () => (await serverRow(id)).state === 'deleted', 'deleted');
  }
  assert.equal((await send('DELETE', `/admin/vdcs/${vdcId}`)).statusCode, 204);
});

test('power schedules: validated, owned, limited per server; a due one starts the operation once', { skip }, async () => {
  const { runSchedules } = await import('../../dist/schedules.js');
  // A ready, idle server of the customer from the earlier tests (the small test IP range has no room for another).
  const { rows: [srv] } = await pool.query(`SELECT s.id, s.power_state FROM servers s JOIN users u ON u.id = s.owner_id WHERE u.email = 'user@example.test' AND s.state = 'ready' AND s.vdc_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) LIMIT 1`);
  assert.ok(srv, 'a ready server of the customer');
  const id = srv.id;
  const [first, second] = srv.power_state === 'poweredOn' ? ['shutdown', 'power_on'] : ['power_on', 'shutdown'];
  const path = `/servers/${id}/schedules`;
  assert.deepEqual(Object.keys((await send('POST', path, { action: 'reset', days: [], time: '9', timezone: 'Nowhere/X' }, user)).json().fields).sort(), ['action', 'days', 'time', 'timezone']);
  assert.equal((await send('GET', path, undefined, other)).statusCode, 404);
  // Due now in UTC: the action that changes the server's current power state.
  const now = new Date();
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const r = await send('POST', path, { action: first, days: [now.getUTCDay() || 7], time, timezone: 'UTC' }, user);
  assert.equal(r.statusCode, 201, r.body);
  const off = await send('POST', path, { action: second, days: [1, 2, 3, 4, 5], time: '08:00', timezone: 'Europe/Istanbul', enabled: false }, user);
  assert.equal((await send('GET', path, undefined, user)).json().schedules.length, 2);
  const before = (await pool.query('SELECT count(*)::int AS n FROM operations WHERE server_id = $1 AND kind = $2', [id, first])).rows[0].n;
  await runSchedules();
  assert.equal((await pool.query('SELECT last_result FROM power_schedules WHERE id = $1', [r.json().id])).rows[0].last_result, 'started');
  assert.equal((await lastOp(id)).kind, first);
  await runSchedules(); // a second tick within 10 minutes does nothing
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE server_id = $1 AND kind = $2', [id, first])).rows[0].n, before + 1);
  assert.equal((await pool.query('SELECT last_run_at FROM power_schedules WHERE id = $1', [off.json().id])).rows[0].last_run_at, null);
  for (const x of [r, off]) assert.equal((await send('DELETE', `${path}/${x.json().id}`, undefined, user)).statusCode, 204);
  await until(async () => (await lastOp(id)).status === 'succeeded', 'scheduled action done');

  // Admin bulk action back to the original state: staff only, one operation per server, a repeated key starts nothing new.
  const key = randomUUID();
  const bulk = (session) => send('POST', '/admin/servers/actions', { action: second, serverIds: [id, randomUUID()] }, session, { 'idempotency-key': key });
  assert.equal((await bulk(user)).statusCode, 403);
  assert.equal((await send('POST', '/admin/servers/actions', { action: 'explode', serverIds: [id] }, admin, { 'idempotency-key': randomUUID() })).statusCode, 400);
  assert.deepEqual((await bulk(admin)).json(), { started: 1, skipped: 1 });
  assert.deepEqual((await bulk(admin)).json(), { started: 0, skipped: 2 });
  await until(async () => (await lastOp(id)).kind === second && (await lastOp(id)).status === 'succeeded', 'bulk action done');
});

test('snapshots: taken, listed, reverted (power kept) and removed as operations; owner-only; the admin can turn them off', { skip }, async () => {
  const { rows: [srv] } = await pool.query(`SELECT s.id, s.power_state FROM servers s JOIN users u ON u.id = s.owner_id WHERE u.email = 'user@example.test' AND s.state = 'ready' AND s.vdc_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) LIMIT 1`);
  const id = srv.id, path = `/servers/${id}/snapshots`;
  const key = () => ({ 'idempotency-key': randomUUID() });
  const done = (kind) => until(async () => { const o = await lastOp(id); return o.kind === kind && o.status === 'succeeded'; }, `${kind} done`);
  assert.equal((await send('POST', path, { name: '-bad' }, user, key())).json().fields.name, 'INVALID_SNAPSHOT_NAME');
  assert.equal((await send('POST', '/ssh-keys/github', { username: 'bad_name!' }, user)).json().fields.username, 'INVALID_GITHUB_USER');
  assert.equal((await send('GET', path, undefined, other)).statusCode, 404);
  const made = await send('POST', path, { name: 'before upgrade', description: 'kernel 6.12' }, user, key());
  assert.equal(made.statusCode, 202, made.body);
  await done('snapshot_create');
  const list = (await send('GET', path, undefined, user)).json();
  assert.equal(list.max, 5);
  const snap = list.snapshots.find((s) => s.name === 'before upgrade');
  assert.ok(snap && snap.current && snap.description === 'kernel 6.12', JSON.stringify(list));
  assert.equal((await send('POST', `${path}/snapshot-999999/revert`, undefined, user, key())).statusCode, 202); // checked by VMware: fails as an operation
  await until(async () => (await lastOp(id)).status === 'failed', 'unknown snapshot fails');
  assert.equal((await lastOp(id)).error_code, 'SNAPSHOT_NOT_FOUND');
  assert.equal((await send('POST', `${path}/${snap.id}/revert`, undefined, user, key())).statusCode, 202);
  await done('snapshot_revert');
  assert.equal((await serverRow(id)).power_state, srv.power_state);
  await send('PUT', '/admin/settings/servers', { customer: { snapshots: false } });
  assert.equal((await send('DELETE', `${path}/${snap.id}`, undefined, user, key())).json().code, 'ACTION_DISABLED');
  await send('PUT', '/admin/settings/servers', { customer: { snapshots: true } });
  assert.equal((await send('DELETE', `${path}/${snap.id}`, undefined, user, key())).statusCode, 202);
  await done('snapshot_delete');
  assert.equal((await send('GET', path, undefined, user)).json().snapshots.some((s) => s.id === snap.id), false);
});
