import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { can } from './permissions';
import { capacityOf, limitsFor, resolveOrder, usageOf } from './catalog';
import { exceededQuota } from './capacity';
import { openConsole } from './console';
import { callAdapter, storedTarget } from './vmware';
import { limits } from './firewalls';

type Input = Record<string, unknown>;
// BullMQ carries only the operation id (also the job id, so re-adding is harmless);
// PostgreSQL holds the truth and the worker re-enqueues anything a lost job left behind.
const queue = new Queue('operations', { connection: redis });
export const enqueue = (operationId: string) => queue.add('operation', {}, {
  jobId: operationId, attempts: 6, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true,
}).catch(() => undefined); // if Redis is down the worker's recovery scan enqueues it later
const deadlineMinutes = { create: 45, delete: 20, power_on: 10, shutdown: 10, power_off: 10, reset: 10 } as const;
type Kind = keyof typeof deadlineMinutes;

function idempotencyKey(header: string | undefined, userId: string) {
  if (!header || !/^[\w-]{8,100}$/.test(header)) throw apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 characters)');
  return `${userId}:${header}`;
}
const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The same key with the same request returns the first result; with a different request it is refused.
async function replay(key: string, requestHash: string) {
  const { rows: [op] } = await pool.query('SELECT id, server_id, request_hash, kind, status FROM operations WHERE idempotency_key = $1', [key]);
  if (!op) return null;
  if (op.request_hash !== requestHash) throw apiError(409, 'IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was used for a different request');
  return { serverId: op.server_id, operation: { id: op.id, kind: op.kind, status: op.status }, replayed: true };
}

const sshKeyPattern = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ([A-Za-z0-9+/]+={0,2})( [^\r\n]{0,200})?$/;
const fingerprint = (blob: string) => 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '');

// Owners see and act on their servers; staff with servers.view_all see all, with servers.manage_all act on all.
// A server id alone gives no access (404 for others).
export async function findServer(req: AuthedRequest, id: string, manage = false) {
  const staff = manage ? can(req.user.permissions, 'servers.manage_all') : can(req.user.permissions, 'servers.view_all') || can(req.user.permissions, 'servers.manage_all');
  const { rows: [s] } = await pool.query(`SELECT * FROM servers WHERE id = $1 AND state <> 'deleted' AND (owner_id = $2 OR $3)`, [id, req.user.id, staff]);
  if (!s) throw apiError(404, 'NOT_FOUND', 'Unknown server');
  return s;
}

