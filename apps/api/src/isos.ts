// ISO library. The admin connects storages (FTP/FTPS, SFTP, WebDAV, S3-compatible, SMB, HTTP), browses them and
// copies ISO files into a location's datastore; customers insert a ready ISO into their server's CD-ROM (and may
// boot from it). Storage access runs in the worker (rclone); this side validates, stores and waits for answers.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { onClose, pool, redis } from './db';
import { apiError } from './errors';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { customerMay, findServer } from './servers';
import { callAdapter, storedTarget } from './vmware';

type Input = Record<string, unknown>;
type Field = { key: string; type: 'text' | 'number' | 'bool' | 'textarea'; required?: boolean; secret?: boolean; default?: string | number | boolean };

// The form of each protocol; keys are rclone option names (the worker passes them on as they are).
export const protocols: Record<string, Field[]> = {
  ftp: [{ key: 'host', type: 'text', required: true }, { key: 'port', type: 'number', default: 21 }, { key: 'user', type: 'text' }, { key: 'pass', type: 'text', secret: true },
    { key: 'explicit_tls', type: 'bool', default: false }, { key: 'tls', type: 'bool', default: false }, { key: 'no_check_certificate', type: 'bool', default: false }],
  sftp: [{ key: 'host', type: 'text', required: true }, { key: 'port', type: 'number', default: 22 }, { key: 'user', type: 'text', required: true },
    { key: 'pass', type: 'text', secret: true }, { key: 'key_pem', type: 'textarea', secret: true }],
  webdav: [{ key: 'url', type: 'text', required: true }, { key: 'user', type: 'text' }, { key: 'pass', type: 'text', secret: true }],
  s3: [{ key: 'endpoint', type: 'text', required: true }, { key: 'region', type: 'text' }, { key: 'access_key_id', type: 'text', required: true },
    { key: 'secret_access_key', type: 'text', secret: true, required: true }, { key: 'force_path_style', type: 'bool', default: true }],
  smb: [{ key: 'host', type: 'text', required: true }, { key: 'port', type: 'number', default: 445 }, { key: 'user', type: 'text' }, { key: 'pass', type: 'text', secret: true },
    { key: 'domain', type: 'text' }],
  http: [{ key: 'url', type: 'text', required: true }],
};

const hostPattern = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^[0-9a-fA-F:.]+$/;
const pathPattern = /^[^\0\r\n]{0,500}$/;
const fileName = (name: string) => name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 140).replace(/(\.iso)?$/i, '.iso');

const queue = new Queue('isos', { connection: redis });
let events: QueueEvents | undefined;
let eventsConnection: ReturnType<typeof redis.duplicate> | undefined;

// Browsing runs in the worker; the request waits for its answer (up to 45 s).
async function browse(data: Record<string, unknown>) {
  // A blocking subscriber: its own connection, which BullMQ requires without a retry limit.
  if (!events) { eventsConnection = redis.duplicate({ maxRetriesPerRequest: null }); events = new QueueEvents('isos', { connection: eventsConnection }); }
  const job = await queue.add('browse', data, { attempts: 1, removeOnComplete: { age: 60 }, removeOnFail: { age: 60 } });
  try { return await job.waitUntilFinished(events, 45_000) as { entries: { name: string; dir: boolean; size: number | null }[] }; }
  catch (e) {
    const code = String((e as Error).message ?? '');
    if (/^STORAGE_|^RCLONE_/.test(code)) throw apiError(422, code, 'Storage request failed', undefined, { detail: (await queue.getJob(job.id!))?.failedReason });
    throw apiError(504, 'STORAGE_TIMEOUT', 'The storage did not answer in time');
  }
}

