// The adapter against a small pretend Incus server (an in-memory API), and its client against a real TLS server
// that asks for a client certificate. test/fixtures holds a throwaway self-signed pair made for these tests only.
// The pretend server copies what a real Incus 6.0 did when the adapter ran against one: a PATCH without a
// description empties it and so does a restore, a snapshot holds the configuration and the devices, and a volume's
// name is taken once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

process.env.INCUS_ALLOW_NETWORKS = '127.0.0.0/8'; // the pretend server listens on loopback
const h = await import('../handlers.mjs');
const { handler } = await import('../server.mjs');
const { apiFailure, connect, Failure, identity, operationFailure } = await import('../incus.mjs');

const CERT = readFileSync(new URL('./fixtures/test-only.crt', import.meta.url), 'utf8'), KEY = readFileSync(new URL('./fixtures/test-only.key', import.meta.url), 'utf8');
const GIB = 1024 ** 3;
const FP = 'ab12'.repeat(16), SERVER = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f', NAME = `lvm-${SERVER}`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function incus({ clustered = false } = {}) {
  let n = 100;
  const db = { ops: {}, volumes: {}, snaps: {}, instances: [{ name: 'someone-else', type: 'container', status: 'Running', location: 'none', description: '', architecture: 'x86_64', profiles: ['default'], ephemeral: false, stateful: false,
      config: { 'volatile.uuid': uuid(2), 'image.os': 'Debian', 'image.release': 'bookworm' }, devices: {}, expanded_config: { 'limits.cpu': '0-1', 'limits.memory': '1GiB' }, expanded_devices: { root: { type: 'disk', path: '/', pool: 'default', size: '10GiB' }, eth0: { type: 'nic', network: 'incusbr0', name: 'eth0' } },
      last_used_at: '2020-01-01T00:00:00Z' }],
    images: [{ fingerprint: FP, type: 'virtual-machine', size: 400e6, aliases: [{ name: 'ubuntu-24' }], properties: { os: 'Ubuntu', release: 'noble', description: 'Ubuntu 24.04 cloud' } },
      { fingerprint: 'cd34'.repeat(16), type: 'container', size: 100e6, aliases: [], properties: { os: 'Alpine', release: '3.20', description: 'Alpine 3.20' } }] };
  const calls = [];
  const nf = () => { throw apiFailure(404, 'Not Found'); };
  const inst = (name) => db.instances.find((i) => i.name === name) ?? nf();
  const op = (fn) => { const id = uuid(++n); db.ops[id] = { id, status: 'Running', status_code: 103, err: '', run: fn }; return { ...db.ops[id], run: undefined }; };
  const finish = (id) => { const o = db.ops[id]; try { o.run?.(); o.status = 'Success'; o.status_code = 200; } catch (e) { o.status = 'Failure'; o.status_code = 400; o.err = e.message; } };
  const withState = (i) => ({ ...i, expanded_config: { ...i.expanded_config, ...i.config }, expanded_devices: { ...i.expanded_devices, ...i.devices },
    state: { status: i.status, started_at: i.started, memory: { usage: i.status === 'Running' ? 512 * 1024 * 1024 : 0 }, disk: { root: { usage: 3 * GIB } },
      network: i.status === 'Running' && i.agent !== false ? { lo: { addresses: [{ family: 'inet', address: '127.0.0.1', scope: 'local' }] }, eth0: { hwaddr: '00:16:3e:00:00:01', addresses: [{ family: 'inet', address: '203.0.113.20', scope: 'global' }, { family: 'inet6', address: 'fe80::1', scope: 'link' }] } } : null } });
  const plain = (i) => { const { state: _s, ...rest } = withState(i); return rest; };
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const [p, q = ''] = path.split('?');
    let m;
    if (p === '/1.0/resources') return { cpu: { total: 16, sockets: [{ cores: 8, frequency: 2400, frequency_turbo: 3600, name: 'Test CPU', vendor: 'Test' }] }, memory: { total: 64 * GIB, used: 24 * GIB } };
    if (p === '/1.0/cluster/members') return [{ server_name: 'node1', status: 'Online' }, { server_name: 'node2', status: 'Offline' }];
    if (p === '/1.0/storage-pools') return [{ name: 'default', driver: 'zfs', status: 'Created' }];
    if (p === '/1.0/storage-pools/default/resources') return { space: { total: 1000 * GIB, used: 200 * GIB } };
    if (p === '/1.0/storage-pools/default') return { name: 'default' };
    if (p === '/1.0/networks' && method === 'GET') return [{ name: 'incusbr0', type: 'bridge', managed: true }, { name: 'lo', type: 'loopback', managed: false }, { name: 'eno1', type: 'physical', managed: false }];
    if (p === '/1.0/networks/incusbr0') return { name: 'incusbr0' };
    if (p === '/1.0/images') return db.images;
    if ((m = /^\/1\.0\/images\/([0-9a-f]+)$/.exec(p))) return db.images.find((i) => i.fingerprint === m[1]) ?? nf();
    if ((m = /^\/1\.0\/operations\/([0-9a-f-]+)(\/wait)?$/.exec(p))) { const o = db.ops[m[1]] ?? nf(); if (m[2]) finish(m[1]); return { ...o, run: undefined }; }
    if (p === '/1.0/instances' && method === 'GET') return db.instances.map(q.includes('recursion=2') ? withState : plain);
    if (p === '/1.0/instances' && method === 'POST') {
      if (db.instances.some((i) => i.name === body.name)) throw apiFailure(409, `Instance "${body.name}" already exists`);
      return op(() => { if (body.devices.root.size === '9999GiB') throw new Error('Failed creating instance: not enough space on the pool'); db.instances.push({ name: body.name, type: body.type, status: 'Stopped', location: 'none', description: body.description,
        architecture: 'x86_64', profiles: ['default'], ephemeral: false, stateful: false, config: { ...body.config, 'volatile.uuid': uuid(++n), 'volatile.eth0.hwaddr': '00:16:3E:00:00:01', 'image.os': 'Ubuntu', 'image.release': 'noble' }, devices: body.devices, expanded_config: {}, expanded_devices: {}, last_used_at: '1970-01-01T00:00:00Z' }); });
    }
    if ((m = /^\/1\.0\/instances\/([^/]+)$/.exec(p))) {
      const i = inst(m[1]);
      if (method === 'GET') return q.includes('recursion=1') ? withState(i) : plain(i);
      if (method === 'PATCH') { Object.assign(i.config, body.config ?? {}); Object.assign(i.devices, body.devices ?? {}); i.description = body.description ?? ''; return null; }
      if (method === 'PUT') return op(() => {
        if (body.restore) { const s = db.snaps[i.name]?.find((x) => x.name === `${i.name}/${body.restore}`); if (!s) throw new Error('Snapshot not found'); if (i.status === 'Running') db.restoredRunning = true;
          db.restored = body.restore; i.config = structuredClone(s.config); i.devices = structuredClone(s.devices); i.description = ''; return; }
        if (i.status === 'Running' && i.busy) throw new Error('device is busy'); i.config = body.config; i.devices = body.devices; i.description = body.description; });
      if (method === 'POST') return op(() => { i.name = body.name; });
      if (method === 'DELETE') return op(() => { if (i.status === 'Running') throw new Error('Instance is running'); db.instances = db.instances.filter((x) => x !== i); });
    }
    if ((m = /^\/1\.0\/instances\/([^/]+)\/state$/.exec(p))) { const i = inst(m[1]); return op(() => { if (body.action === 'stop') i.status = 'Stopped'; else { i.status = 'Running'; i.started = new Date().toISOString(); } }); }
    if ((m = /^\/1\.0\/instances\/([^/]+)\/snapshots$/.exec(p))) { const i = inst(m[1]), list = (db.snaps[i.name] ??= []);
      if (method === 'GET') return list.map(({ config: _c, devices: _d, ...s }) => s); return op(() => { list.push({ name: `${i.name}/${body.name}`, created_at: '2024-01-01T10:00:00Z', stateful: false, config: structuredClone(i.config), devices: structuredClone(i.devices) }); }); }
    if ((m = /^\/1\.0\/instances\/([^/]+)\/snapshots\/([^/]+)$/.exec(p))) { const i = inst(m[1]); return op(() => { db.snaps[i.name] = db.snaps[i.name].filter((s) => s.name !== `${i.name}/${m[2]}`); }); }
    if (p === '/1.0/storage-pools/default/volumes/custom' && method === 'GET') return Object.keys(db.volumes).map((v) => `/1.0/storage-pools/default/volumes/custom/${v}`);
    if (p === '/1.0/storage-pools/default/volumes/custom' && method === 'POST') { if (body.config.size === '9999GiB') throw new Failure('INCUS_ERROR', 'not enough space left on the pool');
      if (db.volumes[body.name]) throw apiFailure(409, 'Volume by that name already exists'); db.volumes[body.name] = body; return null; }
    if ((m = /^\/1\.0\/storage-pools\/default\/volumes\/custom\/([^/]+)$/.exec(p)) && method === 'DELETE') { if (!db.volumes[m[1]]) nf(); delete db.volumes[m[1]]; return null; }
    if (/^\/1\.0\/(storage-pools|networks)\/[^/]+$/.test(p) && method === 'GET') nf();
    throw new Error(`fake incus: ${method} ${path}`);
  };
  api.server = { api_version: '1.0', auth: 'trusted', api_extensions: ['cloud_init', 'instance_state_started_at'], environment: { server: 'incus', server_version: '6.0.4', server_name: 'incus01', server_clustered: clustered, certificate_fingerprint: 'f'.repeat(64) } };
  api.project = 'default';
  return { api, db, calls, inst };
}
const order = { name: NAME, serverId: SERVER, template: `image-${FP}`, pool: 'default', datastore: 'default', network: 'incusbr0', vcpu: 4, memoryMb: 4096, diskGb: 40,
  metadata: JSON.stringify({ 'local-hostname': 'web1', network: { version: 2, ethernets: { nic0: { match: { name: 'e*' }, addresses: ['203.0.113.20/24'] } } } }), userdata: '#cloud-config\nhostname: web1\n' };
