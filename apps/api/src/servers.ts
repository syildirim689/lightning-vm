import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { pool, redis } from './db';
import { apiError } from './errors';
import { actedOn, actingFor, audit, SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { can, limitsOf, type Permission } from './permissions';
import { capacityOf, limitsFor, resolveOrder, usageOf } from './catalog';
import { orderNeedsVerifiedAddress } from './address-check';
import { capabilitiesOf, exceededQuota } from './capacity';
import { checkBudget } from './budget';
import { openConsole } from './console';
import { callAdapter, storedTarget } from './vmware';
import { target as snapshotTarget } from './snapshots';
import { limits } from './firewalls';
import { choosePassword, generatePassword, sha512Crypt } from './passwords';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, type ServerSettings } from './settings-store';
import { notify } from './notify';
import { prepareApplication } from './applications';
import { prepareGuestUpdates, reporterOrigin } from './guest-updates';
import { checkVdcRoom, resolveVdcOrder } from './vdc';
import { renderPtr } from './rdns-names';
import { cleanLabels, fingerprint, parseKeyList, sshKeyPattern } from './smart-rules';
import { available, billOrder, billResize, payFromBalance, repriceOpenRenewal, resizeCharge, startHourly } from './billing';
import { heldRefuses, hourlyOf, sumMoney } from './billing-rules';
import { checkCoupon } from './coupons';
import { checkResellerRoom, discounted, resellerOf } from './reseller';
import { clearRestoreHoldNotice, forgetRestoreHold, restoreHold } from './restore-hold';

type Input = Record<string, unknown>;
// BullMQ carries only the operation id (also the job id, so re-adding is harmless);
// PostgreSQL holds the truth and the worker re-enqueues anything a lost job left behind.
const queue = new Queue('operations', { connection: redis });
export const enqueue = (operationId: string) => queue.add('operation', {}, {
  jobId: operationId, attempts: 6, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true,
}).catch(() => undefined); // if Redis is down the worker's recovery scan enqueues it later
const deadlineMinutes = { create: 45, delete: 20, power_on: 10, shutdown: 10, power_off: 10, reset: 10, snapshot_create: 30, snapshot_revert: 30, snapshot_delete: 60, resize: 30, reinstall: 45, backup_create: 360, backup_restore: 360, backup_delete: 30, migrate: 240, disk_add: 30, disk_remove: 30, nic_add: 30, nic_remove: 30, image_create: 240 } as const;
export type Kind = keyof typeof deadlineMinutes;

export function idempotencyKey(header: string | undefined, userId: string) {
  if (!header || !/^[\w-]{8,100}$/.test(header)) throw apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 characters)');
  return `${userId}:${header}`;
}
export const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The same key with the same request returns the first result; with a different request it is refused.
export async function replay(key: string, requestHash: string) {
  const { rows: [op] } = await pool.query('SELECT id, server_id, request_hash, kind, status FROM operations WHERE idempotency_key = $1', [key]);
  if (!op) return null;
  if (op.request_hash !== requestHash) throw apiError(409, 'IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was used for a different request');
  return { serverId: op.server_id, operation: { id: op.id, kind: op.kind, status: op.status }, replayed: true };
}


// Owners see and act on their servers; staff with servers.view_all see all, with servers.manage_all act on all.
// A server id alone gives no access (404 for others).
// The admin's server settings decide what customers may do themselves; staff always may.
// Each action needs the member's permission (their role) and must not be switched off for everyone (Settings → Servers).
const actionPermission: Record<keyof ServerSettings['customer'], Permission> = { power: 'server.power', console: 'server.console', delete: 'server.delete',
  snapshots: 'server.snapshots', iso: 'server.iso', rootPassword: 'server.root_password', resize: 'server.resize', reinstall: 'server.reinstall', backups: 'server.backups' };
// The billing integration (external.ts) acts as the owner for ownership and keys, but for the billing system: the
// customer's role, the customer switches and the account's quota are not its limits (what is sold is decided there).
const forBilling = (req: AuthedRequest) => (req as { externalBilling?: boolean }).externalBilling === true;
export async function customerMay(req: AuthedRequest, action: keyof ServerSettings['customer']) {
  if (can(req.user.permissions, 'servers.manage_all') || forBilling(req)) return;
  if (!can(req.user.permissions, actionPermission[action])) throw apiError(403, 'ACTION_NOT_PERMITTED', 'Your role does not allow this');
  if (!(await getSettings('servers')).customer[action]) throw apiError(403, 'ACTION_DISABLED', 'The administrator turned this off');
}
// A server billed by an outside system (external_source) has no subscription here, so nothing the owner adds to it in the
// panel would be charged by anyone: a bigger shape, an extra disk and a copy are changed or ordered there. Staff and the
// integration itself still may.
export function refuseBilledElsewhere(req: AuthedRequest, server: { external_source?: string | null }) {
  if (!server.external_source || forBilling(req) || can(req.user.permissions, 'servers.manage_all')) return;
  throw apiError(409, 'EXTERNALLY_BILLED', 'This server is managed by your hosting account; change it there');
}
// A copy ordered from this server and not built yet (waiting for payment, queued or cloning) reads this server's disk
// when it is built: until then the server is not handed over, reinstalled or deleted (the worker checks again, CLONE_SOURCE_GONE).
export const copyPending = async (serverId: string, db: typeof pool | PoolClient = pool) =>
  !!(await db.query("SELECT 1 FROM servers WHERE clone_from_server_id = $1 AND vm_moref IS NULL AND state = 'provisioning' LIMIT 1", [serverId])).rowCount;
// A count limit of the user's role (SSH keys, firewalls...): how many more may be added (Infinity: no limit).
export async function roomFor(req: AuthedRequest, limit: 'maxSshKeys' | 'maxFirewalls', countSql: string) {
  const max = limitsOf(req.user.roles.join(','))[limit];
  if (max === undefined) return Infinity;
  const { rows: [r] } = await pool.query(countSql, [req.user.id]);
  return Math.max(0, max - r.n);
}
const allowedFor = async (req: AuthedRequest) => {
  const c = (await getSettings('servers')).customer;
  return can(req.user.permissions, 'servers.manage_all') ? Object.fromEntries(Object.keys(c).map((k) => [k, true]))
    : Object.fromEntries(Object.entries(c).map(([k, on]) => [k, on && can(req.user.permissions, actionPermission[k as keyof typeof c])]));
};

export async function findServer(req: AuthedRequest, id: string, manage = false) {
  const staff = manage ? can(req.user.permissions, 'servers.manage_all') : can(req.user.permissions, 'servers.view_all') || can(req.user.permissions, 'servers.manage_all');
  // A reseller sees and manages their customers' servers too (reseller.ts).
  const { rows: [s] } = await pool.query(`SELECT * FROM servers WHERE id = $1 AND state <> 'deleted' AND (owner_id = $2 OR $3
    OR owner_id IN (SELECT u.id FROM users u JOIN resellers r ON r.user_id = u.reseller_id AND r.active WHERE u.reseller_id = $2))`, [id, req.user.id, staff]);
  if (!s) throw apiError(404, 'NOT_FOUND', 'Unknown server');
  // Reached as the owner's reseller: what this request audits about the server is also in the owner's activity (auth.ts).
  if (s.owner_id !== req.user.id && !staff) actedOn(req, s.id, s.owner_id);
  return s;
}

// Ownership at the moment of the write. findServer reads it once, without a lock; a hand-over (transfers.ts) holds the
// server's row while it moves the server and clears what the previous owner left on it, so a write that names only the
// server id waits for the move and then lands on the new owner's server. Every write a customer route makes on a server
// therefore goes through here: the row is locked and the write runs, on `db` and in that transaction, only while the
// server still belongs to the account findServer answered for; otherwise 404, as for a request sent after the move.
// startOperation makes the same check in its own statement and is called outside of this (on another connection it
// would wait for the lock held here). Staff routes that act across owners (admin/...) do not need it.
export async function ownerWrite<T>(server: { id: string; owner_id: string }, write: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [now] } = await db.query("SELECT owner_id FROM servers WHERE id = $1 AND state <> 'deleted' FOR UPDATE", [server.id]);
    if (now?.owner_id !== server.owner_id) throw apiError(404, 'NOT_FOUND', 'Unknown server');
    const out = await write(db);
    await db.query('COMMIT');
    return out;
  } catch (err) { await db.query('ROLLBACK').catch(() => undefined); throw err; } finally { db.release(); }
}

// The VM a request to an adapter is about: its id, and the managed name it must carry (docs/adapter-contract.md,
// expectName). Proxmox hands a freed VM number out again, so the number alone could name another customer's VM.
export const vmOf = (s: { id: string; vm_moref: string }) => ({ vm: s.vm_moref, expectName: `lvm-${s.id}` });
// An unpaid renewal invoice follows a changed price at once (billing.ts); should that fail, the next billing run does it.
export const repriced = (serverId: string) => repriceOpenRenewal(serverId).then(() => undefined, () => undefined);

// After a restore of an older backup nothing is started until staff release the hold (restore-hold.ts): the rows may
// be older than what the hypervisors hold.
export async function refuseOnRestoreHold() {
  if (await restoreHold()) throw apiError(409, 'RESTORE_HOLD', 'The panel was restored from a backup; nothing is started until an administrator has reviewed it');
}

// A power action started for a VDC's bulk request: one operation per server, its own idempotency key.
export function startPowerOperation(req: AuthedRequest, server: { id: string; owner_id: string }, action: string, key: string) {
  return startOperation(req, server, action as Kind, key, hashOf({ id: server.id, action, bulk: true }));
}

// Starts a ready server's grace period: shut down, deleted by the scheduler when it ends (an existing one is kept).
async function scheduleDeletion(req: AuthedRequest, server: Awaited<ReturnType<typeof findServer>>, key: string, grace: number) {
  const r = await ownerWrite(server, async (db) => (await db.query("UPDATE servers SET delete_at = coalesce(delete_at, now() + make_interval(hours => $2)), updated_at = now() WHERE id = $1 RETURNING delete_at", [server.id, grace])).rows[0]);
  if (server.power_state === 'poweredOn' && !server.delete_at) await startOperation(req, server, 'shutdown', `${key}:shutdown`, hashOf({ id: server.id, action: 'shutdown' })).catch(() => undefined);
  await audit(req, 'server.delete_scheduled', 'success', req.user.id, { serverId: server.id, deleteAt: r.delete_at });
  if (!server.delete_at) await notify('server.delete_scheduled', [server.owner_id], { serverId: server.id, name: server.name, hours: grace });
  return r.delete_at as Date;
}

