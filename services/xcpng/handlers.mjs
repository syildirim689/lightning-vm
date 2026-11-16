// The adapter contract (docs/adapter-contract.md) on XAPI: XCP-ng and XenServer / Citrix Hypervisor.
// Ids the panel stores are XAPI uuids (stable for the life of the object):
//   VM, template, host, datastore (storage repository), network   their uuid
//   compute and its "resource pool"                              the pool's uuid (a pool is one compute resource)
//   task                                                         the XAPI task reference (a copy's task carries the new
//                                                                VM's name, so a repeated clone finds it; nothing else)
//   snapshot                                                     "snapshot-<n>": n is kept on the snapshot
// A new server gets its settings from a cloud-init NoCloud config drive (iso.mjs), so everything in the worker's
// cloud-config arrives: network, host name, SSH keys, root password, files and first-boot commands. The drive is
// written before the copy starts and also carries (in its other_config, without the secrets) what the copy still
// needs to become that server, so the work can be finished by whoever sees the copy first: /v1/task, a repeated
// clone, or find - also after a lost answer, a toolstack restart or a task XAPI has forgotten.
// Each function takes the call of one opened session (xapi.mjs connect) and the request body.
import { createHash, randomBytes } from 'node:crypto';
import { configDrive } from './iso.mjs';
import { Failure } from './xapi.mjs';

const PREFIX = 'lvm-';
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const NULL = 'OpaqueRef:NULL';
const DRIVE = 'lvm-config-drive';
const PENDING = 'lvm-pending', COPY = 'lvm-copy', OWNER = 'lightning.vm-name', MARK = 'lightning.server-id';
const power = (s) => (s === 'Running' ? 'poweredOn' : s === 'Suspended' || s === 'Paused' ? 'suspended' : 'poweredOff');
const round2 = (n) => Math.round(n * 100) / 100;
const real = (v) => !v.is_control_domain && !v.is_a_snapshot && !v.is_default_template;
const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(x ?? ''));
const note = (serverId) => `Managed by Lightning VM (server ${serverId})`;
const date = (x) => { const t = typeof x === 'string' ? x : x?.['$date'] ?? ''; const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})Z?$/.exec(t); return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(t || 0); };

async function vmRef(call, uuid) {
  if (!isUuid(uuid)) throw new Failure('INVALID_REQUEST', 'vm is required');
  try { return await call('VM.get_by_uuid', uuid); } catch (e) { if (e.code === 'VM_NOT_FOUND') throw new Failure('VM_NOT_FOUND', 'the VM no longer exists'); throw e; }
}
// The VMs of that name. XAPI lists snapshots (and the control domain) as VMs too: they are never the VM asked for.
async function named(call, name) {
  const out = [];
  for (const ref of await call('VM.get_by_name_label', name)) { const vm = await call('VM.get_record', ref); if (!vm.is_a_snapshot && !vm.is_control_domain) out.push({ ref, vm }); }
  return out;
}
async function locate(call, uuid) { const ref = await vmRef(call, uuid); return { ref, vm: await call('VM.get_record', ref) }; }
const managed = (vm) => { if (!String(vm.name_label ?? '').startsWith(PREFIX)) throw new Failure('NOT_MANAGED', 'this VM was not created by the panel'); };
const byUuid = async (call, cls, uuid, missing) => { if (!isUuid(uuid)) throw new Failure(missing, `${cls} not found`); try { return await call(`${cls}.get_by_uuid`, uuid); } catch { throw new Failure(missing, `${cls} not found`); } };

// The VM's hard disks in device order (the config drive is not one of them).
async function disksOf(call, vm) {
  const out = [];
  for (const ref of vm.VBDs ?? []) {
    const vbd = await call('VBD.get_record', ref);
    if (vbd.type !== 'Disk' || vbd.VDI === NULL) continue;
    const vdi = await call('VDI.get_record', vbd.VDI);
    out.push({ ref, vbd, vdi, device: Number(vbd.userdevice), drive: String(vdi.name_label ?? '').startsWith(DRIVE) });
  }
  out.sort((a, b) => a.device - b.device);
  const all = out.filter((d) => !d.drive);
  return { all, system: all[0], drive: out.find((d) => d.drive), every: out };
}
const guestIps = (networks = {}) => [...new Set(Object.entries(networks).filter(([k]) => /\/ip(v6\/\d+)?$/.test(k)).map(([, v]) => String(v)).filter((a) => a && !/^fe80:/i.test(a)))];
// A VM as the worker watches it. Without guest tools nothing reports from inside: a server that has been running
// for four minutes then counts as ready with the addresses it was given, so it is not stuck "starting" for ever.
// "Tools" means addresses reported from inside: a stock cloud image has the PV drivers in its kernel (XAPI then keeps
// a guest-metrics record for it) but no guest utilities, so the record alone says nothing and the four minutes apply.
async function state(call, vm, withGuest) {
  const out = { moref: vm.uuid, name: vm.name_label, powerState: power(vm.power_state), toolsRunning: false, ips: [] };
  const id = vm.other_config?.[MARK]; if (id) out.serverId = id;
  if (!withGuest || vm.power_state !== 'Running') return out;
  const gm = vm.guest_metrics && vm.guest_metrics !== NULL ? await call('VM_guest_metrics.get_record', vm.guest_metrics).catch(() => null) : null;
  const seen = guestIps(gm?.networks);
  if (seen.length) { out.toolsRunning = true; out.ips = seen; return out; }
  const started = vm.metrics && vm.metrics !== NULL ? await call('VM_metrics.get_record', vm.metrics).then((m) => date(m.start_time).getTime(), () => 0) : 0;
  if (started && Date.now() - started > 240_000) { out.toolsRunning = true; out.ips = String(vm.other_config?.['lightning.ips'] ?? '').split(',').filter(Boolean); }
  return out;
}