async function created(f, o = order) {
  const c = await h.clone(f.api, o); let t;
  for (let i = 0; i < 3 && (t = await h.task(f.api, { task: c.task })).state === 'running'; i++) await f.api('GET', `/1.0/operations/${c.task.split('|')[0]}/wait`);
  return { task: c.task, ...t };
}

test('sizes and CPU sets are read the way Incus writes them', () => {
  assert.deepEqual(['4GiB', '4096MiB', '2GB', '1048576', '', 'lots'].map(h.bytes), [4 * GIB, 4 * GIB, 2e9, 1048576, 0, 0]);
  assert.deepEqual(['4', '0-3', '0,2,4', '0-1,8-9', ''].map(h.cpus), [4, 4, 3, 4, 0]);
});

test('network settings are rewritten for images whose cloud-init reads them itself', () => {
  const panel = { version: 2, ethernets: { nic0: { match: { name: 'e*' }, addresses: ['203.0.113.20/24', '2001:db8::20/64'], routes: [{ to: 'default', via: '203.0.113.1' }, { to: '::/0', via: '2001:db8::1', 'on-link': true }, { to: '10.0.0.0/8', via: '203.0.113.2' }],
    nameservers: { addresses: ['1.1.1.1'] } } } };
  const before = JSON.stringify(panel);
  const container = h.guestNetwork(panel, false).ethernets;
  assert.deepEqual(container, { eth0: { addresses: ['203.0.113.20/24', '2001:db8::20/64'], routes: [{ to: '0.0.0.0/0', via: '203.0.113.1' }, { to: '10.0.0.0/8', via: '203.0.113.2' }], gateway6: '2001:db8::1', nameservers: { addresses: ['1.1.1.1'] } } });
  // A virtual machine's interface has another name (enp5s0): the match stays.
  assert.deepEqual(Object.entries(h.guestNetwork(panel, true).ethernets).map(([k, v]) => [k, v.match, v.gateway6, v.routes[0].to]), [['nic0', { name: 'e*' }, '2001:db8::1', '0.0.0.0/0']]);
  assert.equal(JSON.stringify(panel), before, 'what the panel sent is left alone');
  assert.deepEqual(h.guestNetwork({ version: 2 }, false), { version: 2 });
});

