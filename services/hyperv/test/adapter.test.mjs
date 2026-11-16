// The adapter against a pretend Hyper-V host that answers by script name (the PowerShell itself is checked with
// the real parser and, for what needs no Hyper-V, run on Windows: see docs/hyperv.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as h from '../handlers.mjs';
import { CLONE_WORKER, names, script } from '../scripts.mjs';
import { handler, routes } from '../server.mjs';
import { account, addressGuard, envelope, Failure, md4, ntlmAuthenticate, ntlmNegotiate, ntlmV2Hash, scriptFailure } from '../winrm.mjs';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function host() {
  const calls = [];
  const db = { vms: [{ id: guid(11), name: 'template-ubuntu-24', power: 'poweredOff', cpu: 2, memory: 2 * GIB, template: true, generation: 2, cpuUsage: 0, memoryAssigned: 0, uptime: 0 },
    { id: guid(12), name: 'someone-else', power: 'poweredOn', cpu: 1, memory: GIB, template: false, generation: 2, cpuUsage: 50, memoryAssigned: GIB, uptime: 900 }], snapshots: {}, disks: {}, tasks: {} };
  const ps = async () => { throw new Error('the fake host answers by name'); };
  ps.named = async (name, p = {}) => {
    calls.push([name, p]);
    const vm = () => { const v = db.vms.find((x) => x.id === p.vm); if (!v) throw new Failure('VM_NOT_FOUND', 'the VM no longer exists'); return v; };
    const state = (v) => ({ moref: v.id, name: v.name, powerState: v.power, toolsRunning: v.power === 'poweredOn', ips: v.power === 'poweredOn' ? ['203.0.113.20'] : [], serverId: v.serverId ?? '' });
    if (name === 'discover') return { name: 'HV01', uuid: 'HW-UUID-1', vendor: 'Test', model: 'Box', cpuName: 'Test CPU', mhz: 3000, cores: 8, threads: 16, memory: 64 * GIB, freeMemory: 40 * GIB, os: 'Microsoft Windows Server 2022 Datacenter',
      version: '10.0.20348', build: '20348', defaultDisk: 'C:\\Hyper-V', volumes: [{ letter: 'C', label: 'System', size: 200 * GIB, free: 100 * GIB }, { letter: 'D', label: 'VMs', size: 2000 * GIB, free: 1500 * GIB }],
      switches: { id: guid(5), name: 'External', type: 'External' }, vms: db.vms }; // one switch: PowerShell gives an object, not a list
    if (name === 'find') { const v = db.vms.find((x) => x.name === p.name); return { vm: v ? state(v) : null }; }
    if (name === 'managed') return { vms: db.vms.filter((v) => v.name.startsWith('lvm-')).map(state) };
    if (name === 'clone') {
      const earlier = db.vms.find((v) => v.name === p.name); if (earlier) return { vm: earlier.id, existed: true };
      if (!db.vms.some((v) => v.id === p.template)) throw new Failure('TEMPLATE_NOT_FOUND', 'the template no longer exists');
      const id = guid(900 + Object.keys(db.tasks).length); db.tasks[id] = { state: 'running', job: p }; return { task: id, existed: false };
    }
    if (name === 'task') { const t = db.tasks[p.task]; if (!t) return { state: 'unknown', code: 'TASK_NOT_FOUND' }; const { job: _j, ...rest } = t; return rest; }
    if (name === 'power') { const v = vm(); const want = p.action === 'on' || p.action === 'reset' ? 'poweredOn' : 'poweredOff'; if (v.power === want && p.action !== 'reset') return { task: '' }; v.power = want; return { task: '' }; }
    if (name === 'destroy') { const v = db.vms.find((x) => x.id === p.vm); if (!v) return { task: '', gone: true }; if (!v.name.startsWith('lvm-')) throw new Failure('NOT_MANAGED', 'x'); db.vms = db.vms.filter((x) => x !== v); return { task: '' }; }
    if (name === 'resize') { Object.assign(vm(), { cpu: p.vcpu, memory: p.memoryMb * MIB }); db.disks[p.vm][0].size = p.diskGb * GIB; return { task: '' }; }
    if (name === 'rename') { const v = vm(); v.name = p.name; return { name: p.name, diskGb: 40 }; }
    if (name === 'disks') return { disks: db.disks[vm().id] };
    if (name === 'diskAdd') { db.disks[vm().id].push({ key: db.disks[p.vm].length, path: `D:\\LightningVM\\x\\disk${db.disks[p.vm].length}.vhdx`, size: p.sizeGb * GIB, controller: 'SCSI 0:1', bus: 'scsi' }); return { task: '' }; }
    if (name === 'diskRemove') { const before = db.disks[vm().id].length; db.disks[p.vm] = db.disks[p.vm].filter((d) => d.key !== p.key); return before === db.disks[p.vm].length ? { task: '', gone: true } : { task: '' }; }
    if (name === 'snapshots') return { snapshots: db.snapshots[vm().id] ?? [] };
    if (name === 'snapshot') { const list = (db.snapshots[vm().id] ??= []);
      if (p.action === 'create') list.push({ id: guid(700 + list.length), name: p.name, notes: '', created: '2024-01-01T10:00:00.0000000Z', parent: '', current: true });
      else if (p.action === 'remove') db.snapshots[p.vm] = list.filter((s) => s.id !== p.snapshot);
      return { task: '' }; }
    if (name === 'details') { const v = vm(); return { state: state(v), notes: `Managed by Lightning VM (server ${v.serverId})\nlvm-ips=203.0.113.20`, generation: 2, version: '10.0', secureBoot: true, uptime: 120, cpu: v.cpu, cpuUsage: 10,
      memoryStartup: v.memory, memoryAssigned: v.memory, memoryDemand: 512 * MIB, dynamicMemory: false, snapshots: 0, nics: { name: 'Network Adapter', mac: '00155D000001', dynamic: true, switch: 'External', connected: true, vlan: 0, ips: ['203.0.113.20'] },
      disks: db.disks[v.id], dvds: [{ path: 'D:\\LightningVM\\x\\cidata.iso' }], guestOs: 'Ubuntu 24.04', host: 'HV01', path: 'D:\\LightningVM\\x' }; }
    throw new Error(`fake host: ${name}`);
  };
  // The background task on the host finishes: the VM exists.
  const finish = (task, serverId) => { const j = db.tasks[task].job; const id = guid(300 + db.vms.length); db.vms.push({ id, name: j.name, power: 'poweredOff', cpu: j.vcpu, memory: j.memoryMb * MIB, template: false, generation: 2, serverId });
    db.disks[id] = [{ key: 0, path: `${j.datastore}:\\LightningVM\\${j.name}\\disk0.vhdx`, size: j.diskGb * GIB, controller: 'SCSI 0:0', bus: 'scsi' }]; db.tasks[task] = { state: 'success', vm: id }; return id; };
  return { db, ps, calls, finish };
}
const serverId = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f';
const order = { name: `lvm-${serverId}`, serverId, template: guid(11), pool: 'HW-UUID-1', datastore: 'D', network: guid(5), vcpu: 4, memoryMb: 4096, diskGb: 40,
  metadata: JSON.stringify({ 'instance-id': serverId, 'local-hostname': 'web1', network: { version: 2, ethernets: { nic0: { addresses: ['203.0.113.20/24'], routes: [{ to: 'default', via: '203.0.113.1' }] } } } }),
  userdata: `#cloud-config\n${JSON.stringify({ hostname: 'web1', ssh_authorized_keys: ['ssh-ed25519 AAAA test@host'] })}` };