// ---- discovery -----------------------------------------------------------------------------------
export async function discover(call) {
  const [pools, hosts, metrics, srs, pbds, nets, pifs, vms] = await Promise.all(['pool', 'host', 'host_metrics', 'SR', 'PBD', 'network', 'PIF', 'VM'].map((c) => call(`${c}.get_all_records`)));
  const pool = Object.values(pools)[0] ?? {};
  const master = hosts[pool.master] ?? Object.values(hosts)[0] ?? {};
  const sw = master.software_version ?? {};
  const brand = sw.product_brand || 'XCP-ng';
  const hostList = Object.entries(hosts).map(([ref, h]) => {
    const info = h.cpu_info ?? {}, m = metrics[h.metrics] ?? {};
    const cpus = Number(info.cpu_count) || 0, live = m.live !== false;
    return { ref, moref: h.uuid, name: h.name_label || h.hostname, hardwareUuid: h.uuid, vendor: info.vendor ?? '', model: info.modelname ?? '', cpuMhz: Math.round(Number(info.speed) || 0), cpuCores: cpus, cpuThreads: cpus,
      memoryBytes: Number(m.memory_total) || 0, connectionState: live ? 'connected' : 'disconnected', powerState: live ? 'poweredOn' : 'unknown', inMaintenance: h.enabled === false, version: h.software_version?.product_version ?? '',
      managementServer: '', parent: pool.uuid };
  });
  const uuidOfHost = Object.fromEntries(hostList.map((h) => [h.ref, h.moref]));
  const datastores = Object.entries(srs).filter(([, s]) => s.type !== 'udev' && s.type !== 'iso' && s.content_type !== 'iso' && !s.is_tools_sr && Number(s.physical_size) > 0).map(([ref, s]) => {
    const attached = Object.values(pbds).filter((p) => p.SR === ref && p.currently_attached);
    return { moref: s.uuid, name: s.name_label, type: s.type, capacityBytes: Number(s.physical_size), freeBytes: Math.max(0, Number(s.physical_size) - Number(s.physical_utilisation)),
      uncommittedBytes: Math.max(0, Number(s.virtual_allocation) - Number(s.physical_utilisation)), accessible: attached.length > 0, maintenanceMode: 'normal', hosts: attached.map((p) => uuidOfHost[p.host]).filter(Boolean) };
  });
  const networks = Object.entries(nets).filter(([, n]) => n.bridge).map(([ref, n]) => {
    const vlan = Object.values(pifs).find((p) => p.network === ref && Number(p.VLAN) >= 0);
    return { moref: n.uuid, name: n.name_label, kind: 'standard', vlan: vlan ? Number(vlan.VLAN) : null, switch: n.bridge };
  });
  const list = Object.values(vms).filter(real).map((v) => ({ moref: v.uuid, name: v.name_label, uuid: v.uuid, instanceUuid: v.uuid, powerState: power(v.power_state), host: uuidOfHost[v.resident_on] ?? uuidOfHost[v.affinity] ?? hostList[0]?.moref ?? '',
    cpu: Number(v.VCPUs_max) || 0, memoryMb: Math.floor(Number(v.memory_static_max) / MIB), template: !!v.is_a_template, guest: v.other_config?.['base_template_name'] ?? '', committedBytes: 0, uncommittedBytes: 0 }));
  const version = String(sw.product_version ?? '');
  return {
    product: { kind: 'xcpng', name: brand, fullName: `${brand} ${version}`.trim(), version, build: String(sw.build_number ?? ''), apiType: 'XAPI', apiVersion: `${master.API_version_major ?? ''}.${master.API_version_minor ?? ''}`, instanceUuid: pool.uuid ?? '' },
    licenses: [], writeApi: 'available', privileges: {},
    operations: { inventory: true, createVm: true, cloneFromImage: true, power: true, resize: true, deleteVm: true, snapshot: true, console: false, firewall: false, automationApi: true },
    warnings: [], hosts: hostList.map(({ ref: _r, ...h }) => h), datastores, networks,
    compute: pool.uuid ? [{ moref: pool.uuid, name: pool.name_label || master.name_label || 'pool', kind: hostList.length > 1 ? 'cluster' : 'standalone', hosts: hostList.length,
      effectiveCpuMhz: hostList.reduce((n, h) => n + h.cpuMhz * h.cpuCores, 0), effectiveMemoryMb: Math.floor(hostList.reduce((n, h) => n + h.memoryBytes, 0) / MIB), resourcePool: pool.uuid }] : [],
    vms: list, compat: { apiVersion: version, customization: 'cloudinit', clone: true, consoleUrl: false, support: 'supported' },
  };
}