test('discovery describes the server, its pools, networks, instances and images', async () => {
  const d = await h.discover(incus().api);
  assert.equal(d.product.kind, 'incus'); assert.equal(d.product.fullName, 'Incus 6.0.4'); assert.equal(d.product.instanceUuid, 'f'.repeat(64));
  assert.deepEqual(d.hosts.map((x) => [x.moref, x.cpuCores, x.cpuThreads, x.cpuMhz, x.memoryBytes, x.parent]), [['incus01', 8, 16, 3600, 64 * GIB, 'incus']]);
  assert.deepEqual(d.compute, [{ moref: 'incus', name: 'incus01', kind: 'standalone', hosts: 1, effectiveCpuMhz: 28800, effectiveMemoryMb: 65536, resourcePool: 'default' }]);
  assert.deepEqual(d.datastores.map((x) => [x.moref, x.type, x.capacityBytes, x.freeBytes]), [['default', 'zfs', 1000 * GIB, 800 * GIB]]);
  assert.deepEqual(d.networks, [{ moref: 'incusbr0', name: 'incusbr0', kind: 'standard', vlan: null, switch: 'bridge' }]);
  assert.deepEqual(d.vms.map((v) => [v.moref, v.name, v.template, v.cpu, v.memoryMb, v.guest]), [[uuid(2), 'someone-else', false, 2, 1024, 'Debian bookworm (container)'],
    [`image-${FP}`, 'ubuntu-24', true, 0, 0, 'Ubuntu noble (VM)'], [`image-${'cd34'.repeat(16)}`, 'Alpine 3.20', true, 0, 0, 'Alpine 3.20 (container)']]);
  const c = await h.discover(incus({ clustered: true }).api);
  assert.deepEqual(c.hosts.map((x) => [x.moref, x.connectionState, x.memoryBytes]), [['node1', 'connected', 64 * GIB], ['node2', 'disconnected', 0]]);
  assert.equal(c.compute[0].kind, 'cluster');
});

