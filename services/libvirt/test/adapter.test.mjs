// The adapter's own parts, on any system: the SSH runner against a pretend ssh, the mapping to the contract from
// canned records, and the HTTP shell. (The shell scripts themselves run in host.test.mjs, on Linux.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import http from 'node:http';
import * as h from '../handlers.mjs';
import { names, quote, script } from '../scripts.mjs';
import { handler, routes } from '../server.mjs';
import { addressGuard, connect, Failure, hostKeys, parse, privateKey, sshFailure } from '../ssh.mjs';

const BLOB = Buffer.from('a pretend ed25519 host key').toString('base64'), RSA = Buffer.from('a pretend rsa host key').toString('base64');
const PIN = createHash('sha256').update(Buffer.from(BLOB, 'base64')).digest('hex');
const SCAN = `# 203.0.113.5:22 SSH-2.0-OpenSSH_9.6\n203.0.113.5 ssh-rsa ${RSA}\n203.0.113.5 ssh-ed25519 ${BLOB}\n`;
// A pretend OpenSSH: remembers what it was asked and answers what the test says.
function fakeSsh(answer = { code: 0, stdout: 'motd from a login script\nLVMBEGIN\nR\tdone\nLVMOK\n', stderr: '' }, scan = SCAN) {
  const calls = [];
  return { calls, transport: { probe: async () => 'refused', run: async (cmd, args, o = {}) => {
    const call = { cmd, args, env: o.env ?? {}, input: o.input ?? '' };
    const known = args.find((a) => a.startsWith('UserKnownHostsFile='))?.slice(19), id = args.includes('-i') ? args[args.indexOf('-i') + 1] : null;
    if (known) call.known = readFileSync(known, 'utf8');
    if (id) call.identity = readFileSync(id, 'utf8');
    call.folder = known;
    calls.push(call);
    return cmd === 'ssh-keyscan' ? { code: 0, stdout: scan, stderr: '' } : answer;
  } } };
}
const target = (over = {}) => ({ host: '203.0.113.5', port: 22, username: 'root', password: 'correct horse', tls: { mode: 'pinned', sha256: PIN }, ...over });

test('host keys are read from ssh-keyscan and the strongest kind comes first', () => {
  const keys = hostKeys(SCAN);
  assert.deepEqual(keys.map((k) => k.type), ['ssh-ed25519', 'ssh-rsa']);
  assert.equal(keys[0].sha256, PIN);
  assert.deepEqual(hostKeys('garbage\n\n203.0.113.5 ssh-dss AAAA\n'), []);
});

test('a host nobody pinned is answered with its fingerprint, and a different key is refused', async () => {
  const f = fakeSsh();
  await assert.rejects(connect(target({ tls: { mode: 'system' } }), f), (e) => e.code === 'TLS_UNTRUSTED' && e.certificate.sha256 === PIN && e.certificate.subject.includes('ssh-ed25519'));
  await assert.rejects(connect(target({ tls: { mode: 'pinned', sha256: 'ab'.repeat(32) } }), f), (e) => e.code === 'TLS_UNTRUSTED' && e.certificate.sha256 === PIN);
  await assert.rejects(connect(target({ tls: { mode: 'pinned', sha256: 'short' } }), f), { code: 'INVALID_PIN' });
  assert.ok(f.calls.every((c) => c.cmd === 'ssh-keyscan'), 'ssh itself never ran');
});