// ---- provisioning --------------------------------------------------------------------------------
// The worker's network document was written for VMware's datasource (netplan in the guest). On a config drive it
// is also read by cloud-init's own renderers (EL with NetworkManager, Debian without netplan), and cloud-init 22.4
// there refuses "to: default", turns an IPv6 default route into a /64 one and takes the ethernets key as the
// interface name instead of matching by name (seen on a real Debian 12; the same rewrite as services/incus). So the
// default routes become 0.0.0.0/0 and gateway6, and the one interface is bound to the MAC address its VIF gets, under
// the key and set-name eth0: cloud-init renames the NIC with that MAC before any renderer runs (net/__init__.py,
// extract_physdevs) and netplan matches it itself, whatever the guest's kernel would have called it.
export function guestNetwork(network, mac) {
  const out = structuredClone(network), nics = {}, entries = Object.entries(out?.ethernets ?? {});
  for (const [key, nic] of entries) {
    const routes = [];
    for (const r of Array.isArray(nic?.routes) ? nic.routes : []) {
      const v6 = String(r?.via ?? '').includes(':');
      if (r?.to === '::/0' || (r?.to === 'default' && v6)) nic.gateway6 = r.via;
      else routes.push(r?.to === 'default' ? { ...r, to: '0.0.0.0/0' } : r);
    }
    if (routes.length) nic.routes = routes; else delete nic.routes;
    if (mac && entries.length === 1) { nic.match = { macaddress: mac.toLowerCase() }; nic['set-name'] = 'eth0'; nics.eth0 = nic; } else nics[key] = nic;
  }
  if (out?.ethernets) out.ethernets = nics;
  return out;
}
// The worker's two documents as the three files of a NoCloud config drive. Its meta-data carries the network the
// way VMware's datasource wants it; NoCloud reads the network from a file of its own.
export function driveFiles(metadata, userdata, serverId, mac) {
  let meta = {}; try { meta = JSON.parse(metadata || '{}'); } catch { /* not JSON */ }
  const { network, ...rest } = meta;
  const files = { 'meta-data': `${JSON.stringify({ 'instance-id': serverId, ...rest })}\n`, 'user-data': String(userdata || '#cloud-config\n{}\n') };
  if (network) files['network-config'] = `${JSON.stringify(guestNetwork(network, mac))}\n`;
  return { files, ips: (Object.values(network?.ethernets ?? {})[0]?.addresses ?? []).map((a) => String(a).split('/')[0]) };
}
// The MAC address is chosen here (locally administered, unicast: what XAPI generates too), because the drive that
// names it is written before the VIF exists.
const newMac = () => { const b = randomBytes(6); b[0] = (b[0] & 0xfe) | 0x02; return [...b].map((x) => x.toString(16).padStart(2, '0')).join(':'); };
// What the request says the copy must become: `p` without secrets (it is kept on the drive), `files` with them.
function plan(b) {
  const mac = newMac(), { files, ips } = driveFiles(b.metadata, b.userdata, b.serverId ?? '', mac);
  return { files, p: { vcpu: b.vcpu, memoryMb: b.memoryMb, diskGb: b.diskGb, network: b.network, serverId: b.serverId ?? '', nestedHv: !!b.nestedHv, mac, ips } };
}

// The config drive made for the VM of that name: found again by its label and its tag (so a retry writes the same
// one instead of leaving a 4 MiB disk behind each time).
async function driveOf(call, name) {
  for (const ref of await call('VDI.get_by_name_label', `${DRIVE} ${name}`)) { const vdi = await call('VDI.get_record', ref); if (vdi.other_config?.[OWNER] === name && !vdi.is_a_snapshot) return { ref, vdi }; }
  return null;
}
const pendingOf = (vdi) => { try { return JSON.parse(Buffer.from(vdi.other_config[PENDING], 'base64').toString('utf8')); } catch { return null; } };
async function writeDrive(call, sr, name, p, files) {
  const image = configDrive(files), other = { [OWNER]: name, [PENDING]: Buffer.from(JSON.stringify(p)).toString('base64') };
  let d = await driveOf(call, name);
  // Left on another storage by an earlier attempt (the worker picks the datastore anew): not attached to anything yet.
  if (d && d.vdi.SR !== sr && !(d.vdi.VBDs ?? []).length) { await call('VDI.destroy', d.ref); d = null; }
  if (d) await call('VDI.set_other_config', d.ref, { ...d.vdi.other_config, ...other });
  else d = { ref: await call('VDI.create', { name_label: `${DRIVE} ${name}`, name_description: 'cloud-init settings of this server (Lightning VM)', SR: sr, virtual_size: Math.max(image.length, 4 * MIB), type: 'user',
    sharable: false, read_only: false, other_config: other, xenstore_data: {}, sm_config: {}, tags: [] }) };
  await call.put('/import_raw_vdi', { vdi: d.ref, format: 'raw' }, image);
  return d.ref;
}
// A copy of that name that still runs. Its task is handed back instead of starting a second copy, and nobody
// touches a VM that is still being written.
async function copying(call, name) {
  return Object.entries(await call('task.get_all_records')).find(([, t]) => t.status === 'pending' && t.other_config?.[COPY] === name)?.[0] ?? null;
}

