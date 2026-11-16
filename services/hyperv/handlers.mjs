// The adapter contract (docs/adapter-contract.md) on Microsoft Hyper-V: one host per connection, driven with
// PowerShell over WinRM (scripts.mjs holds the PowerShell, winrm.mjs runs it). Ids the panel stores:
//   VM, template        the VM's id (a GUID)        host, compute, "resource pool"   the host's hardware UUID
//   datastore           a drive letter ("D")        network                          the virtual switch's id
//   task                the id of the background task on the host (it writes its outcome to a file there)
//   snapshot            "snapshot-<n>": a number made from the checkpoint's id
// Hyper-V has no templates of its own: a VM is one when its name starts with "template-" or "tpl-", or its notes
// contain "lvm-template". A new server gets its settings from a cloud-init NoCloud config drive (iso.mjs).
import { createHash } from 'node:crypto';
import { configDrive } from './iso.mjs';
import { CLONE_WORKER, script } from './scripts.mjs';
import { Failure } from './winrm.mjs';

const PREFIX = 'lvm-';
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const round2 = (n) => Math.round(n * 100) / 100;
const isGuid = (x) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(x ?? ''));
const note = (serverId) => `Managed by Lightning VM (server ${serverId})`;
const numberOf = (id) => Number.parseInt(createHash('sha1').update(String(id).toLowerCase()).digest('hex').slice(0, 11), 16) % 1e12;
const snapId = (id) => `snapshot-${numberOf(id)}`;
// Runs one of the scripts on the host. (Tests hand in a host that answers by script name.)
const run = (ps, name, params, opts) => (ps.named ? ps.named(name, params) : ps(script(name, params), opts));
const clean = (s) => { const o = { ...s }; if (!o.serverId) delete o.serverId; o.ips = [].concat(o.ips ?? []); return o; };

// ---- discovery -----------------------------------------------------------------------------------
export async function discover(ps) {
  const h = await run(ps, 'discover');
  const host = String(h.uuid || h.name);
  const volumes = [].concat(h.volumes ?? []), switches = [].concat(h.switches ?? []), vms = [].concat(h.vms ?? []);
  return {
    product: { kind: 'hyperv', name: 'Microsoft Hyper-V', fullName: `${h.os ?? 'Windows Server'} (Hyper-V)`, version: String(h.version ?? ''), build: String(h.build ?? ''), apiType: 'WinRM', apiVersion: String(h.version ?? ''), instanceUuid: host },
    licenses: [], writeApi: 'available', privileges: {},
    operations: { inventory: true, createVm: true, cloneFromImage: true, power: true, resize: true, deleteVm: true, snapshot: true, console: false, firewall: false, automationApi: true },
    warnings: [],
    hosts: [{ moref: host, name: h.name, hardwareUuid: host, vendor: h.vendor ?? '', model: h.cpuName ?? h.model ?? '', cpuMhz: Number(h.mhz) || 0, cpuCores: Number(h.cores) || 0, cpuThreads: Number(h.threads) || 0, memoryBytes: Number(h.memory) || 0,
      connectionState: 'connected', powerState: 'poweredOn', inMaintenance: false, version: String(h.version ?? ''), managementServer: '', parent: host }],
    datastores: volumes.map((v) => ({ moref: String(v.letter).toUpperCase(), name: v.label ? `${v.letter}: (${v.label})` : `${v.letter}:`, type: 'NTFS', capacityBytes: Number(v.size) || 0, freeBytes: Number(v.free) || 0, uncommittedBytes: 0,
      accessible: true, maintenanceMode: 'normal', hosts: [host] })),
    networks: switches.map((s) => ({ moref: s.id, name: s.name, kind: 'standard', vlan: null, switch: s.type ?? '' })),
    compute: [{ moref: host, name: h.name, kind: 'standalone', hosts: 1, effectiveCpuMhz: (Number(h.mhz) || 0) * (Number(h.cores) || 0), effectiveMemoryMb: Math.floor((Number(h.memory) || 0) / MIB), resourcePool: host }],
    vms: vms.map((v) => ({ moref: v.id, name: v.name, uuid: v.id, instanceUuid: v.id, powerState: v.power, host, cpu: Number(v.cpu) || 0, memoryMb: Math.floor((Number(v.memory) || 0) / MIB), template: !!v.template,
      guest: `generation ${v.generation}`, committedBytes: 0, uncommittedBytes: 0 })),
    compat: { apiVersion: String(h.version ?? ''), customization: 'cloudinit', clone: true, consoleUrl: false, support: 'supported' },
  };
}

