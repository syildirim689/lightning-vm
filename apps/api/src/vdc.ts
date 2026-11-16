// Virtual data centers: admins give a customer an allocation in a pool for a monthly price; the customer
// creates servers of any shape inside it (POST /servers with vdcId), sees the usage, and acts on all at once.
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { capacityOf, type Order } from './catalog';

type Input = Record<string, unknown>;
type Db = PoolClient | typeof pool;

export const vdcUsage = async (id: string, db: Db = pool) => (await db.query(`SELECT count(*)::int AS servers, COALESCE(sum(vcpu), 0)::int AS vcpu,
  COALESCE(sum(memory_mb), 0)::int AS "memoryMb", COALESCE(sum(disk_gb), 0)::int AS "diskGb" FROM servers WHERE vdc_id = $1 AND state <> 'deleted'`, [id])).rows[0] as
  { servers: number; vcpu: number; memoryMb: number; diskGb: number };

const columns = `v.id, v.name, v.owner_id AS "ownerId", u.email AS owner, v.pool_id AS "poolId", p.name AS "poolName", p.location, v.vcpu, v.memory_mb AS "memoryMb",
  v.disk_gb AS "diskGb", v.max_servers AS "maxServers", v.price_monthly::text AS "priceMonthly", v.currency, v.active, v.created_at AS "createdAt",
  (SELECT row_to_json(x) FROM (SELECT count(*)::int AS servers, COALESCE(sum(vcpu), 0)::int AS vcpu, COALESCE(sum(memory_mb), 0)::int AS "memoryMb",
    COALESCE(sum(disk_gb), 0)::int AS "diskGb" FROM servers s WHERE s.vdc_id = v.id AND s.state <> 'deleted') x) AS used`;
const from = 'FROM vdcs v JOIN users u ON u.id = v.owner_id JOIN resource_pools p ON p.id = v.pool_id';

// A server inside a VDC: shape chosen freely within what is left (checked again under lock on create).
export async function resolveVdcOrder(userId: string, body: Input): Promise<{ order: Order; vdcId: string }> {
  // Not while it is suspended for an unpaid invoice (billing.ts holds its servers): a new server would run unheld.
  const { rows: [v] } = await pool.query(`SELECT * FROM vdcs v WHERE v.id = $1 AND v.owner_id = $2 AND v.active
    AND NOT EXISTS (SELECT 1 FROM subscriptions b WHERE b.vdc_id = v.id AND b.status = 'suspended')`, [body.vdcId, userId]).catch(() => ({ rows: [] }));
  if (!v) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { vdcId: 'NOT_AVAILABLE' });
  const fields: Record<string, string> = {};
  const int = (k: string, min: number, max: number) => { const n = Number(body[k]); if (!Number.isInteger(n) || n < min || n > max) fields[k] = 'OUT_OF_RANGE'; return n; };
  const shape = { vcpu: int('vcpu', 1, v.vcpu), memoryMb: int('memoryMb', 512, v.memory_mb), diskGb: int('diskGb', 10, v.disk_gb) };
  if (!fields.memoryMb && shape.memoryMb % 256) fields.memoryMb = 'OUT_OF_RANGE';
  const { rows: [rp] } = await pool.query('SELECT * FROM resource_pools WHERE id = $1', [v.pool_id]);
  const { rows: [img] } = await pool.query('SELECT id, min_disk_gb FROM os_images WHERE id = $1 AND active AND connection_id = $2', [body.imageId, rp.connection_id]).catch(() => ({ rows: [] }));
  if (!img) fields.imageId = 'NOT_AVAILABLE';
  else if (shape.diskGb < img.min_disk_gb) fields.diskGb = 'DISK_TOO_SMALL';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { vdcId: v.id, order: { rp, shape, price: { monthly: '0.00', currency: v.currency }, extraIpv4: 0, application: null, packageId: null, imageId: String(body.imageId), trafficGb: null } };
}