export async function clone(call, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || !b.template || !b.pool || !b.datastore || !b.network) throw new Failure('INVALID_REQUEST', 'name, template, pool, datastore and network are required');
  if (b.customization === 'appliance') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'appliance images (nested ESXi) need VMware');
  const running = await copying(call, b.name);
  if (running) return { task: running, existed: false };
  const [earlier] = await named(call, b.name);
  if (earlier) {
    // A copy nobody finished (the answer was lost and the task forgotten): it becomes the server now, from this
    // request, rather than being handed out with the template's size and network and no settings.
    if (!earlier.vm.other_config?.[MARK]) { const { p, files } = plan(b); await finishClone(call, earlier.ref, p, files); }
    return { vm: earlier.vm.uuid, existed: true };
  }
  const template = await byUuid(call, 'VM', b.template, 'TEMPLATE_NOT_FOUND');
  const tvm = await call('VM.get_record', template);
  if (!(tvm.VIFs ?? []).length) throw new Failure('TEMPLATE_HAS_NO_NIC', 'the template has no network interface');
  const { system } = await disksOf(call, tvm);
  if (system && Number(b.diskGb) > 0 && Number(b.diskGb) * GIB < Number(system.vdi.virtual_size)) throw new Failure('DISK_SMALLER_THAN_TEMPLATE', 'the disk is smaller than the template');
  const sr = await byUuid(call, 'SR', b.datastore, 'DATASTORE_NOT_FOUND');
  await byUuid(call, 'network', b.network, 'NETWORK_NOT_FOUND');
  // The drive first: the user data (a password hash, scripts, a token) lives on it and nowhere else - not in a task
  // record, which any pool user can read and XAPI throws away when it likes.
  const { p, files } = plan(b);
  await writeDrive(call, sr, b.name, p, files);
  // A full copy onto the chosen storage.
  const task = await call('Async.VM.copy', template, b.name, sr);
  await call('task.add_to_other_config', task, COPY, b.name);
  return { task, existed: false };
}

const blank = { other_config: {}, qos_algorithm_type: '', qos_algorithm_params: {} };
// The copy is there: it becomes a VM of the right size on the right network, with its config drive. Every step
// looks at what is already so, so a retry after a half-done run carries on. `files` (only a clone request has
// them) writes the drive anew; without them the drive written before the copy is attached. The marker comes last:
// a VM without it is an unfinished copy to everyone who finds it.
async function finishClone(call, ref, p, files) {
  let vm = await call('VM.get_record', ref);
  if (vm.is_a_template) { await call('VM.provision', ref); vm = await call('VM.get_record', ref); }
  await call('VM.set_name_description', ref, note(p.serverId));
  const vcpu = Number(p.vcpu) || 0, mem = (Number(p.memoryMb) || 0) * MIB;
  if (vcpu) {
    // The maximum may never be below what the VM starts with: raise it first, or lower it last.
    if (vcpu > Number(vm.VCPUs_max)) { await call('VM.set_VCPUs_max', ref, vcpu); await call('VM.set_VCPUs_at_startup', ref, vcpu); }
    else { await call('VM.set_VCPUs_at_startup', ref, vcpu); await call('VM.set_VCPUs_max', ref, vcpu); }
  }
  if (mem) await call('VM.set_memory_limits', ref, Math.min(Number(vm.memory_static_min) || mem, mem), mem, mem, mem);
  if (p.nestedHv) await call('VM.add_to_platform', ref, 'exp-nested-hvm', 'true').catch(() => undefined);
  const network = await byUuid(call, 'network', p.network, 'NETWORK_NOT_FOUND');
  const vifs = await Promise.all((vm.VIFs ?? []).map(async (r) => ({ ref: r, vif: await call('VIF.get_record', r) })));
  const first = vifs.sort((a, c) => Number(a.vif.device) - Number(c.vif.device))[0];
  // The first interface: on the ordered network, with the MAC address the drive's network-config is bound to.
  if (!first || first.vif.network !== network || (p.mac && String(first.vif.MAC).toLowerCase() !== p.mac)) {
    if (first) await call('VIF.destroy', first.ref);
    await call('VIF.create', { ...blank, device: first?.vif.device ?? '0', network, VM: ref, MAC: p.mac ?? '', MTU: 1500, locking_mode: 'network_default', ipv4_allowed: [], ipv6_allowed: [] });
  }
  const { system, drive } = await disksOf(call, vm);
  if (system && p.diskGb && Number(p.diskGb) * GIB > Number(system.vdi.virtual_size)) await call('VDI.resize', system.vbd.VDI, Number(p.diskGb) * GIB);
  if (system) {
    const vdi = files ? await writeDrive(call, system.vdi.SR, vm.name_label, p, files) : drive?.vbd.VDI ?? (await driveOf(call, vm.name_label))?.ref;
    if (!vdi) throw new Failure('XAPI_ERROR', 'the config drive of this server is missing');
    if (!drive) {
      const free = (await call('VM.get_allowed_VBD_devices', ref)).map(Number).filter((n) => n >= 2).sort((a, c) => a - c)[0] ?? 3;
      await call('VBD.create', { ...blank, VM: ref, VDI: vdi, userdevice: String(free), bootable: false, mode: 'RO', type: 'Disk', unpluggable: true, empty: false });
    }
  }
  await call('VM.set_other_config', ref, { ...vm.other_config, [MARK]: p.serverId, 'lightning.ips': (p.ips ?? []).join(',') });
}

const fault = (code) => (code === 'VM_BAD_POWER_STATE' || code === 'OTHER_OPERATION_IN_PROGRESS' || code === 'OPERATION_NOT_ALLOWED' ? 'INVALID_STATE' : code === 'RBAC_PERMISSION_DENIED' ? 'PERMISSION_DENIED'
  : code === 'SR_FULL' || code === 'HOST_NOT_ENOUGH_FREE_MEMORY' || code === 'NO_HOSTS_AVAILABLE' ? 'INSUFFICIENT_RESOURCES' : code === 'LICENCE_RESTRICTION' ? 'WRITE_RESTRICTED' : 'TASK_FAILED');
