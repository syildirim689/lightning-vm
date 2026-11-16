// Server operations: a resumable step machine. PostgreSQL holds the truth (operation step, VMware
// task id, VM moref); every step first checks what already happened, so a retry, a worker restart or
// a network timeout continues the work instead of repeating it. No transaction is held open while
// VMware is called.
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { UnrecoverableError } from 'bullmq';

export class OperationError extends Error {
  constructor(code, detail, permanent = false) { super(code); this.code = code; this.detail = detail; this.permanent = permanent; }
}

// Codes that will not change by retrying; everything else (network, timeouts, 5xx) is retried with backoff.
const permanent = new Set(['SNAPSHOT_NOT_FOUND', 'INVALID_LOGIN', 'PERMISSION_DENIED', 'WRITE_RESTRICTED', 'PROVISIONING_NOT_SUPPORTED', 'TEMPLATE_NOT_FOUND',
  'NETWORK_NOT_FOUND', 'TEMPLATE_HAS_NO_NIC', 'DISK_SMALLER_THAN_TEMPLATE', 'INSUFFICIENT_RESOURCES', 'NOT_MANAGED', 'TOOLS_NOT_RUNNING',
  'TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH', 'ENDPOINT_BLOCKED', 'INVALID_REQUEST', 'SECRET_KEY_UNAVAILABLE', 'INVALID_STATE', 'VM_NOT_FOUND',
  'FIREWALL_NEEDS_DVS', 'FIREWALL_TOO_MANY_RULES', 'DISK_SHRINK_NOT_SUPPORTED', 'DISK_HAS_SNAPSHOTS', 'VM_HAS_NO_DISK', 'DISK_NOT_SUPPORTED', 'DATASTORE_NOT_FOUND', 'PLATFORM_NOT_SUPPORTED', 'HOST_IS_SLAVE']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readinessPollMs = Number(process.env.READINESS_POLL_MS) || 5000;
const taskPollMs = Number(process.env.TASK_POLL_MS) || 2000;
const shutdownPollMs = Number(process.env.SHUTDOWN_POLL_MS) || 5000;

let key;
export function decrypt(blob, context) {
  key ??= Buffer.from(readFileSync(process.env.MASTER_KEY_FILE ?? '/run/secrets/master_key', 'utf8').trim(), 'base64');
  const raw = Buffer.from(blob.replace(/^v1:/, ''), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(context));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}

// Adapters besides VMware's, by connection kind. All speak the same contract (docs/adapter-contract.md).
const adapters = { proxmox: () => process.env.PROXMOX_SERVICE_URL ?? 'http://proxmox:8080', xcpng: () => process.env.XCPNG_SERVICE_URL ?? 'http://xcpng:8080',
  ovirt: () => process.env.OVIRT_SERVICE_URL ?? 'http://ovirt:8080', hyperv: () => process.env.HYPERV_SERVICE_URL ?? 'http://hyperv:8080',
  libvirt: () => process.env.LIBVIRT_SERVICE_URL ?? 'http://libvirt:8080', incus: () => process.env.INCUS_SERVICE_URL ?? 'http://incus:8080' };
// Where a platform's adapter listens (VMware's when the kind names no other). Uploads (iso.mjs) use the same lookup.
export const adapterBase = (platform) => adapters[platform]?.() ?? process.env.VMWARE_SERVICE_URL ?? 'http://vmware:8080';
// The adapter request for a stored connection (password decrypted in memory only).
export const connectionTarget = (c) => ({ host: c.host, port: c.port, username: c.username, password: decrypt(c.password_enc, c.id), ...(c.api_version && { apiVersion: c.api_version }), ...(adapters[c.kind] && { platform: c.kind }),
  tls: { mode: c.tls_mode, ...(c.tls_ca_pem && { caPem: c.tls_ca_pem }), ...(c.tls_sha256 && { sha256: c.tls_sha256 }) } });

export async function adapter(path, body) {
  let token;
  try { token = readFileSync(process.env.VMWARE_SERVICE_TOKEN_FILE ?? '/run/secrets/vmware_token', 'utf8').trim(); }
  catch { throw new OperationError('VMWARE_SERVICE_UNAVAILABLE', 'service token missing'); }
  let res;
  try {
    // The adapter of the connection's platform: both speak the same contract (docs/adapter-contract.md).
    res = await fetch(`${adapterBase(body?.platform)}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(130_000) });
  } catch { throw new OperationError('VMWARE_SERVICE_UNAVAILABLE', `${path} unreachable`); }
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new OperationError(out?.code ?? 'VMWARE_ERROR', out?.message, permanent.has(out?.code));
  return out;
}

// Everything one operation needs, read fresh each time (never cached across steps).
async function load(db, opId) {
  const { rows: [op] } = await db.query('SELECT * FROM operations WHERE id = $1', [opId]);
  if (!op) return null;
  return { op, ...(await loadServer(db, op.server_id)) };
}

async function loadServer(db, serverId) {
  const { rows: [s] } = await db.query(`SELECT s.*, p.connection_id, p.datastore_morefs, p.network_moref, p.compute_moref, i.template_moref, i.family AS image_family,
      host(a.address) AS address, masklen(ip.cidr) AS prefix, host(ip.gateway) AS gateway, ARRAY(SELECT host(x) FROM unnest(ip.dns) x) AS dns,
      ARRAY(SELECT host(e.address) FROM ip_allocations e WHERE e.server_id = s.id AND e.kind = 'extra' ORDER BY e.address) AS extra,
      (SELECT host(v.address) FROM ip_allocations v WHERE v.server_id = s.id AND v.kind = 'ipv6') AS ipv6,
      masklen(ip.ipv6_prefix) AS ipv6_prefix_len, host(ip.ipv6_gateway) AS ipv6_gateway,
      (SELECT u.install_enc FROM server_updates u WHERE u.server_id = s.id) AS updates_install_enc
    FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN os_images i ON i.id = s.image_id
    LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary' LEFT JOIN ip_pools ip ON ip.id = a.ip_pool_id WHERE s.id = $1`, [serverId]);
  if (!s) return null;
  const { rows: [c] } = await db.query('SELECT * FROM vmware_connections WHERE id = $1', [s.connection_id]);
  const target = connectionTarget(c);
  return { s, target, vmName: `lvm-${s.id}`, customization: c.customization ?? 'auto', compat: c.compat };
}

const setStep = (db, op, step) => db.query('UPDATE operations SET step = $2, updated_at = now() WHERE id = $1', [op.id, step]);
// What a platform did not do although the request went through (codes, e.g. Proxmox EXTRA_ADDRESSES_NOT_CONFIGURED):
// kept on the operation (params.warnings, shown with it in the admin's operations list) and in the log, because a
// retry after a lost answer finds the server already there and is not told again.
export const warningCodes = (out) => [...new Set((Array.isArray(out?.warnings) ? out.warnings : []).filter((w) => typeof w === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(w)))].slice(0, 10);
async function saveWarnings(db, ctx, out) {
  const codes = warningCodes(out), { op } = ctx;
  if (!codes.length) return;
  ctx.log?.('warn', 'operation_warnings', { kind: op.kind, operationId: op.id, serverId: op.server_id, warnings: codes });
  await db.query(`UPDATE operations SET params = params || jsonb_build_object('warnings', (SELECT COALESCE(jsonb_agg(DISTINCT w), '[]'::jsonb)
    FROM jsonb_array_elements_text(COALESCE(params->'warnings', '[]'::jsonb) || $2::jsonb) w)), updated_at = now() WHERE id = $1`, [op.id, JSON.stringify(codes)]);
}
const saveTask = (db, op, task) => db.query('UPDATE operations SET provider_task_id = $2, updated_at = now() WHERE id = $1', [op.id, task || null]);

async function guard(db, op) {
  const { rows: [o] } = await db.query('SELECT cancel_requested, deadline_at < now() AS late FROM operations WHERE id = $1', [op.id]);
  if (o.cancel_requested) throw new OperationError('CANCELLED', 'cancel requested', true);
  if (o.late) throw new OperationError('TIMEOUT', 'operation deadline passed', true);
}

// Waits for a VMware task; the task id is stored before waiting so a restart resumes the wait.
async function waitTask(db, ctx, task) {
  for (;;) {
    await guard(db, ctx.op);
    const t = await adapter('/v1/task', { ...ctx.target, task });
    if (t.state === 'success') return t;
    if (t.state === 'error') {
      // A failed task stays failed: its id is forgotten, so a retry issues the step again instead of reading the same failure.
      await saveTask(db, ctx.op, null);
      ctx.op.provider_task_id = null;
      throw new OperationError(t.code, t.error, permanent.has(t.code));
    }
    if (t.code === 'TASK_NOT_FOUND') return t; // expired from vCenter: the caller checks the real object (or lostTask)
    await sleep(taskPollMs);
  }
}

// A task the platform no longer knows proves nothing about its result (a vanished disk copy is not a finished one). Where
// the result can be read (`done`), it is; otherwise the stored id is dropped and the step fails as retryable, so the next
// attempt issues it again. Every step that comes here is safe to repeat or checks first what is already there.
async function lostTask(db, ctx, done) {
  await saveTask(db, ctx.op, null);
  ctx.op.provider_task_id = null;
  if (done && (await done())) return;
  throw new OperationError('TASK_FAILED', 'the platform no longer knows the task; the step is issued again');
}

const find = async (ctx) => (await adapter('/v1/vm/find', { ...ctx.target, name: ctx.vmName })).vm;

async function bestDatastore(db, s) {
  const { rows: [d] } = await db.query('SELECT moref FROM vmware_datastores WHERE connection_id = $1 AND moref = ANY($2) AND accessible ORDER BY free_bytes DESC LIMIT 1',
    [s.connection_id, s.datastore_morefs]);
  const { rows: [r] } = await db.query('SELECT resource_pool FROM vmware_compute WHERE connection_id = $1 AND moref = $2', [s.connection_id, s.compute_moref]);
  if (!d || !r?.resource_pool) throw new OperationError('INVENTORY_STALE', 'datastore or resource pool not in inventory; discover again', true);
  return { datastore: d.moref, pool: r.resource_pool };
}

// Nested ESXi (William Lam's appliance and similar): the host reads its network, password and SSH setting from
// these vApp (OVF) properties on first boot. The root password is the one stored (encrypted) with the order.
export function esxiProperties(s) {
  const mask = (bits) => [24, 16, 8, 0].map((sh) => (Number(bits) >= 32 - sh ? 255 : Number(bits) <= 24 - sh ? 0 : (0xff << (32 - sh - Number(bits))) & 0xff)).join('.');
  return {
    'guestinfo.hostname': s.name, 'guestinfo.ipaddress': s.address ?? '', 'guestinfo.netmask': s.prefix ? mask(s.prefix) : '', 'guestinfo.gateway': s.gateway ?? '',
    'guestinfo.dns': (s.dns ?? []).join(','), 'guestinfo.domain': '', 'guestinfo.ntp': 'pool.ntp.org', 'guestinfo.ssh': 'True', 'guestinfo.createvmfs': 'False',
    'guestinfo.password': s.root_password_enc ? decrypt(s.root_password_enc, 'server-root-password') : '',
  };
}

// Installs the update reporter (api: guest-updates-script.ts) on the first boot. The panel may not be reachable
// the moment the network comes up, so it tries for about ten minutes; then the owner can still install it by hand.
export function updatesInstaller(url, id, token) {
  return `#!/bin/sh
# Lightning VM update reporter: tells the panel which updates wait. Turn it off on the server's page in the panel.
command -v curl >/dev/null 2>&1 || apt-get install -y curl >/dev/null 2>&1 || dnf install -y curl >/dev/null 2>&1 || yum install -y curl >/dev/null 2>&1
n=0
while [ "$n" -lt 30 ]; do
  if curl -fsSL -m 30 '${url}/api/guest/updates.sh' -o /root/lightning-updates.sh && sh /root/lightning-updates.sh '${url}' '${id}' '${token}'; then break; fi
  n=$((n + 1)); sleep 20
done
rm -f /root/lightning-updates.sh /root/lightning-updates-install.sh
`;
}

// cloud-init (JSON is valid YAML): every allocated address (primary and extra IPv4 on one subnet, the IPv6
// one if the pool has a prefix) and the customer's SSH keys.
export function cloudInit(s) {
  const addresses = [`${s.address}/${s.prefix}`, ...(s.extra ?? []).map((a) => `${a}/${s.prefix}`)];
  const routes = [{ to: 'default', via: s.gateway }];
  if (s.ipv6) { addresses.push(`${s.ipv6}/${s.ipv6_prefix_len}`); routes.push({ to: '::/0', via: s.ipv6_gateway, 'on-link': true }); }
  const metadata = JSON.stringify({ 'instance-id': s.id, 'local-hostname': s.name, network: { version: 2, ethernets: { nic0: {
    match: { name: 'e*' }, addresses, routes, nameservers: { addresses: s.dns } } } } });
  // The root password, when one was chosen, arrives only as a SHA-512 crypt hash (console and RDP; SSH stays key-only).
  const files = [], commands = [];
  // An application (cPanel, Plesk, ...): its script runs in the background so the server becomes ready meanwhile.
  if (s.app_script_enc) {
    files.push({ path: '/root/lightning-app.sh', permissions: '0700', content: decrypt(s.app_script_enc, 'server-app-script') });
    commands.push(['sh', '-c', 'nohup sh /root/lightning-app.sh > /var/log/lightning-app.log 2>&1 &']);
  }
  // The update reporter (Linux), also in the background. A copy without one must not report as the server it was copied from.
  const [url, token] = s.updates_install_enc && s.image_family === 'linux' ? decrypt(s.updates_install_enc, 'server-updates-install').split(' ') : [];
  if (url && token) {
    files.push({ path: '/root/lightning-updates-install.sh', permissions: '0700', content: updatesInstaller(url, s.id, token) });
    commands.push(['sh', '-c', 'nohup sh /root/lightning-updates-install.sh > /var/log/lightning-updates-install.log 2>&1 &']);
  } else if (s.clone_from_moref) commands.push(['sh', '-c', 'rm -f /etc/lightning-updates.conf']);
  // disable_root false: on stock cloud images the top-level keys otherwise reach root only as a "please login as the
  // user" stub, while the panel tells the customer to connect as root. The keys stay top-level: the Proxmox and oVirt
  // adapters read them from there.
  const userdata = '#cloud-config\n' + JSON.stringify({ hostname: s.name, ssh_authorized_keys: s.ssh_public_keys, disable_root: false, ssh_pwauth: false,
    ...(s.root_password_hash && { chpasswd: { expire: false, list: `root:${s.root_password_hash}` } }),
    ...(files.length && { write_files: files }), ...(commands.length && { runcmd: commands }) });
  return { metadata, userdata };
}

async function ensureVM(db, ctx) {
  const { op, s } = ctx;
  if (s.vm_moref) return s.vm_moref;
  await setStep(db, op, 'clone');
  let vm = null;
  if (op.provider_task_id) {
    const t = await waitTask(db, ctx, op.provider_task_id).catch((e) => { if (e.code === 'DUPLICATE_NAME') return {}; throw e; });
    vm = t.vm || (await find(ctx))?.moref || null;
    if (!vm) await saveTask(db, op, null); // the old task left nothing behind; a new clone is safe
  }
  if (!vm) {
    const { datastore, pool } = await bestDatastore(db, s);
    // The adapter looks the name up first, so a retry after a lost response returns the earlier VM.
    // How the guest gets its cloud-init data: the admin's choice, else what discovery found the version supports.
    const customization = ctx.customization === 'auto' ? (ctx.compat?.customization ?? 'cloudinit') : ctx.customization;
    if (customization === 'none') throw new OperationError('PROVISIONING_NOT_SUPPORTED', 'this endpoint cannot customize guests', true);
    const { rows: [st] } = await db.query("SELECT value FROM settings WHERE key = 'servers'");
    const hw = { cpuHotAdd: false, memoryHotAdd: false, nestedHv: false, ...st?.value?.hardware };
    const guest = s.image_family === 'esxi' ? { customization: 'appliance', nestedHv: true, vappProperties: esxiProperties(s) } : { customization, ...cloudInit(s) };
    const out = await adapter('/v1/vm/clone', { ...ctx.target, name: ctx.vmName, serverId: s.id, template: s.clone_from_moref ?? s.template_moref, pool, datastore,
      network: s.network_moref, vcpu: s.vcpu, memoryMb: s.memory_mb, diskGb: s.disk_gb, ...hw, ...guest });
    await saveWarnings(db, ctx, out);
    if (out.vm) vm = out.vm;
    else {
      await saveTask(db, op, out.task);
      const t = await waitTask(db, ctx, out.task).catch((e) => { if (e.code === 'DUPLICATE_NAME') return {}; throw e; });
      vm = t.vm || (await find(ctx))?.moref;
    }
  }
  if (!vm) throw new OperationError('CLONE_RESULT_MISSING', 'clone finished but no VM was found');
  await db.query('UPDATE servers SET vm_moref = $2, updated_at = now() WHERE id = $1', [s.id, vm]);
  await saveTask(db, op, null);
  op.provider_task_id = null; // any task id stored from here on belongs to the next step
  return vm;
}

// Readiness: powered on is not enough. A server is ready when VMware Tools runs in the guest and the
// guest reports the address cloud-init was given (network configured, cloud-init ran).
async function waitReady(db, ctx) {
  await setStep(db, ctx.op, 'readiness');
  for (;;) {
    await guard(db, ctx.op);
    const st = await find(ctx);
    if (!st) throw new OperationError('VM_MISSING', 'the VM disappeared during provisioning', true);
    await db.query('UPDATE servers SET power_state = $2, updated_at = now() WHERE id = $1', [ctx.s.id, st.powerState]);
    if (st.powerState === 'poweredOn' && st.toolsRunning && st.ips.includes(ctx.s.address)) return;
    await sleep(readinessPollMs);
  }
}

async function power(db, ctx, action) {
  const vm = ctx.s.vm_moref;
  await setStep(db, ctx.op, action);
  const want = { on: 'poweredOn', off: 'poweredOff', shutdown: 'poweredOff' }[action];
  try {
    let t;
    if (ctx.op.provider_task_id) t = await waitTask(db, ctx, ctx.op.provider_task_id);
    else {
      const out = await adapter('/v1/vm/power', { ...ctx.target, vm, action });
      if (out.task) { await saveTask(db, ctx.op, out.task); t = await waitTask(db, ctx, out.task); }
    }
    // The task expired unseen: on and off are read from the VM and issued again if it is not there yet. A reset cannot
    // be read back and a second one would cut the guest off again, so it counts as done.
    if (t?.code === 'TASK_NOT_FOUND' && want) await lostTask(db, ctx, async () => (await find(ctx))?.powerState === want);
  } catch (e) {
    // Already in the wanted state (for example after a restart mid-task): that is success. A clean shutdown of a
    // server that is already off is refused as "no guest agent" by some adapters; it is just as done.
    const state = e.code === 'INVALID_STATE' || (action === 'shutdown' && e.code === 'TOOLS_NOT_RUNNING') ? (await find(ctx))?.powerState : null;
    // A reset of a stopped server starts it (what the customer wants from "restart").
    if (action === 'reset' && state === 'poweredOff') { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; return power(db, ctx, 'on'); }
    if (!want || state !== want) throw e;
  }
  await saveTask(db, ctx.op, null);
  ctx.op.provider_task_id = null;
}

// Removes the VM, then confirms in VMware that it is gone before releasing the reservation and IP.
async function removeVM(db, ctx) {
  await setStep(db, ctx.op, 'destroy');
  const st = await find(ctx);
  const vm = st?.moref ?? ctx.s.vm_moref;
  if (st && vm) {
    let t;
    if (ctx.op.provider_task_id) t = await waitTask(db, ctx, ctx.op.provider_task_id);
    else {
      const out = await adapter('/v1/vm/destroy', { ...ctx.target, vm });
      if (out.task) { await saveTask(db, ctx.op, out.task); t = await waitTask(db, ctx, out.task); }
    }
    // A task that expired with the VM still listed (below) is not waited for again: the retry destroys anew.
    if (t?.code === 'TASK_NOT_FOUND') { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; }
  }
  await setStep(db, ctx.op, 'verify_gone');
  if (await find(ctx)) throw new OperationError('VM_STILL_PRESENT', 'VMware still lists the VM');
  await saveTask(db, ctx.op, null);
  ctx.op.provider_task_id = null;
}

async function destroy(db, ctx) {
  await removeVM(db, ctx);
  // Its backups go too (after the transaction below marks them; a file left behind is only space). What the transaction
  // released is also written into the operation, in the same transaction: a retry after the commit (a crash, a failed
  // status update) finds nothing left to release, and still clears the PTR records and deletes the backup files.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // A deleted server's addresses wait out their pool's quarantine before anyone else gets them (their
    // reputation may still be this customer's); a cancelled create never used them and frees them at once.
    if (ctx.op.kind === 'delete') {
      await client.query(`INSERT INTO ip_quarantine (address, ip_pool_id, available_at, server_name)
        SELECT a.address, a.ip_pool_id, now() + make_interval(hours => ip.quarantine_hours), $2 FROM ip_allocations a JOIN ip_pools ip ON ip.id = a.ip_pool_id
        WHERE a.server_id = $1 AND ip.quarantine_hours > 0
        ON CONFLICT (address) DO UPDATE SET released_at = now(), available_at = EXCLUDED.available_at, server_name = EXCLUDED.server_name`, [ctx.s.id, ctx.s.name]);
    }
    const { rows: released } = await client.query('DELETE FROM ip_allocations WHERE server_id = $1 RETURNING host(address) AS address, ptr', [ctx.s.id]);
    // A key-based licence goes back to the pool for the next order.
    await client.query('UPDATE application_licenses SET server_id = NULL, assigned_at = NULL WHERE server_id = $1', [ctx.s.id]);
    await client.query('DELETE FROM private_network_members WHERE server_id = $1', [ctx.s.id]);
    const { rows: backups } = await client.query("UPDATE backups SET status = 'deleted' WHERE server_id = $1 AND status <> 'deleted' RETURNING datastore_moref, path", [ctx.s.id]);
    if (released.length || backups.length) await client.query("UPDATE operations SET params = params || jsonb_build_object('released', $2::jsonb, 'backups', $3::jsonb) WHERE id = $1",
      [ctx.op.id, JSON.stringify(released), JSON.stringify(backups)]);
    ctx.released = released.length ? released : ctx.op.params?.released ?? [];
    ctx.backups = backups.length ? backups : ctx.op.params?.backups ?? [];
    await client.query("UPDATE servers SET state = 'deleted', deleted_at = now(), power_state = 'unknown', updated_at = now() WHERE id = $1", [ctx.s.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  for (const b of ctx.backups ?? []) await adapter('/v1/backup/delete', { ...ctx.target, datastore: b.datastore_moref, name: b.path }).catch(() => undefined);
}

// Writes the union of the server's firewalls to VMware. The version is read first, so the recorded version
// never claims rules newer than the ones written. No firewall attached removes the filter.
async function writeFirewall(db, ctx) {
  const { rows: [v] } = await db.query('SELECT firewall_version FROM servers WHERE id = $1', [ctx.s.id]);
  const { rows } = await db.query('SELECT f.rules FROM firewall_servers fs JOIN firewalls f ON f.id = fs.firewall_id WHERE fs.server_id = $1', [ctx.s.id]);
  const rules = rows.flatMap((r) => r.rules).map((r) => ({ direction: r.direction, protocol: r.protocol, port: r.port ?? '', ips: r.ips }));
  await adapter('/v1/vm/firewall', { ...ctx.target, vm: ctx.s.vm_moref, enabled: rows.length > 0, rules });
  await db.query(`UPDATE servers SET firewall_applied_version = GREATEST(firewall_applied_version, $2), firewall_error = NULL,
    firewall_applied_at = now() WHERE id = $1`, [ctx.s.id, v.firewall_version]);
}

// A firewall job (queue "firewalls", one at a time): applies the server's current rules if they are newer than
// what VMware has. A server still being created is skipped; its create operation applies them before boot.
export async function processFirewall(db, job, log, notify = async () => {}) {
  const ctx = await loadServer(db, job.data.serverId);
  if (!ctx || !ctx.s.vm_moref || ['deleted', 'deleting', 'provisioning'].includes(ctx.s.state)) return;
  if (ctx.s.firewall_applied_version >= ctx.s.firewall_version) return;
  try {
    await writeFirewall(db, ctx);
    log('info', 'firewall_applied', { serverId: ctx.s.id, version: ctx.s.firewall_version });
  } catch (err) {
    const code = err.code ?? 'INTERNAL_ERROR';
    const last = err.permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    log(last ? 'error' : 'warn', 'firewall_failed', { serverId: ctx.s.id, code, final: last });
    if (!last) throw err;
    await db.query('UPDATE servers SET firewall_error = $2 WHERE id = $1', [ctx.s.id, code]);
    await notify('server.firewall_failed', [ctx.s.owner_id], { serverId: ctx.s.id, name: ctx.s.name, code });
    throw new UnrecoverableError(code);
  }
}

// The disk a disk_add made, among the VM's disks: never the system disk or one a row of this server already holds;
// new since `before` (keys listed before the call) when that is known, else of the asked size when one is given.
export const addedDisk = (disks, taken, { before, sizeGb }) =>
  disks.find((d) => !d.system && !taken.includes(d.key) && !(before && before.includes(d.key)) && (sizeGb === undefined || d.sizeGb === sizeGb)) ?? null;

const kinds = {
  async create(db, ctx) {
    ctx.s.vm_moref = await ensureVM(db, ctx);
    await guard(db, ctx.op);
    // Firewalls chosen at order time are in place before the guest first boots.
    if (ctx.s.firewall_applied_version < ctx.s.firewall_version) { await setStep(db, ctx.op, 'firewall'); await writeFirewall(db, ctx); }
    await setStep(db, ctx.op, 'power_on');
    const st = await find(ctx);
    if (st?.powerState !== 'poweredOn') await power(db, ctx, 'on');
    await waitReady(db, ctx);
    // Proxmox's own cloud-init carries the network and the SSH keys only: the root password, the host name, files
    // and first-boot commands are applied through the guest agent now that the server answers (once; a retry is a no-op).
    if (ctx.target.platform === 'proxmox' && ctx.s.image_family !== 'esxi') {
      const out = await adapter('/v1/vm/guest-setup', { ...ctx.target, vm: ctx.s.vm_moref, userdata: cloudInit(ctx.s).userdata });
      if (out?.reason === 'NO_GUEST_AGENT') console.warn(JSON.stringify({ level: 'warn', service: 'worker', msg: 'guest_setup_skipped', serverId: ctx.s.id, reason: out.reason }));
    }
    await db.query("UPDATE servers SET state = 'ready', guest_ready = true, error_code = NULL, updated_at = now() WHERE id = $1", [ctx.s.id]);
  },
  delete: (db, ctx) => destroy(db, ctx),
  // A fresh VM from the image the API recorded, on the same addresses, keys and firewalls. The old VM goes first;
  // once the clone step started a retry never removes again (it would remove the new VM).
  async reinstall(db, ctx) {
    if (!['clone', 'firewall', 'power_on', 'readiness'].includes(ctx.op.step)) {
      await removeVM(db, ctx);
      // The new image; an application installed on the old disk went with it, so its licence returns to the pool.
      await db.query(`UPDATE servers SET vm_moref = NULL, image_id = $2, clone_from_moref = NULL, firewall_applied_version = 0, guest_ready = false, application_id = NULL, app_script_enc = NULL,
        app_state = NULL, app_message = NULL, updated_at = now() WHERE id = $1`, [ctx.s.id, ctx.op.params.imageId]);
      await db.query('UPDATE application_licenses SET server_id = NULL, assigned_at = NULL WHERE server_id = $1', [ctx.s.id]);
    }
    Object.assign(ctx, await loadServer(db, ctx.s.id)); // the new image's template, read after the change above
    await kinds.create(db, ctx);
  },
  // A backup: a short snapshot (the base disk stops changing), the base disk copied to the backup datastore, the
  // snapshot removed. Each step is resumable; a retry never copies or snapshots twice.
  async backup_create(db, ctx) {
    const b = await backupOf(db, ctx.op.params.backupId);
    await db.query("UPDATE backups SET status = 'running' WHERE id = $1 AND status = 'pending'", [b.id]);
    const snap = `lightning-backup ${b.id}`;
    if (!['copy', 'cleanup'].includes(ctx.op.step)) {
      if (!(await snapshotNamed(ctx, snap))) await vmTask(db, ctx, 'snapshot', '/v1/vm/snapshot', { action: 'create', name: snap, description: 'Backup in progress' });
      await nextStep(db, ctx);
    }
    if (ctx.op.step !== 'cleanup') {
      await vmTask(db, ctx, 'copy', '/v1/vm/disk-copy', { datastore: b.datastore_moref, name: b.path, direction: 'backup' });
      await nextStep(db, ctx);
    }
    await setStep(db, ctx.op, 'cleanup');
    const id = await snapshotNamed(ctx, snap);
    if (id) await vmTask(db, ctx, 'cleanup', '/v1/vm/snapshot', { action: 'remove', snapshot: id });
    await db.query("UPDATE backups SET status = 'ready', size_gb = $2, finished_at = now() WHERE id = $1", [b.id, ctx.s.disk_gb]);
  },
  // A restore: stopped (cleanly first), the backup copied over the disk, started again if it ran.
  async backup_restore(db, ctx) {
    const b = await backupOf(db, ctx.op.params.backupId);
    if (ctx.op.step !== 'on') {
      if (ctx.op.step !== 'restore') await stopForChange(db, ctx);
      await vmTask(db, ctx, 'restore', '/v1/vm/disk-copy', { datastore: b.datastore_moref, name: b.path, direction: 'restore' });
      await nextStep(db, ctx);
    }
    if (ctx.op.params.powerOn) await power(db, ctx, 'on');
    await refreshPower(db, ctx);
  },
  // A move to another host or datastore while it runs; the inventory row gets the new host at once.
  async migrate(db, ctx) {
    await setStep(db, ctx.op, 'migrate');
    if (!ctx.op.provider_task_id) {
      const out = await adapter('/v1/vm/migrate', { ...ctx.target, vm: ctx.s.vm_moref, host: ctx.op.params.host ?? '', datastore: ctx.op.params.datastore ?? '' });
      if (!out.task) return; // already there
      await saveTask(db, ctx.op, out.task);
      ctx.op.provider_task_id = out.task;
    }
    // A move that vanished is asked for again: the adapter answers "already there" when it did finish.
    if ((await waitTask(db, ctx, ctx.op.provider_task_id)).code === 'TASK_NOT_FOUND') await lostTask(db, ctx);
    if (ctx.op.params.host) await db.query('UPDATE vmware_vms SET host_moref = $3 WHERE connection_id = $1 AND moref = $2', [ctx.s.connection_id, ctx.s.vm_moref, ctx.op.params.host]);
  },
  // An extra disk: added beside the system disk; its device key is the new one VMware lists.
  async disk_add(db, ctx) {
    const sizeGb = ctx.op.params.sizeGb, retry = ctx.op.step === 'disk', resumed = retry && !!ctx.op.provider_task_id;
    const disks = async () => (await adapter('/v1/vm/disks', { ...ctx.target, vm: ctx.s.vm_moref })).disks;
    const taken = (await db.query('SELECT device_key FROM server_disks WHERE server_id = $1 AND device_key IS NOT NULL', [ctx.s.id])).rows.map((r) => r.device_key);
    const before = await disks();
    // disk-add is not idempotent, and some platforms answer only after the disk exists and without a task id. A retry
    // that cannot tell whether its earlier call went through first adopts a disk of the asked size that no row holds.
    let fresh = retry && !resumed ? addedDisk(before, taken, { sizeGb }) : null;
    if (!fresh) {
      await vmTask(db, ctx, 'disk', '/v1/vm/disk-add', { sizeGb });
      const after = await disks();
      // A retry that waited for the stored task may have listed the new disk in "before" already.
      fresh = addedDisk(after, taken, { before: before.map((d) => d.key) }) ?? (resumed ? addedDisk(after, taken, {}) : null);
    }
    if (!fresh) throw new OperationError('DISK_NOT_FOUND', 'the new disk is not listed', true);
    await db.query("UPDATE server_disks SET device_key = $2, status = 'ready' WHERE id = $1", [ctx.op.params.diskId, fresh.key]);
  },
  async disk_remove(db, ctx) {
    const { rows: [d] } = await db.query('SELECT * FROM server_disks WHERE id = $1', [ctx.op.params.diskId]);
    if (d) {
      await vmTask(db, ctx, 'disk', '/v1/vm/disk-remove', { key: ctx.op.params.key });
      // One statement: the row and its share of the price go together, or a crash between leaves the customer paying
      // for a removed disk. The price drops by what this row carries, once (a retry finds no row and changes nothing).
      // An hourly server's hourly price drops by what the API worked out for this disk (hourlySubtract; absent: unchanged).
      await db.query(`WITH gone AS (DELETE FROM server_disks WHERE id = $2 RETURNING price_monthly)
        UPDATE servers s SET price_monthly = greatest(0, s.price_monthly - gone.price_monthly),
          price_hourly = CASE WHEN s.billing_mode = 'hourly' AND s.price_hourly IS NOT NULL AND $3::numeric IS NOT NULL THEN greatest(0, s.price_hourly - $3::numeric) ELSE s.price_hourly END,
          updated_at = now() FROM gone WHERE s.id = $1`, [ctx.s.id, d.id, ctx.op.params.hourlySubtract ?? null]);
    }
  },
  // Joining a private network: a NIC on its port group; the MAC is kept so the guest can match the interface.
  async nic_add(db, ctx) {
    const pg = await networkPortgroup(db, ctx.op.params.networkId);
    await vmTask(db, ctx, 'nic', '/v1/vm/nic-add', { portgroup: pg });
    const { mac } = await adapter('/v1/vm/nic-mac', { ...ctx.target, vm: ctx.s.vm_moref, portgroup: pg });
    await db.query("UPDATE private_network_members SET status = 'joined', mac = $3 WHERE network_id = $1 AND server_id = $2", [ctx.op.params.networkId, ctx.s.id, mac || null]);
  },
  async nic_remove(db, ctx) {
    await vmTask(db, ctx, 'nic', '/v1/vm/nic-remove', { portgroup: await networkPortgroup(db, ctx.op.params.networkId) });
    await db.query('DELETE FROM private_network_members WHERE network_id = $1 AND server_id = $2', [ctx.op.params.networkId, ctx.s.id]);
  },
  // A personal image: the server cloned into a template, then offered to its owner as an image.
  async image_create(db, ctx) {
    const p = ctx.op.params;
    const name = `lvm-img-${p.imageId}`;
    await setStep(db, ctx.op, 'image');
    if (ctx.op.provider_task_id) await waitTask(db, ctx, ctx.op.provider_task_id);
    else {
      const out = await adapter('/v1/image/create', { ...ctx.target, vm: ctx.s.vm_moref, name });
      if (out.task) { await saveTask(db, ctx.op, out.task); await waitTask(db, ctx, out.task); }
    }
    const tpl = (await adapter('/v1/vm/find', { ...ctx.target, name })).vm;
    if (!tpl) throw new OperationError('IMAGE_NOT_FOUND', 'the new template is not listed', true);
    await db.query(`INSERT INTO os_images (id, name, family, connection_id, template_moref, min_disk_gb, cloud_init, active, owner_id, source_server_id)
      VALUES ($1, $2, $3, $4, $5, $6, true, true, $7, $8) ON CONFLICT (id) DO NOTHING`, [p.imageId, p.name, ctx.s.image_family, ctx.s.connection_id, tpl.moref, ctx.s.disk_gb, ctx.s.owner_id, ctx.s.id]);
  },
  async backup_delete(db, ctx) {
    const b = await backupOf(db, ctx.op.params.backupId);
    await setStep(db, ctx.op, 'delete');
    await adapter('/v1/backup/delete', { ...ctx.target, datastore: b.datastore_moref, name: b.path });
    await db.query("UPDATE backups SET status = 'deleted', finished_at = coalesce(finished_at, now()) WHERE id = $1", [b.id]);
  },
  // New vCPU, memory and disk size: the VM is stopped (a clean shutdown first), changed, then started again if it ran.
  async resize(db, ctx) {
    const p = ctx.op.params;
    if (ctx.op.step !== 'on') {
      if (ctx.op.step !== 'resize') await stopForChange(db, ctx); // a retry during "resize" resumes the stored task or asks again
      // A failure leaves the server off and the step at "resize", so a retry changes it for real (starting it here moved
      // the step to "on", and the retry then reported a resize that never happened). A final failure starts it again
      // (processOperation).
      await vmTask(db, ctx, 'resize', '/v1/vm/resize', { vcpu: p.vcpu, memoryMb: p.memoryMb, diskGb: p.diskGb });
      await db.query('UPDATE servers SET vcpu = $2, memory_mb = $3, disk_gb = $4, updated_at = now() WHERE id = $1', [ctx.s.id, p.vcpu, p.memoryMb, p.diskGb]);
      await nextStep(db, ctx);
      await setStep(db, ctx.op, 'on'); // "on" means: resized (also for a server that stays off); a failure from here keeps the new price
    }
    if (p.powerOn) { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; await power(db, ctx, 'on'); }
    await refreshPower(db, ctx);
  },
  async power_on(db, ctx) { await power(db, ctx, 'on'); await refreshPower(db, ctx); },
  async shutdown(db, ctx) {
    await power(db, ctx, 'shutdown');
    let off = false;
    for (let i = 0; i < 60 && !off; i++) { // a guest shutdown has no task; wait until VMware sees it off
      await guard(db, ctx.op);
      off = (await find(ctx))?.powerState === 'poweredOff';
      if (!off) await sleep(shutdownPollMs);
    }
    await refreshPower(db, ctx);
    // The guest ignored the request: that is not a shutdown. (stopForChange forces it off after this.)
    if (!off) throw new OperationError('SHUTDOWN_TIMEOUT', 'the guest did not shut down in time; power it off instead', true);
  },
  async power_off(db, ctx) { await power(db, ctx, 'off'); await refreshPower(db, ctx); },
  // Step "on": the server was off and is being started instead (power); a retry does not reset what it just started.
  async reset(db, ctx) { await power(db, ctx, ctx.op.step === 'on' ? 'on' : 'reset'); await refreshPower(db, ctx); },
  // A task that vanished is judged by the list: asking twice would make a second snapshot, or fail on one already removed.
  snapshot_create: (db, ctx) => snapshot(db, ctx, { action: 'create', name: ctx.op.params.name, description: ctx.op.params.description ?? '' },
    async () => !!(await snapshotNamed(ctx, ctx.op.params.name))),
  snapshot_delete: (db, ctx) => snapshot(db, ctx, { action: 'remove', snapshot: ctx.op.params.snapshot },
    async () => !(await adapter('/v1/vm/snapshots', { ...ctx.target, vm: ctx.s.vm_moref })).snapshots.some((x) => x.id === ctx.op.params.snapshot)),
  // A snapshot without memory comes back powered off: start the VM again if it was running. A retry after the
  // revert finished (step "on") only powers on.
  async snapshot_revert(db, ctx) {
    if (ctx.op.step !== 'on') await snapshot(db, ctx, { action: 'revert', snapshot: ctx.op.params.snapshot });
    if (ctx.op.params.powerOn) { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; await power(db, ctx, 'on'); }
    await refreshPower(db, ctx);
  },
};

const snapshot = (db, ctx, body, done) => vmTask(db, ctx, 'snapshot', '/v1/vm/snapshot', body, done);

// The next step starts without the previous step's task id.
async function nextStep(db, ctx) { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; }

// Off for a change of hardware or disk: a clean shutdown first, then forced off if it is still running.
async function stopForChange(db, ctx) {
  if ((await find(ctx))?.powerState === 'poweredOn') {
    try { await kinds.shutdown(db, ctx); } catch { /* no VMware Tools or no answer: below */ }
    await nextStep(db, ctx);
    if ((await find(ctx))?.powerState === 'poweredOn') await power(db, ctx, 'off');
  }
  await nextStep(db, ctx);
}

const networkPortgroup = async (db, id) => {
  const { rows: [n] } = await db.query('SELECT portgroup_moref FROM private_networks WHERE id = $1', [id]);
  if (!n?.portgroup_moref) throw new OperationError('NETWORK_NOT_FOUND', 'private network missing', true);
  return n.portgroup_moref;
};
const backupOf = async (db, id) => {
  const { rows: [b] } = await db.query('SELECT * FROM backups WHERE id = $1', [id]);
  if (!b) throw new OperationError('BACKUP_NOT_FOUND', 'backup record missing', true);
  return b;
};
const snapshotNamed = async (ctx, name) => (await adapter('/v1/vm/snapshots', { ...ctx.target, vm: ctx.s.vm_moref })).snapshots.find((x) => x.name === name)?.id ?? null;

// One VMware task on the server's VM; a stored task id (a retry) is waited for instead of starting another.
// A task that expired unseen is not success: `done` reads the result where asking again is not safe (lostTask).
async function vmTask(db, ctx, step, path, body, done) {
  await setStep(db, ctx.op, step);
  let task = ctx.op.provider_task_id;
  if (!task) {
    const out = await adapter(path, { ...ctx.target, vm: ctx.s.vm_moref, ...body });
    if (!out.task) return; // nothing left to do (already done)
    await saveTask(db, ctx.op, task = out.task);
  }
  if ((await waitTask(db, ctx, task)).code === 'TASK_NOT_FOUND') await lostTask(db, ctx, done);
}

async function refreshPower(db, ctx) {
  const st = await find(ctx);
  await db.query('UPDATE servers SET power_state = $2, guest_ready = $3, updated_at = now() WHERE id = $1',
    [ctx.s.id, st?.powerState ?? 'unknown', !!(st && st.powerState === 'poweredOn' && st.toolsRunning && st.ips.includes(ctx.s.address))]);
}

// Cancelling a create removes what it built (VM, reservation, IP) once VMware confirms the VM is gone.
// A clone still running is waited for first (whatever its result): where the platform copies in the background and
// defines the VM at the end, nothing is found before that, and the copy would finish into a VM nobody owns. The wait ends
// at the operation's deadline; a clone still running then leaves the cancel failed (the server shows an error) rather
// than a server marked deleted with a VM on the way.
async function rollbackCreate(db, ctx) {
  try {
    for (;;) {
      const { rows: [o] } = await db.query('SELECT provider_task_id, deadline_at < now() AS late FROM operations WHERE id = $1', [ctx.op.id]);
      if (!o?.provider_task_id) break;
      const t = await adapter('/v1/task', { ...ctx.target, task: o.provider_task_id }).catch(() => ({})); // unreachable: asked again
      if (t.state === 'success' || t.state === 'error' || t.code === 'TASK_NOT_FOUND') break;
      if (o.late) return false;
      await sleep(taskPollMs);
    }
    await destroy(db, { ...ctx, op: { ...ctx.op, provider_task_id: null } });
    return true;
  } catch { return false; }
}

// notify(event, to, data): enqueues on the API's notification queue (apps/api/src/notify.ts decides the channels).
// rdns(job): enqueues on the API's reverse-DNS queue (apps/api/src/rdns.ts writes the PTR records).
export async function processOperation(db, job, log, notify = async () => {}, rdns = async () => {}) {
  // Loading can fail too (database, key file); log it instead of failing silently.
  const ctx = await load(db, job.id).catch((e) => { log('error', 'operation_load_failed', { operationId: job.id, error: e.code ?? e.message }); throw e; });
  if (!ctx || ['succeeded', 'failed', 'cancelled'].includes(ctx.op.status)) return; // already settled
  if (ctx.op.step === 'awaiting_payment' && !ctx.op.cancel_requested) return; // billing.ts queues it again once paid
  ctx.log = log; // for the steps that have something to say besides their outcome
  await db.query("UPDATE operations SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1, updated_at = now() WHERE id = $1", [ctx.op.id]);
  try {
    await guard(db, ctx.op);
    await kinds[ctx.op.kind](db, ctx);
    await db.query("UPDATE operations SET status = 'succeeded', step = 'done', finished_at = now(), error_code = NULL, updated_at = now() WHERE id = $1", [ctx.op.id]);
    log('info', 'operation_succeeded', { kind: ctx.op.kind, operationId: ctx.op.id });
    const d = { serverId: ctx.s.id, name: ctx.s.name, kind: ctx.op.kind };
    if (ctx.op.kind === 'create' || ctx.op.kind === 'reinstall') { await notify('server.ready', [ctx.s.owner_id], { ...d, address: ctx.s.address ?? '' }); await rdns({ action: 'default', serverId: ctx.s.id }); }
    else if (ctx.op.kind === 'delete') { await notify('server.deleted', [ctx.s.owner_id], d); if (ctx.released?.length) await rdns({ action: 'clear', addresses: ctx.released.map((a) => a.address) }); }
    else if (ctx.op.kind.startsWith('backup_')) await notify('server.backup', [ctx.s.owner_id], d);
    else if (ctx.op.kind.startsWith('snapshot_')) await notify('server.snapshot', [ctx.s.owner_id], { ...d, snapshot: ctx.op.params.name ?? '' });
    else await notify('server.power', [ctx.s.owner_id], d);
  } catch (err) {
    const code = err.code ?? 'INTERNAL_ERROR';
    const last = err.permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    log(last ? 'error' : 'warn', 'operation_failed', { kind: ctx.op.kind, operationId: ctx.op.id, code, final: last });
    if (!last) {
      await db.query("UPDATE operations SET status = 'pending', error_code = $2, error_detail = $3, updated_at = now() WHERE id = $1", [ctx.op.id, code, String(err.detail ?? '').slice(0, 500)]);
      throw err; // BullMQ retries with exponential backoff
    }
    let status = 'failed';
    if (code === 'CANCELLED' && ctx.op.kind === 'create') status = (await rollbackCreate(db, ctx)) ? 'cancelled' : 'failed';
    await db.query("UPDATE operations SET status = $2, error_code = $3, error_detail = $4, finished_at = now(), updated_at = now() WHERE id = $1",
      [ctx.op.id, status, code, String(err.detail ?? '').slice(0, 500)]);
    if ((ctx.op.kind === 'create' || ctx.op.kind === 'reinstall') && status === 'failed') await db.query("UPDATE servers SET state = 'error', error_code = $2, updated_at = now() WHERE id = $1 AND state <> 'deleted'", [ctx.s.id, code]);
    // A restore or resize refused after the server was stopped: it is started again as it was (only now, at the end:
    // between retries it stays off, so the step can be issued again).
    if (['backup_restore', 'resize'].includes(ctx.op.kind) && status === 'failed' && ctx.op.params.powerOn) await adapter('/v1/vm/power', { ...ctx.target, vm: ctx.s.vm_moref, action: 'on' }).catch(() => undefined);
    if (ctx.op.kind === 'nic_add' && status === 'failed') await db.query("UPDATE private_network_members SET status = 'failed' WHERE network_id = $1 AND server_id = $2", [ctx.op.params.networkId, ctx.s.id]);
    if (ctx.op.kind === 'nic_remove' && status === 'failed') await db.query("UPDATE private_network_members SET status = 'joined' WHERE network_id = $1 AND server_id = $2", [ctx.op.params.networkId, ctx.s.id]);
    if (ctx.op.kind === 'disk_add' && status === 'failed') await db.query("UPDATE server_disks SET status = 'failed' WHERE id = $1", [ctx.op.params.diskId]);
    if (ctx.op.kind === 'disk_remove' && status === 'failed') await db.query("UPDATE server_disks SET status = 'ready' WHERE id = $1", [ctx.op.params.diskId]);
    if (ctx.op.kind === 'backup_create' && status === 'failed') {
      await db.query("UPDATE backups SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1", [ctx.op.params.backupId, code]);
      const left = await snapshotNamed(ctx, `lightning-backup ${ctx.op.params.backupId}`).catch(() => null);
      if (left) await adapter('/v1/vm/snapshot', { ...ctx.target, vm: ctx.s.vm_moref, action: 'remove', snapshot: left }).catch(() => undefined);
    }
    // A resize that did not happen: the old price again, and its unpaid invoice withdrawn (a paid one is left to staff, told below).
    // Read again: the API writes the invoice id after queueing (the copy from the job's start may lack it), and the step
    // tells whether the VM was changed after all ("on": only starting it failed; the new price and its invoice stand).
    if (ctx.op.kind === 'resize' && status === 'failed') {
      const { rows: [now] } = await db.query('SELECT step, params FROM operations WHERE id = $1', [ctx.op.id]);
      const p = now?.params ?? ctx.op.params, f = p.from ?? {};
      if (now?.step !== 'on') {
        // Everything the API changed with the price, as far as "from" carries it (an absent field is left alone; a null allowance is "unlimited").
        await db.query(`UPDATE servers SET price_monthly = $2, package_id = $3, traffic_gb = CASE WHEN $4 THEN $5::int ELSE traffic_gb END,
          price_hourly = CASE WHEN $6 THEN $7::numeric ELSE price_hourly END, updated_at = now() WHERE id = $1`,
          [ctx.s.id, f.priceMonthly ?? ctx.s.price_monthly, f.packageId ?? null, 'trafficGb' in f, f.trafficGb ?? null, f.priceHourly != null, f.priceHourly ?? null]);
        if (p.invoiceId) await db.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'unpaid' AND paid_total = 0", [p.invoiceId]);
      }
    }
    if (ctx.op.kind === 'delete') await db.query("UPDATE servers SET state = 'error', error_code = $2, updated_at = now() WHERE id = $1 AND state = 'deleting'", [ctx.s.id, code]);
    if (status === 'failed') {
      const { rows: [o] } = await db.query('SELECT email FROM users WHERE id = $1', [ctx.s.owner_id]).catch(() => ({ rows: [] }));
      const d = { serverId: ctx.s.id, name: ctx.s.name, kind: ctx.op.kind, code };
      await notify('server.failed', [ctx.s.owner_id], d);
      await notify('admin.operation_failed', 'staff:servers.view_all', { ...d, owner: o?.email ?? '' });
    }
    throw new UnrecoverableError(code);
  }
}

// Compares the platform with VMware: missing VMs, unknown platform-named VMs, power state drift.
// It reports; it never deletes anything on its own.
export async function reconcile(db, log) {
  const { rows: conns } = await db.query("SELECT DISTINCT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE c.kind IN ('vcenter', 'proxmox', 'xcpng', 'ovirt', 'hyperv', 'libvirt', 'incus')");
  for (const c of conns) {
    const target = connectionTarget(c);
    let vms;
    try { vms = (await adapter('/v1/vms/managed', target)).vms; }
    catch (e) {
      log('warn', 'reconcile_unreachable', { connectionId: c.id, code: e.code });
      await db.query("UPDATE vmware_connections SET status = 'error', last_error_code = $2 WHERE id = $1", [c.id, e.code ?? 'VMWARE_ERROR']);
      continue;
    }
    await db.query("UPDATE vmware_connections SET status = 'ok', last_error_code = NULL WHERE id = $1 AND status <> 'ok'", [c.id]);
    const byName = new Map(vms.map((v) => [v.name, v]));
    const { rows: servers } = await db.query(`SELECT s.id, s.state, s.power_state FROM servers s JOIN resource_pools p ON p.id = s.pool_id
      WHERE p.connection_id = $1 AND s.state IN ('ready', 'error', 'missing') AND s.vm_moref IS NOT NULL`, [c.id]);
    const seen = new Set();
    const finding = (kind, serverId, vm, detail) => db.query(`INSERT INTO reconciliation_findings (connection_id, kind, server_id, vm_moref, detail) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (connection_id, kind, COALESCE(server_id::text, vm_moref)) WHERE resolved_at IS NULL DO UPDATE SET last_seen = now(), detail = reconciliation_findings.detail || EXCLUDED.detail`, [c.id, kind, serverId, vm, detail]);
    const missing = [], drifted = [], orphans = []; // what this run still sees wrong; every other open finding of the connection is over
    for (const s of servers) {
      const vm = byName.get(`lvm-${s.id}`);
      seen.add(`lvm-${s.id}`);
      if (!vm) {
        // The state it had is kept with the finding (later runs see "missing" and add nothing), for when the VM is back.
        missing.push(s.id);
        await finding('vm_missing', s.id, null, s.state === 'missing' ? {} : { was: s.state });
        await db.query("UPDATE servers SET state = 'missing', power_state = 'unknown', updated_at = now() WHERE id = $1", [s.id]);
        continue;
      }
      // Back again: the state from before it went missing, so a server that had failed is not promoted to ready.
      // (Findings from before "was" was recorded: an error code still on the row says it had failed.)
      if (s.state === 'missing') await db.query(`UPDATE servers s SET state = COALESCE((SELECT f.detail->>'was' FROM reconciliation_findings f WHERE f.server_id = s.id AND f.kind = 'vm_missing'
        AND f.resolved_at IS NULL AND f.detail->>'was' IN ('ready', 'error') LIMIT 1), CASE WHEN s.error_code IS NULL THEN 'ready' ELSE 'error' END), updated_at = now() WHERE s.id = $1`, [s.id]);
      if (vm.powerState !== s.power_state) {
        drifted.push(s.id);
        await finding('power_drift', s.id, vm.moref, { recorded: s.power_state, actual: vm.powerState });
        await db.query('UPDATE servers SET power_state = $2, updated_at = now() WHERE id = $1', [s.id, vm.powerState]);
      }
    }
    const { rows: live } = await db.query("SELECT 'lvm-' || id AS name FROM servers WHERE state <> 'deleted'");
    const known = new Set(live.map((r) => r.name));
    // Personal images' templates (lvm-img-…) are the panel's too, not stray VMs.
    for (const v of vms) if (!known.has(v.name) && !v.name.startsWith('lvm-img-')) { orphans.push(v.moref); await finding('orphan_vm', null, v.moref, { name: v.name }); }
    // Findings that no longer hold are closed (the admin's count is of open ones): a VM that is back, a power state that
    // matches again (the row above took the platform's value, so the next run closes it), a stray VM no longer listed,
    // and those of servers that left the list (deleted).
    await db.query(`UPDATE reconciliation_findings SET resolved_at = now() WHERE connection_id = $1 AND resolved_at IS NULL AND ((kind = 'vm_missing' AND server_id <> ALL($2::uuid[]))
      OR (kind = 'power_drift' AND server_id <> ALL($3::uuid[])) OR (kind = 'orphan_vm' AND vm_moref <> ALL($4::text[])))`, [c.id, missing, drifted, orphans]);
    log('info', 'reconcile_done', { connectionId: c.id, vms: vms.length, servers: servers.length });
  }
}