// Inside the create transaction: the VDC row is locked and what is left is checked against the new server.
export async function checkVdcRoom(client: PoolClient, vdcId: string, shape: { vcpu: number; memoryMb: number; diskGb: number }) {
  const { rows: [v] } = await client.query('SELECT * FROM vdcs WHERE id = $1 AND active FOR UPDATE', [vdcId]);
  if (!v) throw apiError(409, 'VDC_INACTIVE', 'This virtual data center is not active');
  const u = await vdcUsage(vdcId, client);
  const over: Record<string, string> = {};
  if (u.servers + 1 > v.max_servers) over.servers = 'VDC_LIMIT';
  if (u.vcpu + shape.vcpu > v.vcpu) over.vcpu = 'VDC_LIMIT';
  if (u.memoryMb + shape.memoryMb > v.memory_mb) over.memoryMb = 'VDC_LIMIT';
  if (u.diskGb + shape.diskGb > v.disk_gb) over.diskGb = 'VDC_LIMIT';
  if (Object.keys(over).length) throw apiError(409, 'VDC_LIMIT', 'Not enough room left in this virtual data center', over);
}

function readVdc(b: Input) {
  const fields: Record<string, string> = {};
  const int = (k: string, min: number, max: number) => { const n = Number(b[k]); if (!Number.isInteger(n) || n < min || n > max) fields[k] = 'OUT_OF_RANGE'; return n; };
  const name = typeof b.name === 'string' && b.name.trim() && b.name.trim().length <= 60 ? b.name.trim() : (fields.name = 'INVALID_VALUE', '');
  const v = { name, vcpu: int('vcpu', 1, 100000), memoryMb: int('memoryMb', 512, 1 << 30), diskGb: int('diskGb', 10, 1 << 30), maxServers: int('maxServers', 1, 10000),
    price: String(b.priceMonthly ?? '0').replace(',', '.'), currency: String(b.currency ?? 'EUR').toUpperCase(), active: b.active !== false };
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(v.price)) fields.priceMonthly = 'INVALID_AMOUNT';
  if (!/^[A-Z]{3}$/.test(v.currency)) fields.currency = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return v;
}

@Controller('admin') @UseGuards(PermissionGuard)
export class VdcAdminController {
  @Get('vdcs') @Can('catalog.view', 'catalog.manage', 'servers.view_all')
  async list() { return { vdcs: (await pool.query(`SELECT ${columns} ${from} ORDER BY u.email, v.name`)).rows }; }