export async function task(call, b) {
  const ref = String(b.task ?? '');
  if (!/^OpaqueRef:[\w-]+$/.test(ref)) throw new Failure('INVALID_REQUEST', 'task is required');
  let t;
  try { t = await call('task.get_record', ref); } catch (e) { if (e.code === 'VM_NOT_FOUND') return { state: 'unknown', code: 'TASK_NOT_FOUND' }; throw e; }
  if (t.status === 'pending' || t.status === 'cancelling') return { state: 'running' };
  if (t.status !== 'success') {
    const [code, ...rest] = t.error_info ?? [];
    // A copy that failed has no VM to carry its drive: the drive (and the settings on it) goes too.
    const left = t.other_config?.[COPY] ? await driveOf(call, t.other_config[COPY]).catch(() => null) : null;
    if (left && !(left.vdi.VBDs ?? []).length) await call('VDI.destroy', left.ref).catch(() => undefined);
    return { state: 'error', code: fault(code), error: [code, ...rest].filter(Boolean).join(' ') || t.status };
  }
  const made = /OpaqueRef:[\w-]+/.exec(String(t.result ?? ''))?.[0];
  const vm = made ? await call('VM.get_record', made).catch(() => null) : null;
  if (vm && t.other_config?.[COPY] && !vm.other_config?.[MARK]) {
    const p = pendingOf((await driveOf(call, vm.name_label))?.vdi);
    if (p) await finishClone(call, made, p);
  }
  return { state: 'success', ...(vm && { vm: vm.uuid }) };
}

export async function find(call, b) {
  if (!b.name) throw new Failure('INVALID_REQUEST', 'name is required');
  const [found] = await named(call, b.name);
  if (!found) return { vm: null };
  let { vm } = found;
  // No marker, but a drive with settings waiting for it: a copy nobody finished. While it is still being written it
  // is not a server; afterwards it is made one here, before anyone starts it. (A VM taken over by rename has neither.)
  if (!vm.other_config?.[MARK] && String(vm.name_label).startsWith(PREFIX)) {
    const p = pendingOf((await driveOf(call, vm.name_label))?.vdi);
    if (p) { if (await copying(call, vm.name_label)) return { vm: null }; await finishClone(call, found.ref, p); vm = await call('VM.get_record', found.ref); }
  }
  return { vm: await state(call, vm, true) };
}
export async function managedVms(call) {
  const all = Object.values(await call('VM.get_all_records')).filter((v) => real(v) && String(v.name_label ?? '').startsWith(PREFIX));
  return { vms: await Promise.all(all.map((v) => state(call, v, false))) };
}

export async function powerAction(call, b) {
  if (!['on', 'off', 'reset', 'shutdown'].includes(b.action)) throw new Failure('INVALID_REQUEST', 'unknown power action');
  const { ref, vm } = await locate(call, b.vm);
  const running = vm.power_state === 'Running';
  if ((b.action === 'on' && running) || ((b.action === 'off' || b.action === 'shutdown') && vm.power_state === 'Halted')) return { task: '' };
  if (b.action === 'on' || (b.action === 'reset' && !running)) return { task: await call('Async.VM.start', ref, false, false) };
  if (b.action === 'off') return { task: await call('Async.VM.hard_shutdown', ref) };
  if (b.action === 'reset') return { task: await call('Async.VM.hard_reboot', ref) };
  // A clean shutdown needs the guest's cooperation (PV drivers with the shutdown feature). Without it XAPI leaves
  // clean_shutdown out of the VM's allowed operations and the asynchronous call would fail unseen, the worker
  // waiting five minutes for nothing: said at once, in the contract's word for it. (Judged only while the hard
  // shutdown is allowed, so a VM that is busy with something else is not taken for one without tools.)
  const allowed = vm.allowed_operations ?? [];
  if (allowed.includes('hard_shutdown') && !allowed.includes('clean_shutdown')) throw new Failure('TOOLS_NOT_RUNNING', 'the guest cannot be asked to shut down (no guest tools)');
  // The worker watches the power state, so no task is handed back.
  await call('Async.VM.clean_shutdown', ref);
  return { task: '' };
}

// XAPI's VM.destroy removes the VM record only: its disks stay, and so do its snapshots (VMs of their own, with
// disks of their own). Snapshots go first, then the VM, then its disks. A disk that cannot be removed is reported
// (the storage keeps filling otherwise, unseen) once everything else is gone.
const removeVm = async (call, ref, vm) => {
  const failed = [];
  for (const { ref: s, s: snap } of await snapsOf(call, vm)) await removeVm(call, s, snap).catch((e) => failed.push(e.message));
  const { every } = await disksOf(call, vm);
  await call('VM.destroy', ref);
  for (const d of every) await call('VDI.destroy', d.vbd.VDI).catch((e) => { if (e.code !== 'VM_NOT_FOUND') failed.push(`${d.vdi.uuid}: ${e.message}`); });
  if (failed.length) throw new Failure('XAPI_ERROR', `the VM is removed, but not all of its disks: ${failed.join('; ')}`);
};
export async function destroy(call, b) {
  let found;
  try { found = await locate(call, b.vm); } catch (e) { if (e.code === 'VM_NOT_FOUND') return { task: '', gone: true }; throw e; }
  managed(found.vm);
  if (found.vm.power_state !== 'Halted') await call('VM.hard_shutdown', found.ref).catch((e) => { if (e.code !== 'INVALID_STATE') throw e; });
  await removeVm(call, found.ref, found.vm); // XAPI keeps the disks of a destroyed VM: they go too
  // An unfinished copy never had its config drive attached: that goes as well (its user data is on it).
  const left = await driveOf(call, found.vm.name_label).catch(() => null);
  if (left) await call('VDI.destroy', left.ref).catch(() => undefined);
  return { task: '' };
}