// Servers whose deletion grace period is over (scheduler tick): deleted now. A server locked meanwhile keeps its lock and
// is not deleted (the wait ends); one busy with an operation is tried again on the next tick.
export async function runDueDeletions() {
  // A reminder 2 hours before the end, once per scheduled deletion; only when the grace period is long enough
  // (6 hours or more) that the first notice is not still fresh.
  if ((await getSettings('servers')).deleteGraceHours >= 6) {
    const { rows: soon } = await pool.query("SELECT id, name, owner_id, delete_at FROM servers WHERE delete_at > now() AND delete_at <= now() + interval '2 hours'");
    for (const s of soon) {
      if (!(await redis.set(`trash:remind:${s.id}:${s.delete_at.getTime()}`, '1', 'EX', 3 * 3600, 'NX'))) continue;
      await notify('server.delete_scheduled', [s.owner_id], { serverId: s.id, name: s.name, reminder: true, minutes: Math.max(1, Math.round((s.delete_at.getTime() - Date.now()) / 60_000)) });
    }
  }
  const { rows } = await pool.query(`SELECT s.* FROM servers s WHERE s.delete_at <= now() AND s.state IN ('ready', 'error')
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) LIMIT 50`);
  const system = { id: 'trash', ip: null, user: { id: null, permissions: [] } } as unknown as AuthedRequest;
  for (const s of rows) {
    if (s.locked) { await pool.query('UPDATE servers SET delete_at = NULL WHERE id = $1', [s.id]); continue; }
    const { rowCount } = await pool.query("UPDATE servers SET state = 'deleting', updated_at = now() WHERE id = $1 AND state = $2 AND delete_at IS NOT NULL", [s.id, s.state]);
    if (!rowCount) continue;
    await startOperation(system, s, 'delete', `trash:${s.id}:${s.delete_at.getTime()}`, hashOf({ id: s.id, delete: true }))
      .then(() => pool.query('UPDATE servers SET delete_at = NULL WHERE id = $1', [s.id]),
        () => pool.query("UPDATE servers SET state = $2 WHERE id = $1 AND state = 'deleting'", [s.id, s.state]));
  }
  return rows.length;
}

// What a lock stops: anything that ends the server or loses its running state or data.
const lockedKinds = new Set<Kind>(['delete', 'power_off', 'reset', 'snapshot_revert', 'reinstall', 'resize', 'backup_restore']);

// Who an operation is recorded as started by (migration 076): the signed-in account; nobody for the billing run, a
// schedule, the deletion grace period and the billing integration, whose operations a customer may not cancel.
const startedBy = (req: AuthedRequest) => ((req as { billing?: boolean }).billing || forBilling(req) ? null : req.user?.id ?? null);
// Whose share of the worker's slots the operation counts against (operations.capped_for; the worker lets one account
// run only so many at once): whoever started it (the owner, a reseller for a customer), the server's owner for a
// schedule. Staff, the billing run and the billing integration are not capped (null), so they never wait behind a customer.
// capFor: a reseller ordering for a customer (reseller.ts), where the request carries the customer as its user.
export const cappedFor = (req: AuthedRequest, ownerId: string) => ((req as { billing?: boolean }).billing || forBilling(req) || can(req.user?.permissions ?? [], 'servers.manage_all') ? null
  : (req as { capFor?: string }).capFor ?? req.user?.id ?? ownerId);
// An operation somebody other than the owner or staff started on the server (the owner's reseller, findServer): the
// audit event says for whom, so it is also in the owner's own activity (audit-log.ts).
const actedFor = (req: AuthedRequest, ownerId: string) => (req.user?.id && req.user.id !== ownerId && !can(req.user.permissions ?? [], 'servers.manage_all') && !forBilling(req) ? actingFor(ownerId, 'reseller') : {});