test('discovery describes the host, its drives, switches and VMs the way the panel stores them', async () => {
  const { ps } = host();
  const d = await h.discover(ps);
  assert.deepEqual([d.product.kind, d.product.fullName, d.product.instanceUuid], ['hyperv', 'Microsoft Windows Server 2022 Datacenter (Hyper-V)', 'HW-UUID-1']);
  assert.deepEqual(d.hosts.map((x) => [x.moref, x.parent, x.cpuMhz, x.cpuCores, x.cpuThreads, x.memoryBytes]), [['HW-UUID-1', 'HW-UUID-1', 3000, 8, 16, 64 * GIB]]);
  assert.deepEqual(d.compute, [{ moref: 'HW-UUID-1', name: 'HV01', kind: 'standalone', hosts: 1, effectiveCpuMhz: 24000, effectiveMemoryMb: 65536, resourcePool: 'HW-UUID-1' }]);
  assert.deepEqual(d.datastores.map((x) => [x.moref, x.name, x.freeBytes]), [['C', 'C: (System)', 100 * GIB], ['D', 'D: (VMs)', 1500 * GIB]]);
  assert.deepEqual(d.networks, [{ moref: guid(5), name: 'External', kind: 'standard', vlan: null, switch: 'External' }], 'a single switch still makes a list');
  assert.deepEqual(d.vms.map((x) => [x.name, x.template, x.powerState]), [['template-ubuntu-24', true, 'poweredOff'], ['someone-else', false, 'poweredOn']]);
  for (const k of ['licenses', 'warnings', 'hosts', 'datastores', 'networks', 'compute', 'vms']) assert.ok(Array.isArray(d[k]));
});

