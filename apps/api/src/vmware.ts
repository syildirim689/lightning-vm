import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { apiError } from './errors';
import { AdminGuard, audit, type AuthedRequest } from './auth';
import { decryptSecret, encryptSecret } from './secrets';

type TlsSettings = { mode: 'system' | 'ca' | 'pinned'; caPem?: string; sha256?: string };
type Target = { host: string; port: number; username: string; password: string; tls: TlsSettings };
type Discovery = {
  product: { kind: 'esxi' | 'vcenter'; instanceUuid: string } & Record<string, string>;
  licenses: unknown[]; writeApi: string; privileges: Record<string, boolean>; operations: Record<string, boolean>; warnings: string[];
  hosts: { hardwareUuid: string; name: string }[]; datastores: unknown[]; networks: unknown[]; compute: unknown[]; vms: unknown[];
};

const hostnamePattern = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Server-side validation of an ESXi/vCenter target; field codes are translated by the web UI.
function readTarget(body: unknown, requirePassword = true): Target & { name: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const tls = (b.tls ?? { mode: 'system' }) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const port = b.port === undefined || b.port === '' ? 443 : Number(b.port);
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) fields.name = 'INVALID_VALUE';
  if (typeof b.host !== 'string' || !(isIP(b.host) || hostnamePattern.test(b.host))) fields.host = 'INVALID_HOST';
  if (!Number.isInteger(port) || port < 1 || port > 65535) fields.port = 'INVALID_PORT';
  if (typeof b.username !== 'string' || !b.username || b.username.length > 200) fields.username = 'INVALID_VALUE';
  if (requirePassword && (typeof b.password !== 'string' || !b.password || b.password.length > 500)) fields.password = 'INVALID_VALUE';
  if (!['system', 'ca', 'pinned'].includes(tls.mode as string)) fields.tlsMode = 'INVALID_VALUE';
  if (tls.mode === 'ca' && (typeof tls.caPem !== 'string' || !tls.caPem.includes('BEGIN CERTIFICATE') || tls.caPem.length > 20000)) fields.caPem = 'INVALID_CERTIFICATE';
  if (tls.mode === 'pinned' && (typeof tls.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tls.sha256))) fields.sha256 = 'INVALID_FINGERPRINT';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return {
    name: (b.name as string).trim(), host: (b.host as string).toLowerCase(), port, username: b.username as string, password: (b.password as string) ?? '',
    tls: { mode: tls.mode as TlsSettings['mode'], ...(tls.mode === 'ca' && { caPem: tls.caPem as string }), ...(tls.mode === 'pinned' && { sha256: tls.sha256 as string }) },
  };
}

// Calls the internal Go adapter. Its failure code (and the untrusted certificate, if any) is passed on.
async function discover(target: Target): Promise<Discovery> {
  let token: string;
  try { token = readFileSync(process.env.VMWARE_SERVICE_TOKEN_FILE ?? '/run/secrets/vmware_token', 'utf8').trim(); }
  catch { throw apiError(503, 'VMWARE_SERVICE_UNAVAILABLE', 'Service token missing'); }
  const res = await fetch(`${process.env.VMWARE_SERVICE_URL ?? 'http://vmware:8080'}/v1/discover`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(target), signal: AbortSignal.timeout(70_000),
  }).catch(() => { throw apiError(503, 'VMWARE_SERVICE_UNAVAILABLE', 'VMware adapter unreachable'); });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw apiError(422, body?.code ?? 'VMWARE_ERROR', body?.message ?? 'Discovery failed', undefined, body?.certificate ? { certificate: body.certificate } : undefined);
  return body;
}

function summary(d: Discovery) {
  return { product: d.product, writeApi: d.writeApi, operations: d.operations, warnings: d.warnings,
    counts: { hosts: d.hosts.length, datastores: d.datastores.length, networks: d.networks.length, compute: d.compute.length, vms: d.vms.length } };
}

