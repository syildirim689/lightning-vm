// The real shell scripts, run by bash against pretend libvirt tools (test/fake-host: virsh, virt-clone, virt-xml,
// qemu-img keep their "domains" as small files), through the same handlers the service uses. Linux only: the
// scripts are written for a KVM host's userland (GNU coreutils, setsid, /proc).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from '../handlers.mjs';
import { parse, sshFailure } from '../ssh.mjs';

const linux = process.platform === 'linux' && spawnSync('bash', ['-c', 'command -v setsid && command -v base64']).status === 0;
const tools = join(dirname(fileURLToPath(import.meta.url)), 'fake-host');
const GIB = 1024 ** 3;
const TEMPLATE = '00000000-0000-4000-8000-000000000001', SERVER = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f', NAME = `lvm-${SERVER}`;

// A fresh pretend host: one shut-down template with a 10 GB disk and a NIC, and one VM that is not the panel's.
function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'lvm-host-'));
  const dom = (name, uuid, st) => { const d = join(root, 'dom', name); mkdirSync(d, { recursive: true });
    for (const [k, v] of Object.entries({ uuid, state: st, vcpu: '2', mem: String(2 * 1024 * 1024), desc: '' })) writeFileSync(join(d, k), v ? `${v}\n` : '');
    writeFileSync(join(d, 'disks'), `vda disk ${root}/pool/${name}.qcow2\n`); writeFileSync(join(d, 'nics'), ' vnet0       network   default   virtio   52:54:00:00:00:01\n');
    writeFileSync(join(root, 'pool', `${name}.qcow2`), 'disk'); writeFileSync(join(root, 'pool', `${name}.qcow2.size`), String(10 * GIB)); };
  mkdirSync(join(root, 'pool'), { recursive: true }); mkdirSync(join(root, 'lvm'));
  dom('template-ubuntu-24', TEMPLATE, 'shut off'); dom('someone-else', '00000000-0000-4000-8000-000000000002', 'running');
  for (const f of readdirSync(tools)) chmodSync(join(tools, f), 0o755);
  const sh = (text) => new Promise((resolve, reject) => {
    const p = spawn('bash', ['-s'], { env: { PATH: `${tools}:${process.env.PATH}`, FAKE: root, LVM_ROOT: join(root, 'lvm') } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; }); p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (code) => { try { const rows = parse(stdout); if (!rows) throw sshFailure({ code, stdout, stderr }); resolve(rows); } catch (e) { reject(e); } });
    p.stdin.end(`echo LVMBEGIN\n${text}`);
  });
  return { root, sh, file: (...p) => join(root, ...p), close: () => rmSync(root, { recursive: true, force: true }) };
}
const order = { name: NAME, serverId: SERVER, template: TEMPLATE, pool: 'x', datastore: 'default', network: 'default', vcpu: 4, memoryMb: 4096, diskGb: 40,
  metadata: JSON.stringify({ 'local-hostname': 'web1', network: { version: 2, ethernets: { nic0: { addresses: ['203.0.113.20/24'] } } } }), userdata: "#cloud-config\n# it's \"quoted\" $HOME `id`\n{}\n" };
