// Network discovery of ESXi and vCenter: an admin scans IP blocks; every address that answers as
// vSphere is listed with its product, version and certificate, and marked as already connected,
// managed through a connected vCenter, ignored or new. The adapter asks each address only for the
// public ServiceContent (no credentials). Scans run in the API in chunks so progress is visible and
// a scan can be cancelled; an optional daily or weekly scan reports endpoints that are new.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { audit, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { notify } from './notify';
import { Can, PermissionGuard } from './rbac';
import { block24, parseTargets } from './scan-targets';
import { getSettings, saveSettings } from './settings-store';
import { callAdapter } from './vmware';

const chunkSize = 64;
const keepScans = 20;
type Product = { kind: 'esxi' | 'vcenter'; name: string; fullName: string; version: string; build: string; apiVersion: string; instanceUuid: string };
type Cert = { subject: string; issuer: string; notAfter: string; sha256: string; dnsNames: string[] | null; ips: string[] | null; selfSigned: boolean; trustedName: string };
type Hit = { address: string; state: 'vsphere' | 'https'; hostname?: string; product?: Product; certificate?: Cert };
type AdapterResult = { hits: Hit[]; closed: number; silent: number; blocked: number };
export type ScanSettings = { targets: string; port: number; auto: 'off' | 'daily' | 'weekly'; notify: boolean };