// ---- provisioning --------------------------------------------------------------------------------
// The MAC address of a server's interface, made from its id so that a repeated clone gives the same one: the config
// drive is written before the VM exists and names the interface by it. Locally administered (02:...), so it can
// never fall into a host's pool of dynamic addresses (00:15:5D:..), which Microsoft says a static one must avoid.
export const macOf = (seed) => `02:15:5d:${createHash('sha256').update(String(seed)).digest('hex').slice(0, 6).replace(/(..)(?=.)/g, '$1:')}`;
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

export async function clone(ps, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || !b.template || !b.pool || !b.datastore || !b.network) throw new Failure('INVALID_REQUEST', 'name, template, pool, datastore and network are required');
  if (!/^lvm-[\w-]{1,76}$/.test(b.name)) throw new Failure('INVALID_REQUEST', 'the name may hold letters, digits, - and _ only');
  if (b.customization === 'appliance') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'appliance images (nested ESXi) need VMware');
  const mac = macOf(b.serverId || b.name);
  const { files, ips } = driveFiles(b.metadata, b.userdata, b.serverId ?? '', mac);
  // The copy runs on the host on its own (a large disk takes minutes); this call only starts it.
  const out = await run(ps, 'clone', { name: b.name, template: b.template, datastore: String(b.datastore).replace(/:$/, ''), network: b.network, vcpu: Number(b.vcpu) || 1, memoryMb: Number(b.memoryMb) || 1024,
    diskGb: Number(b.diskGb) || 0, nestedHv: !!b.nestedHv, notes: `${note(b.serverId ?? '')}\nlvm-ips=${ips.join(',')}`, iso: configDrive(files).toString('base64'), mac: mac.replace(/:/g, '').toUpperCase(), worker: Buffer.from(CLONE_WORKER, 'utf8').toString('base64') });
  return out.existed ? { vm: out.vm, existed: true } : { task: out.task, existed: false };
}
export async function task(ps, b) {
  const out = await run(ps, 'task', { task: String(b.task ?? '') });
  if (out.state === 'success') return { state: 'success', vm: out.vm };
  if (out.state === 'error') return { state: 'error', code: out.code || 'TASK_FAILED', error: String(out.error ?? '') };
  return out.state === 'unknown' ? { state: 'unknown', code: 'TASK_NOT_FOUND' } : { state: 'running' };
}

export async function find(ps, b) {
  if (!b.name) throw new Failure('INVALID_REQUEST', 'name is required');
  const out = await run(ps, 'find', { name: b.name });
  return { vm: out.vm ? clean(out.vm) : null };
}
export async function managedVms(ps) { return { vms: [].concat((await run(ps, 'managed')).vms ?? []).map(clean) }; }

export async function powerAction(ps, b) {
  if (!['on', 'off', 'reset', 'shutdown'].includes(b.action)) throw new Failure('INVALID_REQUEST', 'unknown power action');
  return run(ps, 'power', { vm: b.vm, action: b.action });
}
export const destroy = (ps, b) => run(ps, 'destroy', { vm: b.vm });

export async function resize(ps, b) {
  const vcpu = Number(b.vcpu), memoryMb = Number(b.memoryMb), diskGb = Number(b.diskGb);
  if (!(vcpu >= 1) || !(memoryMb >= 256) || !(diskGb >= 1)) throw new Failure('INVALID_REQUEST', 'vcpu, memoryMb and diskGb are required');
  return run(ps, 'resize', { vm: b.vm, vcpu, memoryMb, diskGb });
}
export async function rename(ps, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || String(b.name).length > 80) throw new Failure('INVALID_REQUEST', 'name must start with lvm- and be at most 80 characters');
  return run(ps, 'rename', { vm: b.vm, name: b.name });
}