test('a clone starts a background task on the host with the config drive and the worker script; the task reports the VM', async () => {
  const e = host();
  const started = await h.clone(e.ps, order);
  assert.equal(started.existed, false);
  const job = e.calls.at(-1)[1];
  assert.deepEqual([job.name, job.template, job.datastore, job.network, job.vcpu, job.memoryMb, job.diskGb], [order.name, guid(11), 'D', guid(5), 4, 4096, 40]);
  assert.equal(job.notes, `Managed by Lightning VM (server ${serverId})\nlvm-ips=203.0.113.20`);
  // The interface gets an address made from the server's id (the same on every try), and the config drive names it by that.
  assert.equal(job.mac, '021 55D'.replace(' ', '') + h.macOf(serverId).slice(9).replace(/:/g, '').toUpperCase()); assert.match(job.mac, /^02155D[0-9A-F]{6}$/);
  await h.clone(e.ps, { ...order, name: 'lvm-again' }); assert.equal(e.calls.at(-1)[1].mac, job.mac, 'a retry gives the same address');
  const iso = Buffer.from(job.iso, 'base64');
  assert.ok(iso.includes(Buffer.from(`"match":{"macaddress":"${h.macOf(serverId)}"}`)) && iso.includes(Buffer.from('"set-name":"eth0"')) && iso.includes(Buffer.from('"to":"0.0.0.0/0"')) && !iso.includes(Buffer.from('"to":"default"')));
  assert.equal(iso.subarray(16 * 2048 + 40, 16 * 2048 + 46).toString(), 'cidata'); assert.ok(iso.includes(Buffer.from('ssh-ed25519 AAAA test@host')));
  assert.equal(Buffer.from(job.worker, 'base64').toString(), CLONE_WORKER);
  assert.deepEqual(await h.task(e.ps, { task: started.task }), { state: 'running' });
  const id = e.finish(started.task, serverId);
  assert.deepEqual(await h.task(e.ps, { task: started.task }), { state: 'success', vm: id });
  assert.deepEqual(await h.task(e.ps, { task: guid(1) }), { state: 'unknown', code: 'TASK_NOT_FOUND' });
  assert.deepEqual(await h.clone(e.ps, order), { vm: id, existed: true });
  assert.deepEqual((await h.find(e.ps, { name: order.name })).vm, { moref: id, name: order.name, powerState: 'poweredOff', toolsRunning: false, ips: [], serverId });
  assert.equal((await h.find(e.ps, { name: 'lvm-nobody' })).vm, null);
  await h.powerAction(e.ps, { vm: id, action: 'on' });
  assert.deepEqual((await h.find(e.ps, { name: order.name })).vm.ips, ['203.0.113.20']);
  await assert.rejects(h.clone(e.ps, { ...order, name: 'lvm-x', template: guid(999) }), { code: 'TEMPLATE_NOT_FOUND' });
  await assert.rejects(h.clone(e.ps, { ...order, name: 'lvm-bad name' }), { code: 'INVALID_REQUEST' }, 'a name that could break a path is refused before it reaches the host');
  await assert.rejects(h.clone(e.ps, { ...order, name: 'web1' }), { code: 'INVALID_REQUEST' });
});