export async function resize(call, b) {
  const vcpu = Number(b.vcpu), memoryMb = Number(b.memoryMb), diskGb = Number(b.diskGb);
  if (!(vcpu >= 1) || !(memoryMb >= 256) || !(diskGb >= 1)) throw new Failure('INVALID_REQUEST', 'vcpu, memoryMb and diskGb are required');
  const { ref, vm } = await locate(call, b.vm); managed(vm);
  const { system } = await disksOf(call, vm);
  if (!system) throw new Failure('VM_HAS_NO_DISK', 'the VM has no disk');
  const now = Math.ceil(Number(system.vdi.virtual_size) / GIB);
  if (diskGb < now) throw new Failure('DISK_SHRINK_NOT_SUPPORTED', 'a disk cannot be made smaller');
  if (diskGb > now && (vm.snapshots ?? []).length) throw new Failure('DISK_HAS_SNAPSHOTS', 'remove the snapshots before growing the disk');
  if (vcpu > Number(vm.VCPUs_max)) { await call('VM.set_VCPUs_max', ref, vcpu); await call('VM.set_VCPUs_at_startup', ref, vcpu); }
  else { await call('VM.set_VCPUs_at_startup', ref, vcpu); await call('VM.set_VCPUs_max', ref, vcpu); }
  const mem = memoryMb * MIB;
  await call('VM.set_memory_limits', ref, Math.min(Number(vm.memory_static_min) || mem, mem), mem, mem, mem);
  if (diskGb > now) await call('VDI.resize', system.vbd.VDI, diskGb * GIB);
  return { task: '' };
}

export async function rename(call, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || String(b.name).length > 80) throw new Failure('INVALID_REQUEST', 'name must start with lvm- and be at most 80 characters');
  const { ref, vm } = await locate(call, b.vm);
  const diskGb = Math.ceil(Number((await disksOf(call, vm)).system?.vdi.virtual_size ?? 0) / GIB);
  if (vm.name_label === b.name) return { name: b.name, diskGb };
  if (String(vm.name_label ?? '').startsWith(PREFIX) || vm.is_a_template) throw new Failure('NOT_IMPORTABLE', 'already managed, or a template');
  await call('VM.set_name_label', ref, b.name);
  return { name: b.name, diskGb };
}

// ---- disks ---------------------------------------------------------------------------------------
export async function disks(call, b) {
  const { vm } = await locate(call, b.vm); managed(vm);
  const { all, system } = await disksOf(call, vm);
  return { disks: all.map((d) => ({ key: d.device, label: d.vdi.name_label || `disk ${d.device}`, sizeGb: Math.floor(Number(d.vdi.virtual_size) / GIB), system: d === system })) };
}
export async function diskAdd(call, b) {
  const sizeGb = Number(b.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536) throw new Failure('INVALID_REQUEST', 'sizeGb must be 1 to 65536');
  const { ref, vm } = await locate(call, b.vm); managed(vm);
  const { system } = await disksOf(call, vm);
  if (!system) throw new Failure('VM_HAS_NO_DISK', 'the VM has no disk');
  const free = (await call('VM.get_allowed_VBD_devices', ref)).map(Number).sort((a, c) => a - c)[0];
  if (free === undefined) throw new Failure('NO_DISK_CONTROLLER', 'no free disk slot');
  const vdi = await call('VDI.create', { name_label: `${vm.name_label} disk ${free}`, name_description: '', SR: system.vdi.SR, virtual_size: sizeGb * GIB, type: 'user', sharable: false, read_only: false,
    other_config: {}, xenstore_data: {}, sm_config: {}, tags: [] });
  const vbd = await call('VBD.create', { ...blank, VM: ref, VDI: vdi, userdevice: String(free), bootable: false, mode: 'RW', type: 'Disk', unpluggable: true, empty: false });
  if (vm.power_state === 'Running') await call('VBD.plug', vbd).catch(() => undefined); // without guest tools it shows after the next start
  return { task: '' };
}
export async function diskRemove(call, b) {
  const { vm } = await locate(call, b.vm); managed(vm);
  const { all, system } = await disksOf(call, vm);
  const d = all.find((x) => x.device === Number(b.key));
  if (!d) return { task: '', gone: true };
  if (d === system) throw new Failure('SYSTEM_DISK', 'the system disk cannot be removed');
  if (d.vbd.currently_attached) await call('VBD.unplug', d.ref).catch((e) => { throw new Failure('INVALID_STATE', `the disk is in use in the server: ${e.message}`); });
  await call('VBD.destroy', d.ref);
  await call('VDI.destroy', d.vbd.VDI);
  return { task: '' };
}

