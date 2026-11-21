import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { isIP } from 'node:net';
import { pool } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest, TokenOpen } from './auth';
import { Can, PermissionGuard } from './rbac';
import { ensureRoles, limitsOf } from './permissions';
import { budgetState } from './budget';
import { checkCoupon } from './coupons';
import { capabilitiesOf, checkCustom, exceededQuota, poolCapacity, type Capabilities, type Limits, type Shape } from './capacity';
import { locationColumns } from './locations';
import type { Application } from './applications';

type Input = Record<string, unknown>;

// Small server-side validators that collect field codes for the UI.
class Fields {
  errors: Record<string, string> = {};
  constructor(private body: Input) {}
  text(name: string, max = 100, required = true) {
    const v = this.body[name];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.length > max) { this.errors[name] = 'INVALID_VALUE'; return ''; }
    return v.trim();
  }
  int(name: string, min: number, max: number, fallback?: number) {
    const v = this.body[name] === undefined || this.body[name] === '' ? fallback : Number(this.body[name]);
    if (v === undefined || !Number.isInteger(v) || v < min || v > max) { this.errors[name] = 'OUT_OF_RANGE'; return 0; }
    return v;
  }
  decimal(name: string, max: number, required = true) {
    const v = this.body[name];
    if ((v === undefined || v === null || v === '') && !required) return null;
    const s = String(v);
    if (!/^\d{1,8}(\.\d{1,4})?$/.test(s) || Number(s) > max) { this.errors[name] = 'INVALID_AMOUNT'; return '0'; }
    return s; // stays a decimal string all the way into PostgreSQL numeric
  }
  ratio(name: string, min: number, max: number, fallback: number) {
    const v = this.body[name] === undefined || this.body[name] === '' ? fallback : Number(this.body[name]);
    if (!Number.isFinite(v) || v < min || v > max) { this.errors[name] = 'OUT_OF_RANGE'; return fallback; }
    return Math.round(v * 100) / 100;
  }
  currency(name: string) {
    const v = this.body[name];
    if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) { this.errors[name] = 'INVALID_CURRENCY'; return 'EUR'; }
    return v;
  }
  ids(name: string) {
    const v = this.body[name] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !/^[0-9a-f-]{36}$/.test(x))) { this.errors[name] = 'INVALID_VALUE'; return []; }
    return v as string[];
  }
  done() { if (Object.keys(this.errors).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', this.errors); }
}

// Maps constraint violations to stable codes instead of a generic 500.
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (err) {
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Duplicate', { name: 'NAME_TAKEN' });
    if (pg.code === '23503') throw apiError(409, 'IN_USE', 'Still referenced by other records');
    if (pg.code === '23514' && pg.constraint?.startsWith('ip_pools_ipv6')) throw apiError(400, 'VALIDATION_FAILED', 'Invalid IPv6', { ipv6Gateway: 'IPV6_GATEWAY_OUTSIDE' });
    if (pg.code === '23514' && pg.constraint?.startsWith('ip_pools')) throw apiError(400, 'VALIDATION_FAILED', 'Invalid range', { range: 'IP_OUTSIDE_SUBNET' });
    if (pg.code === '22P02') throw apiError(400, 'VALIDATION_FAILED', 'Invalid address', { cidr: 'INVALID_ADDRESS' });
    throw err;
  }
}

// Optional IPv6 for an IP pool: a prefix of /48 to /64 and a gateway inside it (each server gets one address).
function readIpv6(body: Input, f: Fields) {
  const prefix = typeof body.ipv6Prefix === 'string' ? body.ipv6Prefix.trim() : '';
  const gateway = typeof body.ipv6Gateway === 'string' ? body.ipv6Gateway.trim() : '';
  if (!prefix && !gateway) return { ipv6Prefix: null, ipv6Gateway: null };
  const m = /^([0-9a-f:]+)\/(\d{1,3})$/i.exec(prefix);
  if (!m || isIP(m[1]) !== 6 || Number(m[2]) < 48 || Number(m[2]) > 64) f.errors.ipv6Prefix = 'INVALID_IPV6_PREFIX';
  if (isIP(gateway) !== 6) f.errors.ipv6Gateway = 'INVALID_ADDRESS';
  return { ipv6Prefix: prefix, ipv6Gateway: gateway };
}