test('the network settings are rewritten for a guest without netplan, and bound to the interface by its address', () => {
  const panel = { version: 2, ethernets: { nic0: { match: { name: 'e*' }, addresses: ['203.0.113.20/24', '2001:db8::20/64'],
    routes: [{ to: 'default', via: '203.0.113.1' }, { to: '::/0', via: '2001:db8::1', 'on-link': true }, { to: '10.0.0.0/8', via: '203.0.113.2' }], nameservers: { addresses: ['1.1.1.1'] } } } };
  const before = JSON.stringify(panel);
  assert.deepEqual(h.guestNetwork(panel, '02:15:5d:00:00:01'), { version: 2, ethernets: { eth0: { match: { macaddress: '02:15:5d:00:00:01' }, 'set-name': 'eth0', addresses: ['203.0.113.20/24', '2001:db8::20/64'],
    routes: [{ to: '0.0.0.0/0', via: '203.0.113.1' }, { to: '10.0.0.0/8', via: '203.0.113.2' }], gateway6: '2001:db8::1', nameservers: { addresses: ['1.1.1.1'] } } } });
  assert.equal(JSON.stringify(panel), before, 'what the panel sent is left alone');
  assert.deepEqual(h.guestNetwork({ version: 2 }, 'x'), { version: 2 });
  assert.match(h.macOf('a'), /^02:15:5d(:[0-9a-f]{2}){3}$/); assert.equal(h.macOf('a'), h.macOf('a')); assert.notEqual(h.macOf('a'), h.macOf('b'));
  assert.equal(h.driveFiles(JSON.stringify({ network: panel }), '', 'id', '02:15:5d:00:00:01').files['network-config'].includes('"set-name":"eth0"'), true);
});

