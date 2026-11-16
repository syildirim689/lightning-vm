// The adapter contract (docs/adapter-contract.md) on Incus (and LXD): one server or cluster per connection, in one
// project (the connection's user name; "default"). Ids the panel stores:
//   VM              the instance's volatile.uuid (its name can change; the name when an old server has none)
//   template        "image-<fingerprint>": an image of the server's image store
//   host            a cluster member's name (the server's own name when it is not clustered)
//   compute         "incus"                    resource pool    the project's name
//   datastore       the storage pool's name    network          the network's name
//   task            "<operation id>|<instance name>"
//   snapshot        "snapshot-<n>": the seconds in the snapshot's own name (lvm<seconds>)
// Instances are virtual machines or system containers, whichever the image is. A new server gets its settings
// through Incus' own cloud-init support (cloud-init.user-data, cloud-init.network-config).
import { createHash } from 'node:crypto';
import { Failure, operationFailure } from './incus.mjs';

const PREFIX = 'lvm-';
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const round2 = (n) => Math.round(n * 100) / 100;
const note = (serverId) => `Managed by Lightning VM (server ${serverId})`;
const enc = encodeURIComponent;
const UNITS = { '': 1, B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: MIB, GiB: GIB, TiB: 1024 * GIB };
// "4GiB", "4096MiB", "2GB" or plain bytes.
export function bytes(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*$/.exec(String(text ?? ''));
  return m && UNITS[m[2]] !== undefined ? Math.round(Number(m[1]) * UNITS[m[2]]) : 0;
}
// limits.cpu is a count ("4") or a set of host CPUs ("0-3", "0,2,4").
export function cpus(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(',').reduce((n, part) => { const [a, b] = part.split('-').map(Number); return n + (Number.isInteger(b) ? b - a + 1 : 1); }, 0);
}
const idOf = (i) => i.config?.['volatile.uuid'] || i.name;
const isVm = (i) => i.type === 'virtual-machine';
const power = (i) => (i.status === 'Running' ? 'poweredOn' : i.status === 'Frozen' ? 'suspended' : 'poweredOff');
const conf = (i) => ({ ...(i.expanded_config ?? {}), ...(i.config ?? {}) });
const devs = (i) => ({ ...(i.expanded_devices ?? {}), ...(i.devices ?? {}) });
const rootOf = (i) => Object.entries(devs(i)).find(([, d]) => d.type === 'disk' && d.path === '/') ?? [null, null];
const missing = (e) => e instanceof Failure && e.code === 'NOT_FOUND';
// Waits for a background operation; an answer that is no operation (a synchronous call) is simply done.
async function settled(api, op, seconds = 50) {
  if (!op?.id || op.status_code === undefined) return op;
  const done = await api('GET', `/1.0/operations/${enc(op.id)}/wait?timeout=${seconds}`);
  if (done?.status_code >= 400) throw operationFailure(done.err);
  if (done?.status_code !== 200) throw new Failure('TIMEOUT', 'the server is still working on it');
  return done;
}
const all = (api) => api('GET', '/1.0/instances?recursion=1');
async function byId(api, vm) {
  if (!vm) throw new Failure('INVALID_REQUEST', 'vm is required');
  const i = (await all(api)).find((x) => idOf(x) === vm);
  if (!i) throw new Failure('VM_NOT_FOUND', 'the VM no longer exists');
  return i;
}
const managed = (i) => { if (!i.name.startsWith(PREFIX)) throw new Failure('NOT_MANAGED', 'this instance was not created by the panel'); return i; };
const one = (api, name) => api('GET', `/1.0/instances/${enc(name)}?recursion=1`).catch((e) => { if (missing(e)) return null; throw e; });