// ---- disks ---------------------------------------------------------------------------------------
const diskList = (raw) => [].concat(raw ?? []).map((d, i) => ({ key: Number(d.key), label: String(d.path ?? '').split(/[\\/]/).pop() ?? '', sizeGb: Math.floor((Number(d.size) || 0) / GIB), system: i === 0 }));
export async function disks(ps, b) { return { disks: diskList((await run(ps, 'disks', { vm: b.vm })).disks) }; }
export async function diskAdd(ps, b) {
  const sizeGb = Number(b.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536) throw new Failure('INVALID_REQUEST', 'sizeGb must be 1 to 65536');
  return run(ps, 'diskAdd', { vm: b.vm, sizeGb });
}
export const diskRemove = (ps, b) => run(ps, 'diskRemove', { vm: b.vm, key: Number(b.key) });

// ---- snapshots (checkpoints) ---------------------------------------------------------------------
export async function snapshots(ps, b) {
  const list = [].concat((await run(ps, 'snapshots', { vm: b.vm })).snapshots ?? []);
  return { snapshots: list.map((s) => ({ id: snapId(s.id), name: s.name, description: String(s.notes ?? ''), created: new Date(s.created).toISOString(), powerState: 'poweredOff', current: !!s.current,
    parent: isGuid(s.parent) ? snapId(s.parent) : '' })) };
}
export async function snapshot(ps, b) {
  if (b.action === 'create') {
    const name = String(b.name ?? ''), description = String(b.description ?? '');
    if (!name || Buffer.byteLength(name) > 80 || Buffer.byteLength(description) > 500) throw new Failure('INVALID_REQUEST', 'name is 1 to 80 bytes, description at most 500');
    return run(ps, 'snapshot', { vm: b.vm, action: 'create', name });
  }
  if (b.action !== 'revert' && b.action !== 'remove') throw new Failure('INVALID_REQUEST', 'unknown snapshot action');
  const target = [].concat((await run(ps, 'snapshots', { vm: b.vm })).snapshots ?? []).find((s) => snapId(s.id) === b.snapshot);
  if (!target) throw new Failure('SNAPSHOT_NOT_FOUND', 'the checkpoint is not in this VM');
  return run(ps, 'snapshot', { vm: b.vm, action: b.action, snapshot: target.id });
}

// ---- reading -------------------------------------------------------------------------------------
export async function details(ps, b) {
  const d = await run(ps, 'details', { vm: b.vm });
  const s = clean(d.state), running = s.powerState === 'poweredOn';
  const all = [].concat(d.disks ?? []), nics = [].concat(d.nics ?? []);
  const drive = (p) => /^[A-Za-z]:/.test(String(p)) ? `${String(p)[0].toUpperCase()}:` : '';
  return {
    moref: s.moref, name: s.name, instanceUuid: s.moref, biosUuid: s.moref, guestId: '', configuredOs: d.guestOs ?? '', hardwareVersion: String(d.version ?? ''), firmware: Number(d.generation) === 2 ? 'efi' : 'bios', secureBoot: !!d.secureBoot,
    annotation: String(d.notes ?? '').split('\n').filter((l) => !l.startsWith('lvm-ips=')).join('\n'), powerState: s.powerState, connectionState: 'connected',
    bootTime: running && d.uptime ? new Date(Date.now() - Number(d.uptime) * 1000).toISOString() : null, uptimeSeconds: running ? Number(d.uptime) || 0 : 0, overallStatus: 'green', consolidationNeeded: false,
    snapshots: Number(d.snapshots) || 0, committedGb: 0, uncommittedGb: 0,
    cpu: { count: Number(d.cpu) || 0, coresPerSocket: 1, hotAdd: false, reservationMhz: 0, limitMhz: -1, shares: 0, usageMhz: 0 },
    memory: { sizeMb: Math.floor((Number(d.memoryStartup) || 0) / MIB), hotAdd: !!d.dynamicMemory, reservationMb: 0, limitMb: -1, shares: 0, guestUsageMb: Math.floor((Number(d.memoryDemand) || 0) / MIB),
      hostUsageMb: Math.floor((Number(d.memoryAssigned) || 0) / MIB), balloonedMb: 0, swappedMb: 0 },
    nics: nics.map((n, i) => ({ label: n.name || `Network adapter ${i + 1}`, adapter: 'synthetic', mac: String(n.mac ?? '').replace(/(..)(?=.)/g, '$1:').toLowerCase(), macType: n.dynamic ? 'generated' : 'manual', connected: running && !!n.connected,
      startConnected: true, network: n.switch ?? '', kind: 'standard', portKey: '', portgroupKey: '', switch: n.switch ?? '', vlan: Number(n.vlan) > 0 ? Number(n.vlan) : null, ips: [].concat(n.ips ?? []), guestConnected: [].concat(n.ips ?? []).length ? true : null })),
    disks: all.map((x, i) => ({ label: `Hard disk ${i + 1}`, capacityGb: round2((Number(x.size) || 0) / GIB), datastore: drive(x.path), file: x.path, provisioning: 'thin', mode: 'persistent', controller: x.controller ?? '', bus: x.bus ?? '' })),
    cdroms: [].concat(d.dvds ?? []).map((x, i) => ({ label: `CD/DVD drive ${i + 1}`, iso: x.path ?? '', connected: !!x.path })),
    tools: { status: s.toolsRunning ? 'toolsOk' : running ? 'toolsNotRunning' : 'toolsNotInstalled', runningStatus: s.toolsRunning ? 'guestToolsRunning' : 'guestToolsNotRunning', version: '', versionStatus: '' },
    guest: { hostName: '', os: d.guestOs ?? '', family: /windows/i.test(d.guestOs ?? '') ? 'windowsGuest' : 'linuxGuest', ips: s.ips, gateways: [], dns: [], domain: '', state: running ? 'running' : 'notRunning', heartbeat: s.toolsRunning ? 'green' : 'gray' },
    placement: { host: d.host ?? '', cluster: '', resourcePool: '', folder: '', datastores: [...new Set(all.map((x) => drive(x.path)).filter(Boolean))].sort(), vmxPath: d.path ?? '' },
  };
}