// Validates a storage form; on update, empty secrets keep the stored ones.
function readSource(body: Input, existing?: { protocol: string; secrets: Record<string, string> }) {
  const fields: Record<string, string> = {};
  const name = typeof body.name === 'string' && body.name.trim() && body.name.trim().length <= 60 ? body.name.trim() : (fields.name = 'INVALID_VALUE', '');
  const protocol = String(body.protocol ?? existing?.protocol ?? '');
  if (!protocols[protocol]) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { protocol: 'INVALID_VALUE' });
  const given = (body.config ?? {}) as Input;
  const config: Record<string, string | number | boolean> = {};
  const secrets: Record<string, string> = {};
  for (const f of protocols[protocol]) {
    let v = given[f.key];
    if (f.secret) {
      const s = typeof v === 'string' ? v : '';
      if (s.length > 8000) fields[f.key] = 'TOO_LONG';
      if (s) secrets[f.key] = s;
      else if (existing?.protocol === protocol && existing.secrets[f.key]) secrets[f.key] = existing.secrets[f.key];
      else if (f.required) fields[f.key] = 'REQUIRED';
      continue;
    }
    if (v === undefined || v === '') v = f.default;
    if (v === undefined || v === '') { if (f.required) fields[f.key] = 'REQUIRED'; continue; }
    if (f.type === 'number') { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) fields[f.key] = 'OUT_OF_RANGE'; config[f.key] = n; }
    else if (f.type === 'bool') config[f.key] = v === true || v === 'true';
    else {
      const s = String(v).trim();
      if (f.key === 'host' && !hostPattern.test(s)) fields[f.key] = 'INVALID_VALUE';
      if ((f.key === 'url' || f.key === 'endpoint') && !/^https?:\/\/[^\s]+$/i.test(s)) fields[f.key] = 'INVALID_URL';
      if (s.length > 500) fields[f.key] = 'TOO_LONG';
      config[f.key] = s;
    }
  }
  const basePath = typeof body.basePath === 'string' ? body.basePath.trim() : '';
  if (!pathPattern.test(basePath)) fields.basePath = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { name, protocol, config, secrets, basePath };
}

const sourceSecrets = (r: { id: string; secrets_enc: string | null }) => (r.secrets_enc ? JSON.parse(decryptSecret(r.secrets_enc, `iso-source:${r.id}`)) as Record<string, string> : {});

@Controller('admin') @UseGuards(PermissionGuard)
export class IsoAdminController {
  @Get('iso-sources') @Can('catalog.view', 'catalog.manage')
  async sources() {
    const { rows } = await pool.query(`SELECT s.id, s.name, s.protocol, s.config, s.base_path AS "basePath", s.secrets_enc, s.updated_at AS "updatedAt",
      (SELECT count(*)::int FROM isos i WHERE i.source_id = s.id) AS isos FROM iso_sources s ORDER BY s.name`);
    // Secrets never leave: only which ones are set.
    return { protocols, sources: rows.map(({ secrets_enc, ...r }) => ({ ...r, secretsSet: Object.keys(sourceSecrets({ id: r.id, secrets_enc })) })) };
  }