type Db = PoolClient | typeof pool;
// Refuses at once what a location's platform cannot do (capacity.ts), instead of an operation that fails later in the worker.
export async function platformCan(poolId: string, what: keyof Capabilities) {
  const { rows: [c] } = await pool.query('SELECT c.kind, c.operations FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [poolId]);
  if (c && !capabilitiesOf(c.kind, c.operations)[what]) throw apiError(409, 'PLATFORM_NOT_SUPPORTED', 'This location’s platform does not support this yet');
}
// Live (not deleted) servers are the pool's reserved capacity and the owner's quota usage; a server's disk is its system
// disk plus its extra disks (disks.ts).
const withDisks = "disk_gb + COALESCE((SELECT sum(d.size_gb) FROM server_disks d WHERE d.server_id = servers.id AND d.status <> 'failed'), 0)";
// Reserved in a pool: its servers outside VDCs, plus every active VDC allocation (whose servers live inside it).
export async function reservedFor(poolId: string, db: Db = pool) {
  const { rows: [r] } = await db.query(`SELECT COALESCE(sum(vcpu), 0)::int AS vcpu, COALESCE(sum(memory_mb), 0)::int AS "memoryMb", COALESCE(sum(disk_gb), 0)::int AS "diskGb" FROM (
      SELECT vcpu, memory_mb, ${withDisks} AS disk_gb FROM servers WHERE pool_id = $1 AND state <> 'deleted' AND vdc_id IS NULL
      UNION ALL SELECT vcpu, memory_mb, disk_gb FROM vdcs WHERE pool_id = $1 AND active) x`, [poolId]);
  return r as { vcpu: number; memoryMb: number; diskGb: number };
}
// What a quota counts of `servers` rows joined to their open resize (at most one: a server has one open operation).
const openResize = (and = '') => `LEFT JOIN LATERAL (SELECT (o.params->>'vcpu')::int AS to_vcpu, (o.params->>'memoryMb')::int AS to_memory_mb, (o.params->>'diskGb')::int AS to_disk_gb
      FROM operations o WHERE o.server_id = servers.id AND o.kind = 'resize' AND o.status IN ('pending', 'running') ${and}) r ON true`;
const usedSums = { vcpu: 'COALESCE(sum(GREATEST(vcpu, COALESCE(r.to_vcpu, 0))), 0)::int', memoryMb: 'COALESCE(sum(GREATEST(memory_mb, COALESCE(r.to_memory_mb, 0))), 0)::int',
  diskGb: `COALESCE(sum(${withDisks} + GREATEST(0, COALESCE(r.to_disk_gb, 0) - disk_gb)), 0)::int` };
// Counted against the limits limitsFor gives: a project's servers only when the project has a quota of its own; otherwise
// everything the owner has (projects cost nothing to make, so they must not each start a fresh count).
// A resize that is accepted and not finished counts with the size it grows to: the server's row changes only when the
// worker has resized it, and until then a second request (a resize of another server, an order, an extra disk) would be
// measured against room that is already given away. Once the row has the new size, or the resize failed, nothing is added.
// notGrowing: a server counted as its row says, whatever is open on it (a resize asked for while another is open on the
// same server is refused as that, an open operation, and not by a quota its own first resize filled).
export async function usageOf(userId: string, projectId?: string, db: Db = pool, notGrowing?: string) {
  const { rows: [u] } = await db.query(`SELECT count(*)::int AS servers, ${usedSums.vcpu} AS vcpu, ${usedSums.memoryMb} AS "memoryMb", ${usedSums.diskGb} AS "diskGb" FROM servers
    ${openResize('AND o.server_id IS DISTINCT FROM $3::uuid')}
    WHERE state <> 'deleted' AND vdc_id IS NULL
      AND (CASE WHEN $2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM quotas q WHERE q.scope = 'project' AND q.subject_id = $2) THEN project_id = $2 ELSE owner_id = $1 END)`, [userId, projectId ?? null, notGrowing ?? null]);
  return u as { servers: number; vcpu: number; memoryMb: number; diskGb: number };
}

export async function capacityOf(p: Record<string, unknown>, db: Db = pool) {
  const [hosts, datastores, vms] = await Promise.all([
    db.query('SELECT cpu_cores, memory_bytes, moref FROM vmware_hosts WHERE connection_id = $1 AND parent = $2', [p.connection_id, p.compute_moref]),
    db.query('SELECT capacity_bytes, free_bytes, uncommitted_bytes FROM vmware_datastores WHERE connection_id = $1 AND moref = ANY($2)', [p.connection_id, p.datastore_morefs]),
    // The platform's own VMs (lvm-*) are counted as reserved below, not again as foreign use.
    db.query(`SELECT v.cpu, v.memory_mb, v.committed_bytes, v.template FROM vmware_vms v
      JOIN vmware_hosts h ON h.connection_id = v.connection_id AND h.moref = v.host_moref WHERE v.connection_id = $1 AND h.parent = $2 AND v.name NOT LIKE 'lvm-%'`, [p.connection_id, p.compute_moref]),
  ]);
  const settings = { cpu_overcommit: Number(p.cpu_overcommit), memory_overcommit: Number(p.memory_overcommit), storage_overcommit: Number(p.storage_overcommit),
    reserve_cpu_pct: Number(p.reserve_cpu_pct), reserve_memory_pct: Number(p.reserve_memory_pct), reserve_storage_pct: Number(p.reserve_storage_pct) };
  return poolCapacity(settings, hosts.rows, datastores.rows, vms.rows, await reservedFor(String(p.id), db));
}

async function readPool(body: Input, client: PoolClient | typeof pool = pool) {
  const f = new Fields(body);
  const v = {
    name: f.text('name'), location: f.text('location', 100, false) ?? '',
    connectionId: f.text('connectionId', 36), computeMoref: f.text('computeMoref', 80), networkMoref: f.text('networkMoref', 80),
    datastoreMorefs: Array.isArray(body.datastoreMorefs) && body.datastoreMorefs.length && body.datastoreMorefs.every((d) => typeof d === 'string') ? body.datastoreMorefs as string[] : (f.errors.datastoreMorefs = 'REQUIRED', []),
    cpuOvercommit: f.ratio('cpuOvercommit', 1, 32, 4), memoryOvercommit: f.ratio('memoryOvercommit', 1, 4, 1), storageOvercommit: f.ratio('storageOvercommit', 1, 10, 1),
    reserveCpuPct: f.int('reserveCpuPct', 0, 90, 10), reserveMemoryPct: f.int('reserveMemoryPct', 0, 90, 10), reserveStoragePct: f.int('reserveStoragePct', 0, 90, 15),
    active: body.active !== false,
    // Extra IPv4 addresses a customer may add to a server here, and their monthly price each (offering currency).
    extraIpv4Max: f.int('extraIpv4Max', 0, 32, 0), extraIpv4Price: f.decimal('extraIpv4Price', 100000, false) ?? '0',
    // Monthly traffic allowance of custom-shaped servers here (GB in and out; empty: unlimited).
    trafficGb: body.trafficGb === undefined || body.trafficGb === null || body.trafficGb === '' ? null : f.int('trafficGb', 1, 10_000_000),
  };
  f.done();
  // Everything referenced must exist in the discovered inventory of that connection.
  const { rows: [ok] } = await client.query(`SELECT
      EXISTS (SELECT 1 FROM vmware_compute WHERE connection_id = $1 AND moref = $2) AS compute,
      EXISTS (SELECT 1 FROM vmware_networks WHERE connection_id = $1 AND moref = $3) AS network,
      (SELECT count(*) FROM vmware_datastores WHERE connection_id = $1 AND moref = ANY($4))::int AS datastores`,
    [v.connectionId, v.computeMoref, v.networkMoref, v.datastoreMorefs]).catch(() => ({ rows: [{}] }));
  const missing: Record<string, string> = {};
  if (!ok?.compute) missing.computeMoref = 'NOT_IN_INVENTORY';
  if (!ok?.network) missing.networkMoref = 'NOT_IN_INVENTORY';
  if (ok?.datastores !== v.datastoreMorefs.length) missing.datastoreMorefs = 'NOT_IN_INVENTORY';
  if (Object.keys(missing).length) throw apiError(400, 'VALIDATION_FAILED', 'Not in inventory', missing);
  return v;
}

function readRule(body: Input) {
  const f = new Fields(body);
  const r = {
    cpu_min: f.int('cpuMin', 1, 256), cpu_max: f.int('cpuMax', 1, 256), cpu_step: f.int('cpuStep', 1, 64, 1),
    memory_min_mb: f.int('memoryMinMb', 512, 4194304), memory_max_mb: f.int('memoryMaxMb', 512, 4194304), memory_step_mb: f.int('memoryStepMb', 128, 65536, 1024),
    disk_min_gb: f.int('diskMinGb', 1, 65536), disk_max_gb: f.int('diskMaxGb', 1, 65536), disk_step_gb: f.int('diskStepGb', 1, 1024, 10),
    min_memory_mb_per_vcpu: f.int('minMemoryMbPerVcpu', 1, 65536, 512), max_memory_mb_per_vcpu: f.int('maxMemoryMbPerVcpu', 1, 1048576, 16384),
    price_vcpu: f.decimal('priceVcpu', 100000), price_memory_gb: f.decimal('priceMemoryGb', 100000), price_disk_gb: f.decimal('priceDiskGb', 100000),
    currency: f.currency('currency'), active: body.active !== false,
  };
  if (!f.errors.cpuMax && r.cpu_min > r.cpu_max) f.errors.cpuMax = 'MIN_ABOVE_MAX';
  if (!f.errors.memoryMaxMb && r.memory_min_mb > r.memory_max_mb) f.errors.memoryMaxMb = 'MIN_ABOVE_MAX';
  if (!f.errors.diskMaxGb && r.disk_min_gb > r.disk_max_gb) f.errors.diskMaxGb = 'MIN_ABOVE_MAX';
  if (!f.errors.maxMemoryMbPerVcpu && r.min_memory_mb_per_vcpu > r.max_memory_mb_per_vcpu) f.errors.maxMemoryMbPerVcpu = 'MIN_ABOVE_MAX';
  f.done();
  return r;
}

function readLimits(body: Input): Limits {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { maxServers: 'INVALID_VALUE' });
  const f = new Fields(body);
  const opt = (name: string, max: number) => body[name] === null || body[name] === '' || body[name] === undefined ? null : f.int(name, 0, max);
  const l = { max_servers: opt('maxServers', 10000), max_vcpu: opt('maxVcpu', 100000), max_memory_mb: opt('maxMemoryMb', 1 << 30), max_disk_gb: opt('maxDiskGb', 1 << 30) };
  f.done();
  return l;
}

