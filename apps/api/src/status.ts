// The public status page: how the panel's parts and each location are doing, for anyone (customers check it
// when something seems wrong). Only aggregate states: no connection names, hosts or counts of customers.
// Cached for 15 seconds so the page cannot be used to load the database.
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { live } from './announcement';
import { audit, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { Can, PermissionGuard } from './rbac';
import { getSettings, saveSettings } from './settings-store';

type State = 'ok' | 'degraded' | 'down';
let cache: { at: number; value: unknown } | null = null;
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

async function snapshot() {
  const [db, queue] = await Promise.all([ok(pool.query('SELECT 1')), ok(redis.ping())]);
  const worker = db && (await pool.query("SELECT bool_or(last_seen > now() - interval '90 seconds') AS fresh FROM worker_heartbeats").then((r) => !!r.rows[0]?.fresh, () => false));
  const conn = db ? (await pool.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ok')::int AS ok FROM vmware_connections")).rows[0] : { total: 0, ok: 0 };
  const virtualization: State = !conn.total || conn.ok === conn.total ? 'ok' : conn.ok ? 'degraded' : 'down';
  const services: { key: string; state: State }[] = [
    { key: 'panel', state: 'ok' },
    { key: 'database', state: db ? 'ok' : 'down' },
    { key: 'queue', state: queue ? 'ok' : 'down' },
    { key: 'automation', state: worker ? 'ok' : 'down' },
    { key: 'virtualization', state: virtualization },
  ];
  const locations = db ? (await pool.query(`SELECT name, city, country_code AS "countryCode", status FROM locations WHERE status <> 'hidden' ORDER BY sort, name`)).rows : [];
  const a = await getSettings('announcement').catch(() => null);
  const overall: State = services.some((s) => s.state === 'down') ? 'down' : services.some((s) => s.state === 'degraded') || locations.some((l) => l.status === 'maintenance') ? 'degraded' : 'ok';
  return { overall, services, locations, announcement: a && live(a) ? { tone: a.tone, textTr: a.textTr, textEn: a.textEn } : null, checkedAt: new Date().toISOString() };
}

@Controller('public')
export class StatusController {
  @Get('status')
  async status() {
    if (!(await getSettings('statusPage')).enabled) throw apiError(404, 'NOT_FOUND', 'The status page is off');
    if (!cache || Date.now() - cache.at > 15_000) cache = { at: Date.now(), value: await snapshot() };
    return cache.value;
  }
}

@Controller('admin/settings/status-page') @UseGuards(PermissionGuard)
export class StatusPageSettingsController {
  @Get() @Can('settings.view', 'settings.manage')
  get() { return getSettings('statusPage'); }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: { enabled?: unknown }) {
    if (typeof body?.enabled !== 'boolean') throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { enabled: 'INVALID_VALUE' });
    await saveSettings('statusPage', { enabled: body.enabled });
    await audit(req, 'settings.status_page', 'success', req.user.id, { enabled: body.enabled });
    return { enabled: body.enabled };
  }
}