// prepare: what must be in place before the worker can pick the operation up (an invoice, tracking rows); it runs after
// the operation exists and before it is queued. If it fails, the operation ends there and never runs.
export async function startOperation(req: AuthedRequest, server: { id: string; owner_id: string }, kind: Kind, key: string, requestHash: string, params: object = {},
  prepare?: (op: { id: string }) => Promise<void>) {
  await refuseOnRestoreHold();
  // Read here, for every caller (the server page, bulk actions, schedules, data centers).
  if (lockedKinds.has(kind) && (await pool.query('SELECT 1 FROM servers WHERE id = $1 AND locked', [server.id])).rowCount) {
    throw apiError(409, 'SERVER_LOCKED', 'The server is locked against this; unlock it first');
  }
  // Held for an unpaid invoice: it may be shut down or deleted, nothing else until it is paid, whoever asks (the owner, a
  // reseller, a schedule's pseudo-request). Staff still may; billing's own run puts the hold on and takes it off.
  if (heldRefuses(kind, { staff: can(req.user?.permissions ?? [], 'servers.manage_all'), billing: (req as { billing?: boolean }).billing === true })
    && (await pool.query('SELECT 1 FROM servers WHERE id = $1 AND billing_hold', [server.id])).rowCount) {
    throw apiError(409, 'BILLING_HOLD', 'The server is held until the unpaid invoice is paid');
  }
  // The role's operations per hour, for a member acting on their own servers (staff and schedules are not counted).
  if (req.user?.id === server.owner_id && !can(req.user.permissions, 'servers.manage_all') && !forBilling(req)) {
    const perHour = limitsOf(req.user.roles.join(',')).operationsPerHour;
    if (perHour !== undefined) {
      const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM operations WHERE owner_id = $1 AND created_at > now() - interval '1 hour'", [req.user.id]);
      if (n.n >= perHour) throw apiError(429, 'OPERATION_RATE_LIMITED', 'Too many operations this hour');
    }
  }
  try {
    // Only while the server is still the owner's the caller read (ownerWrite says why): the locking read waits for a
    // hand-over in progress and then sees the new owner, and an operation accepted first keeps the hand-over out (busy).
    const { rows: [op] } = await pool.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, params, started_by, capped_for)
      SELECT $1, 'pending', $2, $3, s.id, s.owner_id, 'queued', now() + make_interval(mins => $6), $7, $8, $9 FROM servers s WHERE s.id = $4 AND s.owner_id = $5 FOR SHARE OF s
      RETURNING id, kind, status`, [kind, key, requestHash, server.id, server.owner_id, deadlineMinutes[kind], params, startedBy(req), cappedFor(req, server.owner_id)]);
    if (!op) throw apiError(404, 'NOT_FOUND', 'Unknown server');
    if (prepare) {
      await prepare(op).catch(async (err) => {
        await pool.query("UPDATE operations SET status = 'cancelled', error_code = 'CANCELLED', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending'", [op.id]);
        throw err;
      });
    }
    await enqueue(op.id);
    await audit(req, `server.${kind}`, 'success', req.user.id, { serverId: server.id, operationId: op.id, ...params, ...actedFor(req, server.owner_id) });
    return op;
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'operations_one_open_per_server') throw apiError(409, 'OPERATION_IN_PROGRESS', 'Another operation is still running on this server');
    throw err;
  }
}

// A resize's target: priced like an order in the server's own location (with its extra IPv4 and application), the disk
// never smaller, and the increase within the owner's quota and the location's free capacity.
async function resizeTarget(req: AuthedRequest, server: Record<string, any>, body: Input) {
  if (server.vdc_id) throw apiError(409, 'VDC_SERVER', 'Change the virtual data center instead');
  const order = await resolveOrder(server.pool_id, { type: body?.type, packageId: body?.packageId, vcpu: body?.vcpu, memoryMb: body?.memoryMb, diskGb: body?.diskGb,
    extraIpv4: server.extra_ipv4, imageId: server.image_id, ...(server.application_id && { applicationId: server.application_id }) },
    can(req.user.permissions, 'servers.manage_all') || forBilling(req) ? undefined : limitsOf(req.user.roles.join(',')).allowedLocations);
  const { shape } = order;
  if (shape.diskGb < server.disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'A disk can only grow', { diskGb: 'DISK_SHRINK_NOT_SUPPORTED' });
  if (shape.vcpu === server.vcpu && shape.memoryMb === server.memory_mb && shape.diskGb === server.disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Nothing changes', { type: 'NO_CHANGE' });
  const { rows: [img] } = await pool.query('SELECT family FROM os_images WHERE id = $1', [server.image_id]);
  if (img?.family === 'esxi' && (shape.vcpu < 2 || shape.memoryMb < 4096)) throw apiError(400, 'VALIDATION_FAILED', 'ESXi needs 2 vCPU and 4 GB', { type: 'ESXI_NEEDS_MORE' });
  const more = { vcpu: Math.max(0, shape.vcpu - server.vcpu), memoryMb: Math.max(0, shape.memoryMb - server.memory_mb), diskGb: Math.max(0, shape.diskGb - server.disk_gb) };
  // The billing system's own change of package is not held to the account's quota (as its order is not).
  const over = forBilling(req) ? [] : exceededQuota({ ...(await limitsFor(server.owner_id, server.project_id ?? undefined)), max_servers: null }, await usageOf(server.owner_id, server.project_id ?? undefined), more);
  if (over.length) throw apiError(409, 'QUOTA_EXCEEDED', 'Quota exceeded', Object.fromEntries(over.map((o) => [o, 'QUOTA_EXCEEDED'])));
  const cap = await capacityOf(order.rp);
  if (more.vcpu > cap.available.vcpu || more.memoryMb > cap.available.memoryMb || more.diskGb > cap.available.storageGb) throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough capacity in this location');
  const reseller = await resellerOf(server.owner_id);
  if (reseller) {
    order.price = { ...order.price, monthly: discounted(order.price.monthly, reseller.discountPct) };
    await checkResellerRoom(reseller, { servers: 0, ...more });
  }
  // Extra disks stay through a resize: their prices (already in the server's current price) are added to the new shape's.
  const { rows: disks } = await pool.query('SELECT price_monthly::text AS price FROM server_disks WHERE server_id = $1', [server.id]);
  if (disks.length) order.price = { ...order.price, monthly: sumMoney(order.price.monthly, disks.map((d) => d.price)) };
  return { order, billTo: reseller?.id ?? server.owner_id, charge: await resizeCharge(server.id, server.price_monthly, order.price.monthly) };
}

const serverColumns = `s.id, s.name, s.state, s.power_state AS "powerState", s.guest_ready AS "guestReady", s.vcpu, s.memory_mb AS "memoryMb", s.disk_gb AS "diskGb",
  s.price_monthly::text AS "priceMonthly", s.currency, s.traffic_gb AS "trafficGb", s.billing_mode AS "billingMode", s.price_hourly::text AS "priceHourly", s.traffic_throttled AS "trafficThrottled",
  (SELECT COALESCE(sum(t.rx_bytes + t.tx_bytes), 0)::float8 FROM server_traffic t WHERE t.server_id = s.id AND t.day >= date_trunc('month', current_date)) AS "trafficBytes", s.error_code AS "errorCode", s.created_at AS "createdAt", s.project_id AS "projectId",
  s.tags, s.notes, s.locked, s.billing_hold AS "billingHold", s.delete_at AS "deleteAt", s.pool_id AS "poolId", s.image_id AS "imageId", s.package_id AS "packageId", s.vdc_id AS "vdcId",
  p.name AS "poolName", p.location, l.city AS "locationCity", l.country_code AS "locationCountry", l.datacenter AS "locationDatacenter", i.name AS "imageName", host(a.address) AS address,
  CASE WHEN s.firewall_applied_version >= s.firewall_version THEN 'applied' WHEN s.firewall_error IS NOT NULL THEN 'failed' ELSE 'pending' END AS "firewallStatus",
  s.firewall_error AS "firewallError", s.root_password_enc IS NOT NULL AS "hasRootPassword",
  (SELECT name FROM applications ap WHERE ap.id = s.application_id) AS "applicationName", s.app_state AS "appState", s.app_message AS "appMessage", (SELECT count(*)::int FROM firewall_servers fs WHERE fs.server_id = s.id) AS "firewallCount",
  (SELECT row_to_json(o) FROM (SELECT id, kind, status, step, error_code AS "errorCode", created_at AS "createdAt" FROM operations
    WHERE server_id = s.id ORDER BY created_at DESC LIMIT 1) o) AS "lastOperation",
  (SELECT json_build_object('kind', c.kind, 'operations', c.operations) FROM vmware_connections c WHERE c.id = p.connection_id) AS platform`;
// What the server's platform can do (capacity.ts), instead of the connection's own details.
// platform: the connection's kind (vcenter, proxmox, ...).
const withCapabilities = <T extends Record<string, any>>({ platform, ...row }: T) => ({ ...row, platform: (platform?.kind ?? null) as string | null, capabilities: capabilitiesOf(platform?.kind ?? '', platform?.operations) }); // eslint-disable-line @typescript-eslint/no-explicit-any
const serverJoins = "FROM servers s JOIN resource_pools p ON p.id = s.pool_id LEFT JOIN locations l ON l.id = p.location_id JOIN os_images i ON i.id = s.image_id LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary'";

type VmDetails = { nics: Record<string, unknown>[]; disks: Record<string, unknown>[]; cdroms: { iso: string }[]; placement: unknown; annotation: string } & Record<string, unknown>;

@Controller() @UseGuards(SessionGuard)
export class ServersController {
  @Get('ssh-keys')
  async keys(@Req() req: AuthedRequest) {
    const { rows } = await pool.query('SELECT id, name, fingerprint, created_at AS "createdAt" FROM ssh_keys WHERE owner_id = $1 ORDER BY name', [req.user.id]);
    return { keys: rows };
  }

  @Post('ssh-keys') @HttpCode(201)
  async addKey(@Req() req: AuthedRequest, @Body() body: Input) {
    const name = typeof body.name === 'string' && body.name.trim() && body.name.length <= 100 ? body.name.trim() : null;
    const key = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
    const m = sshKeyPattern.exec(key);
    const fields: Record<string, string> = {};
    if (!name) fields.name = 'INVALID_VALUE';
    if (!m) fields.publicKey = 'INVALID_SSH_KEY';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    if (!(await roomFor(req, 'maxSshKeys', 'SELECT count(*)::int AS n FROM ssh_keys WHERE owner_id = $1'))) throw apiError(409, 'LIMIT_REACHED', 'Your role allows no more SSH keys', { publicKey: 'LIMIT_REACHED' });
    const { rows: [k] } = await pool.query('INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id, fingerprint',
      [req.user.id, name, key, fingerprint(m![3])]);
    if (!k) throw apiError(409, 'VALIDATION_FAILED', 'Key exists', { publicKey: 'KEY_EXISTS' });
    return k;
  }

  // Imports the public keys a GitHub user published (github.com/<user>.keys); keys already here are skipped.
  @Post('ssh-keys/github') @HttpCode(201)
  async importGithub(@Req() req: AuthedRequest, @Body() body: Input) {
    const user = typeof body?.username === 'string' ? body.username.trim().replace(/^@/, '') : '';
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { username: 'INVALID_GITHUB_USER' });
    const res = await fetch(`https://github.com/${user}.keys`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (res?.status === 404) throw apiError(400, 'VALIDATION_FAILED', 'Unknown user', { username: 'GITHUB_USER_NOT_FOUND' });
    if (!res?.ok) throw apiError(502, 'GITHUB_UNREACHABLE', 'GitHub did not answer');
    const keys = parseKeyList((await res.text()).slice(0, 65_536));
    if (!keys.length) throw apiError(400, 'VALIDATION_FAILED', 'No keys', { username: 'GITHUB_NO_KEYS' });
    const room = await roomFor(req, 'maxSshKeys', 'SELECT count(*)::int AS n FROM ssh_keys WHERE owner_id = $1');
    if (!room) throw apiError(409, 'LIMIT_REACHED', 'Your role allows no more SSH keys', { username: 'LIMIT_REACHED' });
    let added = 0;
    for (const [i, k] of keys.entries()) {
      if (added >= room) break;
      const r = await pool.query('INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [req.user.id, keys.length > 1 ? `github:${user} #${i + 1}` : `github:${user}`, k.publicKey, k.fingerprint]);
      added += r.rowCount ?? 0;
    }
    return { added, skipped: keys.length - added };
  }

  @Delete('ssh-keys/:id') @HttpCode(204)
  async deleteKey(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query('DELETE FROM ssh_keys WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown key');
  }

  // Saved console commands: the person's own, typed into a console or the admin terminal from the panel.
  @Get('console-snippets')
  async snippets(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT id, name, command, shared, owner_id = $1 AS mine FROM console_snippets
      WHERE owner_id = $1 OR shared ORDER BY shared DESC, name, created_at`, [req.user.id]);
    return { snippets: rows };
  }

  @Post('console-snippets') @HttpCode(201)
  async addSnippet(@Req() req: AuthedRequest, @Body() body: Input) {
    const { name, command, shared } = snippetInput(req, body);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM console_snippets WHERE owner_id = $1', [req.user.id]);
    if (n >= 50) throw apiError(409, 'LIMIT_REACHED', 'At most 50 saved commands', { command: 'LIMIT_REACHED' });
    const { rows: [r] } = await pool.query('INSERT INTO console_snippets (owner_id, name, command, shared) VALUES ($1, $2, $3, $4) RETURNING id, name, command, shared, true AS mine',
      [req.user.id, name, command, shared]);
    if (shared) await audit(req, 'console.snippet_shared', 'success', req.user.id, { id: r.id, name });
    return r;
  }

  // Same rules as saving; a shared command (or sharing one) needs settings.manage.
  @Put('console-snippets/:id')
  async updateSnippet(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const { name, command, shared } = snippetInput(req, body);
    // The self-join reads the row before the update: only newly sharing a command is audited.
    const { rows: [r] } = await pool.query(`UPDATE console_snippets c SET name = $3, command = $4, shared = $5 FROM console_snippets old
      WHERE c.id = $1 AND old.id = c.id AND (c.owner_id = $2 OR (c.shared AND $6)) RETURNING c.id, c.name, c.command, c.shared, c.owner_id = $2 AS mine, old.shared AS was`,
      [id, req.user.id, name, command, shared, can(req.user.permissions, 'settings.manage')]);
    if (!r) throw apiError(404, 'NOT_FOUND', 'Unknown command');
    const { was, ...snippet } = r;
    if (shared && !was) await audit(req, 'console.snippet_shared', 'success', req.user.id, { id, name });
    return snippet;
  }

  @Delete('console-snippets/:id') @HttpCode(204)
  async deleteSnippet(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    // Shared commands: whoever may share may also remove them.
    const { rowCount } = await pool.query('DELETE FROM console_snippets WHERE id = $1 AND (owner_id = $2 OR (shared AND $3))',
      [id, req.user.id, can(req.user.permissions, 'settings.manage')]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown command');
  }

  @Get('servers')
  async list(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${serverColumns}, EXISTS (SELECT 1 FROM server_favorites f WHERE f.user_id = $1 AND f.server_id = s.id) AS favorite
      ${serverJoins} WHERE s.state <> 'deleted' AND s.owner_id = $1 ORDER BY s.created_at DESC`, [req.user.id]);
    return { servers: rows.map(withCapabilities) };
  }

  // Background work for the task manager: what is running now and what finished in the last 15 minutes.
  // scope=all (staff with servers.view_all) shows everyone's.
  @Get('operations/active')
  async active(@Req() req: AuthedRequest, @Query('scope') scope?: string) {
    const all = scope === 'all' && can(req.user.permissions, 'servers.view_all');
    const { rows } = await pool.query(`SELECT o.id, o.kind, o.status, o.step, o.attempts, o.error_code AS "errorCode", o.created_at AS "createdAt",
        o.started_at AS "startedAt", o.finished_at AS "finishedAt", s.id AS "serverId", s.name AS "serverName"
      FROM operations o JOIN servers s ON s.id = o.server_id
      WHERE (o.status IN ('pending', 'running') OR o.finished_at > now() - interval '15 minutes') AND ($2 OR o.owner_id = $1)
      ORDER BY (o.status IN ('pending', 'running')) DESC, o.created_at DESC LIMIT 20`, [req.user.id, all]);
    return { operations: rows };
  }

  // Live performance from vCenter/ESXi (20-second samples, about the last 15 minutes), cached briefly
  // so several open tabs do not each query VMware.
  @Get('servers/:id/metrics')
  async metrics(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    if (!s.vm_moref || s.state !== 'ready') throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not ready');
    const cached = await redis.get(`metrics:${id}`).catch(() => null);
    if (cached) return JSON.parse(cached);
    const { rows: [c] } = await pool.query('SELECT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [s.pool_id]);
    const out = await callAdapter<{ interval: number; samples: { t: string; cpu: number | null; mem: number | null; net: number | null; disk: number | null }[];
      quick: Record<string, number> }>('/v1/vm/metrics', { ...storedTarget(c), ...vmOf(s) }, 30_000);
    const body = { ...out, vcpu: s.vcpu, memoryMb: s.memory_mb, fetchedAt: new Date().toISOString() };
    await redis.set(`metrics:${id}`, JSON.stringify(body), 'EX', 15).catch(() => undefined);
    return body;
  }

  // Every detail VMware has on the VM: hardware and allocation, NICs (MAC, adapter, distributed port, guest
  // addresses), disks (size, provisioning, controller slot), CD drives, VMware Tools, the guest's own network
  // view and, for staff, where it runs. Customers do not see infrastructure names (host, cluster, datastores,
  // switches, port groups, VLANs, file paths). Cached 20 seconds.
  @Get('servers/:id/details')
  async details(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    if (!s.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'The server has no VM yet');
    const staff = can(req.user.permissions, 'servers.view_all');
    let raw = await redis.get(`vm-details:${id}`).catch(() => null);
    if (!raw) {
      const { rows: [c] } = await pool.query('SELECT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [s.pool_id]);
      if (!c) throw apiError(409, 'INVALID_SERVER_STATE', 'The server has no VMware connection');
      const out = await callAdapter<Record<string, unknown>>('/v1/vm/details', { ...storedTarget(c), ...vmOf(s) }, 30_000);
      raw = JSON.stringify({ ...out, fetchedAt: new Date().toISOString() });
      await redis.set(`vm-details:${id}`, raw, 'EX', 20).catch(() => undefined);
    }
    const d = JSON.parse(raw) as VmDetails;
    if (staff) return { ...d, staff: true };
    return {
      ...d, staff: false, placement: null, annotation: '',
      nics: d.nics.map((n) => ({ ...n, network: '', switch: '', portgroupKey: '', vlan: null })),
      disks: d.disks.map((x) => ({ ...x, datastore: '', file: '' })),
      cdroms: d.cdroms.map((x) => ({ ...x, iso: x.iso ? x.iso.replace(/^\[[^\]]*\]\s*/, '').split('/').pop() ?? '' : '' })),
    };
  }

  // Network traffic: the last 31 days (bytes in and out per day), this month's total and the monthly allowance.
  @Get('servers/:id/traffic')
  async traffic(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const { rows: days } = await pool.query(`SELECT d::date::text AS day, COALESCE(t.rx_bytes, 0)::float8 AS rx, COALESCE(t.tx_bytes, 0)::float8 AS tx
      FROM generate_series(current_date - 30, current_date, interval '1 day') d LEFT JOIN server_traffic t ON t.server_id = $1 AND t.day = d::date ORDER BY d`, [id]);
    const { rows: [m] } = await pool.query(`SELECT COALESCE(sum(rx_bytes), 0)::float8 AS rx, COALESCE(sum(tx_bytes), 0)::float8 AS tx FROM server_traffic
      WHERE server_id = $1 AND day >= date_trunc('month', current_date)`, [id]);
    return { days, month: m, allowanceGb: s.traffic_gb, countedAt: s.traffic_counted_at };
  }

  @Get('servers/:id')
  async detail(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const found = await findServer(req, id);
    const own = found.owner_id === req.user.id;
    const [{ rows: [server] }, { rows: operations }] = await Promise.all([
      pool.query(`SELECT ${serverColumns} ${serverJoins} WHERE s.id = $1`, [id]),
      pool.query(`SELECT id, kind, status, step, attempts, error_code AS "errorCode", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
        FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    // Billed by an outside system: its size changes there (refuseBilledElsewhere), so the page does not offer it.
    const allowed = await allowedFor(req);
    if (found.external_source && !can(req.user.permissions, 'servers.manage_all')) allowed.resize = false;
    return { server: withCapabilities(server), operations, own, allowed, deleteGraceHours: (await getSettings('servers')).deleteGraceHours };
  }

  @Post('servers') @HttpCode(202) @Can('servers.create')
  async create(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Body() body: Input) {
    // Billed by an outside system (external.ts): its order is not the customer's own, so neither the role's permission
    // nor the account's quota decides it, and it gets no subscription, invoice or hourly usage here.
    const external = forBilling(req);
    if (!external && !can(req.user.permissions, 'servers.create')) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf(body);
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    await refuseOnRestoreHold();
    // An account that belongs to an outside billing system orders there: with the panel's billing off nobody would bill
    // a server ordered here. (With it on, the panel invoices the order like anyone's.)
    if (!external && !(await getSettings('billing')).enabled && (await pool.query('SELECT 1 FROM users WHERE id = $1 AND external_source IS NOT NULL', [req.user.id])).rowCount) {
      throw apiError(409, 'EXTERNALLY_BILLED', 'Servers of this account are ordered through your hosting account');
    }

    // Settings → Sign-in security: an unverified address does not order. Asked of whoever places the order: the
    // reseller for a customer's server (capFor), never the outside billing system.
    if (!external && await orderNeedsVerifiedAddress((req as { capFor?: string }).capFor ?? req.user.id)) {
      throw apiError(403, 'EMAIL_NOT_VERIFIED', 'Verify the e-mail address of this account before ordering a server');
    }

    const fields: Record<string, string> = {};
    const name = typeof body.name === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(body.name) ? body.name : (fields.name = 'INVALID_HOSTNAME', '');
    if (!body.imageId) fields.imageId = 'REQUIRED';
    const sshKeyIds = Array.isArray(body.sshKeyIds) ? body.sshKeyIds.map(String) : [];
    if (!sshKeyIds.length) fields.sshKeyIds = 'REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const projectId = body.projectId ? String(body.projectId) : null;
    if (projectId && !(await pool.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2', [projectId, req.user.id]).catch(() => ({ rowCount: 0 }))).rowCount) {
      throw apiError(404, 'NOT_FOUND', 'Unknown project');
    }
    // Inside a virtual data center the shape is free within its allocation, with no price of its own.
    const vdc = body.vdcId ? await resolveVdcOrder(req.user.id, body) : null;
    const order = vdc ? vdc.order : await resolveOrder(String(body.poolId ?? ''), body, external ? undefined : limitsOf(req.user.roles.join(',')).allowedLocations);
    const { rows: keys } = await pool.query('SELECT public_key FROM ssh_keys WHERE owner_id = $1 AND id = ANY($2::uuid[])', [req.user.id, sshKeyIds]).catch(() => ({ rows: [] }));
    // Optional root password (console/RDP): a weak one is replaced by a strong one that starts with the brand.
    if (body.rootPassword !== undefined && (typeof body.rootPassword !== 'string' || body.rootPassword.length > 128)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { rootPassword: 'INVALID_VALUE' });
    const branding = await getSettings('branding');
    const { rows: [img] } = await pool.query('SELECT family, cloud_init FROM os_images WHERE id = $1', [order.imageId]).catch(() => ({ rows: [] }));
    // Nested ESXi: at least 2 vCPU and 4 GB, and always a root password (it is the host's login; generated when none is given).
    if (img?.family === 'esxi' && (order.shape.vcpu < 2 || order.shape.memoryMb < 4096)) throw apiError(400, 'VALIDATION_FAILED', 'ESXi needs 2 vCPU and 4 GB', { imageId: 'ESXI_NEEDS_MORE' });
    const prefix = branding.passwordPrefix || branding.name;
    const root = choosePassword((body.rootPassword as string | undefined) || undefined, prefix, [name, req.user.email.split('@')[0]])
      ?? (img?.family === 'esxi' ? { password: generatePassword(prefix), replaced: true } : null);
    if (keys.length !== sshKeyIds.length) throw apiError(400, 'VALIDATION_FAILED', 'Unknown key', { sshKeyIds: 'NOT_AVAILABLE' });
    // Firewalls chosen at order time are applied before the VM is first powered on.
    const firewallIds = Array.isArray(body.firewallIds) ? [...new Set(body.firewallIds.map(String))] : [];
    if (firewallIds.length > limits.firewallsPerServer) throw apiError(400, 'VALIDATION_FAILED', 'Too many firewalls', { firewallIds: 'FIREWALL_LIMIT' });
    if (firewallIds.length && (await pool.query('SELECT 1 FROM firewalls WHERE owner_id = $1 AND id = ANY($2::uuid[])', [req.user.id, firewallIds]).catch(() => ({ rowCount: 0 }))).rowCount !== firewallIds.length) {
      throw apiError(400, 'VALIDATION_FAILED', 'Unknown firewall', { firewallIds: 'NOT_AVAILABLE' });
    }
    // A copy of one of the user's servers: same location and image, the disk at least as big, cloned from its VM.
    let cloneFrom: { id: string; moref: string } | null = null;
    if (body.cloneFrom) {
      const { rows: [src] } = await pool.query(`SELECT s.id, s.vm_moref, s.pool_id, s.image_id, s.disk_gb, s.external_source, i.family FROM servers s JOIN os_images i ON i.id = s.image_id
        WHERE s.id = $1 AND s.owner_id = $2 AND s.state = 'ready' AND s.vm_moref IS NOT NULL AND s.vdc_id IS NULL`, [String(body.cloneFrom), req.user.id]).catch(() => ({ rows: [] }));
      if (!src || src.family === 'esxi') throw apiError(400, 'VALIDATION_FAILED', 'Cannot clone', { cloneFrom: 'NOT_AVAILABLE' });
      refuseBilledElsewhere(req, src); // a copy of a server sold elsewhere is ordered there too
      if (src.pool_id !== order.rp.id || src.image_id !== order.imageId) throw apiError(400, 'VALIDATION_FAILED', 'A copy stays in its location and image', { cloneFrom: 'CLONE_MISMATCH' });
      if (order.shape.diskGb < src.disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Disk smaller than the original', { diskGb: 'BELOW_SOURCE_DISK' });
      if (order.application) throw apiError(400, 'VALIDATION_FAILED', 'No application on a copy', { applicationId: 'NOT_WITH_CLONE' });
      cloneFrom = { id: src.id, moref: src.vm_moref };
    }
    // Pay as you go: offered when the admin allows it; the balance must cover the first hours (Settings → Billing).
    let hourly: string | null = null;
    // A reseller's customer (or the reseller): the reseller's price, billed to the reseller, within their allocation.
    const reseller = vdc ? null : await resellerOf(req.user.id);
    if (reseller) {
      order.price = { ...order.price, monthly: discounted(order.price.monthly, reseller.discountPct) };
      if (body.billingCycle === 'hourly') throw apiError(400, 'VALIDATION_FAILED', 'Hourly billing is not offered', { billingCycle: 'NOT_AVAILABLE' });
    }
    if (body.billingCycle === 'hourly' && !external) {
      const bs = await getSettings('billing');
      if (vdc || !bs.enabled || !bs.hourly || !bs.balance) throw apiError(400, 'VALIDATION_FAILED', 'Hourly billing is not offered', { billingCycle: 'NOT_AVAILABLE' });
      const { rows: [p] } = order.packageId ? await pool.query('SELECT price_hourly::text AS h FROM packages WHERE id = $1', [order.packageId]) : { rows: [] };
      hourly = p?.h && Number(p.h) > 0 && !order.extraIpv4 && !order.application ? p.h : hourlyOf(order.price.monthly);
      if (await available(pool, req.user.id, order.price.currency) < Number(hourly) * bs.hourlyMinHours) {
        throw apiError(409, 'BALANCE_TOO_LOW', 'Top up your balance first', { billingCycle: 'BALANCE_TOO_LOW' });
      }
    }
    // A coupon applies to a monthly server the customer pays here (not a reseller's, an hourly one or a data center's).
    const couponCode = typeof body.coupon === 'string' && body.coupon.trim() ? body.coupon : null;
    if (couponCode && (vdc || reseller || hourly || external || !(await getSettings('billing')).enabled)) throw apiError(400, 'VALIDATION_FAILED', 'No coupon here', { coupon: 'COUPON_NOT_AVAILABLE' });
    if (couponCode) await checkCoupon(pool, couponCode, req.user.id, { packageId: order.packageId, monthly: order.price.monthly, currency: order.price.currency });
    // A personal image is its owner's alone, and must be on this location's vCenter.
    if (order.imageId && !(await pool.query('SELECT 1 FROM os_images WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2) AND connection_id = $3', [order.imageId, req.user.id, order.rp.connection_id])).rowCount) {
      throw apiError(400, 'VALIDATION_FAILED', 'Unknown image', { imageId: 'NOT_AVAILABLE' });
    }
    const { rows: [conn] } = await pool.query('SELECT kind, operations FROM vmware_connections WHERE id = $1', [order.rp.connection_id]);
    if (!['vcenter', 'proxmox', 'xcpng', 'ovirt', 'hyperv', 'libvirt', 'incus'].includes(conn.kind) || !conn.operations?.cloneFromImage) throw apiError(409, 'PROVISIONING_NOT_SUPPORTED', 'This location cannot create servers (needs vCenter with clone rights)');
    if (firewallIds.length && !conn.operations?.firewall) throw apiError(409, 'FIREWALL_NOT_SUPPORTED', 'This location cannot enforce firewalls (needs vCenter with a distributed switch)');

    // Short transaction, no external calls: quota, capacity and IP are checked and taken under row
    // locks (owner, then pool), so concurrent requests can never take the same address or capacity twice.
    const client = await pool.connect();
    let result: { serverId: string; operation: { id: string; kind: string; status: string }; passwordReplaced?: boolean; invoiceId?: string; awaitingPayment?: boolean };
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      await client.query('SELECT 1 FROM resource_pools WHERE id = $1 FOR UPDATE', [order.rp.id]);
      const again = await client.query('SELECT 1 FROM operations WHERE idempotency_key = $1', [key]);
      if (again.rowCount) { await client.query('ROLLBACK'); return (await replay(key, requestHash))!; }
      if (vdc) await checkVdcRoom(client, vdc.vdcId, order.shape); // reserved in the pool already; the VDC's own limits apply
      else {
        const over = external ? [] : exceededQuota(await limitsFor(req.user.id, projectId ?? undefined, client), await usageOf(req.user.id, projectId ?? undefined, client), order.shape);
        if (over.length) throw apiError(409, 'QUOTA_EXCEEDED', 'Quota exceeded', Object.fromEntries(over.map((o) => [o, 'QUOTA_EXCEEDED'])));
        const cap = await capacityOf(order.rp, client);
        if (order.shape.vcpu > cap.available.vcpu || order.shape.memoryMb > cap.available.memoryMb || order.shape.diskGb > cap.available.storageGb) {
          throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough capacity in this location');
        }
      }
      if (reseller) await checkResellerRoom(reseller, { servers: 1, ...order.shape }, client);
      const coupon = couponCode ? await checkCoupon(client, couponCode, req.user.id, { packageId: order.packageId, monthly: order.price.monthly, currency: order.price.currency }, true) : null;
      // The primary and any extra IPv4 come from one IP pool (one subnet and gateway in the guest), skipping
      // excluded, gateway, used and quarantined addresses; the first pool (by name) with enough room wins.
      const wanted = 1 + order.extraIpv4;
      const { rows: ips } = await client.query(`WITH free AS (
          SELECT i.id, i.name, i.range_start + g AS a, g FROM ip_pools i, generate_series(0::bigint, i.range_end - i.range_start) g
          WHERE i.pool_id = $1 AND (i.range_start + g) <> ALL(i.excluded) AND (i.range_start + g) <> i.gateway
            AND NOT EXISTS (SELECT 1 FROM ip_allocations a WHERE a.address = i.range_start + g)
            AND NOT EXISTS (SELECT 1 FROM ip_quarantine q WHERE q.address = i.range_start + g AND q.available_at > now())),
        roomy AS (SELECT id, name FROM free GROUP BY id, name HAVING count(*) >= $2 ORDER BY name LIMIT 1)
        SELECT f.id AS ip_pool_id, host(f.a) AS address FROM free f JOIN roomy r ON r.id = f.id ORDER BY f.g LIMIT $2`, [order.rp.id, wanted]);
      if (ips.length < wanted) throw apiError(409, 'IP_EXHAUSTED', 'No free IP address in this location');
      const { rows: [s] } = await client.query(`INSERT INTO servers (owner_id, project_id, pool_id, image_id, package_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, ssh_public_keys, extra_ipv4, root_password_hash, root_password_enc)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'provisioning', $12, $13, $14, $15) RETURNING id`,
        [req.user.id, projectId, order.rp.id, order.imageId, order.packageId, name, order.shape.vcpu, order.shape.memoryMb, order.shape.diskGb, order.price.monthly, order.price.currency, keys.map((k) => k.public_key), order.extraIpv4,
          root ? sha512Crypt(root.password) : null, root ? encryptSecret(root.password, 'server-root-password') : null]);
      for (const [i, ip] of ips.entries()) {
        await client.query('INSERT INTO ip_allocations (ip_pool_id, address, server_id, kind) VALUES ($1, $2, $3, $4)', [ip.ip_pool_id, ip.address, s.id, i === 0 ? 'primary' : 'extra']);
      }
      // One IPv6 address when that IP pool has a prefix: the lowest free host from ::10 up.
      const { rows: [v6] } = await client.query(`SELECT host(host(network(i.ipv6_prefix))::inet + g) AS address FROM ip_pools i, generate_series(16::bigint, 65535) g
        WHERE i.id = $1 AND i.ipv6_prefix IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ip_allocations a WHERE a.address = host(network(i.ipv6_prefix))::inet + g)
          AND NOT EXISTS (SELECT 1 FROM ip_quarantine q WHERE q.address = host(network(i.ipv6_prefix))::inet + g AND q.available_at > now())
        ORDER BY g LIMIT 1`, [ips[0].ip_pool_id]);
      if (v6) await client.query("INSERT INTO ip_allocations (ip_pool_id, address, server_id, kind) VALUES ($1, $2, $3, 'ipv6')", [ips[0].ip_pool_id, v6.address, s.id]);
      // An application to install: its licence is taken here, so two orders can never get the same key. The guest
      // reports back to the address the customer ordered through (the panel's public origin).
      if (order.application) {
        const rdns = await getSettings('rdns');
        const hostname = (rdns.template ? renderPtr(rdns.template, ips[0].address, name) : `${name}.localdomain.`).replace(/\.$/, '');
        const origin = typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : `${req.protocol}://${req.headers.host}`;
        await prepareApplication(client, order.application, s.id, { hostname, ip: ips[0].address }, `${origin}/api/servers/${s.id}/app-callback`);
      }
      // A Linux server installs the update reporter on its first boot (Settings → Servers); it only tells its owner
      // about waiting updates until they choose otherwise, and can be turned off on the server's page.
      if (img?.family === 'linux' && img.cloud_init && (await getSettings('servers')).guestUpdates !== false) await prepareGuestUpdates(client, s.id, await reporterOrigin(req));
      // The source server with the VM id it had at the order: the worker builds the copy only from that server, still this owner's and on that VM.
      if (cloneFrom) await client.query('UPDATE servers SET clone_from_moref = $2, clone_from_server_id = $3 WHERE id = $1', [s.id, cloneFrom.moref, cloneFrom.id]);
      if (vdc) await client.query('UPDATE servers SET vdc_id = $2 WHERE id = $1', [s.id, vdc.vdcId]);
      else if (order.trafficGb) await client.query('UPDATE servers SET traffic_gb = $2 WHERE id = $1', [s.id, order.trafficGb]);
      if (firewallIds.length) {
        await client.query('INSERT INTO firewall_servers (firewall_id, server_id) SELECT unnest($1::uuid[]), $2', [firewallIds, s.id]);
        await client.query('UPDATE servers SET firewall_version = 1 WHERE id = $1', [s.id]);
      }
      // Billing on: the subscription and first invoice (a data center's servers are paid with the data center).
      if (hourly) await startHourly(client, { serverId: s.id, ownerId: req.user.id, hourly, currency: order.price.currency });
      if (coupon) await client.query('INSERT INTO coupon_redemptions (coupon_id, user_id, server_id, once) VALUES ($1, $2, $3, $4)', [coupon.id, req.user.id, s.id, coupon.once]);
      const bill = vdc || hourly || external ? null : await billOrder(client, { ownerId: reseller?.id ?? req.user.id, serverId: s.id, name, monthly: order.price.monthly, currency: order.price.currency, coupon });
      const { rows: [op] } = await client.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, started_by, capped_for)
        VALUES ('create', 'pending', $1, $2, $3, $4, $6, now() + make_interval(mins => $5), $7, $8) RETURNING id, kind, status`,
        [key, requestHash, s.id, req.user.id, deadlineMinutes.create, bill?.awaitingPayment ? 'awaiting_payment' : 'queued', startedBy(req), cappedFor(req, req.user.id)]);
      await client.query('COMMIT');
      result = { serverId: s.id, operation: op, ...(root && { passwordReplaced: root.replaced }), ...(bill && { invoiceId: bill.invoiceId, awaitingPayment: bill.awaitingPayment }) };
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { constraint?: string }).constraint === 'servers_owner_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' });
      if ((err as { constraint?: string }).constraint === 'ip_allocations_pkey') throw apiError(409, 'IP_EXHAUSTED', 'Address taken concurrently; retry');
      throw err;
    } finally {
      client.release();
    }
    // Waiting for payment: a balance that covers it pays at once (the payment queues the build); otherwise the invoice waits.
    if (result.awaitingPayment) {
      if ((await getSettings('billing')).balance && await payFromBalance(result.invoiceId!, true, req.user.id)) result.awaitingPayment = false;
    } else await enqueue(result.operation.id);
    await audit(req, 'server.create', 'success', req.user.id, { serverId: result.serverId, operationId: result.operation.id, ...(result.invoiceId && { invoiceId: result.invoiceId }) });
    await checkBudget(req.user.id).catch(() => undefined);
    return result;
  }

  // The root password chosen (or generated) at order time; every look is audited. Forgetting deletes the panel's copy.
  @Get('servers/:id/root-password')
  async rootPassword(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'rootPassword');
    if (!s.root_password_enc) throw apiError(404, 'NOT_FOUND', 'No stored password');
    await audit(req, 'server.root_password_viewed', 'success', req.user.id, { serverId: id });
    return { password: decryptSecret(s.root_password_enc, 'server-root-password') };
  }

  // Lock or unlock (the owner, or staff who may manage all servers).
  // A new name in the panel (and in the default reverse DNS made from it; a PTR set by hand stays). The guest's own
  // hostname is the customer's to change inside the server.
  @Put('servers/:id/name')
  async rename(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const s = await findServer(req, id, true);
    const name = typeof body?.name === 'string' ? body.name.trim().toLowerCase() : '';
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { name: 'INVALID_HOSTNAME' });
    if (name === s.name) return { name };
    try { await ownerWrite(s, (db) => db.query('UPDATE servers SET name = $2, updated_at = now() WHERE id = $1', [id, name])); }
    catch (err) {
      if ((err as { constraint?: string }).constraint === 'servers_owner_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' });
      throw err;
    }
    const rdns = await getSettings('rdns');
    if (rdns.provider !== 'none' && rdns.template) {
      const { rows } = await pool.query('SELECT host(address) AS address, ptr FROM ip_allocations WHERE server_id = $1 AND ptr IS NOT NULL', [id]);
      const stale = rows.filter((r) => r.ptr === renderPtr(rdns.template, r.address, s.name)).map((r) => r.address);
      if (stale.length) {
        await pool.query('UPDATE ip_allocations SET ptr = NULL WHERE server_id = $1 AND host(address) = ANY($2)', [id, stale]);
        await (await import('./rdns')).rdnsQueue.add('rdns', { action: 'default', serverId: id }, { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true });
      }
    }
    await audit(req, 'server.renamed', 'success', req.user.id, { serverId: id, from: s.name, to: name });
    return { name };
  }

  @Put('servers/:id/lock')
  async lock(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    if (typeof body?.locked !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { locked: 'INVALID_VALUE' });
    const s = await findServer(req, id, true);
    await ownerWrite(s, (db) => db.query('UPDATE servers SET locked = $2, updated_at = now() WHERE id = $1', [id, body.locked]));
    await audit(req, body.locked ? 'server.locked' : 'server.unlocked', 'success', req.user.id, { serverId: id });
    return { locked: body.locked };
  }

  @Delete('servers/:id/root-password') @HttpCode(204) @Can('server.root_password')
  async forgetRootPassword(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    await ownerWrite(s, (db) => db.query('UPDATE servers SET root_password_enc = NULL, updated_at = now() WHERE id = $1', [id]));
    await audit(req, 'server.root_password_forgotten', 'success', req.user.id, { serverId: id });
  }

  @Post('servers/:id/actions') @HttpCode(202) @Can('server.power')
  async action(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf({ id, ...body });
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    const kind = body.action as Kind;
    if (!['power_on', 'shutdown', 'power_off', 'reset'].includes(kind)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const server = await findServer(req, id, true);
    await customerMay(req, 'power');
    // A failed create may have left no VM to act on.
    if ((server.state !== 'ready' && server.state !== 'error') || !server.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    return { serverId: id, operation: await startOperation(req, server, kind, key, requestHash) };
  }

  // What a resize to this shape would cost, before anything changes (the order page's price, for the same pool and extras).
  @Post('servers/:id/resize/quote') @Can('server.resize')
  async resizeQuote(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const server = await findServer(req, id, true);
    refuseBilledElsewhere(req, server);
    await customerMay(req, 'resize');
    const r = await resizeTarget(req, server, body);
    return { shape: r.order.shape, priceMonthly: r.order.price.monthly, currency: r.order.price.currency, ...r.charge };
  }

  // New vCPU, memory and disk size (a package of this location, or a custom shape). The disk only grows. The new monthly price
  // applies from now: an increase is invoiced for the rest of the period, a decrease simply bills less from the next one.
  @Post('servers/:id/resize') @HttpCode(202) @Can('server.resize')
  async resize(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf({ id, resize: body });
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    const server = await findServer(req, id, true);
    refuseBilledElsewhere(req, server);
    await customerMay(req, 'resize');
    if (server.state !== 'ready' || !server.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    const r = await resizeTarget(req, server, body);
    const { shape, price } = r.order;
    // vSphere cannot grow a disk under snapshots: refused here, before the server is stopped for nothing.
    if (shape.diskGb > server.disk_gb) {
      const { snapshots } = await callAdapter<{ snapshots: unknown[] }>('/v1/vm/snapshots', { ...(await snapshotTarget(server.pool_id)), ...vmOf(server) }, 30_000);
      if (snapshots.length) throw apiError(409, 'DISK_HAS_SNAPSHOTS', 'Remove the snapshots before growing the disk');
    }
    // The price follows the shape (renewals read it), written by the request whose operation exists and by no other: in
    // the step that runs once the operation is accepted and before it is queued (a resize that fails at once must find
    // the new price and its invoice there to undo, not have them written over its undoing). A request that is refused
    // (another operation is open) changes nothing; it used to write the price first and then put back the price it had
    // read, over the accepted request's. The write also holds only while the row is the one this request priced from. A
    // resize that finally fails puts the price back (worker, from `from`; a retry applies `to` again).
    const priceHourly = server.billing_mode === 'hourly' ? hourlyOf(price.monthly) : server.price_hourly;
    const setPrice = (v: { priceMonthly: unknown; packageId: unknown; trafficGb: unknown; priceHourly: unknown }) => pool.query(
      'UPDATE servers SET price_monthly = $2, package_id = $3, traffic_gb = $4, price_hourly = $5, updated_at = now() WHERE id = $1', [id, v.priceMonthly, v.packageId, v.trafficGb, v.priceHourly]);
    const from = { vcpu: server.vcpu, memoryMb: server.memory_mb, diskGb: server.disk_gb, priceMonthly: server.price_monthly, packageId: server.package_id, trafficGb: server.traffic_gb, priceHourly: server.price_hourly };
    const to = { priceMonthly: price.monthly, packageId: r.order.packageId, trafficGb: r.order.trafficGb, priceHourly, billTo: r.billTo, currency: price.currency };
    let invoiceId = null as string | null;
    const operation = await startOperation(req, server, 'resize', key, requestHash,
      { vcpu: shape.vcpu, memoryMb: shape.memoryMb, diskGb: shape.diskGb, powerOn: server.power_state === 'poweredOn', from, to }, async (op) => {
        const { rowCount } = await pool.query(`UPDATE servers SET price_monthly = $2, package_id = $3, traffic_gb = $4, price_hourly = $5, updated_at = now()
          WHERE id = $1 AND price_monthly = $6 AND package_id IS NOT DISTINCT FROM $7::uuid AND vcpu = $8 AND memory_mb = $9 AND disk_gb = $10`,
          [id, to.priceMonthly, to.packageId, to.trafficGb, to.priceHourly, from.priceMonthly, from.packageId, from.vcpu, from.memoryMb, from.diskGb]);
        if (!rowCount) throw apiError(409, 'OPERATION_IN_PROGRESS', 'The server changed meanwhile; ask again');
        // The invoice could not be made, or not noted on the operation (a resize that fails later withdraws it by that
        // id): the operation ends here (startOperation), with the price this request found and without the invoice.
        try {
          invoiceId = r.charge.chargeNow !== '0.00' ? await billResize({ ...server, owner_id: r.billTo }, r.charge.chargeNow, price.currency, shape) : null;
          if (invoiceId) await pool.query("UPDATE operations SET params = params || jsonb_build_object('invoiceId', $2::text) WHERE id = $1", [op.id, invoiceId]);
        } catch (err) {
          await setPrice(from);
          if (invoiceId) await pool.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'unpaid' AND paid_total = 0", [invoiceId]).catch(() => undefined);
          await repriced(id);
          throw err;
        }
        await repriced(id);
      });
    return { serverId: id, operation, ...(invoiceId && { invoiceId }) };
  }

  // A fresh install from another (or the same) image: the disk is wiped; addresses, firewalls and the price stay.
  // Dangerous: the caller repeats the server's name.
  @Post('servers/:id/reinstall') @HttpCode(202) @Can('server.reinstall')
  async reinstall(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf({ id, reinstall: body });
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    const server = await findServer(req, id, true);
    await customerMay(req, 'reinstall');
    if (body?.confirm !== server.name) throw apiError(400, 'VALIDATION_FAILED', 'Confirmation required', { confirm: 'CONFIRMATION_MISMATCH' });
    if (!['ready', 'error'].includes(server.state) || !server.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    if (server.locked) throw apiError(409, 'SERVER_LOCKED', 'The server is locked against this; unlock it first');
    // A new VM is built from the image: extra disks would be left behind, so they go first (by the customer).
    if ((await pool.query('SELECT 1 FROM server_disks WHERE server_id = $1', [id])).rowCount) throw apiError(409, 'REMOVE_EXTRA_DISKS', 'Remove the extra disks before reinstalling');
    if ((await pool.query('SELECT 1 FROM private_network_members WHERE server_id = $1', [id])).rowCount) throw apiError(409, 'LEAVE_PRIVATE_NETWORKS', 'Take the server off its private networks before reinstalling');
    if (await copyPending(id)) throw apiError(409, 'CLONE_PENDING', 'A copy of this server is still being built; wait for it or cancel it first');
    const { rows: [img] } = await pool.query(`SELECT i.family, i.cloud_init, i.min_disk_gb FROM os_images i JOIN resource_pools p ON p.connection_id = i.connection_id
      WHERE i.id = $1 AND i.active AND p.id = $2 AND (i.owner_id IS NULL OR i.owner_id = $4) AND (NOT EXISTS (SELECT 1 FROM package_images pi WHERE pi.package_id = $3)
        OR EXISTS (SELECT 1 FROM package_images pi WHERE pi.package_id = $3 AND pi.image_id = i.id))`, [String(body.imageId ?? ''), server.pool_id, server.package_id, server.owner_id]).catch(() => ({ rows: [] }));
    if (!img) throw apiError(400, 'VALIDATION_FAILED', 'Unknown image', { imageId: 'NOT_AVAILABLE' });
    if (server.disk_gb < img.min_disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Disk too small', { imageId: 'BELOW_IMAGE_MINIMUM' });
    if (img.family === 'esxi' && (server.vcpu < 2 || server.memory_mb < 4096)) throw apiError(400, 'VALIDATION_FAILED', 'ESXi needs 2 vCPU and 4 GB', { imageId: 'ESXI_NEEDS_MORE' });
    // New SSH keys and root password when given; otherwise the server's current ones go onto the new disk. A server
    // without stored keys or password (handed over: transfers.ts clears the previous owner's) gets a new password rather
    // than a disk nobody can sign in to.
    let keys: string[] = server.ssh_public_keys;
    if (Array.isArray(body.sshKeyIds) && body.sshKeyIds.length) {
      const ids = body.sshKeyIds.map(String);
      const { rows } = await pool.query('SELECT public_key FROM ssh_keys WHERE owner_id = $1 AND id = ANY($2::uuid[])', [server.owner_id, ids]).catch(() => ({ rows: [] }));
      if (rows.length !== ids.length) throw apiError(400, 'VALIDATION_FAILED', 'Unknown key', { sshKeyIds: 'NOT_AVAILABLE' });
      keys = rows.map((k) => k.public_key);
    }
    if (body.rootPassword !== undefined && (typeof body.rootPassword !== 'string' || body.rootPassword.length > 128)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { rootPassword: 'INVALID_VALUE' });
    const branding = await getSettings('branding');
    const prefix = branding.passwordPrefix || branding.name;
    const root = choosePassword((body.rootPassword as string | undefined) || undefined, prefix, [server.name, req.user.email.split('@')[0]])
      ?? ((img.family === 'esxi' && !server.root_password_enc) || (!keys.length && !server.root_password_hash) ? { password: generatePassword(prefix), replaced: true } : null);
    // Keys and password first (the worker reads them when it builds); the image is set by the worker once the old VM is gone.
    // Only on a server that is still this owner's (ownerWrite): the keys are the requester's.
    await ownerWrite(server, async (db) => {
      if ((await db.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id])).rowCount) throw apiError(409, 'OPERATION_IN_PROGRESS', 'Another operation is still running on this server');
      await db.query(`UPDATE servers SET ssh_public_keys = $2, root_password_hash = COALESCE($3, root_password_hash), root_password_enc = COALESCE($4, root_password_enc), updated_at = now() WHERE id = $1`,
        [id, keys, root ? sha512Crypt(root.password) : null, root ? encryptSecret(root.password, 'server-root-password') : null]);
      // The state too, before the operation is queued: a reinstall that fails at once sets "error", and that must not be written over.
      await db.query("UPDATE servers SET state = 'provisioning', error_code = NULL, updated_at = now() WHERE id = $1 AND state <> 'deleted'", [id]);
    });
    const operation = await startOperation(req, server, 'reinstall', key, requestHash, { imageId: String(body.imageId), fromImageId: server.image_id }, async () => {
      // Update tracking follows the server onto its new disk: the reporter is installed again on a Linux image; on another, tracking ends.
      if ((await pool.query('SELECT 1 FROM server_updates WHERE server_id = $1', [id])).rowCount) {
        if (img.family === 'linux' && img.cloud_init) await prepareGuestUpdates(pool, id, await reporterOrigin(req));
        else await pool.query('DELETE FROM server_updates WHERE server_id = $1', [id]);
      }
    }).catch(async (err) => {
      // Refused (a billing hold, the role's hourly limit, another operation): the server is as it was, with the keys and password it really has.
      await pool.query(`UPDATE servers SET state = $2, error_code = $3, ssh_public_keys = $4, root_password_hash = $5, root_password_enc = $6 WHERE id = $1 AND state = 'provisioning'`,
        [id, server.state, server.error_code, server.ssh_public_keys, server.root_password_hash, server.root_password_enc]);
      throw err;
    });
    return { serverId: id, operation, ...(root && { passwordReplaced: root.replaced }) };
  }

  // Dangerous: the caller must repeat the server's name. Resources are released only after the
  // worker has confirmed in VMware that the VM is gone.
  @Delete('servers/:id') @HttpCode(202) @Can('server.delete')
  async remove(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf({ id, delete: true });
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    const server = await findServer(req, id, true);
    await customerMay(req, 'delete');
    if (body?.confirm !== server.name) throw apiError(400, 'VALIDATION_FAILED', 'Confirmation required', { confirm: 'CONFIRMATION_MISMATCH' });
    if (server.state === 'deleting') throw apiError(409, 'OPERATION_IN_PROGRESS', 'Already being deleted');
    // Before anything changes (startOperation checks again for every other path).
    if (server.locked) throw apiError(409, 'SERVER_LOCKED', 'The server is locked against this; unlock it first');
    if (await copyPending(id)) throw apiError(409, 'CLONE_PENDING', 'A copy of this server is still being built; wait for it or cancel it first');
    // A running create is cancelled first; the delete then removes whatever it left.
    // (These two touch only a server that is still being built, which cannot change owner; no ownerWrite.)
    await pool.query("UPDATE operations SET cancel_requested = true WHERE server_id = $1 AND status IN ('pending', 'running') AND kind = 'create'", [id]);
    // A build still waiting for its first payment never started: it ends here (its unpaid invoice is withdrawn with the server).
    await pool.query("UPDATE operations SET status = 'cancelled', error_code = 'CANCELLED', finished_at = now(), updated_at = now() WHERE server_id = $1 AND kind = 'create' AND status = 'pending' AND step = 'awaiting_payment'", [id]);
    const { rows: [open] } = await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id]);
    if (open) throw apiError(409, 'OPERATION_IN_PROGRESS', 'Wait for the running operation to stop, then delete again');
    // A ready server waits out the grace period shut down (the scheduler deletes it then); `now` skips the wait.
    const grace = (await getSettings('servers')).deleteGraceHours;
    if (grace > 0 && server.state === 'ready' && body?.now !== true) return { serverId: id, deleteAt: await scheduleDeletion(req, server, key, grace) };
    await ownerWrite(server, (db) => db.query("UPDATE servers SET state = 'deleting', delete_at = NULL, updated_at = now() WHERE id = $1", [id]));
    // Refused (another operation got in between, the role's hourly limit): the server is as it was, not left "deleting" with nothing deleting it.
    const operation = await startOperation(req, server, 'delete', key, requestHash).catch(async (err) => {
      await pool.query("UPDATE servers SET state = $2, delete_at = $3, updated_at = now() WHERE id = $1 AND state = 'deleting'", [id, server.state, server.delete_at]);
      throw err;
    });
    return { serverId: id, operation };
  }

  // Takes back a server waiting to be deleted (it stays shut down; the owner starts it again).
  @Delete('servers/:id/deletion') @Can('server.delete')
  async restore(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'delete');
    const { rowCount } = await ownerWrite(s, (db) => db.query("UPDATE servers SET delete_at = NULL, updated_at = now() WHERE id = $1 AND delete_at IS NOT NULL AND state <> 'deleting'", [id]));
    if (!rowCount) throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not waiting to be deleted');
    await audit(req, 'server.delete_cancelled', 'success', req.user.id, { serverId: id });
    return { restored: true };
  }

  // One power action on several of the caller's servers (the list's selection). Each goes through the same checks as
  // the server page; ones the caller may not act on, busy or unsuitable are skipped and counted.
  @Post('servers/actions') @HttpCode(202) @Can('server.power', 'server.delete')
  async bulk(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Body() body: Input) {
    const action = String(body?.action ?? '');
    if (!['power_on', 'shutdown', 'power_off', 'reset', 'delete', 'restore', 'tag', 'untag'].includes(action)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const ids = Array.isArray(body?.serverIds) ? [...new Set(body.serverIds.map(String))] : [];
    if (!ids.length || ids.length > 100 || ids.some((x) => !/^[0-9a-f-]{36}$/.test(x))) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { serverIds: 'INVALID_VALUE' });
    const tag = bulkTag(action, body);
    const trash = action === 'delete' || action === 'restore';
    // Tags need no member permission, as on the server page.
    if (!tag) await customerMay(req, trash ? 'delete' : 'power');
    // Deleting several at once only ever starts the grace period, so a slip can be taken back.
    const grace = (await getSettings('servers')).deleteGraceHours;
    if (action === 'delete' && grace <= 0) throw apiError(403, 'ACTION_DISABLED', 'Deleting several servers at once needs a deletion grace period');
    const base = idempotencyKey(header, req.user.id);
    let started = 0;
    for (const id of ids) {
      const s = await findServer(req, id, true).catch(() => null);
      if (!s) continue;
      if (tag) { if (await retag(s, action, tag)) started++; continue; }
      if (trash) {
        const busy = !!(await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id])).rowCount;
        if (await bulkTrash(req, { ...s, busy }, action, `${base}:${id}`, grace)) started++;
        continue;
      }
      if (!['ready', 'error'].includes(s.state) || !s.vm_moref || s.delete_at) continue;
      await startPowerOperation(req, s, action, `${base}:${id}`).then(() => started++, () => undefined);
    }
    await audit(req, 'server.bulk_action', 'success', req.user.id, { action, started, skipped: ids.length - started });
    return { started, skipped: ids.length - started };
  }

  @Post('servers/:id/operations/:op/cancel') @HttpCode(202)
  async cancel(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('op', ParseUUIDPipe) op: string) {
    await findServer(req, id, true);
    // A customer cancels what they started themselves (not what staff, billing, a schedule or the billing integration
    // started), and only where cancelling undoes cleanly: a build (the worker removes what it made, after a running clone
    // ends) or an operation the worker has not picked up yet. Anything else has, or may have, a task at the hypervisor;
    // ending it early would undo its price while the change still lands. Staff may ask for any; the worker then waits
    // for an issued task's real outcome and only stops what would come after it.
    // (No ownerWrite: a server with an open operation is not handed over, and one the requester started stays theirs to cancel.)
    const staff = can(req.user.permissions, 'servers.manage_all');
    const { rowCount } = await pool.query(`UPDATE operations SET cancel_requested = true, updated_at = now() WHERE id = $1 AND server_id = $2 AND status IN ('pending', 'running')
      AND ($3 OR (started_by = $4 AND (kind = 'create' OR (status = 'pending' AND step IN ('queued', 'awaiting_payment') AND attempts = 0 AND provider_task_id IS NULL))))`, [op, id, staff, req.user.id]);
    if (!rowCount) throw apiError(409, 'INVALID_SERVER_STATE', 'Nothing to cancel');
    await audit(req, 'server.cancel', 'success', req.user.id, { serverId: id, operationId: op });
    return { cancelRequested: true };
  }

  // The customer's own server only (admins: any). Ownership is checked here, not by knowing the id.
  @Post('servers/:id/console') @HttpCode(201) @Can('server.console')
  async console(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param('id', ParseUUIDPipe) id: string) {
    // Taken before ownership is read: a hand-over (or sign-out, ban...) from this moment on revokes the ticket (console.ts).
    const asked = Date.now();
    const s = await findServer(req, id, true);
    await customerMay(req, 'console');
    if (!s.vm_moref || s.state !== 'ready') throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not ready');
    if (s.billing_hold && s.owner_id === req.user.id) throw apiError(409, 'BILLING_HOLD', 'The server is held until the unpaid invoice is paid');
    const { rows: [p] } = await pool.query('SELECT connection_id FROM resource_pools WHERE id = $1', [s.pool_id]);
    return openConsole(req, reply, p.connection_id, s.vm_moref, true, { asked, expectName: `lvm-${s.id}` });
  }
}

// A saved console command as sent: CRLF to LF, no trailing space; the name defaults to the first line.
function snippetInput(req: AuthedRequest, body: Input) {
  const command = typeof body?.command === 'string' ? body.command.replace(/\r\n?/g, '\n').replace(/\s+$/, '') : '';
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : command.split('\n')[0].trim().slice(0, 60);
  const fields: Record<string, string> = {};
  if (!command.trim() || command.length > 2000) fields.command = 'INVALID_VALUE';
  if (!name || name.length > 60) fields.name = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const shared = body.shared === true;
  if (shared && !can(req.user.permissions, 'settings.manage')) throw apiError(403, 'FORBIDDEN', 'Permission required');
  return { name, command, shared };
}

// Bulk delete (only starts the grace period: ready, unlocked, idle servers) or restore; false when the server was skipped.
async function bulkTrash(req: AuthedRequest, s: Awaited<ReturnType<typeof findServer>>, action: string, key: string, grace: number): Promise<boolean> {
  if (action === 'restore') {
    const { rowCount } = await ownerWrite(s, (db) => db.query("UPDATE servers SET delete_at = NULL, updated_at = now() WHERE id = $1 AND delete_at IS NOT NULL AND state <> 'deleting'", [s.id]));
    if (rowCount) await audit(req, 'server.delete_cancelled', 'success', req.user.id, { serverId: s.id });
    return !!rowCount;
  }
  if (s.state !== 'ready' || s.locked || s.delete_at || s.busy) return false;
  return scheduleDeletion(req, s, key, grace).then(() => true, () => false);
}

// The one tag a bulk tag/untag carries, checked like the server page's labels (null for other actions).
function bulkTag(action: string, body: Input): string | null {
  if (action !== 'tag' && action !== 'untag') return null;
  const v = cleanLabels({ tags: [body?.tag ?? ''] });
  if ('fields' in v || v.tags.length !== 1) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { tag: 'INVALID_TAG' });
  return v.tags[0];
}

// Adds or removes one tag (case-insensitively); false when nothing changed or the server already has 10 tags.
async function retag(s: { id: string; owner_id: string; tags: string[] | null }, action: string, tag: string): Promise<boolean> {
  const has = (x: string) => x.toLocaleLowerCase('tr') === tag.toLocaleLowerCase('tr');
  const now = s.tags ?? [];
  const next = action === 'tag' ? (now.some(has) || now.length >= 10 ? now : [...now, tag]) : now.filter((x) => !has(x));
  if (next.length === now.length) return false;
  return ownerWrite(s, (db) => db.query('UPDATE servers SET tags = $2, updated_at = now() WHERE id = $1', [s.id, next])).then(() => true, () => false);
}

@Controller('admin') @UseGuards(PermissionGuard)
export class ServersAdminController {
  @Get('servers') @Can('servers.view_all', 'dashboard.view')
  async all(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${serverColumns}, u.email AS "ownerEmail", EXISTS (SELECT 1 FROM server_favorites f WHERE f.user_id = $1 AND f.server_id = s.id) AS favorite
      ${serverJoins} JOIN users u ON u.id = s.owner_id WHERE s.state <> 'deleted' ORDER BY s.created_at DESC`, [req.user.id]).then((r) => ({ rows: r.rows.map(withCapabilities) }));
    return { servers: rows };
  }

  @Get('operations') @Can('servers.view_all', 'dashboard.view')
  async operations() {
    const { rows } = await pool.query(`SELECT o.id, o.kind, o.status, o.step, o.attempts, o.error_code AS "errorCode", o.error_detail AS "errorDetail",
      COALESCE(o.params->'warnings', '[]'::jsonb) AS "warnings", o.created_at AS "createdAt", o.finished_at AS "finishedAt", s.name AS "serverName", s.id AS "serverId", u.email AS "ownerEmail"
      FROM operations o LEFT JOIN servers s ON s.id = o.server_id LEFT JOIN users u ON u.id = o.owner_id ORDER BY o.created_at DESC LIMIT 200`);
    return { operations: rows };
  }

  // One power action on many servers (the admin list's current filter): busy or unsuitable ones are skipped
  // and counted, the rest get their own operation. The Idempotency-Key makes a repeated click start nothing new.
  @Post('servers/actions') @HttpCode(202) @Can('servers.manage_all')
  async bulk(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Body() body: Input) {
    const action = String(body?.action ?? '');
    if (!['power_on', 'shutdown', 'power_off', 'reset', 'tag', 'untag', 'delete', 'restore'].includes(action)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const tag = bulkTag(action, body);
    const trash = action === 'delete' || action === 'restore';
    const grace = (await getSettings('servers')).deleteGraceHours;
    if (action === 'delete' && grace <= 0) throw apiError(403, 'ACTION_DISABLED', 'Deleting several servers at once needs a deletion grace period');
    const ids = Array.isArray(body?.serverIds) ? [...new Set(body.serverIds.map(String))] : [];
    if (!ids.length || ids.length > 200 || ids.some((x) => !/^[0-9a-f-]{36}$/.test(x))) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { serverIds: 'INVALID_VALUE' });
    const base = idempotencyKey(header, req.user.id);
    const { rows } = await pool.query(`SELECT s.*, EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) AS busy
      FROM servers s WHERE s.id = ANY($1::uuid[]) AND s.state <> 'deleted'`, [ids]);
    const started: string[] = [], skipped: string[] = [];
    for (const s of rows) {
      if (tag) { (await retag(s, action, tag) ? started : skipped).push(s.id); continue; }
      if (trash) { (await bulkTrash(req, s, action, `${base}:${s.id}`, grace) ? started : skipped).push(s.id); continue; }
      if (s.busy || !['ready', 'error'].includes(s.state) || !s.vm_moref) { skipped.push(s.id); continue; }
      await startPowerOperation(req, s, action, `${base}:${s.id}`).then(() => started.push(s.id), () => skipped.push(s.id));
    }
    await audit(req, 'server.bulk_action', 'success', req.user.id, { action, started: started.length, skipped: skipped.length });
    return { started: started.length, skipped: skipped.length + ids.length - rows.length };
  }

  // A failed operation resumes from its persisted step; nothing already done is repeated.
  @Post('operations/:id/retry') @HttpCode(202) @Can('operations.retry')
  async retry(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await refuseOnRestoreHold();
    // No stored provider task: the one that failed is over, and waiting for it again would fail the same way. The exception
    // is an operation that ended without learning its task's outcome (OUTCOME_UNKNOWN, worker): its task id is kept, so the
    // retry reads what became of it instead of issuing the step a second time. A cancel asked for before it failed is
    // forgotten: staff want it run now, and the worker would otherwise end it as cancelled again at once.
    const { rows: [op] } = await pool.query(`UPDATE operations o SET status = 'pending', cancel_requested = false, error_code = NULL, error_detail = NULL, finished_at = NULL,
      provider_task_id = CASE WHEN o.error_code = 'OUTCOME_UNKNOWN' THEN o.provider_task_id END, deadline_at = now() + interval '45 minutes', updated_at = now()
      FROM operations old WHERE o.id = $1 AND old.id = o.id AND o.status = 'failed' RETURNING o.id, o.server_id, o.kind, o.step, o.params, old.error_code AS was, old.error_detail AS detail`, [id])
      .catch((err) => { if (err.constraint === 'operations_one_open_per_server') throw apiError(409, 'OPERATION_IN_PROGRESS', 'Another operation is open'); throw err; });
    if (!op) throw apiError(409, 'INVALID_SERVER_STATE', 'Only failed operations can be retried');
    // The server goes back to the state its operation works in: being deleted, or being built; any other kind leaves it as it is.
    if (op.kind === 'delete') await pool.query("UPDATE servers SET state = 'deleting', error_code = NULL WHERE id = $1 AND state = 'error'", [op.server_id]);
    else if (op.kind === 'create' || op.kind === 'reinstall') await pool.query("UPDATE servers SET state = 'provisioning', error_code = NULL WHERE id = $1 AND state = 'error'", [op.server_id]);
    // A failed resize took the old price back and withdrew its unpaid invoice (worker): the retry is for the new shape at
    // the new price again, with a new invoice for what is left of the period. ("on": only starting it failed; nothing was
    // undone. OUTCOME_UNKNOWN: nothing was undone either.) The operation's prices are from the day it was asked for: what
    // the server costs now may hold more (an extra disk added since), so the retry adds the difference the resize makes
    // to the current price instead of writing the old target over it, and only while the server still has the shape and
    // package the operation started from. Changed since (another resize): refused, and staff ask for a new resize.
    const to = op.kind === 'resize' && op.step !== 'on' && op.was !== 'OUTCOME_UNKNOWN' ? op.params?.to : null;
    if (to) {
      const f = op.params.from ?? {};
      const { rows: [s] } = f.priceMonthly == null ? { rows: [] } : await pool.query(`UPDATE servers SET price_monthly = greatest(0, price_monthly + $2::numeric - $3::numeric), package_id = $4, traffic_gb = $5,
          price_hourly = CASE WHEN $6::numeric IS NOT NULL AND $7::numeric IS NOT NULL AND price_hourly IS NOT NULL THEN greatest(0, price_hourly + $6::numeric - $7::numeric) ELSE price_hourly END, updated_at = now()
        WHERE id = $1 AND vcpu = $8 AND memory_mb = $9 AND disk_gb = $10 AND package_id IS NOT DISTINCT FROM $11::uuid AND state <> 'deleted'
        RETURNING *, price_monthly::text AS now_monthly, (price_monthly - $2::numeric + $3::numeric)::text AS was_monthly`,
        [op.server_id, to.priceMonthly, f.priceMonthly, to.packageId ?? null, to.trafficGb ?? null, to.priceHourly ?? null, f.priceHourly ?? null, f.vcpu, f.memoryMb, f.diskGb, f.packageId ?? null]);
      if (!s) {
        await pool.query("UPDATE operations SET status = 'failed', error_code = $2, error_detail = $3, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending'", [op.id, op.was, op.detail]);
        throw apiError(409, 'SERVER_CHANGED', 'The server changed since this resize failed; ask for a new resize instead');
      }
      const { rows: [old] } = op.params.invoiceId ? await pool.query('SELECT status FROM invoices WHERE id = $1', [op.params.invoiceId]) : { rows: [] };
      const charge = old?.status === 'cancelled' ? await resizeCharge(s.id, s.was_monthly, s.now_monthly) : null;
      await repriced(s.id);
      if (charge && charge.chargeNow !== '0.00') {
        const invoiceId = await billResize({ ...s, owner_id: to.billTo ?? s.owner_id }, charge.chargeNow, to.currency ?? s.currency.trim(), { vcpu: op.params.vcpu, memoryMb: op.params.memoryMb, diskGb: op.params.diskGb });
        await pool.query("UPDATE operations SET params = params || jsonb_build_object('invoiceId', $2::text) WHERE id = $1", [op.id, invoiceId]);
      }
    }
    await enqueue(op.id);
    await audit(req, 'operation.retry', 'success', req.user.id, { operationId: id });
    return { id, status: 'pending' };
  }

  @Get('reconciliation') @Can('servers.view_all')
  async findings() {
    const { rows } = await pool.query(`SELECT f.id, f.kind, f.server_id AS "serverId", s.name AS "serverName", f.vm_moref AS "vmMoref", f.detail,
      f.first_seen AS "firstSeen", f.last_seen AS "lastSeen", c.name AS "connectionName" FROM reconciliation_findings f
      JOIN vmware_connections c ON c.id = f.connection_id LEFT JOIN servers s ON s.id = f.server_id WHERE f.resolved_at IS NULL ORDER BY f.last_seen DESC`);
    return { findings: rows };
  }

  // After a restore of an older backup (scripts/install.sh sets the hold, with the backup's name and the time): whether
  // the panel is held, from which backup and since when.
  @Get('system/restore-hold') @Can('system.update')
  async restoreHoldState() {
    const { rows: [h] } = await pool.query("SELECT value, at FROM maintenance_state WHERE key = 'restore_hold'");
    return { held: !!h, backup: h?.value?.backup ?? null, restoredAt: h ? h.value?.restored_at ?? h.at : null, detail: h?.value ?? null };
  }

  // Staff have reviewed what changed since the backup (payments, orders, deletions, servers): the panel acts again.
  @Delete('system/restore-hold') @HttpCode(200) @Can('system.update')
  async releaseRestoreHold(@Req() req: AuthedRequest) {
    const { rows: [h] } = await pool.query("DELETE FROM maintenance_state WHERE key = 'restore_hold' RETURNING value, at");
    forgetRestoreHold();
    await clearRestoreHoldNotice().catch(() => undefined); // a later hold is announced again
    if (h) await audit(req, 'system.restore_hold_released', 'success', req.user.id, { since: h.at, detail: h.value });
    return { held: false, released: !!h };
  }

  @Post('reconcile') @HttpCode(202) @Can('reconcile.run')
  async reconcile(@Req() req: AuthedRequest) {
    await new Queue('maintenance', { connection: redis }).add('reconcile', {}, { removeOnComplete: true, removeOnFail: true });
    await audit(req, 'reconcile.requested', 'success', req.user.id);
    return { queued: true };
  }
}
