// The real shell scripts, run by bash against pretend libvirt tools (test/fake-host: virsh, virt-clone, virt-xml,
// qemu-img keep their "domains" as small files), through the same handlers the service uses. Linux only: the
// scripts are written for a KVM host's userland (GNU coreutils, setsid, /proc).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from '../handlers.mjs';
import { script } from '../scripts.mjs';
import { parse, sshFailure } from '../ssh.mjs';

const linux = process.platform === 'linux' && spawnSync('bash', ['-c', 'command -v setsid && command -v base64 && command -v pgrep']).status === 0;
const skip = !linux && 'needs Linux';
const tools = join(dirname(fileURLToPath(import.meta.url)), 'fake-host');
const GIB = 1024 ** 3;
const TEMPLATE = '00000000-0000-4000-8000-000000000001', OTHER = '00000000-0000-4000-8000-000000000002', SERVER = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f', NAME = `lvm-${SERVER}`;
const MAC = h.macOf(SERVER);

// A fresh pretend host: one shut-down template with a 10 GB disk and a NIC, and one VM that is not the panel's
// (whose disk has a space in its path).
function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'lvm-host-'));
  const dom = (name, uuid, st, file = `${name}.qcow2`) => { const d = join(root, 'dom', name); mkdirSync(d, { recursive: true });
    for (const [k, v] of Object.entries({ uuid, state: st, vcpu: '2', mem: String(2 * 1024 * 1024), desc: '' })) writeFileSync(join(d, k), v ? `${v}\n` : '');
    writeFileSync(join(d, 'disks'), `vda disk ${root}/pool/${file}\n`); writeFileSync(join(d, 'nics'), ' vnet0       network   default   virtio   52:54:00:00:00:01\n');
    writeFileSync(join(root, 'pool', file), 'disk'); writeFileSync(join(root, 'pool', `${file}.size`), String(10 * GIB)); };
  mkdirSync(join(root, 'pool'), { recursive: true }); mkdirSync(join(root, 'lvm'));
  dom('template-ubuntu-24', TEMPLATE, 'shut off'); dom('someone-else', OTHER, 'running', 'some one else.qcow2');
  for (const f of readdirSync(tools)) chmodSync(join(tools, f), 0o755);
  const sh = (text) => new Promise((resolve, reject) => {
    const p = spawn('bash', ['-s'], { env: { PATH: `${tools}:${process.env.PATH}`, FAKE: root, LVM_ROOT: join(root, 'lvm') } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; }); p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (code) => { try { const rows = parse(stdout); if (!rows) throw sshFailure({ code, stdout, stderr }); resolve(rows); } catch (e) { reject(e); } });
    p.stdin.end(`echo LVMBEGIN\n${text}`);
  });
  const file = (...p) => join(root, ...p);
  return { root, sh, file, calls: () => (existsSync(file('calls')) ? readFileSync(file('calls'), 'utf8').split('\n').filter(Boolean) : []),
    left: (name) => readdirSync(file('pool')).filter((x) => x.startsWith(name) && !x.endsWith('.size')), close: () => rmSync(root, { recursive: true, force: true }) };
}
const order = { name: NAME, serverId: SERVER, template: TEMPLATE, pool: 'x', datastore: 'default', network: 'default', vcpu: 4, memoryMb: 4096, diskGb: 40,
  metadata: JSON.stringify({ 'local-hostname': 'web1', network: { version: 2, ethernets: { nic0: { match: { name: 'e*' }, addresses: ['203.0.113.20/24'], routes: [{ to: 'default', via: '203.0.113.1' }] } } } }), userdata: "#cloud-config\n# it's \"quoted\" $HOME `id`\n{}\n" };
