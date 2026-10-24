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
const permanent = new Set(['INVALID_LOGIN', 'PERMISSION_DENIED', 'WRITE_RESTRICTED', 'PROVISIONING_NOT_SUPPORTED', 'TEMPLATE_NOT_FOUND',
  'NETWORK_NOT_FOUND', 'TEMPLATE_HAS_NO_NIC', 'DISK_SMALLER_THAN_TEMPLATE', 'INSUFFICIENT_RESOURCES', 'NOT_MANAGED', 'TOOLS_NOT_RUNNING',
  'TLS_UNTRUSTED', 'TLS_HOSTNAME_MISMATCH', 'TLS_PIN_MISMATCH', 'ENDPOINT_BLOCKED', 'INVALID_REQUEST', 'SECRET_KEY_UNAVAILABLE', 'INVALID_STATE', 'VM_NOT_FOUND']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readinessPollMs = Number(process.env.READINESS_POLL_MS) || 5000;

let key;
function decrypt(blob, context) {
  key ??= Buffer.from(readFileSync(process.env.MASTER_KEY_FILE ?? '/run/secrets/master_key', 'utf8').trim(), 'base64');
  const raw = Buffer.from(blob.replace(/^v1:/, ''), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(context));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}

async function adapter(path, body) {
  let token;
  try { token = readFileSync(process.env.VMWARE_SERVICE_TOKEN_FILE ?? '/run/secrets/vmware_token', 'utf8').trim(); }
  catch { throw new OperationError('VMWARE_SERVICE_UNAVAILABLE', 'service token missing'); }
  let res;
  try {
    res = await fetch(`${process.env.VMWARE_SERVICE_URL ?? 'http://vmware:8080'}${path}`, {
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
  const { rows: [s] } = await db.query(`SELECT s.*, p.connection_id, p.datastore_morefs, p.network_moref, p.compute_moref, i.template_moref,
      host(a.address) AS address, masklen(ip.cidr) AS prefix, host(ip.gateway) AS gateway, ARRAY(SELECT host(x) FROM unnest(ip.dns) x) AS dns
    FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN os_images i ON i.id = s.image_id
    LEFT JOIN ip_allocations a ON a.server_id = s.id LEFT JOIN ip_pools ip ON ip.id = a.ip_pool_id WHERE s.id = $1`, [op.server_id]);
  const { rows: [c] } = await db.query('SELECT * FROM vmware_connections WHERE id = $1', [s.connection_id]);
  const target = { host: c.host, port: c.port, username: c.username, password: decrypt(c.password_enc, c.id), ...(c.api_version && { apiVersion: c.api_version }),
    tls: { mode: c.tls_mode, ...(c.tls_ca_pem && { caPem: c.tls_ca_pem }), ...(c.tls_sha256 && { sha256: c.tls_sha256 }) } };
  return { op, s, target, vmName: `lvm-${s.id}`, customization: c.customization ?? 'auto', compat: c.compat };
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

// cloud-init (JSON is valid YAML): the allocated static address and the customer's SSH keys.
function cloudInit(s) {
  const metadata = JSON.stringify({ 'instance-id': s.id, 'local-hostname': s.name, network: { version: 2, ethernets: { nic0: {
    match: { name: 'e*' }, addresses: [`${s.address}/${s.prefix}`], routes: [{ to: 'default', via: s.gateway }], nameservers: { addresses: s.dns } } } } });
  const userdata = '#cloud-config\n' + JSON.stringify({ hostname: s.name, ssh_authorized_keys: s.ssh_public_keys, ssh_pwauth: false });
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
    const out = await adapter('/v1/vm/clone', { ...ctx.target, name: ctx.vmName, serverId: s.id, template: s.template_moref, pool, datastore,
      network: s.network_moref, vcpu: s.vcpu, memoryMb: s.memory_mb, diskGb: s.disk_gb, customization, ...cloudInit(s) });
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
async function destroy(db, ctx) {
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
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ip_allocations WHERE server_id = $1', [ctx.s.id]);
    await client.query("UPDATE servers SET state = 'deleted', deleted_at = now(), power_state = 'unknown', updated_at = now() WHERE id = $1", [ctx.s.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

const kinds = {
  async create(db, ctx) {
    ctx.s.vm_moref = await ensureVM(db, ctx);
    await guard(db, ctx.op);
    await setStep(db, ctx.op, 'power_on');
    const st = await find(ctx);
    if (st?.powerState !== 'poweredOn') await power(db, ctx, 'on');
    await waitReady(db, ctx);
    await db.query("UPDATE servers SET state = 'ready', guest_ready = true, error_code = NULL, updated_at = now() WHERE id = $1", [ctx.s.id]);
  },
  delete: (db, ctx) => destroy(db, ctx),
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
};

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
export async function processOperation(db, job, log, notify = async () => {}) {
  // Loading can fail too (database, key file); log it instead of failing silently.
  const ctx = await load(db, job.id).catch((e) => { log('error', 'operation_load_failed', { operationId: job.id, error: e.code ?? e.message }); throw e; });
  if (!ctx || ['succeeded', 'failed', 'cancelled'].includes(ctx.op.status)) return; // already settled
  await db.query("UPDATE operations SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1, updated_at = now() WHERE id = $1", [ctx.op.id]);
  try {
    await guard(db, ctx.op);
    await kinds[ctx.op.kind](db, ctx);
    await db.query("UPDATE operations SET status = 'succeeded', step = 'done', finished_at = now(), error_code = NULL, updated_at = now() WHERE id = $1", [ctx.op.id]);
    log('info', 'operation_succeeded', { kind: ctx.op.kind, operationId: ctx.op.id });
    const d = { serverId: ctx.s.id, name: ctx.s.name, kind: ctx.op.kind };
    if (ctx.op.kind === 'create') await notify('server.ready', [ctx.s.owner_id], { ...d, address: ctx.s.address ?? '' });
    else if (ctx.op.kind === 'delete') await notify('server.deleted', [ctx.s.owner_id], d);
    else await notify('server.power', [ctx.s.owner_id], d);
  } catch (err) {
    const code = err.code ?? 'INTERNAL_ERROR';
    const last = err.permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    log(last ? 'error' : 'warn', 'operation_failed', { kind: ctx.op.kind, operationId: ctx.op.id, code, final: last });
    if (!last) {
      await db.query("UPDATE operations SET status = 'pending', error_code = $2, updated_at = now() WHERE id = $1", [ctx.op.id, code]);
      throw err; // BullMQ retries with exponential backoff
    }
    let status = 'failed';
    if (code === 'CANCELLED' && ctx.op.kind === 'create') status = (await rollbackCreate(db, ctx)) ? 'cancelled' : 'failed';
    await db.query("UPDATE operations SET status = $2, error_code = $3, error_detail = $4, finished_at = now(), updated_at = now() WHERE id = $1",
      [ctx.op.id, status, code, String(err.detail ?? '').slice(0, 500)]);
    if (ctx.op.kind === 'create' && status === 'failed') await db.query("UPDATE servers SET state = 'error', error_code = $2, updated_at = now() WHERE id = $1 AND state <> 'deleted'", [ctx.s.id, code]);
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
  const { rows: conns } = await db.query("SELECT DISTINCT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE c.kind = 'vcenter'");
  for (const c of conns) {
    const target = { host: c.host, port: c.port, username: c.username, password: decrypt(c.password_enc, c.id), ...(c.api_version && { apiVersion: c.api_version }),
      tls: { mode: c.tls_mode, ...(c.tls_ca_pem && { caPem: c.tls_ca_pem }), ...(c.tls_sha256 && { sha256: c.tls_sha256 }) } };
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
    for (const v of vms) if (!known.has(v.name)) await finding('orphan_vm', null, v.moref, { name: v.name });
    log('info', 'reconcile_done', { connectionId: c.id, vms: vms.length, servers: servers.length });
  }
}