// Addresses the guest reports (a VM needs the Incus agent for that; a container always can).
function addresses(st) {
  const out = [];
  for (const [name, n] of Object.entries(st?.network ?? {})) if (name !== 'lo') for (const a of n.addresses ?? []) if (a.scope === 'global' && (a.family === 'inet' || a.family === 'inet6')) out.push(a.address);
  return out;
}
function stateOf(i, now = Date.now()) {
  const c = conf(i), on = power(i) === 'poweredOn';
  let ips = on ? addresses(i.state) : [], tools = ips.length > 0;
  // No agent in the guest: a server that has been running for four minutes counts as ready with the addresses it was given.
  const since = Date.parse(i.state?.started_at ?? '') || Date.parse(i.last_used_at ?? '') || 0;
  if (on && !tools && since > 0 && now - since > 240_000) { tools = true; ips = String(c['user.lvm-ips'] ?? '').split(',').filter(Boolean); }
  return { moref: idOf(i), name: i.name, powerState: power(i), toolsRunning: tools, ips, ...(c['user.lvm-server'] && { serverId: c['user.lvm-server'] }) };
}

// ---- discovery -----------------------------------------------------------------------------------
const hardware = (r) => { const sockets = r?.cpu?.sockets ?? []; return { threads: Number(r?.cpu?.total) || 0, cores: sockets.reduce((n, s) => n + (Number(s.cores) || 0), 0), mhz: Number(sockets[0]?.frequency_turbo || sockets[0]?.frequency) || 0,
  model: sockets[0]?.name ?? '', vendor: sockets[0]?.vendor ?? '', memory: Number(r?.memory?.total) || 0, used: Number(r?.memory?.used) || 0 }; };
// The server itself, or every member of the cluster, with its hardware.
async function members(api) {
  const env = api.server?.environment ?? {};
  if (!env.server_clustered) return [{ name: env.server_name || 'incus', online: true, ...hardware(await api('GET', '/1.0/resources')) }];
  const list = await api('GET', '/1.0/cluster/members?recursion=1');
  return Promise.all(list.map(async (m) => { const online = m.status === 'Online'; return { name: m.server_name, online, ...hardware(online ? await api('GET', `/1.0/resources?target=${enc(m.server_name)}`).catch(() => null) : null) }; }));
}
async function pools(api) {
  const list = await api('GET', '/1.0/storage-pools?recursion=1');
  return Promise.all(list.map(async (p) => { const r = await api('GET', `/1.0/storage-pools/${enc(p.name)}/resources`).catch(() => null); return { name: p.name, driver: p.driver, ok: p.status === 'Created' || !p.status, total: Number(r?.space?.total) || 0, used: Number(r?.space?.used) || 0 }; }));
}
const imageName = (im) => im.aliases?.[0]?.name || im.properties?.description || im.fingerprint.slice(0, 12);