  @Post('iso-sources') @HttpCode(201) @Can('catalog.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = readSource(body ?? {});
    const { rows: [s] } = await pool.query('INSERT INTO iso_sources (name, protocol, config, base_path) VALUES ($1, $2, $3, $4) RETURNING id', [v.name, v.protocol, v.config, v.basePath])
      .catch((e) => { if (e.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }); throw e; });
    if (Object.keys(v.secrets).length) await pool.query('UPDATE iso_sources SET secrets_enc = $2 WHERE id = $1', [s.id, encryptSecret(JSON.stringify(v.secrets), `iso-source:${s.id}`)]);
    await audit(req, 'catalog.iso_source_created', 'success', req.user.id, { id: s.id, name: v.name, protocol: v.protocol });
    return { id: s.id };
  }

  @Put('iso-sources/:id') @Can('catalog.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const { rows: [old] } = await pool.query('SELECT id, protocol, secrets_enc FROM iso_sources WHERE id = $1', [id]);
    if (!old) throw apiError(404, 'NOT_FOUND', 'Unknown storage');
    const v = readSource(body ?? {}, { protocol: old.protocol, secrets: sourceSecrets(old) });
    await pool.query(`UPDATE iso_sources SET name = $2, protocol = $3, config = $4, base_path = $5, secrets_enc = $6, updated_at = now() WHERE id = $1`,
      [id, v.name, v.protocol, v.config, v.basePath, Object.keys(v.secrets).length ? encryptSecret(JSON.stringify(v.secrets), `iso-source:${id}`) : null])
      .catch((e) => { if (e.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }); throw e; });
    await audit(req, 'catalog.iso_source_updated', 'success', req.user.id, { id });
    return { id };
  }

  @Delete('iso-sources/:id') @HttpCode(204) @Can('catalog.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    // ISOs already copied stay; they only lose the link to where they came from.
    const { rowCount } = await pool.query('DELETE FROM iso_sources WHERE id = $1', [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown storage');
    await audit(req, 'catalog.iso_source_deleted', 'success', req.user.id, { id });
  }

  // "Test connection" of a form not saved yet: lists its top folder. The form travels encrypted through Redis.
  @Post('iso-sources/test') @HttpCode(200) @Can('catalog.manage')
  async test(@Req() req: AuthedRequest, @Body() body: Input) {
    let existing;
    if (typeof body?.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id)) {
      const { rows: [old] } = await pool.query('SELECT id, protocol, secrets_enc FROM iso_sources WHERE id = $1', [body.id]);
      if (old) existing = { protocol: old.protocol, secrets: sourceSecrets(old) };
    }
    const v = readSource({ ...(body ?? {}), name: body?.name || 'test' }, existing);
    const out = await browse({ draft: encryptSecret(JSON.stringify(v), 'iso-draft'), path: '' });
    await audit(req, 'catalog.iso_source_tested', 'success', req.user.id, { protocol: v.protocol });
    return { ok: true, entries: out.entries.length, isos: out.entries.filter((e) => !e.dir).length };
  }

  @Post('iso-sources/:id/browse') @HttpCode(200) @Can('catalog.manage')
  async browse(@Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const path = typeof body?.path === 'string' ? body.path : '';
    if (!pathPattern.test(path) || path.split('/').includes('..')) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { path: 'INVALID_VALUE' });
    const { rowCount } = await pool.query('SELECT 1 FROM iso_sources WHERE id = $1', [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown storage');
    return { path, ...(await browse({ sourceId: id, path })) };
  }

  @Get('isos') @Can('catalog.view', 'catalog.manage')
  async isos() {
    const { rows } = await pool.query(`SELECT i.id, i.name, i.file_name AS "fileName", i.pool_id AS "poolId", p.name AS "poolName", i.datastore_moref AS "datastore",
        i.source_id AS "sourceId", s.name AS "sourceName", i.source_path AS "sourcePath", i.size_bytes::float8 AS "sizeBytes", i.copied_bytes::float8 AS "copiedBytes",
        i.state, i.error, i.public, i.created_at AS "createdAt",
        (SELECT count(*)::int FROM servers v WHERE v.iso_id = i.id AND v.state <> 'deleted') AS servers
      FROM isos i JOIN resource_pools p ON p.id = i.pool_id LEFT JOIN iso_sources s ON s.id = i.source_id ORDER BY p.name, i.name`);
    return { isos: rows };
  }

  // Copies one file from a storage into a location's datastore (in the background).
  @Post('isos') @HttpCode(202) @Can('catalog.manage')
  async import(@Req() req: AuthedRequest, @Body() body: Input) {
    const fields: Record<string, string> = {};
    const path = typeof body?.path === 'string' ? body.path.replace(/^\/+/, '') : '';
    if (!/\.iso$/i.test(path) || !pathPattern.test(path) || path.split('/').includes('..')) fields.path = 'NOT_AN_ISO';
    const name = (typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : path.split('/').pop() ?? '').slice(0, 100);
    const ids = (Array.isArray(body?.poolIds) ? body.poolIds : [body?.poolId]).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
    if (!ids.length) fields.poolIds = 'REQUIRED';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const { rows: [src] } = await pool.query('SELECT id FROM iso_sources WHERE id = $1', [body.sourceId]).catch(() => ({ rows: [] }));
    if (!src) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { sourceId: 'INVALID_VALUE' });
    const { rows: pools } = await pool.query('SELECT id, datastore_morefs FROM resource_pools WHERE id = ANY($1::uuid[])', [ids]);
    if (pools.length !== ids.length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { poolIds: 'INVALID_VALUE' });
    const created: string[] = [];
    // One copy per location (each has its own datastores); the first datastore of the location holds it.
    for (const p of pools) {
      const { rows: [i] } = await pool.query(`INSERT INTO isos (name, file_name, pool_id, datastore_moref, source_id, source_path, public)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (pool_id, datastore_moref, file_name) DO NOTHING RETURNING id`,
        [name, fileName(path.split('/').pop()!), p.id, p.datastore_morefs[0], src.id, path, body.public !== false]);
      if (!i) throw apiError(409, 'VALIDATION_FAILED', 'Already in the library', { path: 'ISO_EXISTS' });
      created.push(i.id);
      await queue.add('import', { isoId: i.id }, { attempts: 1, jobId: `iso-${i.id}`, removeOnComplete: true, removeOnFail: 100 });
    }
    await audit(req, 'catalog.iso_import_started', 'success', req.user.id, { sourceId: src.id, path, pools: ids });
    return { ids: created };
  }

  @Put('isos/:id') @Can('catalog.manage')
  async edit(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const name = typeof body?.name === 'string' && body.name.trim() && body.name.trim().length <= 100 ? body.name.trim() : null;
    if (!name) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { name: 'INVALID_VALUE' });
    const { rowCount } = await pool.query('UPDATE isos SET name = $2, public = $3, updated_at = now() WHERE id = $1', [id, name, body.public !== false]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown ISO');
    await audit(req, 'catalog.iso_updated', 'success', req.user.id, { id });
    return { id };
  }

  // A failed or finished copy is retried / refreshed from its storage.
  @Post('isos/:id/retry') @HttpCode(202) @Can('catalog.manage')
  async retry(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query("UPDATE isos SET state = 'copying', error = NULL, copied_bytes = 0, updated_at = now() WHERE id = $1 AND state = 'failed' AND source_id IS NOT NULL", [id]);
    if (!rowCount) throw apiError(409, 'INVALID_STATE', 'Only a failed copy with its storage can be retried');
    await queue.add('import', { isoId: id }, { attempts: 1, removeOnComplete: true, removeOnFail: 100 });
    await audit(req, 'catalog.iso_import_started', 'success', req.user.id, { id, retry: true });
    return { id };
  }

  @Delete('isos/:id') @HttpCode(202) @Can('catalog.manage')
  async remove2(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM servers WHERE iso_id = $1 AND state <> 'deleted'", [id]);
    if (n.n) throw apiError(409, 'IN_USE', 'Servers still have this ISO inserted');
    // A copy in progress stops at its next progress update; the worker then removes the file and the row.
    const { rowCount } = await pool.query("UPDATE isos SET state = 'deleting', updated_at = now() WHERE id = $1 AND state <> 'deleting'", [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown ISO');
    await queue.add('delete', { isoId: id }, { attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 });
    await audit(req, 'catalog.iso_deleted', 'success', req.user.id, { id });
  }
}

// A server's CD-ROM: the ready ISOs of its location, and inserting / ejecting one (owner or staff).
@Controller() @UseGuards(SessionGuard)
export class ServerIsoController {
  @Get('servers/:id/isos')
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const staff = req.user.permissions.includes('*') || req.user.permissions.includes('servers.manage_all');
    const { rows } = await pool.query(`SELECT id, name, size_bytes::float8 AS "sizeBytes" FROM isos WHERE pool_id = $1 AND state = 'ready' AND (public OR $2) ORDER BY name`, [s.pool_id, staff]);
    return { isos: rows, inserted: s.iso_id, boot: s.iso_boot };
  }

  @Put('servers/:id/iso')
  async insert(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const s = await findServer(req, id, true);
    await customerMay(req, 'iso');
    if (!s.vm_moref || !['ready', 'error'].includes(s.state)) throw apiError(409, 'INVALID_STATE', 'The server is not ready');
    const isoId = typeof body?.isoId === 'string' && body.isoId ? body.isoId : null;
    const boot = isoId !== null && body?.boot === true;
    let iso: { id: string; name: string; datastore_moref: string; file_name: string } | undefined;
    if (isoId) {
      const staff = req.user.permissions.includes('*') || req.user.permissions.includes('servers.manage_all');
      ({ rows: [iso] } = await pool.query("SELECT * FROM isos WHERE id = $1 AND pool_id = $2 AND state = 'ready' AND (public OR $3)", [isoId, s.pool_id, staff]).catch(() => ({ rows: [] })));
      if (!iso) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { isoId: 'NOT_AVAILABLE' });
    }
    const { rows: [c] } = await pool.query('SELECT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [s.pool_id]);
    await callAdapter('/v1/vm/cdrom', { ...storedTarget(c), vm: s.vm_moref, ...(iso && { datastore: iso.datastore_moref, name: iso.file_name }), boot }, 60_000);
    await pool.query('UPDATE servers SET iso_id = $2, iso_boot = $3, updated_at = now() WHERE id = $1', [id, iso?.id ?? null, boot]);
    await audit(req, iso ? 'server.iso_inserted' : 'server.iso_ejected', 'success', req.user.id, { serverId: id, ...(iso && { isoId: iso.id, name: iso.name, boot }) });
    return { inserted: iso?.id ?? null, boot };
  }
}

onClose.push(async () => { await events?.close(); eventsConnection?.disconnect(); events = undefined; });