// ---- snapshots -----------------------------------------------------------------------------------
const snapId = (s) => `snapshot-${/^\d{1,12}$/.test(s.other_config?.['lightning.snap-id'] ?? '') ? s.other_config['lightning.snap-id'] : Number.parseInt(createHash('sha1').update(s.uuid).digest('hex').slice(0, 11), 16) % 1e12}`;
const snapsOf = async (call, vm) => Promise.all((vm.snapshots ?? []).map(async (ref) => ({ ref, s: await call('VM.get_record', ref) })));
export async function snapshots(call, b) {
  const { vm } = await locate(call, b.vm);
  const list = (await snapsOf(call, vm)).sort((a, c) => date(a.s.snapshot_time) - date(c.s.snapshot_time));
  return { snapshots: list.map(({ s }) => ({ id: snapId(s), name: s.name_label, description: s.name_description ?? '', created: date(s.snapshot_time).toISOString(), powerState: 'poweredOff', current: false, parent: '' })) };
}
export async function snapshot(call, b) {
  const { ref, vm } = await locate(call, b.vm);
  if (b.action === 'create') {
    const name = String(b.name ?? ''), description = String(b.description ?? '');
    if (!name || Buffer.byteLength(name) > 80 || Buffer.byteLength(description) > 500) throw new Failure('INVALID_REQUEST', 'name is 1 to 80 bytes, description at most 500');
    const taken = new Set((await snapsOf(call, vm)).map(({ s }) => s.other_config?.['lightning.snap-id']));
    let n = Math.floor(Date.now() / 1000); while (taken.has(String(n))) n += 1;
    // Disks only, no memory: it works without guest tools (crash-consistent), like on the other platforms.
    // Two arguments: the third (ignore_vdis, default none) exists since XAPI 21.4.0 and an older one refuses the call.
    const made = await call('VM.snapshot', ref, name);
    await call('VM.set_name_description', made, description);
    await call('VM.add_to_other_config', made, 'lightning.snap-id', String(n));
    return { task: '' };
  }
  if (b.action !== 'revert' && b.action !== 'remove') throw new Failure('INVALID_REQUEST', 'unknown snapshot action');
  const target = (await snapsOf(call, vm)).find(({ s }) => snapId(s) === b.snapshot);
  if (!target) throw new Failure('SNAPSHOT_NOT_FOUND', 'the snapshot is not in this VM');
  if (b.action === 'revert') { await call('VM.revert', target.ref); return { task: '' }; }
  await removeVm(call, target.ref, target.s);
  return { task: '' };
}

// ---- reading -------------------------------------------------------------------------------------
export async function details(call, b) {
  const { vm } = await locate(call, b.vm);
  const running = vm.power_state === 'Running';
  const [{ all }, vifs, gm, vmm, host] = await Promise.all([disksOf(call, vm), Promise.all((vm.VIFs ?? []).map((r) => call('VIF.get_record', r))),
    vm.guest_metrics && vm.guest_metrics !== NULL ? call('VM_guest_metrics.get_record', vm.guest_metrics).catch(() => null) : null,
    vm.metrics && vm.metrics !== NULL ? call('VM_metrics.get_record', vm.metrics).catch(() => null) : null,
    vm.resident_on && vm.resident_on !== NULL ? call('host.get_record', vm.resident_on).catch(() => null) : null]);
  const ips = guestIps(gm?.networks);
  const nics = await Promise.all(vifs.sort((a, c) => Number(a.device) - Number(c.device)).map(async (v, i) => {
    const net = await call('network.get_record', v.network).catch(() => ({}));
    const mine = Object.entries(gm?.networks ?? {}).filter(([k]) => k.startsWith(`${v.device}/ip`)).map(([, a]) => String(a));
    return { label: `Network adapter ${i + 1}`, adapter: 'netfront', mac: v.MAC, macType: v.MAC_autogenerated ? 'generated' : 'manual', connected: running && !!v.currently_attached, startConnected: true, network: net.name_label ?? '',
      kind: 'standard', portKey: '', portgroupKey: '', switch: net.bridge ?? '', vlan: null, ips: mine, guestConnected: mine.length ? true : null };
  }));
  const srNames = await Promise.all(all.map((d) => call('SR.get_record', d.vdi.SR).then((s) => s.name_label, () => '')));
  const start = vmm ? date(vmm.start_time) : null;
  const os = gm?.os_version ?? {};
  return {
    moref: vm.uuid, name: vm.name_label, instanceUuid: vm.uuid, biosUuid: vm.uuid, guestId: os.distro ?? '', configuredOs: os.name ?? vm.other_config?.base_template_name ?? '', hardwareVersion: String(vm.hardware_platform_version ?? ''),
    firmware: vm.HVM_boot_params?.firmware === 'uefi' ? 'efi' : 'bios', secureBoot: vm.platform?.secureboot === 'true', annotation: vm.name_description ?? '', powerState: power(vm.power_state), connectionState: 'connected',
    bootTime: running && start && start.getTime() > 0 ? start.toISOString() : null, uptimeSeconds: running && start && start.getTime() > 0 ? Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000)) : 0,
    overallStatus: 'green', consolidationNeeded: false, snapshots: (vm.snapshots ?? []).length, committedGb: round2(all.reduce((n, d) => n + Number(d.vdi.physical_utilisation || 0), 0) / GIB),
    uncommittedGb: round2(all.reduce((n, d) => n + Math.max(0, Number(d.vdi.virtual_size) - Number(d.vdi.physical_utilisation || 0)), 0) / GIB),
    cpu: { count: Number(vm.VCPUs_at_startup) || 0, coresPerSocket: Number(vm.platform?.['cores-per-socket']) || 1, hotAdd: Number(vm.VCPUs_max) > Number(vm.VCPUs_at_startup), reservationMhz: 0, limitMhz: -1, shares: Number(vm.VCPUs_params?.weight) || 0, usageMhz: 0 },
    memory: { sizeMb: Math.floor(Number(vm.memory_static_max) / MIB), hotAdd: Number(vm.memory_dynamic_min) < Number(vm.memory_static_max), reservationMb: 0, limitMb: -1, shares: 0, guestUsageMb: Math.floor(Number(vmm?.memory_actual ?? 0) / MIB),
      hostUsageMb: Math.floor(Number(vmm?.memory_actual ?? 0) / MIB), balloonedMb: 0, swappedMb: 0 },
    nics, disks: all.map((d, i) => ({ label: `Hard disk ${i + 1}`, capacityGb: round2(Number(d.vdi.virtual_size) / GIB), datastore: srNames[i], file: d.vdi.uuid, provisioning: 'thin', mode: d.vbd.mode === 'RO' ? 'read-only' : 'persistent',
      controller: `xvd ${d.device}`, bus: 'xvd' })),
    cdroms: [], tools: { status: gm ? 'toolsOk' : running ? 'toolsNotRunning' : 'toolsNotInstalled', runningStatus: gm ? 'guestToolsRunning' : 'guestToolsNotRunning',
      version: [gm?.PV_drivers_version?.major, gm?.PV_drivers_version?.minor, gm?.PV_drivers_version?.micro].filter((x) => x !== undefined).join('.'), versionStatus: gm?.PV_drivers_up_to_date ? 'guestToolsCurrent' : '' },
    guest: { hostName: gm?.other?.hostname ?? '', os: os.name ?? '', family: /windows/i.test(os.name ?? '') ? 'windowsGuest' : 'linuxGuest', ips, gateways: [], dns: [], domain: '', state: running ? 'running' : 'notRunning', heartbeat: gm ? 'green' : 'gray' },
    placement: { host: host?.name_label ?? '', cluster: '', resourcePool: '', folder: '', datastores: [...new Set(srNames.filter(Boolean))].sort(), vmxPath: vm.uuid },
  };
}