export async function discover(api) {
  const env = api.server?.environment ?? {}, lxd = env.server === 'lxd';
  const [hosts, stores, nets, instances, images] = [await members(api), await pools(api), await api('GET', '/1.0/networks?recursion=1'), await all(api), await api('GET', '/1.0/images?recursion=1')];
  const uuid = String(env.certificate_fingerprint || env.server_name || 'incus');
  return {
    product: { kind: 'incus', name: lxd ? 'LXD' : 'Incus', fullName: `${lxd ? 'LXD' : 'Incus'} ${env.server_version ?? ''}${env.server_clustered ? ' (cluster)' : ''}`.trim(), version: String(env.server_version ?? ''), build: '', apiType: lxd ? 'LXD REST' : 'Incus REST',
      apiVersion: String(api.server?.api_version ?? '1.0'), instanceUuid: uuid },
    licenses: [], writeApi: 'available', privileges: {},
    operations: { inventory: true, createVm: true, cloneFromImage: true, power: true, resize: true, deleteVm: true, snapshot: true, console: false, firewall: false, automationApi: true },
    warnings: images.length ? [] : ['NO_IMAGES'],
    hosts: hosts.map((h) => ({ moref: h.name, name: h.name, hardwareUuid: `${uuid.slice(0, 16)}:${h.name}`, vendor: h.vendor, model: h.model, cpuMhz: h.mhz, cpuCores: h.cores || h.threads, cpuThreads: h.threads, memoryBytes: h.memory,
      connectionState: h.online ? 'connected' : 'disconnected', powerState: h.online ? 'poweredOn' : 'unknown', inMaintenance: false, version: String(env.server_version ?? ''), managementServer: '', parent: 'incus' })),
    datastores: stores.map((p) => ({ moref: p.name, name: p.name, type: p.driver, capacityBytes: p.total, freeBytes: Math.max(0, p.total - p.used), uncommittedBytes: 0, accessible: p.ok, maintenanceMode: 'normal', hosts: hosts.map((h) => h.name) })),
    networks: nets.filter((n) => n.managed || n.type === 'bridge').map((n) => ({ moref: n.name, name: n.name, kind: 'standard', vlan: null, switch: n.type ?? '' })),
    compute: [{ moref: 'incus', name: env.server_clustered ? 'cluster' : env.server_name || 'incus', kind: env.server_clustered ? 'cluster' : 'standalone', hosts: hosts.length, effectiveCpuMhz: hosts.reduce((n, h) => n + h.mhz * (h.cores || h.threads), 0),
      effectiveMemoryMb: Math.floor(hosts.reduce((n, h) => n + h.memory, 0) / MIB), resourcePool: api.project }],
    vms: [...instances.map((i) => { const c = conf(i); return { moref: idOf(i), name: i.name, uuid: idOf(i), instanceUuid: idOf(i), powerState: power(i), host: i.location && i.location !== 'none' ? i.location : hosts[0]?.name ?? '', cpu: cpus(c['limits.cpu']),
      memoryMb: Math.floor(bytes(c['limits.memory']) / MIB), template: false, guest: `${c['image.os'] ?? ''} ${c['image.release'] ?? ''} (${isVm(i) ? 'VM' : 'container'})`.trim(), committedBytes: 0, uncommittedBytes: 0 }; }),
    ...images.map((im) => ({ moref: `image-${im.fingerprint}`, name: imageName(im), uuid: im.fingerprint, instanceUuid: im.fingerprint, powerState: 'poweredOff', host: hosts[0]?.name ?? '', cpu: 0, memoryMb: 0, template: true,
      guest: `${im.properties?.os ?? ''} ${im.properties?.release ?? ''} (${im.type === 'virtual-machine' ? 'VM' : 'container'})`.trim(), committedBytes: Number(im.size) || 0, uncommittedBytes: 0 }))],
    compat: { apiVersion: String(api.server?.api_version ?? '1.0'), customization: 'cloudinit', clone: true, consoleUrl: false, support: 'supported' },
  };
}

