// The adapter against a small pretend oVirt Engine: one cluster with one host, a data domain, a template.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as h from '../handlers.mjs';
import { handler } from '../server.mjs';
import { engineFailure, Failure } from '../engine.mjs';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function engine() {
  let n = 200;
  const db = { clusters: [{ id: id(1), name: 'Default' }],
    hosts: [{ id: id(2), name: 'node1', status: 'up', cluster: { id: id(1) }, memory: 64 * GIB, cpu: { name: 'Test CPU', speed: 2400, topology: { sockets: 2, cores: 8, threads: 2 } },
      hardware_information: { uuid: 'hw-uuid-1', manufacturer: 'Test' }, version: { full_version: 'vdsm-4.50' } }],
    storagedomains: [{ id: id(3), name: 'data', type: 'data', available: 800 * GIB, used: 200 * GIB, committed: 500 * GIB, storage: { type: 'nfs' }, external_status: 'ok' }, { id: id(4), name: 'iso', type: 'iso', available: GIB, used: 0 }],
    networks: [{ id: id(5), name: 'ovirtmgmt' }, { id: id(6), name: 'customers', vlan: { id: 120 } }],
    vnicprofiles: [{ id: id(7), name: 'ovirtmgmt', network: { id: id(5) } }, { id: id(8), name: 'public', network: { id: id(6) } }],
    templates: [{ id: '00000000-0000-0000-0000-000000000000', name: 'Blank' }, { id: id(11), name: 'ubuntu-24', memory: 2 * GIB, cpu: { topology: { sockets: 2, cores: 1, threads: 1 } }, os: { type: 'ubuntu' } }],
    disks: { [id(20)]: { id: id(20), name: 'ubuntu_Disk1', provisioned_size: 10 * GIB, actual_size: 3 * GIB, status: 'ok', storage_domains: { storage_domain: [{ id: id(3) }] } } },
    atts: { [id(11)]: [{ id: id(20), bootable: true, interface: 'virtio_scsi', disk: { id: id(20) } }] },
    nics: { [id(11)]: [{ id: id(30), name: 'nic1', interface: 'virtio', mac: { address: '56:6f:00:00:00:01' }, vnic_profile: { id: id(7) } }] },
    snapshots: {}, vms: [{ id: id(12), name: 'someone-else', status: 'up', memory: GIB, cpu: { topology: { sockets: 1, cores: 1, threads: 1 } }, host: { id: id(2) }, cluster: { id: id(1) } }] };
  const calls = [];
  const vm = (i) => { const v = db.vms.find((x) => x.id === i); if (!v) throw engineFailure(404, 'Entity not found: VM'); return v; };
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const [p, query = ''] = path.split('?');
    if (p === '') return { product_info: { name: 'oVirt Engine', instance_id: 'engine-1', version: { full_version: '4.5.6-1.el9', major: 4, minor: 5 } } };
    const coll = { '/clusters': ['cluster', db.clusters], '/hosts': ['host', db.hosts], '/storagedomains': ['storage_domain', db.storagedomains], '/vnicprofiles': ['vnic_profile', db.vnicprofiles], '/networks': ['network', db.networks], '/templates': ['template', db.templates] }[p];
    if (coll && method === 'GET') return { [coll[0]]: coll[1] };
    if (p === '/vms' && method === 'GET') { const s = decodeURIComponent(/search=([^&]*)/.exec(query)?.[1] ?? '').replace(/^name=/, ''); return { vm: db.vms.filter((v) => !s || (s.endsWith('*') ? v.name.startsWith(s.slice(0, -1)) : v.name === s)) }; }
    if (p === '/vms' && method === 'POST') {
      assert.equal(query, 'clone=true');
      const v = { id: id(++n), status: 'image_locked', ...body }; delete v.disk_attachments; db.vms.push(v);
      db.atts[v.id] = body.disk_attachments.disk_attachment.map((a) => { const d = id(++n); db.disks[d] = { ...db.disks[a.disk.id], id: d, status: 'locked', storage_domains: a.disk.storage_domains }; return { id: d, bootable: true, interface: 'virtio_scsi', disk: { id: d } }; });
      db.nics[v.id] = db.nics[body.template.id].map((x) => ({ ...x, id: id(++n) })); db.snapshots[v.id] = [];
      return v;
    }
    let m;
    if ((m = /^\/(templates|hosts|clusters|vnicprofiles|storagedomains)\/([^/]+)$/.exec(p))) { const x = db[m[1]].find((y) => y.id === m[2]); if (!x) throw engineFailure(404, 'Entity not found'); return x; }
    if ((m = /^\/disks\/([^/]+)$/.exec(p))) { if (!db.disks[m[1]]) throw engineFailure(404, 'Entity not found'); return db.disks[m[1]]; }
    if ((m = /^\/(templates|vms)\/([^/]+)\/(diskattachments|nics)$/.exec(p))) {
      if (method === 'POST') { const d = id(++n); db.disks[d] = { id: d, status: 'ok', actual_size: 0, ...body.disk }; const a = { id: d, bootable: false, interface: body.interface, disk: { id: d } }; db.atts[m[2]].push(a); return a; }
      return m[3] === 'nics' ? { nic: db.nics[m[2]] ?? [] } : { disk_attachment: db.atts[m[2]] ?? [] };
    }
    if ((m = /^\/vms\/([^/]+)\/nics\/([^/]+)$/.exec(p))) { Object.assign(db.nics[m[1]].find((x) => x.id === m[2]), body); return {}; }
    if ((m = /^\/vms\/([^/]+)\/diskattachments\/([^/]+)$/.exec(p))) {
      if (method === 'DELETE') { db.atts[m[1]] = db.atts[m[1]].filter((a) => a.id !== m[2]); delete db.disks[m[2]]; return {}; }
      if (body.disk?.provisioned_size) Object.assign(db.disks[m[2]], body.disk, { status: 'locked' }); return {};
    }
    if ((m = /^\/vms\/([^/]+)\/snapshots$/.exec(p))) {
      if (method === 'POST') { const s = { id: id(++n), date: 1_704_103_200_000, snapshot_type: 'regular', ...body }; db.snapshots[m[1]].push(s); return s; }
      return { snapshot: [{ id: id(999), snapshot_type: 'active', description: 'Active VM' }, ...(db.snapshots[m[1]] ?? [])] };
    }
    if ((m = /^\/vms\/([^/]+)\/snapshots\/([^/]+)(\/restore)?$/.exec(p))) { if (!m[3]) db.snapshots[m[1]] = db.snapshots[m[1]].filter((s) => s.id !== m[2]); return {}; }
    if ((m = /^\/vms\/([^/]+)\/reporteddevices$/.exec(p))) return { reported_device: vm(m[1]).status === 'up' ? [{ name: 'eth0', mac: { address: '56:6f:00:00:00:01' }, ips: { ip: [{ address: '203.0.113.20', version: 'v4' }, { address: 'fe80::1', version: 'v6' }] } }] : [] };
    if ((m = /^\/(vms|hosts)\/([^/]+)\/statistics$/.exec(p))) return { statistic: [{ name: 'memory.used', values: { value: [{ datum: 512 * MIB }] } }, { name: 'cpu.current.user', values: { value: [{ datum: 25 }] } }] };
    if ((m = /^\/vms\/([^/]+)\/(start|stop|shutdown|reset|reboot)$/.exec(p))) { const v = vm(m[1]); v.started_with = body; v.status = m[2] === 'stop' || m[2] === 'shutdown' ? 'down' : 'up'; if (v.status === 'up') { v.host = { id: id(2) }; v.start_time = Date.now() - 1000; } return {}; }
    if ((m = /^\/vms\/([^/]+)$/.exec(p))) {
      if (method === 'DELETE') { vm(m[1]); db.vms = db.vms.filter((v) => v.id !== m[1]); return {}; }
      if (method === 'PUT') { Object.assign(vm(m[1]), body); return {}; }
      return vm(m[1]);
    }
    throw new Error(`fake engine: ${method} ${path}`);
  };
  api.root = { product_info: { name: 'oVirt Engine', instance_id: 'engine-1', version: { full_version: '4.5.6-1.el9' } } };
  // The engine finishes what it was busy with (a copy, a resize).
  const settle = () => { for (const v of db.vms) if (v.status === 'image_locked') v.status = 'down'; for (const d of Object.values(db.disks)) d.status = 'ok'; };
  return { db, api, calls, settle };
}
const serverId = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f';
const order = { name: `lvm-${serverId}`, serverId, template: id(11), pool: id(1), datastore: id(3), network: id(8), vcpu: 4, memoryMb: 4096, diskGb: 40,
  metadata: JSON.stringify({ 'instance-id': serverId, network: { version: 2, ethernets: { nic0: { addresses: ['203.0.113.20/26', '2001:db8::10/64'], routes: [{ to: 'default', via: '203.0.113.1' }, { to: '::/0', via: '2001:db8::1' }], nameservers: { addresses: ['1.1.1.1', '9.9.9.9'] } } } } }),
  userdata: `#cloud-config\n${JSON.stringify({ hostname: 'web1', ssh_authorized_keys: ['ssh-ed25519 AAAA a', 'ssh-ed25519 BBBB b'], ssh_pwauth: false, chpasswd: { expire: false, list: 'root:$6$salt$hash' }, runcmd: [['sh', '-c', 'echo hi']] })}` };
