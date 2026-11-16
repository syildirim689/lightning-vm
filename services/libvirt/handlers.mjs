// The adapter contract (docs/adapter-contract.md) on libvirt/KVM: one host per connection, driven with virsh over
// SSH (scripts.mjs holds the shell, ssh.mjs runs it). Ids the panel stores:
//   VM, template        the domain's UUID           host, compute, "resource pool"   the host's /etc/machine-id
//   datastore           the storage pool's name     network                          the libvirt network's name
//   task                the id of the background job on the host (it writes its outcome to a file there)
//   snapshot            "snapshot-<n>": the seconds in the snapshot's own name (lvm<seconds>)
// libvirt has no templates of its own: a domain is one when its name starts with "template-" or "tpl-", or its
// description contains "lvm-template". A new server gets its settings from a cloud-init NoCloud config drive.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { configDrive } from './iso.mjs';
import { script } from './scripts.mjs';
import { Failure } from './ssh.mjs';

const PREFIX = 'lvm-';
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const round2 = (n) => Math.round(n * 100) / 100;
const note = (serverId) => `Managed by Lightning VM (server ${serverId})`;
// Runs one of the scripts on the host and gives its records. (Tests hand in a host that answers by script name.)
const run = (sh, name, params, opts) => (sh.named ? sh.named(name, params) : sh(script(name, params), opts));
const of = (rows, kind) => rows.filter((r) => r[0] === kind).map((r) => r.slice(1));
const fields = (rows, kind) => Object.fromEntries(of(rows, kind).map(([k, ...v]) => [k, v.join('\t')]));
const result = (rows) => of(rows, 'R')[0] ?? [];
const kib = (text) => (Number.parseInt(text, 10) || 0) * 1024;
const state = ([uuid, name, power, tools, ips, sid]) => ({ moref: uuid, name, powerState: power, toolsRunning: tools === '1', ips: ips ? ips.split(',').filter(Boolean) : [], ...(sid && { serverId: sid }) });
const unxml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---- discovery -----------------------------------------------------------------------------------
function hostOf(rows) {
  const H = fields(rows, 'H');
  const threads = Number(H['CPU(s)']) || 0, perCore = Number(H['Thread(s)_per_core']) || 1;
  return { id: String(H.uuid || H.name), name: H.name ?? '', version: H.version ?? '', os: H.os ?? '', model: H.CPU_model ?? '', mhz: Number.parseInt(H.CPU_frequency, 10) || 0, threads, cores: Math.max(1, Math.round(threads / perCore)),
    memory: kib(H.Memory_size), free: Number(H.free) || 0, virtinst: H.virtinst === '1' };
}
const vmOf = ([uuid, name, power, cpu, maxKib, template, os]) => ({ id: uuid, name, power, cpu: Number(cpu) || 0, memory: kib(maxKib), template: template === '1', os: os ?? '' });

export async function discover(sh) {
  const rows = await run(sh, 'discover');
  const h = hostOf(rows), vms = of(rows, 'V').map(vmOf);
  return {
    product: { kind: 'libvirt', name: 'libvirt / KVM', fullName: `${h.version || 'QEMU'} on ${h.os || 'Linux'}`, version: h.version.replace(/^\D+/, ''), build: '', apiType: 'virsh over SSH', apiVersion: h.version.replace(/^\D+/, ''), instanceUuid: h.id },
    licenses: [], writeApi: 'available', privileges: {},
    operations: { inventory: true, createVm: h.virtinst, cloneFromImage: h.virtinst, power: true, resize: true, deleteVm: true, snapshot: true, console: false, firewall: false, automationApi: true },
    warnings: h.virtinst ? [] : ['VIRTINST_MISSING'],
    hosts: [{ moref: h.id, name: h.name, hardwareUuid: h.id, vendor: '', model: h.model, cpuMhz: h.mhz, cpuCores: h.cores, cpuThreads: h.threads, memoryBytes: h.memory,
      connectionState: 'connected', powerState: 'poweredOn', inMaintenance: false, version: h.version, managementServer: '', parent: h.id }],
    datastores: of(rows, 'D').map(([pool, capacity, available, st]) => ({ moref: pool, name: pool, type: 'pool', capacityBytes: Number(capacity) || 0, freeBytes: Number(available) || 0, uncommittedBytes: 0,
      accessible: st === 'running', maintenanceMode: 'normal', hosts: [h.id] })),
    networks: of(rows, 'N').map(([name, bridge]) => ({ moref: name, name, kind: 'standard', vlan: null, switch: bridge ?? '' })),
    compute: [{ moref: h.id, name: h.name, kind: 'standalone', hosts: 1, effectiveCpuMhz: h.mhz * h.cores, effectiveMemoryMb: Math.floor(h.memory / MIB), resourcePool: h.id }],
    vms: vms.map((v) => ({ moref: v.id, name: v.name, uuid: v.id, instanceUuid: v.id, powerState: v.power, host: h.id, cpu: v.cpu, memoryMb: Math.floor(v.memory / MIB), template: v.template, guest: v.os, committedBytes: 0, uncommittedBytes: 0 })),
    compat: { apiVersion: h.version.replace(/^\D+/, ''), customization: 'cloudinit', clone: h.virtinst, consoleUrl: false, support: 'supported' },
  };
}