// ---- provisioning --------------------------------------------------------------------------------
export async function clone(api, b) {
  if (!String(b.name ?? '').startsWith(PREFIX) || !b.template || !b.pool || !b.datastore || !b.network) throw new Failure('INVALID_REQUEST', 'name, template, pool, datastore and network are required');
  if (!/^lvm-[A-Za-z0-9-]{1,59}$/.test(b.name) || b.name.endsWith('-')) throw new Failure('INVALID_REQUEST', 'the name may hold letters, digits and - only (63 characters at most)');
  if (b.customization === 'appliance') throw new Failure('PROVISIONING_NOT_SUPPORTED', 'appliance images (nested ESXi) need VMware');
  const earlier = await one(api, b.name);
  if (earlier) return { vm: idOf(earlier), existed: true };
  const fingerprint = /^image-([0-9a-f]{12,64})$/.exec(String(b.template))?.[1];
  const image = fingerprint && await api('GET', `/1.0/images/${fingerprint}`).catch((e) => { if (missing(e)) return null; throw e; });
  if (!image) throw new Failure('TEMPLATE_NOT_FOUND', 'the image no longer exists');
  await api('GET', `/1.0/storage-pools/${enc(b.datastore)}`).catch((e) => { throw missing(e) ? new Failure('DATASTORE_NOT_FOUND', 'the storage pool no longer exists') : e; });
  await api('GET', `/1.0/networks/${enc(b.network)}`).catch((e) => { throw missing(e) ? new Failure('NETWORK_NOT_FOUND', 'the network no longer exists') : e; });
  let meta = {}; try { meta = JSON.parse(b.metadata || '{}'); } catch { /* not JSON */ }
  const ips = (Object.values(meta.network?.ethernets ?? {})[0]?.addresses ?? []).map((a) => String(a).split('/')[0]);
  const vm = image.type === 'virtual-machine';
  // Older LXD knows the cloud-init keys only under user.*.
  const key = (api.server?.api_extensions ?? ['cloud_init']).includes('cloud_init') ? 'cloud-init' : 'user';
  const diskGb = Math.floor(Number(b.diskGb)) || 0;
  const op = await api('POST', '/1.0/instances', { name: b.name, type: vm ? 'virtual-machine' : 'container', description: note(b.serverId ?? ''), start: false, source: { type: 'image', fingerprint: image.fingerprint },
    config: { 'limits.cpu': String(Math.floor(Number(b.vcpu)) || 1), 'limits.memory': `${Math.floor(Number(b.memoryMb)) || 1024}MiB`, [`${key}.user-data`]: String(b.userdata || '#cloud-config\n{}\n'),
      ...(meta.network && { [`${key}.network-config`]: JSON.stringify(meta.network) }), 'user.lvm-server': String(b.serverId ?? ''), 'user.lvm-ips': ips.join(','), ...(!vm && b.nestedHv && { 'security.nesting': 'true' }) },
    devices: { root: { type: 'disk', path: '/', pool: b.datastore, ...(diskGb > 0 && { size: `${diskGb}GiB` }) }, eth0: { type: 'nic', network: b.network, name: 'eth0' },
      // A VM image without the Incus agent reads its cloud-init data from this drive.
      ...(vm && { 'cloud-init': { type: 'disk', source: 'cloud-init:config' } }) } })
    .catch((e) => { throw /already exists/i.test(e?.message ?? '') ? new Failure('DUPLICATE_NAME', e.message) : e; });
  return { task: `${op.id}|${b.name}`, existed: false };
}
export async function task(api, b) {
  const [id, name] = String(b.task ?? '').split('|');
  if (!/^[0-9a-f-]{36}$/.test(id) || !name) throw new Failure('INVALID_REQUEST', 'task is required');
  const op = await api('GET', `/1.0/operations/${id}`).catch((e) => { if (missing(e)) return null; throw e; });
  // Incus forgets a finished operation after a few seconds: then the instance itself says how it went.
  if (!op || op.status_code === 200) { const i = await one(api, name); return i ? { state: 'success', vm: idOf(i) } : op ? { state: 'error', code: 'TASK_FAILED', error: 'the instance is not there after its creation' } : { state: 'unknown', code: 'TASK_NOT_FOUND' }; }
  if (op.status_code >= 400) { const f = operationFailure(op.err); return { state: 'error', code: f.code, error: f.message.slice(0, 500) }; }
  return { state: 'running' };
}

export async function find(api, b) {
  if (!b.name) throw new Failure('INVALID_REQUEST', 'name is required');
  const i = await one(api, b.name);
  return { vm: i ? stateOf(i) : null };
}
export async function managedVms(api) { return { vms: (await api('GET', '/1.0/instances?recursion=2')).filter((i) => i.name.startsWith(PREFIX)).map((i) => stateOf(i)) }; }

const setState = (api, i, action, force, timeout = 30) => api('PUT', `/1.0/instances/${enc(i.name)}/state`, { action, force, timeout });
export async function powerAction(api, b) {
  if (!['on', 'off', 'reset', 'shutdown'].includes(b.action)) throw new Failure('INVALID_REQUEST', 'unknown power action');
  const i = await byId(api, b.vm), on = power(i) !== 'poweredOff';
  try {
    if (b.action === 'on') { if (i.status === 'Frozen') await settled(api, await setState(api, i, 'unfreeze', false)); else if (!on) await settled(api, await setState(api, i, 'start', false)); }
    else if (b.action === 'off') { if (on) await settled(api, await setState(api, i, 'stop', true)); }
    else if (b.action === 'reset') await settled(api, await setState(api, i, on ? 'restart' : 'start', on));
    // A clean shutdown is the guest's to finish: asked for, not waited for.
    else if (on) await setState(api, i, 'stop', false, 120);
  } catch (e) { if (e instanceof Failure && e.code === 'TASK_FAILED') throw new Failure('INCUS_ERROR', e.message); throw e; }
  return { task: '' };
}
// The volumes of the extra disks the panel added to an instance: [device name, pool, volume].
const extraDisks = (i) => Object.entries(i.devices ?? {}).filter(([k, d]) => /^lvm-disk\d+$/.test(k) && d.type === 'disk' && d.pool && d.source).map(([k, d]) => [k, d.pool, d.source]);
const dropVolume = (api, pool, volume) => api('DELETE', `/1.0/storage-pools/${enc(pool)}/volumes/custom/${enc(volume)}`).then((op) => settled(api, op)).catch((e) => { if (!missing(e)) throw e; });
export async function destroy(api, b) {
  const i = (await all(api)).find((x) => idOf(x) === b.vm);
  if (!i) return { task: '', gone: true };
  managed(i);
  if (power(i) !== 'poweredOff') await settled(api, await setState(api, i, 'stop', true));
  await settled(api, await api('DELETE', `/1.0/instances/${enc(i.name)}`), 100);
  for (const [, pool, volume] of extraDisks(i)) if (volume.startsWith(`${i.name}-`)) await dropVolume(api, pool, volume);
  return { task: '' };
}

