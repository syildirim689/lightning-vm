// The adapter contract (docs/adapter-contract.md) on the oVirt Engine REST API (oVirt, Red Hat Virtualization,
// Oracle Linux Virtualization Manager). Ids the panel stores are the engine's own ids:
//   VM, template, host   their id            compute and its "resource pool"   the cluster's id
//   datastore            the data storage domain's id       network            the vNIC profile's id
//   task                 the engine hands out no task ids over REST, so a task is what to look at until it is settled:
//                        "create:<vm>" (a new VM is ready when it and its disks are no longer locked), "remove:<vm>",
//                        "disk:<disk>" (a disk being grown), "snapshot:<vm>:<snapshot>", "unsnap:<vm>:<snapshot>"
//                        (a snapshot being removed), "restore:<vm>:<snapshot>"
//   snapshot             "snapshot-<n>": a number made from the snapshot's id
// A new server gets its settings from the engine's own cloud-init support: they are stored with the VM when it is
// created and applied at its first start. Each function takes the api of one opened connection (engine.mjs).
import { createHash } from 'node:crypto';
import { Failure } from './engine.mjs';

const PREFIX = 'lvm-';
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const BLANK = '00000000-0000-0000-0000-000000000000';
const isId = (x) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(x ?? ''));
const num = (x) => Number(x) || 0;
const round2 = (n) => Math.round(n * 100) / 100;
const list = (o, key) => (Array.isArray(o?.[key]) ? o[key] : []);
const power = (s) => (['up', 'powering_up', 'migrating', 'reboot_in_progress', 'not_responding', 'powering_down', 'saving_state', 'wait_for_launch'].includes(s) ? 'poweredOn' : s === 'paused' || s === 'suspended' ? 'suspended' : 'poweredOff');
const note = (serverId) => `Managed by Lightning VM (server ${serverId})`;
const serverIdOf = (d) => /Managed by Lightning VM \(server ([0-9a-f-]{36})\)/.exec(d ?? '')?.[1];
const numberOf = (id, mod = 1e12) => Number.parseInt(createHash('sha1').update(String(id)).digest('hex').slice(0, 11), 16) % mod;
const no = (x) => x === false || x === 'false'; // the engine's JSON carries booleans as strings
// Sockets and cores for a number of vCPUs. One core per socket while the engine takes that many sockets (CPU hot-plug
// adds sockets): MaxNumOfVmSockets is 16 up to cluster level 4.5. Beyond it, the largest number of sockets up to 16
// that divides the count, so sockets x cores is always exactly what was ordered (17 is one socket of 17 cores).
const cpuTopology = (vcpu) => { let sockets = Math.min(vcpu, 16); while (vcpu % sockets) sockets -= 1; return { sockets, cores: vcpu / sockets, threads: 1 }; };
const cpus = (vm) => { const t = vm.cpu?.topology ?? {}; return (num(t.sockets) || 1) * (num(t.cores) || 1) * (num(t.threads) || 1); };

async function locate(api, id) {
  if (!isId(id)) throw new Failure('INVALID_REQUEST', 'vm is required');
  try { return await api('GET', `/vms/${id}`); } catch (e) { if (e.code === 'VM_NOT_FOUND') throw new Failure('VM_NOT_FOUND', 'the VM no longer exists'); throw e; }
}
const managed = (vm) => { if (!String(vm.name ?? '').startsWith(PREFIX)) throw new Failure('NOT_MANAGED', 'this VM was not created by the panel'); };
const byName = async (api, name) => list(await api('GET', `/vms?search=${encodeURIComponent(`name=${name}`)}`), 'vm').find((v) => v.name === name);
// The VM's (or template's) disks: the bootable one is the system disk.
async function disksOf(api, kind, id) {
  const atts = list(await api('GET', `/${kind}/${id}/diskattachments`), 'disk_attachment');
  const all = await Promise.all(atts.map(async (a) => ({ att: a, disk: await api('GET', `/disks/${a.disk.id}`) })));
  all.sort((a, b) => Number(b.att.bootable === true || b.att.bootable === 'true') - Number(a.att.bootable === true || a.att.bootable === 'true') || String(a.disk.name).localeCompare(String(b.disk.name)));
  return { all, system: all[0] };
}
// The marks the adapter leaves in the VM's comment: what is still to do (the engine keeps them, the adapter keeps nothing).
const marks = (comment) => Object.fromEntries(String(comment ?? '').split(/\s+/).filter((x) => x.startsWith('lvm:')).map((x) => { const [k, v = '1'] = x.slice(4).split('='); return [k, v]; }));
const withMarks = (m) => Object.entries(m).map(([k, v]) => `lvm:${k}=${v}`).join(' ');

