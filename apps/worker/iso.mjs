// ISO library jobs: list a storage (FTP/FTPS, SFTP, WebDAV, S3, SMB, HTTP through rclone), copy an ISO from it
// into a location's datastore (rclone cat -> adapter -> vCenter, streamed, never stored here), and delete one.
// The storage is passed to rclone as RCLONE_CONFIG_SRC_* environment variables: no config file, no secrets in argv.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { adapter, adapterBase, connectionTarget, decrypt, OperationError } from './operations.mjs';

// rclone stores these options obscured; everything else is passed as given.
const obscured = new Set(['pass']);
const common = ['--contimeout', '15s', '--timeout', '60s', '--low-level-retries', '2', '--retries', '1'];

function run(args, env, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('rclone', args, { env: { PATH: process.env.PATH, HOME: '/tmp', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => reject(new OperationError('RCLONE_MISSING', 'rclone is not installed', true)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(storageError(err))));
    if (input !== undefined) p.stdin.end(input);
  });
}

// rclone's messages, mapped to stable codes; the text (no secrets in it) goes along as detail.
function storageError(stderr) {
  const t = String(stderr);
  // Credentials first: a rejected login is often reported together with "directory not found".
  const code = /(401|403|530)|unauthori[sz]ed|login|authenticat|permission denied|access denied|InvalidAccessKeyId|SignatureDoesNotMatch|LOGON_FAILURE/i.test(t) ? 'STORAGE_AUTH_FAILED'
    : /directory not found|object not found|not found|404|no such file/i.test(t) ? 'STORAGE_NOT_FOUND'
    : /certificate|x509|tls/i.test(t) ? 'STORAGE_TLS_FAILED'
    : /no such host|connection refused|timeout|i\/o timeout|unreachable|dial tcp/i.test(t) ? 'STORAGE_UNREACHABLE' : 'STORAGE_ERROR';
  return new OperationError(code, t.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300), code !== 'STORAGE_UNREACHABLE');
}

async function remoteEnv(src) {
  const env = { RCLONE_CONFIG_SRC_TYPE: src.protocol, ...(src.protocol === 'webdav' && { RCLONE_CONFIG_SRC_VENDOR: 'other' }), ...(src.protocol === 's3' && { RCLONE_CONFIG_SRC_PROVIDER: 'Other' }) };
  for (const [k, v] of Object.entries({ ...src.config, ...src.secrets })) {
    if (v === '' || v === null || v === undefined) continue;
    env[`RCLONE_CONFIG_SRC_${k.toUpperCase()}`] = obscured.has(k) ? (await run(['obscure', '-'], {}, String(v))).trim() : String(v);
  }
  return env;
}