test('disks, snapshots, resize and delete', async () => {
  const e = host();
  const id = e.finish((await h.clone(e.ps, order)).task, serverId);
  assert.deepEqual((await h.disks(e.ps, { vm: id })).disks, [{ key: 0, label: 'disk0.vhdx', sizeGb: 40, system: true }]);
  await h.diskAdd(e.ps, { vm: id, sizeGb: 20 });
  assert.deepEqual((await h.disks(e.ps, { vm: id })).disks.map((d) => [d.key, d.sizeGb, d.system]), [[0, 40, true], [1, 20, false]]);
  assert.deepEqual(await h.diskRemove(e.ps, { vm: id, key: 1 }), { task: '' }); assert.deepEqual(await h.diskRemove(e.ps, { vm: id, key: 1 }), { task: '', gone: true });
  await assert.rejects(h.diskAdd(e.ps, { vm: id, sizeGb: 0 }), { code: 'INVALID_REQUEST' });
  await h.snapshot(e.ps, { vm: id, action: 'create', name: 'before the upgrade' });
  const [s] = (await h.snapshots(e.ps, { vm: id })).snapshots;
  assert.match(s.id, /^snapshot-\d{1,12}$/); assert.deepEqual([s.name, s.created, s.current], ['before the upgrade', '2024-01-01T10:00:00.000Z', true]);
  await assert.rejects(h.snapshot(e.ps, { vm: id, action: 'revert', snapshot: 'snapshot-1' }), { code: 'SNAPSHOT_NOT_FOUND' });
  await h.snapshot(e.ps, { vm: id, action: 'revert', snapshot: s.id });
  assert.deepEqual(e.calls.at(-1), ['snapshot', { vm: id, action: 'revert', snapshot: guid(700) }], 'the panel\'s id is turned back into the checkpoint\'s own');
  await h.snapshot(e.ps, { vm: id, action: 'remove', snapshot: s.id });
  assert.deepEqual((await h.snapshots(e.ps, { vm: id })).snapshots, []);
  await h.resize(e.ps, { vm: id, vcpu: 8, memoryMb: 8192, diskGb: 60 });
  assert.deepEqual(e.calls.at(-1), ['resize', { vm: id, vcpu: 8, memoryMb: 8192, diskGb: 60 }]);
  await assert.rejects(h.resize(e.ps, { vm: id, vcpu: 0, memoryMb: 8192, diskGb: 60 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.destroy(e.ps, { vm: guid(12) }), { code: 'NOT_MANAGED' });
  assert.deepEqual(await h.destroy(e.ps, { vm: id }), { task: '' }); assert.deepEqual(await h.destroy(e.ps, { vm: id }), { task: '', gone: true });
});

test('details, topology and the power report have the shapes the panel reads', async () => {
  const e = host();
  const id = e.finish((await h.clone(e.ps, order)).task, serverId);
  await h.powerAction(e.ps, { vm: id, action: 'on' });
  const d = await h.details(e.ps, { vm: id });
  assert.deepEqual([d.cpu.count, d.memory.sizeMb, d.firmware, d.secureBoot, d.nics[0].mac, d.nics[0].network, d.nics[0].ips, d.guest.ips, d.disks[0].capacityGb, d.disks[0].datastore, d.placement.host],
    [4, 4096, 'efi', true, '00:15:5d:00:00:01', 'External', ['203.0.113.20'], ['203.0.113.20'], 40, 'D:', 'HV01']);
  assert.equal(d.annotation, `Managed by Lightning VM (server ${serverId})`, 'the adapter\'s own note line is not shown'); assert.deepEqual(d.cdroms, [{ label: 'CD/DVD drive 1', iso: 'D:\\LightningVM\\x\\cidata.iso', connected: true }]);
  const m = await h.metrics(e.ps, { vm: id });
  assert.deepEqual([m.interval, m.samples, m.quick.memoryActiveMb, m.quick.uptimeSeconds], [60, [], 512, 120]);
  const t = await h.topology(e.ps);
  assert.deepEqual(t.vms.map((v) => [v.name, v.power]), [[order.name, 'poweredOn']]); assert.equal(t.otherVms, 1);
  assert.deepEqual([t.hosts[0].cpuTotalMhz, t.hosts[0].memUsedMb, t.hosts[0].memTotalMb, t.compute[0].kind], [24000, 24 * 1024, 64 * 1024, 'host']);
  const p = await h.powerReport(e.ps);
  assert.deepEqual([p.hosts[0].coreMhz, p.hosts[0].watts, p.vms.map((v) => v.name)], [3000, null, [order.name]]);
});

test('every script carries its parameters, ends in one result line, and stays clear of JavaScript', () => {
  for (const n of names) {
    const s = script(n, { vm: guid(1), name: "lvm-it's", text: 'ünï €' });
    const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(s)[1];
    assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), { vm: guid(1), name: "lvm-it's", text: 'ünï €' }, `${n}: parameters survive as they are`);
    assert.ok(!s.includes('__BODY__') && !s.includes('__PARAMS__')); assert.ok(s.includes("'LVMOK '")); assert.ok(!/\$\{/.test(s), `${n}: no \${ in PowerShell`);
  }
  assert.ok(CLONE_WORKER.includes('__ID__') && CLONE_WORKER.includes('Add-VMDvdDrive'));
  // Stop-VM has no -Id (its parameter sets are -Name and -VM): the detached shutdown hands the VM over.
  assert.ok(!/Stop-VM -Id/.test(script('power')) && script('power').includes(`"Get-VM -Id '" + [string]$v.Id + "' | Stop-VM -Force`));
  // The note that marks a finished VM is the worker's last change, after the config drive; a failure removes what was made.
  assert.ok(CLONE_WORKER.indexOf('Set-VM -VM $vm -Notes $j.notes') > CLONE_WORKER.indexOf('Add-VMDvdDrive') && !/Set-VM @set[^\n]*Notes/.test(CLONE_WORKER));
  assert.match(CLONE_WORKER, /catch \{[\s\S]*Remove-VM -VM \$_ -Force[\s\S]*Remove-Item -LiteralPath \$j\.dir -Recurse/);
  assert.match(CLONE_WORKER, /Parameters\.ContainsKey\('AutomaticCheckpointsEnabled'\)/); assert.ok(!/-AutomaticCheckpointsEnabled/.test(CLONE_WORKER), 'never passed where Set-VM may not know it');
  assert.ok(CLONE_WORKER.includes("'disk0' + $ext") && CLONE_WORKER.includes('Set-VMNetworkAdapter -StaticMacAddress $j.mac'));
  // Deleting: no separate checkpoint merge, and a folder that stays is a failure.
  assert.ok(!script('destroy').includes('Remove-VMSnapshot') && /Unfolder \$dir 15\)\) \{ Fail 'HYPERV_ERROR'/.test(script('destroy')));
  // No addresses after four minutes: the given ones, also when the heartbeat is fine.
  assert.match(script('find'), /if \(\$ips\.Count\) \{[^\n]*\n\s*elseif \(\$v\.Uptime\.TotalSeconds -gt 240\) \{ \$s\.toolsRunning = \$true; \$s\.ips = @\(GivenIps \$v\) \}/);
  assert.throws(() => script('nope'), /no such script/);
});

test('NTLMv2 matches the published test values; messages are well formed', () => {
  const u = (s) => Buffer.from(s, 'utf16le');
  assert.equal(md4(u('Password')).toString('hex'), 'a4f49c406510bdcab6824ee7c30fd852');
  assert.equal(md4(Buffer.alloc(0)).toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.equal(md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toString('hex'), 'e33b4ddc9c38f2199c3e7b164fcc0536');
  assert.equal(ntlmV2Hash('User', 'Domain', 'Password').toString('hex'), '0c868a403bfd7a93a3001ef22ef02e3f');
  assert.deepEqual([account('LAB\\admin'), account('administrator')], [{ domain: 'LAB', user: 'admin' }, { domain: '', user: 'administrator' }]);
  const n = ntlmNegotiate(); assert.equal(n.toString('latin1', 0, 8), 'NTLMSSP\0'); assert.equal(n.readUInt32LE(8), 1);
  // The challenge of the specification's NTLMv2 example: server challenge 0123456789abcdef, target info "Domain" / "Server".
  const info = Buffer.concat([Buffer.from([2, 0, 12, 0]), u('Domain'), Buffer.from([1, 0, 12, 0]), u('Server'), Buffer.alloc(4)]);
  const c = Buffer.alloc(56 + info.length); c.write('NTLMSSP\0', 0, 'latin1'); c.writeUInt32LE(2, 8); c.writeUInt32LE(0x00088207, 20); Buffer.from('0123456789abcdef', 'hex').copy(c, 24); c.writeUInt16LE(info.length, 40); c.writeUInt16LE(info.length, 42); c.writeUInt32LE(56, 44); info.copy(c, 56);
  const a = ntlmAuthenticate(c, 'Domain\\User', 'Password', Buffer.alloc(8, 0xaa), -11644473600000); // the example's time is zero (the year 1601)
  assert.equal(a.readUInt32LE(8), 3);
  const field = (i) => a.subarray(a.readUInt32LE(16 + i * 8), a.readUInt32LE(16 + i * 8) + a.readUInt16LE(12 + i * 8));
  assert.equal(field(1).subarray(0, 16).toString('hex'), '68cd0ab851e51c96aabc927bebef6a1c', 'the NT proof of the specification\'s example');
  assert.equal(field(0).toString('hex'), '86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa', 'its LMv2 response');
  assert.deepEqual([field(2).toString('utf16le'), field(3).toString('utf16le')], ['Domain', 'User']);
  assert.throws(() => ntlmAuthenticate(Buffer.alloc(10), 'u', 'p'), { code: 'NOT_WINRM' });
});

test('script failures become contract codes; SOAP envelopes are escaped', () => {
  assert.deepEqual([scriptFailure('LVM:DISK_HAS_SNAPSHOTS:remove the checkpoints first').code, scriptFailure('LVM:VM_NOT_FOUND:gone').message], ['DISK_HAS_SNAPSHOTS', 'gone']);
  assert.equal(scriptFailure('New-VHD : There is not enough space on the disk.').code, 'INSUFFICIENT_RESOURCES');
  assert.equal(scriptFailure("Get-VM : The term 'Get-VM' is not recognized as the name of a cmdlet").code, 'NOT_HYPERV');
  assert.equal(scriptFailure('Access is denied.').code, 'PERMISSION_DENIED'); assert.equal(scriptFailure('something odd').code, 'HYPERV_ERROR');
  const xml = envelope('https://hv:5986/wsman', 'urn:x', { shell: 'A&B<1>', options: { WINRS_CODEPAGE: '65001' }, body: '<rsp:Shell/>' });
  assert.ok(xml.includes('<w:Selector Name="ShellId">A&amp;B&lt;1&gt;</w:Selector>')); assert.ok(xml.includes('<w:Option Name="WINRS_CODEPAGE">65001</w:Option>')); assert.ok(xml.includes('<s:Body><rsp:Shell/></s:Body>'));
});

test('a route that ran out of time leaves its connection open until the work itself has ended', async () => {
  const token = 't'.repeat(40), seen = [];
  let finish; const held = new Promise((r) => { finish = r; });
  const transport = Object.assign(async () => ({}), { named: async () => { seen.push('started'); await held; seen.push('ended'); return { vm: null }; }, close: () => seen.push('closed') });
  const server = http.createServer(handler(token, { transport })).listen(0);
  const kept = routes['/v1/vm/find']; routes['/v1/vm/find'] = [kept[0], 0.05];
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/vm/find`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ host: 'x', username: 'administrator', name: 'lvm-slow' }) });
    assert.deepEqual([r.status, (await r.json()).code], [502, 'TIMEOUT']);
    assert.deepEqual(seen, ['started'], 'not closed under the handler that is still working');
    finish(); await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ['started', 'ended', 'closed']);
  } finally { routes['/v1/vm/find'] = kept; server.close(); }
});

test('the service wants its token and answers unsupported routes clearly', async () => {
  const { ps } = host();
  const token = 't'.repeat(40);
  const server = http.createServer(handler(token, { transport: ps })).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, auth = `Bearer ${token}`) => fetch(base + path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  try {
    assert.deepEqual(await post('/v1/vm/find', { host: 'x', username: 'administrator', name: 'lvm-nobody' }, 'Bearer wrong'), [401, { code: 'UNAUTHORIZED', message: 'service token required' }]);
    assert.deepEqual(await post('/v1/vm/find', { host: 'x', username: 'administrator', name: 'lvm-nobody' }), [200, { vm: null }]);
    assert.equal((await post('/v1/vm/firewall', { host: 'x', username: 'administrator' }))[1].code, 'PLATFORM_NOT_SUPPORTED');
    const missing = await post('/v1/vm/details', { host: 'x', username: 'administrator', vm: guid(999) });
    assert.deepEqual([missing[0], missing[1].code], [404, 'VM_NOT_FOUND']);
  } finally { server.close(); }
});

test('the address guard refuses the adapter\'s own networks unless they are allowed', () => {
  const docker = { lo: [{ address: '127.0.0.1', cidr: '127.0.0.1/8', family: 'IPv4', internal: true }], eth0: [{ address: '172.18.0.5', cidr: '172.18.0.5/16', family: 'IPv4', internal: false }, { address: 'fd00:18::5', cidr: 'fd00:18::5/64', family: 'IPv6', internal: false }] };
  const guard = addressGuard({}, docker);
  assert.deepEqual([guard('172.18.0.3', 'ipv4'), guard('fd00:18::3', 'ipv6'), guard('127.0.0.1', 'ipv4'), guard('169.254.169.254', 'ipv4'), guard('203.0.113.9', 'ipv4'), guard('2001:db8::9', 'ipv6')], [false, false, false, false, true, true]);
  const allowed = addressGuard({ HYPERV_ALLOW_NETWORKS: '172.18.0.0/16', HYPERV_DENY_NETWORKS: '203.0.113.0/24' }, docker);
  assert.deepEqual([allowed('172.18.0.3', 'ipv4'), allowed('203.0.113.9', 'ipv4'), allowed('198.51.100.9', 'ipv4')], [true, false, true]);
});