const rootGb = (i) => { const [, root] = rootOf(i); return Math.ceil(bytes(root?.size) / GIB); };
export async function resize(api, b) {
  const vcpu = Number(b.vcpu), memoryMb = Number(b.memoryMb), diskGb = Number(b.diskGb);
  if (!Number.isInteger(vcpu) || vcpu < 1 || !Number.isInteger(memoryMb) || memoryMb < 256 || !Number.isInteger(diskGb) || diskGb < 1) throw new Failure('INVALID_REQUEST', 'vcpu, memoryMb and diskGb are required');
  const i = managed(await byId(api, b.vm)), [rootName, root] = rootOf(i), now = rootGb(i);
  if (!root) throw new Failure('VM_HAS_NO_DISK', 'the instance has no root disk');
  if (now && diskGb < now) throw new Failure('DISK_SHRINK_NOT_SUPPORTED', 'a disk cannot be made smaller');
  if (power(i) !== 'poweredOff') throw new Failure('INVALID_STATE', 'the server must be shut down to change its size');
  await settled(api, await api('PATCH', `/1.0/instances/${enc(i.name)}`, { config: { 'limits.cpu': String(vcpu), 'limits.memory': `${memoryMb}MiB` }, devices: { [rootName]: { ...root, size: `${diskGb}GiB` } } }));
  return { task: '' };
}
export async function rename(api, b) {
  if (!/^lvm-[A-Za-z0-9-]{1,59}$/.test(String(b.name ?? ''))) throw new Failure('INVALID_REQUEST', 'name must start with lvm- and hold letters, digits and - only');
  const i = await byId(api, b.vm);
  if (i.name !== b.name) {
    if (i.name.startsWith(PREFIX)) throw new Failure('NOT_IMPORTABLE', 'already managed');
    if (power(i) !== 'poweredOff') throw new Failure('INVALID_STATE', 'shut the instance down first: Incus renames only a stopped instance');
    await settled(api, await api('POST', `/1.0/instances/${enc(i.name)}`, { name: b.name }));
  }
  return { name: b.name, diskGb: rootGb(i) };
}