const join = (...parts) => parts.map((p) => String(p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

// Whether a progress update shows the copy is no longer wanted: only an answer counts (the row gone, or in another
// state). An update that failed (a database blip) says nothing, and the copy goes on.
export const copyStopped = (res) => !!res && res.rows[0]?.state !== 'copying';

async function loadSource(db, data) {
  if (data.draft) return JSON.parse(decrypt(data.draft, 'iso-draft')); // "Test" of a form not saved yet
  const { rows: [s] } = await db.query('SELECT * FROM iso_sources WHERE id = $1', [data.sourceId]);
  if (!s) throw new OperationError('NOT_FOUND', 'unknown storage', true);
  return { protocol: s.protocol, config: s.config, secrets: s.secrets_enc ? JSON.parse(decrypt(s.secrets_enc, `iso-source:${s.id}`)) : {}, basePath: s.base_path };
}

// One folder level: sub-folders and .iso files, folders first.
async function browse(db, data) {
  const src = await loadSource(db, data);
  const out = await run(['lsjson', '--max-depth', '1', ...common, `src:${join(src.basePath, data.path)}`], await remoteEnv(src));
  const entries = JSON.parse(out || '[]').filter((e) => e.IsDir || /\.iso$/i.test(e.Name))
    .map((e) => ({ name: e.Name, dir: e.IsDir, size: e.IsDir ? null : e.Size, modified: e.ModTime ?? null }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { entries };
}

// Streams one file into the datastore through the adapter; progress lands in isos.copied_bytes.
async function importIso(db, data, log, notify) {
  const { rows: [iso] } = await db.query(`SELECT i.*, p.connection_id, p.name AS pool_name FROM isos i JOIN resource_pools p ON p.id = i.pool_id WHERE i.id = $1`, [data.isoId]);
  if (!iso || iso.state !== 'copying') return;
  const fail = async (e) => {
    const error = `${e.code ?? 'STORAGE_ERROR'}${e.detail ? `: ${e.detail}` : ''}`.slice(0, 400);
    await db.query("UPDATE isos SET state = 'failed', error = $2, updated_at = now() WHERE id = $1 AND state = 'copying'", [iso.id, error]);
    await notify('admin.iso_failed', 'staff:catalog.manage', { name: iso.name, pool: iso.pool_name, error });
    log('warn', 'iso_import_failed', { iso: iso.id, code: e.code });
  };
  try {
    if (!iso.source_id) throw new OperationError('NOT_FOUND', 'the storage was removed', true);
    const src = await loadSource(db, { sourceId: iso.source_id });
    const env = await remoteEnv(src);
    const path = `src:${join(src.basePath, iso.source_path)}`;
    const stat = JSON.parse(await run(['lsjson', '--stat', ...common, path], env));
    if (!(stat.Size > 0)) throw new OperationError('ISO_SIZE_UNKNOWN', 'the storage does not report the file size', true);
    await db.query('UPDATE isos SET size_bytes = $2, copied_bytes = 0, updated_at = now() WHERE id = $1', [iso.id, stat.Size]);
    const { rows: [c] } = await db.query('SELECT * FROM vmware_connections WHERE id = $1', [iso.connection_id]);
    const target = connectionTarget(c);
    const header = Buffer.from(JSON.stringify({ ...target, datastore: iso.datastore_moref, name: iso.file_name })).toString('base64');
    const token = readFileSync(process.env.VMWARE_SERVICE_TOKEN_FILE ?? '/run/secrets/vmware_token', 'utf8').trim();

    const cat = spawn('rclone', ['cat', ...common, path], { env: { PATH: process.env.PATH, HOME: '/tmp', ...env } });
    let stderr = '', copied = 0, cancelled = false;
    cat.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const counter = new Transform({ transform(chunk, _e, cb) { copied += chunk.length; cb(null, chunk); } });
    // Progress every 3 s; an ISO deleted meanwhile stops the copy.
    const timer = setInterval(async () => {
      if (copyStopped(await db.query('UPDATE isos SET copied_bytes = $2, updated_at = now() WHERE id = $1 RETURNING state', [iso.id, copied]).catch(() => null))) { cancelled = true; cat.kill(); }
    }, 3000);
    try {
      const out = await new Promise((resolve, reject) => {
        // The connection's own adapter, as for every other call: a platform without an ISO library says so itself.
        const u = new URL('/v1/iso/upload', adapterBase(target.platform));
        const req = request(u, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-upload': header, 'content-length': stat.Size, 'content-type': 'application/octet-stream' } }, (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => {
            const j = (() => { try { return JSON.parse(body); } catch { return null; } })();
            if (res.statusCode === 200) resolve(j); else reject(new OperationError(j?.code ?? 'VMWARE_ERROR', j?.message, true));
          });
        });
        req.on('error', () => reject(new OperationError('VMWARE_SERVICE_UNAVAILABLE', 'adapter unreachable')));
        cat.on('close', (code) => { if (code !== 0) { req.destroy(); reject(cancelled ? new OperationError('CANCELLED', 'deleted during the copy', true) : storageError(stderr)); } });
        cat.stdout.pipe(counter).pipe(req);
      });
      if (copied !== stat.Size) throw new OperationError('ISO_INCOMPLETE', `${copied} of ${stat.Size} bytes`, true);
      await db.query("UPDATE isos SET state = 'ready', copied_bytes = $2, error = NULL, updated_at = now() WHERE id = $1 AND state = 'copying'", [iso.id, copied]);
      await notify('admin.iso_ready', 'staff:catalog.manage', { name: iso.name, pool: iso.pool_name });
      log('info', 'iso_imported', { iso: iso.id, bytes: copied, path: out?.path });
    } finally { clearInterval(timer); }
  } catch (e) {
    if (e.code === 'CANCELLED') return;
    await fail(e);
  }
}

// Removes the file from the datastore, then the row. Servers holding it were refused earlier (API).
async function deleteIso(db, data) {
  const { rows: [iso] } = await db.query(`SELECT i.*, p.connection_id FROM isos i JOIN resource_pools p ON p.id = i.pool_id WHERE i.id = $1`, [data.isoId]);
  if (!iso) return;
  const { rows: [c] } = await db.query('SELECT * FROM vmware_connections WHERE id = $1', [iso.connection_id]);
  await adapter('/v1/iso/delete', { ...connectionTarget(c), datastore: iso.datastore_moref, name: iso.file_name });
  await db.query('DELETE FROM isos WHERE id = $1', [iso.id]);
}

export async function processIso(db, job, log, notify = async () => {}) {
  if (job.name === 'browse') return browse(db, job.data);
  if (job.name === 'import') return importIso(db, job.data, log, notify);
  if (job.name === 'delete') return deleteIso(db, job.data);
}