// Usage over time lives in XAPI's RRD files, which this first version does not read: the answer has the shape
// the panel wants, with what is known now and no samples.
export async function metrics(call, b) {
  const { vm } = await locate(call, b.vm);
  const vmm = vm.metrics && vm.metrics !== NULL ? await call('VM_metrics.get_record', vm.metrics).catch(() => null) : null;
  const start = vmm ? date(vmm.start_time).getTime() : 0;
  return { interval: 60, samples: [], quick: { cpuMhz: 0, memoryActiveMb: Math.floor(Number(vmm?.memory_actual ?? 0) / MIB), uptimeSeconds: vm.power_state === 'Running' && start > 0 ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0 } };
}

export async function topology(call) {
  const d = await discover(call);
  const [metrics, hosts] = await Promise.all([call('host_metrics.get_all_records'), call('host.get_all_records')]);
  const freeOf = Object.fromEntries(Object.values(hosts).map((h) => [h.uuid, Number(metrics[h.metrics]?.memory_free) || 0]));
  const mine = d.vms.filter((v) => v.name.startsWith(PREFIX));
  return { time: new Date().toISOString(), compute: d.compute.map((c) => ({ moref: c.moref, name: c.name, kind: c.kind === 'cluster' ? 'cluster' : 'host' })),
    hosts: d.hosts.map((h) => ({ moref: h.moref, name: h.name, compute: h.parent, state: h.connectionState, power: h.powerState, cpuUsedMhz: 0, cpuTotalMhz: h.cpuMhz * h.cpuCores,
      memUsedMb: Math.floor(Math.max(0, h.memoryBytes - freeOf[h.moref]) / MIB), memTotalMb: Math.floor(h.memoryBytes / MIB) })),
    datastores: d.datastores.map((s) => ({ moref: s.moref, name: s.name, capacityGb: s.capacityBytes / GIB, freeGb: s.freeBytes / GIB, hosts: s.hosts })),
    vms: mine.map((v) => ({ moref: v.moref, name: v.name, host: v.host, power: v.powerState, cpuUsedMhz: 0, memUsedMb: v.powerState === 'poweredOn' ? v.memoryMb : 0, rxKBps: null, txKBps: null })),
    otherVms: d.vms.filter((v) => !v.name.startsWith(PREFIX) && !v.template).length };
}
export async function powerReport(call) {
  const d = await discover(call);
  return { time: new Date().toISOString(),
    hosts: d.hosts.map((h) => ({ moref: h.moref, name: h.name, watts: null, cpuUsedMhz: 0, cpuTotalMhz: h.cpuMhz * h.cpuCores, coreMhz: h.cpuMhz, connected: h.connectionState === 'connected' })),
    vms: d.vms.filter((v) => v.powerState === 'poweredOn' && v.name.startsWith(PREFIX) && v.name.length > PREFIX.length).map((v) => ({ name: v.name, host: v.host, cpuUsedMhz: 0, traffic: [] })) };
}