test('a server is created from an image with its cloud-init data, and the task follows the operation', async () => {
  const f = incus();
  const c = await h.clone(f.api, order);
  assert.match(c.task, new RegExp(`^[0-9a-f-]{36}\\|${NAME}$`));
  assert.deepEqual(await h.task(f.api, { task: c.task }), { state: 'running' });
  await f.api('GET', `/1.0/operations/${c.task.split('|')[0]}/wait`);
  const done = await h.task(f.api, { task: c.task });
  assert.equal(done.state, 'success');
  const i = f.inst(NAME);
  assert.equal(i.type, 'virtual-machine'); assert.equal(i.description, `Managed by Lightning VM (server ${SERVER})`);
  assert.deepEqual([i.config['limits.cpu'], i.config['limits.memory'], i.config['user.lvm-server'], i.config['user.lvm-ips']], ['4', '4096MiB', SERVER, '203.0.113.20']);
  assert.equal(i.config['cloud-init.user-data'], order.userdata);
  assert.deepEqual(JSON.parse(i.config['cloud-init.network-config']).ethernets.nic0.addresses, ['203.0.113.20/24']);
  assert.deepEqual(i.devices, { root: { type: 'disk', path: '/', pool: 'default', size: '40GiB' }, eth0: { type: 'nic', network: 'incusbr0', name: 'eth0' }, 'cloud-init': { type: 'disk', source: 'cloud-init:config' } });
  assert.deepEqual(await h.clone(f.api, order), { vm: done.vm, existed: true });
  // Incus has forgotten the operation: the instance answers for it.
  delete f.db.ops[c.task.split('|')[0]];
  assert.deepEqual(await h.task(f.api, { task: c.task }), { state: 'success', vm: done.vm });
  assert.deepEqual(await h.task(f.api, { task: `${uuid(999)}|lvm-never` }), { state: 'unknown', code: 'TASK_NOT_FOUND' });

  const full = await created(incus(), { ...order, diskGb: 9999 });
  assert.equal(full.state, 'error'); assert.equal(full.code, 'INSUFFICIENT_RESOURCES');
  const box = incus(); await created(box, { ...order, template: `image-${'cd34'.repeat(16)}`, nestedHv: true });
  assert.equal(box.inst(NAME).type, 'container'); assert.equal(box.inst(NAME).config['security.nesting'], 'true'); assert.equal(box.inst(NAME).devices['cloud-init'], undefined);
  const old = incus(); old.api.server.api_extensions = []; await created(old);
  assert.equal(old.inst(NAME).config['user.user-data'], order.userdata); assert.equal(old.inst(NAME).config['cloud-init.user-data'], undefined);
  await assert.rejects(h.clone(f.api, { ...order, name: 'lvm-other', template: `image-${'00'.repeat(32)}` }), { code: 'TEMPLATE_NOT_FOUND' });
  await assert.rejects(h.clone(f.api, { ...order, name: 'lvm-other', datastore: 'nope' }), { code: 'DATASTORE_NOT_FOUND' });
  await assert.rejects(h.clone(f.api, { ...order, name: 'lvm-other', network: 'nope' }), { code: 'NETWORK_NOT_FOUND' });
  await assert.rejects(h.clone(f.api, { ...order, name: 'lvm-under_score' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.clone(f.api, { ...order, customization: 'appliance' }), { code: 'PROVISIONING_NOT_SUPPORTED' });
});

test('power, readiness and deletion', async () => {
  const f = incus(), { vm } = await created(f);
  assert.deepEqual((await h.find(f.api, { name: NAME })).vm, { moref: vm, name: NAME, powerState: 'poweredOff', toolsRunning: false, ips: [], serverId: SERVER });
  assert.deepEqual(await h.find(f.api, { name: 'lvm-none' }), { vm: null });
  assert.deepEqual(await h.powerAction(f.api, { vm, action: 'on' }), { task: '' });
  const before = f.calls.length; await h.powerAction(f.api, { vm, action: 'on' });
  assert.ok(!f.calls.slice(before).some((c) => c.startsWith('PUT')), 'a running server is not started again');
  assert.deepEqual((await h.find(f.api, { name: NAME })).vm, { moref: vm, name: NAME, powerState: 'poweredOn', toolsRunning: true, ips: ['203.0.113.20'], serverId: SERVER });
  // A container has an address of its own before cloud-init has set the given one: not ready yet.
  f.inst(NAME).config['user.lvm-ips'] = '203.0.113.99';
  assert.deepEqual((await h.find(f.api, { name: NAME })).vm, { moref: vm, name: NAME, powerState: 'poweredOn', toolsRunning: false, ips: ['203.0.113.20'], serverId: SERVER });
  f.inst(NAME).config['user.lvm-ips'] = '203.0.113.20';
  // No agent in the guest: not ready at first, ready with the given addresses after four minutes.
  f.inst(NAME).agent = false;
  assert.equal((await h.find(f.api, { name: NAME })).vm.toolsRunning, false);
  f.inst(NAME).started = new Date(Date.now() - 300_000).toISOString();
  assert.deepEqual((await h.find(f.api, { name: NAME })).vm.ips, ['203.0.113.20']);
  assert.deepEqual((await h.managedVms(f.api)).vms.map((v) => v.name), [NAME]);
  await assert.rejects(h.powerAction(f.api, { vm, action: 'explode' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.powerAction(f.api, { vm: uuid(404), action: 'on' }), { code: 'VM_NOT_FOUND' });
  await assert.rejects(h.destroy(f.api, { vm: uuid(2) }), { code: 'NOT_MANAGED' });
  await h.diskAdd(f.api, { vm, sizeGb: 20 });
  assert.deepEqual(await h.destroy(f.api, { vm }), { task: '' }); // running: stopped first
  assert.deepEqual(Object.keys(f.db.volumes), [], 'the added disk\'s volume went with the server');
  assert.deepEqual(await h.destroy(f.api, { vm }), { task: '', gone: true });
  assert.deepEqual(await h.find(f.api, { name: NAME }), { vm: null });
});

test('resize, take over, disks and snapshots', async () => {
  const f = incus(), { vm } = await created(f);
  await assert.rejects(h.resize(f.api, { vm, vcpu: 8, memoryMb: 8192, diskGb: 20 }), { code: 'DISK_SHRINK_NOT_SUPPORTED' });
  await h.powerAction(f.api, { vm, action: 'on' });
  await assert.rejects(h.resize(f.api, { vm, vcpu: 8, memoryMb: 8192, diskGb: 60 }), { code: 'INVALID_STATE' });
  await h.powerAction(f.api, { vm, action: 'off' });
  assert.deepEqual(await h.resize(f.api, { vm, vcpu: 8, memoryMb: 8192, diskGb: 60 }), { task: '' });
  const i = f.inst(NAME);
  assert.deepEqual([i.config['limits.cpu'], i.config['limits.memory'], i.devices.root], ['8', '8192MiB', { type: 'disk', path: '/', pool: 'default', size: '60GiB' }]);
  await assert.rejects(h.resize(f.api, { vm: uuid(2), vcpu: 1, memoryMb: 1024, diskGb: 10 }), { code: 'NOT_MANAGED' });

  await assert.rejects(h.rename(f.api, { vm: uuid(2), name: 'lvm-taken' }), { code: 'INVALID_STATE' });
  await assert.rejects(h.rename(f.api, { vm, name: 'lvm-taken' }), { code: 'NOT_IMPORTABLE' });
  f.inst('someone-else').status = 'Stopped';
  assert.deepEqual(await h.rename(f.api, { vm: uuid(2), name: 'lvm-taken' }), { name: 'lvm-taken', diskGb: 10 });
  assert.equal((await h.find(f.api, { name: 'lvm-taken' })).vm.moref, uuid(2), 'the id the panel stored still finds it');

  await h.diskAdd(f.api, { vm, sizeGb: 20 }); await h.diskAdd(f.api, { vm, sizeGb: 30 });
  assert.deepEqual(f.db.volumes[`${NAME}-disk1`], { name: `${NAME}-disk1`, type: 'custom', content_type: 'block', config: { size: '20GiB' } });
  assert.deepEqual(i.devices['lvm-disk2'], { type: 'disk', pool: 'default', source: `${NAME}-disk2` });
  assert.deepEqual((await h.disks(f.api, { vm })).disks, [{ key: 0, label: 'root', sizeGb: 60, system: true }, { key: 1, label: 'disk1', sizeGb: 20, system: false }, { key: 2, label: 'disk2', sizeGb: 30, system: false }]);
  await assert.rejects(h.diskAdd(f.api, { vm, sizeGb: 9999 }), { code: 'INSUFFICIENT_RESOURCES' });
  await assert.rejects(h.diskRemove(f.api, { vm, key: 0 }), { code: 'SYSTEM_DISK' });
  i.status = 'Running'; i.busy = true;
  await assert.rejects(h.diskRemove(f.api, { vm, key: 1 }), { code: 'INVALID_STATE' });
  i.status = 'Stopped';
  assert.deepEqual(await h.diskRemove(f.api, { vm, key: 1 }), { task: '' });
  assert.deepEqual([Object.keys(f.db.volumes), i.devices['lvm-disk1'], i.config['user.lvm-disk.1'], i.config['volatile.uuid']], [[`${NAME}-disk2`], undefined, undefined, vm]);
  assert.deepEqual(await h.diskRemove(f.api, { vm, key: 1 }), { task: '', gone: true });

  await h.snapshot(f.api, { vm, action: 'create', name: "before the 'big' upgrade", description: 'ağ & çekirdek' }, 1700000000000);
  assert.deepEqual((await h.snapshots(f.api, { vm })).snapshots, [{ id: 'snapshot-1700000000', name: "before the 'big' upgrade", description: 'ağ & çekirdek', created: '2024-01-01T10:00:00.000Z', powerState: 'poweredOff', current: false, parent: '' }]);
  f.db.snaps[NAME].push({ name: `${NAME}/by-hand`, created_at: '2024-02-01T10:00:00Z', stateful: true });
  const [, foreign] = (await h.snapshots(f.api, { vm })).snapshots;
  assert.match(foreign.id, /^snapshot-\d{1,12}$/); assert.equal(foreign.name, 'by-hand');
  // Since the snapshot: disk 2 went, a new disk came, a second snapshot was named. Going back keeps all three as they
  // are now (a snapshot holds the configuration of its moment, and Incus would bring that back).
  i.busy = false; await h.diskRemove(f.api, { vm, key: 2 }); await h.diskAdd(f.api, { vm, sizeGb: 5 });
  await h.snapshot(f.api, { vm, action: 'create', name: 'second', description: '' }, 1700000100000);
  f.db.snaps[NAME].push(f.db.snaps[NAME].splice(1, 1)[0]); // the one made by hand stays last
  await h.powerAction(f.api, { vm, action: 'on' });
  await h.snapshot(f.api, { vm, action: 'revert', snapshot: 'snapshot-1700000000' });
  assert.equal(f.db.restored, 'lvm1700000000');
  assert.equal(f.db.restoredRunning, undefined, 'stopped first: Incus would start it with a disk that is gone');
  assert.equal(i.status, 'Running');
  assert.deepEqual(Object.keys(i.devices).filter((k) => k.startsWith('lvm-disk')), ['lvm-disk1']);
  assert.deepEqual((await h.disks(f.api, { vm })).disks.map((x) => [x.key, x.sizeGb]), [[0, 60], [1, 5]]);
  assert.deepEqual((await h.snapshots(f.api, { vm })).snapshots.map((s) => s.name), ["before the 'big' upgrade", 'second', 'by-hand']);
  assert.equal(i.description, `Managed by Lightning VM (server ${SERVER})`, 'no update empties the description');
  await h.snapshot(f.api, { vm, action: 'remove', snapshot: 'snapshot-1700000100' });
  assert.equal(i.config['user.lvm-snap.lvm1700000100'], undefined, 'a removed snapshot leaves no label behind');
  // A volume without its device (an answer was lost): its number is not given out again.
  f.db.volumes[`${NAME}-disk2`] = { name: `${NAME}-disk2` };
  await h.diskAdd(f.api, { vm, sizeGb: 7 });
  assert.deepEqual((await h.disks(f.api, { vm })).disks.map((x) => [x.key, x.sizeGb]), [[0, 60], [1, 5], [3, 7]]);
  await h.snapshot(f.api, { vm, action: 'remove', snapshot: foreign.id });
  assert.deepEqual(f.db.snaps[NAME].map((s) => s.name), [`${NAME}/lvm1700000000`]);
  await assert.rejects(h.snapshot(f.api, { vm, action: 'remove', snapshot: 'snapshot-5' }), { code: 'SNAPSHOT_NOT_FOUND' });
});

test('details, usage and the topology', async () => {
  const f = incus(), { vm } = await created(f);
  await h.powerAction(f.api, { vm, action: 'on' }); await h.diskAdd(f.api, { vm, sizeGb: 20 });
  const d = await h.details(f.api, { vm });
  assert.deepEqual([d.name, d.powerState, d.cpu.count, d.memory.sizeMb, d.memory.guestUsageMb, d.hardwareVersion, d.annotation], [NAME, 'poweredOn', 4, 4096, 512, 'virtual-machine', `Managed by Lightning VM (server ${SERVER})`]);
  assert.deepEqual(d.nics.map((x) => [x.mac, x.network, x.ips]), [['00:16:3e:00:00:01', 'incusbr0', ['203.0.113.20']]]);
  assert.deepEqual(d.disks.map((x) => [x.capacityGb, x.datastore, x.file]), [[40, 'default', `default/${NAME}`], [20, 'default', `default/${NAME}-disk1`]]);
  assert.deepEqual(d.placement.datastores, ['default']); assert.equal(d.placement.host, 'incus01'); assert.equal(d.committedGb, 3);
  assert.deepEqual((await h.metrics(f.api, { vm })).quick.memoryActiveMb, 512);
  const t = await h.topology(f.api);
  assert.deepEqual(t.vms.map((v) => [v.name, v.host, v.power, v.memUsedMb]), [[NAME, 'incus01', 'poweredOn', 512]]); assert.equal(t.otherVms, 1);
  assert.deepEqual([t.hosts[0].memUsedMb, t.hosts[0].memTotalMb, t.hosts[0].cpuTotalMhz], [24576, 65536, 28800]);
  assert.deepEqual((await h.powerReport(f.api)).vms.map((v) => v.name), [NAME]);
});

// ---- the client, against a real TLS server that wants a client certificate ---------------------------
test('the client signs in with its certificate, pins the server\'s and names what went wrong', async () => {
  const seen = [];
  let trusted = true;
  const server = https.createServer({ cert: CERT, key: KEY, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const client = req.socket.getPeerCertificate()?.raw;
    seen.push(`${req.method} ${req.url} ${client ? 'cert' : 'no-cert'}`);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/1.0') return send(200, { type: 'sync', status_code: 200, metadata: { api_version: '1.0', auth: client && trusted ? 'trusted' : 'untrusted', api_extensions: [], environment: { server: 'incus', server_version: '6.0.4' } } });
    if (req.url.startsWith('/1.0/instances/missing')) return send(404, { type: 'error', error: 'Instance not found', error_code: 404 });
    if (req.url.startsWith('/1.0/instances')) return send(202, { type: 'async', status_code: 100, operation: '/1.0/operations/x', metadata: { id: 'x', status_code: 103 } });
    return send(403, { type: 'error', error: 'not authorized', error_code: 403 });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pin = createHash('sha256').update(new X509Certificate(CERT).raw).digest('hex');
  // Pasted into a one-line field: no line breaks left.
  const pasted = `${CERT} ${KEY}`.replace(/\n/g, ' ');
  const target = (over = {}) => ({ host: '127.0.0.1', port: server.address().port, username: 'customers', password: pasted, tls: { mode: 'pinned', sha256: pin }, ...over });
  try {
    await assert.rejects(connect(target({ tls: { mode: 'system' } })), (e) => e.code === 'TLS_UNTRUSTED' && e.certificate.sha256 === pin);
    await assert.rejects(connect(target({ tls: { mode: 'pinned', sha256: 'ab'.repeat(32) } })), (e) => e.code === 'TLS_PIN_MISMATCH' && e.certificate.sha256 === pin);
    await assert.rejects(connect(target({ password: 'just a password' })), { code: 'INVALID_LOGIN' });
    await assert.rejects(connect(target({ username: 'bad project!' })), { code: 'INVALID_REQUEST' });
    trusted = false; await assert.rejects(connect(target()), { code: 'INVALID_LOGIN' }); trusted = true;
    const api = await connect(target());
    assert.equal(api.server.environment.server_version, '6.0.4'); assert.equal(api.project, 'customers');
    assert.deepEqual(await api('POST', '/1.0/instances', { name: 'x' }), { id: 'x', status_code: 103 });
    await assert.rejects(api('GET', '/1.0/instances/missing?recursion=1'), { code: 'NOT_FOUND' });
    await assert.rejects(api('GET', '/1.0/certificates'), { code: 'PERMISSION_DENIED' });
    api.close();
    assert.deepEqual(seen.slice(-4), ['GET /1.0 cert', 'POST /1.0/instances?project=customers cert', 'GET /1.0/instances/missing?recursion=1&project=customers cert', 'GET /1.0/certificates cert']);
  } finally { server.close(); }
  assert.deepEqual(identity('nothing'), null);
  assert.equal(identity(pasted).key, KEY.replace(/\r\n/g, '\n')); assert.equal(identity(pasted).cert, CERT.replace(/\r\n/g, '\n'));
  assert.equal(operationFailure('Failed: no space left on device').code, 'INSUFFICIENT_RESOURCES'); assert.equal(operationFailure('boom').code, 'TASK_FAILED');
});

// ---- the HTTP shell ------------------------------------------------------------------------------
test('the service wants its token and names what is not there yet', async () => {
  const token = 't'.repeat(40), f = incus();
  const server = http.createServer(handler(token, { transport: f.api })); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (path, body, auth = token) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body ?? {}) }); return [r.status, await r.json()]; };
  try {
    assert.equal((await call('/v1/discover', { host: 'incus.example' }, 'wrong'))[0], 401);
    assert.deepEqual(await call('/v1/console-ticket', { host: 'incus.example' }), [400, { code: 'PLATFORM_NOT_SUPPORTED', message: 'not available on Incus yet' }]);
    assert.deepEqual(await call('/v1/vm/find', { host: 'incus.example', username: 'default', name: 'lvm-x' }), [200, { vm: null }]);
    assert.deepEqual((await call('/v1/vm/power', { host: 'incus.example', vm: uuid(404), action: 'on' })).map((x) => x.code ?? x), [404, 'VM_NOT_FOUND']);
  } finally { server.close(); }
});
