// The adapter contract (docs/adapter-contract.md) on Proxmox VE. Ids the panel stores:
//   VM, template     the VMID ("105"); its node is looked up each time, so a migrated VM is still found
//   host, compute    the node's name (every node is one compute resource; its "resource pool" is the node too)
//   datastore        "storage" for shared storage, "storage@node" for a node's own
//   network          the bridge's name ("vmbr0")
//   task             the UPID; "UPID|vmid" for a clone, whose new VM still gets its settings when the copy ends
//   snapshot         "snapshot-<n>": n is the digits of our snapshot name "lvm<n>" (or a number made from another name)
// Each function takes the API of one opened session (pve.mjs connect) and the request body.
import { createHash } from 'node:crypto';
import { Failure } from './pve.mjs';

const PREFIX = 'lvm-';
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const enc = encodeURIComponent;
const power = (status) => (status === 'running' ? 'poweredOn' : status === 'paused' || status === 'suspended' ? 'suspended' : 'poweredOff');
const note = (serverId) => `Managed by Lightning VM (server ${serverId})`;
const serverIdOf = (description) => /Managed by Lightning VM \(server ([0-9a-f-]{36})\)/.exec(description ?? '')?.[1];
const PENDING = 'lvm-pending:';
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resources = (api, type) => api('GET', '/cluster/resources', { type });
const guests = async (api) => (await resources(api, 'vm')).filter((v) => v.type === 'qemu');
async function locate(api, vm) {
  if (!/^\d{1,10}$/.test(String(vm ?? ''))) throw new Failure('INVALID_REQUEST', 'vm is required');
  const found = (await guests(api)).find((v) => String(v.vmid) === String(vm));
  if (!found) throw new Failure('VM_NOT_FOUND', 'the VM no longer exists');
  return found;
}
const base = (v) => `/nodes/${enc(v.node)}/qemu/${v.vmid}`;
const managed = (v) => { if (!String(v.name ?? '').startsWith(PREFIX)) throw new Failure('NOT_MANAGED', 'this VM was not created by the panel'); };

// "local-lvm:vm-105-disk-0,size=32G,ssd=1" -> { volume, storage, size (bytes), media, ... }
function drive(value) {
  const [volume, ...opts] = String(value).split(',');
  const o = Object.fromEntries(opts.map((x) => { const i = x.indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }));
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/.exec(o.size ?? '');
  const size = m ? Number(m[1]) * { '': 1, K: 1024, M: MIB, G: GIB, T: 1024 * GIB }[m[2]] : 0;
  return { volume, storage: volume.includes(':') ? volume.split(':')[0] : '', size, media: o.media ?? 'disk', cloudinit: /cloudinit/.test(volume), opts: o };
}
const BUS = { ide: 0, sata: 100, scsi: 200, virtio: 300 };
const slotKey = (slot) => { const m = /^(ide|sata|scsi|virtio)(\d+)$/.exec(slot); return m ? BUS[m[1]] + Number(m[2]) : -1; };
const keySlot = (key) => { const bus = Object.entries(BUS).reverse().find(([, b]) => key >= b); return bus ? `${bus[0]}${key - bus[1]}` : ''; };
// The VM's hard disks in device order; the system disk is the first in the boot order (else the first disk).
function disksOf(config) {
  const all = Object.entries(config).filter(([k]) => slotKey(k) >= 0).map(([slot, v]) => ({ slot, ...drive(v) })).filter((d) => d.media === 'disk' && !d.cloudinit && d.volume !== 'none')
    .sort((a, b) => slotKey(a.slot) - slotKey(b.slot));
  const order = /order=([^,]+)/.exec(config.boot ?? '')?.[1]?.split(';') ?? (config.bootdisk ? [config.bootdisk] : []);
  const system = all.find((d) => order.includes(d.slot)) ?? all[0];
  return { all, system };
}
const nicsOf = (config) => Object.entries(config).filter(([k]) => /^net\d+$/.test(k)).sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3))).map(([slot, v]) => {
  const parts = String(v).split(','); const [model, mac] = parts[0].split('=');
  const o = Object.fromEntries(parts.slice(1).map((x) => x.split('=')));
  return { slot, model, mac: mac ?? '', bridge: o.bridge ?? '', vlan: o.tag ? Number(o.tag) : null, down: o.link_down === '1', raw: String(v) };
});

