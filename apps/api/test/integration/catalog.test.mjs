// Resource pools, images, packages, custom rules, IP pools, quotas and projects, on top of the
// simulated vCenter's inventory (compose.simulator.yaml). Destructive: wipes the *_test database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
const vcenter = process.env.VCSIM_VCENTER;
const skip = !vcenter || !process.env.VMWARE_SERVICE_URL ? 'needs VCSIM_VCENTER and VMWARE_SERVICE_URL (compose.simulator.yaml)' : false;
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');

let app, admin, user, other, connectionId, cluster, datastores, network, poolId, imageId, packageId;
const password = 'correct horse battery staple';
const send = (method, path, payload, session = admin) => app.inject({
  method, url: path, payload, headers: { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost', ...(session && { cookie: `lvm.session_token=${session}` }) } });
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm\.session_token=([^;]+)/)?.[1];

before(async () => {
  if (skip) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  admin = cookieOf(await send('POST', '/setup/admin', { token, email: 'admin@example.test', password }, null));
  await send('PUT', '/admin/settings', { registrationOpen: true });
  user = cookieOf(await send('POST', '/auth/sign-up/email', { name: '', email: 'user@example.test', password }, null));
  other = cookieOf(await send('POST', '/auth/sign-up/email', { name: '', email: 'other@example.test', password }, null));
  const target = { name: 'Sim', host: vcenter, port: 8989, username: 'sim-admin', password: 'sim-password-1' };
  const pin = (await send('POST', '/admin/vmware/test', { ...target, tls: { mode: 'system' } })).json().certificate.sha256;
  connectionId = (await send('POST', '/admin/vmware/connections', { ...target, tls: { mode: 'pinned', sha256: pin } })).json().id;
  cluster = (await pool.query("SELECT moref FROM vmware_compute WHERE connection_id = $1 AND kind = 'cluster'", [connectionId])).rows[0].moref;
  datastores = (await pool.query('SELECT moref FROM vmware_datastores WHERE connection_id = $1', [connectionId])).rows.map((r) => r.moref);
  network = (await pool.query('SELECT moref FROM vmware_networks WHERE connection_id = $1 LIMIT 1', [connectionId])).rows[0].moref;
});
after(async () => { await app?.close(); await closeConnections(); });

test('a resource pool only references discovered inventory and shows capacity layers separately', { skip }, async () => {
  const bad = await send('POST', '/admin/pools', { name: 'P', connectionId, computeMoref: 'domain-c999', datastoreMorefs: ['datastore-999'], networkMoref: 'network-999', cpuOvercommit: 50 });
  assert.deepEqual(bad.json().fields, { cpuOvercommit: 'OUT_OF_RANGE' });
  const missing = await send('POST', '/admin/pools', { name: 'P', connectionId, computeMoref: 'domain-c999', datastoreMorefs: ['datastore-999'], networkMoref: 'network-999' });
  assert.deepEqual(missing.json().fields, { computeMoref: 'NOT_IN_INVENTORY', networkMoref: 'NOT_IN_INVENTORY', datastoreMorefs: 'NOT_IN_INVENTORY' });
  const res = await send('POST', '/admin/pools', { name: 'Simulated cluster', location: 'Lab', connectionId, computeMoref: cluster, datastoreMorefs: datastores,
    networkMoref: network, cpuOvercommit: 4, memoryOvercommit: 1, storageOvercommit: 1.5, reserveCpuPct: 10, reserveMemoryPct: 10, reserveStoragePct: 15 });
  assert.equal(res.statusCode, 201, res.body);
  poolId = res.json().id;
  const [p] = (await send('GET', '/admin/pools')).json().pools;
  const c = p.capacity;
  assert.ok(c.physical.cores > 0 && c.physical.memoryMb > 0 && c.physical.storageGb > 0);
  assert.equal(c.offered.vcpu, Math.floor((c.physical.cores - c.headroom.cores) * 4), 'CPU overcommit applies to CPU only');
  assert.equal(c.offered.memoryMb, c.physical.memoryMb - c.headroom.memoryMb, 'memory is not overcommitted here');
  assert.deepEqual(c.reserved, { vcpu: 0, memoryMb: 0, diskGb: 0 }, 'nothing reserved before provisioning exists');
});

test('custom rules are validated as a whole', { skip }, async () => {
  const bad = await send('PUT', `/admin/pools/${poolId}/custom-rule`, { cpuMin: 8, cpuMax: 2, memoryMinMb: 1024, memoryMaxMb: 65536, diskMinGb: 20, diskMaxGb: 500,
    priceVcpu: '5', priceMemoryGb: '2', priceDiskGb: 'abc', currency: 'eur' });
  assert.deepEqual(bad.json().fields, { cpuMax: 'MIN_ABOVE_MAX', priceDiskGb: 'INVALID_AMOUNT', currency: 'INVALID_CURRENCY' });
  const ok = await send('PUT', `/admin/pools/${poolId}/custom-rule`, { cpuMin: 1, cpuMax: 16, cpuStep: 1, memoryMinMb: 1024, memoryMaxMb: 65536, memoryStepMb: 1024,
    diskMinGb: 20, diskMaxGb: 500, diskStepGb: 10, minMemoryMbPerVcpu: 1024, maxMemoryMbPerVcpu: 8192, priceVcpu: '5.00', priceMemoryGb: '2.0000', priceDiskGb: '0.10', currency: 'EUR' });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('images must be templates from the inventory', { skip }, async () => {
  const { rows: [vm] } = await pool.query('SELECT moref FROM vmware_vms WHERE connection_id = $1 LIMIT 1', [connectionId]);
  const notTemplate = await send('POST', '/admin/images', { name: 'Ubuntu', family: 'linux', connectionId, templateMoref: vm.moref });
  assert.deepEqual(notTemplate.json().fields, { templateMoref: 'NOT_A_TEMPLATE' });
  // The simulator has no templates; mark one in the discovered inventory (simulated data).
  await pool.query('UPDATE vmware_vms SET template = true WHERE connection_id = $1 AND moref = $2', [connectionId, vm.moref]);
  const res = await send('POST', '/admin/images', { name: 'Ubuntu 24.04', family: 'linux', connectionId, templateMoref: vm.moref, minDiskGb: 30 });
  assert.equal(res.statusCode, 201, res.body);
  imageId = res.json().id;
});

test('packages keep money as decimals and need at least one pool', { skip }, async () => {
  const bad = await send('POST', '/admin/packages', { name: 'S', vcpu: 0, memoryMb: 2048, diskGb: 40, priceMonthly: '1e3', currency: 'EUR', poolIds: [] });
  assert.deepEqual(bad.json().fields, { vcpu: 'OUT_OF_RANGE', priceMonthly: 'INVALID_AMOUNT', poolIds: 'REQUIRED' });
  const res = await send('POST', '/admin/packages', { name: 'Small', vcpu: 2, memoryMb: 4096, diskGb: 40, priceMonthly: '12.10', priceHourly: '0.0168', currency: 'EUR', poolIds: [poolId], imageIds: [imageId] });
  assert.equal(res.statusCode, 201, res.body);
  packageId = res.json().id;
  const [p] = (await send('GET', '/admin/packages')).json().packages;
  assert.deepEqual([p.priceMonthly, p.priceHourly, p.poolIds, p.imageIds], ['12.10', '0.0168', [poolId], [imageId]]);
  assert.equal((await send('POST', '/admin/packages', { name: 'Small', vcpu: 1, memoryMb: 1024, diskGb: 20, priceMonthly: '1', currency: 'EUR', poolIds: [poolId] })).json().fields.name, 'NAME_TAKEN');
});

test('IP pools stay inside their subnet and never overlap, even when created concurrently', { skip }, async () => {
  const base = { poolId, cidr: '10.20.0.0/24', gateway: '10.20.0.1', dns: ['10.20.0.53'] };
  const outside = await send('POST', '/admin/ip-pools', { ...base, name: 'bad', rangeStart: '10.20.0.10', rangeEnd: '10.20.1.20' });
  assert.equal(outside.json().fields.range, 'IP_OUTSIDE_SUBNET');
  const notIp = await send('POST', '/admin/ip-pools', { ...base, name: 'bad', rangeStart: 'ten', rangeEnd: '10.20.0.20' });
  assert.equal(notIp.json().fields.cidr, 'INVALID_ADDRESS');
  const results = await Promise.all(['a', 'b', 'c'].map((n, i) =>
    send('POST', '/admin/ip-pools', { ...base, name: `lan-${n}`, rangeStart: `10.20.0.${10 + i}`, rangeEnd: '10.20.0.100', excluded: ['10.20.0.50'] })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409]);
  const [ip] = (await send('GET', '/admin/ip-pools')).json().ipPools;
  assert.equal(ip.size, 100 - Number(ip.rangeStart.split('.')[3]) + 1 - 1, 'size excludes the excluded address');
  assert.equal((await send('DELETE', `/admin/pools/${poolId}`)).json().code, 'IN_USE', 'a pool with IP pools cannot be removed');
  assert.equal((await send('DELETE', `/admin/vmware/connections/${connectionId}`)).json().code, 'IN_USE', 'a connection with pools cannot be removed');
});

test('admin catalog endpoints are admin-only', { skip }, async () => {
  for (const [m, p] of [['GET', '/admin/pools'], ['POST', '/admin/packages'], ['PUT', '/admin/quotas/default'], ['GET', '/admin/ip-pools']]) {
    assert.equal((await send(m, p, {}, user)).statusCode, 403, p);
  }
});

test('projects belong to their owner; another user cannot delete them by id', { skip }, async () => {
  const p = (await send('POST', '/projects', { name: 'Web' }, user)).json();
  assert.equal((await send('POST', '/projects', { name: 'Web' }, user)).json().fields.name, 'NAME_TAKEN');
  assert.equal((await send('DELETE', `/projects/${p.id}`, undefined, other)).statusCode, 404);
  assert.deepEqual((await send('GET', '/projects', undefined, other)).json().projects, []);
  assert.equal((await send('DELETE', `/projects/${p.id}`, undefined, user)).statusCode, 204);
});

test('quotes validate custom shapes, price them exactly and apply quotas', { skip }, async () => {
  const catalog = (await send('GET', '/catalog', undefined, user)).json();
  assert.deepEqual(catalog.packages.map((p) => p.name), ['Small']);
  assert.equal(catalog.pools[0].custom.currency, 'EUR');
  assert.doesNotMatch(JSON.stringify(catalog), /cpu_overcommit|reserve_|moref/i, 'no infrastructure internals to customers');

  const pkg = (await send('POST', '/catalog/quote', { type: 'package', packageId, poolId, imageId }, user)).json();
  assert.deepEqual([pkg.price, pkg.quota.exceeded], [{ monthly: '12.10', currency: 'EUR' }, []]);
  // Simulated hosts are small; whether 2 vCPU / 4 GB fits must follow the pool's own available figures.
  const { available } = (await send('GET', '/admin/pools')).json().pools[0].capacity;
  assert.equal(pkg.capacityAvailable, available.vcpu >= 2 && available.memoryMb >= 4096 && available.storageGb >= 40);

  const step = await send('POST', '/catalog/quote', { type: 'custom', poolId, vcpu: 2, memoryMb: 4000, diskGb: 45 }, user);
  assert.deepEqual(step.json().fields, { memoryMb: 'INVALID_STEP', diskGb: 'INVALID_STEP' });
  const ratio = await send('POST', '/catalog/quote', { type: 'custom', poolId, vcpu: 1, memoryMb: 16384, diskGb: 40 }, user);
  assert.deepEqual(ratio.json().fields, { memoryMb: 'RATIO_NOT_ALLOWED' });
  const small = await send('POST', '/catalog/quote', { type: 'custom', poolId, imageId, vcpu: 2, memoryMb: 4096, diskGb: 20 }, user);
  assert.deepEqual(small.json().fields, { diskGb: 'BELOW_IMAGE_MINIMUM' });
  // 3 x 5.00 + 6 GB x 2.00 + 70 GB x 0.10 = 15 + 12 + 7 = 34.00, computed as numeric
  const custom = (await send('POST', '/catalog/quote', { type: 'custom', poolId, imageId, vcpu: 3, memoryMb: 6144, diskGb: 70 }, user)).json();
  assert.deepEqual(custom.price, { monthly: '34.00', currency: 'EUR' });

  const uid = (await pool.query("SELECT id FROM users WHERE email = 'user@example.test'")).rows[0].id;
  await send('PUT', `/admin/quotas/users/${uid}`, { maxServers: 10, maxVcpu: 2, maxMemoryMb: null, maxDiskGb: 50 });
  const capped = (await send('POST', '/catalog/quote', { type: 'custom', poolId, vcpu: 3, memoryMb: 6144, diskGb: 70 }, user)).json();
  assert.deepEqual(capped.quota.exceeded, ['vcpu', 'diskGb']);
  assert.equal(capped.quota.limits.max_memory_mb, null, 'null limit is unlimited');
  const otherQuote = (await send('POST', '/catalog/quote', { type: 'custom', poolId, vcpu: 3, memoryMb: 6144, diskGb: 70 }, other)).json();
  assert.deepEqual(otherQuote.quota.exceeded, [], 'other users keep the default quota');
});