async function finished(sh, task) {
  for (let i = 0; i < 100; i++) { const t = await h.task(sh, { task }); if (t.state !== 'running') return t; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('the job never finished');
}
const until = async (what) => { for (let i = 0; i < 100; i++) { if (what()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('it never happened'); };

test('a server\'s whole life on a KVM host, through the real scripts', { skip }, async () => {
  const f = fakeHost(), { sh } = f;
  try {
    const d = await h.discover(sh);
    assert.deepEqual(d.hosts.map((x) => [x.cpuCores, x.cpuThreads, x.cpuMhz, x.memoryBytes]), [[8, 16, 2400, 65536000 * 1024]]);
    assert.equal(d.product.version, '8.2.2'); assert.ok(d.product.instanceUuid);
    assert.deepEqual(d.datastores.map((x) => [x.moref, x.capacityBytes, x.freeBytes, x.accessible]), [['default', 1e12, 8e11, true]]);
    assert.deepEqual(d.networks, [{ moref: 'default', name: 'default', kind: 'standard', vlan: null, switch: 'virbr0' }]);
    assert.deepEqual(d.vms.map((v) => [v.name, v.template, v.powerState, v.cpu, v.memoryMb]).sort(), [['someone-else', false, 'poweredOn', 2, 2048], ['template-ubuntu-24', true, 'poweredOff', 2, 2048]]);
    assert.equal(d.operations.cloneFromImage, true);
    assert.deepEqual(f.calls().filter((c) => c.startsWith('domstate')), [], 'whether a domain runs is read from the one dominfo call');

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
    assert.ok(iso.includes(`"match":{"macaddress":"${MAC}"}`) && iso.includes('"set-name":"eth0"') && iso.includes('"to":"0.0.0.0/0"'), 'the network settings name the interface by the address the domain was given');
    assert.equal(readFileSync(f.file('dom', NAME, 'desc'), 'utf8'), `Managed by Lightning VM (server ${SERVER})\nlvm-ips=203.0.113.20`);
    assert.equal(readFileSync(f.file('dom', NAME, 'cdbus'), 'utf8'), 'sata\n', 'the config drive is a SATA CD on a q35 machine, not whatever "sdz" would have meant');
    assert.deepEqual(readdirSync(f.file('lvm', 'tasks')).filter((x) => !x.endsWith('.status') && !x.endsWith('.sh')), [], 'the job left neither its note nor its name behind');

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
    assert.deepEqual(det.nics.map((n) => [n.mac, n.network, n.ips]), [[MAC, 'default', ['203.0.113.20']]]);
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

    // A start that fails is asked once, and what virsh said is what the panel gets.
    writeFileSync(f.file('dom', NAME, 'nostart'), '1');
    const before = f.calls().filter((c) => c === `start ${NAME}`).length;
    await assert.rejects(h.powerAction(sh, { vm, action: 'on' }), { code: 'LIBVIRT_ERROR', message: `error: Failed to start domain '${NAME}'` });
    assert.equal(f.calls().filter((c) => c === `start ${NAME}`).length, before + 1);
    rmSync(f.file('dom', NAME, 'nostart'));

    // Someone else's VM: read, never changed; taking it over needs it shut down. Its disk's path has a space.
    const theirs = await h.details(sh, { vm: OTHER });
    assert.deepEqual(theirs.disks.map((x) => [x.file, x.capacityGb]), [[f.file('pool', 'some one else.qcow2'), 10]]);
    await assert.rejects(h.destroy(sh, { vm: OTHER }), { code: 'NOT_MANAGED' });
    await assert.rejects(h.resize(sh, { vm: OTHER, vcpu: 1, memoryMb: 1024, diskGb: 10 }), { code: 'NOT_MANAGED' });
    await assert.rejects(h.rename(sh, { vm: OTHER, name: 'lvm-taken-over' }), { code: 'INVALID_STATE' });
    await assert.rejects(h.rename(sh, { vm: TEMPLATE, name: 'lvm-taken-over' }), { code: 'NOT_IMPORTABLE' });
    await h.powerAction(sh, { vm: OTHER, action: 'off' });
    assert.deepEqual(await h.rename(sh, { vm: OTHER, name: 'lvm-taken-over' }), { name: 'lvm-taken-over', diskGb: 10 });
    // A VM taken over carries no note of the panel and was never copied by it: it is there, and it is not copied over.
    assert.equal((await h.find(sh, { name: 'lvm-taken-over' })).vm.moref, OTHER);
    assert.deepEqual(await h.clone(sh, { ...order, name: 'lvm-taken-over' }), { vm: OTHER, existed: true });
    await assert.rejects(h.details(sh, { vm: '00000000-0000-4000-8000-00000000dead' }), { code: 'VM_NOT_FOUND' });

    // Deleting takes the extra disk along, which libvirt does not (it is no volume of the pool, only a file in its folder).
    await h.diskAdd(sh, { vm, sizeGb: 20 });
    assert.ok(existsSync(f.file('pool', `${NAME}-vdb.qcow2`)));
    assert.deepEqual(await h.destroy(sh, { vm }), { task: '' });
    assert.deepEqual(await h.destroy(sh, { vm }), { task: '', gone: true });
    assert.deepEqual(await h.find(sh, { name: NAME }), { vm: null });
    assert.deepEqual(f.left(NAME), [], 'nothing of the server is left in the pool');
  } finally { f.close(); }
});

test('a copy in flight is one task and not a server yet; a failed one leaves nothing, and what a dead one left is cleared', { skip }, async () => {
  const f = fakeHost(), { sh } = f;
  try {
    // virt-clone defines the domain before it copies: the name is there, the server is not.
    writeFileSync(f.file('clone-slow'), '');
    const started = await h.clone(sh, order);
    await until(() => existsSync(f.file('dom', NAME, 'uuid')));
    assert.deepEqual(await h.find(sh, { name: NAME }), { vm: null }, 'not there yet: the worker would start a half-copied disk');
    assert.deepEqual(await h.clone(sh, order), { task: started.task, existed: false }, 'asked again: the same task');
    assert.deepEqual(await h.task(sh, { task: started.task }), { state: 'running' });
    rmSync(f.file('clone-slow'));
    const done = await finished(sh, started.task);
    assert.equal(done.state, 'success');
    assert.deepEqual(await h.clone(sh, order), { vm: done.vm, existed: true });
    assert.equal((await h.find(sh, { name: NAME })).vm.moref, done.vm);
    await h.destroy(sh, { vm: done.vm });

    // A copy that fails: the job takes away what it made, and the next try starts from nothing.
    writeFileSync(f.file('clone-fails'), '');
    const failed = await finished(sh, (await h.clone(sh, order)).task);
    assert.deepEqual([failed.state, failed.code], ['error', 'INSUFFICIENT_RESOURCES']); assert.match(failed.error, /No space left/);
    assert.deepEqual([f.left(NAME), existsSync(f.file('dom', NAME)), existsSync(f.file('lvm', 'tasks', `${NAME}.task`))], [[], false, false]);
    assert.deepEqual(await h.find(sh, { name: NAME }), { vm: null });
    rmSync(f.file('clone-fails'));

    // A job that died after virt-clone (the host restarted): a domain without the note, its task file still there.
    const dead = '00000000-0000-4000-8000-0000000000aa', d = f.file('dom', NAME);
    mkdirSync(d); for (const [k, v] of Object.entries({ uuid: '00000000-0000-4000-8000-0000000000bb', state: 'shut off', vcpu: '2', mem: '2097152', desc: '', nics: '' })) writeFileSync(join(d, k), v ? `${v}\n` : '');
    writeFileSync(join(d, 'disks'), `vda disk ${f.root}/pool/${NAME}.qcow2\n`); writeFileSync(f.file('pool', `${NAME}.qcow2`), 'half'); writeFileSync(f.file('vols'), `${f.root}/pool/${NAME}.qcow2\n`);
    writeFileSync(f.file('lvm', 'tasks', `${NAME}.task`), `${dead}\n`); writeFileSync(f.file('lvm', 'tasks', `${dead}.status`), 'running\n');
    utimesSync(f.file('lvm', 'tasks', `${dead}.status`), new Date(Date.now() - 600e3), new Date(Date.now() - 600e3));
    assert.deepEqual(await h.find(sh, { name: NAME }), { vm: null });
    assert.equal((await h.task(sh, { task: dead })).state, 'error');
    const again = await h.clone(sh, order);
    assert.ok(again.task && again.task !== dead && !again.existed, 'not adopted: copied again');
    const redone = await finished(sh, again.task);
    assert.equal(redone.state, 'success'); assert.notEqual(redone.vm, '00000000-0000-4000-8000-0000000000bb');
    assert.equal(readFileSync(f.file('dom', NAME, 'desc'), 'utf8'), `Managed by Lightning VM (server ${SERVER})\nlvm-ips=203.0.113.20`);
    assert.equal(readFileSync(f.file('pool', `${NAME}.qcow2`), 'utf8'), 'disk', 'the whole disk, not the half one');

    // On the older PC machine type the config drive is an IDE CD.
    writeFileSync(f.file('dom', 'template-ubuntu-24', 'machine'), 'pc-i440fx-8.2\n');
    const second = '11111111-2222-4333-8444-555555555555';
    assert.equal((await finished(sh, (await h.clone(sh, { ...order, name: `lvm-${second}`, serverId: second })).task)).state, 'success');
    assert.equal(readFileSync(f.file('dom', `lvm-${second}`, 'cdbus'), 'utf8'), 'ide\n');
    assert.match(readFileSync(f.file('dom', `lvm-${second}`, 'nics'), 'utf8'), new RegExp(`${h.macOf(second)}\\s*$`));
  } finally { f.close(); }
});

test('no text a caller sends is run on the host or read as an option', { skip }, async () => {
  const f = fakeHost(), { sh } = f;
  const mark = f.file('pwned'), run = `touch ${mark}`;
  const hostile = [`"; ${run}; "`, `$(${run})`, `\`${run}\``, `'; ${run}; '`, `x\n${run}\n`, '--help', `-o$(${run})`];
  const job = { name: NAME, template: TEMPLATE, datastore: 'default', network: 'default', vcpu: 1, memoryMb: 1024, diskGb: 0, mac: MAC, notes: '', iso: Buffer.from('x').toString('base64') };
  const tried = async (name, p) => sh(script(name, p)).then((rows) => rows, (e) => e.code);
  try {
    // The note used to be written into the job script between double quotes: this ran as the SSH user.
    const notes = `Managed by Lightning VM (server ${SERVER})\nlvm-ips=1.1.1.1"; ${run}; echo "$(${run}) \`${run}\` \\`;
    const [[, , id]] = await tried('clone', { ...job, notes });
    assert.equal((await finished(sh, id)).state, 'success');
    assert.equal(readFileSync(f.file('dom', NAME, 'desc'), 'utf8'), notes, 'the note is the domain\'s description, character for character');
    const vm = readFileSync(f.file('dom', NAME, 'uuid'), 'utf8').trim();
    // Every parameter of every script that takes text, with every hostile value.
    for (const bad of hostile) {
      for (const k of ['name', 'template', 'datastore', 'network', 'vcpu', 'memoryMb', 'diskGb', 'mac', 'notes']) assert.ok(k === 'notes' || typeof (await tried('clone', { ...job, name: 'lvm-other', [k]: bad })) === 'string', `clone ${k}`);
      assert.deepEqual(await tried('find', { name: bad }), []);
      assert.deepEqual(await tried('destroy', { vm: bad }), [['R', 'gone']]);
      assert.equal(await tried('task', { task: bad }), 'INVALID_REQUEST');
      for (const s of ['power', 'details', 'disks', 'snapshots', 'resize', 'diskAdd']) assert.equal(await tried(s, { vm: bad, action: 'on', vcpu: 1, memoryMb: 1024, diskGb: 1, sizeGb: 1 }), 'INVALID_REQUEST', s);
      assert.equal(await tried('power', { vm, action: bad }), 'INVALID_REQUEST');
      assert.equal(await tried('rename', { vm, name: bad }), 'INVALID_REQUEST');
      assert.equal(await tried('resize', { vm, vcpu: bad, memoryMb: 1024, diskGb: 40 }), 'INVALID_REQUEST');
      assert.equal(await tried('diskAdd', { vm, sizeGb: bad }), 'INVALID_REQUEST');
      assert.deepEqual(await tried('diskRemove', { vm, target: bad }), [['R', 'gone']]);
      for (const action of ['revert', 'remove']) assert.equal(await tried('snapshot', { vm, action, snapname: bad, description: '' }), 'SNAPSHOT_NOT_FOUND');
      assert.equal(await tried('snapshot', { vm, action: 'create', snapname: bad, description: 'lvm:eA' }), 'INVALID_REQUEST');
      assert.equal(await tried('snapshot', { vm, action: 'create', snapname: 'lvm1', description: bad }), 'INVALID_REQUEST');
      assert.equal(await tried('snapshot', { vm, action: bad, snapname: 'lvm1', description: '' }), 'INVALID_REQUEST');
      // What the customer types, the way it really travels: packed by the handler, and back unchanged.
      await h.snapshot(sh, { vm, action: 'create', name: bad, description: bad }, 1700000000000 + hostile.indexOf(bad) * 1000);
      const made = (await h.snapshots(sh, { vm })).snapshots.at(-1);
      assert.deepEqual([made.name, made.description], [bad, bad]);
      await assert.rejects(h.rename(sh, { vm, name: `lvm-${bad}` }), (e) => ['INVALID_REQUEST', 'NOT_IMPORTABLE'].includes(e.code));
      await assert.rejects(h.clone(sh, { ...order, name: 'lvm-other', serverId: bad }), { code: 'INVALID_REQUEST' });
    }
    assert.ok(!existsSync(mark), 'nothing ran');
    assert.deepEqual(readdirSync(f.file('dom')).sort(), [NAME, 'someone-else', 'template-ubuntu-24'], 'and nothing else was made or removed');
  } finally { f.close(); }
});

test('a snapshot asked for twice is taken once; the same name again later is a new one', { skip }, async () => {
  const f = fakeHost(), { sh } = f;
  try {
    const vm = (await finished(sh, (await h.clone(sh, order)).task)).vm;
    const ask = { vm, action: 'create', name: 'before the upgrade', description: 'by hand' };
    // While libvirt is still writing one (it has a job on the domain), a second is not started.
    writeFileSync(f.file('dom', NAME, 'job'), '');
    await assert.rejects(h.snapshot(sh, ask, 1700000000000), { code: 'LIBVIRT_ERROR', message: /busy/ });
    rmSync(f.file('dom', NAME, 'job'));
    await h.snapshot(sh, ask, 1700000000000);
    await h.snapshot(sh, ask, 1700000060000); // the answer was lost and the worker asks again a minute later
    assert.deepEqual((await h.snapshots(sh, { vm })).snapshots.map((s) => s.id), ['snapshot-1700000000']);
    await h.snapshot(sh, { ...ask, description: 'another' }, 1700000061000);
    assert.equal((await h.snapshots(sh, { vm })).snapshots.length, 2, 'another description is another snapshot');
    // An hour on, the customer takes one of the same name: that is not a retry.
    for (const s of readdirSync(f.file('dom', NAME, 'snaps'))) utimesSync(f.file('dom', NAME, 'snaps', s), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    await h.snapshot(sh, ask, 1700003600000);
    assert.deepEqual((await h.snapshots(sh, { vm })).snapshots.map((s) => [s.id, s.name]).sort(), [['snapshot-1700000000', 'before the upgrade'], ['snapshot-1700000061', 'before the upgrade'], ['snapshot-1700003600', 'before the upgrade']]);
  } finally { f.close(); }
});