test('a password goes through sshpass in the environment, with only the pinned key trusted', async () => {
  const f = fakeSsh();
  const sh = await connect(target(), f);
  assert.deepEqual(await sh('echo LVMOK'), [['R', 'done']]);
  const c = f.calls.at(-1);
  assert.equal(c.cmd, 'sshpass'); assert.deepEqual(c.args.slice(0, 2), ['-e', 'ssh']); assert.equal(c.env.SSHPASS, 'correct horse');
  assert.ok(!c.args.join(' ').includes('correct horse'), 'the password is not on the command line');
  assert.equal(c.known, `203.0.113.5 ssh-ed25519 ${BLOB}\n`);
  for (const o of ['StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'HostKeyAlgorithms=ssh-ed25519', 'PubkeyAuthentication=no']) assert.ok(c.args.includes(o), o);
  // The host ends the script itself, a little before the adapter stops waiting for it (50 s unless a route says otherwise).
  assert.deepEqual(c.args.slice(-2), ['203.0.113.5', 'timeout -k 5 45 bash -s']);
  await sh('x', { timeout: 110000 }); assert.equal(f.calls.at(-1).args.at(-1), 'timeout -k 5 105 bash -s');
  assert.ok(c.input.startsWith('echo LVMBEGIN\n'));
  sh.close(); await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(c.folder), 'the temporary folder is gone');
});

test('a private key is written to a private file and used without a password prompt', async () => {
  const f = fakeSsh();
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----';
  const sh = await connect(target({ password: pem, port: 2222, tls: { mode: 'pinned', sha256: PIN.toUpperCase().replace(/(..)(?=.)/g, '$1:') } }), f);
  await sh('x');
  const c = f.calls.at(-1);
  assert.equal(c.cmd, 'ssh'); assert.equal(c.identity, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
  assert.ok(c.args.includes('BatchMode=yes')); assert.equal(c.known.split(' ')[0], '[203.0.113.5]:2222');
  assert.deepEqual(c.env, {});
  sh.close();
  // Pasted into a one-line field: the line breaks are gone or have become spaces.
  const body = 'A'.repeat(150), good = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(70)}\n${'A'.repeat(70)}\n${'A'.repeat(10)}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(privateKey(`-----BEGIN OPENSSH PRIVATE KEY-----${body}-----END OPENSSH PRIVATE KEY-----`), good);
  assert.equal(privateKey(`-----BEGIN OPENSSH PRIVATE KEY----- ${'A'.repeat(70)} ${'A'.repeat(80)} -----END OPENSSH PRIVATE KEY-----`), good);
  assert.equal(privateKey('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----'), null);
  await assert.rejects(connect(target({ password: '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nAAAA\n-----END RSA PRIVATE KEY-----' }), f), { code: 'INVALID_LOGIN' });
});

test('what went wrong on the way is told apart', async () => {
  await assert.rejects(connect(target({ host: '127.0.0.1' }), fakeSsh()), { code: 'ENDPOINT_BLOCKED' });
  await assert.rejects(connect(target({ username: '-oProxyCommand=x' }), fakeSsh()), { code: 'INVALID_REQUEST' });
  await assert.rejects(connect(target(), fakeSsh(undefined, '')), { code: 'CONNECTION_REFUSED' });
  const failing = async (answer) => { const sh = await connect(target(), fakeSsh(answer)); try { return await sh('x'); } finally { sh.close(); } };
  await assert.rejects(failing({ code: 5, stdout: '', stderr: '' }), { code: 'INVALID_LOGIN' });
  await assert.rejects(failing({ code: 255, stdout: '', stderr: 'root@203.0.113.5: Permission denied (publickey,password).' }), { code: 'INVALID_LOGIN' });
  await assert.rejects(failing({ code: 255, stdout: '', stderr: 'Host key verification failed.' }), { code: 'TLS_UNTRUSTED' });
  await assert.rejects(failing({ code: -2, stdout: '', stderr: '' }), { code: 'TIMEOUT' });
  await assert.rejects(failing({ code: 124, stdout: 'LVMBEGIN\nS\thalf\n', stderr: '' }), { code: 'TIMEOUT' }, 'the host\'s own timeout ended the script');
  // The networks the adapter itself sits on (the panel's database lives there) are refused like loopback is.
  const own = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.'));
  if (own) await assert.rejects(connect(target({ host: own.address }), fakeSsh()), { code: 'ENDPOINT_BLOCKED' });
  await assert.rejects(failing({ code: 1, stdout: 'LVMBEGIN\nLVMERR NOT_MANAGED this VM was not created by the panel\n', stderr: '' }), { code: 'NOT_MANAGED', message: 'this VM was not created by the panel' });
  await assert.rejects(failing({ code: 0, stdout: 'LVMBEGIN\nS\thalf\n', stderr: 'virsh: something broke' }), { code: 'LIBVIRT_ERROR', message: 'virsh: something broke' });
  assert.equal(sshFailure({ code: 127, stdout: '', stderr: 'bash: command not found' }).code, 'NOT_LIBVIRT');
  assert.equal(parse('no end marker'), null);
});

test('every script takes its parameters as quoted shell words', () => {
  assert.equal(quote("it's $(reboot) `x`"), `'it'\\''s $(reboot) \`x\`'`);
  for (const n of names) { const s = script(n, { vm: 'x', name: "a'b" }); assert.ok(s.startsWith("P_vm='x'\nP_name='a'\\''b'\nset -u\n"), n); assert.ok(s.trimEnd().endsWith('echo LVMOK'), n); }
  assert.throws(() => script('nope')); assert.throws(() => script('find', { 'a b': 1 }));
});

// ---- the mapping, from records as the scripts print them ---------------------------------------------
const UUID = '00000000-0000-4000-8000-000000000011', SERVER = '8f0c0d2e-5b7a-4c1e-9d3f-2a6b7c8d9e0f', NAME = `lvm-${SERVER}`;
const DISCOVER = [['H', 'name', 'kvm01'], ['H', 'uuid', 'machine-id-1'], ['H', 'version', 'QEMU 8.2.2'], ['H', 'os', 'Ubuntu 24.04 LTS'], ['H', 'CPU_model', 'x86_64'], ['H', 'CPU(s)', '16'], ['H', 'CPU_frequency', '2400 MHz'],
  ['H', 'CPU_socket(s)', '1'], ['H', 'Core(s)_per_socket', '8'], ['H', 'Thread(s)_per_core', '2'], ['H', 'Memory_size', '65536000 KiB'], ['H', 'free', '34359738368'], ['H', 'virtinst', '1'],
  ['D', 'default', '1000000000000', '800000000000', 'running'], ['N', 'default', 'virbr0'],
  ['V', '00000000-0000-4000-8000-000000000001', 'template-ubuntu-24', 'poweredOff', '2', '2097152', '1', 'hvm'], ['V', UUID, NAME, 'poweredOn', '4', '4194304', '0', 'hvm'], ['V', '00000000-0000-4000-8000-000000000002', 'someone-else', 'poweredOn', '1', '1048576', '0', 'hvm']];
function host(answers) {
  const calls = [];
  const sh = async () => { throw new Error('the fake host answers by name'); };
  sh.named = async (name, p) => { calls.push([name, p]); const a = answers[name]; if (!a) throw new Error(`fake host: ${name}`); return typeof a === 'function' ? a(p) : a; };
  return { sh, calls };
}

test('discovery describes the host, its pools, networks and domains the way the panel stores them', async () => {
  const d = await h.discover(host({ discover: DISCOVER }).sh);
  assert.equal(d.product.kind, 'libvirt'); assert.equal(d.product.instanceUuid, 'machine-id-1'); assert.equal(d.product.version, '8.2.2');
  assert.deepEqual(d.hosts.map((x) => [x.moref, x.cpuCores, x.cpuThreads, x.cpuMhz, x.memoryBytes, x.parent]), [['machine-id-1', 8, 16, 2400, 65536000 * 1024, 'machine-id-1']]);
  assert.deepEqual(d.compute, [{ moref: 'machine-id-1', name: 'kvm01', kind: 'standalone', hosts: 1, effectiveCpuMhz: 19200, effectiveMemoryMb: 64000, resourcePool: 'machine-id-1' }]);
  assert.deepEqual(d.datastores.map((x) => [x.moref, x.capacityBytes, x.freeBytes, x.accessible]), [['default', 1e12, 8e11, true]]);
  assert.deepEqual(d.networks, [{ moref: 'default', name: 'default', kind: 'standard', vlan: null, switch: 'virbr0' }]);
  assert.deepEqual(d.vms.map((v) => [v.name, v.template, v.memoryMb]), [['template-ubuntu-24', true, 2048], [NAME, false, 4096], ['someone-else', false, 1024]]);
  assert.equal(d.operations.cloneFromImage, true); assert.deepEqual(d.warnings, []);
  const bare = await h.discover(host({ discover: DISCOVER.map((r) => (r[1] === 'virtinst' ? ['H', 'virtinst', '0'] : r)) }).sh);
  assert.equal(bare.operations.cloneFromImage, false); assert.deepEqual(bare.warnings, ['VIRTINST_MISSING']);
});

test('creating a server starts a job on the host with a config drive, and the task says how it went', async () => {
  let status = ['R', 'running'];
  const f = host({ clone: [['R', 'task', 'job-1']], task: () => [status] });
  const order = { name: NAME, serverId: SERVER, template: 'tpl', pool: 'machine-id-1', datastore: 'default', network: 'default', vcpu: 4, memoryMb: 4096, diskGb: 40,
    metadata: JSON.stringify({ 'local-hostname': 'web1', network: { version: 2, ethernets: { nic0: { addresses: ['203.0.113.20/24'] } } } }), userdata: '#cloud-config\n{}\n' };
  assert.deepEqual(await h.clone(f.sh, order), { task: 'job-1', existed: false });
  const p = f.calls[0][1];
  assert.equal(p.notes, `Managed by Lightning VM (server ${SERVER})\nlvm-ips=203.0.113.20`);
  const iso = Buffer.from(p.iso, 'base64');
  assert.equal(iso.subarray(32769, 32774).toString(), 'CD001'); assert.ok(iso.includes('local-hostname')); assert.ok(iso.includes('203.0.113.20/24'));
  // The interface's address is made from the server's id (the same on every try); the config drive names the interface by it.
  assert.match(p.mac, /^52:54:00(:[0-9a-f]{2}){3}$/); assert.equal(p.mac, h.macOf(SERVER));
  assert.ok(iso.includes(`"match":{"macaddress":"${p.mac}"}`) && iso.includes('"set-name":"eth0"'));
  // What becomes text on the host is held to its shape before it gets there.
  for (const serverId of [undefined, '', 'x', `${SERVER}"; reboot; "`, `${SERVER}\n`]) await assert.rejects(h.clone(f.sh, { ...order, serverId }), { code: 'INVALID_REQUEST' });
  for (const a of ['203.0.113.20"; reboot; "/24', '$(reboot)/24', 'web1/24']) await assert.rejects(h.clone(f.sh, { ...order, metadata: JSON.stringify({ network: { version: 2, ethernets: { nic0: { addresses: [a] } } } }) }), { code: 'INVALID_REQUEST' });
  assert.equal(f.calls.length, 1, 'none of those reached the host');
  assert.deepEqual(await h.task(f.sh, { task: 'job-1' }), { state: 'running' });
  status = ['R', 'success', UUID]; assert.deepEqual(await h.task(f.sh, { task: 'job-1' }), { state: 'success', vm: UUID });
  status = ['R', 'error', 'INSUFFICIENT_RESOURCES', 'No space left']; assert.deepEqual(await h.task(f.sh, { task: 'job-1' }), { state: 'error', code: 'INSUFFICIENT_RESOURCES', error: 'No space left' });
  status = ['R', 'unknown']; assert.deepEqual(await h.task(f.sh, { task: 'job-1' }), { state: 'unknown', code: 'TASK_NOT_FOUND' });
  assert.deepEqual(await h.clone(host({ clone: [['R', 'existed', UUID]] }).sh, order), { vm: UUID, existed: true });
  await assert.rejects(h.clone(f.sh, { ...order, name: 'web1' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.clone(f.sh, { ...order, name: 'lvm-a;reboot' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(h.clone(f.sh, { ...order, customization: 'appliance' }), { code: 'PROVISIONING_NOT_SUPPORTED' });
});

test('the network settings are rewritten for a guest without netplan, and bound to the interface by its address', () => {
  const panel = { version: 2, ethernets: { nic0: { match: { name: 'e*' }, addresses: ['203.0.113.20/24', '2001:db8::20/64'],
    routes: [{ to: 'default', via: '203.0.113.1' }, { to: '::/0', via: '2001:db8::1', 'on-link': true }, { to: '10.0.0.0/8', via: '203.0.113.2' }], nameservers: { addresses: ['1.1.1.1'] } } } };
  const before = JSON.stringify(panel);
  assert.deepEqual(h.guestNetwork(panel, '52:54:00:00:00:01'), { version: 2, ethernets: { eth0: { match: { macaddress: '52:54:00:00:00:01' }, 'set-name': 'eth0', addresses: ['203.0.113.20/24', '2001:db8::20/64'],
    routes: [{ to: '0.0.0.0/0', via: '203.0.113.1' }, { to: '10.0.0.0/8', via: '203.0.113.2' }], gateway6: '2001:db8::1', nameservers: { addresses: ['1.1.1.1'] } } } });
  assert.equal(JSON.stringify(panel), before, 'what the panel sent is left alone');
  assert.deepEqual(h.guestNetwork({ version: 2 }, 'x'), { version: 2 });
  assert.equal(h.macOf('a'), h.macOf('a')); assert.notEqual(h.macOf('a'), h.macOf('b'));
});

test('the scripts never put a caller\'s text where the shell reads it as code', () => {
  const clone = script('clone', { name: 'lvm-x', notes: 'n' });
  const job = clone.slice(clone.indexOf('<<LVMJOB'), clone.indexOf('\nLVMJOB\n'));
  // Inside the job script (written through an unquoted here-document) only checked values appear; the note is read from a file.
  assert.ok(!job.includes('$P_notes') && job.includes('--new-desc "\\$(cat "$ROOT/tasks/$id.notes")"'));
  assert.deepEqual([...new Set(job.match(/\$P_\w+/g))].sort(), ['$P_diskGb', '$P_mac', '$P_memoryMb', '$P_name', '$P_network', '$P_vcpu']);
  for (const v of ['ours "$P_name"', 'plain "$P_network"', 'num "$P_vcpu" && num "$P_memoryMb" && num "$P_diskGb"', 'is "$P_mac"', 'plain "$t"', 'plain "$dir"']) assert.ok(clone.indexOf(v) > 0 && clone.indexOf(v) < clone.indexOf('<<LVMJOB'), v);
  // The note is written last, and a failure takes away what was made.
  assert.ok(job.indexOf('--new-desc') > job.indexOf('--add-device') && job.indexOf("printf 'success") > job.indexOf('--new-desc'));
  assert.match(job, /bad\(\) \{ undo;/);
  // No parameter is ever the pattern of a grep (the one fixed-string search for a checked description apart).
  for (const n of names) assert.ok(!/grep [^|\n]*"\$P_/.test(script(n).replace('grep -qF -e "<description>$P_description', '')), n);
});

test('a route that ran out of time leaves its connection open until the work itself has ended', async () => {
  const token = 't'.repeat(40), seen = [];
  let finish; const held = new Promise((r) => { finish = r; });
  const kept = routes['/v1/vm/find'];
  routes['/v1/vm/find'] = [async (sh) => { seen.push('started'); await held; seen.push('ended'); const close = sh.close; sh.close = () => { seen.push('closed'); close(); }; return { vm: null }; }, 0.05];
  const server = http.createServer(handler(token, fakeSsh())); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/vm/find`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...target(), name: 'lvm-slow' }) });
    assert.deepEqual([r.status, (await r.json()).code], [502, 'TIMEOUT']);
    assert.deepEqual(seen, ['started'], 'the folder with the private key is not removed under the handler that still works');
    finish(); await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ['started', 'ended', 'closed']);
  } finally { routes['/v1/vm/find'] = kept; server.close(); }
});

test('state, disks and snapshots come back in the contract\'s shape', async () => {
  const S = ['S', UUID, NAME, 'poweredOn', '1', '203.0.113.20,2001:db8::20', SERVER];
  const snaps = [];
  const f = host({ find: (p) => (p.name === NAME ? [S] : []), managed: [S], power: [], destroy: (p) => (p.vm === UUID ? [] : [['R', 'gone']]),
    disks: [['K', 'vda', '/pool/a.qcow2', String(40 * 1024 ** 3)], ['K', 'vdb', '/pool/a-vdb.qcow2', String(20 * 1024 ** 3)]], diskRemove: [], diskAdd: [],
    snapshots: () => snaps, snapshot: (p) => { if (p.action === 'create') snaps.push(['P', p.snapname, '1704103200', '1', '', p.description.replace(/&/g, '&amp;')]); return []; } });
  assert.deepEqual((await h.find(f.sh, { name: NAME })).vm, { moref: UUID, name: NAME, powerState: 'poweredOn', toolsRunning: true, ips: ['203.0.113.20', '2001:db8::20'], serverId: SERVER });
  assert.deepEqual(await h.find(f.sh, { name: 'lvm-none' }), { vm: null });
  assert.equal((await h.managedVms(f.sh)).vms.length, 1);
  assert.deepEqual(await h.powerAction(f.sh, { vm: UUID, action: 'on' }), { task: '' });
  await assert.rejects(h.powerAction(f.sh, { vm: UUID, action: 'explode' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(await h.destroy(f.sh, { vm: 'gone' }), { task: '', gone: true });
  assert.deepEqual((await h.disks(f.sh, { vm: UUID })).disks, [{ key: 0, label: 'a.qcow2', sizeGb: 40, system: true }, { key: 1, label: 'a-vdb.qcow2', sizeGb: 20, system: false }]);
  assert.deepEqual([h.diskKey('vda'), h.diskKey('vdz'), h.diskKey('vdaa'), h.diskKey('sdb')], [0, 25, 26, 1001]);
  assert.deepEqual(await h.diskRemove(f.sh, { vm: UUID, key: 1 }), { task: '' });
  assert.deepEqual(f.calls.at(-1), ['diskRemove', { vm: UUID, target: 'vdb' }]);
  assert.deepEqual(await h.diskRemove(f.sh, { vm: UUID, key: 7 }), { task: '', gone: true });
  await assert.rejects(h.diskAdd(f.sh, { vm: UUID, sizeGb: 0 }), { code: 'INVALID_REQUEST' });

  await h.snapshot(f.sh, { vm: UUID, action: 'create', name: "before <upgrade> & 'tests'", description: 'çok önemli' }, 1700000000000);
  const made = f.calls.at(-1)[1];
  assert.equal(made.snapname, 'lvm1700000000'); assert.match(made.description, /^lvm:[A-Za-z0-9_-]+$/);
  assert.deepEqual((await h.snapshots(f.sh, { vm: UUID })).snapshots, [{ id: 'snapshot-1700000000', name: "before <upgrade> & 'tests'", description: 'çok önemli', created: '2024-01-01T10:00:00.000Z', powerState: 'poweredOff', current: true, parent: '' }]);
  snaps.push(['P', 'made by hand', '1704103300', '0', 'lvm1700000000', 'a &lt;note&gt;']);
  const [, foreign] = (await h.snapshots(f.sh, { vm: UUID })).snapshots;
  assert.match(foreign.id, /^snapshot-\d{1,12}$/); assert.equal(foreign.name, 'made by hand'); assert.equal(foreign.description, 'a <note>'); assert.equal(foreign.parent, 'snapshot-1700000000');
  await h.snapshot(f.sh, { vm: UUID, action: 'revert', snapshot: foreign.id });
  assert.equal(f.calls.at(-1)[1].snapname, 'made by hand');
  await assert.rejects(h.snapshot(f.sh, { vm: UUID, action: 'remove', snapshot: 'snapshot-5' }), { code: 'SNAPSHOT_NOT_FOUND' });
});

test('details, usage and the topology are filled from what virsh knows', async () => {
  const started = String(Math.floor(Date.now() / 1000) - 600);
  const f = host({ discover: DISCOVER, details: [['S', UUID, NAME, 'poweredOn', '1', '203.0.113.20', SERVER], ['I', 'CPU(s)', '4'], ['I', 'Max_memory', '4194304 KiB'], ['I', 'Used_memory', '4194304 KiB'], ['I', 'OS_Type', 'hvm'],
    ['I', 'desc', `Managed by Lightning VM (server ${SERVER})|lvm-ips=203.0.113.20|`], ['I', 'firmware', 'efi'], ['I', 'machine', 'pc-q35-8.2'], ['I', 'snapshots', '2'], ['I', 'host', 'kvm01'], ['I', 'started', started],
    ['K', 'vda', '/pool/a.qcow2', String(40 * 1024 ** 3)], ['C', '/pool/a-cidata.iso'], ['F', 'vnet0', 'network', 'default', 'virtio', '52:54:00:00:00:01'], ['A', '52:54:00:00:00:01', '203.0.113.20/24'], ['A', '52:54:00:00:00:01', 'fe80::1/64']] });
  const d = await h.details(f.sh, { vm: UUID });
  assert.equal(d.annotation, `Managed by Lightning VM (server ${SERVER})`); assert.equal(d.firmware, 'efi'); assert.equal(d.snapshots, 2);
  assert.equal(d.cpu.count, 4); assert.equal(d.memory.sizeMb, 4096); assert.ok(d.uptimeSeconds >= 600 && d.uptimeSeconds < 700);
  assert.deepEqual(d.nics.map((n) => [n.mac, n.network, n.ips]), [['52:54:00:00:00:01', 'default', ['203.0.113.20']]]);
  assert.deepEqual(d.disks.map((x) => [x.capacityGb, x.file, x.bus]), [[40, '/pool/a.qcow2', 'virtio']]);
  assert.deepEqual(d.cdroms, [{ label: 'CD/DVD drive 1', iso: '/pool/a-cidata.iso', connected: true }]);
  assert.deepEqual((await h.metrics(f.sh, { vm: UUID })).samples, []);
  const t = await h.topology(f.sh);
  assert.deepEqual(t.vms.map((v) => [v.name, v.memUsedMb]), [[NAME, 4096]]); assert.equal(t.otherVms, 1); assert.equal(t.hosts[0].memTotalMb, 64000);
  assert.deepEqual((await h.powerReport(f.sh)).vms.map((v) => v.name), [NAME]);
});

// ---- the HTTP shell ------------------------------------------------------------------------------
test('the service wants its token, names what is not there yet and passes the host key on', async () => {
  const token = 't'.repeat(40), f = fakeSsh();
  const server = http.createServer(handler(token, f)); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (path, body, auth = token) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body ?? {}) }); return [r.status, await r.json()]; };
  try {
    assert.equal((await call('/v1/discover', target(), 'wrong'))[0], 401);
    assert.deepEqual(await call('/v1/console-ticket', target()), [400, { code: 'PLATFORM_NOT_SUPPORTED', message: 'not available on libvirt yet' }]);
    const [status, out] = await call('/v1/discover', target({ tls: { mode: 'system' } }));
    assert.equal(status, 502); assert.equal(out.code, 'TLS_UNTRUSTED'); assert.equal(out.certificate.sha256, PIN);
    assert.deepEqual(await call('/v1/vm/find', { ...target(), name: 'lvm-x' }), [200, { vm: null }]);
    assert.ok(new Failure('X') instanceof Error);
  } finally { server.close(); }
});

test('the address guard refuses the adapter\'s own networks unless they are allowed', () => {
  const docker = { lo: [{ address: '127.0.0.1', cidr: '127.0.0.1/8', family: 'IPv4', internal: true }], eth0: [{ address: '172.18.0.5', cidr: '172.18.0.5/16', family: 'IPv4', internal: false }, { address: 'fd00:18::5', cidr: 'fd00:18::5/64', family: 'IPv6', internal: false }] };
  const guard = addressGuard({}, docker);
  assert.deepEqual([guard('172.18.0.3', 'ipv4'), guard('fd00:18::3', 'ipv6'), guard('127.0.0.1', 'ipv4'), guard('169.254.169.254', 'ipv4'), guard('203.0.113.9', 'ipv4'), guard('2001:db8::9', 'ipv6')], [false, false, false, false, true, true]);
  const allowed = addressGuard({ LIBVIRT_ALLOW_NETWORKS: '172.18.0.0/16', LIBVIRT_DENY_NETWORKS: '203.0.113.0/24' }, docker);
  assert.deepEqual([allowed('172.18.0.3', 'ipv4'), allowed('203.0.113.9', 'ipv4'), allowed('198.51.100.9', 'ipv4')], [true, false, true]);
});