// ---- disks ---------------------------------------------------------------------------------------
// The root disk is key 0; an added disk is the device "lvm-disk<key>" on a custom volume "<instance>-disk<key>".
export async function disks(api, b) {
  const i = managed(await byId(api, b.vm)), c = conf(i);
  return { disks: [{ key: 0, label: 'root', sizeGb: rootGb(i), system: true }, ...extraDisks(i).map(([k]) => Number(k.slice(8))).sort((x, y) => x - y).map((n) => ({ key: n, label: `disk${n}`, sizeGb: Number(c[`user.lvm-disk.${n}`]) || 0, system: false }))] };
}
export async function diskAdd(api, b) {
  const sizeGb = Number(b.sizeGb);
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 65536) throw new Failure('INVALID_REQUEST', 'sizeGb must be 1 to 65536');
  const i = managed(await byId(api, b.vm)), [, root] = rootOf(i);
  if (!root?.pool) throw new Failure('VM_HAS_NO_DISK', 'the instance has no root disk');
  const used = new Set(extraDisks(i).map(([k]) => Number(k.slice(8))));
  const n = Array.from({ length: 15 }, (_, x) => x + 1).find((x) => !used.has(x));
  if (!n) throw new Failure('NO_DISK_CONTROLLER', 'no free disk slot');
  const volume = `${i.name}-disk${n}`;
  await settled(api, await api('POST', `/1.0/storage-pools/${enc(root.pool)}/volumes/custom`, { name: volume, type: 'custom', content_type: isVm(i) ? 'block' : 'filesystem', config: { size: `${sizeGb}GiB` } })
    .catch((e) => { throw e instanceof Failure && e.code === 'INCUS_ERROR' && /space|quota|exceed/i.test(e.message) ? new Failure('INSUFFICIENT_RESOURCES', e.message) : e; }));
  try {
    await settled(api, await api('PATCH', `/1.0/instances/${enc(i.name)}`, { config: { [`user.lvm-disk.${n}`]: String(sizeGb) }, devices: { [`lvm-disk${n}`]: { type: 'disk', pool: root.pool, source: volume, ...(!isVm(i) && { path: `/mnt/disk${n}` }) } } }));
  } catch (e) { await dropVolume(api, root.pool, volume).catch(() => {}); throw e; }
  return { task: '' };
}
// Everything of an instance a PUT must send back for the rest to stay as it is.
const writable = (i) => ({ architecture: i.architecture, config: { ...i.config }, devices: { ...i.devices }, ephemeral: !!i.ephemeral, profiles: i.profiles ?? [], description: i.description ?? '', stateful: !!i.stateful });
export async function diskRemove(api, b) {
  const key = Number(b.key), i = managed(await byId(api, b.vm));
  if (key === 0) throw new Failure('SYSTEM_DISK', 'the system disk cannot be removed');
  const found = extraDisks(i).find(([k]) => k === `lvm-disk${key}`);
  if (!found) return { task: '', gone: true };
  const next = writable(i); delete next.devices[found[0]]; delete next.config[`user.lvm-disk.${key}`];
  try { await settled(api, await api('PUT', `/1.0/instances/${enc(i.name)}`, next)); }
  catch (e) { throw e instanceof Failure && ['TASK_FAILED', 'INCUS_ERROR'].includes(e.code) ? new Failure('INVALID_STATE', `the disk is in use in the server: ${e.message}`) : e; }
  if (found[2].startsWith(`${i.name}-`)) await dropVolume(api, found[1], found[2]);
  return { task: '' };
}

// ---- snapshots -----------------------------------------------------------------------------------
// A snapshot's own name is lvm<seconds>; the name and description the customer typed are kept in the instance's
// configuration (user.lvm-snap.<name>, base64 of JSON), because an Incus snapshot has no description to write to.
const numberOf = (name) => (/^lvm\d{1,12}$/.test(name) ? Number(name.slice(3)) : Number.parseInt(createHash('sha1').update(name).digest('hex').slice(0, 11), 16) % 1e12);
const snapId = (name) => `snapshot-${numberOf(name)}`;
const short = (s) => String(s.name).split('/').pop();
function labelOf(i, snap) {
  try { const o = JSON.parse(Buffer.from(String(conf(i)[`user.lvm-snap.${snap}`] ?? ''), 'base64url').toString('utf8')); return { name: String(o.name ?? snap), description: String(o.description ?? '') }; } catch { return { name: snap, description: '' }; }
}
const snapList = (api, i) => api('GET', `/1.0/instances/${enc(i.name)}/snapshots?recursion=1`);
export async function snapshots(api, b) {
  const i = await byId(api, b.vm);
  return { snapshots: (await snapList(api, i)).map((s) => ({ id: snapId(short(s)), ...labelOf(i, short(s)), created: new Date(Date.parse(s.created_at) || 0).toISOString(), powerState: s.stateful ? 'poweredOn' : 'poweredOff', current: false, parent: '' })) };
}
export async function snapshot(api, b, now = Date.now()) {
  const i = await byId(api, b.vm);
  if (b.action === 'create') {
    const name = String(b.name ?? ''), description = String(b.description ?? '');
    if (!name || Buffer.byteLength(name) > 80 || Buffer.byteLength(description) > 500) throw new Failure('INVALID_REQUEST', 'name is 1 to 80 bytes, description at most 500');
    const snap = `lvm${Math.floor(now / 1000)}`;
    await settled(api, await api('POST', `/1.0/instances/${enc(i.name)}/snapshots`, { name: snap, stateful: false }));
    await settled(api, await api('PATCH', `/1.0/instances/${enc(i.name)}`, { config: { [`user.lvm-snap.${snap}`]: Buffer.from(JSON.stringify({ name, description }), 'utf8').toString('base64url') } }));
    return { task: '' };
  }
  if (b.action !== 'revert' && b.action !== 'remove') throw new Failure('INVALID_REQUEST', 'unknown snapshot action');
  const target = (await snapList(api, i)).map(short).find((s) => snapId(s) === b.snapshot);
  if (!target) throw new Failure('SNAPSHOT_NOT_FOUND', 'the snapshot is not in this instance');
  if (b.action === 'revert') await settled(api, await api('PUT', `/1.0/instances/${enc(i.name)}`, { restore: target }));
  else await settled(api, await api('DELETE', `/1.0/instances/${enc(i.name)}/snapshots/${enc(target)}`));
  return { task: '' };
}