const keyOf = (h: Pick<Hit, 'address' | 'product'>) => h.product?.instanceUuid || h.address;
const codeOf = (err: unknown) => (err as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'VMWARE_ERROR';

// Validated targets and port; field codes are translated by the web UI.
function readScan(body: unknown, allowEmpty = false) {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.targets === 'string' ? b.targets.trim() : '';
  const port = b.port === undefined || b.port === '' ? 443 : Number(b.port);
  const fields: Record<string, string> = {};
  const parsed = parseTargets(text);
  const bad = parsed.items.find((i) => i.error);
  if (text.length > 4000) fields.targets = 'TOO_LONG';
  else if (bad?.error === 'RANGE_TOO_LARGE') fields.targets = 'RANGE_TOO_LARGE';
  else if (bad?.error === 'IPV6_RANGE') fields.targets = 'IPV6_RANGE';
  else if (bad) fields.targets = 'INVALID_TARGET';
  else if (parsed.tooMany) fields.targets = 'TOO_MANY_ADDRESSES';
  else if (!parsed.addresses.length && !allowEmpty) fields.targets = 'REQUIRED';
  if (!Number.isInteger(port) || port < 1 || port > 65535) fields.port = 'INVALID_PORT';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { text, port, addresses: parsed.addresses };
}

// A scan whose instance stopped (restart, crash) is not left "running" forever.
async function closeStale() {
  await pool.query(`UPDATE vmware_scans SET status = 'failed', error_code = 'SCAN_INTERRUPTED', finished_at = now()
    WHERE status = 'running' AND updated_at < now() - interval '3 minutes'`);
}

export async function startScan(text: string, port: number, addresses: string[], startedBy: string | null, auto = false) {
  await closeStale();
  const id = randomUUID();
  try {
    await pool.query('INSERT INTO vmware_scans (id, targets, port, auto, status, total, started_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, text, port, auto, 'running', addresses.length, startedBy]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw apiError(409, 'SCAN_RUNNING', 'Another scan is running');
    throw err;
  }
  // Older scans go; their hits with them.
  await pool.query(`DELETE FROM vmware_scans WHERE status <> 'running' AND id NOT IN (SELECT id FROM vmware_scans ORDER BY started_at DESC LIMIT ${keepScans})`);
  void runScan(id, addresses, port, auto);
  return id;
}

async function runScan(id: string, addresses: string[], port: number, auto: boolean) {
  try {
    for (let i = 0; i < addresses.length; i += chunkSize) {
      const { rows: [s] } = await pool.query('SELECT status FROM vmware_scans WHERE id = $1', [id]);
      if (s?.status !== 'running') return; // cancelled
      const part = addresses.slice(i, i + chunkSize);
      const r = await callAdapter<AdapterResult>('/v1/scan', { addresses: part, port, timeoutMs: 1500 }, 100_000);
      if (r.hits.length) {
        await pool.query(`INSERT INTO vmware_scan_hits (scan_id, address, state, hostname, product, certificate)
          SELECT $1, address, state, nullif(hostname, ''), product, certificate FROM json_to_recordset($2) AS x(address text, state text, hostname text, product jsonb, certificate jsonb)
          ON CONFLICT DO NOTHING`, [id, JSON.stringify(r.hits)]);
      }
      await pool.query(`UPDATE vmware_scans SET scanned = scanned + $2, found = found + $3, other = other + $4, closed = closed + $5, silent = silent + $6,
        blocked = blocked + $7, updated_at = now() WHERE id = $1 AND status = 'running'`,
        [id, part.length, r.hits.filter((h) => h.state === 'vsphere').length, r.hits.filter((h) => h.state === 'https').length, r.closed, r.silent, r.blocked]);
    }
    await pool.query("UPDATE vmware_scans SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'", [id]);
    logEvent('info', 'vmware_scan_done', { id, total: addresses.length });
    if (auto) await reportNew(id);
  } catch (err) {
    const code = codeOf(err);
    await pool.query("UPDATE vmware_scans SET status = 'failed', error_code = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'", [id, code])
      .catch(() => undefined);
    logEvent('warn', 'vmware_scan_failed', { id, code });
  }
}

// Each vSphere hit, with what the panel already knows about it.
async function annotate(hits: Hit[]) {
  const [{ rows: conns }, { rows: managed }, { rows: ignored }] = await Promise.all([
    pool.query('SELECT id, name, kind, lower(host) AS host, instance_uuid FROM vmware_connections'),
    pool.query(`SELECT lower(h.name) AS name, c.id, c.name AS connection FROM vmware_hosts h JOIN vmware_connections c ON c.id = h.connection_id WHERE c.kind = 'vcenter'`),
    pool.query('SELECT key FROM vmware_scan_ignored'),
  ]);
  const skip = new Set(ignored.map((r) => r.key));
  return hits.map((h) => {
    const names = [h.address, h.hostname, ...(h.certificate?.dnsNames ?? [])].filter(Boolean).map((n) => n!.toLowerCase());
    const conn = h.state === 'vsphere' ? conns.find((c) => names.includes(c.host) || (!!h.product?.instanceUuid && c.instance_uuid === h.product.instanceUuid)) : undefined;
    const via = !conn && h.product?.kind === 'esxi' ? managed.find((m) => names.includes(m.name)) : undefined;
    const status = h.state !== 'vsphere' ? 'other' : conn ? 'connected' : via ? 'managed' : skip.has(keyOf(h)) ? 'ignored' : 'new';
    return { ...h, key: keyOf(h), status, connection: conn ? { id: conn.id, name: conn.name } : via ? { id: via.id, name: via.connection } : null };
  });
}

const ipOrder = (a: string) => a.includes(':') ? `z${a}` : a.split('.').map((p) => p.padStart(3, '0')).join('.');
const scanColumns = `id, targets, port, auto, status, total, scanned, found, other, closed, silent, blocked, error_code AS "errorCode",
  started_at AS "startedAt", finished_at AS "finishedAt", (SELECT name FROM users u WHERE u.id = s.started_by) AS "startedBy"`;

async function scanDetail(id: string) {
  const { rows: [scan] } = await pool.query(`SELECT ${scanColumns} FROM vmware_scans s WHERE id = $1`, [id]);
  if (!scan) return null;
  const { rows } = await pool.query('SELECT address, state, hostname, product, certificate FROM vmware_scan_hits WHERE scan_id = $1', [id]);
  const hits = (await annotate(rows)).sort((a, b) => (a.state === b.state ? 0 : a.state === 'vsphere' ? -1 : 1) || ipOrder(a.address).localeCompare(ipOrder(b.address)));
  return { scan, hits };
}

// After an automatic scan: endpoints that are new and were in no earlier scan are reported once.
async function reportNew(id: string) {
  const s = await getSettings('vmwareScan');
  if (!s.notify) return;
  const detail = await scanDetail(id);
  const fresh = detail?.hits.filter((h) => h.status === 'new') ?? [];
  if (!fresh.length) return;
  const { rows } = await pool.query(`SELECT DISTINCT coalesce(product->>'instanceUuid', '') AS uuid, address FROM vmware_scan_hits WHERE scan_id <> $1 AND state = 'vsphere'`, [id]);
  const before = new Set(rows.flatMap((r) => [r.uuid, r.address]).filter(Boolean));
  const unseen = fresh.filter((h) => !before.has(h.key) && !before.has(h.address));
  if (!unseen.length) return;
  const list = unseen.slice(0, 5).map((h) => `${h.address} (${h.product?.kind === 'vcenter' ? 'vCenter' : 'ESXi'} ${h.product?.version ?? ''})`.trim()).join(', ')
    + (unseen.length > 5 ? ` +${unseen.length - 5}` : '');
  await notify('admin.vmware_found', 'staff:vmware.manage', { count: String(unseen.length), list });
}

async function suggestions() {
  const out = new Map<string, { target: string; source: 'connection' | 'hosts' | 'recent'; label: string }>();
  const { rows: conns } = await pool.query('SELECT id, name, host FROM vmware_connections ORDER BY name');
  for (const c of conns) { const b = block24(c.host); if (b && !out.has(b)) out.set(b, { target: b, source: 'connection', label: c.name }); }
  const { rows: hosts } = await pool.query('SELECT h.name, c.name AS connection FROM vmware_hosts h JOIN vmware_connections c ON c.id = h.connection_id ORDER BY h.name LIMIT 200');
  for (const h of hosts) { const b = block24(h.name); if (b && !out.has(b)) out.set(b, { target: b, source: 'hosts', label: h.connection }); }
  const { rows: recent } = await pool.query('SELECT DISTINCT ON (targets) targets, started_at FROM vmware_scans ORDER BY targets, started_at DESC');
  for (const r of recent.sort((a, b) => +b.started_at - +a.started_at).slice(0, 5)) {
    if (!out.has(r.targets) && r.targets.length <= 60) out.set(r.targets, { target: r.targets, source: 'recent', label: '' });
  }
  return [...out.values()].slice(0, 8);
}

@Controller('admin/vmware') @UseGuards(PermissionGuard)
export class VmwareScanController {
  // Everything the discovery panel needs: settings, suggested blocks, the latest scan and recent ones.
  @Get('scan') @Can('vmware.view', 'vmware.manage')
  async overview() {
    await closeStale();
    const [settings, suggested, { rows: history }, { rows: ignored }] = await Promise.all([
      getSettings('vmwareScan'), suggestions(),
      pool.query(`SELECT ${scanColumns} FROM vmware_scans s ORDER BY started_at DESC LIMIT 10`),
      pool.query('SELECT key, label, created_at AS "createdAt" FROM vmware_scan_ignored ORDER BY created_at DESC'),
    ]);
    const { rows: [lastAuto] } = await pool.query('SELECT started_at FROM vmware_scans WHERE auto ORDER BY started_at DESC LIMIT 1');
    return { settings, suggestions: suggested, history, ignored, latest: history[0] ? await scanDetail(history[0].id) : null,
      nextAuto: settings.auto === 'off' || !settings.targets ? null : nextAutoAt(settings.auto, lastAuto?.started_at ?? null) };
  }

  @Post('scans') @HttpCode(201) @Can('vmware.manage')
  async start(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { text, port, addresses } = readScan(body);
    const id = await startScan(text, port, addresses, req.user.id);
    await audit(req, 'vmware.scan_started', 'success', req.user.id, { id, targets: text.slice(0, 200), addresses: addresses.length, port });
    return { id };
  }

  @Get('scans/:id') @Can('vmware.view', 'vmware.manage')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    await closeStale();
    const d = await scanDetail(id);
    if (!d) throw apiError(404, 'NOT_FOUND', 'Unknown scan');
    return d;
  }

  @Post('scans/:id/cancel') @HttpCode(200) @Can('vmware.manage')
  async cancel(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query("UPDATE vmware_scans SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'", [id]);
    if (!rowCount) throw apiError(409, 'SCAN_NOT_RUNNING', 'The scan is not running');
    await audit(req, 'vmware.scan_cancelled', 'success', req.user.id, { id });
    return { ok: true };
  }

  // The blocks the automatic scan covers, how often it runs and whether new endpoints are reported.
  @Put('scan/settings') @Can('vmware.manage')
  async updateSettings(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const auto = b.auto ?? 'off';
    if (!['off', 'daily', 'weekly'].includes(auto as string)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { auto: 'INVALID_VALUE' });
    const { text, port } = readScan(body, auto === 'off');
    const value: ScanSettings = { targets: text, port, auto: auto as ScanSettings['auto'], notify: b.notify !== false };
    await saveSettings('vmwareScan', value);
    await audit(req, 'vmware.scan_settings', 'success', req.user.id, { auto: value.auto, port, notify: value.notify });
    return value;
  }

  @Post('scan/ignore') @HttpCode(200) @Can('vmware.manage')
  async ignore(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.key !== 'string' || !b.key || b.key.length > 200) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { key: 'INVALID_VALUE' });
    const label = typeof b.label === 'string' ? b.label.slice(0, 200) : null;
    await pool.query('INSERT INTO vmware_scan_ignored (key, label, created_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [b.key, label, req.user.id]);
    await audit(req, 'vmware.scan_ignored', 'success', req.user.id, { key: b.key, label });
    return { ok: true };
  }

  @Post('scan/unignore') @HttpCode(200) @Can('vmware.manage')
  async unignore(@Req() req: AuthedRequest, @Body() body: unknown) {
    const key = ((body ?? {}) as Record<string, unknown>).key;
    if (typeof key !== 'string') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { key: 'INVALID_VALUE' });
    await pool.query('DELETE FROM vmware_scan_ignored WHERE key = $1', [key]);
    await audit(req, 'vmware.scan_unignored', 'success', req.user.id, { key });
    return { ok: true };
  }
}