const guestIps = (devices) => [...new Set(devices.flatMap((d) => list(d.ips, 'ip').map((i) => String(i.address))).filter((a) => a && !/^fe80:/i.test(a) && a !== '127.0.0.1' && a !== '::1'))];
async function state(api, vm, withGuest) {
  const out = { moref: vm.id, name: vm.name, powerState: power(vm.status), toolsRunning: false, ips: [] };
  const id = serverIdOf(vm.description); if (id) out.serverId = id;
  if (!withGuest || vm.status !== 'up') return out;
  const devices = list(await api('GET', `/vms/${vm.id}/reporteddevices`).catch(() => ({})), 'reported_device');
  const ips = guestIps(devices);
  // The guest agent reports the addresses. Without one, a server that is up counts as ready with the addresses it was given.
  if (ips.length || vm.guest_operating_system) { out.toolsRunning = true; out.ips = ips; return out; }
  const given = list(vm.initialization?.nic_configurations, 'nic_configuration').flatMap((n) => [n.ip?.address, n.ipv6?.address]).filter(Boolean);
  if (num(vm.start_time) && Date.now() - num(vm.start_time) > 240_000) { out.toolsRunning = true; out.ips = given; }
  return out;
}

// ---- discovery -----------------------------------------------------------------------------------
export async function discover(api) {
  const root = api.root ?? await api('GET', '');
  const [clusters, hosts, domains, profiles, networks, vms, templates] = await Promise.all(
    [['/clusters', 'cluster'], ['/hosts', 'host'], ['/storagedomains', 'storage_domain'], ['/vnicprofiles', 'vnic_profile'], ['/networks', 'network'], ['/vms', 'vm'], ['/templates', 'template']].map(async ([p, k]) => list(await api('GET', p), k)));
  const info = root.product_info ?? {};
  const version = info.version?.full_version ?? [info.version?.major, info.version?.minor, info.version?.build].filter((x) => x !== undefined).join('.');
  const hostList = hosts.map((h) => {
    const t = h.cpu?.topology ?? {}, up = h.status === 'up';
    const cores = (num(t.sockets) || 1) * (num(t.cores) || 1);
    return { moref: h.id, name: h.name, hardwareUuid: h.hardware_information?.uuid || h.id, vendor: h.hardware_information?.manufacturer ?? '', model: h.cpu?.name ?? h.hardware_information?.product_name ?? '', cpuMhz: Math.round(num(h.cpu?.speed)),
      cpuCores: cores, cpuThreads: cores * (num(t.threads) || 1), memoryBytes: num(h.memory), connectionState: up || h.status === 'maintenance' ? 'connected' : h.status === 'non_responsive' ? 'notResponding' : 'disconnected',
      powerState: up || h.status === 'maintenance' ? 'poweredOn' : 'unknown', inMaintenance: h.status === 'maintenance', version: h.version?.full_version ?? '', managementServer: '', parent: h.cluster?.id ?? '' };
  });
  const netOf = Object.fromEntries(networks.map((n) => [n.id, n]));
  return {
    product: { kind: 'ovirt', name: info.name ?? 'oVirt Engine', fullName: `${info.name ?? 'oVirt Engine'} ${version}`.trim(), version: String(version), build: String(info.version?.revision ?? ''), apiType: 'oVirt', apiVersion: String(version),
      instanceUuid: String(info.instance_id ?? root.instance_id ?? '') },
    licenses: [], writeApi: 'available', privileges: {},
    operations: { inventory: true, createVm: true, cloneFromImage: true, power: true, resize: true, deleteVm: true, snapshot: true, console: false, firewall: false, automationApi: true },
    // The engine writes a new server's network under the interface name it is given, and the adapter has only
    // "eth0" to give (initialization below): said with every discovery, so the admin knows what the images must do.
    warnings: ['GUEST_NIC_NAME_ETH0'], hosts: hostList,
    datastores: domains.filter((d) => d.type === 'data').map((d) => ({ moref: d.id, name: d.name, type: d.storage?.type ?? '', capacityBytes: num(d.available) + num(d.used), freeBytes: num(d.available),
      uncommittedBytes: Math.max(0, num(d.committed) - num(d.used)), accessible: d.external_status !== 'error' && d.status !== 'inactive' && d.status !== 'unattached' && d.available !== undefined, maintenanceMode: d.status === 'maintenance' ? 'inMaintenance' : 'normal',
      hosts: hostList.filter((h) => h.connectionState === 'connected').map((h) => h.moref) })),
    networks: profiles.map((p) => { const n = netOf[p.network?.id] ?? {}; return { moref: p.id, name: n.name && n.name !== p.name ? `${n.name} / ${p.name}` : p.name, kind: 'standard', vlan: n.vlan?.id !== undefined ? num(n.vlan.id) : null, switch: n.name ?? '' }; }),
    compute: clusters.map((c) => { const mine = hostList.filter((h) => h.parent === c.id);
      return { moref: c.id, name: c.name, kind: 'cluster', hosts: mine.length, effectiveCpuMhz: mine.reduce((n, h) => n + h.cpuMhz * h.cpuCores, 0), effectiveMemoryMb: Math.floor(mine.reduce((n, h) => n + h.memoryBytes, 0) / MIB), resourcePool: c.id }; }),
    vms: [...vms.map((v) => ({ v, template: false })), ...templates.filter((t) => t.id !== BLANK).map((v) => ({ v, template: true }))].map(({ v, template }) => ({ moref: v.id, name: v.name, uuid: v.id, instanceUuid: v.id,
      powerState: template ? 'poweredOff' : power(v.status), host: v.host?.id ?? '', cpu: cpus(v), memoryMb: Math.floor(num(v.memory) / MIB), template, guest: v.os?.type ?? '', committedBytes: 0, uncommittedBytes: 0 })),
    compat: { apiVersion: String(version), customization: 'cloudinit', clone: true, consoleUrl: false, support: 'supported' },
  };
}

