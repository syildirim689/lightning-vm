import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { can, limitsOf, type Permission } from './permissions';
import { capacityOf, limitsFor, resolveOrder, usageOf } from './catalog';
import { exceededQuota } from './capacity';
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
import { checkVdcRoom, resolveVdcOrder } from './vdc';
import { renderPtr } from './rdns-names';
import { cleanLabels, fingerprint, parseKeyList, sshKeyPattern } from './smart-rules';
import { available, billOrder, billResize, payFromBalance, resizeCharge, startHourly } from './billing';
import { hourlyOf } from './billing-rules';
import { checkCoupon } from './coupons';
import { checkResellerRoom, discounted, resellerOf } from './reseller';

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
export async function customerMay(req: AuthedRequest, action: keyof ServerSettings['customer']) {
  if (can(req.user.permissions, 'servers.manage_all')) return;
  if (!can(req.user.permissions, actionPermission[action])) throw apiError(403, 'ACTION_NOT_PERMITTED', 'Your role does not allow this');
  if (!(await getSettings('servers')).customer[action]) throw apiError(403, 'ACTION_DISABLED', 'The administrator turned this off');
}
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
  return s;
}

// A power action started for a VDC's bulk request: one operation per server, its own idempotency key.
export function startPowerOperation(req: AuthedRequest, server: { id: string; owner_id: string }, action: string, key: string) {
  return startOperation(req, server, action as Kind, key, hashOf({ id: server.id, action, bulk: true }));
}