export function nextAutoAt(auto: 'daily' | 'weekly', last: Date | null) {
  const every = auto === 'daily' ? 86_400_000 : 7 * 86_400_000;
  return new Date(Math.max(Date.now(), (last ? +new Date(last) : 0) + every)).toISOString();
}

// Every 15 minutes: start the automatic scan when it is due (one instance at a time).
export function startVmwareAutoScan() {
  const tick = async () => {
    if (!(await redis.set('lock:vmware-scan', '1', 'EX', 840, 'NX').catch(() => null))) return;
    try {
      await closeStale();
      const s = await getSettings('vmwareScan');
      if (s.auto === 'off' || !s.targets) return;
      const { rows: [last] } = await pool.query('SELECT started_at FROM vmware_scans WHERE auto ORDER BY started_at DESC LIMIT 1');
      if (Date.parse(nextAutoAt(s.auto, last?.started_at ?? null)) > Date.now() + 60_000) return;
      const { addresses } = parseTargets(s.targets);
      if (!addresses.length) return;
      await startScan(s.targets, s.port, addresses, null, true).catch((err) => { if (codeOf(err) !== 'SCAN_RUNNING') throw err; });
    } catch (err) { logEvent('error', 'vmware_auto_scan_failed', { code: codeOf(err) }); }
  };
  setTimeout(tick, 60_000).unref();
  return setInterval(tick, 15 * 60_000).unref();
}