// ---- provisioning --------------------------------------------------------------------------------
// The MAC address of a server's interface, made from its id so that a repeated clone gives the same one: the config
// drive is written before the domain exists and names the interface by it. 52:54:00 is the prefix QEMU/KVM guests use.
export const macOf = (seed) => `52:54:00:${createHash('sha256').update(String(seed)).digest('hex').slice(0, 6).replace(/(..)(?=.)/g, '$1:')}`;
// The panel's network settings as the guest's cloud-init reads them everywhere. Without netplan in the image (Debian
// 12, cloud-init 22.4, seen on a real server) cloud-init refuses the route "to: default", turns "::/0" into "::/64",
// and takes the entry's key for the interface's name instead of matching "e*". So: an address for the IPv4 default
// route, gateway6 for the IPv6 one, and the first interface is found by its MAC address (which the adapter sets on
// the VM) and called eth0, whatever name the guest's kernel gave it.
export function guestNetwork(network, mac) {
  const out = structuredClone(network), nics = {}, entries = Object.entries(out?.ethernets ?? {});
  for (const [i, [key, nic]] of entries.entries()) {
    const routes = [];
    for (const r of Array.isArray(nic?.routes) ? nic.routes : []) {
      const v6 = String(r?.via ?? '').includes(':');
      if (r?.to === '::/0' || (r?.to === 'default' && v6)) nic.gateway6 = r.via;
      else routes.push(r?.to === 'default' ? { ...r, to: '0.0.0.0/0' } : r);
    }
    if (nic && typeof nic === 'object') { if (routes.length) nic.routes = routes; else delete nic.routes; }
    if (i === 0 && mac && nic && typeof nic === 'object') { nic.match = { macaddress: mac }; nic['set-name'] = 'eth0'; nics.eth0 = nic; } else nics[key] = nic;
  }
  if (out?.ethernets) out.ethernets = nics;
  return out;
}
// The worker's two documents as the three files of a NoCloud config drive (the network goes into a file of its own).
export function driveFiles(metadata, userdata, serverId, mac) {
  let meta = {}; try { meta = JSON.parse(metadata || '{}'); } catch { /* not JSON */ }
  const { network, ...rest } = meta;
  const files = { 'meta-data': `${JSON.stringify({ 'instance-id': serverId, ...rest })}\n`, 'user-data': String(userdata || '#cloud-config\n{}\n') };
  if (network) files['network-config'] = `${JSON.stringify(guestNetwork(network, mac))}\n`;
  return { files, ips: (Object.values(network?.ethernets ?? {})[0]?.addresses ?? []).map((a) => String(a).split('/')[0]) };
}

export async function clone(sh, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || !b.template || !b.pool || !b.datastore || !b.network) throw new Failure('INVALID_REQUEST', 'name, template, pool, datastore and network are required');
  if (!/^lvm-[\w-]{1,76}$/.test(b.name)) throw new Failure('INVALID_REQUEST', 'the name may hold letters, digits, - and _ only');
  if (b.customization === 'appliance') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'appliance images (nested ESXi) need VMware');
  // The server's id and its addresses become the domain's description on the host: only what they must be is let through.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(b.serverId ?? ''))) throw new Failure('INVALID_REQUEST', 'serverId must be a UUID');
  const mac = macOf(b.serverId);
  const { files, ips } = driveFiles(b.metadata, b.userdata, b.serverId, mac);
  if (ips.some((a) => !isIP(a))) throw new Failure('INVALID_REQUEST', 'the addresses in the network settings must be IP addresses');
  const whole = (x, or) => { const n = Math.floor(Number(x)); return n > 0 && n < 1e9 ? n : or; };
  // The copy runs on the host on its own (a large disk takes minutes); this call only starts it.
  const [what, id] = result(await run(sh, 'clone', { name: b.name, template: String(b.template), datastore: String(b.datastore), network: String(b.network), vcpu: whole(b.vcpu, 1), memoryMb: whole(b.memoryMb, 1024),
    diskGb: whole(b.diskGb, 0), notes: `${note(b.serverId)}\nlvm-ips=${ips.join(',')}`, mac, iso: configDrive(files).toString('base64') }));
  if (what === 'existed') return { vm: id, existed: true };
  if (what !== 'task' || !id) throw new Failure('LIBVIRT_ERROR', 'the host did not start the copy');
  return { task: id, existed: false };
}
export async function task(sh, b) {
  const [st, a, ...rest] = result(await run(sh, 'task', { task: String(b.task ?? '') }));
  if (st === 'success') return { state: 'success', vm: a };
  if (st === 'error') return { state: 'error', code: /^[A-Z_]+$/.test(a ?? '') ? a : 'TASK_FAILED', error: rest.join(' ').slice(0, 500) };
  return st === 'unknown' ? { state: 'unknown', code: 'TASK_NOT_FOUND' } : { state: 'running' };
}

