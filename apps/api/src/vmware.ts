import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';

type TlsSettings = { mode: 'system' | 'ca' | 'pinned'; caPem?: string; sha256?: string };
type Target = { host: string; port: number; username: string; password: string; tls: TlsSettings; apiVersion?: string };
type Compat = { apiVersion: string; customization: 'cloudinit' | 'guestinfo' | 'none'; clone: boolean; consoleUrl: boolean; support: string };
type Discovery = {
  product: { kind: 'esxi' | 'vcenter'; instanceUuid: string } & Record<string, string>;
  licenses: unknown[]; writeApi: string; privileges: Record<string, boolean>; operations: Record<string, boolean>; warnings: string[];
  hosts: { hardwareUuid: string; name: string }[]; datastores: unknown[]; networks: unknown[]; compute: unknown[]; vms: unknown[]; compat: Compat;
};
// vSphere API versions an admin may pin (Broadcom API reference per release); empty = what the endpoint reports.
export const apiVersions = ['9.0.0.0', '8.0.3.0', '8.0.2.0', '8.0.1.0', '8.0.0.1', '7.0.3.0', '7.0.2.0', '7.0.1.0', '7.0.0.0', '6.7.3', '6.7.2', '6.7.1', '6.7', '6.5', '6.0'];
const customizations = ['auto', 'cloudinit', 'guestinfo'];

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
  // Editing may leave the password empty (keep the stored one); anything sent is checked the same way.
  const passwordGiven = requirePassword || (b.password !== undefined && b.password !== null && b.password !== '');
  if (passwordGiven && (typeof b.password !== 'string' || !b.password || b.password.length > 500)) fields.password = 'INVALID_VALUE';
  if (!['system', 'ca', 'pinned'].includes(tls.mode as string)) fields.tlsMode = 'INVALID_VALUE';
  if (tls.mode === 'ca' && (typeof tls.caPem !== 'string' || !tls.caPem.includes('BEGIN CERTIFICATE') || tls.caPem.length > 20000)) fields.caPem = 'INVALID_CERTIFICATE';
  if (tls.mode === 'pinned' && (typeof tls.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tls.sha256))) fields.sha256 = 'INVALID_FINGERPRINT';
  if (b.apiVersion !== undefined && b.apiVersion !== '' && !apiVersions.includes(b.apiVersion as string)) fields.apiVersion = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return {
    ...(b.apiVersion ? { apiVersion: b.apiVersion as string } : {}),
    name: (b.name as string).trim(), host: (b.host as string).toLowerCase(), port, username: b.username as string, password: typeof b.password === 'string' ? b.password : '',
    tls: { mode: tls.mode as TlsSettings['mode'], ...(tls.mode === 'ca' && { caPem: tls.caPem as string }), ...(tls.mode === 'pinned' && { sha256: tls.sha256 as string }) },
  };
}