const recordsets = {
  vmware_hosts: `moref text, name text, "hardwareUuid" text, vendor text, model text, "cpuMhz" int, "cpuCores" int, "cpuThreads" int, "memoryBytes" bigint,
    "connectionState" text, "powerState" text, "inMaintenance" boolean, version text, "managementServer" text, parent text`,
  vmware_datastores: `moref text, name text, type text, "capacityBytes" bigint, "freeBytes" bigint, "uncommittedBytes" bigint, accessible boolean, "maintenanceMode" text, hosts text[]`,
  vmware_networks: 'moref text, name text, kind text, vlan int, switch text',
  vmware_compute: `moref text, name text, kind text, hosts int, "effectiveCpuMhz" int, "effectiveMemoryMb" bigint, "resourcePool" text`,
  vmware_vms: `moref text, name text, uuid text, "instanceUuid" text, "powerState" text, host text, cpu int, "memoryMb" int, template boolean, guest text,
    "committedBytes" bigint, "uncommittedBytes" bigint`,
};

// Replaces one connection's cached inventory. A host already counted through another connection
// is refused, and the unique index makes that hold under concurrent requests too.
async function storeInventory(client: PoolClient, id: string, d: Discovery) {
  // A host without hardware details (for example disconnected) gets a per-connection placeholder id.
  d.hosts = d.hosts.map((h) => ({ ...h, hardwareUuid: h.hardwareUuid || `unknown:${id}:${(h as { moref?: string }).moref}` }));
  const uuids = d.hosts.map((h) => h.hardwareUuid);
  const { rows: clashes } = await client.query(
    `SELECT h.name AS host, c.name AS connection FROM vmware_hosts h JOIN vmware_connections c ON c.id = h.connection_id
     WHERE h.hardware_uuid = ANY($1) AND h.connection_id <> $2`, [uuids, id]);
  if (clashes.length) throw apiError(409, 'HOSTS_ALREADY_MANAGED', 'Hosts are already counted through another connection', undefined, { conflicts: clashes });
  for (const table of Object.keys(recordsets)) await client.query(`DELETE FROM ${table} WHERE connection_id = $1`, [id]);
  await client.query(`INSERT INTO vmware_hosts SELECT $1, * FROM json_to_recordset($2) AS x(${recordsets.vmware_hosts})`, [id, JSON.stringify(d.hosts)]);
  await client.query(`INSERT INTO vmware_datastores SELECT $1, * FROM json_to_recordset($2) AS x(${recordsets.vmware_datastores})`, [id, JSON.stringify(d.datastores)]);
  await client.query(`INSERT INTO vmware_networks SELECT $1, * FROM json_to_recordset($2) AS x(${recordsets.vmware_networks})`, [id, JSON.stringify(d.networks)]);
  await client.query(`INSERT INTO vmware_compute SELECT $1, * FROM json_to_recordset($2) AS x(${recordsets.vmware_compute})`, [id, JSON.stringify(d.compute)]);
  await client.query(`INSERT INTO vmware_vms SELECT $1, * FROM json_to_recordset($2) AS x(${recordsets.vmware_vms})`, [id, JSON.stringify(d.vms)]);
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === '23505') {
      if (pg.constraint === 'vmware_hosts_hardware_uuid_key') throw apiError(409, 'HOSTS_ALREADY_MANAGED', 'Hosts are already counted through another connection');
      if (pg.constraint === 'vmware_connections_name_key') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' });
      throw apiError(409, 'CONNECTION_EXISTS', 'This endpoint is already connected');
    }
    throw err;
  } finally {
    client.release();
  }
}

const connectionColumns = `id, name, kind, host, port, username, tls_mode AS "tlsMode", tls_sha256 AS "tlsSha256", product, licenses,
  write_api AS "writeApi", privileges, operations, warnings, status, last_error_code AS "lastErrorCode", last_discovered_at AS "lastDiscoveredAt", created_at AS "createdAt"`;

@Controller('admin/vmware') @UseGuards(AdminGuard)
export class VmwareController {
  // Connects and discovers without saving anything: the wizard's and the form's "Test connection".
  @Post('test') @HttpCode(200)
  async test(@Body() body: unknown) {
    return summary(await discover(readTarget(body)));
  }

  @Get('connections')
  async list() {
    const { rows } = await pool.query(`SELECT ${connectionColumns},
      (SELECT count(*)::int FROM vmware_hosts h WHERE h.connection_id = c.id) AS hosts,
      (SELECT count(*)::int FROM vmware_vms v WHERE v.connection_id = c.id) AS vms
      FROM vmware_connections c ORDER BY name`);
    return { connections: rows };
  }

