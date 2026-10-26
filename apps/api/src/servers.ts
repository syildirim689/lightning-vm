import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
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
import { limits } from './firewalls';
import { choosePassword, generatePassword, sha512Crypt } from './passwords';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, type ServerSettings } from './settings-store';
import { prepareApplication } from './applications';
import { checkVdcRoom, resolveVdcOrder } from './vdc';
import { renderPtr } from './rdns-names';
import { fingerprint, parseKeyList, sshKeyPattern } from './smart-rules';

type Input = Record<string, unknown>;
// BullMQ carries only the operation id (also the job id, so re-adding is harmless);
// PostgreSQL holds the truth and the worker re-enqueues anything a lost job left behind.
const queue = new Queue('operations', { connection: redis });
export const enqueue = (operationId: string) => queue.add('operation', {}, {
  jobId: operationId, attempts: 6, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true,
}).catch(() => undefined); // if Redis is down the worker's recovery scan enqueues it later
const deadlineMinutes = { create: 45, delete: 20, power_on: 10, shutdown: 10, power_off: 10, reset: 10, snapshot_create: 30, snapshot_revert: 30, snapshot_delete: 60 } as const;
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
  snapshots: 'server.snapshots', iso: 'server.iso', rootPassword: 'server.root_password' };
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
  const { rows: [s] } = await pool.query(`SELECT * FROM servers WHERE id = $1 AND state <> 'deleted' AND (owner_id = $2 OR $3)`, [id, req.user.id, staff]);
  if (!s) throw apiError(404, 'NOT_FOUND', 'Unknown server');
  return s;
}

// A power action started for a VDC's bulk request: one operation per server, its own idempotency key.
export function startPowerOperation(req: AuthedRequest, server: { id: string; owner_id: string }, action: string, key: string) {
  return startOperation(req, server, action as Kind, key, hashOf({ id: server.id, action, bulk: true }));
}

export async function startOperation(req: AuthedRequest, server: { id: string; owner_id: string }, kind: Kind, key: string, requestHash: string, params: object = {}) {
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

const serverColumns = `s.id, s.name, s.state, s.power_state AS "powerState", s.guest_ready AS "guestReady", s.vcpu, s.memory_mb AS "memoryMb", s.disk_gb AS "diskGb",
  s.price_monthly::text AS "priceMonthly", s.currency, s.error_code AS "errorCode", s.created_at AS "createdAt", s.project_id AS "projectId",
  s.tags, s.notes, s.pool_id AS "poolId", s.image_id AS "imageId", s.package_id AS "packageId", s.vdc_id AS "vdcId",
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

  @Get('servers/:id')
  async detail(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const own = (await findServer(req, id)).owner_id === req.user.id;
    const [{ rows: [server] }, { rows: operations }] = await Promise.all([
      pool.query(`SELECT ${serverColumns} ${serverJoins} WHERE s.id = $1`, [id]),
      pool.query(`SELECT id, kind, status, step, attempts, error_code AS "errorCode", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
        FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    return { server, operations, own, allowed: await allowedFor(req) };
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
    const { rows: [conn] } = await pool.query('SELECT kind, operations FROM vmware_connections WHERE id = $1', [order.rp.connection_id]);
    if (conn.kind !== 'vcenter' || !conn.operations?.cloneFromImage) throw apiError(409, 'PROVISIONING_NOT_SUPPORTED', 'This location cannot create servers (needs vCenter with clone rights)');
    if (firewallIds.length && !conn.operations?.firewall) throw apiError(409, 'FIREWALL_NOT_SUPPORTED', 'This location cannot enforce firewalls (needs vCenter with a distributed switch)');

    // Short transaction, no external calls: quota, capacity and IP are checked and taken under row
    // locks (owner, then pool), so concurrent requests can never take the same address or capacity twice.
    const client = await pool.connect();
    let result: { serverId: string; operation: { id: string; kind: string; status: string }; passwordReplaced?: boolean };
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
      if (vdc) await client.query('UPDATE servers SET vdc_id = $2 WHERE id = $1', [s.id, vdc.vdcId]);
      if (firewallIds.length) {
        await client.query('INSERT INTO firewall_servers (firewall_id, server_id) SELECT unnest($1::uuid[]), $2', [firewallIds, s.id]);
        await client.query('UPDATE servers SET firewall_version = 1 WHERE id = $1', [s.id]);
      }
      const { rows: [op] } = await client.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at)
        VALUES ('create', 'pending', $1, $2, $3, $4, 'queued', now() + make_interval(mins => $5)) RETURNING id, kind, status`, [key, requestHash, s.id, req.user.id, deadlineMinutes.create]);
      await client.query('COMMIT');
      result = { serverId: s.id, operation: op, ...(root && { passwordReplaced: root.replaced }) };
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { constraint?: string }).constraint === 'servers_owner_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' });
      if ((err as { constraint?: string }).constraint === 'ip_allocations_pkey') throw apiError(409, 'IP_EXHAUSTED', 'Address taken concurrently; retry');
      throw err;
    } finally {
      client.release();
    }
    await enqueue(result.operation.id);
    await audit(req, 'server.create', 'success', req.user.id, { serverId: result.serverId, operationId: result.operation.id });
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
    // A running create is cancelled first; the delete then removes whatever it left.
    await pool.query("UPDATE operations SET cancel_requested = true WHERE server_id = $1 AND status IN ('pending', 'running') AND kind = 'create'", [id]);
    const { rows: [open] } = await pool.query("SELECT 1 FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id]);
    if (open) throw apiError(409, 'OPERATION_IN_PROGRESS', 'Wait for the running operation to stop, then delete again');
    await pool.query("UPDATE servers SET state = 'deleting', updated_at = now() WHERE id = $1", [id]);
    return { serverId: id, operation: await startOperation(req, server, 'delete', key, requestHash) };
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
    const { rows: [p] } = await pool.query('SELECT connection_id FROM resource_pools WHERE id = $1', [s.pool_id]);
    return openConsole(req, reply, p.connection_id, s.vm_moref, true);
  }
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
    if (!['power_on', 'shutdown', 'power_off', 'reset'].includes(action)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const ids = Array.isArray(body?.serverIds) ? [...new Set(body.serverIds.map(String))] : [];
    if (!ids.length || ids.length > 200 || ids.some((x) => !/^[0-9a-f-]{36}$/.test(x))) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { serverIds: 'INVALID_VALUE' });
    const base = idempotencyKey(header, req.user.id);
    const { rows } = await pool.query(`SELECT s.*, EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) AS busy
      FROM servers s WHERE s.id = ANY($1::uuid[]) AND s.state <> 'deleted'`, [ids]);
    const started: string[] = [], skipped: string[] = [];
    for (const s of rows) {
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