// An image is a template in a connection's discovered inventory.
async function readImage(body: Input) {
  const f = new Fields(body);
  const v = { name: f.text('name'), family: ['linux', 'windows', 'esxi'].includes(String(body.family)) ? String(body.family) : (f.errors.family = 'INVALID_VALUE', ''),
    connectionId: f.text('connectionId', 36), templateMoref: f.text('templateMoref', 80), minDiskGb: f.int('minDiskGb', 1, 65536, 10), cloudInit: body.cloudInit !== false };
  f.done();
  const { rows: [t] } = await pool.query('SELECT template FROM vmware_vms WHERE connection_id = $1 AND moref = $2', [v.connectionId, v.templateMoref]).catch(() => ({ rows: [] }));
  if (!t) throw apiError(400, 'VALIDATION_FAILED', 'Not in inventory', { templateMoref: 'NOT_IN_INVENTORY' });
  if (!t.template) throw apiError(400, 'VALIDATION_FAILED', 'Not a template', { templateMoref: 'NOT_A_TEMPLATE' });
  return v;
}

function readPackage(body: Input) {
  const f = new Fields(body);
  const v = { name: f.text('name'), vcpu: f.int('vcpu', 1, 256), memoryMb: f.int('memoryMb', 512, 4194304), diskGb: f.int('diskGb', 1, 65536),
    priceMonthly: f.decimal('priceMonthly', 1000000), priceHourly: f.decimal('priceHourly', 10000, false), currency: f.currency('currency'),
    poolIds: f.ids('poolIds'), imageIds: f.ids('imageIds'), sort: f.int('sort', 0, 10000, 0), active: body.active !== false,
    trafficGb: body.trafficGb === undefined || body.trafficGb === null || body.trafficGb === '' ? null : f.int('trafficGb', 1, 10_000_000), };
  if (!f.errors.poolIds && !v.poolIds.length) f.errors.poolIds = 'REQUIRED';
  f.done();
  return v;
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

const poolColumns = `p.id, p.name, p.location, p.location_id AS "locationId", p.connection_id AS "connectionId", c.name AS "connectionName", p.compute_moref AS "computeMoref",
  p.datastore_morefs AS "datastoreMorefs", p.network_moref AS "networkMoref", p.cpu_overcommit::float AS "cpuOvercommit",
  p.memory_overcommit::float AS "memoryOvercommit", p.storage_overcommit::float AS "storageOvercommit", p.reserve_cpu_pct AS "reserveCpuPct",
  p.reserve_memory_pct AS "reserveMemoryPct", p.reserve_storage_pct AS "reserveStoragePct", p.active,
  p.extra_ipv4_max AS "extraIpv4Max", p.extra_ipv4_price::text AS "extraIpv4Price", p.traffic_gb AS "trafficGb", p.backup_datastore_moref AS "backupDatastore", p.extra_disk_price_gb::text AS "extraDiskPriceGb", p.private_portgroup_moref AS "privatePortgroup", p.private_vlan_min AS "privateVlanMin", p.private_vlan_max AS "privateVlanMax"`;

@Controller('admin') @UseGuards(PermissionGuard)
export class CatalogAdminController {
  @Get('pools') @Can('catalog.view', 'catalog.manage', 'dashboard.view')
  async pools() {
    const { rows } = await pool.query(`SELECT ${poolColumns}, row_to_json(r) AS "customRule" FROM resource_pools p
      JOIN vmware_connections c ON c.id = p.connection_id LEFT JOIN custom_rules r ON r.pool_id = p.id ORDER BY p.name`);
    const raw = await pool.query('SELECT * FROM resource_pools');
    const byId = new Map(raw.rows.map((r) => [r.id, r]));
    return { pools: await Promise.all(rows.map(async (p) => ({ ...p, capacity: await capacityOf(byId.get(p.id)) }))) };
  }

  @Post('pools') @HttpCode(201) @Can('catalog.manage')
  async createPool(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = await readPool(body);
    const locationId = typeof body.locationId === 'string' && body.locationId ? body.locationId : null;
    if (locationId) {
      const { rows: [l] } = await pool.query('SELECT name FROM locations WHERE id = $1', [locationId]).catch(() => ({ rows: [] }));
      if (!l) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { locationId: 'INVALID_VALUE' });
      v.location = l.name;
    }
    const { rows: [p] } = await guarded(() => pool.query(`INSERT INTO resource_pools (name, location, connection_id, compute_moref, datastore_morefs, network_moref,
      cpu_overcommit, memory_overcommit, storage_overcommit, reserve_cpu_pct, reserve_memory_pct, reserve_storage_pct, active, extra_ipv4_max, extra_ipv4_price, traffic_gb)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, [v.name, v.location, v.connectionId, v.computeMoref, v.datastoreMorefs, v.networkMoref,
      v.cpuOvercommit, v.memoryOvercommit, v.storageOvercommit, v.reserveCpuPct, v.reserveMemoryPct, v.reserveStoragePct, v.active, v.extraIpv4Max, v.extraIpv4Price, v.trafficGb]));
    if (locationId) await pool.query('UPDATE resource_pools SET location_id = $2 WHERE id = $1', [p.id, locationId]);
    await audit(req, 'catalog.pool_created', 'success', req.user.id, { id: p.id, name: v.name });
    return { id: p.id };
  }

  @Put('pools/:id') @Can('catalog.manage')
  async updatePool(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const v = await readPool(body);
    const { rowCount } = await guarded(() => pool.query(`UPDATE resource_pools SET name=$2, location=$3, connection_id=$4, compute_moref=$5, datastore_morefs=$6,
      network_moref=$7, cpu_overcommit=$8, memory_overcommit=$9, storage_overcommit=$10, reserve_cpu_pct=$11, reserve_memory_pct=$12, reserve_storage_pct=$13,
      active=$14, extra_ipv4_max=$15, extra_ipv4_price=$16, traffic_gb=$17, updated_at=now() WHERE id=$1`, [id, v.name, v.location, v.connectionId, v.computeMoref, v.datastoreMorefs, v.networkMoref,
      v.cpuOvercommit, v.memoryOvercommit, v.storageOvercommit, v.reserveCpuPct, v.reserveMemoryPct, v.reserveStoragePct, v.active, v.extraIpv4Max, v.extraIpv4Price, v.trafficGb]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_updated', 'success', req.user.id, { id });
    return { id };
  }

  // Extra IPv4 for sale in this location (how many per server, monthly price each), without the full pool form.
  @Put('pools/:id/ip-options') @Can('catalog.manage')
  async poolIpOptions(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const f = new Fields(body);
    const v = { max: f.int('extraIpv4Max', 0, 32, 0), price: f.decimal('extraIpv4Price', 100000, false) ?? '0',
      trafficGb: body.trafficGb === undefined || body.trafficGb === null || body.trafficGb === '' ? null : f.int('trafficGb', 1, 10_000_000) };
    f.done();
    // trafficGb: the monthly allowance of custom-shaped servers ordered here from now on (empty: unlimited).
    const { rowCount } = await pool.query('UPDATE resource_pools SET extra_ipv4_max = $2, extra_ipv4_price = $3, traffic_gb = $4, updated_at = now() WHERE id = $1', [id, v.max, v.price, v.trafficGb]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_ip_options', 'success', req.user.id, { id, ...v });
    return { id, extraIpv4Max: v.max, extraIpv4Price: v.price, trafficGb: v.trafficGb };
  }

  @Delete('pools/:id') @HttpCode(204) @Can('catalog.manage')
  async deletePool(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await guarded(() => pool.query('DELETE FROM resource_pools WHERE id = $1', [id]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    await audit(req, 'catalog.pool_deleted', 'success', req.user.id, { id });
  }

  @Put('pools/:id/custom-rule') @Can('catalog.manage')
  async setRule(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const r = readRule(body);
    await guarded(() => pool.query(`INSERT INTO custom_rules (pool_id, cpu_min, cpu_max, cpu_step, memory_min_mb, memory_max_mb, memory_step_mb,
      disk_min_gb, disk_max_gb, disk_step_gb, min_memory_mb_per_vcpu, max_memory_mb_per_vcpu, price_vcpu, price_memory_gb, price_disk_gb, currency, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (pool_id) DO UPDATE SET cpu_min=EXCLUDED.cpu_min, cpu_max=EXCLUDED.cpu_max, cpu_step=EXCLUDED.cpu_step, memory_min_mb=EXCLUDED.memory_min_mb,
      memory_max_mb=EXCLUDED.memory_max_mb, memory_step_mb=EXCLUDED.memory_step_mb, disk_min_gb=EXCLUDED.disk_min_gb, disk_max_gb=EXCLUDED.disk_max_gb,
      disk_step_gb=EXCLUDED.disk_step_gb, min_memory_mb_per_vcpu=EXCLUDED.min_memory_mb_per_vcpu, max_memory_mb_per_vcpu=EXCLUDED.max_memory_mb_per_vcpu,
      price_vcpu=EXCLUDED.price_vcpu, price_memory_gb=EXCLUDED.price_memory_gb, price_disk_gb=EXCLUDED.price_disk_gb, currency=EXCLUDED.currency, active=EXCLUDED.active`,
      [id, r.cpu_min, r.cpu_max, r.cpu_step, r.memory_min_mb, r.memory_max_mb, r.memory_step_mb, r.disk_min_gb, r.disk_max_gb, r.disk_step_gb,
        r.min_memory_mb_per_vcpu, r.max_memory_mb_per_vcpu, r.price_vcpu, r.price_memory_gb, r.price_disk_gb, r.currency, r.active]));
    await audit(req, 'catalog.custom_rule_set', 'success', req.user.id, { poolId: id });
    return { poolId: id };
  }

  @Get('images') @Can('catalog.view', 'catalog.manage', 'dashboard.view')
  async images() {
    const { rows } = await pool.query(`SELECT i.id, i.name, i.family, i.connection_id AS "connectionId", i.template_moref AS "templateMoref",
      v.name AS "templateName", i.min_disk_gb AS "minDiskGb", i.cloud_init AS "cloudInit", i.active FROM os_images i
      LEFT JOIN vmware_vms v ON v.connection_id = i.connection_id AND v.moref = i.template_moref WHERE i.owner_id IS NULL ORDER BY i.name`); // customers' own images (images.ts) are theirs, not the catalog's
    return { images: rows };
  }

  @Post('images') @HttpCode(201) @Can('catalog.manage')
  async createImage(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = await readImage(body);
    const { rows: [i] } = await guarded(() => pool.query(`INSERT INTO os_images (name, family, connection_id, template_moref, min_disk_gb, cloud_init)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [v.name, v.family, v.connectionId, v.templateMoref, v.minDiskGb, v.cloudInit]));
    await audit(req, 'catalog.image_created', 'success', req.user.id, { id: i.id, name: v.name });
    return { id: i.id };
  }

  // Same fields and checks as a new image; servers already built from it keep what they have.
  @Put('images/:id') @Can('catalog.manage')
  async updateImage(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const v = await readImage(body);
    const { rowCount } = await guarded(() => pool.query(`UPDATE os_images SET name = $2, family = $3, connection_id = $4, template_moref = $5, min_disk_gb = $6, cloud_init = $7
      WHERE id = $1`, [id, v.name, v.family, v.connectionId, v.templateMoref, v.minDiskGb, v.cloudInit]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown image');
    await audit(req, 'catalog.image_updated', 'success', req.user.id, { id, name: v.name });
    return { id };
  }

  @Delete('images/:id') @HttpCode(204) @Can('catalog.manage')
  async deleteImage(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await guarded(() => pool.query('DELETE FROM os_images WHERE id = $1', [id]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown image');
    await audit(req, 'catalog.image_deleted', 'success', req.user.id, { id });
  }

  @Get('packages') @Can('catalog.view', 'catalog.manage', 'dashboard.view')
  async packages() {
    const { rows } = await pool.query(`SELECT p.id, p.name, p.vcpu, p.memory_mb AS "memoryMb", p.disk_gb AS "diskGb", p.price_monthly::text AS "priceMonthly",
      p.price_hourly::text AS "priceHourly", p.currency, p.active, p.sort, p.traffic_gb AS "trafficGb",
      COALESCE((SELECT array_agg(pool_id) FROM package_pools WHERE package_id = p.id), '{}') AS "poolIds",
      COALESCE((SELECT array_agg(image_id) FROM package_images WHERE package_id = p.id), '{}') AS "imageIds"
      FROM packages p ORDER BY p.sort, p.name`);
    return { packages: rows };
  }

  @Post('packages') @HttpCode(201) @Can('catalog.manage')
  async createPackage(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = readPackage(body);
    const id = await guarded(() => inTransaction(async (client) => {
      const { rows: [p] } = await client.query(`INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, price_hourly, currency, sort, active, traffic_gb)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [v.name, v.vcpu, v.memoryMb, v.diskGb, v.priceMonthly, v.priceHourly, v.currency, v.sort, v.active, v.trafficGb]);
      await client.query('INSERT INTO package_pools SELECT $1, unnest($2::uuid[])', [p.id, v.poolIds]);
      await client.query('INSERT INTO package_images SELECT $1, i.id FROM os_images i WHERE i.id = ANY($2::uuid[]) AND i.owner_id IS NULL', [p.id, v.imageIds]); // never a customer's own image
      return p.id as string;
    }));
    await audit(req, 'catalog.package_created', 'success', req.user.id, { id, name: v.name });
    return { id };
  }

  // Same fields and checks as a new package. Servers keep the shape and price they were ordered with.
  @Put('packages/:id') @Can('catalog.manage')
  async updatePackage(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const v = readPackage(body);
    const found = await guarded(() => inTransaction(async (client) => {
      const { rowCount } = await client.query(`UPDATE packages SET name=$2, vcpu=$3, memory_mb=$4, disk_gb=$5, price_monthly=$6, price_hourly=$7, currency=$8, sort=$9,
        active=$10, traffic_gb=$11 WHERE id=$1`, [id, v.name, v.vcpu, v.memoryMb, v.diskGb, v.priceMonthly, v.priceHourly, v.currency, v.sort, v.active, v.trafficGb]);
      if (!rowCount) return false;
      await client.query('DELETE FROM package_pools WHERE package_id = $1', [id]);
      await client.query('DELETE FROM package_images WHERE package_id = $1', [id]);
      await client.query('INSERT INTO package_pools SELECT $1, unnest($2::uuid[])', [id, v.poolIds]);
      await client.query('INSERT INTO package_images SELECT $1, i.id FROM os_images i WHERE i.id = ANY($2::uuid[]) AND i.owner_id IS NULL', [id, v.imageIds]);
      return true;
    }));
    if (!found) throw apiError(404, 'NOT_FOUND', 'Unknown package');
    await audit(req, 'catalog.package_updated', 'success', req.user.id, { id, name: v.name });
    return { id };
  }

  @Delete('packages/:id') @HttpCode(204) @Can('catalog.manage')
  async deletePackage(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await guarded(() => pool.query('DELETE FROM packages WHERE id = $1', [id]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown package');
    await audit(req, 'catalog.package_deleted', 'success', req.user.id, { id });
  }

  @Get('ip-pools') @Can('catalog.view', 'catalog.manage', 'dashboard.view')
  async ipPools() {
    const { rows } = await pool.query(`SELECT i.id, i.name, i.pool_id AS "poolId", p.name AS "poolName", host(i.gateway) AS gateway, i.cidr::text AS cidr,
      host(i.range_start) AS "rangeStart", host(i.range_end) AS "rangeEnd", ARRAY(SELECT host(x) FROM unnest(i.dns) x) AS dns,
      ARRAY(SELECT host(x) FROM unnest(i.excluded) x) AS excluded,
      (i.range_end - i.range_start + 1 - (SELECT count(*) FROM unnest(i.excluded) x WHERE x BETWEEN i.range_start AND i.range_end))::int AS size,
      i.quarantine_hours AS "quarantineHours", i.ipv6_prefix::text AS "ipv6Prefix", host(i.ipv6_gateway) AS "ipv6Gateway",
      (SELECT count(*)::int FROM ip_allocations a WHERE a.ip_pool_id = i.id AND family(a.address) = 4) AS used,
      (SELECT count(*)::int FROM ip_quarantine q WHERE q.ip_pool_id = i.id AND q.available_at > now() AND family(q.address) = 4) AS quarantined
      FROM ip_pools i JOIN resource_pools p ON p.id = i.pool_id ORDER BY i.name`);
    return { ipPools: rows };
  }

  // Every address that is not simply free: in use (with server, owner, kind, PTR), in quarantine, or excluded.
  @Get('ip-addresses') @Can('catalog.view', 'catalog.manage', 'servers.view_all')
  async ipAddresses(@Query('ipPoolId') ipPoolId?: string) {
    const only = ipPoolId && /^[0-9a-f-]{36}$/.test(ipPoolId) ? ipPoolId : null;
    const { rows } = await pool.query(`
      SELECT host(a.address) AS address, a.ip_pool_id AS "ipPoolId", 'used' AS state, a.kind, a.ptr, s.id AS "serverId", s.name AS "serverName", u.email AS owner,
        a.allocated_at AS since, NULL::timestamptz AS until
        FROM ip_allocations a JOIN servers s ON s.id = a.server_id JOIN users u ON u.id = s.owner_id WHERE ($1::uuid IS NULL OR a.ip_pool_id = $1)
      UNION ALL
      SELECT host(q.address), q.ip_pool_id, 'quarantine', NULL, NULL, NULL, q.server_name, NULL, q.released_at, q.available_at
        FROM ip_quarantine q WHERE q.available_at > now() AND ($1::uuid IS NULL OR q.ip_pool_id = $1)
      UNION ALL
      SELECT host(x), i.id, 'excluded', NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM ip_pools i, unnest(i.excluded) x WHERE ($1::uuid IS NULL OR i.id = $1)
      ORDER BY 1`, [only]);
    return { addresses: rows };
  }

  // Hands a quarantined address back early (for example the same customer wants it again).
  @Delete('ip-quarantine/:address') @HttpCode(204) @Can('catalog.manage')
  async releaseQuarantine(@Req() req: AuthedRequest, @Param('address') address: string) {
    const { rowCount } = await guarded(() => pool.query('DELETE FROM ip_quarantine WHERE address = $1::inet', [address]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Not in quarantine');
    await audit(req, 'catalog.ip_quarantine_released', 'success', req.user.id, { address });
  }

  // Quarantine length, IPv6, DNS servers and excluded addresses; the range itself stays as created.
  @Put('ip-pools/:id') @Can('catalog.manage')
  async updateIpPool(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const f = new Fields(body);
    const v = { quarantineHours: f.int('quarantineHours', 0, 8760, 24), ...readIpv6(body, f),
      dns: Array.isArray(body.dns) ? body.dns.map(String) : [], excluded: Array.isArray(body.excluded) ? body.excluded.map(String) : [] };
    f.done();
    const { rowCount } = await guarded(() => pool.query(`UPDATE ip_pools SET quarantine_hours = $2, ipv6_prefix = $3::cidr, ipv6_gateway = $4::inet, dns = $5::inet[], excluded = $6::inet[]
      WHERE id = $1`, [id, v.quarantineHours, v.ipv6Prefix, v.ipv6Gateway, v.dns, v.excluded]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown IP pool');
    await audit(req, 'catalog.ip_pool_updated', 'success', req.user.id, { id, quarantineHours: v.quarantineHours, ipv6: !!v.ipv6Prefix });
    return { id };
  }

  // IPv4 only for now. Ranges on the same resource-pool network must not overlap.
  @Post('ip-pools') @HttpCode(201) @Can('catalog.manage')
  async createIpPool(@Req() req: AuthedRequest, @Body() body: Input) {
    const f = new Fields(body);
    const v = { name: f.text('name'), poolId: f.text('poolId', 36), cidr: f.text('cidr', 43), gateway: f.text('gateway', 39),
      rangeStart: f.text('rangeStart', 39), rangeEnd: f.text('rangeEnd', 39),
      dns: Array.isArray(body.dns) ? body.dns.map(String) : [], excluded: Array.isArray(body.excluded) ? body.excluded.map(String) : [],
      quarantineHours: f.int('quarantineHours', 0, 8760, 24), ...readIpv6(body, f) };
    f.done();
    const id = await guarded(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ip_pools'))"); // serialize overlap checks
        const { rows: [overlap] } = await client.query(`SELECT name FROM ip_pools WHERE pool_id = $1 AND range_start <= $3::inet AND range_end >= $2::inet`,
          [v.poolId, v.rangeStart, v.rangeEnd]);
        if (overlap) throw apiError(409, 'VALIDATION_FAILED', 'Overlapping range', { range: 'RANGE_OVERLAPS' }, { overlaps: overlap.name });
        const { rows: [i] } = await client.query(`INSERT INTO ip_pools (name, pool_id, cidr, gateway, dns, range_start, range_end, excluded, quarantine_hours, ipv6_prefix, ipv6_gateway)
          VALUES ($1, $2, $3::cidr, $4::inet, $5::inet[], $6::inet, $7::inet, $8::inet[], $9, $10::cidr, $11::inet) RETURNING id`,
          [v.name, v.poolId, v.cidr, v.gateway, v.dns, v.rangeStart, v.rangeEnd, v.excluded, v.quarantineHours, v.ipv6Prefix, v.ipv6Gateway]);
        await client.query('COMMIT');
        return i.id;
      } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    });
    await audit(req, 'catalog.ip_pool_created', 'success', req.user.id, { id, name: v.name });
    return { id };
  }

  @Delete('ip-pools/:id') @HttpCode(204) @Can('catalog.manage')
  async deleteIpPool(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await guarded(() => pool.query('DELETE FROM ip_pools WHERE id = $1', [id]));
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown IP pool');
    await audit(req, 'catalog.ip_pool_deleted', 'success', req.user.id, { id });
  }

  // The default row, the users' own and the projects' own. email: the user, or the project's owner; projectName only
  // on a project's row. usage: what counts against that row today (a user: all their servers outside data centers; a
  // project: its own; counted as usageOf counts, an open resize with the size it grows to), null for the default. A quota whose project is gone is not listed (deleteProject removes it).
  @Get('quotas') @Can('catalog.view', 'catalog.manage')
  async quotas() {
    const { rows } = await pool.query(`SELECT q.scope, q.subject_id AS "subjectId", u.email, p.name AS "projectName", p.owner_id AS "ownerId", q.max_servers AS "maxServers", q.max_vcpu AS "maxVcpu",
      q.max_memory_mb AS "maxMemoryMb", q.max_disk_gb AS "maxDiskGb",
      CASE WHEN q.scope = 'default' THEN NULL ELSE (SELECT json_build_object('servers', count(*)::int, 'vcpu', ${usedSums.vcpu}, 'memoryMb', ${usedSums.memoryMb}, 'diskGb', ${usedSums.diskGb})
        FROM servers ${openResize()} WHERE state <> 'deleted' AND vdc_id IS NULL AND (CASE WHEN q.scope = 'project' THEN project_id = q.subject_id ELSE owner_id = q.subject_id END)) END AS usage
      FROM quotas q LEFT JOIN projects p ON q.scope = 'project' AND p.id = q.subject_id LEFT JOIN users u ON u.id = COALESCE(p.owner_id, q.subject_id)
      WHERE q.scope <> 'project' OR p.id IS NOT NULL ORDER BY q.scope, u.email, p.name`);
    return { quotas: rows };
  }

  // Every project with its owner, for the picker of the quota form.
  @Get('quotas/projects') @Can('catalog.view', 'catalog.manage')
  async quotaProjects() {
    const { rows } = await pool.query(`SELECT p.id, p.name, p.owner_id AS "ownerId", u.email,
      (SELECT count(*)::int FROM servers s WHERE s.project_id = p.id AND s.state <> 'deleted') AS servers FROM projects p JOIN users u ON u.id = p.owner_id ORDER BY u.email, p.name LIMIT 5000`);
    return { projects: rows };
  }

  // A project's own quota: it replaces the owner's limits for servers ordered into that project and counts only that
  // project's servers (limitsFor, usageOf). It can be wider or narrower than the owner's, so staff set it, not the owner.
  @Put('quotas/projects/:id') @Can('catalog.manage')
  async setProjectQuota(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const l = readLimits(body);
    const { rows: [p] } = await pool.query('SELECT owner_id FROM projects WHERE id = $1', [id]);
    if (!p) throw apiError(404, 'NOT_FOUND', 'Unknown project');
    await guarded(() => pool.query(`INSERT INTO quotas (scope, subject_id, max_servers, max_vcpu, max_memory_mb, max_disk_gb) SELECT 'project', id, $2, $3, $4, $5 FROM projects WHERE id = $1
      ON CONFLICT (scope, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000')) DO UPDATE
      SET max_servers=EXCLUDED.max_servers, max_vcpu=EXCLUDED.max_vcpu, max_memory_mb=EXCLUDED.max_memory_mb, max_disk_gb=EXCLUDED.max_disk_gb`,
      [id, l.max_servers, l.max_vcpu, l.max_memory_mb, l.max_disk_gb]));
    await audit(req, 'catalog.quota_set', 'success', req.user.id, { scope: 'project', subjectId: id, ownerId: p.owner_id, ...l });
    return l;
  }

  // The project goes back to its owner's quota (their own, or the default with their role's limits).
  @Delete('quotas/projects/:id') @HttpCode(204) @Can('catalog.manage')
  async removeProjectQuota(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query("DELETE FROM quotas WHERE scope = 'project' AND subject_id = $1", [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'This project has no quota of its own');
    await audit(req, 'catalog.quota_removed', 'success', req.user.id, { scope: 'project', subjectId: id });
  }

  @Put('quotas/default') @Can('catalog.manage')
  async setDefaultQuota(@Req() req: AuthedRequest, @Body() body: Input) {
    const l = readLimits(body);
    await pool.query("UPDATE quotas SET max_servers=$1, max_vcpu=$2, max_memory_mb=$3, max_disk_gb=$4 WHERE scope='default'",
      [l.max_servers, l.max_vcpu, l.max_memory_mb, l.max_disk_gb]);
    await audit(req, 'catalog.quota_set', 'success', req.user.id, { scope: 'default', ...l });
    return l;
  }

  @Put('quotas/users/:id') @Can('catalog.manage')
  async setUserQuota(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const l = readLimits(body);
    await guarded(() => pool.query(`INSERT INTO quotas (scope, subject_id, max_servers, max_vcpu, max_memory_mb, max_disk_gb) VALUES ('user', $1, $2, $3, $4, $5)
      ON CONFLICT (scope, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000')) DO UPDATE
      SET max_servers=EXCLUDED.max_servers, max_vcpu=EXCLUDED.max_vcpu, max_memory_mb=EXCLUDED.max_memory_mb, max_disk_gb=EXCLUDED.max_disk_gb`,
      [id, l.max_servers, l.max_vcpu, l.max_memory_mb, l.max_disk_gb]));
    await audit(req, 'catalog.quota_set', 'success', req.user.id, { scope: 'user', subjectId: id, ...l });
    return l;
  }

  // The user goes back to the default quota (and their role's limits).
  @Delete('quotas/users/:id') @HttpCode(204) @Can('catalog.manage')
  async removeUserQuota(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query("DELETE FROM quotas WHERE scope = 'user' AND subject_id = $1", [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'This user has no quota of their own');
    await audit(req, 'catalog.quota_removed', 'success', req.user.id, { scope: 'user', subjectId: id });
  }
}


export type Order = { rp: Record<string, unknown>; shape: Shape; price: { monthly: string; currency: string }; extraIpv4: number; application: Application | null; packageId: string | null; imageId: string | null; trafficGb: number | null };
// Validates the chosen pool, package or custom shape and image, and prices it. Shared by quote and create.
export async function resolveOrder(poolId: string, body: Input, allowedLocations?: string[]): Promise<Order> {
    const { rows: [rp] } = await pool.query(`SELECT r.*, l.status AS location_status FROM resource_pools r LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.id = $1 AND r.active`, [poolId]).catch(() => ({ rows: [] }));
    if (!rp) throw apiError(400, 'VALIDATION_FAILED', 'Unknown pool', { poolId: 'NOT_AVAILABLE' });
    // A location under maintenance (or hidden) takes no new servers; existing ones keep running.
    if (rp.location_status && rp.location_status !== 'active') throw apiError(409, 'LOCATION_UNAVAILABLE', 'This location takes no new servers right now');
    // The member's role may limit where they order.
    if (allowedLocations && !allowedLocations.includes(rp.location_id)) throw apiError(403, 'LOCATION_NOT_ALLOWED', 'Your role cannot order in this location', { poolId: 'LOCATION_NOT_ALLOWED' });

    let shape: Shape; let price: { monthly: string; currency: string };
    let trafficGb: number | null = (rp.traffic_gb as number | null) ?? null; // custom shapes: the location's allowance
    if (body.type === 'package') {
      const { rows: [p] } = await pool.query(`SELECT p.vcpu, p.memory_mb, p.disk_gb, p.price_monthly::text, p.currency, p.traffic_gb FROM packages p
        JOIN package_pools pp ON pp.package_id = p.id AND pp.pool_id = $2 WHERE p.id = $1 AND p.active`, [body.packageId, poolId]).catch(() => ({ rows: [] }));
      if (!p) throw apiError(400, 'VALIDATION_FAILED', 'Package not offered here', { packageId: 'NOT_AVAILABLE' });
      shape = { vcpu: p.vcpu, memoryMb: p.memory_mb, diskGb: p.disk_gb };
      price = { monthly: p.price_monthly, currency: p.currency };
      trafficGb = p.traffic_gb;
    } else if (body.type === 'custom') {
      const { rows: [rule] } = await pool.query('SELECT * FROM custom_rules WHERE pool_id = $1 AND active', [poolId]);
      if (!rule) throw apiError(400, 'VALIDATION_FAILED', 'No custom offering', { poolId: 'NO_CUSTOM_OFFERING' });
      shape = { vcpu: Number(body.vcpu), memoryMb: Number(body.memoryMb), diskGb: Number(body.diskGb) };
      const fields = checkCustom(rule, shape);
      if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Not allowed', fields);
      // Priced in PostgreSQL numeric: no binary floating point in money.
      const { rows: [q] } = await pool.query('SELECT ($1::int * price_vcpu + $2::numeric / 1024 * price_memory_gb + $3::int * price_disk_gb)::numeric(12,2)::text AS monthly FROM custom_rules WHERE pool_id = $4',
        [shape.vcpu, shape.memoryMb, shape.diskGb, poolId]);
      price = { monthly: q.monthly, currency: rule.currency };
    } else {
      throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { type: 'INVALID_VALUE' });
    }
    if (body.imageId !== undefined && body.imageId !== null) {
      // A package limited to some images (package_images) is sold with those only, as a reinstall also checks.
      const { rows: [img] } = await pool.query(`SELECT i.min_disk_gb FROM os_images i WHERE i.id = $1 AND i.active AND (NOT EXISTS (SELECT 1 FROM package_images pi WHERE pi.package_id = $2)
        OR EXISTS (SELECT 1 FROM package_images pi WHERE pi.package_id = $2 AND pi.image_id = i.id))`, [body.imageId, body.type === 'package' ? body.packageId : null]).catch(() => ({ rows: [] }));
      if (!img) throw apiError(400, 'VALIDATION_FAILED', 'Unknown image', { imageId: 'NOT_AVAILABLE' });
      if (shape.diskGb < img.min_disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Disk too small', { diskGb: 'BELOW_IMAGE_MINIMUM' });
    }
    // Extra IPv4 addresses, if this location sells them; their price is added to the monthly total.
    const extraIpv4 = body.extraIpv4 === undefined || body.extraIpv4 === null || body.extraIpv4 === '' ? 0 : Number(body.extraIpv4);
    if (!Number.isInteger(extraIpv4) || extraIpv4 < 0 || extraIpv4 > Number(rp.extra_ipv4_max)) throw apiError(400, 'VALIDATION_FAILED', 'Not allowed', { extraIpv4: 'OUT_OF_RANGE' });
    if (extraIpv4) {
      const { rows: [t] } = await pool.query('SELECT ($1::numeric + $2::int * $3::numeric)::numeric(12,2)::text AS monthly', [price.monthly, extraIpv4, rp.extra_ipv4_price]);
      price = { ...price, monthly: t.monthly };
    }
    // An application to install (cPanel, Plesk, ...): Linux images only, enough memory and disk, its price added.
    let application: Application | null = null;
    if (body.applicationId) {
      const { rows: [a] } = await pool.query('SELECT * FROM applications WHERE id = $1 AND active', [body.applicationId]).catch(() => ({ rows: [] }));
      if (!a) throw apiError(400, 'VALIDATION_FAILED', 'Unknown application', { applicationId: 'NOT_AVAILABLE' });
      if (shape.memoryMb < a.min_memory_mb || shape.diskGb < a.min_disk_gb) throw apiError(400, 'VALIDATION_FAILED', 'Too small', { applicationId: 'APP_NEEDS_MORE' });
      if (body.imageId) {
        const { rows: [img] } = await pool.query('SELECT family FROM os_images WHERE id = $1', [body.imageId]);
        if (img?.family !== 'linux') throw apiError(400, 'VALIDATION_FAILED', 'Linux only', { applicationId: 'APP_NEEDS_LINUX' });
      }
      const { rows: [t] } = await pool.query('SELECT ($1::numeric + $2::numeric)::numeric(12,2)::text AS monthly', [price.monthly, a.price_monthly]);
      price = { ...price, monthly: t.monthly };
      application = a;
    }
  return { rp, shape, price, extraIpv4, application, packageId: body.type === 'package' ? String(body.packageId) : null, imageId: body.imageId ? String(body.imageId) : null, trafficGb };
}

// Whose limits limitsFor gave: a project's own quota, or the account's (the user's own, or the default with the role's).
export const quotaScope = (l: Limits): 'project' | 'account' => ((l as Limits & { scope?: string }).scope === 'project' ? 'project' : 'account');
// The refusal when something does not fit them. A project's quota has its own code, so the page can say which
// quota it is (the fields say which limits: servers, vcpu, memoryMb, diskGb, or the input that asked for too much).
export function quotaExceeded(limits: Limits, over: string[], fields?: Record<string, string>) {
  const project = quotaScope(limits) === 'project';
  return apiError(409, project ? 'PROJECT_QUOTA_EXCEEDED' : 'QUOTA_EXCEEDED', project ? 'The quota of this project is exceeded' : 'Quota exceeded', fields ?? Object.fromEntries(over.map((o) => [o, 'QUOTA_EXCEEDED'])));
}
const camelLimits = (l: Limits) => ({ maxServers: l.max_servers, maxVcpu: l.max_vcpu, maxMemoryMb: l.max_memory_mb, maxDiskGb: l.max_disk_gb });

// Effective limits: project override, else user override, else the role's limits over the default row.
export async function limitsFor(userId: string, projectId?: string, db: Db = pool): Promise<Limits> {
  const { rows } = await db.query(`SELECT scope, max_servers, max_vcpu, max_memory_mb, max_disk_gb FROM quotas
    WHERE scope = 'default' OR (scope = 'user' AND subject_id = $1) OR (scope = 'project' AND subject_id = $2)`, [userId, projectId ?? null]);
  const own = rows.find((r) => r.scope === 'project') ?? rows.find((r) => r.scope === 'user');
  if (own) return own;
  const d = rows.find((r) => r.scope === 'default');
  await ensureRoles();
  const { rows: [u] } = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
  const r = limitsOf(u?.role);
  return { max_servers: r.maxServers ?? d.max_servers, max_vcpu: r.maxVcpu ?? d.max_vcpu, max_memory_mb: r.maxMemoryMb ?? d.max_memory_mb, max_disk_gb: r.maxDiskGb ?? d.max_disk_gb };
}

@Controller() @UseGuards(SessionGuard)
export class CatalogController {
  // quota: the project's own quota when staff gave it one (limits, null = unlimited) with what its servers use of it;
  // null: the account's quota applies to it.
  @Get('projects')
  async projects(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT p.id, p.name, p.created_at AS "createdAt",
      (SELECT count(*)::int FROM servers s WHERE s.project_id = p.id AND s.state <> 'deleted') AS servers,
      (SELECT row_to_json(q) FROM (SELECT max_servers, max_vcpu, max_memory_mb, max_disk_gb FROM quotas WHERE scope = 'project' AND subject_id = p.id) q) AS quota
      FROM projects p WHERE p.owner_id = $1 ORDER BY p.name`, [req.user.id]);
    return { projects: await Promise.all(rows.map(async (p) => ({ ...p, quota: p.quota ? { ...camelLimits(p.quota), usage: await usageOf(req.user.id, p.id) } : null }))) };
  }

  @Post('projects') @HttpCode(201)
  async createProject(@Req() req: AuthedRequest, @Body() body: Input) {
    const f = new Fields(body);
    const name = f.text('name');
    f.done();
    const { rows: [p] } = await guarded(() => pool.query('INSERT INTO projects (owner_id, name) VALUES ($1, $2) RETURNING id, name', [req.user.id, name]));
    await audit(req, 'project.created', 'success', req.user.id, { id: p.id });
    return p;
  }

  // Ownership is checked in the query itself: knowing another user's project id is not enough.
  @Delete('projects/:id') @HttpCode(204)
  async deleteProject(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown project');
    // Its own quota goes with it (the servers stay, without a project, under the account's quota).
    const { rowCount: quota } = await pool.query("DELETE FROM quotas WHERE scope = 'project' AND subject_id = $1", [id]);
    await audit(req, 'project.deleted', 'success', req.user.id, { id, ...(quota && { quotaRemoved: true }) });
  }

  // What a customer may order: active packages and active pools' custom offerings. No internals.
  @Get('catalog')
  async catalog(@Req() req: AuthedRequest) {
    const only = limitsOf(req.user.roles.join(',')).allowedLocations;
    const [packages, pools, images, applications, locations] = await Promise.all([
      pool.query(`SELECT p.id, p.name, p.vcpu, p.memory_mb AS "memoryMb", p.disk_gb AS "diskGb", p.price_monthly::text AS "priceMonthly",
        p.price_hourly::text AS "priceHourly", p.currency, p.traffic_gb AS "trafficGb",
        ARRAY(SELECT pp.pool_id FROM package_pools pp JOIN resource_pools r ON r.id = pp.pool_id AND r.active WHERE pp.package_id = p.id) AS "poolIds",
        ARRAY(SELECT pi.image_id FROM package_images pi JOIN os_images i ON i.id = pi.image_id AND i.active WHERE pi.package_id = p.id) AS "imageIds"
        FROM packages p WHERE p.active ORDER BY p.sort, p.name`),
      pool.query(`SELECT r.id, r.name, r.location, r.location_id AS "locationId", CASE WHEN c.active THEN json_build_object('cpuMin', c.cpu_min, 'cpuMax', c.cpu_max, 'cpuStep', c.cpu_step,
        'memoryMinMb', c.memory_min_mb, 'memoryMaxMb', c.memory_max_mb, 'memoryStepMb', c.memory_step_mb, 'diskMinGb', c.disk_min_gb, 'diskMaxGb', c.disk_max_gb,
        'diskStepGb', c.disk_step_gb, 'minMemoryMbPerVcpu', c.min_memory_mb_per_vcpu, 'maxMemoryMbPerVcpu', c.max_memory_mb_per_vcpu,
        'priceVcpu', c.price_vcpu::text, 'priceMemoryGb', c.price_memory_gb::text, 'priceDiskGb', c.price_disk_gb::text, 'currency', c.currency) END AS custom,
        r.extra_ipv4_max AS "extraIpv4Max", r.extra_ipv4_price::text AS "extraIpv4Price", r.traffic_gb AS "trafficGb",
        EXISTS (SELECT 1 FROM ip_pools i WHERE i.pool_id = r.id AND i.ipv6_prefix IS NOT NULL) AS ipv6,
        (SELECT json_build_object('kind', x.kind, 'operations', x.operations) FROM vmware_connections x WHERE x.id = r.connection_id) AS platform
        FROM resource_pools r LEFT JOIN custom_rules c ON c.pool_id = r.id LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.active AND (l.status IS NULL OR l.status <> 'hidden') ORDER BY r.name`),
      // The images everyone gets, and this person's own (personal images, images.ts).
      // poolIds: the locations an image can be ordered in (those of its own connection), as the order itself checks.
      pool.query(`SELECT i.id, i.name, i.family, i.min_disk_gb AS "minDiskGb", i.owner_id IS NOT NULL AS own,
        ARRAY(SELECT r.id FROM resource_pools r WHERE r.active AND r.connection_id = i.connection_id) AS "poolIds"
        FROM os_images i WHERE i.active AND (i.owner_id IS NULL OR i.owner_id = $1) ORDER BY i.owner_id IS NULL DESC, i.name`, [req.user.id]),
      pool.query(`SELECT id, name, kind, description, min_memory_mb AS "minMemoryMb", min_disk_gb AS "minDiskGb", price_monthly::text AS "priceMonthly",
        (license_mode = 'none' OR EXISTS (SELECT 1 FROM application_licenses l WHERE l.application_id = a.id AND l.server_id IS NULL)) AS available
        FROM applications a WHERE active ORDER BY name`),
      pool.query(`SELECT ${locationColumns} FROM locations l WHERE l.status <> 'hidden'
        AND EXISTS (SELECT 1 FROM resource_pools r WHERE r.location_id = l.id AND r.active) ORDER BY l.sort, l.name`),
    ]);
    const pools2 = (only ? pools.rows.filter((p) => only.includes(p.locationId)) : pools.rows).map(({ platform, ...p }) => ({ ...p, capabilities: capabilitiesOf(platform?.kind ?? '', platform?.operations) }));
    return { packages: packages.rows, pools: pools2, images: images.rows, applications: applications.rows, locations: only ? locations.rows.filter((l) => only.includes(l.id)) : locations.rows };
  }

  // For the order page: which packages of a location can be ordered right now by this user, and if not, why
  // (no capacity there, over the user's quota). The API checks again on create.
  @Get('catalog/availability')
  async availability(@Req() req: AuthedRequest, @Query('poolId') poolId?: string, @Query('projectId') project?: string) {
    const { rows: [rp] } = await pool.query('SELECT * FROM resource_pools WHERE id = $1 AND active', [poolId]).catch(() => ({ rows: [] }));
    if (!rp) throw apiError(404, 'NOT_FOUND', 'Unknown pool');
    // The project the order is for, when it is the caller's: its own quota (if it has one) decides instead of the account's.
    const projectId = project && (await pool.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2', [project, req.user.id]).catch(() => ({ rowCount: 0 }))).rowCount ? project : undefined;
    const [cap, limits, usage, { rows: pkgs }] = await Promise.all([capacityOf(rp), limitsFor(req.user.id, projectId), usageOf(req.user.id, projectId),
      pool.query('SELECT p.id, p.vcpu, p.memory_mb, p.disk_gb FROM packages p JOIN package_pools pp ON pp.package_id = p.id AND pp.pool_id = $1 WHERE p.active', [rp.id])]);
    const packages = Object.fromEntries(pkgs.map((p) => {
      const shape = { vcpu: p.vcpu, memoryMb: p.memory_mb, diskGb: p.disk_gb };
      const capacity = shape.vcpu <= cap.available.vcpu && shape.memoryMb <= cap.available.memoryMb && shape.diskGb <= cap.available.storageGb;
      return [p.id, { capacity, quota: exceededQuota(limits, usage, shape) }];
    }));
    return { packages, available: cap.available };
  }

  // Validates an order on the server and prices it. Creating the server comes with provisioning.
  @Post('catalog/quote') @HttpCode(200) @TokenOpen()
  async quote(@Req() req: AuthedRequest, @Body() body: Input) {
    const f = new Fields(body);
    const poolId = f.text('poolId', 36);
    const projectId = body.projectId === undefined ? undefined : f.text('projectId', 36);
    f.done();
    if (projectId) {
      const { rowCount } = await pool.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2', [projectId, req.user.id]).catch(() => ({ rowCount: 0 }));
      if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown project');
    }
    const { rp, shape, price, packageId, imageId } = await resolveOrder(poolId as string, body, limitsOf(req.user.roles.join(',')).allowedLocations);
    // The same rule as the order itself (servers.ts): the image is the catalog's or the person's own, on this location's connection.
    if (imageId && !(await pool.query('SELECT 1 FROM os_images WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2) AND connection_id = $3', [imageId, req.user.id, rp.connection_id])).rowCount) {
      throw apiError(400, 'VALIDATION_FAILED', 'Unknown image', { imageId: 'NOT_AVAILABLE' });
    }
    const limits = await limitsFor(req.user.id, projectId);
    const usage = await usageOf(req.user.id, projectId);
    const over = exceededQuota(limits, usage, shape);
    const cap = await capacityOf(rp);
    const fits = shape.vcpu <= cap.available.vcpu && shape.memoryMb <= cap.available.memoryMb && shape.diskGb <= cap.available.storageGb;
    // The budget after this order, so the page can warn before it is placed (never a block).
    const current = await budgetState(req.user.id);
    const budget = current && price.currency.trim() === current.currency ? await budgetState(req.user.id, Number(price.monthly)) : current;
    // A coupon typed in: its first price and how many invoices it covers, or why it does not apply (shown at the field).
    const coupon = typeof body.coupon === 'string' && body.coupon.trim()
      ? await checkCoupon(pool, body.coupon, req.user.id, { packageId, monthly: price.monthly, currency: price.currency })
        .then((c) => ({ code: c.code, monthly: c.monthly, periods: c.periods }), (e: unknown) => {
          if (!(e instanceof HttpException)) throw e;
          return { error: (e.getResponse() as { fields?: Record<string, string> }).fields?.coupon ?? 'COUPON_UNKNOWN' };
        })
      : null;
    // scope: whose quota this is ('project': the chosen project's own; 'account': the caller's). usage: what counts against it now.
    return { shape, price, quota: { limits, exceeded: over, usage, scope: quotaScope(limits) }, capacityAvailable: fits, budget, coupon };
  }
}
