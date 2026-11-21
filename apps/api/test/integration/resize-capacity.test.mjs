// What is counted across accounts when a server grows, against a real PostgreSQL and Redis (destructive, like the
// other files here: it wipes the test database and Redis DB): a location's free capacity and a reseller's allocation.
// What is checked: two servers of two accounts grown at the same moment cannot together take the location's last
// room, nor two customers' servers their reseller's (in two locations, so only the reseller's own lock keeps them
// apart); the refused one gets CAPACITY_EXHAUSTED or RESELLER_ALLOCATION_EXCEEDED, never a 500, and writes nothing;
// an accepted resize that is not finished counts with the size it grows to, in what staff and the reseller are shown
// and for the next resize, order and retry; a failed one gives the room back. The same for two orders of one
// reseller's customers in two locations, and for two extra disks of two accounts on a location's last storage.
// Nothing here builds or resizes a server: the locations are fixtures without a hypervisor behind them and no worker
// runs, so an accepted resize stays open (as in resize-quota).
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

// tight: 14 vCPU and no more (no overcommit, no headroom). wide and far: room for everything; wide sells extra disks.
let app, admin, a, b, reseller, resellerId, c1, c2, tight, wide, far, imageId, small, large;
const keys = {};
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const GiB = 2 ** 30;
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload, headers = {}) => app.inject({ method, url: path, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const post = (path, payload, cookie, headers) => call('POST', path, cookie, payload, headers);
const put = (path, payload, cookie) => call('PUT', path, cookie, payload);
const key = () => ({ 'idempotency-key': randomUUID() });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); };
const signUp = async (email) => {
  await freshLimits();
  const r = await post('/auth/sign-up/email', { name: '', email, password });
  const cookie = cookieOf(r), id = r.json().user.id;
  keys[cookie] = (await one("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'k', $2, $3) RETURNING id",
    [id, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixtureFix ${email}`, `fp-${email}`])).id;
  return [cookie, id];
};
let n = 0;
const order = (cookie, poolId, extra = {}) => post('/servers', { type: 'package', poolId, packageId: small, imageId, name: `c-${++n}`, sshKeyIds: [keys[cookie]], ...extra }, cookie, key());
// A small server (2 vCPU, 40 GB) that is built and idle, as far as the panel knows.
const built = async (cookie, poolId) => {
  const r = await order(cookie, poolId);
  assert.equal(r.statusCode, 202, r.body);
  const id = r.json().serverId;
  await pool.query("UPDATE servers SET state = 'ready', power_state = 'poweredOff', vm_moref = $2 WHERE id = $1", [id, `vm-${n}`]);
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE server_id = $1", [id]);
  return id;
};
// To the large package: 6 vCPU and 14 GB of memory more, the same disk (so no hypervisor is asked about snapshots).
const grow = (id, cookie) => post(`/servers/${id}/resize`, { type: 'package', packageId: large }, cookie, key());
const capacity = async (poolId) => (await get('/admin/pools', admin)).json().pools.find((p) => p.id === poolId).capacity;
const openResizes = async () => (await pool.query("SELECT id, server_id FROM operations WHERE kind = 'resize' AND status IN ('pending', 'running') ORDER BY created_at")).rows;
const codes = (answers) => answers.map((r) => (r.statusCode === 202 ? 202 : `${r.statusCode} ${r.json().code}`)).sort((x, y) => String(x).localeCompare(String(y)));
const untouched = async (id) => assert.deepEqual(await one('SELECT price_monthly::text AS p, package_id FROM servers WHERE id = $1', [id]), { p: '30.00', package_id: small });
// What the worker does when a resize fails for good: the operation is over and the server has its old package and price.
const fail = async (op) => {
  await pool.query("UPDATE operations SET status = 'failed', error_code = 'TASK_FAILED', finished_at = now() WHERE id = $1", [op.id]);
  await pool.query('UPDATE servers SET price_monthly = 30, package_id = $2 WHERE id = $1', [op.server_id, small]);
};

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
  // No account quota in the way: this file is about what is counted across accounts.
  await pool.query("UPDATE quotas SET max_servers = NULL, max_vcpu = NULL, max_memory_mb = NULL, max_disk_gb = NULL WHERE scope = 'default'");
  // Locations nobody can build on (see security-servers.test.mjs): the worker, if one runs, cannot read the password.
  const connectionId = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, product, write_api, operations)
    VALUES ($1, 'Fixture', 'vcenter', 'vc.example.test', 443, 'svc', $2, 'system', '{}', 'available', '{"cloneFromImage": true}')`, [connectionId, encryptSecret('pw', 'not-this-connection')]);
  imageId = (await one("INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('Public Debian', 'linux', $1, 'tpl-1') RETURNING id", [connectionId])).id;
  small = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('small', 2, 2048, 40, 30, 'TRY') RETURNING id")).id;
  large = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('large', 8, 16384, 40, 80, 'TRY') RETURNING id")).id;
  const location = async (i, name, cores, diskPrice) => {
    await pool.query(`INSERT INTO vmware_hosts (connection_id, moref, name, hardware_uuid, cpu_cores, memory_bytes, parent) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [connectionId, `host-${i}`, `esx${i}`, `hw-${i}`, cores, 2048 * GiB, `cluster-${i}`]);
    await pool.query(`INSERT INTO vmware_datastores (connection_id, moref, name, capacity_bytes, free_bytes, accessible) VALUES ($1, $2, $3, $4, $4, true)`, [connectionId, `ds-${i}`, `ds${i}`, 8000 * GiB]);
    const id = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref, cpu_overcommit, reserve_cpu_pct, storage_overcommit, reserve_storage_pct, extra_disk_price_gb)
      VALUES ($1, $2, $3, $4, 'net-1', 1, 0, 1, 0, $5) RETURNING id`, [name, connectionId, `cluster-${i}`, [`ds-${i}`], diskPrice])).id;
    await pool.query('INSERT INTO package_pools (package_id, pool_id) VALUES ($1, $3), ($2, $3)', [small, large, id]);
    await pool.query(`INSERT INTO ip_pools (name, pool_id, cidr, gateway, range_start, range_end) VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, id, `198.51.${i}.0/24`, `198.51.${i}.1`, `198.51.${i}.10`, `198.51.${i}.200`]);
    return id;
  };
  tight = await location(1, 'Tight', 14, null);
  wide = await location(2, 'Wide', 256, 0.1);
  far = await location(3, 'Far', 256, null);
  [a] = await signUp('a@example.test');
  [b] = await signUp('b@example.test');
  [reseller, resellerId] = await signUp('reseller@example.test');
  [c1] = await signUp('c1@example.test');
  [c2] = await signUp('c2@example.test');
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('two accounts grow a server each at once on a location with room for one: one is accepted, the other refused for capacity', async () => {
  // 14 vCPU in the location, two small servers of two accounts use 4: either may grow by 6, not both.
  const ofA = await built(a, tight), ofB = await built(b, tight);
  let cap = await capacity(tight);
  assert.deepEqual([cap.offered.vcpu, cap.reserved.vcpu, cap.available.vcpu], [14, 4, 10]);
  const answers = await Promise.all([grow(ofA, a), grow(ofB, b)]);
  assert.deepEqual(codes(answers), [202, '409 CAPACITY_EXHAUSTED'], answers.map((r) => r.body).join(' '));
  const [open, ...more] = await openResizes();
  assert.equal(more.length, 0, 'one open resize, none for the refused request');
  const [grown, refused, refusedCookie] = open.server_id === ofA ? [ofA, ofB, b] : [ofB, ofA, a];
  await untouched(refused);
  // The accepted growth is reserved before any worker has resized anything, and staff see the same figures.
  assert.equal((await one("SELECT sum(vcpu)::int AS n FROM servers WHERE pool_id = $1 AND state <> 'deleted'", [tight])).n, 4);
  cap = await capacity(tight);
  assert.deepEqual([cap.reserved.vcpu, cap.available.vcpu, cap.reserved.memoryMb], [10, 4, 2 * 2048 + 14336]);
  // So nothing else takes that room: not a later resize, not an order of 8 vCPU; one of 2 still fits.
  const later = await grow(refused, refusedCookie);
  assert.deepEqual([later.statusCode, later.json().code], [409, 'CAPACITY_EXHAUSTED'], later.body);
  const big = await order(a, tight, { packageId: large });
  assert.deepEqual([big.statusCode, big.json().code], [409, 'CAPACITY_EXHAUSTED'], big.body);
  // A second resize of the growing server is refused as an open operation, not for the capacity its own first one took.
  assert.equal((await grow(grown, refusedCookie === a ? b : a)).json().code, 'OPERATION_IN_PROGRESS');
  // The resize fails: the room is back, the other server takes it, and staff's retry of the failed one no longer fits.
  await fail(open);
  assert.equal((await capacity(tight)).available.vcpu, 10);
  assert.equal((await grow(refused, refusedCookie)).statusCode, 202);
  const retried = await post(`/admin/operations/${open.id}/retry`, undefined, admin);
  assert.deepEqual([retried.statusCode, retried.json().code], [409, 'CAPACITY_EXHAUSTED'], retried.body);
  assert.equal((await one('SELECT status FROM operations WHERE id = $1', [open.id])).status, 'failed');
  assert.equal((await capacity(tight)).available.vcpu, 4);
});

test('two customers of one reseller grow a server each at once, in two locations: the allocation is given once', async () => {
  // Built as accounts of their own, then the reseller's: 10 vCPU for the reseller, 4 used, each resize asks for 6.
  const first = await built(c1, wide), second = await built(c2, far);
  assert.equal((await put(`/admin/resellers/${resellerId}`, { maxCustomers: 5, maxServers: 10, maxVcpu: 10, discountPct: 0 }, admin)).statusCode, 200);
  await pool.query('UPDATE users SET reseller_id = $1 WHERE email IN ($2, $3)', [resellerId, 'c1@example.test', 'c2@example.test']);
  const used = async () => (await get('/reseller/summary', reseller)).json().usage;
  assert.equal((await used()).vcpu, 4);
  const answers = await Promise.all([grow(first, c1), grow(second, c2)]);
  assert.deepEqual(codes(answers), [202, '409 RESELLER_ALLOCATION_EXCEEDED'], answers.map((r) => r.body).join(' '));
  assert.deepEqual(answers.find((r) => r.statusCode === 409).json().fields, { vcpu: 'RESELLER_ALLOCATION_EXCEEDED' });
  const open = (await openResizes()).filter((o) => [first, second].includes(o.server_id));
  assert.equal(open.length, 1);
  const [refused, refusedCookie] = open[0].server_id === first ? [second, c2] : [first, c1];
  await untouched(refused);
  // The reseller and staff see the accepted growth as used; the rows still say 2 vCPU each.
  assert.deepEqual([(await used()).vcpu, (await used()).memoryMb], [10, 2 * 2048 + 14336]);
  assert.equal((await get('/admin/resellers', admin)).json().resellers.find((r) => r.id === resellerId).usage.vcpu, 10);
  assert.equal((await grow(refused, refusedCookie)).json().code, 'RESELLER_ALLOCATION_EXCEEDED');
  // Failed: the allocation is free again, the other customer takes it, and the retry is refused by the allocation.
  await fail(open[0]);
  assert.equal((await used()).vcpu, 4);
  assert.equal((await grow(refused, refusedCookie)).statusCode, 202);
  const retried = await post(`/admin/operations/${open[0].id}/retry`, undefined, admin);
  assert.deepEqual([retried.statusCode, retried.json().code], [409, 'RESELLER_ALLOCATION_EXCEEDED'], retried.body);
  assert.equal((await one('SELECT status FROM operations WHERE id = $1', [open[0].id])).status, 'failed');
});

test('two customers of one reseller order at once in two locations: the reseller\'s last server is given once', async () => {
  const servers = (await one(`SELECT count(*)::int AS n FROM servers s JOIN users u ON u.id = s.owner_id WHERE u.reseller_id = $1 AND s.state <> 'deleted'`, [resellerId])).n;
  assert.equal((await put(`/admin/resellers/${resellerId}`, { maxCustomers: 5, maxServers: servers + 1, maxVcpu: null, discountPct: 0 }, admin)).statusCode, 200);
  const answers = await Promise.all([order(c1, wide), order(c2, far)]);
  assert.deepEqual(codes(answers), [202, '409 RESELLER_ALLOCATION_EXCEEDED'], answers.map((r) => r.body).join(' '));
  assert.equal((await get('/reseller/summary', reseller)).json().usage.servers, servers + 1);
});

test('two accounts add a disk each at once on a location with storage for one: one is added, the other refused for capacity', async () => {
  const ofA = await built(a, wide), ofB = await built(b, wide);
  // Room for 150 GB more: either disk of 100 GB fits, not both.
  const { reserved } = await capacity(wide);
  await pool.query("UPDATE vmware_datastores SET capacity_bytes = $1, free_bytes = $1 WHERE moref = 'ds-2'", [(reserved.diskGb + 150) * GiB]);
  assert.equal((await capacity(wide)).available.storageGb, 150);
  const answers = await Promise.all([post(`/servers/${ofA}/disks`, { sizeGb: 100 }, a), post(`/servers/${ofB}/disks`, { sizeGb: 100 }, b)]);
  assert.deepEqual(codes(answers), [202, '409 CAPACITY_EXHAUSTED'], answers.map((r) => r.body).join(' '));
  assert.equal((await one('SELECT count(*)::int AS n FROM server_disks WHERE server_id = ANY($1)', [[ofA, ofB]])).n, 1);
  assert.equal((await capacity(wide)).available.storageGb, 50);
});
