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
const adapters = { proxmox: () => process.env.PROXMOX_SERVICE_URL ?? 'http://proxmox:8080', xcpng: () => process.env.XCPNG_SERVICE_URL ?? 'http://xcpng:8080' };
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
    const base = adapters[body?.platform]?.() ?? process.env.VMWARE_SERVICE_URL ?? 'http://vmware:8080';
    res = await fetch(`${base}${path}`, {
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
    if (t.state === 'error') throw new OperationError(t.code, t.error, permanent.has(t.code));
    if (t.code === 'TASK_NOT_FOUND') return t; // expired from vCenter: the caller checks the VM itself
    await sleep(2000);
  }
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
  const userdata = '#cloud-config\n' + JSON.stringify({ hostname: s.name, ssh_authorized_keys: s.ssh_public_keys, ssh_pwauth: false,
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
  try {
    if (ctx.op.provider_task_id) await waitTask(db, ctx, ctx.op.provider_task_id);
    else {
      const out = await adapter('/v1/vm/power', { ...ctx.target, vm, action });
      if (out.task) { await saveTask(db, ctx.op, out.task); await waitTask(db, ctx, out.task); }
    }
  } catch (e) {
    // Already in the wanted state (for example after a restart mid-task): that is success.
    const want = { on: 'poweredOn', off: 'poweredOff' }[action];
    if (!(e.code === 'INVALID_STATE' && want && (await find(ctx))?.powerState === want)) throw e;
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
    if (ctx.op.provider_task_id) await waitTask(db, ctx, ctx.op.provider_task_id);
    else {
      const out = await adapter('/v1/vm/destroy', { ...ctx.target, vm });
      if (out.task) { await saveTask(db, ctx.op, out.task); await waitTask(db, ctx, out.task); }
    }
  }
  await setStep(db, ctx.op, 'verify_gone');
  if (await find(ctx)) throw new OperationError('VM_STILL_PRESENT', 'VMware still lists the VM');
  await saveTask(db, ctx.op, null);
  ctx.op.provider_task_id = null;
}

async function destroy(db, ctx) {
  await removeVM(db, ctx);
  // Its backups go too (after the transaction below marks them; a file left behind is only space).
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
    ctx.released = released;
    await client.query('DELETE FROM private_network_members WHERE server_id = $1', [ctx.s.id]);
    ctx.backups = (await client.query("UPDATE backups SET status = 'deleted' WHERE server_id = $1 AND status <> 'deleted' RETURNING datastore_moref, path", [ctx.s.id])).rows;
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
    await waitTask(db, ctx, ctx.op.provider_task_id);
    if (ctx.op.params.host) await db.query('UPDATE vmware_vms SET host_moref = $3 WHERE connection_id = $1 AND moref = $2', [ctx.s.connection_id, ctx.s.vm_moref, ctx.op.params.host]);
  },
  // An extra disk: added beside the system disk; its device key is the new one VMware lists.
  async disk_add(db, ctx) {
    const before = (await adapter('/v1/vm/disks', { ...ctx.target, vm: ctx.s.vm_moref })).disks.map((d) => d.key);
    const known = ctx.op.step === 'disk' && ctx.op.provider_task_id; // a retry waits for the stored task instead
    await vmTask(db, ctx, 'disk', '/v1/vm/disk-add', { sizeGb: ctx.op.params.sizeGb });
    const { rows: taken } = await db.query('SELECT device_key FROM server_disks WHERE server_id = $1 AND device_key IS NOT NULL', [ctx.s.id]);
    const disks = (await adapter('/v1/vm/disks', { ...ctx.target, vm: ctx.s.vm_moref })).disks;
    const fresh = disks.find((d) => !d.system && (known ? true : !before.includes(d.key)) && !taken.some((t) => t.device_key === d.key));
    if (!fresh) throw new OperationError('DISK_NOT_FOUND', 'the new disk is not listed', true);
    await db.query("UPDATE server_disks SET device_key = $2, status = 'ready' WHERE id = $1", [ctx.op.params.diskId, fresh.key]);
  },
  async disk_remove(db, ctx) {
    const { rows: [d] } = await db.query('SELECT * FROM server_disks WHERE id = $1', [ctx.op.params.diskId]);
    if (d) {
      await vmTask(db, ctx, 'disk', '/v1/vm/disk-remove', { key: ctx.op.params.key });
      await db.query('DELETE FROM server_disks WHERE id = $1', [d.id]);
      await db.query('UPDATE servers SET price_monthly = greatest(0, price_monthly - $2), updated_at = now() WHERE id = $1', [ctx.s.id, d.price_monthly]);
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
      if (ctx.op.step !== 'resize') await stopForChange(db, ctx); // a retry during "resize" resumes the stored task instead
      try { await vmTask(db, ctx, 'resize', '/v1/vm/resize', { vcpu: p.vcpu, memoryMb: p.memoryMb, diskGb: p.diskGb }); }
      catch (e) {
        // Refused (snapshots on the disk, ...): the server comes back as it was before failing.
        if (p.powerOn) { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; await power(db, ctx, 'on').catch(() => undefined); }
        throw e;
      }
      await db.query('UPDATE servers SET vcpu = $2, memory_mb = $3, disk_gb = $4, updated_at = now() WHERE id = $1', [ctx.s.id, p.vcpu, p.memoryMb, p.diskGb]);
    }
    if (p.powerOn) { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; await power(db, ctx, 'on'); }
    await refreshPower(db, ctx);
  },
  async power_on(db, ctx) { await power(db, ctx, 'on'); await refreshPower(db, ctx); },
  async shutdown(db, ctx) {
    await power(db, ctx, 'shutdown');
    for (let i = 0; i < 60; i++) { // a guest shutdown has no task; wait until VMware sees it off
      await guard(db, ctx.op);
      if ((await find(ctx))?.powerState === 'poweredOff') break;
      await sleep(5000);
    }
    await refreshPower(db, ctx);
  },
  async power_off(db, ctx) { await power(db, ctx, 'off'); await refreshPower(db, ctx); },
  async reset(db, ctx) { await power(db, ctx, 'reset'); await refreshPower(db, ctx); },
  snapshot_create: (db, ctx) => snapshot(db, ctx, { action: 'create', name: ctx.op.params.name, description: ctx.op.params.description ?? '' }),
  snapshot_delete: (db, ctx) => snapshot(db, ctx, { action: 'remove', snapshot: ctx.op.params.snapshot }),
  // A snapshot without memory comes back powered off: start the VM again if it was running. A retry after the
  // revert finished (step "on") only powers on.
  async snapshot_revert(db, ctx) {
    if (ctx.op.step !== 'on') await snapshot(db, ctx, { action: 'revert', snapshot: ctx.op.params.snapshot });
    if (ctx.op.params.powerOn) { await saveTask(db, ctx.op, null); ctx.op.provider_task_id = null; await power(db, ctx, 'on'); }
    await refreshPower(db, ctx);
  },
};

const snapshot = (db, ctx, body) => vmTask(db, ctx, 'snapshot', '/v1/vm/snapshot', body);

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
async function vmTask(db, ctx, step, path, body) {
  await setStep(db, ctx.op, step);
  if (ctx.op.provider_task_id) { await waitTask(db, ctx, ctx.op.provider_task_id); return; }
  const out = await adapter(path, { ...ctx.target, vm: ctx.s.vm_moref, ...body });
  if (!out.task) return; // nothing left to do (already done)
  await saveTask(db, ctx.op, out.task);
  await waitTask(db, ctx, out.task);
}

async function refreshPower(db, ctx) {
  const st = await find(ctx);
  await db.query('UPDATE servers SET power_state = $2, guest_ready = $3, updated_at = now() WHERE id = $1',
    [ctx.s.id, st?.powerState ?? 'unknown', !!(st && st.powerState === 'poweredOn' && st.toolsRunning && st.ips.includes(ctx.s.address))]);
}

// Cancelling a create removes what it built (VM, reservation, IP) once VMware confirms the VM is gone.
async function rollbackCreate(db, ctx) {
  try { await destroy(db, { ...ctx, op: { ...ctx.op, provider_task_id: null } }); return true; } catch { return false; }
}

// notify(event, to, data): enqueues on the API's notification queue (apps/api/src/notify.ts decides the channels).
// rdns(job): enqueues on the API's reverse-DNS queue (apps/api/src/rdns.ts writes the PTR records).
export async function processOperation(db, job, log, notify = async () => {}, rdns = async () => {}) {
  // Loading can fail too (database, key file); log it instead of failing silently.
  const ctx = await load(db, job.id).catch((e) => { log('error', 'operation_load_failed', { operationId: job.id, error: e.code ?? e.message }); throw e; });
  if (!ctx || ['succeeded', 'failed', 'cancelled'].includes(ctx.op.status)) return; // already settled
  if (ctx.op.step === 'awaiting_payment' && !ctx.op.cancel_requested) return; // billing.ts queues it again once paid
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
    // A restore refused after the server was stopped: it is started again as it was.
    if (ctx.op.kind === 'backup_restore' && status === 'failed' && ctx.op.params.powerOn) await adapter('/v1/vm/power', { ...ctx.target, vm: ctx.s.vm_moref, action: 'on' }).catch(() => undefined);
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
    if (ctx.op.kind === 'resize' && status === 'failed') {
      const f = ctx.op.params.from ?? {};
      await db.query('UPDATE servers SET price_monthly = $2, package_id = $3, updated_at = now() WHERE id = $1', [ctx.s.id, f.priceMonthly ?? ctx.s.price_monthly, f.packageId ?? null]);
      if (ctx.op.params.invoiceId) await db.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'unpaid' AND paid_total = 0", [ctx.op.params.invoiceId]);
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
  const { rows: conns } = await db.query("SELECT DISTINCT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE c.kind IN ('vcenter', 'proxmox', 'xcpng')");
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
      ON CONFLICT (connection_id, kind, COALESCE(server_id::text, vm_moref)) WHERE resolved_at IS NULL DO UPDATE SET last_seen = now(), detail = EXCLUDED.detail`, [c.id, kind, serverId, vm, detail]);
    for (const s of servers) {
      const vm = byName.get(`lvm-${s.id}`);
      seen.add(`lvm-${s.id}`);
      if (!vm) {
        await finding('vm_missing', s.id, null, {});
        await db.query("UPDATE servers SET state = 'missing', power_state = 'unknown', updated_at = now() WHERE id = $1", [s.id]);
        continue;
      }
      await db.query("UPDATE reconciliation_findings SET resolved_at = now() WHERE server_id = $1 AND kind = 'vm_missing' AND resolved_at IS NULL", [s.id]);
      if (s.state === 'missing') await db.query("UPDATE servers SET state = 'ready', updated_at = now() WHERE id = $1", [s.id]);
      if (vm.powerState !== s.power_state) {
        await finding('power_drift', s.id, vm.moref, { recorded: s.power_state, actual: vm.powerState });
        await db.query('UPDATE servers SET power_state = $2, updated_at = now() WHERE id = $1', [s.id, vm.powerState]);
      }
    }
    const { rows: live } = await db.query("SELECT 'lvm-' || id AS name FROM servers WHERE state <> 'deleted'");
    const known = new Set(live.map((r) => r.name));
    // Personal images' templates (lvm-img-…) are the panel's too, not stray VMs.
    for (const v of vms) if (!known.has(v.name) && !v.name.startsWith('lvm-img-')) await finding('orphan_vm', null, v.moref, { name: v.name });
    log('info', 'reconcile_done', { connectionId: c.id, vms: vms.length, servers: servers.length });
  }
}