export async function find(sh, b) {
  if (!b.name) throw new Failure('INVALID_REQUEST', 'name is required');
  const s = of(await run(sh, 'find', { name: b.name }), 'S')[0];
  return { vm: s ? state(s) : null };
}
export async function managedVms(sh) { return { vms: of(await run(sh, 'managed'), 'S').map(state) }; }

export async function powerAction(sh, b) {
  if (!['on', 'off', 'reset', 'shutdown'].includes(b.action)) throw new Failure('INVALID_REQUEST', 'unknown power action');
  await run(sh, 'power', { vm: b.vm, action: b.action });
  return { task: '' };
}
export async function destroy(sh, b) {
  const [what] = result(await run(sh, 'destroy', { vm: String(b.vm ?? '') }, { timeout: 110000 }));
  return what === 'gone' ? { task: '', gone: true } : { task: '' };
}

export async function resize(sh, b) {
  const vcpu = Number(b.vcpu), memoryMb = Number(b.memoryMb), diskGb = Number(b.diskGb);
  if (!Number.isInteger(vcpu) || vcpu < 1 || !Number.isInteger(memoryMb) || memoryMb < 256 || !Number.isInteger(diskGb) || diskGb < 1) throw new Failure('INVALID_REQUEST', 'vcpu, memoryMb and diskGb are required');
  await run(sh, 'resize', { vm: b.vm, vcpu, memoryMb, diskGb });
  return { task: '' };
}
export async function rename(sh, b) {
  if (!/^lvm-[\w-]{1,76}$/.test(String(b.name ?? ''))) throw new Failure('INVALID_REQUEST', 'name must start with lvm- and hold letters, digits, - and _ only');
  const [, gb] = result(await run(sh, 'rename', { vm: b.vm, name: b.name }));
  return { name: b.name, diskGb: Number(gb) || 0 };
}

// ---- disks ---------------------------------------------------------------------------------------
// The panel keeps a disk by a number: made from its target ("vdb" -> 1, "sdb" -> 1001).
export function diskKey(target) {
  const t = String(target), letters = t.slice(2);
  let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 96);
  return ({ vd: 0, sd: 1000, hd: 2000 }[t.slice(0, 2)] ?? 3000) + n - 1;
}
const diskRows = (rows) => of(rows, 'K').map(([target, path, size], i) => ({ target, path: path ?? '', size: Number(size) || 0, key: diskKey(target), system: i === 0 }));
export async function disks(sh, b) {
  return { disks: diskRows(await run(sh, 'disks', { vm: b.vm })).map((d) => ({ key: d.key, label: d.path.split('/').pop() ?? '', sizeGb: Math.floor(d.size / GIB), system: d.system })) };
}
export async function diskAdd(sh, b) {
  const sizeGb = Number(b.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536) throw new Failure('INVALID_REQUEST', 'sizeGb must be 1 to 65536');
  await run(sh, 'diskAdd', { vm: b.vm, sizeGb });
  return { task: '' };
}
export async function diskRemove(sh, b) {
  const d = diskRows(await run(sh, 'disks', { vm: b.vm })).find((x) => x.key === Number(b.key));
  if (!d) return { task: '', gone: true };
  const [what] = result(await run(sh, 'diskRemove', { vm: b.vm, target: d.target }));
  return what === 'gone' ? { task: '', gone: true } : { task: '' };
}