// ---- provisioning --------------------------------------------------------------------------------
const maskOf = (bits) => [24, 16, 8, 0].map((sh) => (bits >= 32 - sh ? 255 : bits <= 24 - sh ? 0 : (0xff << (32 - sh - bits)) & 0xff)).join('.');
// The worker's cloud-init documents as the engine's "initialization": host name, keys, the first interface's
// addresses and name servers as fields of their own; the rest of the cloud-config (password hash, files, first-boot
// commands) goes along as the custom script, which the engine adds to the user data it builds.
export function initialization(metadata, userdata) {
  let meta = {}, user = {};
  try { meta = JSON.parse(metadata || '{}'); } catch { /* not JSON */ }
  try { user = JSON.parse(String(userdata || '').replace(/^#cloud-config\s*/, '') || '{}'); } catch { /* same */ }
  const out = {};
  const { hostname, ssh_authorized_keys: keys, ...rest } = user;
  if (hostname) out.host_name = String(hostname);
  if (Array.isArray(keys) && keys.length) out.authorized_ssh_keys = keys.join('\n');
  const nic = Object.values(meta.network?.ethernets ?? {})[0];
  if (nic) {
    const v4 = (nic.addresses ?? []).find((a) => !a.includes(':')), v6 = (nic.addresses ?? []).find((a) => a.includes(':'));
    const gw4 = (nic.routes ?? []).find((r) => r.to === 'default')?.via, gw6 = (nic.routes ?? []).find((r) => r.to === '::/0')?.via;
    // The name is written into the guest's network configuration as it stands: the engine's config drive names each
    // link by this name only (VmInitToOpenStackMetadataAdapter: id, name, type - no MAC address), and nothing in the
    // REST API binds it to the NIC another way. An image whose kernel calls the interface enp1s0 or ens3 therefore
    // gets no address: images for oVirt need classic names (net.ifnames=0) or one interface cloud-init can rename.
    // Discovery says so (GUEST_NIC_NAME_ETH0) rather than the adapter guessing a name.
    const conf = { name: 'eth0', on_boot: true, boot_protocol: v4 ? 'static' : 'none' };
    if (v4) { const [address, bits] = v4.split('/'); conf.ip = { version: 'v4', address, netmask: maskOf(Number(bits) || 24), ...(gw4 && { gateway: gw4 }) }; }
    if (v6) { const [address, bits] = v6.split('/'); conf.ipv6_boot_protocol = 'static'; conf.ipv6 = { version: 'v6', address, netmask: String(bits || 64), ...(gw6 && { gateway: gw6 }) }; }
    out.nic_configurations = { nic_configuration: [conf] };
    const dns = (nic.nameservers?.addresses ?? []).filter((a) => /^[0-9a-f.:]+$/i.test(a));
    if (dns.length) out.dns_servers = dns.join(' ');
  }
  // The engine dumps its own user data as block-style YAML and appends this text as it is (CloudInitHandler:
  // userDataStr += vmInit.getCustomScript()). A JSON object after a block mapping is not YAML, and cloud-init then
  // drops the whole document. So: one line per key, "key: <JSON value>" (a JSON value is a YAML flow value), on lines
  // of their own. Keys the engine wrote as well (runcmd, chpasswd, ssh_pwauth, disable_root) are repeated here, later
  // in the document, where the YAML reader of cloud-init lets the later one count.
  const lines = Object.entries(rest).map(([k, v]) => `${/^[\w-]+$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`);
  if (lines.length) out.custom_script = `\n${lines.join('\n')}\n`;
  return out;
}

export async function clone(api, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || !b.template || !b.pool || !b.datastore || !b.network) throw new Failure('INVALID_REQUEST', 'name, template, pool, datastore and network are required');
  if (b.customization === 'appliance') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'appliance images (nested ESXi) need VMware');
  const earlier = await byName(api, b.name);
  if (earlier) return { vm: earlier.id, existed: true };
  if (!isId(b.template)) throw new Failure('TEMPLATE_NOT_FOUND', 'the template no longer exists');
  // The source is a template, or another server's VM (a copy of a server).
  const source = await api('GET', `/templates/${b.template}`).then((t) => ({ kind: 'templates', t }), async (e) => { if (e.code !== 'VM_NOT_FOUND') throw e;
    return api('GET', `/vms/${b.template}`).then((t) => ({ kind: 'vms', t }), () => { throw new Failure('TEMPLATE_NOT_FOUND', 'the template no longer exists'); }); });
  if (source.kind === 'vms') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'on oVirt a server is copied from a template; make a template of the server first');
  if (!list(await api('GET', `/templates/${b.template}/nics`), 'nic').length) throw new Failure('TEMPLATE_HAS_NO_NIC', 'the template has no network interface');
  const { all, system } = await disksOf(api, 'templates', b.template);
  if (system && Number(b.diskGb) > 0 && Number(b.diskGb) * GIB < num(system.disk.provisioned_size)) throw new Failure('DISK_SMALLER_THAN_TEMPLATE', 'the disk is smaller than the template');
  if (!isId(b.datastore)) throw new Failure('DATASTORE_NOT_FOUND', 'the storage domain no longer exists');
  if (!isId(b.network)) throw new Failure('NETWORK_NOT_FOUND', 'the network profile no longer exists');
  const mem = (Number(b.memoryMb) || 0) * MIB, init = initialization(b.metadata, b.userdata);
  const todo = { nic: b.network, ...(system && Number(b.diskGb) * GIB > num(system.disk.provisioned_size) && { disk: Number(b.diskGb) }), ...(Object.keys(init).length && { first: 1 }) };
  // A full, independent copy on the chosen storage domain; size, CPU and cloud-init are given at creation.
  const vm = await api('POST', '/vms?clone=true', { name: b.name, description: note(b.serverId ?? ''), comment: withMarks(todo), cluster: { id: b.pool }, template: { id: b.template },
    ...(mem && { memory: mem, memory_policy: { guaranteed: mem, max: mem } }), ...(Number(b.vcpu) && { cpu: { topology: cpuTopology(Number(b.vcpu)) } }),
    ...(Object.keys(init).length && { initialization: init }),
    disk_attachments: { disk_attachment: all.map((d) => ({ disk: { id: d.disk.id, format: 'cow', storage_domains: { storage_domain: [{ id: b.datastore }] } } })) } });
  return { task: `create:${vm.id}`, existed: false };
}