async function create(e) { const { task } = await h.clone(e.api, order); for (let i = 0; i < 6; i++) { e.settle(); const r = await h.task(e.api, { task }); if (r.state !== 'running') return r; } throw new Error('never finished'); }

test('discovery describes the cluster, host, data domain, network profiles and VMs the way the panel stores them', async () => {
  const { api } = engine();
  const d = await h.discover(api);
  assert.deepEqual([d.product.kind, d.product.version, d.product.instanceUuid], ['ovirt', '4.5.6-1.el9', 'engine-1']);
  assert.deepEqual(d.hosts.map((x) => [x.moref, x.parent, x.cpuMhz, x.cpuCores, x.cpuThreads, x.hardwareUuid]), [[id(2), id(1), 2400, 16, 32, 'hw-uuid-1']]);
  assert.deepEqual(d.compute, [{ moref: id(1), name: 'Default', kind: 'cluster', hosts: 1, effectiveCpuMhz: 38400, effectiveMemoryMb: 65536, resourcePool: id(1) }]);
  assert.deepEqual(d.datastores.map((x) => [x.moref, x.capacityBytes, x.freeBytes, x.uncommittedBytes, x.accessible]), [[id(3), 1000 * GIB, 800 * GIB, 300 * GIB, true]], 'only data domains');
  assert.deepEqual(d.networks.map((x) => [x.moref, x.name, x.vlan]), [[id(7), 'ovirtmgmt', null], [id(8), 'customers / public', 120]]);
  assert.deepEqual(d.vms.map((x) => [x.name, x.template, x.powerState]), [['someone-else', false, 'poweredOn'], ['ubuntu-24', true, 'poweredOff']], 'the Blank template is left out');
  for (const k of ['licenses', 'warnings', 'hosts', 'datastores', 'networks', 'compute', 'vms']) assert.ok(Array.isArray(d[k]));
});