// What the guest agent says about the guest's addresses; null when no agent answers.
async function agentAddresses(api, v) {
  try {
    const r = await api('GET', `${base(v)}/agent/network-get-interfaces`);
    const list = r?.result ?? r ?? [];
    return list.filter((i) => i.name !== 'lo').map((i) => ({ mac: String(i['hardware-address'] ?? '').toUpperCase(),
      ips: (i['ip-addresses'] ?? []).filter((a) => !/^fe80:/i.test(a['ip-address']) && a['ip-address'] !== '127.0.0.1' && a['ip-address'] !== '::1').map((a) => ({ ip: a['ip-address'], prefix: a.prefix })) }));
  } catch { return null; }
}
const configured = (config) => [...String(config.ipconfig0 ?? '').matchAll(/ip6?=([0-9a-f.:]+)\//gi)].map((m) => m[1]);
// A VM as the worker watches it. Without a guest agent in the template a running VM counts as ready with the
// addresses cloud-init was given (the panel cannot look inside), so a server is not stuck "starting" for ever.
async function state(api, v, withGuest) {
  const out = { moref: String(v.vmid), name: v.name ?? '', powerState: power(v.status), toolsRunning: false, ips: [] };
  if (!withGuest) return out;
  const config = await api('GET', `${base(v)}/config`).catch(() => ({}));
  const id = serverIdOf(config.description); if (id) out.serverId = id;
  if (v.status !== 'running') return out;
  if (/(^|,)(enabled=)?1/.test(String(config.agent ?? ''))) {
    const seen = await agentAddresses(api, v);
    if (seen) { out.toolsRunning = true; out.ips = [...new Set(seen.flatMap((i) => i.ips.map((a) => a.ip)))]; }
  } else { out.toolsRunning = true; out.ips = configured(config); }
  return out;
}

// ---- discovery -----------------------------------------------------------------------------------
const WANTED = ['VM.Allocate', 'VM.Clone', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Disk', 'VM.Config.Network', 'VM.Config.Cloudinit', 'VM.PowerMgmt', 'VM.Snapshot', 'VM.Audit', 'VM.Console',
  'Datastore.AllocateSpace', 'Datastore.Audit', 'Sys.Audit', 'SDN.Use'];
export async function discover(api) {
  const version = api.version ?? await api('GET', '/version');
  const [status, all] = await Promise.all([api('GET', '/cluster/status').catch(() => []), api('GET', '/cluster/resources')]);
  const cluster = status.find((s) => s.type === 'cluster');
  const nodes = all.filter((r) => r.type === 'node');
  const instance = `pve-${cluster?.name ?? nodes.map((n) => n.node).sort()[0] ?? 'node'}`;
  const warnings = [];
  let granted = {};
  try {
    const perms = await api('GET', '/access/permissions');
    for (const path of ['/', '/vms', '/storage', '/nodes', '/sdn']) for (const [k, on] of Object.entries(perms?.[path] ?? {})) if (on) granted[k] = true;
  } catch { granted = null; warnings.push('PRIVILEGES_UNREADABLE'); }
  const privileges = granted ? Object.fromEntries(WANTED.map((p) => [p, !!granted[p]])) : {};
  const has = (...p) => !!granted && p.every((x) => granted[x]);

  const hosts = [], compute = [];
  for (const n of nodes) {
    const online = n.status === 'online';
    const st = online ? await api('GET', `/nodes/${enc(n.node)}/status`).catch(() => null) : null;
    const cpu = st?.cpuinfo ?? {};
    const mhz = Math.round(Number(cpu.mhz) || 0);
    hosts.push({ moref: n.node, name: n.node, hardwareUuid: `${instance}:${n.node}`, vendor: '', model: cpu.model ?? '', cpuMhz: mhz, cpuCores: (cpu.cores ?? 0) * (cpu.sockets ?? 1) || n.maxcpu || 0,
      cpuThreads: cpu.cpus ?? n.maxcpu ?? 0, memoryBytes: st?.memory?.total ?? n.maxmem ?? 0, connectionState: online ? 'connected' : 'disconnected', powerState: online ? 'poweredOn' : 'unknown',
      inMaintenance: false, version: st?.pveversion ?? '', managementServer: '', parent: n.node });
    compute.push({ moref: n.node, name: n.node, kind: 'standalone', hosts: 1, effectiveCpuMhz: mhz * (n.maxcpu ?? 0), effectiveMemoryMb: Math.floor((n.maxmem ?? 0) / MIB), resourcePool: n.node });
  }
  // Storage that can hold VM disks or ISO images. A shared storage is one datastore for all its nodes.
  const stores = new Map();
  for (const s of all.filter((r) => r.type === 'storage' && /images|iso/.test(r.content ?? ''))) {
    const id = s.shared ? s.storage : `${s.storage}@${s.node}`;
    const d = stores.get(id) ?? { moref: id, name: s.shared ? s.storage : `${s.storage} (${s.node})`, type: s.plugintype ?? '', capacityBytes: 0, freeBytes: 0, uncommittedBytes: 0, accessible: false, maintenanceMode: 'normal', hosts: [] };
    if (!d.hosts.length || !s.shared) { d.capacityBytes = s.maxdisk ?? 0; d.freeBytes = Math.max(0, (s.maxdisk ?? 0) - (s.disk ?? 0)); }
    d.accessible = d.accessible || s.status === 'available';
    d.hosts.push(s.node);
    stores.set(id, d);
  }
  const bridges = new Map();
  for (const n of nodes.filter((x) => x.status === 'online')) {
    for (const b of await api('GET', `/nodes/${enc(n.node)}/network`, { type: 'any_bridge' }).catch(() => [])) {
      if (b.iface && !bridges.has(b.iface)) bridges.set(b.iface, { moref: b.iface, name: b.iface, kind: 'standard', vlan: null, switch: b.type ?? 'bridge' });
    }
  }
  const vms = all.filter((r) => r.type === 'qemu').map((v) => ({ moref: String(v.vmid), name: v.name ?? `VM ${v.vmid}`, uuid: '', instanceUuid: '', powerState: power(v.status), host: v.node, cpu: v.maxcpu ?? 0,
    memoryMb: Math.floor((v.maxmem ?? 0) / MIB), template: v.template === 1, guest: '', committedBytes: v.disk || v.maxdisk || 0, uncommittedBytes: 0 }));
  const release = String(version.release ?? version.version ?? '');
  return {
    product: { kind: 'proxmox', name: 'Proxmox VE', fullName: `Proxmox VE ${version.version}`, version: String(version.version), build: String(version.repoid ?? ''), apiType: 'ProxmoxVE', apiVersion: release, instanceUuid: instance },
    licenses: [], writeApi: 'available', privileges,
    operations: { inventory: true, createVm: has('VM.Allocate', 'Datastore.AllocateSpace'), cloneFromImage: has('VM.Clone', 'VM.Allocate', 'Datastore.AllocateSpace'), power: has('VM.PowerMgmt'),
      resize: has('VM.Config.CPU', 'VM.Config.Memory'), deleteVm: has('VM.Allocate'), snapshot: has('VM.Snapshot'), console: false, firewall: false, automationApi: true },
    warnings, hosts, datastores: [...stores.values()], networks: [...bridges.values()], compute, vms,
    compat: { apiVersion: release, customization: 'cloudinit', clone: true, consoleUrl: false, support: Number.parseInt(release, 10) >= 8 ? 'supported' : 'end-of-support' },
  };
}

// ---- provisioning --------------------------------------------------------------------------------
// The worker's cloud-init documents (written for VMware's datasource) as Proxmox's own cloud-init settings:
// the first IPv4 and IPv6 address with their gateways, the name servers and the SSH keys. What Proxmox cannot
// carry this way (a password hash, the host name, files and first-boot commands) is done through the guest agent
// once the server is up: guestSetup below. Further IPv4 addresses are not configured.
export function cloudInitSettings(metadata, userdata) {
  const out = {};
  let meta = {}, user = {};
  try { meta = JSON.parse(metadata || '{}'); } catch { /* not JSON: nothing to take */ }
  try { user = JSON.parse(String(userdata || '').replace(/^#cloud-config\s*/, '') || '{}'); } catch { /* same */ }
  const nic = Object.values(meta.network?.ethernets ?? {})[0];
  if (nic) {
    const v4 = (nic.addresses ?? []).find((a) => !a.includes(':')), v6 = (nic.addresses ?? []).find((a) => a.includes(':'));
    const gw4 = (nic.routes ?? []).find((r) => r.to === 'default')?.via, gw6 = (nic.routes ?? []).find((r) => r.to === '::/0')?.via;
    const parts = [v4 && `ip=${v4}`, v4 && gw4 && `gw=${gw4}`, v6 && `ip6=${v6}`, v6 && gw6 && `gw6=${gw6}`].filter(Boolean);
    if (parts.length) out.ipconfig0 = parts.join(',');
    const dns = (nic.nameservers?.addresses ?? []).filter((a) => /^[0-9a-f.:]+$/i.test(a));
    if (dns.length) out.nameserver = dns.join(' ');
  }
  const keys = (user.ssh_authorized_keys ?? []).filter((k) => typeof k === 'string' && k.trim());
  if (keys.length) out.sshkeys = enc(keys.join('\n')); // Proxmox wants the value URL-encoded once more
  return out;
}

export async function clone(api, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || !b.template || !b.pool || !b.datastore || !b.network) throw new Failure('INVALID_REQUEST', 'name, template, pool, datastore and network are required');
  if (b.customization === 'appliance') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'appliance images (nested ESXi) need VMware');
  const all = await guests(api);
  const earlier = all.find((v) => v.name === b.name);
  if (earlier) return { vm: String(earlier.vmid), existed: true };
  const template = all.find((v) => String(v.vmid) === String(b.template));
  if (!template) throw new Failure('TEMPLATE_NOT_FOUND', 'the template no longer exists');
  const config = await api('GET', `${base(template)}/config`);
  if (!nicsOf(config).length) throw new Failure('TEMPLATE_HAS_NO_NIC', 'the template has no network interface');
  const { system } = disksOf(config);
  if (system && Number(b.diskGb) > 0 && Number(b.diskGb) * GIB < system.size) throw new Failure('DISK_SMALLER_THAN_TEMPLATE', 'the disk is smaller than the template');
  const node = String(b.pool);
  const storage = String(b.datastore).split('@')[0];
  // What the new VM still needs once the copy exists; kept in its notes until then (the adapter keeps no state).
  const pending = Buffer.from(JSON.stringify({ vcpu: b.vcpu, memoryMb: b.memoryMb, diskGb: b.diskGb, network: b.network, nestedHv: !!b.nestedHv, ...cloudInitSettings(b.metadata, b.userdata) })).toString('base64');
  const newid = Number(await api('GET', '/cluster/nextid'));
  const task = await api('POST', `${base(template)}/clone`, { newid, name: b.name, full: 1, storage, ...(node !== template.node && { target: node }),
    description: `${note(b.serverId ?? '')}\n${PENDING}${pending}` }).catch((e) => {
    if (/already exists|duplicate/i.test(e.message)) throw new Failure('DUPLICATE_NAME', e.message);
    throw e;
  });
  return { task: `${task}|${newid}`, existed: false };
}

// Some changes are tasks even where the contract wants them done within the request (growing a disk): wait a
// little for the task, and say so when it is still running (the caller comes back).
async function settled(api, upid, seconds = 20) {
  const node = /^UPID:([^:]+):/.exec(String(upid ?? ''))?.[1];
  if (!node) return; // an older Proxmox answers at once, with nothing to wait for
  for (let i = 0; i < seconds * 2; i++) {
    const st = await api('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/status`);
    if (st.status === 'stopped') { if (st.exitstatus !== 'OK' && !/^WARNINGS/.test(String(st.exitstatus))) throw new Failure(taskFault(String(st.exitstatus)), String(st.exitstatus)); return; }
    await sleep(500);
  }
  throw new Failure('TIMEOUT', 'the disk is still being resized');
}

// The copy is there: CPU, memory, the network, cloud-init and the disk size. Every step can be repeated.
async function finishClone(api, vmid) {
  const v = (await guests(api)).find((x) => String(x.vmid) === String(vmid));
  if (!v) return;
  const config = await api('GET', `${base(v)}/config`);
  const line = String(config.description ?? '').split('\n').find((l) => l.startsWith(PENDING));
  if (!line) return; // already done
  const p = JSON.parse(Buffer.from(line.slice(PENDING.length), 'base64').toString('utf8'));
  const nic = nicsOf(config)[0];
  const set = { description: String(config.description).split('\n').filter((l) => !l.startsWith(PENDING)).join('\n') };
  if (p.vcpu) { set.cores = p.vcpu; set.sockets = 1; }
  if (p.memoryMb) set.memory = p.memoryMb;
  if (nic && p.network) set[nic.slot] = nic.raw.replace(/(^|,)bridge=[^,]*/, '').replace(/(^|,)tag=[^,]*/, '') + `,bridge=${p.network}`;
  for (const k of ['ipconfig0', 'nameserver', 'sshkeys']) if (p[k]) set[k] = p[k];
  if (p.nestedHv) set.cpu = 'host';
  const { system } = disksOf(config);
  // A template without a cloud-init drive gets one next to its system disk, or the settings above reach nobody.
  if (!Object.values(config).some((x) => /cloudinit/.test(String(x))) && system?.storage) set.ide2 = `${system.storage}:cloudinit`;
  if (system && p.diskGb && Number(p.diskGb) * GIB > system.size) await settled(api, await api('PUT', `${base(v)}/resize`, { disk: system.slot, size: `${p.diskGb}G` }));
  await api('PUT', `${base(v)}/config`, set);
}

const taskFault = (text) => (/already running|not running|is locked|already stopped/i.test(text) ? 'INVALID_STATE' : /permission|not allowed/i.test(text) ? 'PERMISSION_DENIED'
  : /already exists|duplicate/i.test(text) ? 'DUPLICATE_NAME' : /out of space|no space|not enough|insufficient|exceeds/i.test(text) ? 'INSUFFICIENT_RESOURCES' : 'TASK_FAILED');
export async function task(api, b) {
  const [upid, vmid] = String(b.task ?? '').split('|');
  const node = /^UPID:([^:]+):/.exec(upid)?.[1];
  if (!node) throw new Failure('INVALID_REQUEST', 'task is required');
  let st;
  try { st = await api('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/status`); }
  catch (e) { if (e.code === 'VM_NOT_FOUND' || e.code === 'PROXMOX_ERROR') return { state: 'unknown', code: 'TASK_NOT_FOUND' }; throw e; }
  if (st.status !== 'stopped') return { state: 'running' };
  const exit = String(st.exitstatus ?? '');
  if (exit !== 'OK' && !/^WARNINGS/.test(exit)) return { state: 'error', code: taskFault(exit), error: exit };
  if (vmid) { await finishClone(api, vmid); return { state: 'success', vm: vmid }; }
  return { state: 'success' };
}

export async function find(api, b) {
  if (!b.name) throw new Failure('INVALID_REQUEST', 'name is required');
  const v = (await guests(api)).find((x) => x.name === b.name);
  return { vm: v ? await state(api, v, true) : null };
}
export async function managedVms(api) {
  return { vms: await Promise.all((await guests(api)).filter((v) => String(v.name ?? '').startsWith(PREFIX)).map((v) => state(api, v, false))) };
}

export async function powerAction(api, b) {
  const act = { on: 'start', off: 'stop', reset: 'reset', shutdown: 'shutdown' }[b.action];
  if (!act) throw new Failure('INVALID_REQUEST', 'unknown power action');
  const v = await locate(api, b.vm);
  const running = v.status === 'running';
  // Already as asked: nothing to start (VMware fails such a task with INVALID_STATE, which the worker reads the same way).
  if ((act === 'start' && running) || ((act === 'stop' || act === 'shutdown') && !running)) return { task: '' };
  if (act === 'reset' && !running) return { task: await api('POST', `${base(v)}/status/start`) };
  const upid = await api('POST', `${base(v)}/status/${act}`, act === 'shutdown' ? { timeout: 180 } : undefined);
  // A clean shutdown has no task to wait for in the contract: the worker watches the power state.
  return { task: act === 'shutdown' ? '' : upid };
}

export async function destroy(api, b) {
  let v;
  try { v = await locate(api, b.vm); } catch (e) { if (e.code === 'VM_NOT_FOUND') return { task: '', gone: true }; throw e; }
  managed(v);
  if (v.status === 'running') {
    await api('POST', `${base(v)}/status/stop`).catch(() => undefined);
    for (let i = 0; i < 40; i++) { await sleep(1500); if ((await api('GET', `${base(v)}/status/current`)).status === 'stopped') break; }
  }
  return { task: await api('DELETE', base(v), { purge: 1, 'destroy-unreferenced-disks': 1 }) };
}

const snapshotList = async (api, v) => (await api('GET', `${base(v)}/snapshot`)) ?? [];
export async function resize(api, b) {
  const vcpu = Number(b.vcpu), memoryMb = Number(b.memoryMb), diskGb = Number(b.diskGb);
  if (!(vcpu >= 1) || !(memoryMb >= 256) || !(diskGb >= 1)) throw new Failure('INVALID_REQUEST', 'vcpu, memoryMb and diskGb are required');
  const v = await locate(api, b.vm); managed(v);
  const config = await api('GET', `${base(v)}/config`);
  const { system } = disksOf(config);
  if (!system) throw new Failure('VM_HAS_NO_DISK', 'the VM has no disk');
  const now = Math.ceil(system.size / GIB);
  if (diskGb < now) throw new Failure('DISK_SHRINK_NOT_SUPPORTED', 'a disk cannot be made smaller');
  if (diskGb > now && (await snapshotList(api, v)).some((s) => s.name !== 'current')) throw new Failure('DISK_HAS_SNAPSHOTS', 'remove the snapshots before growing the disk');
  await api('PUT', `${base(v)}/config`, { cores: vcpu, sockets: 1, memory: memoryMb });
  // Growing the disk is a task of its own on Proxmox: the worker waits for it like for any other.
  const grow = diskGb > now ? await api('PUT', `${base(v)}/resize`, { disk: system.slot, size: `${diskGb}G` }) : '';
  return { task: /^UPID:/.test(String(grow ?? '')) ? grow : '' };
}

export async function rename(api, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || String(b.name).length > 80) throw new Failure('INVALID_REQUEST', 'name must start with lvm- and be at most 80 characters');
  const v = await locate(api, b.vm);
  const config = await api('GET', `${base(v)}/config`);
  const diskGb = Math.ceil((disksOf(config).system?.size ?? 0) / GIB);
  if (v.name === b.name) return { name: b.name, diskGb };
  if (String(v.name ?? '').startsWith(PREFIX) || v.template === 1) throw new Failure('NOT_IMPORTABLE', 'already managed, or a template');
  await api('PUT', `${base(v)}/config`, { name: b.name });
  return { name: b.name, diskGb };
}

// ---- disks ---------------------------------------------------------------------------------------
export async function disks(api, b) {
  const v = await locate(api, b.vm); managed(v);
  const { all, system } = disksOf(await api('GET', `${base(v)}/config`));
  return { disks: all.map((d) => ({ key: slotKey(d.slot), label: d.slot, sizeGb: Math.floor(d.size / GIB), system: d === system })) };
}
export async function diskAdd(api, b) {
  const sizeGb = Number(b.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536) throw new Failure('INVALID_REQUEST', 'sizeGb must be 1 to 65536');
  const v = await locate(api, b.vm); managed(v);
  const config = await api('GET', `${base(v)}/config`);
  const { system } = disksOf(config);
  if (!system) throw new Failure('VM_HAS_NO_DISK', 'the VM has no disk');
  const bus = system.slot.replace(/\d+$/, ''), max = { ide: 4, sata: 6, scsi: 31, virtio: 16 }[bus];
  const free = Array.from({ length: max }, (_, i) => `${bus}${i}`).find((s) => config[s] === undefined);
  if (!free) throw new Failure('NO_DISK_CONTROLLER', 'no free disk slot');
  return { task: await api('POST', `${base(v)}/config`, { [free]: `${system.storage}:${sizeGb}` }) };
}
export async function diskRemove(api, b) {
  const v = await locate(api, b.vm); managed(v);
  const config = await api('GET', `${base(v)}/config`);
  const slot = keySlot(Number(b.key));
  const { system } = disksOf(config);
  if (!slot || config[slot] === undefined) return { task: '', gone: true };
  if (system?.slot === slot) throw new Failure('SYSTEM_DISK', 'the system disk cannot be removed');
  const volume = drive(config[slot]).volume;
  await api('PUT', `${base(v)}/config`, { delete: slot }); // detached: it stays as "unusedN"
  const after = await api('GET', `${base(v)}/config`);
  const unused = Object.entries(after).find(([k, val]) => /^unused\d+$/.test(k) && String(val) === volume)?.[0];
  if (unused) await api('PUT', `${base(v)}/config`, { delete: unused }); // and its volume is deleted
  return { task: '' };
}

// ---- snapshots -----------------------------------------------------------------------------------
// Our own snapshots are named lvm<n>; another one gets a number made from its name (the panel wants snapshot-<digits>).
const snapId = (name) => `snapshot-${/^lvm(\d{1,12})$/.exec(name)?.[1] ?? Number.parseInt(createHash('sha1').update(name).digest('hex').slice(0, 11), 16) % 1e12}`;
export async function snapshots(api, b) {
  const v = await locate(api, b.vm);
  const list = await snapshotList(api, v);
  const current = list.find((s) => s.name === 'current')?.parent;
  return { snapshots: list.filter((s) => s.name !== 'current').sort((a, c) => (a.snaptime ?? 0) - (c.snaptime ?? 0)).map((s) => {
    const [first, ...rest] = String(s.description ?? '').split('\n');
    const ours = /^lvm\d+$/.test(s.name);
    return { id: snapId(s.name), name: ours && first ? first : s.name, description: ours ? rest.join('\n').trim() : String(s.description ?? '').trim(), created: new Date((s.snaptime ?? 0) * 1000).toISOString(),
      powerState: s.vmstate ? 'poweredOn' : 'poweredOff', current: s.name === current, parent: s.parent ? snapId(s.parent) : '' };
  }) };
}
export async function snapshot(api, b) {
  const v = await locate(api, b.vm);
  if (b.action === 'create') {
    const name = String(b.name ?? ''), description = String(b.description ?? '');
    if (!name || Buffer.byteLength(name) > 80 || Buffer.byteLength(description) > 500) throw new Failure('INVALID_REQUEST', 'name is 1 to 80 bytes, description at most 500');
    const taken = new Set((await snapshotList(api, v)).map((s) => s.name));
    let n = Math.floor(Date.now() / 1000); while (taken.has(`lvm${n}`)) n += 1;
    // Proxmox names are short and plain: the customer's name is the first line of the description.
    return { task: await api('POST', `${base(v)}/snapshot`, { snapname: `lvm${n}`, description: `${name}${description ? `\n${description}` : ''}`, vmstate: 0 }) };
  }
  if (b.action !== 'revert' && b.action !== 'remove') throw new Failure('INVALID_REQUEST', 'unknown snapshot action');
  const target = (await snapshotList(api, v)).find((s) => s.name !== 'current' && snapId(s.name) === b.snapshot);
  if (!target) throw new Failure('SNAPSHOT_NOT_FOUND', 'the snapshot is not in this VM');
  return { task: b.action === 'revert' ? await api('POST', `${base(v)}/snapshot/${enc(target.name)}/rollback`, { start: 0 }) : await api('DELETE', `${base(v)}/snapshot/${enc(target.name)}`) };
}

// ---- reading -------------------------------------------------------------------------------------
export async function details(api, b) {
  const v = await locate(api, b.vm);
  const [config, cur, snaps] = await Promise.all([api('GET', `${base(v)}/config`), api('GET', `${base(v)}/status/current`).catch(() => ({})), snapshotList(api, v).catch(() => [])]);
  const { all } = disksOf(config);
  const running = v.status === 'running';
  const agentOn = /(^|,)(enabled=)?1/.test(String(config.agent ?? ''));
  const seen = running && agentOn ? await agentAddresses(api, v) : null;
  const osinfo = seen ? await api('GET', `${base(v)}/agent/get-osinfo`).then((r) => r?.result ?? r, () => null) : null;
  const hostname = seen ? await api('GET', `${base(v)}/agent/get-host-name`).then((r) => (r?.result ?? r)?.['host-name'] ?? '', () => '') : '';
  const guestIps = seen ? [...new Set(seen.flatMap((i) => i.ips.map((a) => a.ip)))] : running ? configured(config) : [];
  const cdroms = Object.entries(config).filter(([k, val]) => slotKey(k) >= 0 && drive(val).media === 'cdrom' && !drive(val).cloudinit);
  return {
    moref: String(v.vmid), name: v.name ?? '', instanceUuid: '', biosUuid: /uuid=([0-9a-f-]+)/i.exec(config.smbios1 ?? '')?.[1] ?? '', guestId: config.ostype ?? '', configuredOs: config.ostype ?? '',
    hardwareVersion: config.machine ?? '', firmware: config.bios === 'ovmf' ? 'efi' : 'bios', secureBoot: /pre-enrolled-keys=1/.test(config.efidisk0 ?? ''),
    annotation: String(config.description ?? '').split('\n').filter((l) => !l.startsWith(PENDING)).join('\n'), powerState: power(v.status), connectionState: 'connected',
    bootTime: running && cur.uptime ? new Date(Date.now() - cur.uptime * 1000).toISOString() : null, uptimeSeconds: running ? cur.uptime ?? 0 : 0, overallStatus: 'green', consolidationNeeded: false,
    snapshots: snaps.filter((s) => s.name !== 'current').length, committedGb: round2((v.disk || 0) / GIB), uncommittedGb: 0,
    cpu: { count: (config.cores ?? 1) * (config.sockets ?? 1), coresPerSocket: config.cores ?? 1, hotAdd: /cpu/.test(String(config.hotplug ?? '')), reservationMhz: 0, limitMhz: -1, shares: config.cpuunits ?? 0, usageMhz: 0 },
    memory: { sizeMb: Number(config.memory ?? 0), hotAdd: /memory/.test(String(config.hotplug ?? '')), reservationMb: 0, limitMb: -1, shares: config.shares ?? 0, guestUsageMb: Math.floor((cur.mem ?? 0) / MIB),
      hostUsageMb: Math.floor((cur.mem ?? 0) / MIB), balloonedMb: 0, swappedMb: 0 },
    nics: nicsOf(config).map((n, i) => { const g = seen?.find((x) => x.mac === n.mac.toUpperCase());
      return { label: `Network adapter ${i + 1}`, adapter: n.model, mac: n.mac, macType: 'assigned', connected: running && !n.down, startConnected: !n.down, network: n.bridge, kind: 'standard', portKey: '', portgroupKey: '',
        switch: n.bridge, vlan: n.vlan, ips: g ? g.ips.map((a) => (a.prefix ? `${a.ip}/${a.prefix}` : a.ip)) : [], guestConnected: g ? true : null }; }),
    disks: all.map((d, i) => ({ label: `Hard disk ${i + 1}`, capacityGb: round2(d.size / GIB), datastore: d.storage, file: d.volume, provisioning: 'thin', mode: 'persistent', controller: d.slot, bus: d.slot.replace(/\d+$/, '') })),
    cdroms: cdroms.map(([, val], i) => ({ label: `CD/DVD drive ${i + 1}`, iso: drive(val).volume === 'none' ? '' : drive(val).volume, connected: drive(val).volume !== 'none' })),
    tools: { status: seen ? 'toolsOk' : agentOn ? 'toolsNotRunning' : 'toolsNotInstalled', runningStatus: seen ? 'guestToolsRunning' : 'guestToolsNotRunning', version: '', versionStatus: '' },
    guest: { hostName: hostname, os: osinfo?.['pretty-name'] ?? '', family: /^w/.test(config.ostype ?? '') ? 'windowsGuest' : 'linuxGuest', ips: guestIps, gateways: [...String(config.ipconfig0 ?? '').matchAll(/gw6?=([0-9a-f.:]+)/gi)].map((m) => m[1]),
      dns: String(config.nameserver ?? '').split(/\s+/).filter(Boolean), domain: config.searchdomain ?? '', state: running ? 'running' : 'notRunning', heartbeat: seen ? 'green' : 'gray' },
    placement: { host: v.node, cluster: '', resourcePool: v.pool ?? '', folder: '', datastores: [...new Set(all.map((d) => d.storage))].sort(), vmxPath: `${v.node}/qemu-server/${v.vmid}.conf` },
  };
}

const rrd = (api, v) => api('GET', `${base(v)}/rrddata`, { timeframe: 'hour', cf: 'AVERAGE' }).then((r) => (r ?? []).filter((p) => p.time).slice(-45), () => []);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export async function metrics(api, b) {
  const v = await locate(api, b.vm);
  const [points, cur] = await Promise.all([v.status === 'running' ? rrd(api, v) : [], api('GET', `${base(v)}/status/current`).catch(() => ({}))]);
  const kb = (a, c) => (num(a) === null && num(c) === null ? null : round2(((a ?? 0) + (c ?? 0)) / 1024));
  return { interval: 60, // Proxmox keeps one value a minute
    samples: points.map((p) => ({ t: new Date(p.time * 1000).toISOString(), cpu: num(p.cpu) === null ? null : round2(p.cpu * 100), mem: num(p.mem) === null || !p.maxmem ? null : round2((p.mem / p.maxmem) * 100),
      net: kb(p.netin, p.netout), disk: kb(p.diskread, p.diskwrite) })),
    quick: { cpuMhz: 0, memoryActiveMb: Math.floor((cur.mem ?? 0) / MIB), uptimeSeconds: cur.uptime ?? 0 } };
}

async function nodeFacts(api, all) {
  const nodes = all.filter((r) => r.type === 'node');
  const mhz = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.node, n.status === 'online' ? Math.round(Number((await api('GET', `/nodes/${enc(n.node)}/status`).catch(() => null))?.cpuinfo?.mhz) || 0) : 0])));
  return { nodes, mhz };
}
export async function topology(api) {
  const all = await api('GET', '/cluster/resources');
  const { nodes, mhz } = await nodeFacts(api, all);
  const stores = new Map();
  for (const s of all.filter((r) => r.type === 'storage' && /images|iso/.test(r.content ?? ''))) {
    const id = s.shared ? s.storage : `${s.storage}@${s.node}`;
    const d = stores.get(id) ?? { moref: id, name: s.shared ? s.storage : `${s.storage} (${s.node})`, capacityGb: (s.maxdisk ?? 0) / GIB, freeGb: Math.max(0, (s.maxdisk ?? 0) - (s.disk ?? 0)) / GIB, hosts: [] };
    d.hosts.push(s.node); stores.set(id, d);
  }
  const qemu = all.filter((r) => r.type === 'qemu');
  return { time: new Date().toISOString(),
    compute: nodes.map((n) => ({ moref: n.node, name: n.node, kind: 'host' })),
    hosts: nodes.map((n) => ({ moref: n.node, name: n.node, compute: n.node, state: n.status === 'online' ? 'connected' : 'disconnected', power: n.status === 'online' ? 'poweredOn' : 'unknown',
      cpuUsedMhz: Math.round((n.cpu ?? 0) * (n.maxcpu ?? 0) * mhz[n.node]), cpuTotalMhz: (n.maxcpu ?? 0) * mhz[n.node], memUsedMb: Math.floor((n.mem ?? 0) / MIB), memTotalMb: Math.floor((n.maxmem ?? 0) / MIB) })),
    datastores: [...stores.values()],
    vms: qemu.filter((v) => String(v.name ?? '').startsWith(PREFIX)).map((v) => ({ moref: String(v.vmid), name: v.name, host: v.node, power: power(v.status), cpuUsedMhz: Math.round((v.cpu ?? 0) * (v.maxcpu ?? 0) * (mhz[v.node] ?? 0)),
      memUsedMb: Math.floor((v.mem ?? 0) / MIB), rxKBps: null, txKBps: null })),
    otherVms: qemu.filter((v) => !String(v.name ?? '').startsWith(PREFIX) && v.template !== 1).length };
}

// The worker counts traffic as rate x 1024 x 20 seconds per sample. Proxmox has one value a minute, so each
// rate is sent three times as large: the bytes of the whole minute are counted once, by the sample's own time.
export async function powerReport(api) {
  const all = await api('GET', '/cluster/resources');
  const { nodes, mhz } = await nodeFacts(api, all);
  const running = all.filter((r) => r.type === 'qemu' && r.status === 'running' && String(r.name ?? '').startsWith(PREFIX) && r.name.length > PREFIX.length);
  return { time: new Date().toISOString(),
    hosts: nodes.map((n) => ({ moref: n.node, name: n.node, watts: null, cpuUsedMhz: Math.round((n.cpu ?? 0) * (n.maxcpu ?? 0) * mhz[n.node]), cpuTotalMhz: (n.maxcpu ?? 0) * mhz[n.node], coreMhz: mhz[n.node], connected: n.status === 'online' })),
    vms: await Promise.all(running.map(async (v) => ({ name: v.name, host: v.node, cpuUsedMhz: Math.round((v.cpu ?? 0) * (v.maxcpu ?? 0) * (mhz[v.node] ?? 0)),
      traffic: (await rrd(api, v)).slice(-15).filter((p) => num(p.netin) !== null || num(p.netout) !== null).map((p) => ({ t: new Date(p.time * 1000).toISOString(), rx: round2(((p.netin ?? 0) / 1024) * 3), tx: round2(((p.netout ?? 0) / 1024) * 3) })) }))) };
}

// ---- first-boot work through the guest agent ---------------------------------------------------------
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The rest of the worker's cloud-config, once the server runs: the root password (as the hash it was given),
// the host name, the files and the first-boot commands (an application's installer, the update reporter). It
// happens once: a marker in the guest makes a second call a no-op. Without a guest agent nothing can be done
// from outside, and the answer says so.
export async function guestSetup(api, b) {
  const v = await locate(api, b.vm);
  let user = {};
  try { user = JSON.parse(String(b.userdata || '').replace(/^#cloud-config\s*/, '') || '{}'); } catch { /* nothing to apply */ }
  const hash = /^root:(\$[^\s]+)$/.exec(String(user.chpasswd?.list ?? '').trim())?.[1];
  const files = (user.write_files ?? []).filter((x) => x && typeof x.path === 'string' && /^\/[\w./-]{1,200}$/.test(x.path) && typeof x.content === 'string');
  const commands = (user.runcmd ?? []).map((c) => (Array.isArray(c) ? c.map(quote).join(' ') : typeof c === 'string' ? c : '')).filter(Boolean);
  const hostname = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(String(user.hostname ?? '')) ? String(user.hostname) : '';
  if (!hash && !files.length && !commands.length && !hostname) return { applied: false, reason: 'NOTHING_TO_DO' };
  const config = await api('GET', `${base(v)}/config`);
  if (v.status !== 'running' || !/(^|,)(enabled=)?1/.test(String(config.agent ?? ''))) return { applied: false, reason: 'NO_GUEST_AGENT' };
  if ((await agentAddresses(api, v)) === null) throw new Failure('TOOLS_NOT_RUNNING', 'the guest agent does not answer yet');
  if (hash) await api('POST', `${base(v)}/agent/set-user-password`, { username: 'root', password: hash, crypted: 1 });
  for (const f of files) {
    if (Buffer.byteLength(f.content) > 60_000) throw new Failure('INVALID_REQUEST', `the file ${f.path} is too large for the guest agent`);
    await api('POST', `${base(v)}/agent/file-write`, { file: f.path, content: f.content });
  }
  const marker = '/var/lib/lightning-guest-setup.done';
  const script = ['#!/bin/sh', '# Lightning VM: first-boot settings on Proxmox VE (run once).', `[ -e ${marker} ] && exit 0`, `mkdir -p /var/lib && : > ${marker}`,
    ...(hostname ? [`(hostnamectl set-hostname ${quote(hostname)} || hostname ${quote(hostname)}) >/dev/null 2>&1`] : []),
    ...files.filter((f) => /^[0-7]{3,4}$/.test(String(f.permissions ?? ''))).map((f) => `chmod ${f.permissions} ${quote(f.path)}`), ...commands, ''].join('\n');
  await api('POST', `${base(v)}/agent/file-write`, { file: '/root/.lightning-guest-setup.sh', content: script });
  await api('POST', `${base(v)}/agent/exec`, { command: ['sh', '/root/.lightning-guest-setup.sh'] });
  return { applied: true, password: !!hash, files: files.length, commands: commands.length };
}