const got = (api, path) => api('GET', path).catch((e) => { if (e.code === 'VM_NOT_FOUND') return null; throw e; });
const failed = (error) => ({ state: 'error', code: 'TASK_FAILED', error });
const settled = (s) => (s.snapshot_status ?? 'ok') === 'ok';
// What the engine is still busy with after it answered: each is read off the thing itself. The engine locks what it
// works on before it answers, so "not locked and not as asked" is a failure, and the worker asks for the step again.
const waits = {
  async remove(api, id) { const vm = await got(api, `/vms/${id}`); return !vm ? { state: 'success' } : vm.status === 'image_locked' ? { state: 'running' } : failed('the engine kept the VM (see its events)'); },
  async disk(api, id) { const d = await got(api, `/disks/${id}`); return !d || d.status === 'illegal' ? failed('the engine could not change the disk (see its events)') : d.status === 'ok' ? { state: 'success' } : { state: 'running' }; },
  async snapshot(api, id, sub) { const sn = await got(api, `/vms/${id}/snapshots/${sub}`); return !sn ? failed('the engine did not keep the snapshot (see its events)') : settled(sn) ? { state: 'success' } : { state: 'running' }; },
  async unsnap(api, id, sub) { const sn = await got(api, `/vms/${id}/snapshots/${sub}`); return !sn ? { state: 'success' } : settled(sn) ? failed('the engine kept the snapshot (see its events)') : { state: 'running' }; },
  async restore(api, id) {
    const vm = await got(api, `/vms/${id}`);
    if (!vm) return failed('the VM is gone');
    return vm.status === 'image_locked' || !list(await api('GET', `/vms/${id}/snapshots`), 'snapshot').every(settled) ? { state: 'running' } : { state: 'success' };
  },
};

// The copy exists: its first interface goes onto the ordered network and its disk grows. One step per look, so a
// change the engine is still busy with is waited for instead of run into.
export async function task(api, b) {
  const [, kind, id, sub] = /^(create|remove|disk|snapshot|unsnap|restore):([0-9a-f-]{36})(?::([0-9a-f-]{36}))?$/i.exec(String(b.task ?? '')) ?? [];
  if (!kind) throw new Failure('INVALID_REQUEST', 'task is required');
  if (kind !== 'create') return waits[kind](api, id, sub);
  let vm;
  try { vm = await api('GET', `/vms/${id}`); } catch (e) { if (e.code === 'VM_NOT_FOUND') return { state: 'error', code: 'TASK_FAILED', error: 'the engine did not keep the new VM (see its events)' }; throw e; }
  if (vm.status === 'image_locked') return { state: 'running' };
  const { system } = await disksOf(api, 'vms', vm.id);
  if (system && system.disk.status && system.disk.status !== 'ok') return system.disk.status === 'illegal' ? { state: 'error', code: 'TASK_FAILED', error: 'the disk copy failed' } : { state: 'running' };
  const todo = marks(vm.comment);
  if (todo.nic) {
    const [nic] = list(await api('GET', `/vms/${vm.id}/nics`), 'nic');
    if (nic && nic.vnic_profile?.id !== todo.nic) await api('PUT', `/vms/${vm.id}/nics/${nic.id}`, { vnic_profile: { id: todo.nic } });
    delete todo.nic;
    await api('PUT', `/vms/${vm.id}`, { comment: withMarks(todo) });
  }
  if (todo.disk) {
    const want = Number(todo.disk) * GIB;
    if (system && want > num(system.disk.provisioned_size)) {
      // Asked once. The disk is locked while it grows (waited for above); unlocked again and no larger, the engine
      // gave up (a full storage domain, usually): that is the answer, not a reason to ask on every look until the deadline.
      if (todo.grow) return { state: 'error', code: 'INSUFFICIENT_RESOURCES', error: `the engine did not grow the disk to ${todo.disk} GiB (see its events)` };
      await api('PUT', `/vms/${vm.id}/diskattachments/${system.att.id}`, { disk: { provisioned_size: want } });
      await api('PUT', `/vms/${vm.id}`, { comment: withMarks({ ...todo, grow: 1 }) });
      return { state: 'running' };
    }
    delete todo.disk; delete todo.grow;
    await api('PUT', `/vms/${vm.id}`, { comment: withMarks(todo) });
  }
  return { state: 'success', vm: vm.id };
}