// Starts a ready server's grace period: shut down, deleted by the scheduler when it ends (an existing one is kept).
async function scheduleDeletion(req: AuthedRequest, server: Awaited<ReturnType<typeof findServer>>, key: string, grace: number) {
  const { rows: [r] } = await pool.query("UPDATE servers SET delete_at = coalesce(delete_at, now() + make_interval(hours => $2)), updated_at = now() WHERE id = $1 RETURNING delete_at", [server.id, grace]);
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

export async function startOperation(req: AuthedRequest, server: { id: string; owner_id: string }, kind: Kind, key: string, requestHash: string, params: object = {}) {
  // Read here, for every caller (the server page, bulk actions, schedules, data centers).
  if (lockedKinds.has(kind) && (await pool.query('SELECT 1 FROM servers WHERE id = $1 AND locked', [server.id])).rowCount) {
    throw apiError(409, 'SERVER_LOCKED', 'The server is locked against this; unlock it first');
  }
  // Held for an unpaid invoice: the owner may shut it down or delete it, nothing else until it is paid (staff still may).
  if (req.user?.id === server.owner_id && !['delete', 'shutdown', 'power_off'].includes(kind) && (await pool.query('SELECT 1 FROM servers WHERE id = $1 AND billing_hold', [server.id])).rowCount) {
    throw apiError(409, 'BILLING_HOLD', 'The server is held until the unpaid invoice is paid');
  }
  // The role's operations per hour, for a member acting on their own servers (staff and schedules are not counted).
  if (req.user?.id === server.owner_id && !can(req.user.permissions, 'servers.manage_all')) {
    const perHour = limitsOf(req.user.roles.join(',')).operationsPerHour;
    if (perHour !== undefined) {
      const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM operations WHERE owner_id = $1 AND created_at > now() - interval '1 hour'", [req.user.id]);
      if (n.n >= perHour) throw apiError(429, 'OPERATION_RATE_LIMITED', 'Too many operations this hour');
    }
  }
  try {
    const { rows: [op] } = await pool.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, params)
      VALUES ($1, 'pending', $2, $3, $4, $5, 'queued', now() + make_interval(mins => $6), $7) RETURNING id, kind, status`,
      [kind, key, requestHash, server.id, server.owner_id, deadlineMinutes[kind], params]);
    await enqueue(op.id);
    await audit(req, `server.${kind}`, 'success', req.user.id, { serverId: server.id, operationId: op.id, ...params });
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
    can(req.user.permissions, 'servers.manage_all') ? undefined : limitsOf(req.user.roles.join(',')).allowedLocations);
  const { shape } = order;
  if (shape.diskGb < server.disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'A disk can only grow', { diskGb: 'DISK_SHRINK_NOT_SUPPORTED' });
  if (shape.vcpu === server.vcpu && shape.memoryMb === server.memory_mb && shape.diskGb === server.disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Nothing changes', { type: 'NO_CHANGE' });
  const { rows: [img] } = await pool.query('SELECT family FROM os_images WHERE id = $1', [server.image_id]);
  if (img?.family === 'esxi' && (shape.vcpu < 2 || shape.memoryMb < 4096)) throw apiError(400, 'VALIDATION_FAILED', 'ESXi needs 2 vCPU and 4 GB', { type: 'ESXI_NEEDS_MORE' });
  const more = { vcpu: Math.max(0, shape.vcpu - server.vcpu), memoryMb: Math.max(0, shape.memoryMb - server.memory_mb), diskGb: Math.max(0, shape.diskGb - server.disk_gb) };
  const over = exceededQuota({ ...(await limitsFor(server.owner_id, server.project_id ?? undefined)), max_servers: null }, await usageOf(server.owner_id, server.project_id ?? undefined), more);
  if (over.length) throw apiError(409, 'QUOTA_EXCEEDED', 'Quota exceeded', Object.fromEntries(over.map((o) => [o, 'QUOTA_EXCEEDED'])));
  const cap = await capacityOf(order.rp);
  if (more.vcpu > cap.available.vcpu || more.memoryMb > cap.available.memoryMb || more.diskGb > cap.available.storageGb) throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough capacity in this location');
  const reseller = await resellerOf(server.owner_id);
  if (reseller) {
    order.price = { ...order.price, monthly: discounted(order.price.monthly, reseller.discountPct) };
    await checkResellerRoom(reseller, { servers: 0, ...more });
  }
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
    WHERE server_id = s.id ORDER BY created_at DESC LIMIT 1) o) AS "lastOperation"`;
const serverJoins = "FROM servers s JOIN resource_pools p ON p.id = s.pool_id LEFT JOIN locations l ON l.id = p.location_id JOIN os_images i ON i.id = s.image_id LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary'";

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
    const { rows: [r] } = await pool.query(`UPDATE console_snippets SET name = $3, command = $4, shared = $5
      WHERE id = $1 AND (owner_id = $2 OR (shared AND $6)) RETURNING id, name, command, shared, owner_id = $2 AS mine`,
      [id, req.user.id, name, command, shared, can(req.user.permissions, 'settings.manage')]);
    if (!r) throw apiError(404, 'NOT_FOUND', 'Unknown command');
    if (shared) await audit(req, 'console.snippet_shared', 'success', req.user.id, { id, name });
    return r;
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
    return { servers: rows };
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
      quick: Record<string, number> }>('/v1/vm/metrics', { ...storedTarget(c), vm: s.vm_moref }, 30_000);
    const body = { ...out, vcpu: s.vcpu, memoryMb: s.memory_mb, fetchedAt: new Date().toISOString() };
    await redis.set(`metrics:${id}`, JSON.stringify(body), 'EX', 15).catch(() => undefined);
    return body;
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
    const own = (await findServer(req, id)).owner_id === req.user.id;
    const [{ rows: [server] }, { rows: operations }] = await Promise.all([
      pool.query(`SELECT ${serverColumns} ${serverJoins} WHERE s.id = $1`, [id]),
      pool.query(`SELECT id, kind, status, step, attempts, error_code AS "errorCode", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
        FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    return { server, operations, own, allowed: await allowedFor(req), deleteGraceHours: (await getSettings('servers')).deleteGraceHours };
  }

  @Post('servers') @HttpCode(202)
  async create(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Body() body: Input) {
    if (!can(req.user.permissions, 'servers.create')) throw apiError(403, 'FORBIDDEN', 'Permission required');
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf(body);
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;

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
    const order = vdc ? vdc.order : await resolveOrder(String(body.poolId ?? ''), body, limitsOf(req.user.roles.join(',')).allowedLocations);
    const { rows: keys } = await pool.query('SELECT public_key FROM ssh_keys WHERE owner_id = $1 AND id = ANY($2::uuid[])', [req.user.id, sshKeyIds]).catch(() => ({ rows: [] }));
    // Optional root password (console/RDP): a weak one is replaced by a strong one that starts with the brand.
    if (body.rootPassword !== undefined && (typeof body.rootPassword !== 'string' || body.rootPassword.length > 128)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { rootPassword: 'INVALID_VALUE' });
    const branding = await getSettings('branding');
    const { rows: [img] } = await pool.query('SELECT family FROM os_images WHERE id = $1', [order.imageId]).catch(() => ({ rows: [] }));
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
    let cloneFrom: string | null = null;
    if (body.cloneFrom) {
      const { rows: [src] } = await pool.query(`SELECT s.vm_moref, s.pool_id, s.image_id, s.disk_gb, i.family FROM servers s JOIN os_images i ON i.id = s.image_id
        WHERE s.id = $1 AND s.owner_id = $2 AND s.state = 'ready' AND s.vm_moref IS NOT NULL AND s.vdc_id IS NULL`, [String(body.cloneFrom), req.user.id]).catch(() => ({ rows: [] }));
      if (!src || src.family === 'esxi') throw apiError(400, 'VALIDATION_FAILED', 'Cannot clone', { cloneFrom: 'NOT_AVAILABLE' });
      if (src.pool_id !== order.rp.id || src.image_id !== order.imageId) throw apiError(400, 'VALIDATION_FAILED', 'A copy stays in its location and image', { cloneFrom: 'CLONE_MISMATCH' });
      if (order.shape.diskGb < src.disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Disk smaller than the original', { diskGb: 'BELOW_SOURCE_DISK' });
      if (order.application) throw apiError(400, 'VALIDATION_FAILED', 'No application on a copy', { applicationId: 'NOT_WITH_CLONE' });
      cloneFrom = src.vm_moref;
    }
    // Pay as you go: offered when the admin allows it; the balance must cover the first hours (Settings → Billing).
    let hourly: string | null = null;
    // A reseller's customer (or the reseller): the reseller's price, billed to the reseller, within their allocation.
    const reseller = vdc ? null : await resellerOf(req.user.id);
    if (reseller) {
      order.price = { ...order.price, monthly: discounted(order.price.monthly, reseller.discountPct) };
      if (body.billingCycle === 'hourly') throw apiError(400, 'VALIDATION_FAILED', 'Hourly billing is not offered', { billingCycle: 'NOT_AVAILABLE' });
    }
    // Billed by an outside system (external.ts): no subscription, no invoice, no hourly usage here.
    const external = !!(req as { externalBilling?: boolean }).externalBilling;
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
    if (conn.kind !== 'vcenter' || !conn.operations?.cloneFromImage) throw apiError(409, 'PROVISIONING_NOT_SUPPORTED', 'This location cannot create servers (needs vCenter with clone rights)');
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
        const over = exceededQuota(await limitsFor(req.user.id, projectId ?? undefined, client), await usageOf(req.user.id, projectId ?? undefined, client), order.shape);
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
      if (cloneFrom) await client.query('UPDATE servers SET clone_from_moref = $2 WHERE id = $1', [s.id, cloneFrom]);
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
      const { rows: [op] } = await client.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at)
        VALUES ('create', 'pending', $1, $2, $3, $4, $6, now() + make_interval(mins => $5)) RETURNING id, kind, status`,
        [key, requestHash, s.id, req.user.id, deadlineMinutes.create, bill?.awaitingPayment ? 'awaiting_payment' : 'queued']);
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
    try { await pool.query('UPDATE servers SET name = $2, updated_at = now() WHERE id = $1', [id, name]); }
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
    await findServer(req, id, true);
    await pool.query('UPDATE servers SET locked = $2, updated_at = now() WHERE id = $1', [id, body.locked]);
    await audit(req, body.locked ? 'server.locked' : 'server.unlocked', 'success', req.user.id, { serverId: id });
    return { locked: body.locked };
  }

  @Delete('servers/:id/root-password') @HttpCode(204)
  async forgetRootPassword(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id, true);
    await pool.query('UPDATE servers SET root_password_enc = NULL, updated_at = now() WHERE id = $1', [id]);
    await audit(req, 'server.root_password_forgotten', 'success', req.user.id, { serverId: id });
  }

  @Post('servers/:id/actions') @HttpCode(202)
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
  @Post('servers/:id/resize/quote')
  async resizeQuote(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const server = await findServer(req, id, true);
    await customerMay(req, 'resize');
    const r = await resizeTarget(req, server, body);
    return { shape: r.order.shape, priceMonthly: r.order.price.monthly, currency: r.order.price.currency, ...r.charge };
  }

  // New vCPU, memory and disk size (a package of this location, or a custom shape). The disk only grows. The new monthly price
  // applies from now: an increase is invoiced for the rest of the period, a decrease simply bills less from the next one.
  @Post('servers/:id/resize') @HttpCode(202)
  async resize(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const key = idempotencyKey(header, req.user.id);
    const requestHash = hashOf({ id, resize: body });
    const earlier = await replay(key, requestHash);
    if (earlier) return earlier;
    const server = await findServer(req, id, true);
    await customerMay(req, 'resize');
    if (server.state !== 'ready' || !server.vm_moref) throw apiError(409, 'INVALID_SERVER_STATE', 'Not possible in this state');
    const r = await resizeTarget(req, server, body);
    const { shape, price } = r.order;
    // vSphere cannot grow a disk under snapshots: refused here, before the server is stopped for nothing.
    if (shape.diskGb > server.disk_gb) {
      const { snapshots } = await callAdapter<{ snapshots: unknown[] }>('/v1/vm/snapshots', { ...(await snapshotTarget(server.pool_id)), vm: server.vm_moref }, 30_000);
      if (snapshots.length) throw apiError(409, 'DISK_HAS_SNAPSHOTS', 'Remove the snapshots before growing the disk');
    }
    const operation = await startOperation(req, server, 'resize', key, requestHash,
      { vcpu: shape.vcpu, memoryMb: shape.memoryMb, diskGb: shape.diskGb, powerOn: server.power_state === 'poweredOn',
        from: { vcpu: server.vcpu, memoryMb: server.memory_mb, diskGb: server.disk_gb, priceMonthly: server.price_monthly, packageId: server.package_id } });
    // The price follows the shape at once (renewals read it); a resize that finally fails puts it back (worker).
    await pool.query(`UPDATE servers SET price_monthly = $2, package_id = $3, traffic_gb = $4, price_hourly = CASE WHEN billing_mode = 'hourly' THEN $5::numeric ELSE price_hourly END,
      updated_at = now() WHERE id = $1`, [id, price.monthly, r.order.packageId, r.order.trafficGb, hourlyOf(price.monthly)]);
    const invoiceId = r.charge.chargeNow !== '0.00' ? await billResize({ ...server, owner_id: r.billTo }, r.charge.chargeNow, price.currency, shape) : null;
    if (invoiceId) await pool.query("UPDATE operations SET params = params || jsonb_build_object('invoiceId', $2::text) WHERE id = $1", [operation.id, invoiceId]);
    return { serverId: id, operation, ...(invoiceId && { invoiceId }) };
  }

  // A fresh install from another (or the same) image: the disk is wiped; addresses, firewalls and the price stay.
  // Dangerous: the caller repeats the server's name.
  @Post('servers/:id/reinstall') @HttpCode(202)
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
    const { rows: [img] } = await pool.query(`SELECT i.family, i.min_disk_gb FROM os_images i JOIN resource_pools p ON p.connection_id = i.connection_id
      WHERE i.id = $1 AND i.active AND p.id = $2 AND (i.owner_id IS NULL OR i.owner_id = $4) AND (NOT EXISTS (SELECT 1 FROM package_images pi WHERE pi.package_id = $3)
        OR EXISTS (SELECT 1 FROM package_images pi WHERE pi.package_id = $3 AND pi.image_id = i.id))`, [String(body.imageId ?? ''), server.pool_id, server.package_id, server.owner_id]).catch(() => ({ rows: [] }));
    if (!img) throw apiError(400, 'VALIDATION_FAILED', 'Unknown image', { imageId: 'NOT_AVAILABLE' });
    if (server.disk_gb < img.min_disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Disk too small', { imageId: 'BELOW_IMAGE_MINIMUM' });
    if (img.family === 'esxi' && (server.vcpu < 2 || server.memory_mb < 4096)) throw apiError(400, 'VALIDATION_FAILED', 'ESXi needs 2 vCPU and 4 GB', { imageId: 'ESXI_NEEDS_MORE' });
    // New SSH keys and root password when given; otherwise the server's current ones go onto the new disk.
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
      ?? (img.family === 'esxi' && !server.root_password_enc ? { password: generatePassword(prefix), replaced: true } : null);
    // Keys and password first (the worker reads them when it builds); the image is set by the worker once the old VM is gone.
    if ((await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id])).rowCount) throw apiError(409, 'OPERATION_IN_PROGRESS', 'Another operation is still running on this server');
    await pool.query(`UPDATE servers SET ssh_public_keys = $2, root_password_hash = COALESCE($3, root_password_hash), root_password_enc = COALESCE($4, root_password_enc), updated_at = now() WHERE id = $1`,
      [id, keys, root ? sha512Crypt(root.password) : null, root ? encryptSecret(root.password, 'server-root-password') : null]);
    const operation = await startOperation(req, server, 'reinstall', key, requestHash, { imageId: String(body.imageId), fromImageId: server.image_id });
    await pool.query("UPDATE servers SET state = 'provisioning', error_code = NULL, updated_at = now() WHERE id = $1 AND state <> 'deleted'", [id]);
    return { serverId: id, operation, ...(root && { passwordReplaced: root.replaced }) };
  }

  // Dangerous: the caller must repeat the server's name. Resources are released only after the
  // worker has confirmed in VMware that the VM is gone.
  @Delete('servers/:id') @HttpCode(202)
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
    // A running create is cancelled first; the delete then removes whatever it left.
    await pool.query("UPDATE operations SET cancel_requested = true WHERE server_id = $1 AND status IN ('pending', 'running') AND kind = 'create'", [id]);
    // A build still waiting for its first payment never started: it ends here (its unpaid invoice is withdrawn with the server).
    await pool.query("UPDATE operations SET status = 'cancelled', error_code = 'CANCELLED', finished_at = now(), updated_at = now() WHERE server_id = $1 AND kind = 'create' AND status = 'pending' AND step = 'awaiting_payment'", [id]);
    const { rows: [open] } = await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id]);
    if (open) throw apiError(409, 'OPERATION_IN_PROGRESS', 'Wait for the running operation to stop, then delete again');
    // A ready server waits out the grace period shut down (the scheduler deletes it then); `now` skips the wait.
    const grace = (await getSettings('servers')).deleteGraceHours;
    if (grace > 0 && server.state === 'ready' && body?.now !== true) return { serverId: id, deleteAt: await scheduleDeletion(req, server, key, grace) };
    await pool.query("UPDATE servers SET state = 'deleting', delete_at = NULL, updated_at = now() WHERE id = $1", [id]);
    return { serverId: id, operation: await startOperation(req, server, 'delete', key, requestHash) };
  }

  // Takes back a server waiting to be deleted (it stays shut down; the owner starts it again).
  @Delete('servers/:id/deletion')
  async restore(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id, true);
    await customerMay(req, 'delete');
    const { rowCount } = await pool.query("UPDATE servers SET delete_at = NULL, updated_at = now() WHERE id = $1 AND delete_at IS NOT NULL AND state <> 'deleting'", [id]);
    if (!rowCount) throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not waiting to be deleted');
    await audit(req, 'server.delete_cancelled', 'success', req.user.id, { serverId: id });
    return { restored: true };
  }

  // One power action on several of the caller's servers (the list's selection). Each goes through the same checks as
  // the server page; ones the caller may not act on, busy or unsuitable are skipped and counted.
  @Post('servers/actions') @HttpCode(202)
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
    const { rowCount } = await pool.query("UPDATE operations SET cancel_requested = true, updated_at = now() WHERE id = $1 AND server_id = $2 AND status IN ('pending', 'running')", [op, id]);
    if (!rowCount) throw apiError(409, 'INVALID_SERVER_STATE', 'Nothing to cancel');
    await audit(req, 'server.cancel', 'success', req.user.id, { serverId: id, operationId: op });
    return { cancelRequested: true };
  }

  // The customer's own server only (admins: any). Ownership is checked here, not by knowing the id.
  @Post('servers/:id/console') @HttpCode(201)
  async console(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'console');
    if (!s.vm_moref || s.state !== 'ready') throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not ready');
    if (s.billing_hold && s.owner_id === req.user.id) throw apiError(409, 'BILLING_HOLD', 'The server is held until the unpaid invoice is paid');
    const { rows: [p] } = await pool.query('SELECT connection_id FROM resource_pools WHERE id = $1', [s.pool_id]);
    return openConsole(req, reply, p.connection_id, s.vm_moref, true);
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
    const { rowCount } = await pool.query("UPDATE servers SET delete_at = NULL, updated_at = now() WHERE id = $1 AND delete_at IS NOT NULL AND state <> 'deleting'", [s.id]);
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
async function retag(s: { id: string; tags: string[] | null }, action: string, tag: string): Promise<boolean> {
  const has = (x: string) => x.toLocaleLowerCase('tr') === tag.toLocaleLowerCase('tr');
  const now = s.tags ?? [];
  const next = action === 'tag' ? (now.some(has) || now.length >= 10 ? now : [...now, tag]) : now.filter((x) => !has(x));
  if (next.length === now.length) return false;
  await pool.query('UPDATE servers SET tags = $2, updated_at = now() WHERE id = $1', [s.id, next]);
  return true;
}