test('cloud-init documents become the engine\'s initialization', () => {
  const i = h.initialization(order.metadata, order.userdata);
  assert.equal(i.host_name, 'web1'); assert.equal(i.authorized_ssh_keys, 'ssh-ed25519 AAAA a\nssh-ed25519 BBBB b'); assert.equal(i.dns_servers, '1.1.1.1 9.9.9.9');
  assert.deepEqual(i.nic_configurations.nic_configuration, [{ name: 'eth0', on_boot: true, boot_protocol: 'static', ip: { version: 'v4', address: '203.0.113.20', netmask: '255.255.255.192', gateway: '203.0.113.1' },
    ipv6_boot_protocol: 'static', ipv6: { version: 'v6', address: '2001:db8::10', netmask: '64', gateway: '2001:db8::1' } }]);
  assert.deepEqual(JSON.parse(i.custom_script), { ssh_pwauth: false, chpasswd: { expire: false, list: 'root:$6$salt$hash' }, runcmd: [['sh', '-c', 'echo hi']] }, 'the rest travels as the custom script');
  assert.deepEqual(h.initialization('', 'not json'), {});
});

test('a clone is created with its size and cloud-init, then moved to its network and grown, one step per look', async () => {
  const e = engine();
  const started = await h.clone(e.api, order);
  assert.match(started.task, /^create:/); assert.equal(started.existed, false);
  const vm = e.db.vms.find((v) => v.name === order.name);
  assert.deepEqual([vm.memory, vm.cpu.topology.sockets, vm.cluster.id, vm.template.id, vm.description], [4096 * MIB, 4, id(1), id(11), `Managed by Lightning VM (server ${serverId})`]);
  assert.equal(vm.initialization.host_name, 'web1');
  assert.deepEqual(e.db.disks[e.db.atts[vm.id][0].disk.id].storage_domains, { storage_domain: [{ id: id(3) }] }, 'the copy goes to the chosen storage domain');
  assert.deepEqual(await h.task(e.api, { task: started.task }), { state: 'running' }, 'the image is still locked');
  e.settle();
  assert.deepEqual(await h.task(e.api, { task: started.task }), { state: 'running' }, 'the network was set and the disk is growing');
  assert.equal(e.db.nics[vm.id][0].vnic_profile.id, id(8));
  assert.deepEqual(await h.task(e.api, { task: started.task }), { state: 'running' }, 'the disk is locked while it grows');
  e.settle();
  assert.deepEqual(await h.task(e.api, { task: started.task }), { state: 'success', vm: vm.id });
  assert.equal(e.db.disks[e.db.atts[vm.id][0].disk.id].provisioned_size, 40 * GIB); assert.equal(vm.comment, 'lvm:first=1', 'only the first-boot mark is left');
  assert.deepEqual(await h.clone(e.api, order), { vm: vm.id, existed: true });
  await h.powerAction(e.api, { vm: vm.id, action: 'on' });
  assert.deepEqual(vm.started_with, { use_cloud_init: true }, 'the first start hands the settings to cloud-init'); assert.equal(vm.comment, '');
  const up = (await h.find(e.api, { name: order.name })).vm;
  assert.deepEqual([up.powerState, up.toolsRunning, up.ips, up.serverId], ['poweredOn', true, ['203.0.113.20'], serverId]);
  await h.powerAction(e.api, { vm: vm.id, action: 'off' }); await h.powerAction(e.api, { vm: vm.id, action: 'on' });
  assert.deepEqual(vm.started_with, {}, 'later starts are ordinary');
  assert.deepEqual(await h.powerAction(e.api, { vm: vm.id, action: 'on' }), { task: '' });
});