// ---- reading -------------------------------------------------------------------------------------
async function read(api, vm) {
  const i = await one(api, (await byId(api, vm)).name);
  if (!i) throw new Failure('VM_NOT_FOUND', 'the VM no longer exists');
  const s = stateOf(i), running = s.powerState === 'poweredOn', started = Date.parse(i.state?.started_at ?? '') || Date.parse(i.last_used_at ?? '') || 0;
  return { i, s, c: conf(i), running, started, uptime: running && started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0 };
}
export async function details(api, b) {
  const { i, s, c, running, started, uptime } = await read(api, b.vm);
  const d = devs(i), [rootName] = rootOf(i), vm = isVm(i);
  const diskDevs = Object.entries(d).filter(([, x]) => x.type === 'disk' && x.source !== 'cloud-init:config' && (x.path === '/' || x.pool)).sort(([a], [z]) => (a === rootName ? -1 : z === rootName ? 1 : a.localeCompare(z)));
  const os = `${c['image.os'] ?? ''} ${c['image.release'] ?? ''}`.trim();
  return {
    moref: s.moref, name: s.name, instanceUuid: s.moref, biosUuid: s.moref, guestId: '', configuredOs: os, hardwareVersion: vm ? 'virtual-machine' : 'container', firmware: vm ? 'efi' : 'bios', secureBoot: vm && c['security.secureboot'] !== 'false',
    annotation: String(i.description ?? ''), powerState: s.powerState, connectionState: 'connected', bootTime: running && started ? new Date(started).toISOString() : null, uptimeSeconds: uptime, overallStatus: 'green', consolidationNeeded: false,
    snapshots: (await snapList(api, i).catch(() => [])).length, committedGb: round2((Number(i.state?.disk?.[rootName]?.usage) || 0) / GIB), uncommittedGb: 0,
    cpu: { count: cpus(c['limits.cpu']), coresPerSocket: 1, hotAdd: !vm, reservationMhz: 0, limitMhz: -1, shares: 0, usageMhz: 0 },
    memory: { sizeMb: Math.floor(bytes(c['limits.memory']) / MIB), hotAdd: !vm, reservationMb: 0, limitMb: -1, shares: 0, guestUsageMb: Math.floor((Number(i.state?.memory?.usage) || 0) / MIB), hostUsageMb: Math.floor((Number(i.state?.memory?.usage) || 0) / MIB), balloonedMb: 0, swappedMb: 0 },
    nics: Object.entries(d).filter(([, x]) => x.type === 'nic').map(([k, x], n) => { const live = i.state?.network?.[x.name ?? k] ?? Object.values(i.state?.network ?? {}).find((y) => y.hwaddr && y.hwaddr === c[`volatile.${k}.hwaddr`]);
      const ips = (live?.addresses ?? []).filter((a) => a.scope === 'global').map((a) => a.address), mine = ips.length ? ips : n === 0 ? s.ips : [];
      return { label: `Network adapter ${n + 1}`, adapter: x.nictype ?? (vm ? 'virtio' : 'veth'), mac: String(c[`volatile.${k}.hwaddr`] ?? live?.hwaddr ?? '').toLowerCase(), macType: x.hwaddr ? 'manual' : 'generated', connected: running, startConnected: true,
        network: x.network ?? x.parent ?? '', kind: 'standard', portKey: '', portgroupKey: '', switch: x.parent ?? '', vlan: Number(x.vlan) > 0 ? Number(x.vlan) : null, ips: mine, guestConnected: mine.length ? true : null }; }),
    disks: diskDevs.map(([k, x], n) => ({ label: `Hard disk ${n + 1}`, capacityGb: k === rootName ? round2(bytes(x.size) / GIB) : Number(c[`user.lvm-disk.${k.slice(8)}`]) || 0, datastore: x.pool ?? '', file: k === rootName ? `${x.pool ?? ''}/${i.name}` : `${x.pool}/${x.source}`,
      provisioning: 'thin', mode: 'persistent', controller: k, bus: vm ? 'virtio-scsi' : 'filesystem' })),
    cdroms: [],
    tools: { status: s.toolsRunning ? 'toolsOk' : running ? 'toolsNotRunning' : 'toolsNotInstalled', runningStatus: s.toolsRunning ? 'guestToolsRunning' : 'guestToolsNotRunning', version: '', versionStatus: '' },
    guest: { hostName: i.state?.os_info?.hostname ?? '', os: i.state?.os_info?.os ?? os, family: 'linuxGuest', ips: s.ips, gateways: [], dns: [], domain: '', state: running ? 'running' : 'notRunning', heartbeat: s.toolsRunning ? 'green' : 'gray' },
    placement: { host: i.location && i.location !== 'none' ? i.location : api.server?.environment?.server_name ?? '', cluster: '', resourcePool: api.project ?? '', folder: '', datastores: [...new Set(diskDevs.map(([, x]) => x.pool).filter(Boolean))].sort(), vmxPath: '' },
  };
}