export async function find(api, b) {
  if (!b.name) throw new Failure('INVALID_REQUEST', 'name is required');
  const vm = await byName(api, b.name);
  return { vm: vm ? await state(api, vm, true) : null };
}
export async function managedVms(api) {
  const all = list(await api('GET', `/vms?search=${encodeURIComponent(`name=${PREFIX}*`)}`), 'vm').filter((v) => String(v.name ?? '').startsWith(PREFIX));
  return { vms: await Promise.all(all.map((v) => state(api, v, false))) };
}

export async function powerAction(api, b) {
  if (!['on', 'off', 'reset', 'shutdown'].includes(b.action)) throw new Failure('INVALID_REQUEST', 'unknown power action');
  const vm = await locate(api, b.vm);
  const up = power(vm.status) === 'poweredOn', down = vm.status === 'down';
  if ((b.action === 'on' && up) || ((b.action === 'off' || b.action === 'shutdown') && down)) return { task: '' };
  if (b.action === 'on' || (b.action === 'reset' && !up)) {
    const todo = marks(vm.comment);
    // The first start hands the stored settings to cloud-init; later starts are ordinary ones.
    await api('POST', `/vms/${vm.id}/start`, todo.first ? { use_cloud_init: true } : {});
    if (todo.first) { delete todo.first; await api('PUT', `/vms/${vm.id}`, { comment: withMarks(todo) }).catch(() => undefined); }
    return { task: '' };
  }
  // The engine has no task to hand back for these: the worker watches the power state.
  await api('POST', `/vms/${vm.id}/${b.action === 'off' ? 'stop' : b.action === 'reset' ? 'reset' : 'shutdown'}`, {})
    .catch(async (e) => { if (b.action === 'reset' && e.code === 'VM_NOT_FOUND') return api('POST', `/vms/${vm.id}/reboot`, {}); throw e; });
  return { task: '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Powered off (not asked nicely) and seen down; false when it is still not down after the tries. Gone counts as down.
async function stopped(api, vm, tries) {
  await api('POST', `/vms/${vm.id}/stop`, {}).catch(() => undefined);
  for (let i = 0; i < tries; i++) { await sleep(1500); const now = await got(api, `/vms/${vm.id}`); if (!now || now.status === 'down') return true; }
  return false;
}
export async function destroy(api, b) {
  let vm;
  try { vm = await locate(api, b.vm); } catch (e) { if (e.code === 'VM_NOT_FOUND') return { task: '', gone: true }; throw e; }
  managed(vm);
  if (vm.status !== 'down' && vm.status !== 'image_locked') await stopped(api, vm, 40);
  // With its disks. The answer may come while the engine is still removing (the VM then shows as image_locked), and
  // a second request meanwhile is refused as busy: either way the removal is under way and "remove:<vm>" tells when
  // the VM is really gone - the worker releases the server's addresses only then.
  try { await api('DELETE', `/vms/${vm.id}`); }
  catch (e) { if (e.code === 'VM_NOT_FOUND') return { task: '', gone: true }; if (e.code !== 'ENGINE_BUSY') throw e; }
  return { task: `remove:${vm.id}` };
}

const snapshotsOf = async (api, id) => list(await api('GET', `/vms/${id}/snapshots`), 'snapshot').filter((s) => s.snapshot_type !== 'active');
export async function resize(api, b) {
  const vcpu = Number(b.vcpu), memoryMb = Number(b.memoryMb), diskGb = Number(b.diskGb);
  if (!(vcpu >= 1) || !(memoryMb >= 256) || !(diskGb >= 1)) throw new Failure('INVALID_REQUEST', 'vcpu, memoryMb and diskGb are required');
  const vm = await locate(api, b.vm); managed(vm);
  const { system } = await disksOf(api, 'vms', vm.id);
  if (!system) throw new Failure('VM_HAS_NO_DISK', 'the VM has no disk');
  const now = Math.ceil(num(system.disk.provisioned_size) / GIB);
  if (diskGb < now) throw new Failure('DISK_SHRINK_NOT_SUPPORTED', 'a disk cannot be made smaller');
  if (diskGb > now && (await snapshotsOf(api, vm.id)).length) throw new Failure('DISK_HAS_SNAPSHOTS', 'remove the snapshots before growing the disk');
  const mem = memoryMb * MIB;
  await api('PUT', `/vms/${vm.id}`, { memory: mem, memory_policy: { guaranteed: mem, max: mem }, cpu: { topology: cpuTopology(vcpu) } });
  if (diskGb > now) await api('PUT', `/vms/${vm.id}/diskattachments/${system.att.id}`, { disk: { provisioned_size: diskGb * GIB } });
  // The engine answers at once and grows the disk afterwards, the VM locked meanwhile: the worker waits for the disk
  // before it starts the server again.
  return { task: diskGb > now ? `disk:${system.disk.id}` : '' };
}

export async function rename(api, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || String(b.name).length > 80) throw new Failure('INVALID_REQUEST', 'name must start with lvm- and be at most 80 characters');
  const vm = await locate(api, b.vm);
  const diskGb = Math.ceil(num((await disksOf(api, 'vms', vm.id)).system?.disk.provisioned_size) / GIB);
  if (vm.name === b.name) return { name: b.name, diskGb };
  if (String(vm.name ?? '').startsWith(PREFIX)) throw new Failure('NOT_IMPORTABLE', 'already managed');
  await api('PUT', `/vms/${vm.id}`, { name: b.name });
  return { name: b.name, diskGb };
}

// ---- disks ---------------------------------------------------------------------------------------
const diskKey = (id) => numberOf(id, 2_000_000_000) + 1;
export async function disks(api, b) {
  const vm = await locate(api, b.vm); managed(vm);
  const { all, system } = await disksOf(api, 'vms', vm.id);
  return { disks: all.map((d) => ({ key: diskKey(d.disk.id), label: d.disk.name ?? d.disk.alias ?? '', sizeGb: Math.floor(num(d.disk.provisioned_size) / GIB), system: d === system })) };
}
export async function diskAdd(api, b) {
  const sizeGb = Number(b.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536) throw new Failure('INVALID_REQUEST', 'sizeGb must be 1 to 65536');
  const vm = await locate(api, b.vm); managed(vm);
  const { all, system } = await disksOf(api, 'vms', vm.id);
  if (!system) throw new Failure('VM_HAS_NO_DISK', 'the VM has no disk');
  const domain = list(system.disk.storage_domains, 'storage_domain')[0]?.id;
  await api('POST', `/vms/${vm.id}/diskattachments`, { bootable: false, active: true, interface: system.att.interface ?? 'virtio_scsi',
    disk: { name: `${vm.name}_disk${all.length + 1}`, format: 'cow', provisioned_size: sizeGb * GIB, ...(domain && { storage_domains: { storage_domain: [{ id: domain }] } }) } });
  return { task: '' };
}
export async function diskRemove(api, b) {
  const vm = await locate(api, b.vm); managed(vm);
  const { all, system } = await disksOf(api, 'vms', vm.id);
  const d = all.find((x) => diskKey(x.disk.id) === Number(b.key));
  if (!d) return { task: '', gone: true };
  if (d === system) throw new Failure('SYSTEM_DISK', 'the system disk cannot be removed');
  if (vm.status !== 'down') await api('PUT', `/vms/${vm.id}/diskattachments/${d.att.id}`, { active: false }).catch(() => undefined);
  await api('DELETE', `/vms/${vm.id}/diskattachments/${d.att.id}?detach_only=false`);
  return { task: '' };
}

// ---- snapshots -----------------------------------------------------------------------------------
const snapId = (s) => `snapshot-${numberOf(s.id)}`;
export async function snapshots(api, b) {
  const vm = await locate(api, b.vm);
  const all = (await snapshotsOf(api, vm.id)).sort((a, c) => num(a.date) - num(c.date));
  return { snapshots: all.map((s) => { const [first, ...rest] = String(s.description ?? '').split('\n');
    return { id: snapId(s), name: first, description: rest.join('\n').trim(), created: new Date(num(s.date)).toISOString(), powerState: s.persist_memorystate === true || s.persist_memorystate === 'true' ? 'poweredOn' : 'poweredOff', current: false, parent: '' }; }) };
}
export async function snapshot(api, b) {
  const vm = await locate(api, b.vm);
  if (b.action === 'create') {
    const name = String(b.name ?? ''), description = String(b.description ?? '');
    if (!name || Buffer.byteLength(name) > 80 || Buffer.byteLength(description) > 500) throw new Failure('INVALID_REQUEST', 'name is 1 to 80 bytes, description at most 500');
    const made = await api('POST', `/vms/${vm.id}/snapshots`, { description: `${name}${description ? `\n${description}` : ''}`, persist_memorystate: false });
    return { task: isId(made?.id) ? `snapshot:${vm.id}:${made.id}` : '' }; // answered while the snapshot is still locked
  }
  if (b.action !== 'revert' && b.action !== 'remove') throw new Failure('INVALID_REQUEST', 'unknown snapshot action');
  const target = (await snapshotsOf(api, vm.id)).find((s) => snapId(s) === b.snapshot);
  if (!target) throw new Failure('SNAPSHOT_NOT_FOUND', 'the snapshot is not in this VM');
  if (b.action === 'remove') { await api('DELETE', `/vms/${vm.id}/snapshots/${target.id}`); return { task: `unsnap:${vm.id}:${target.id}` }; }
  // A restore already under way (a retry after a lost answer) is waited for, not asked for again.
  if (vm.status === 'image_locked' || !settled(target)) return { task: `restore:${vm.id}:${target.id}` };
  // The engine restores a snapshot only into a VM that is down ("Cannot preview Snapshot. At least one of the VMs
  // is not down."). On the other platforms a revert of a snapshot without memory leaves the server off as well, and
  // the worker starts it again when it was running: the same here, by powering it off first.
  if (vm.status !== 'down' && !(await stopped(api, vm, 25))) throw new Failure('ENGINE_BUSY', 'the server is still stopping; the snapshot is restored once it is down');
  await api('POST', `/vms/${vm.id}/snapshots/${target.id}/restore`, {});
  return { task: `restore:${vm.id}:${target.id}` };
}

// ---- reading -------------------------------------------------------------------------------------
const statsOf = async (api, path) => Object.fromEntries(list(await api('GET', `${path}/statistics`).catch(() => ({})), 'statistic').map((s) => [s.name, num(list(s.values, 'value')[0]?.datum)]));
export async function details(api, b) {
  const vm = await locate(api, b.vm);
  const up = vm.status === 'up';
  const [{ all }, nics, devices, snaps, stats, host, cluster] = await Promise.all([disksOf(api, 'vms', vm.id), api('GET', `/vms/${vm.id}/nics`).then((r) => list(r, 'nic')),
    up ? api('GET', `/vms/${vm.id}/reporteddevices`).then((r) => list(r, 'reported_device'), () => []) : [], snapshotsOf(api, vm.id).catch(() => []), up ? statsOf(api, `/vms/${vm.id}`) : {},
    vm.host?.id ? api('GET', `/hosts/${vm.host.id}`).catch(() => null) : null, vm.cluster?.id ? api('GET', `/clusters/${vm.cluster.id}`).catch(() => null) : null]);
  const profiles = Object.fromEntries(await Promise.all(nics.filter((n) => n.vnic_profile?.id).map(async (n) => [n.id, await api('GET', `/vnicprofiles/${n.vnic_profile.id}`).catch(() => ({}))])));
  const domains = await Promise.all(all.map((d) => { const id = list(d.disk.storage_domains, 'storage_domain')[0]?.id; return id ? api('GET', `/storagedomains/${id}`).then((s) => s.name, () => '') : ''; }));
  const init = vm.initialization ?? {};
  return {
    moref: vm.id, name: vm.name, instanceUuid: vm.id, biosUuid: vm.id, guestId: vm.os?.type ?? '', configuredOs: vm.os?.type ?? '', hardwareVersion: vm.custom_compatibility_version ? `${vm.custom_compatibility_version.major}.${vm.custom_compatibility_version.minor}` : '',
    firmware: /uefi|ovmf/i.test(vm.bios?.type ?? '') ? 'efi' : 'bios', secureBoot: /secure/i.test(vm.bios?.type ?? ''), annotation: vm.description ?? '', powerState: power(vm.status), connectionState: 'connected',
    bootTime: up && num(vm.start_time) ? new Date(num(vm.start_time)).toISOString() : null, uptimeSeconds: up && num(vm.start_time) ? Math.max(0, Math.floor((Date.now() - num(vm.start_time)) / 1000)) : 0,
    overallStatus: 'green', consolidationNeeded: false, snapshots: snaps.length, committedGb: round2(all.reduce((n, d) => n + num(d.disk.actual_size), 0) / GIB),
    uncommittedGb: round2(all.reduce((n, d) => n + Math.max(0, num(d.disk.provisioned_size) - num(d.disk.actual_size)), 0) / GIB),
    cpu: { count: cpus(vm), coresPerSocket: num(vm.cpu?.topology?.cores) || 1, hotAdd: true, reservationMhz: 0, limitMhz: -1, shares: num(vm.cpu_shares), usageMhz: 0 },
    memory: { sizeMb: Math.floor(num(vm.memory) / MIB), hotAdd: num(vm.memory_policy?.max) > num(vm.memory), reservationMb: Math.floor(num(vm.memory_policy?.guaranteed) / MIB), limitMb: -1, shares: 0,
      guestUsageMb: Math.floor(num(stats['memory.used']) / MIB), hostUsageMb: Math.floor(num(stats['memory.installed']) / MIB), balloonedMb: 0, swappedMb: 0 },
    nics: nics.map((n, i) => { const dev = devices.find((d) => String(d.mac?.address).toLowerCase() === String(n.mac?.address).toLowerCase());
      return { label: n.name ?? `Network adapter ${i + 1}`, adapter: n.interface ?? '', mac: n.mac?.address ?? '', macType: 'assigned', connected: up && !no(n.linked) && !no(n.plugged), startConnected: !no(n.plugged),
        network: profiles[n.id]?.name ?? '', kind: 'standard', portKey: '', portgroupKey: '', switch: '', vlan: null, ips: dev ? list(dev.ips, 'ip').map((x) => String(x.address)) : [], guestConnected: dev ? true : null }; }),
    disks: all.map((d, i) => ({ label: `Hard disk ${i + 1}`, capacityGb: round2(num(d.disk.provisioned_size) / GIB), datastore: domains[i], file: d.disk.id, provisioning: d.disk.sparse === false || d.disk.sparse === 'false' ? 'thick-lazy' : 'thin',
      mode: 'persistent', controller: d.att.interface ?? '', bus: d.att.interface ?? '' })),
    cdroms: [], tools: { status: devices.length || vm.guest_operating_system ? 'toolsOk' : up ? 'toolsNotRunning' : 'toolsNotInstalled', runningStatus: devices.length ? 'guestToolsRunning' : 'guestToolsNotRunning', version: '', versionStatus: '' },
    guest: { hostName: vm.fqdn ?? '', os: [vm.guest_operating_system?.distribution, vm.guest_operating_system?.version?.full_version].filter(Boolean).join(' '), family: /windows/i.test(vm.os?.type ?? '') ? 'windowsGuest' : 'linuxGuest',
      ips: guestIps(devices), gateways: list(init.nic_configurations, 'nic_configuration').map((n) => n.ip?.gateway).filter(Boolean), dns: String(init.dns_servers ?? '').split(/\s+/).filter(Boolean), domain: init.domain ?? '',
      state: up ? 'running' : 'notRunning', heartbeat: devices.length ? 'green' : 'gray' },
    placement: { host: host?.name ?? '', cluster: cluster?.name ?? '', resourcePool: '', folder: '', datastores: [...new Set(domains.filter(Boolean))].sort(), vmxPath: vm.id },
  };
}

// The engine gives current values, not a history: the answer has the shape the panel wants, with what is known now.
export async function metrics(api, b) {
  const vm = await locate(api, b.vm);
  const s = vm.status === 'up' ? await statsOf(api, `/vms/${vm.id}`) : {};
  return { interval: 60, samples: [], quick: { cpuMhz: 0, memoryActiveMb: Math.floor(num(s['memory.used']) / MIB), uptimeSeconds: vm.status === 'up' && num(vm.start_time) ? Math.max(0, Math.floor((Date.now() - num(vm.start_time)) / 1000)) : 0 } };
}

export async function topology(api) {
  const d = await discover(api);
  const mine = d.vms.filter((v) => v.name.startsWith(PREFIX));
  const used = Object.fromEntries(await Promise.all(d.hosts.filter((h) => h.connectionState === 'connected').map(async (h) => [h.moref, await statsOf(api, `/hosts/${h.moref}`)])));
  return { time: new Date().toISOString(), compute: d.compute.map((c) => ({ moref: c.moref, name: c.name, kind: 'cluster' })),
    hosts: d.hosts.map((h) => { const s = used[h.moref] ?? {}; const busy = Math.min(100, num(s['cpu.current.user']) + num(s['cpu.current.system']));
      return { moref: h.moref, name: h.name, compute: h.parent, state: h.connectionState, power: h.powerState, cpuUsedMhz: Math.round((busy / 100) * h.cpuMhz * h.cpuCores), cpuTotalMhz: h.cpuMhz * h.cpuCores,
        memUsedMb: Math.floor(num(s['memory.used']) / MIB), memTotalMb: Math.floor(h.memoryBytes / MIB) }; }),
    datastores: d.datastores.map((s) => ({ moref: s.moref, name: s.name, capacityGb: s.capacityBytes / GIB, freeGb: s.freeBytes / GIB, hosts: s.hosts })),
    vms: mine.map((v) => ({ moref: v.moref, name: v.name, host: v.host, power: v.powerState, cpuUsedMhz: 0, memUsedMb: v.powerState === 'poweredOn' ? v.memoryMb : 0, rxKBps: null, txKBps: null })),
    otherVms: d.vms.filter((v) => !v.name.startsWith(PREFIX) && !v.template).length };
}
export async function powerReport(api) {
  const d = await discover(api);
  return { time: new Date().toISOString(),
    hosts: d.hosts.map((h) => ({ moref: h.moref, name: h.name, watts: null, cpuUsedMhz: 0, cpuTotalMhz: h.cpuMhz * h.cpuCores, coreMhz: h.cpuMhz, connected: h.connectionState === 'connected' })),
    vms: d.vms.filter((v) => v.powerState === 'poweredOn' && v.name.startsWith(PREFIX) && v.name.length > PREFIX.length).map((v) => ({ name: v.name, host: v.host, cpuUsedMhz: 0, traffic: [] })) };
}