test('what cannot be done is refused with the contract\'s codes', async () => {
  const e = engine();
  await assert.rejects(h.clone(e.api, { ...order, diskGb: 5 }), { code: 'DISK_SMALLER_THAN_TEMPLATE' });
  await assert.rejects(h.clone(e.api, { ...order, template: id(998) }), { code: 'TEMPLATE_NOT_FOUND' });
  await assert.rejects(h.clone(e.api, { ...order, template: id(12) }), { code: 'PROVISIONING_NOT_SUPPORTED' }, 'a server is not copied from another server');
  await assert.rejects(h.clone(e.api, { ...order, name: 'web1' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.destroy(e.api, { vm: id(12) }), { code: 'NOT_MANAGED' });
  assert.deepEqual(await h.destroy(e.api, { vm: id(997) }), { task: '', gone: true });
  assert.deepEqual(await h.task(e.api, { task: `create:${id(996)}` }), { state: 'error', code: 'TASK_FAILED', error: 'the engine did not keep the new VM (see its events)' });
  assert.equal(engineFailure(401, '').code, 'INVALID_LOGIN'); assert.equal(engineFailure(409, 'x').code, 'INVALID_STATE'); assert.equal(engineFailure(400, 'VM name is already in use').code, 'DUPLICATE_NAME');
  assert.equal(engineFailure(400, 'Cannot run VM. Low disk space on Storage Domain').code, 'INSUFFICIENT_RESOURCES'); assert.ok(engineFailure(500, 'x') instanceof Failure);
});

test('resize, extra disks, snapshots and delete', async () => {
  const e = engine();
  const { vm: vmId } = await create(e);
  const vm = e.db.vms.find((v) => v.id === vmId);
  await h.resize(e.api, { vm: vmId, vcpu: 2, memoryMb: 2048, diskGb: 60 }); e.settle();
  assert.deepEqual([vm.cpu.topology.sockets, vm.memory, e.db.disks[e.db.atts[vmId][0].disk.id].provisioned_size], [2, 2048 * MIB, 60 * GIB]);
  await assert.rejects(h.resize(e.api, { vm: vmId, vcpu: 2, memoryMb: 2048, diskGb: 10 }), { code: 'DISK_SHRINK_NOT_SUPPORTED' });
  await h.diskAdd(e.api, { vm: vmId, sizeGb: 20 });
  const list = (await h.disks(e.api, { vm: vmId })).disks;
  assert.deepEqual(list.map((d) => [d.sizeGb, d.system]), [[60, true], [20, false]]); assert.ok(list.every((d) => Number.isInteger(d.key) && d.key > 0 && d.key < 2 ** 31));
  await assert.rejects(h.diskRemove(e.api, { vm: vmId, key: list[0].key }), { code: 'SYSTEM_DISK' });
  assert.deepEqual(await h.diskRemove(e.api, { vm: vmId, key: list[1].key }), { task: '' });
  assert.deepEqual(await h.diskRemove(e.api, { vm: vmId, key: list[1].key }), { task: '', gone: true });
  await h.snapshot(e.api, { vm: vmId, action: 'create', name: 'before the upgrade', description: 'ticket 42' });
  const [s] = (await h.snapshots(e.api, { vm: vmId })).snapshots;
  assert.match(s.id, /^snapshot-\d{1,12}$/); assert.deepEqual([s.name, s.description, s.created], ['before the upgrade', 'ticket 42', '2024-01-01T10:00:00.000Z']);
  await assert.rejects(h.resize(e.api, { vm: vmId, vcpu: 2, memoryMb: 2048, diskGb: 80 }), { code: 'DISK_HAS_SNAPSHOTS' });
  await assert.rejects(h.snapshot(e.api, { vm: vmId, action: 'revert', snapshot: 'snapshot-1' }), { code: 'SNAPSHOT_NOT_FOUND' });
  assert.deepEqual(await h.snapshot(e.api, { vm: vmId, action: 'revert', snapshot: s.id }), { task: '' });
  await h.snapshot(e.api, { vm: vmId, action: 'remove', snapshot: s.id });
  assert.deepEqual((await h.snapshots(e.api, { vm: vmId })).snapshots, []);
  assert.deepEqual(await h.destroy(e.api, { vm: vmId }), { task: '' }); assert.equal(e.db.vms.some((v) => v.id === vmId), false);
});

test('details, topology and the power report have the shapes the panel reads', async () => {
  const e = engine();
  const { vm: vmId } = await create(e);
  await h.powerAction(e.api, { vm: vmId, action: 'on' });
  const d = await h.details(e.api, { vm: vmId });
  assert.deepEqual([d.cpu.count, d.memory.sizeMb, d.nics[0].network, d.nics[0].ips, d.guest.ips, d.disks[0].capacityGb, d.placement.host, d.placement.cluster, d.guest.dns],
    [4, 4096, 'public', ['203.0.113.20', 'fe80::1'], ['203.0.113.20'], 40, 'node1', 'Default', ['1.1.1.1', '9.9.9.9']]);
  const m = await h.metrics(e.api, { vm: vmId });
  assert.deepEqual([m.interval, m.samples, m.quick.memoryActiveMb], [60, [], 512]);
  const t = await h.topology(e.api);
  assert.deepEqual(t.vms.map((v) => [v.name, v.host, v.power]), [[order.name, id(2), 'poweredOn']]); assert.equal(t.otherVms, 1);
  assert.deepEqual([t.hosts[0].cpuUsedMhz, t.hosts[0].cpuTotalMhz, t.hosts[0].memUsedMb], [9600, 38400, 512]);
  const p = await h.powerReport(e.api);
  assert.deepEqual([p.hosts[0].coreMhz, p.hosts[0].watts, p.vms.map((v) => v.name)], [2400, null, [order.name]]);
  assert.deepEqual((await h.managedVms(e.api)).vms.map((v) => v.name), [order.name]);
});

test('the service wants its token and answers unsupported routes clearly', async () => {
  const { api } = engine();
  const token = 't'.repeat(40);
  const server = http.createServer(handler(token, { transport: api })).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, auth = `Bearer ${token}`) => fetch(base + path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  try {
    assert.deepEqual(await post('/v1/vm/find', { host: 'x', username: 'admin@internal', name: 'nobody' }, 'Bearer wrong'), [401, { code: 'UNAUTHORIZED', message: 'service token required' }]);
    assert.deepEqual(await post('/v1/vm/find', { host: 'x', username: 'admin@internal', name: 'nobody' }), [200, { vm: null }]);
    assert.equal((await post('/v1/vm/firewall', { host: 'x', username: 'admin@internal' }))[1].code, 'PLATFORM_NOT_SUPPORTED');
    const missing = await post('/v1/vm/details', { host: 'x', username: 'admin@internal', vm: id(999) });
    assert.deepEqual([missing[0], missing[1].code], [404, 'VM_NOT_FOUND']);
  } finally { server.close(); }
});