// Incus counts usage but keeps no history: what is known now, and no samples.
export async function metrics(api, b) {
  const { i, uptime } = await read(api, b.vm);
  return { interval: 60, samples: [], quick: { cpuMhz: 0, memoryActiveMb: Math.floor((Number(i.state?.memory?.usage) || 0) / MIB), uptimeSeconds: uptime } };
}

async function picture(api) {
  const [hosts, instances] = [await members(api), await api('GET', '/1.0/instances?recursion=2')];
  const hostOf = (i) => (i.location && i.location !== 'none' ? i.location : hosts[0]?.name ?? '');
  return { hosts, instances, hostOf };
}
export async function topology(api) {
  const { hosts, instances, hostOf } = await picture(api), stores = await pools(api);
  return { time: new Date().toISOString(), compute: [{ moref: 'incus', name: api.server?.environment?.server_clustered ? 'cluster' : hosts[0]?.name ?? 'incus', kind: hosts.length > 1 ? 'cluster' : 'host' }],
    hosts: hosts.map((h) => ({ moref: h.name, name: h.name, compute: 'incus', state: h.online ? 'connected' : 'disconnected', power: h.online ? 'poweredOn' : 'unknown', cpuUsedMhz: 0, cpuTotalMhz: h.mhz * (h.cores || h.threads), memUsedMb: Math.floor(h.used / MIB), memTotalMb: Math.floor(h.memory / MIB) })),
    datastores: stores.map((p) => ({ moref: p.name, name: p.name, capacityGb: p.total / GIB, freeGb: Math.max(0, p.total - p.used) / GIB, hosts: hosts.map((h) => h.name) })),
    vms: instances.filter((i) => i.name.startsWith(PREFIX)).map((i) => ({ moref: idOf(i), name: i.name, host: hostOf(i), power: power(i), cpuUsedMhz: 0, memUsedMb: Math.floor((Number(i.state?.memory?.usage) || 0) / MIB), rxKBps: null, txKBps: null })),
    otherVms: instances.filter((i) => !i.name.startsWith(PREFIX)).length };
}
export async function powerReport(api) {
  const { hosts, instances, hostOf } = await picture(api);
  return { time: new Date().toISOString(), hosts: hosts.map((h) => ({ moref: h.name, name: h.name, watts: null, cpuUsedMhz: 0, cpuTotalMhz: h.mhz * (h.cores || h.threads), coreMhz: h.mhz, connected: h.online })),
    vms: instances.filter((i) => power(i) === 'poweredOn' && i.name.startsWith(PREFIX) && i.name.length > PREFIX.length).map((i) => ({ name: i.name, host: hostOf(i), cpuUsedMhz: 0, traffic: [] })) };
}