@Controller('admin') @UseGuards(PermissionGuard)
export class ServersAdminController {
  @Get('servers') @Can('servers.view_all', 'dashboard.view')
  async all(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${serverColumns}, u.email AS "ownerEmail", EXISTS (SELECT 1 FROM server_favorites f WHERE f.user_id = $1 AND f.server_id = s.id) AS favorite
      ${serverJoins} JOIN users u ON u.id = s.owner_id WHERE s.state <> 'deleted' ORDER BY s.created_at DESC`, [req.user.id]);
    return { servers: rows };
  }

  @Get('operations') @Can('servers.view_all', 'dashboard.view')
  async operations() {
    const { rows } = await pool.query(`SELECT o.id, o.kind, o.status, o.step, o.attempts, o.error_code AS "errorCode", o.error_detail AS "errorDetail",
      o.created_at AS "createdAt", o.finished_at AS "finishedAt", s.name AS "serverName", s.id AS "serverId", u.email AS "ownerEmail"
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
    const { rows: [op] } = await pool.query(`UPDATE operations SET status = 'pending', error_code = NULL, error_detail = NULL, finished_at = NULL,
      deadline_at = now() + interval '45 minutes', updated_at = now() WHERE id = $1 AND status = 'failed' RETURNING id, server_id`, [id])
      .catch((err) => { if (err.constraint === 'operations_one_open_per_server') throw apiError(409, 'OPERATION_IN_PROGRESS', 'Another operation is open'); throw err; });
    if (!op) throw apiError(409, 'INVALID_SERVER_STATE', 'Only failed operations can be retried');
    await pool.query("UPDATE servers SET state = 'provisioning', error_code = NULL WHERE id = $1 AND state = 'error'", [op.server_id]);
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

  @Post('reconcile') @HttpCode(202) @Can('reconcile.run')
  async reconcile(@Req() req: AuthedRequest) {
    await new Queue('maintenance', { connection: redis }).add('reconcile', {}, { removeOnComplete: true, removeOnFail: true });
    await audit(req, 'reconcile.requested', 'success', req.user.id);
    return { queued: true };
  }
}
