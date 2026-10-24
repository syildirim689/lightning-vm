// Applications installed on a new server after its first boot (DiyoVM's "ready cPanel & Plesk"): the admin
// defines them (cPanel, Plesk, or any shell script) with a price and, for key-based licences, a pool of keys.
// The order renders the script (licence, host name, IP), cloud-init runs it in the background, and the guest
// reports "installing / installed / failed" back with a one-time token.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { notify } from './notify';
import { Can, PermissionGuard } from './rbac';
import { decryptSecret, encryptSecret } from './secrets';
import { presets } from './app-presets';
import { type Application, defaultScripts, keyPattern, marker, renderInstall, tokenHash } from './application-scripts';
export type { Application } from './application-scripts';

type Input = Record<string, unknown>;

// Called inside the order transaction: checks the choice, takes a licence if needed, renders the script.
export async function prepareApplication(client: PoolClient, app: Application, serverId: string, values: { hostname: string; ip: string }, callbackUrl: string) {
  let license = '';
  if (app.license_mode === 'pool') {
    const { rows: [l] } = await client.query(`SELECT id, key_enc FROM application_licenses WHERE application_id = $1 AND server_id IS NULL
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [app.id]);
    if (!l) throw apiError(409, 'LICENSE_EXHAUSTED', 'No licence left for this application');
    await client.query('UPDATE application_licenses SET server_id = $2, assigned_at = now() WHERE id = $1', [l.id, serverId]);
    license = decryptSecret(l.key_enc, `app-license:${app.id}`);
  }
  const token = randomBytes(24).toString('base64url');
  const script = renderInstall(app, { license, ...values }, callbackUrl, token);
  await client.query(`UPDATE servers SET application_id = $2, app_script_enc = $3, app_token_hash = $4, app_state = 'pending', app_updated_at = now() WHERE id = $1`,
    [serverId, app.id, encryptSecret(script, 'server-app-script'), tokenHash(token)]);
}

function readApplication(body: Input) {
  const fields: Record<string, string> = {};
  const name = typeof body.name === 'string' && body.name.trim() && body.name.trim().length <= 60 ? body.name.trim() : (fields.name = 'INVALID_VALUE', '');
  const kind = ['cpanel', 'plesk', 'custom'].includes(String(body.kind)) ? String(body.kind) as Application['kind'] : (fields.kind = 'INVALID_VALUE', 'custom');
  const script = typeof body.script === 'string' && body.script.trim() ? body.script.replace(/\r\n/g, '\n') : defaultScripts[kind];
  if (script.length > 20000) fields.script = 'TOO_LONG';
  if (script.split('\n').some((l) => l.trim() === marker)) fields.script = 'INVALID_VALUE';
  const licenseMode = body.licenseMode === 'pool' ? 'pool' : 'none';
  if (licenseMode === 'pool' && !script.includes('{LICENSE}')) fields.script = 'LICENSE_PLACEHOLDER_MISSING';
  const int = (k: string, min: number, max: number, d: number) => { const v = body[k] === undefined || body[k] === '' ? d : Number(body[k]); if (!Number.isInteger(v) || v < min || v > max) fields[k] = 'OUT_OF_RANGE'; return v; };
  const minMemoryMb = int('minMemoryMb', 256, 1048576, kind === 'custom' ? 512 : 2048);
  const minDiskGb = int('minDiskGb', 1, 65536, kind === 'custom' ? 10 : 40);
  const price = String(body.priceMonthly ?? '0');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(price)) fields.priceMonthly = 'INVALID_AMOUNT';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { name, kind, description: typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '', script, licenseMode, minMemoryMb, minDiskGb,
    price, active: body.active !== false };
}

@Controller('admin/applications') @UseGuards(PermissionGuard)
export class ApplicationsController {
  @Get() @Can('catalog.view', 'catalog.manage')
  async list() {
    const { rows } = await pool.query(`SELECT a.id, a.name, a.kind, a.description, a.script, a.license_mode AS "licenseMode", a.min_memory_mb AS "minMemoryMb",
        a.min_disk_gb AS "minDiskGb", a.price_monthly::text AS "priceMonthly", a.active,
        (SELECT count(*)::int FROM application_licenses l WHERE l.application_id = a.id AND l.server_id IS NULL) AS "licensesFree",
        (SELECT count(*)::int FROM application_licenses l WHERE l.application_id = a.id) AS "licensesTotal",
        (SELECT count(*)::int FROM servers s WHERE s.application_id = a.id AND s.state <> 'deleted') AS servers
      FROM applications a ORDER BY a.name`);
    return { applications: rows, defaults: defaultScripts, presets: presets.map((p) => ({ ...p, script: p.script || defaultScripts[p.kind] })) };
  }

  @Post() @HttpCode(201) @Can('catalog.manage')
  async create(@Req() req: AuthedRequest, @Body() body: Input) {
    const v = readApplication(body ?? {});
    const { rows: [a] } = await pool.query(`INSERT INTO applications (name, kind, description, script, license_mode, min_memory_mb, min_disk_gb, price_monthly, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [v.name, v.kind, v.description, v.script, v.licenseMode, v.minMemoryMb, v.minDiskGb, v.price, v.active])
      .catch((e) => { if (e.code === '23505') throw apiError(409, 'VALIDATION_FAILED', 'Name taken', { name: 'NAME_TAKEN' }); throw e; });
    await audit(req, 'catalog.application_created', 'success', req.user.id, { id: a.id, name: v.name, kind: v.kind });
    return { id: a.id };
  }

  @Put(':id') @Can('catalog.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const v = readApplication(body ?? {});
    const { rowCount } = await pool.query(`UPDATE applications SET name=$2, kind=$3, description=$4, script=$5, license_mode=$6, min_memory_mb=$7, min_disk_gb=$8,
      price_monthly=$9, active=$10 WHERE id=$1`, [id, v.name, v.kind, v.description, v.script, v.licenseMode, v.minMemoryMb, v.minDiskGb, v.price, v.active]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown application');
    await audit(req, 'catalog.application_updated', 'success', req.user.id, { id });
    return { id };
  }

  @Delete(':id') @HttpCode(204) @Can('catalog.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM servers WHERE application_id = $1 AND state <> 'deleted'", [id]);
    if (n.n) throw apiError(409, 'IN_USE', 'Servers still use this application; turn it off instead');
    await pool.query('DELETE FROM applications WHERE id = $1', [id]);
    await audit(req, 'catalog.application_deleted', 'success', req.user.id, { id });
  }

  // Licence keys, one per line; shown back only as their last characters.
  @Post(':id/licenses') @HttpCode(201) @Can('catalog.manage')
  async addLicenses(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const keys = (Array.isArray(body?.keys) ? body.keys : String(body?.keys ?? '').split(/\r?\n/)).map((k) => String(k).trim()).filter(Boolean);
    if (!keys.length || keys.length > 500 || keys.some((k) => !keyPattern.test(k))) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { keys: 'INVALID_LICENSE_KEYS' });
    const { rowCount } = await pool.query('SELECT 1 FROM applications WHERE id = $1', [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown application');
    for (const k of keys) await pool.query('INSERT INTO application_licenses (application_id, key_enc, key_hint) VALUES ($1, $2, $3)', [id, encryptSecret(k, `app-license:${id}`), k.slice(-4)]);
    await audit(req, 'catalog.application_licenses_added', 'success', req.user.id, { id, count: keys.length });
    return { added: keys.length };
  }

  @Get(':id/licenses') @Can('catalog.view', 'catalog.manage')
  async licenses(@Param('id', ParseUUIDPipe) id: string) {
    const { rows } = await pool.query(`SELECT l.id, l.key_hint AS hint, l.assigned_at AS "assignedAt", s.id AS "serverId", s.name AS "serverName"
      FROM application_licenses l LEFT JOIN servers s ON s.id = l.server_id WHERE l.application_id = $1 ORDER BY l.server_id IS NULL DESC, l.created_at`, [id]);
    return { licenses: rows };
  }

  @Delete('licenses/:licenseId') @HttpCode(204) @Can('catalog.manage')
  async removeLicense(@Req() req: AuthedRequest, @Param('licenseId', ParseUUIDPipe) licenseId: string) {
    const { rowCount } = await pool.query('DELETE FROM application_licenses WHERE id = $1 AND server_id IS NULL', [licenseId]);
    if (!rowCount) throw apiError(409, 'IN_USE', 'Only unassigned licences can be removed');
    await audit(req, 'catalog.application_license_removed', 'success', req.user.id, { licenseId });
  }
}

// The guest reports progress with the token from its script. No session: the token is the credential.
@Controller('servers')
export class ApplicationCallbackController {
  @Post(':id/app-callback') @HttpCode(204)
  async callback(@Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const token = typeof body?.token === 'string' ? body.token : '';
    const status = String(body?.status ?? '');
    if (!['installing', 'installed', 'failed'].includes(status)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { status: 'INVALID_VALUE' });
    const { rows: [s] } = await pool.query("SELECT id, name, owner_id, app_token_hash, app_state FROM servers WHERE id = $1 AND state <> 'deleted'", [id]);
    const given = Buffer.from(tokenHash(token)), stored = Buffer.from(s?.app_token_hash ?? '');
    if (!s || !token || given.length !== stored.length || !timingSafeEqual(given, stored)) throw apiError(404, 'NOT_FOUND', 'Unknown server');
    if (s.app_state === 'installed' || s.app_state === 'failed') return; // final; later reports are ignored
    const message = typeof body?.message === 'string' ? body.message.replace(/[^\x20-\x7e]/g, '').slice(0, 200) : '';
    await pool.query('UPDATE servers SET app_state = $2, app_message = $3, app_updated_at = now() WHERE id = $1', [id, status, message || null]);
    if (status !== 'installing') await notify(status === 'installed' ? 'server.app_installed' : 'server.app_failed', [s.owner_id], { serverId: id, name: s.name, message });
  }
}