async function startOperation(req: AuthedRequest, server: { id: string; owner_id: string }, kind: Kind, key: string, requestHash: string) {
  try {
    const { rows: [op] } = await pool.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at)
      VALUES ($1, 'pending', $2, $3, $4, $5, 'queued', now() + make_interval(mins => $6)) RETURNING id, kind, status`,
      [kind, key, requestHash, server.id, server.owner_id, deadlineMinutes[kind]]);
    await enqueue(op.id);
    await audit(req, `server.${kind}`, 'success', req.user.id, { serverId: server.id, operationId: op.id });
    return op;
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'operations_one_open_per_server') throw apiError(409, 'OPERATION_IN_PROGRESS', 'Another operation is still running on this server');
    throw err;
  }
}

const serverColumns = `s.id, s.name, s.state, s.power_state AS "powerState", s.guest_ready AS "guestReady", s.vcpu, s.memory_mb AS "memoryMb", s.disk_gb AS "diskGb",
  s.price_monthly::text AS "priceMonthly", s.currency, s.error_code AS "errorCode", s.created_at AS "createdAt", s.project_id AS "projectId",
  p.name AS "poolName", p.location, i.name AS "imageName", host(a.address) AS address,
  CASE WHEN s.firewall_applied_version >= s.firewall_version THEN 'applied' WHEN s.firewall_error IS NOT NULL THEN 'failed' ELSE 'pending' END AS "firewallStatus",
  s.firewall_error AS "firewallError", (SELECT count(*)::int FROM firewall_servers fs WHERE fs.server_id = s.id) AS "firewallCount",
  (SELECT row_to_json(o) FROM (SELECT id, kind, status, step, error_code AS "errorCode", created_at AS "createdAt" FROM operations
    WHERE server_id = s.id ORDER BY created_at DESC LIMIT 1) o) AS "lastOperation"`;
const serverJoins = "FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN os_images i ON i.id = s.image_id LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary'";

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
    const { rows: [k] } = await pool.query('INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id, fingerprint',
      [req.user.id, name, key, fingerprint(m![3])]);
    if (!k) throw apiError(409, 'VALIDATION_FAILED', 'Key exists', { publicKey: 'KEY_EXISTS' });
    return k;
  }

  @Delete('ssh-keys/:id') @HttpCode(204)
  async deleteKey(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query('DELETE FROM ssh_keys WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown key');
  }

  @Get('servers')
  async list(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${serverColumns} ${serverJoins} WHERE s.state <> 'deleted' AND s.owner_id = $1 ORDER BY s.created_at DESC`, [req.user.id]);
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
    await findServer(req, id);
    const [{ rows: [server] }, { rows: operations }] = await Promise.all([
      pool.query(`SELECT ${serverColumns} ${serverJoins} WHERE s.id = $1`, [id]),
      pool.query(`SELECT id, kind, status, step, attempts, error_code AS "errorCode", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
        FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    return { server, operations };
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
    const order = await resolveOrder(String(body.poolId ?? ''), body);
    const { rows: keys } = await pool.query('SELECT public_key FROM ssh_keys WHERE owner_id = $1 AND id = ANY($2::uuid[])', [req.user.id, sshKeyIds]).catch(() => ({ rows: [] }));
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
    let result: { serverId: string; operation: { id: string; kind: string; status: string } };
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      await client.query('SELECT 1 FROM resource_pools WHERE id = $1 FOR UPDATE', [order.rp.id]);
      const again = await client.query('SELECT 1 FROM operations WHERE idempotency_key = $1', [key]);
      if (again.rowCount) { await client.query('ROLLBACK'); return (await replay(key, requestHash))!; }
      const over = exceededQuota(await limitsFor(req.user.id, projectId ?? undefined, client), await usageOf(req.user.id, projectId ?? undefined, client), order.shape);
      if (over.length) throw apiError(409, 'QUOTA_EXCEEDED', 'Quota exceeded', Object.fromEntries(over.map((o) => [o, 'QUOTA_EXCEEDED'])));
      const cap = await capacityOf(order.rp, client);
      if (order.shape.vcpu > cap.available.vcpu || order.shape.memoryMb > cap.available.memoryMb || order.shape.diskGb > cap.available.storageGb) {
        throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough capacity in this location');
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
      const { rows: [s] } = await client.query(`INSERT INTO servers (owner_id, project_id, pool_id, image_id, package_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, ssh_public_keys, extra_ipv4)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'provisioning', $12, $13) RETURNING id`,
        [req.user.id, projectId, order.rp.id, order.imageId, order.packageId, name, order.shape.vcpu, order.shape.memoryMb, order.shape.diskGb, order.price.monthly, order.price.currency, keys.map((k) => k.public_key), order.extraIpv4]);
      for (const [i, ip] of ips.entries()) {
        await client.query('INSERT INTO ip_allocations (ip_pool_id, address, server_id, kind) VALUES ($1, $2, $3, $4)', [ip.ip_pool_id, ip.address, s.id, i === 0 ? 'primary' : 'extra']);
      }
      // One IPv6 address when that IP pool has a prefix: the lowest free host from ::10 up.
      const { rows: [v6] } = await client.query(`SELECT host(network(i.ipv6_prefix)::inet + g) AS address FROM ip_pools i, generate_series(16::bigint, 65535) g
        WHERE i.id = $1 AND i.ipv6_prefix IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ip_allocations a WHERE a.address = network(i.ipv6_prefix)::inet + g)
          AND NOT EXISTS (SELECT 1 FROM ip_quarantine q WHERE q.address = network(i.ipv6_prefix)::inet + g AND q.available_at > now())
        ORDER BY g LIMIT 1`, [ips[0].ip_pool_id]);
      if (v6) await client.query("INSERT INTO ip_allocations (ip_pool_id, address, server_id, kind) VALUES ($1, $2, $3, 'ipv6')", [ips[0].ip_pool_id, v6.address, s.id]);
      if (firewallIds.length) {
        await client.query('INSERT INTO firewall_servers (firewall_id, server_id) SELECT unnest($1::uuid[]), $2', [firewallIds, s.id]);
        await client.query('UPDATE servers SET firewall_version = 1 WHERE id = $1', [s.id]);
      }
      const { rows: [op] } = await client.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at)
        VALUES ('create', 'pending', $1, $2, $3, $4, 'queued', now() + make_interval(mins => $5)) RETURNING id, kind, status`, [key, requestHash, s.id, req.user.id, deadlineMinutes.create]);
      await client.query('COMMIT');
      result = { serverId: s.id, operation: op };
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
    return result;
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
    if (!s.vm_moref || s.state !== 'ready') throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not ready');
    const { rows: [p] } = await pool.query('SELECT connection_id FROM resource_pools WHERE id = $1', [s.pool_id]);
    return openConsole(req, reply, p.connection_id, s.vm_moref, true);
  }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class ServersAdminController {
  @Get('servers') @Can('servers.view_all', 'dashboard.view')
  async all() {
    const { rows } = await pool.query(`SELECT ${serverColumns}, u.email AS "ownerEmail" ${serverJoins} JOIN users u ON u.id = s.owner_id
      WHERE s.state <> 'deleted' ORDER BY s.created_at DESC`);
    return { servers: rows };
  }

  @Get('operations') @Can('servers.view_all', 'dashboard.view')
  async operations() {
    const { rows } = await pool.query(`SELECT o.id, o.kind, o.status, o.step, o.attempts, o.error_code AS "errorCode", o.error_detail AS "errorDetail",
      o.created_at AS "createdAt", o.finished_at AS "finishedAt", s.name AS "serverName", s.id AS "serverId", u.email AS "ownerEmail"
      FROM operations o LEFT JOIN servers s ON s.id = o.server_id LEFT JOIN users u ON u.id = o.owner_id ORDER BY o.created_at DESC LIMIT 200`);
    return { operations: rows };
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