// ---- snapshots -----------------------------------------------------------------------------------
// A snapshot's libvirt name is lvm<seconds>; the name and description the customer typed travel in libvirt's
// description field (base64 of JSON, so no character can break the shell or the XML around it).
const numberOf = (name) => (/^lvm\d{1,12}$/.test(name) ? Number(name.slice(3)) : Number.parseInt(createHash('sha1').update(name).digest('hex').slice(0, 11), 16) % 1e12);
const snapId = (name) => `snapshot-${numberOf(name)}`;
const packed = (name, description) => `lvm:${Buffer.from(JSON.stringify({ name, description }), 'utf8').toString('base64url')}`;
function unpacked(snapName, raw) {
  const text = unxml(raw).trim();
  if (text.startsWith('lvm:')) { try { const o = JSON.parse(Buffer.from(text.slice(4), 'base64url').toString('utf8')); return { name: String(o.name ?? snapName), description: String(o.description ?? '') }; } catch { /* someone edited it */ } }
  return { name: snapName, description: text };
}
const snapRows = (rows) => of(rows, 'P').map(([name, when, current, parent, ...desc]) => ({ libvirt: name, when: Number(when) || 0, current: current === '1', parent: parent ?? '', ...unpacked(name, desc.join('\t')) }));
export async function snapshots(sh, b) {
  return { snapshots: snapRows(await run(sh, 'snapshots', { vm: b.vm })).map((s) => ({ id: snapId(s.libvirt), name: s.name, description: s.description, created: new Date(s.when * 1000).toISOString(), powerState: 'poweredOff',
    current: s.current, parent: s.parent ? snapId(s.parent) : '' })) };
}
export async function snapshot(sh, b, now = Date.now()) {
  if (b.action === 'create') {
    const name = String(b.name ?? ''), description = String(b.description ?? '');
    if (!name || Buffer.byteLength(name) > 80 || Buffer.byteLength(description) > 500) throw new Failure('INVALID_REQUEST', 'name is 1 to 80 bytes, description at most 500');
    await run(sh, 'snapshot', { vm: b.vm, action: 'create', snapname: `lvm${Math.floor(now / 1000)}`, description: packed(name, description) }, { timeout: 55000 });
    return { task: '' };
  }
  if (b.action !== 'revert' && b.action !== 'remove') throw new Failure('INVALID_REQUEST', 'unknown snapshot action');
  const target = snapRows(await run(sh, 'snapshots', { vm: b.vm })).find((s) => snapId(s.libvirt) === b.snapshot);
  if (!target) throw new Failure('SNAPSHOT_NOT_FOUND', 'the snapshot is not in this VM');
  await run(sh, 'snapshot', { vm: b.vm, action: b.action, snapname: target.libvirt, description: '' }, { timeout: 55000 });
  return { task: '' };
}