// Hyper-V keeps no usage history unless resource metering is turned on: what is known now, and no samples.
export async function metrics(ps, b) {
  const d = await run(ps, 'details', { vm: b.vm });
  return { interval: 60, samples: [], quick: { cpuMhz: 0, memoryActiveMb: Math.floor((Number(d.memoryDemand) || 0) / MIB), uptimeSeconds: Number(d.uptime) || 0 } };
}

export async function topology(ps) {
  const h = await run(ps, 'discover');
  const host = String(h.uuid || h.name), mhz = Number(h.mhz) || 0, cores = Number(h.cores) || 0;
  const vms = [].concat(h.vms ?? []), threads = Number(h.threads) || cores || 1;
  const vmMhz = (v) => Math.round(((Number(v.cpuUsage) || 0) / 100) * (Number(v.cpu) || 0) * mhz);
  return { time: new Date().toISOString(), compute: [{ moref: host, name: h.name, kind: 'host' }],
    hosts: [{ moref: host, name: h.name, compute: host, state: 'connected', power: 'poweredOn', cpuUsedMhz: Math.min(mhz * cores, Math.round(vms.reduce((n, v) => n + vmMhz(v), 0) * (cores / threads))), cpuTotalMhz: mhz * cores,
      memUsedMb: Math.floor(Math.max(0, (Number(h.memory) || 0) - (Number(h.freeMemory) || 0)) / MIB), memTotalMb: Math.floor((Number(h.memory) || 0) / MIB) }],
    datastores: [].concat(h.volumes ?? []).map((v) => ({ moref: String(v.letter).toUpperCase(), name: `${v.letter}:`, capacityGb: (Number(v.size) || 0) / GIB, freeGb: (Number(v.free) || 0) / GIB, hosts: [host] })),
    vms: vms.filter((v) => String(v.name).startsWith(PREFIX)).map((v) => ({ moref: v.id, name: v.name, host, power: v.power, cpuUsedMhz: vmMhz(v), memUsedMb: Math.floor((Number(v.memoryAssigned) || 0) / MIB), rxKBps: null, txKBps: null })),
    otherVms: vms.filter((v) => !String(v.name).startsWith(PREFIX) && !v.template).length };
}
export async function powerReport(ps) {
  const [t, h] = [await topology(ps), await run(ps, 'discover')];
  const host = t.hosts[0];
  return { time: t.time, hosts: [{ moref: host.moref, name: host.name, watts: null, cpuUsedMhz: host.cpuUsedMhz, cpuTotalMhz: host.cpuTotalMhz, coreMhz: Number(h.mhz) || 0, connected: true }],
    vms: t.vms.filter((v) => v.power === 'poweredOn' && v.name.length > PREFIX.length).map((v) => ({ name: v.name, host: v.host, cpuUsedMhz: v.cpuUsedMhz, traffic: [] })) };
}