  @Post('vdcs') @HttpCode(201) @Can('catalog.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = readVdc(body ?? {});
    const { rows: [owner] } = await pool.query('SELECT id FROM users WHERE id = $1', [body?.ownerId]).catch(() => ({ rows: [] }));
    if (!owner) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { ownerId: 'NOT_AVAILABLE' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [rp] } = await client.query('SELECT * FROM resource_pools WHERE id = $1 AND active FOR UPDATE', [body?.poolId]).catch(() => ({ rows: [] }));
      if (!rp) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { poolId: 'NOT_AVAILABLE' });
      // The allocation is reserved in the pool at once, so it must fit now.
      const cap = await capacityOf(rp, client);
      if (v.vcpu > cap.available.vcpu || v.memoryMb > cap.available.memoryMb || v.diskGb > cap.available.storageGb) throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough capacity in this pool');
      const { rows: [row] } = await client.query(`INSERT INTO vdcs (owner_id, name, pool_id, vcpu, memory_mb, disk_gb, max_servers, price_monthly, currency, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [owner.id, v.name, rp.id, v.vcpu, v.memoryMb, v.diskGb, v.maxServers, v.price, v.currency, v.active])
        .catch((e) => { if (e.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }); throw e; });
      await client.query('COMMIT');
      await audit(req, 'vdc.created', 'success', req.user.id, { id: row.id, owner: owner.id, pool: rp.id, vcpu: v.vcpu, memoryMb: v.memoryMb, diskGb: v.diskGb });
      return { id: row.id };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  @Put('vdcs/:id') @Can('catalog.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const v = readVdc(body ?? {});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [old] } = await client.query('SELECT * FROM vdcs WHERE id = $1 FOR UPDATE', [id]);
      if (!old) throw apiError(404, 'NOT_FOUND', 'Unknown VDC');
      const { rows: [rp] } = await client.query('SELECT * FROM resource_pools WHERE id = $1 FOR UPDATE', [old.pool_id]);
      const u = await vdcUsage(id, client);
      const below: Record<string, string> = {};
      if (v.vcpu < u.vcpu) below.vcpu = 'VDC_BELOW_USAGE';
      if (v.memoryMb < u.memoryMb) below.memoryMb = 'VDC_BELOW_USAGE';
      if (v.diskGb < u.diskGb) below.diskGb = 'VDC_BELOW_USAGE';
      if (v.maxServers < u.servers) below.maxServers = 'VDC_BELOW_USAGE';
      if (Object.keys(below).length) throw apiError(400, 'VALIDATION_FAILED', 'Below what is in use', below);
      // Growing needs room in the pool for the difference (the old allocation is already counted there).
      const cap = await capacityOf(rp, client);
      if (v.vcpu - old.vcpu > cap.available.vcpu || v.memoryMb - old.memory_mb > cap.available.memoryMb || v.diskGb - old.disk_gb > cap.available.storageGb) {
        throw apiError(409, 'CAPACITY_EXHAUSTED', 'Not enough capacity in this pool');
      }
      await client.query(`UPDATE vdcs SET name=$2, vcpu=$3, memory_mb=$4, disk_gb=$5, max_servers=$6, price_monthly=$7, currency=$8, active=$9, updated_at=now() WHERE id=$1`,
        [id, v.name, v.vcpu, v.memoryMb, v.diskGb, v.maxServers, v.price, v.currency, v.active]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await audit(req, 'vdc.updated', 'success', req.user.id, { id, vcpu: v.vcpu, memoryMb: v.memoryMb, diskGb: v.diskGb, active: v.active });
    return { id };
  }

  @Delete('vdcs/:id') @HttpCode(204) @Can('catalog.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if ((await vdcUsage(id)).servers) throw apiError(409, 'IN_USE', 'Delete the servers inside it first');
    await pool.query("UPDATE servers SET vdc_id = NULL WHERE vdc_id = $1 AND state = 'deleted'", [id]);
    const { rowCount } = await pool.query('DELETE FROM vdcs WHERE id = $1', [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown VDC');
    await audit(req, 'vdc.deleted', 'success', req.user.id, { id });
  }
}

@Controller() @UseGuards(SessionGuard)
export class VdcController {
  @Get('vdcs')
  async mine(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT ${columns} ${from} WHERE v.owner_id = $1 ORDER BY v.name`, [req.user.id]);
    const { rows: servers } = rows.length ? await pool.query(`SELECT s.id, s.name, s.state, s.vdc_id AS "vdcId", s.vcpu, s.memory_mb AS "memoryMb", s.disk_gb AS "diskGb",
      host(a.address) AS address FROM servers s LEFT JOIN ip_allocations a ON a.server_id = s.id AND a.kind = 'primary'
      WHERE s.vdc_id = ANY($1::uuid[]) AND s.state <> 'deleted' ORDER BY s.name`, [rows.map((r) => r.id)]) : { rows: [] };
    const { rows: images } = rows.length ? await pool.query(`SELECT DISTINCT i.id, i.name, i.family, i.min_disk_gb AS "minDiskGb", p.id AS "poolId" FROM os_images i
      JOIN resource_pools p ON p.connection_id = i.connection_id WHERE i.active AND p.id = ANY($1::uuid[]) ORDER BY i.name`, [rows.map((r) => r.poolId)]) : { rows: [] };
    return { vdcs: rows.map((v) => ({ ...v, servers: servers.filter((s) => s.vdcId === v.id), images: images.filter((i) => i.poolId === v.poolId) })) };
  }

  // The same power action on every server of the VDC that can take it; each gets its own operation.
  @Post('vdcs/:id/actions') @HttpCode(202) @Can('server.power')
  async bulk(@Req() req: AuthedRequest, @Headers('idempotency-key') header: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const action = String(body?.action ?? '');
    if (!['power_on', 'shutdown', 'power_off', 'reset'].includes(action)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { action: 'INVALID_VALUE' });
    const { rows: [v] } = await pool.query('SELECT id FROM vdcs WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!v) throw apiError(404, 'NOT_FOUND', 'Unknown VDC');
    const { customerMay, startPowerOperation } = await import('./servers');
    await customerMay(req, 'power');
    const { rows: servers } = await pool.query(`SELECT * FROM servers s WHERE vdc_id = $1 AND state IN ('ready', 'error') AND vm_moref IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running'))`, [id]);
    const base = header && /^[\w-]{8,100}$/.test(header) ? header : randomUUID();
    const started = [];
    for (const s of servers) started.push({ serverId: s.id, operation: await startPowerOperation(req, s, action, `${req.user.id}:${base}:${s.id}`) });
    await audit(req, 'vdc.bulk_action', 'success', req.user.id, { id, action, servers: started.length });
    return { started };
  }
}