// ---- reading -------------------------------------------------------------------------------------
async function read(sh, vm) {
  const rows = await run(sh, 'details', { vm });
  const s = state(of(rows, 'S')[0] ?? []), I = fields(rows, 'I');
  const running = s.powerState === 'poweredOn', started = Number(I.started) || 0;
  return { rows, s, I, running, uptime: running && started ? Math.max(0, Math.floor(Date.now() / 1000) - started) : 0, started };
}
export async function details(sh, b) {
  const { rows, s, I, running, uptime, started } = await read(sh, b.vm);
  const all = diskRows(rows), addresses = of(rows, 'A').map(([mac, addr]) => ({ mac: String(mac).toLowerCase(), ip: String(addr ?? '').split('/')[0] })).filter((a) => a.ip && !a.ip.startsWith('fe80:'));
  const nics = of(rows, 'F').map(([iface, type, source, model, mac]) => ({ iface, type, source, model, mac: String(mac ?? '').toLowerCase() }));
  const desc = /^No description for domain/.test(I.desc ?? '') ? '' : String(I.desc ?? '');
  const bus = (t) => ({ vd: 'virtio', sd: 'scsi', hd: 'ide' }[t.slice(0, 2)] ?? '');
  const os = I.OS_Type ?? '';
  return {
    moref: s.moref, name: s.name, instanceUuid: s.moref, biosUuid: s.moref, guestId: '', configuredOs: os, hardwareVersion: I.machine ?? '', firmware: I.firmware === 'efi' ? 'efi' : 'bios', secureBoot: false,
    annotation: desc.split('|').filter((l) => l && !l.startsWith('lvm-ips=')).join('\n'), powerState: s.powerState, connectionState: 'connected',
    bootTime: running && started ? new Date(started * 1000).toISOString() : null, uptimeSeconds: uptime, overallStatus: 'green', consolidationNeeded: false,
    snapshots: Number(I.snapshots) || 0, committedGb: 0, uncommittedGb: 0,
    cpu: { count: Number(I['CPU(s)']) || 0, coresPerSocket: 1, hotAdd: false, reservationMhz: 0, limitMhz: -1, shares: 0, usageMhz: 0 },
    memory: { sizeMb: Math.floor(kib(I.Max_memory) / MIB), hotAdd: false, reservationMb: 0, limitMb: -1, shares: 0, guestUsageMb: 0, hostUsageMb: running ? Math.floor(kib(I.Used_memory) / MIB) : 0, balloonedMb: 0, swappedMb: 0 },
    nics: nics.map((n, i) => { const ips = addresses.filter((a) => a.mac === n.mac).map((a) => a.ip); const mine = ips.length ? ips : i === 0 && !addresses.length ? s.ips : [];
      return { label: `Network adapter ${i + 1}`, adapter: n.model ?? '', mac: n.mac, macType: 'generated', connected: running, startConnected: true, network: n.source ?? '', kind: 'standard', portKey: '', portgroupKey: '', switch: n.type === 'bridge' ? n.source ?? '' : '',
        vlan: null, ips: mine, guestConnected: mine.length ? true : null }; }),
    disks: all.map((x, i) => ({ label: `Hard disk ${i + 1}`, capacityGb: round2(x.size / GIB), datastore: '', file: x.path, provisioning: 'thin', mode: 'persistent', controller: x.target, bus: bus(x.target) })),
    cdroms: of(rows, 'C').map(([path], i) => ({ label: `CD/DVD drive ${i + 1}`, iso: path && path !== '-' ? path : '', connected: !!path && path !== '-' })),
    tools: { status: s.toolsRunning ? 'toolsOk' : running ? 'toolsNotRunning' : 'toolsNotInstalled', runningStatus: s.toolsRunning ? 'guestToolsRunning' : 'guestToolsNotRunning', version: '', versionStatus: '' },
    guest: { hostName: '', os, family: 'linuxGuest', ips: s.ips, gateways: [], dns: [], domain: '', state: running ? 'running' : 'notRunning', heartbeat: s.toolsRunning ? 'green' : 'gray' },
    placement: { host: I.host ?? '', cluster: '', resourcePool: '', folder: '', datastores: [], vmxPath: all[0]?.path ?? '' },
  };
}

// The adapter keeps no usage history (that would need a collector on the host): what is known now, and no samples.
export async function metrics(sh, b) {
  const { I, running, uptime } = await read(sh, b.vm);
  return { interval: 60, samples: [], quick: { cpuMhz: 0, memoryActiveMb: running ? Math.floor(kib(I.Used_memory) / MIB) : 0, uptimeSeconds: uptime } };
}

async function picture(sh) {
  const rows = await run(sh, 'discover');
  return { rows, h: hostOf(rows), vms: of(rows, 'V').map(vmOf) };
}
export async function topology(sh) {
  const { rows, h, vms } = await picture(sh);
  return { time: new Date().toISOString(), compute: [{ moref: h.id, name: h.name, kind: 'host' }],
    hosts: [{ moref: h.id, name: h.name, compute: h.id, state: 'connected', power: 'poweredOn', cpuUsedMhz: 0, cpuTotalMhz: h.mhz * h.cores, memUsedMb: Math.floor(Math.max(0, h.memory - h.free) / MIB), memTotalMb: Math.floor(h.memory / MIB) }],
    datastores: of(rows, 'D').map(([pool, capacity, available]) => ({ moref: pool, name: pool, capacityGb: (Number(capacity) || 0) / GIB, freeGb: (Number(available) || 0) / GIB, hosts: [h.id] })),
    vms: vms.filter((v) => v.name.startsWith(PREFIX)).map((v) => ({ moref: v.id, name: v.name, host: h.id, power: v.power, cpuUsedMhz: 0, memUsedMb: v.power === 'poweredOn' ? Math.floor(v.memory / MIB) : 0, rxKBps: null, txKBps: null })),
    otherVms: vms.filter((v) => !v.name.startsWith(PREFIX) && !v.template).length };
}
export async function powerReport(sh) {
  const { h, vms } = await picture(sh);
  return { time: new Date().toISOString(), hosts: [{ moref: h.id, name: h.name, watts: null, cpuUsedMhz: 0, cpuTotalMhz: h.mhz * h.cores, coreMhz: h.mhz, connected: true }],
    vms: vms.filter((v) => v.power === 'poweredOn' && v.name.length > PREFIX.length && v.name.startsWith(PREFIX)).map((v) => ({ name: v.name, host: h.id, cpuUsedMhz: 0, traffic: [] })) };
}
