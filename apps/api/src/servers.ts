import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { pool, redis } from './db';
import { apiError } from './errors';
import { AdminGuard, audit, SessionGuard, type AuthedRequest } from './auth';
import { capacityOf, limitsFor, resolveOrder, usageOf } from './catalog';
import { exceededQuota } from './capacity';
import { openConsole } from './console';

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

// Owners see their servers; admins see all. A server id alone gives no access (404 for others).
async function findServer(req: AuthedRequest, id: string) {
  const { rows: [s] } = await pool.query(`SELECT * FROM servers WHERE id = $1 AND state <> 'deleted' AND (owner_id = $2 OR $3)`, [id, req.user.id, req.user.role === 'admin']);
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
  (SELECT row_to_json(o) FROM (SELECT id, kind, status, step, error_code AS "errorCode", created_at AS "createdAt" FROM operations
    WHERE server_id = s.id ORDER BY created_at DESC LIMIT 1) o) AS "lastOperation"`;
const serverJoins = 'FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN os_images i ON i.id = s.image_id LEFT JOIN ip_allocations a ON a.server_id = s.id';

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
    const { rows: [conn] } = await pool.query('SELECT kind, operations FROM vmware_connections WHERE id = $1', [order.rp.connection_id]);
    if (conn.kind !== 'vcenter' || !conn.operations?.cloneFromImage) throw apiError(409, 'PROVISIONING_NOT_SUPPORTED', 'This location cannot create servers (needs vCenter with clone rights)');

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
      const { rows: [ip] } = await client.query(`SELECT i.id AS ip_pool_id, host(i.range_start + g) AS address FROM ip_pools i,
          generate_series(0::bigint, i.range_end - i.range_start) g
        WHERE i.pool_id = $1 AND (i.range_start + g) <> ALL(i.excluded) AND (i.range_start + g) <> i.gateway
          AND NOT EXISTS (SELECT 1 FROM ip_allocations a WHERE a.address = i.range_start + g)
        ORDER BY i.name, g LIMIT 1`, [order.rp.id]);
      if (!ip) throw apiError(409, 'IP_EXHAUSTED', 'No free IP address in this location');
      const { rows: [s] } = await client.query(`INSERT INTO servers (owner_id, project_id, pool_id, image_id, package_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, ssh_public_keys)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'provisioning', $12) RETURNING id`,
        [req.user.id, projectId, order.rp.id, order.imageId, order.packageId, name, order.shape.vcpu, order.shape.memoryMb, order.shape.diskGb, order.price.monthly, order.price.currency, keys.map((k) => k.public_key)]);
      await client.query('INSERT INTO ip_allocations (ip_pool_id, address, server_id) VALUES ($1, $2, $3)', [ip.ip_pool_id, ip.address, s.id]);
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
    const server = await findServer(req, id);
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
    const server = await findServer(req, id);
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
    await findServer(req, id);
    const { rowCount } = await pool.query("UPDATE operations SET cancel_requested = true, updated_at = now() WHERE id = $1 AND server_id = $2 AND status IN ('pending', 'running')", [op, id]);
    if (!rowCount) throw apiError(409, 'INVALID_SERVER_STATE', 'Nothing to cancel');
    await audit(req, 'server.cancel', 'success', req.user.id, { serverId: id, operationId: op });
    return { cancelRequested: true };
  }

  // The customer's own server only (admins: any). Ownership is checked here, not by knowing the id.
  @Post('servers/:id/console') @HttpCode(201)
  async console(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    if (!s.vm_moref || s.state !== 'ready') throw apiError(409, 'INVALID_SERVER_STATE', 'The server is not ready');
    const { rows: [p] } = await pool.query('SELECT connection_id FROM resource_pools WHERE id = $1', [s.pool_id]);
    return openConsole(req, reply, p.connection_id, s.vm_moref, true);
  }
}

@Controller('admin') @UseGuards(AdminGuard)
export class ServersAdminController {
  @Get('servers')
  async all() {
    const { rows } = await pool.query(`SELECT ${serverColumns}, u.email AS "ownerEmail" ${serverJoins} JOIN users u ON u.id = s.owner_id
      WHERE s.state <> 'deleted' ORDER BY s.created_at DESC`);
    return { servers: rows };
  }

  @Get('operations')
  async operations() {
    const { rows } = await pool.query(`SELECT o.id, o.kind, o.status, o.step, o.attempts, o.error_code AS "errorCode", o.error_detail AS "errorDetail",
      o.created_at AS "createdAt", o.finished_at AS "finishedAt", s.name AS "serverName", s.id AS "serverId", u.email AS "ownerEmail"
      FROM operations o LEFT JOIN servers s ON s.id = o.server_id LEFT JOIN users u ON u.id = o.owner_id ORDER BY o.created_at DESC LIMIT 200`);
    return { operations: rows };
  }

  // A failed operation resumes from its persisted step; nothing already done is repeated.
  @Post('operations/:id/retry') @HttpCode(202)
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

  @Get('reconciliation')
  async findings() {
    const { rows } = await pool.query(`SELECT f.id, f.kind, f.server_id AS "serverId", s.name AS "serverName", f.vm_moref AS "vmMoref", f.detail,
      f.first_seen AS "firstSeen", f.last_seen AS "lastSeen", c.name AS "connectionName" FROM reconciliation_findings f
      JOIN vmware_connections c ON c.id = f.connection_id LEFT JOIN servers s ON s.id = f.server_id WHERE f.resolved_at IS NULL ORDER BY f.last_seen DESC`);
    return { findings: rows };
  }

  @Post('reconcile') @HttpCode(202)
  async reconcile(@Req() req: AuthedRequest) {
    await new Queue('maintenance', { connection: redis }).add('reconcile', {}, { removeOnComplete: true, removeOnFail: true });
    await audit(req, 'reconcile.requested', 'success', req.user.id);
    return { queued: true };
  }
}