  @Post('connections') @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const target = readTarget(body);
    const d = await discover(target); // outside any transaction: this can take seconds
    const id = randomUUID();
    await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, tls_ca_pem, tls_sha256, instance_uuid,
           product, licenses, write_api, privileges, operations, warnings, last_discovered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())`,
        [id, target.name, d.product.kind, target.host, target.port, target.username, encryptSecret(target.password, id), target.tls.mode,
          target.tls.caPem ?? null, target.tls.sha256 ?? null, d.product.instanceUuid || null, d.product, JSON.stringify(d.licenses ?? []), d.writeApi,
          d.privileges, d.operations, JSON.stringify(d.warnings)]);
      await storeInventory(client, id, d);
    });
    await audit(req, 'vmware.connection_created', 'success', req.user.id, { id, name: target.name, host: target.host, kind: d.product.kind });
    return { id, ...summary(d) };
  }

  @Get('connections/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const { rows: [connection] } = await pool.query(`SELECT ${connectionColumns} FROM vmware_connections c WHERE id = $1`, [id]);
    if (!connection) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    const [hosts, datastores, networks, compute, vms] = await Promise.all(
      ['vmware_hosts', 'vmware_datastores', 'vmware_networks', 'vmware_compute', 'vmware_vms'].map((t) =>
        pool.query(`SELECT * FROM ${t} WHERE connection_id = $1 ORDER BY name`, [id]).then((r) => r.rows)));
    // Physical figures only; what is reserved, sold or kept back as headroom comes with resource pools.
    const capacity = {
      cpuCores: hosts.reduce((n, h) => n + (h.cpu_cores ?? 0), 0),
      cpuThreads: hosts.reduce((n, h) => n + (h.cpu_threads ?? 0), 0),
      cpuMhz: hosts.reduce((n, h) => n + (h.cpu_mhz ?? 0) * (h.cpu_cores ?? 0), 0),
      memoryBytes: hosts.reduce((n, h) => n + Number(h.memory_bytes ?? 0), 0),
      storageCapacityBytes: datastores.reduce((n, d) => n + Number(d.capacity_bytes), 0),
      storageFreeBytes: datastores.reduce((n, d) => n + Number(d.free_bytes), 0),
      // Thin disks may still grow: provisioned = used + not yet written (uncommitted).
      storageProvisionedBytes: datastores.reduce((n, d) => n + Number(d.capacity_bytes) - Number(d.free_bytes) + Number(d.uncommitted_bytes), 0),
    };
    return { connection, capacity, hosts, datastores, networks, compute, vms };
  }

  @Post('connections/:id/discover') @HttpCode(200)
  async refresh(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    const target: Target = { host: c.host, port: c.port, username: c.username, password: decryptSecret(c.password_enc, id),
      tls: { mode: c.tls_mode, ...(c.tls_ca_pem && { caPem: c.tls_ca_pem }), ...(c.tls_sha256 && { sha256: c.tls_sha256 }) } };
    let d: Discovery;
    try { d = await discover(target); }
    catch (err) {
      const code = (err as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'VMWARE_ERROR';
      await pool.query("UPDATE vmware_connections SET status = 'error', last_error_code = $2, updated_at = now() WHERE id = $1", [id, code]);
      await audit(req, 'vmware.discovery', 'failure', req.user.id, { id, code });
      throw err;
    }
    await inTransaction(async (client) => {
      await client.query(`UPDATE vmware_connections SET status = 'ok', last_error_code = NULL, product = $2, licenses = $3, write_api = $4,
        privileges = $5, operations = $6, warnings = $7, last_discovered_at = now(), updated_at = now() WHERE id = $1`,
        [id, d.product, JSON.stringify(d.licenses ?? []), d.writeApi, d.privileges, d.operations, JSON.stringify(d.warnings)]);
      await storeInventory(client, id, d);
    });
    await audit(req, 'vmware.discovery', 'success', req.user.id, { id });
    return summary(d);
  }

  // Forgets the connection and its cached inventory. Nothing is changed on the ESXi/vCenter side.
  @Delete('connections/:id') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [c] } = await pool.query('DELETE FROM vmware_connections WHERE id = $1 RETURNING name', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    await audit(req, 'vmware.connection_deleted', 'success', req.user.id, { id, name: c.name });
  }
}