// Calls the internal Go adapter. Its failure code (and the untrusted certificate, if any) is passed on.
export async function callAdapter<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  let token: string;
  try { token = readFileSync(process.env.VMWARE_SERVICE_TOKEN_FILE ?? '/run/secrets/vmware_token', 'utf8').trim(); }
  catch { throw apiError(503, 'VMWARE_SERVICE_UNAVAILABLE', 'Service token missing'); }
  const res = await fetch(`${process.env.VMWARE_SERVICE_URL ?? 'http://vmware:8080'}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => { throw apiError(503, 'VMWARE_SERVICE_UNAVAILABLE', 'VMware adapter unreachable'); });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw apiError(422, out?.code ?? 'VMWARE_ERROR', out?.message ?? 'VMware call failed', undefined, out?.certificate ? { certificate: out.certificate } : undefined);
  return out;
}

// Rebuilds the adapter request from a stored connection row, decrypting the password in memory only.
export function storedTarget(c: Record<string, string | number>): Target {
  return { host: String(c.host), port: Number(c.port), username: String(c.username), password: decryptSecret(String(c.password_enc), String(c.id)),
    ...(c.api_version ? { apiVersion: String(c.api_version) } : {}),
    tls: { mode: c.tls_mode as TlsSettings['mode'], ...(c.tls_ca_pem && { caPem: String(c.tls_ca_pem) }), ...(c.tls_sha256 && { sha256: String(c.tls_sha256) }) } };
}

const discover = (target: Target) => callAdapter<Discovery>('/v1/discover', target, 70_000);

// The admin's customization choice may only use what the endpoint supports ("cloudinit" needs vCenter 7.0U3+).
function readCustomization(body: unknown, compat?: Compat | null) {
  const v = ((body ?? {}) as Record<string, unknown>).customization ?? 'auto';
  if (!customizations.includes(v as string)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { customization: 'INVALID_VALUE' });
  if (v === 'cloudinit' && compat && compat.customization !== 'cloudinit') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { customization: 'NOT_SUPPORTED_BY_VERSION' });
  return v as string;
}

function summary(d: Discovery) {
  return { product: d.product, writeApi: d.writeApi, operations: d.operations, warnings: d.warnings, compat: d.compat,
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

// An edit may leave the password empty to keep the stored one, but only for the same address and port:
// the stored password is never sent to an endpoint it was not given for.
function withStoredPassword<T extends Target>(target: T, c: Record<string, string | number>): T {
  if (target.password) return target;
  if (target.host !== String(c.host) || target.port !== Number(c.port)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { password: 'PASSWORD_REQUIRED_FOR_NEW_ADDRESS' });
  return { ...target, password: decryptSecret(String(c.password_enc), String(c.id)) };
}

const connectionColumns = `id, name, kind, host, port, username, tls_mode AS "tlsMode", tls_sha256 AS "tlsSha256", tls_ca_pem AS "tlsCaPem", product, licenses,
  write_api AS "writeApi", privileges, operations, warnings, api_version AS "apiVersion", customization, compat, status, last_error_code AS "lastErrorCode", last_discovered_at AS "lastDiscoveredAt", created_at AS "createdAt"`;

@Controller('admin/vmware') @UseGuards(PermissionGuard)
export class VmwareController {
  // Connects and discovers without saving anything: the wizard's and the form's "Test connection".
  // With connectionId (editing a connection) an empty password means that connection's stored one.
  @Post('test') @HttpCode(200) @Can('vmware.manage')
  async test(@Body() body: unknown) {
    const connectionId = ((body ?? {}) as Record<string, unknown>).connectionId;
    if (connectionId === undefined || connectionId === null || connectionId === '') return summary(await discover(readTarget(body)));
    if (typeof connectionId !== 'string' || !/^[0-9a-f-]{36}$/.test(connectionId)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { connectionId: 'INVALID_VALUE' });
    const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [connectionId]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    return summary(await discover(withStoredPassword(readTarget(body, false), c)));
  }

  @Get('connections') @Can('vmware.view', 'vmware.manage', 'catalog.manage', 'dashboard.view')
  async list() {
    const { rows } = await pool.query(`SELECT ${connectionColumns},
      (SELECT count(*)::int FROM vmware_hosts h WHERE h.connection_id = c.id) AS hosts,
      (SELECT count(*)::int FROM vmware_vms v WHERE v.connection_id = c.id) AS vms
      FROM vmware_connections c ORDER BY name`);
    return { connections: rows };
  }

  @Post('connections') @HttpCode(201) @Can('vmware.manage')
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const target = readTarget(body);
    const d = await discover(target); // outside any transaction: this can take seconds
    const customization = readCustomization(body, d.compat);
    const id = randomUUID();
    await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, tls_ca_pem, tls_sha256, instance_uuid,
           product, licenses, write_api, privileges, operations, warnings, last_discovered_at, api_version, customization, compat)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now(), $18, $19, $20)`,
        [id, target.name, d.product.kind, target.host, target.port, target.username, encryptSecret(target.password, id), target.tls.mode,
          target.tls.caPem ?? null, target.tls.sha256 ?? null, d.product.instanceUuid || null, d.product, JSON.stringify(d.licenses ?? []), d.writeApi,
          d.privileges, d.operations, JSON.stringify(d.warnings), target.apiVersion ?? null, customization, d.compat ?? null]);
      await storeInventory(client, id, d);
    });
    await audit(req, 'vmware.connection_created', 'success', req.user.id, { id, name: target.name, host: target.host, kind: d.product.kind });
    return { id, ...summary(d) };
  }

  // New credentials, address or certificate trust for an existing connection (a changed password, a renewed
  // certificate). An empty password keeps the stored one. Tested like a new connection before anything is saved;
  // it must still be the same ESXi/vCenter, because pools and images refer to its inventory.
  @Put('connections/:id') @Can('vmware.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    const target = withStoredPassword(readTarget(body, false), c);
    const d = await discover(target);
    if ((c.instance_uuid && d.product.instanceUuid && c.instance_uuid !== d.product.instanceUuid) || c.kind !== d.product.kind)
      throw apiError(409, 'ENDPOINT_CHANGED', 'This address answers as another ESXi/vCenter');
    const customization = readCustomization(body, d.compat);
    await inTransaction(async (client) => {
      await client.query(
        `UPDATE vmware_connections SET name = $2, host = $3, port = $4, username = $5, password_enc = $6, tls_mode = $7, tls_ca_pem = $8, tls_sha256 = $9,
           instance_uuid = COALESCE($10, instance_uuid), product = $11, licenses = $12, write_api = $13, privileges = $14, operations = $15, warnings = $16,
           api_version = $17, customization = $18, compat = $19, status = 'ok', last_error_code = NULL, last_discovered_at = now(), updated_at = now() WHERE id = $1`,
        [id, target.name, target.host, target.port, target.username, encryptSecret(target.password, id), target.tls.mode, target.tls.caPem ?? null,
          target.tls.sha256 ?? null, d.product.instanceUuid || null, d.product, JSON.stringify(d.licenses ?? []), d.writeApi, d.privileges, d.operations,
          JSON.stringify(d.warnings), target.apiVersion ?? null, customization, d.compat ?? null]);
      await storeInventory(client, id, d);
    });
    await audit(req, 'vmware.connection_updated', 'success', req.user.id, { id, name: target.name, host: target.host,
      passwordChanged: !!(body as Record<string, unknown>)?.password, tlsMode: target.tls.mode });
    return { id, ...summary(d) };
  }

  @Get('connections/:id') @Can('vmware.view', 'vmware.manage', 'catalog.manage')
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

  @Post('connections/:id/discover') @HttpCode(200) @Can('vmware.manage')
  async refresh(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    const target = storedTarget(c);
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
        privileges = $5, operations = $6, warnings = $7, compat = $8, last_discovered_at = now(), updated_at = now() WHERE id = $1`,
        [id, d.product, JSON.stringify(d.licenses ?? []), d.writeApi, d.privileges, d.operations, JSON.stringify(d.warnings), d.compat ?? null]);
      await storeInventory(client, id, d);
    });
    await audit(req, 'vmware.discovery', 'success', req.user.id, { id });
    return summary(d);
  }

  // Version pinning and the customization method of an existing connection; checked against a fresh discovery.
  @Post('connections/:id/compat') @HttpCode(200) @Can('vmware.manage')
  async setCompat(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { rows: [c] } = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    const b = (body ?? {}) as Record<string, unknown>;
    const apiVersion = b.apiVersion === '' || b.apiVersion === undefined || b.apiVersion === null ? null : String(b.apiVersion);
    if (apiVersion && !apiVersions.includes(apiVersion)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { apiVersion: 'INVALID_VALUE' });
    const { apiVersion: _old, ...base } = storedTarget(c);
    const d = await discover({ ...base, ...(apiVersion ? { apiVersion } : {}) });
    const customization = readCustomization(body, d.compat);
    await pool.query('UPDATE vmware_connections SET api_version = $2, customization = $3, compat = $4, updated_at = now() WHERE id = $1', [id, apiVersion, customization, d.compat]);
    await audit(req, 'vmware.compat_changed', 'success', req.user.id, { id, apiVersion, customization });
    return { apiVersion, customization, compat: d.compat };
  }

  // Forgets the connection and its cached inventory. Nothing is changed on the ESXi/vCenter side.
  @Delete('connections/:id') @HttpCode(204) @Can('vmware.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    // Pools and images reference connections with ON DELETE RESTRICT: report that, not a 500.
    const { rows: [c] } = await pool.query('DELETE FROM vmware_connections WHERE id = $1 RETURNING name', [id])
      .catch((err) => { if (err.code === '23503') throw apiError(409, 'IN_USE', 'Used by resource pools or images'); throw err; });
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    await audit(req, 'vmware.connection_deleted', 'success', req.user.id, { id, name: c.name });
  }
}
