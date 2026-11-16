// The adapter against a small pretend Proxmox VE: one node, a template, the panel's VMs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as h from '../handlers.mjs';
import { handler } from '../server.mjs';
import { Failure } from '../pve.mjs';

const GIB = 1024 ** 3;
function cluster() {
  const c = { calls: [], nextid: 105, tasks: {}, vms: {
    100: { vmid: 100, name: 'ubuntu-24', node: 'pve1', status: 'stopped', template: 1, maxcpu: 2, maxmem: 2 * GIB, maxdisk: 10 * GIB,
      config: { name: 'ubuntu-24', cores: 2, memory: 2048, boot: 'order=scsi0', scsi0: 'local-lvm:base-100-disk-0,size=10G', net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1', agent: '1' }, snapshots: [] },
    101: { vmid: 101, name: 'someone-else', node: 'pve1', status: 'running', maxcpu: 1, maxmem: GIB, config: { name: 'someone-else', scsi0: 'local-lvm:vm-101-disk-0,size=8G', net0: 'virtio=AA:AA:AA:AA:AA:AA,bridge=vmbr0' }, snapshots: [] },
  } };
  const upid = (type, id) => { const u = `UPID:pve1:0001:0002:0003:${type}:${id}:root@pam:`; c.tasks[u] = { status: 'stopped', exitstatus: 'OK' }; return u; };
  const api = async (method, path, params = {}) => {
    c.calls.push(`${method} ${path}`);
    if (path === '/version') return { version: '8.2.4', release: '8.2', repoid: 'abc' };
    if (path === '/cluster/status') return [{ type: 'cluster', name: 'lab' }, { type: 'node', name: 'pve1' }];
    if (path === '/cluster/nextid') return String(c.nextid);
    if (path === '/access/permissions') return { '/': Object.fromEntries(['VM.Allocate', 'VM.Clone', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.PowerMgmt', 'VM.Snapshot', 'Datastore.AllocateSpace', 'Sys.Audit'].map((p) => [p, 1])) };
    if (path === '/cluster/resources') {
      const all = [{ type: 'node', node: 'pve1', status: 'online', maxcpu: 8, maxmem: 32 * GIB, cpu: 0.25, mem: 8 * GIB },
        { type: 'storage', storage: 'local-lvm', node: 'pve1', shared: 0, content: 'images,rootdir', plugintype: 'lvmthin', maxdisk: 500 * GIB, disk: 100 * GIB, status: 'available' },
        { type: 'storage', storage: 'backups', node: 'pve1', shared: 0, content: 'backup', plugintype: 'dir', maxdisk: GIB, disk: 0, status: 'available' },
        ...Object.values(c.vms).map(({ config: _c, snapshots: _s, ...v }) => ({ type: 'qemu', ...v }))];
      return params.type === 'vm' ? all.filter((r) => r.type === 'qemu') : all;
    }
    if (path === '/nodes/pve1/status') return { cpuinfo: { mhz: '3000.000', cores: 4, sockets: 1, cpus: 8, model: 'Test CPU' }, memory: { total: 32 * GIB }, pveversion: 'pve-manager/8.2.4' };
    if (path === '/nodes/pve1/network') return [{ iface: 'vmbr0', type: 'bridge' }];
    const task = /^\/nodes\/pve1\/tasks\/(.+)\/status$/.exec(path);
    if (task) { const t = c.tasks[decodeURIComponent(task[1])]; if (!t) throw new Failure('PROXMOX_ERROR', 'no such task'); return t; }
    const m = /^\/nodes\/pve1\/qemu\/(\d+)(\/.*)?$/.exec(path);
    if (!m) throw new Error(`fake: ${method} ${path}`);
    const v = c.vms[m[1]], sub = m[2] ?? '';
    if (!v) throw new Failure('VM_NOT_FOUND', 'does not exist');
    if (sub === '/config' && method === 'GET') return { ...v.config };
    if (sub === '/config') {
      for (const [k, val] of Object.entries(params)) {
        if (k === 'delete') { const gone = v.config[val]; delete v.config[val]; if (/^(scsi|virtio|sata|ide)\d+$/.test(val)) v.config.unused0 = String(gone).split(',')[0]; }
        else if (/^(scsi|virtio|sata|ide)\d+$/.test(k) && /^[\w-]+:\d+$/.test(val)) v.config[k] = `${val.split(':')[0]}:vm-${v.vmid}-disk-9,size=${val.split(':')[1]}G`;
        else v.config[k] = val;
      }
      if (params.name) v.name = params.name;
      return method === 'POST' ? upid('qmconfig', v.vmid) : null;
    }
    if (sub === '/clone') { c.nextid += 1; c.vms[params.newid] = { vmid: Number(params.newid), name: params.name, node: params.target ?? v.node, status: 'stopped', maxcpu: v.maxcpu, maxmem: v.maxmem,
      config: { ...v.config, name: params.name, description: params.description }, snapshots: [] }; return upid('qmclone', v.vmid); }
    if (sub === '/resize') { v.config[params.disk] = v.config[params.disk].replace(/size=\w+/, `size=${params.size}`); return upid('resize', v.vmid); }
    if (sub.startsWith('/agent/') && method === 'POST') { (c.agent ??= []).push([sub.slice(7), params]); return sub.endsWith('exec') ? { pid: 7 } : null; }
    if (sub === '/status/current') return { status: v.status, uptime: 120, mem: 512 * 1024 * 1024 };
    const st = /^\/status\/(start|stop|reset|shutdown)$/.exec(sub);
    if (st) { v.status = st[1] === 'start' || st[1] === 'reset' ? 'running' : 'stopped'; return upid(`qm${st[1]}`, v.vmid); }
    if (sub === '' && method === 'DELETE') { delete c.vms[m[1]]; return upid('qmdestroy', m[1]); }
    if (sub === '/snapshot' && method === 'GET') return [...v.snapshots, { name: 'current', parent: v.snapshots.at(-1)?.name }];
    if (sub === '/snapshot') { v.snapshots.push({ name: params.snapname, description: params.description, snaptime: 1_700_000_000 + v.snapshots.length, parent: v.snapshots.at(-1)?.name }); return upid('qmsnapshot', v.vmid); }
    const snap = /^\/snapshot\/([^/]+)(\/rollback)?$/.exec(sub);
    if (snap) { if (!snap[2]) v.snapshots = v.snapshots.filter((s) => s.name !== snap[1]); return upid(snap[2] ? 'qmrollback' : 'qmdelsnapshot', v.vmid); }
    if (sub === '/agent/network-get-interfaces') return { result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1' }] }, { name: 'eth0', 'hardware-address': 'bc:24:11:00:00:01', 'ip-addresses': [{ 'ip-address': '203.0.113.20', prefix: 24 }, { 'ip-address': 'fe80::1', prefix: 64 }] }] };
    if (sub === '/rrddata') return [{ time: 1_700_000_000, cpu: 0.5, mem: GIB, maxmem: 2 * GIB, netin: 2048, netout: 1024, diskread: 0, diskwrite: 4096 }];
    throw new Error(`fake: ${method} ${path}`);
  };
  api.version = { version: '8.2.4', release: '8.2', repoid: 'abc' };
  return { c, api };
}
const serverId = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f';
const order = { name: `lvm-${serverId}`, serverId, template: '100', pool: 'pve1', datastore: 'local-lvm@pve1', network: 'vmbr1', vcpu: 4, memoryMb: 4096, diskGb: 40,
  metadata: JSON.stringify({ 'instance-id': serverId, network: { version: 2, ethernets: { nic0: { addresses: ['203.0.113.20/24', '2001:db8::10/64'], routes: [{ to: 'default', via: '203.0.113.1' }, { to: '::/0', via: '2001:db8::1' }], nameservers: { addresses: ['1.1.1.1', '9.9.9.9'] } } } } }),
  userdata: `#cloud-config\n${JSON.stringify({ hostname: 'web1', ssh_authorized_keys: ['ssh-ed25519 AAAA test@host'] })}` };

test('discovery describes the node, storage, bridges and VMs the way the panel stores them', async () => {
  const { api } = cluster();
  const d = await h.discover(api);
  assert.equal(d.product.kind, 'proxmox'); assert.equal(d.product.instanceUuid, 'pve-lab'); assert.equal(d.writeApi, 'available');
  assert.equal(d.operations.cloneFromImage, true); assert.equal(d.operations.firewall, false); assert.equal(d.compat.customization, 'cloudinit');
  assert.deepEqual(d.hosts.map((x) => [x.moref, x.parent, x.cpuMhz, x.cpuCores, x.hardwareUuid]), [['pve1', 'pve1', 3000, 4, 'pve-lab:pve1']]);
  assert.deepEqual(d.compute.map((x) => [x.moref, x.kind, x.resourcePool]), [['pve1', 'standalone', 'pve1']]);
  assert.deepEqual(d.datastores.map((x) => [x.moref, x.freeBytes, x.accessible, x.hosts]), [['local-lvm@pve1', 400 * GIB, true, ['pve1']]], 'storage without disk images is left out');
  assert.deepEqual(d.networks, [{ moref: 'vmbr0', name: 'vmbr0', kind: 'standard', vlan: null, switch: 'bridge' }]);
  assert.deepEqual(d.vms.map((x) => [x.moref, x.template, x.powerState]), [['100', true, 'poweredOff'], ['101', false, 'poweredOn']]);
  for (const k of ['licenses', 'warnings', 'hosts', 'datastores', 'networks', 'compute', 'vms']) assert.ok(Array.isArray(d[k]), `${k} is an array`);
});

test('cloud-init documents become Proxmox settings', () => {
  const s = h.cloudInitSettings(order.metadata, order.userdata);
  assert.equal(s.ipconfig0, 'ip=203.0.113.20/24,gw=203.0.113.1,ip6=2001:db8::10/64,gw6=2001:db8::1');
  assert.equal(s.nameserver, '1.1.1.1 9.9.9.9');
  assert.equal(decodeURIComponent(s.sshkeys), 'ssh-ed25519 AAAA test@host');
  assert.deepEqual(h.cloudInitSettings('', 'not json'), {});
});

test('a clone is copied, then given its size, network and cloud-init when the copy ends; a retry finds it', async () => {
  const { c, api } = cluster();
  const started = await h.clone(api, order);
  assert.equal(started.existed, false); assert.match(started.task, /^UPID:pve1:.*\|105$/);
  const done = await h.task(api, { task: started.task });
  assert.deepEqual(done, { state: 'success', vm: '105' });
  const cfg = c.vms[105].config;
  assert.equal(cfg.cores, 4); assert.equal(cfg.memory, 4096); assert.match(cfg.scsi0, /size=40G/);
  assert.equal(cfg.net0, 'virtio=BC:24:11:00:00:01,firewall=1,bridge=vmbr1');
  assert.equal(cfg.ipconfig0, 'ip=203.0.113.20/24,gw=203.0.113.1,ip6=2001:db8::10/64,gw6=2001:db8::1');
  assert.equal(cfg.ide2, 'local-lvm:cloudinit', 'a template without a cloud-init drive gets one');
  assert.equal(cfg.description, `Managed by Lightning VM (server ${serverId})`, 'the pending settings are gone from the notes');
  assert.deepEqual(await h.clone(api, order), { vm: '105', existed: true });
  const found = (await h.find(api, { name: order.name })).vm;
  assert.equal(found.moref, '105'); assert.equal(found.serverId, serverId); assert.equal(found.powerState, 'poweredOff');
  await h.powerAction(api, { vm: '105', action: 'on' });
  const up = (await h.find(api, { name: order.name })).vm;
  assert.deepEqual([up.powerState, up.toolsRunning, up.ips], ['poweredOn', true, ['203.0.113.20']]);
  assert.deepEqual(await h.powerAction(api, { vm: '105', action: 'on' }), { task: '' }, 'already on: nothing to do');
});

test('a smaller disk than the template, a missing template and a foreign VM are refused', async () => {
  const { api } = cluster();
  await assert.rejects(h.clone(api, { ...order, diskGb: 5 }), { code: 'DISK_SMALLER_THAN_TEMPLATE' });
  await assert.rejects(h.clone(api, { ...order, template: '999' }), { code: 'TEMPLATE_NOT_FOUND' });
  await assert.rejects(h.clone(api, { ...order, name: 'web1' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.destroy(api, { vm: '101' }), { code: 'NOT_MANAGED' });
  assert.deepEqual(await h.destroy(api, { vm: '999' }), { task: '', gone: true });
  assert.deepEqual((await h.managedVms(api)).vms, []);
});

test('snapshots keep the name the customer gave and get the ids the panel expects', async () => {
  const { c, api } = cluster();
  await h.task(api, { task: (await h.clone(api, order)).task });
  const made = await h.snapshot(api, { vm: '105', action: 'create', name: 'before the upgrade', description: 'ticket 42' });
  assert.match(made.task, /^UPID/); assert.match(c.vms[105].snapshots[0].name, /^lvm\d+$/);
  const [s] = (await h.snapshots(api, { vm: '105' })).snapshots;
  assert.match(s.id, /^snapshot-\d{1,12}$/); assert.equal(s.name, 'before the upgrade'); assert.equal(s.description, 'ticket 42'); assert.equal(s.current, true);
  await assert.rejects(h.snapshot(api, { vm: '105', action: 'revert', snapshot: 'snapshot-1' }), { code: 'SNAPSHOT_NOT_FOUND' });
  await h.snapshot(api, { vm: '105', action: 'remove', snapshot: s.id });
  assert.deepEqual((await h.snapshots(api, { vm: '105' })).snapshots, []);
});

test('disks: listed with stable keys, added on the storage of the system disk, removed with their volume', async () => {
  const { c, api } = cluster();
  await h.task(api, { task: (await h.clone(api, order)).task });
  assert.deepEqual((await h.disks(api, { vm: '105' })).disks, [{ key: 200, label: 'scsi0', sizeGb: 40, system: true }]);
  assert.match((await h.diskAdd(api, { vm: '105', sizeGb: 20 })).task, /^UPID/);
  assert.deepEqual((await h.disks(api, { vm: '105' })).disks.map((d) => [d.key, d.sizeGb, d.system]), [[200, 40, true], [201, 20, false]]);
  await assert.rejects(h.diskRemove(api, { vm: '105', key: 200 }), { code: 'SYSTEM_DISK' });
  assert.deepEqual(await h.diskRemove(api, { vm: '105', key: 201 }), { task: '' });
  assert.equal(c.vms[105].config.scsi1, undefined); assert.equal(c.vms[105].config.unused0, undefined);
  assert.deepEqual(await h.diskRemove(api, { vm: '105', key: 201 }), { task: '', gone: true });
});

test('resize changes CPU, memory and grows the disk; shrinking is refused', async () => {
  const { c, api } = cluster();
  await h.task(api, { task: (await h.clone(api, order)).task });
  assert.match((await h.resize(api, { vm: '105', vcpu: 8, memoryMb: 8192, diskGb: 60 })).task, /^UPID:pve1:.*:resize:/, 'growing the disk is a task the worker waits for');
  assert.deepEqual(await h.resize(api, { vm: '105', vcpu: 8, memoryMb: 8192, diskGb: 60 }), { task: '' }, 'nothing to grow: done at once');
  assert.deepEqual([c.vms[105].config.cores, c.vms[105].config.memory], [8, 8192]); assert.match(c.vms[105].config.scsi0, /size=60G/);
  await assert.rejects(h.resize(api, { vm: '105', vcpu: 8, memoryMb: 8192, diskGb: 10 }), { code: 'DISK_SHRINK_NOT_SUPPORTED' });
});

test('details, metrics, topology and the power report have the shapes the panel reads', async () => {
  const { api } = cluster();
  await h.task(api, { task: (await h.clone(api, order)).task });
  await h.powerAction(api, { vm: '105', action: 'on' });
  const d = await h.details(api, { vm: '105' });
  assert.equal(d.cpu.count, 4); assert.equal(d.memory.sizeMb, 4096); assert.equal(d.nics[0].network, 'vmbr1'); assert.deepEqual(d.nics[0].ips, ['203.0.113.20/24']);
  assert.deepEqual(d.guest.ips, ['203.0.113.20']); assert.equal(d.disks[0].capacityGb, 40); assert.equal(d.placement.host, 'pve1');
  const m = await h.metrics(api, { vm: '105' });
  assert.deepEqual(m.samples[0], { t: '2023-11-14T22:13:20.000Z', cpu: 50, mem: 50, net: 3, disk: 4 });
  const t = await h.topology(api);
  assert.deepEqual(t.vms.map((v) => [v.moref, v.host, v.power]), [['105', 'pve1', 'poweredOn']]); assert.equal(t.otherVms, 1); assert.equal(t.compute[0].kind, 'host');
  const p = await h.powerReport(api);
  assert.equal(p.hosts[0].coreMhz, 3000); assert.equal(p.hosts[0].watts, null);
  assert.deepEqual(p.vms[0].traffic, [{ t: '2023-11-14T22:13:20.000Z', rx: 6, tx: 3 }], 'a minute of traffic counted as three 20-second samples');
});

test('the service wants its token, answers unsupported routes clearly and passes failures on as codes', async () => {
  const { api } = cluster();
  const token = 't'.repeat(40);
  const server = http.createServer(handler(token, { transport: api })).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, auth = `Bearer ${token}`) => fetch(base + path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  try {
    assert.deepEqual(await fetch(`${base}/healthz`).then((r) => r.json()), { status: 'ok' });
    assert.deepEqual(await post('/v1/vm/find', { host: 'pve', username: 'root@pam', name: 'x' }, 'Bearer wrong'), [401, { code: 'UNAUTHORIZED', message: 'service token required' }]);
    assert.deepEqual(await post('/v1/vm/find', { host: 'pve', username: 'root@pam', name: 'nobody' }), [200, { vm: null }]);
    assert.equal((await post('/v1/vm/firewall', { host: 'pve', username: 'root@pam' }))[1].code, 'PLATFORM_NOT_SUPPORTED');
    const missing = await post('/v1/vm/details', { host: 'pve', username: 'root@pam', vm: '999' });
    assert.deepEqual([missing[0], missing[1].code], [404, 'VM_NOT_FOUND']);
    assert.equal((await post('/v1/vm/find', { username: 'root@pam', name: 'x' }))[1].code, 'INVALID_REQUEST', 'a host is required');
  } finally { server.close(); }
});

test('after the first boot the guest agent sets what cloud-init on Proxmox cannot carry, once', async () => {
  const { c, api } = cluster();
  await h.task(api, { task: (await h.clone(api, order)).task });
  const userdata = `#cloud-config\n${JSON.stringify({ hostname: 'web1', chpasswd: { expire: false, list: 'root:$6$salt$hashhashhash' },
    write_files: [{ path: '/root/lightning-app.sh', permissions: '0700', content: "echo it's here" }], runcmd: [['sh', '-c', 'nohup sh /root/lightning-app.sh > /var/log/app.log 2>&1 &']] })}`;
  assert.deepEqual(await h.guestSetup(api, { vm: '105', userdata }), { applied: false, reason: 'NO_GUEST_AGENT' }, 'a stopped server cannot be reached');
  await h.powerAction(api, { vm: '105', action: 'on' });
  assert.deepEqual(await h.guestSetup(api, { vm: '105', userdata }), { applied: true, password: true, files: 1, commands: 1 });
  const [pw, file, script, exec] = c.agent;
  assert.deepEqual(pw, ['set-user-password', { username: 'root', password: '$6$salt$hashhashhash', crypted: 1 }], 'the hash is handed over as a hash');
  assert.deepEqual(file, ['file-write', { file: '/root/lightning-app.sh', content: "echo it's here" }]);
  assert.equal(script[1].file, '/root/.lightning-guest-setup.sh');
  assert.ok(script[1].content.startsWith('#!/bin/sh\n'));
  assert.ok(script[1].content.includes('[ -e /var/lib/lightning-guest-setup.done ] && exit 0'), 'a second run does nothing');
  assert.ok(script[1].content.includes("hostnamectl set-hostname 'web1'")); assert.ok(script[1].content.includes("chmod 0700 '/root/lightning-app.sh'"));
  assert.ok(script[1].content.includes("'sh' '-c' 'nohup sh /root/lightning-app.sh > /var/log/app.log 2>&1 &'"));
  assert.deepEqual(exec, ['exec', { command: ['sh', '/root/.lightning-guest-setup.sh'] }]);
  assert.deepEqual(await h.guestSetup(api, { vm: '105', userdata: '#cloud-config\n{}' }), { applied: false, reason: 'NOTHING_TO_DO' });
});

test('quoting keeps a single quote in a command harmless', async () => {
  const { c, api } = cluster();
  await h.task(api, { task: (await h.clone(api, order)).task });
  await h.powerAction(api, { vm: '105', action: 'on' });
  await h.guestSetup(api, { vm: '105', userdata: `#cloud-config\n${JSON.stringify({ runcmd: [['echo', "it's; rm -rf /"]] })}` });
  assert.ok(c.agent.find((x) => x[0] === 'file-write')[1].content.includes(`'echo' 'it'\\''s; rm -rf /'`));
});