async function finished(sh, task) {
  for (let i = 0; i < 100; i++) { const t = await h.task(sh, { task }); if (t.state !== 'running') return t; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('the job never finished');
}

test('a server\'s whole life on a KVM host, through the real scripts', { skip: !linux && 'needs Linux' }, async () => {
  const f = fakeHost(), { sh } = f;
  try {
    const d = await h.discover(sh);
    assert.deepEqual(d.hosts.map((x) => [x.cpuCores, x.cpuThreads, x.cpuMhz, x.memoryBytes]), [[8, 16, 2400, 65536000 * 1024]]);
    assert.equal(d.product.version, '8.2.2'); assert.ok(d.product.instanceUuid);
    assert.deepEqual(d.datastores.map((x) => [x.moref, x.capacityBytes, x.freeBytes, x.accessible]), [['default', 1e12, 8e11, true]]);
    assert.deepEqual(d.networks, [{ moref: 'default', name: 'default', kind: 'standard', vlan: null, switch: 'virbr0' }]);
    assert.deepEqual(d.vms.map((v) => [v.name, v.template, v.powerState, v.cpu, v.memoryMb]).sort(), [['someone-else', false, 'poweredOn', 2, 2048], ['template-ubuntu-24', true, 'poweredOff', 2, 2048]]);
    assert.equal(d.operations.cloneFromImage, true);

    assert.deepEqual(await h.find(sh, { name: NAME }), { vm: null });
    await assert.rejects(h.clone(sh, { ...order, template: '00000000-0000-4000-8000-00000000dead' }), { code: 'TEMPLATE_NOT_FOUND' });
    await assert.rejects(h.clone(sh, { ...order, datastore: 'nope' }), { code: 'DATASTORE_NOT_FOUND' });
    await assert.rejects(h.clone(sh, { ...order, network: 'nope' }), { code: 'NETWORK_NOT_FOUND' });
    await assert.rejects(h.clone(sh, { ...order, diskGb: 5 }), { code: 'DISK_SMALLER_THAN_TEMPLATE' });
    assert.deepEqual(await h.task(sh, { task: '00000000-0000-4000-8000-00000000dead' }), { state: 'unknown', code: 'TASK_NOT_FOUND' });

    const started = await h.clone(sh, order);
    assert.match(started.task, /^[0-9a-f-]{36}$/);
    const done = await finished(sh, started.task);
    assert.equal(done.state, 'success');
    const vm = done.vm;
    assert.deepEqual(await h.clone(sh, order), { vm, existed: true });
    const iso = readFileSync(f.file('pool', `${NAME}-cidata.iso`));
    assert.equal(iso.subarray(32769, 32774).toString(), 'CD001'); assert.ok(iso.includes('it\'s "quoted" $HOME `id`'), 'the user data arrived byte for byte');
    assert.equal(readFileSync(f.file('dom', NAME, 'desc'), 'utf8'), `Managed by Lightning VM (server ${SERVER})\nlvm-ips=203.0.113.20`);

    assert.deepEqual((await h.find(sh, { name: NAME })).vm, { moref: vm, name: NAME, powerState: 'poweredOff', toolsRunning: false, ips: [], serverId: SERVER });
    assert.deepEqual(await h.powerAction(sh, { vm, action: 'on' }), { task: '' });
    assert.deepEqual(await h.powerAction(sh, { vm, action: 'on' }), { task: '' });
    writeFileSync(f.file('dom', NAME, 'agent'), '1'); // the guest agent answers
    assert.deepEqual((await h.find(sh, { name: NAME })).vm, { moref: vm, name: NAME, powerState: 'poweredOn', toolsRunning: true, ips: ['203.0.113.20'], serverId: SERVER });
    assert.deepEqual((await h.managedVms(sh)).vms.map((v) => v.name), [NAME]);

    const det = await h.details(sh, { vm });
    assert.equal(det.cpu.count, 4); assert.equal(det.memory.sizeMb, 4096); assert.equal(det.annotation, `Managed by Lightning VM (server ${SERVER})`);
    assert.deepEqual(det.disks.map((x) => [x.capacityGb, x.bus]), [[40, 'virtio']]);
    assert.deepEqual(det.cdroms.map((c) => c.iso), [f.file('pool', `${NAME}-cidata.iso`)]);
    assert.deepEqual(det.nics.map((n) => [n.mac, n.network, n.ips]), [['52:54:00:00:00:01', 'default', ['203.0.113.20']]]);
    assert.deepEqual(det.guest.ips, ['203.0.113.20']);

    assert.deepEqual(await h.diskAdd(sh, { vm, sizeGb: 20 }), { task: '' });
    assert.deepEqual((await h.disks(sh, { vm })).disks, [{ key: 0, label: `${NAME}.qcow2`, sizeGb: 40, system: true }, { key: 1, label: `${NAME}-vdb.qcow2`, sizeGb: 20, system: false }]);
    await assert.rejects(h.diskRemove(sh, { vm, key: 0 }), { code: 'SYSTEM_DISK' });
    assert.deepEqual(await h.diskRemove(sh, { vm, key: 1 }), { task: '' });
    assert.ok(!existsSync(f.file('pool', `${NAME}-vdb.qcow2`)), 'the removed disk\'s file is gone');
    assert.deepEqual(await h.diskRemove(sh, { vm, key: 1 }), { task: '', gone: true });

    await h.snapshot(sh, { vm, action: 'create', name: "before the 'big' upgrade", description: 'ağ ayarı & çekirdek' }, 1700000000000);
    const [snap] = (await h.snapshots(sh, { vm })).snapshots;
    assert.deepEqual([snap.id, snap.name, snap.description, snap.current], ['snapshot-1700000000', "before the 'big' upgrade", 'ağ ayarı & çekirdek', true]);
    await assert.rejects(h.resize(sh, { vm, vcpu: 8, memoryMb: 8192, diskGb: 60 }), { code: 'DISK_HAS_SNAPSHOTS' });
    await h.snapshot(sh, { vm, action: 'revert', snapshot: snap.id });
    assert.equal(readFileSync(f.file('log'), 'utf8'), 'reverted lvm1700000000\n');
    await h.snapshot(sh, { vm, action: 'remove', snapshot: snap.id });
    assert.deepEqual(await h.snapshots(sh, { vm }), { snapshots: [] });
    await assert.rejects(h.snapshot(sh, { vm, action: 'remove', snapshot: snap.id }), { code: 'SNAPSHOT_NOT_FOUND' });

    await assert.rejects(h.resize(sh, { vm, vcpu: 8, memoryMb: 8192, diskGb: 60 }), { code: 'INVALID_STATE' });
    await h.powerAction(sh, { vm, action: 'off' });
    await assert.rejects(h.resize(sh, { vm, vcpu: 8, memoryMb: 8192, diskGb: 20 }), { code: 'DISK_SHRINK_NOT_SUPPORTED' });
    assert.deepEqual(await h.resize(sh, { vm, vcpu: 8, memoryMb: 8192, diskGb: 60 }), { task: '' });
    const after = await h.details(sh, { vm });
    assert.deepEqual([after.cpu.count, after.memory.sizeMb, after.disks[0].capacityGb, after.powerState], [8, 8192, 60, 'poweredOff']);

    // Someone else's VM: read, never changed; taking it over needs it shut down.
    const other = '00000000-0000-4000-8000-000000000002';
    await assert.rejects(h.destroy(sh, { vm: other }), { code: 'NOT_MANAGED' });
    await assert.rejects(h.resize(sh, { vm: other, vcpu: 1, memoryMb: 1024, diskGb: 10 }), { code: 'NOT_MANAGED' });
    await assert.rejects(h.rename(sh, { vm: other, name: 'lvm-taken-over' }), { code: 'INVALID_STATE' });
    await assert.rejects(h.rename(sh, { vm: TEMPLATE, name: 'lvm-taken-over' }), { code: 'NOT_IMPORTABLE' });
    await h.powerAction(sh, { vm: other, action: 'off' });
    assert.deepEqual(await h.rename(sh, { vm: other, name: 'lvm-taken-over' }), { name: 'lvm-taken-over', diskGb: 10 });
    await assert.rejects(h.details(sh, { vm: '00000000-0000-4000-8000-00000000dead' }), { code: 'VM_NOT_FOUND' });

    assert.deepEqual(await h.destroy(sh, { vm }), { task: '' });
    assert.deepEqual(await h.destroy(sh, { vm }), { task: '', gone: true });
    assert.deepEqual(await h.find(sh, { name: NAME }), { vm: null });
    assert.deepEqual(readdirSync(f.file('pool')).filter((x) => x.startsWith(NAME) && !x.endsWith('.size')), [], 'nothing of the server is left in the pool');
  } finally { f.close(); }
});
