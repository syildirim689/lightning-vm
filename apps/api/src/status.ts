// The public status page: how the panel's parts and each location are doing, for anyone (customers check it
// when something seems wrong). Only aggregate states: no connection names, hosts or counts of customers.
// Cached for 15 seconds so the page cannot be used to load the database.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { logEvent } from './log';
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

// Per component and day for the last 90 days: the share of samples that were "ok", and whether any was "down".
async function history() {
  const { rows } = await pool.query(`SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, s.key, count(*)::int AS total,
      count(*) FILTER (WHERE s.value = 'ok')::int AS ok, count(*) FILTER (WHERE s.value = 'down')::int AS down
    FROM status_samples, jsonb_each_text(services) AS s(key, value) WHERE at > now() - interval '90 days' GROUP BY 1, 2 ORDER BY 1`);
  const days: Record<string, { day: string; ok: number; down: boolean }[]> = {};
  const uptime: Record<string, number> = {};
  const sums: Record<string, [number, number]> = {};
  for (const r of rows) {
    (days[r.key] ??= []).push({ day: r.day, ok: r.ok / r.total, down: r.down > 0 });
    const s = (sums[r.key] ??= [0, 0]); s[0] += r.ok; s[1] += r.total;
  }
  for (const [k, [ok, total]] of Object.entries(sums)) uptime[k] = Math.round((ok / total) * 10_000) / 100;
  return { days, uptime };
}

// Open incidents, and those resolved in the last 7 days, each with its updates (newest first).
export async function publicIncidents() {
  const { rows } = await pool.query(`SELECT i.id, i.title, i.impact, i.status, i.components, i.created_at AS "createdAt", i.resolved_at AS "resolvedAt",
      coalesce((SELECT json_agg(json_build_object('status', u.status, 'body', u.body, 'at', u.created_at) ORDER BY u.created_at DESC) FROM incident_updates u WHERE u.incident_id = i.id), '[]') AS updates
    FROM incidents i WHERE i.resolved_at IS NULL OR i.resolved_at > now() - interval '7 days' ORDER BY i.resolved_at IS NOT NULL, i.created_at DESC LIMIT 20`);
  return rows;
}

@Controller('public')
export class StatusController {
  @Get('status')
  async status() {
    if (!(await getSettings('statusPage')).enabled) throw apiError(404, 'NOT_FOUND', 'The status page is off');
    if (!cache || Date.now() - cache.at > 15_000) {
      const [now, past, incidents] = await Promise.all([snapshot(), history(), publicIncidents()]);
      // An open incident counts on the whole: major is "down", minor or maintenance "degraded".
      const open = incidents.filter((i) => !i.resolvedAt);
      const worst = open.some((i) => i.impact === 'major') ? 'down' : open.length ? 'degraded' : 'ok';
      const rank = { ok: 0, degraded: 1, down: 2 } as const;
      cache = { at: Date.now(), value: { ...now, overall: rank[worst] > rank[now.overall] ? worst : now.overall, history: past, incidents } };
    }
    return cache.value;
  }
}

// Every 5 minutes, one copy of the API records each component's state (and drops samples older than 90 days).
export function startStatusSampler() {
  const tick = async () => {
    if (!(await redis.set('lock:status-sample', '1', 'EX', 280, 'NX').catch(() => null))) return;
    try {
      const s = await snapshot();
      await pool.query('INSERT INTO status_samples (services) VALUES ($1)', [Object.fromEntries(s.services.map((x) => [x.key, x.state]))]);
      await pool.query("DELETE FROM status_samples WHERE at < now() - interval '90 days'");
    } catch { logEvent('error', 'status_sample_failed'); }
  };
  void tick();
  return setInterval(tick, 300_000).unref();
}

const incidentStatus = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
const components = ['panel', 'database', 'queue', 'automation', 'virtualization'];

// Incidents: opened with a first update, then updates until resolved. Staff with settings.manage write them.
@Controller('admin/incidents') @UseGuards(PermissionGuard)
export class IncidentsController {
  @Get() @Can('settings.view', 'settings.manage')
  async list() {
    const { rows } = await pool.query(`SELECT i.id, i.title, i.impact, i.status, i.components, i.created_at AS "createdAt", i.resolved_at AS "resolvedAt",
        coalesce((SELECT json_agg(json_build_object('status', u.status, 'body', u.body, 'at', u.created_at) ORDER BY u.created_at DESC) FROM incident_updates u WHERE u.incident_id = i.id), '[]') AS updates
      FROM incidents i ORDER BY i.resolved_at IS NOT NULL, i.created_at DESC LIMIT 100`);
    return { incidents: rows };
  }

  @Post() @HttpCode(201) @Can('settings.manage')
  async open(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const fields: Record<string, string> = {};
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 160) fields.title = 'INVALID_VALUE';
    const impact = ['minor', 'major', 'maintenance'].includes(String(body?.impact)) ? String(body.impact) : (fields.impact = 'INVALID_VALUE', '');
    const status = incidentStatus.includes(body?.status as 'investigating') ? String(body.status) : 'investigating';
    const parts = Array.isArray(body?.components) ? [...new Set(body.components.map(String))] : [];
    if (parts.some((c) => !components.includes(c))) fields.components = 'INVALID_VALUE';
    const text = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!text || text.length > 2000) fields.body = 'INVALID_VALUE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const { rows: [i] } = await pool.query('INSERT INTO incidents (title, impact, status, components, created_by, resolved_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [title, impact, status, parts, req.user.id, status === 'resolved' ? new Date() : null]);
    await pool.query('INSERT INTO incident_updates (incident_id, status, body, author_id) VALUES ($1, $2, $3, $4)', [i.id, status, text, req.user.id]);
    cache = null;
    await audit(req, 'incident.opened', 'success', req.user.id, { id: i.id, title, impact });
    return { id: i.id };
  }

  @Post(':id/updates') @HttpCode(201) @Can('settings.manage')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    const status = incidentStatus.includes(body?.status as 'investigating') ? String(body.status) : null;
    const text = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!status || !text || text.length > 2000) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { ...(!status && { status: 'INVALID_VALUE' }), ...((!text || text.length > 2000) && { body: 'INVALID_VALUE' }) });
    const { rowCount } = await pool.query('UPDATE incidents SET status = $2, resolved_at = CASE WHEN $2 = \'resolved\' THEN coalesce(resolved_at, now()) ELSE NULL END WHERE id = $1', [id, status]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown incident');
    await pool.query('INSERT INTO incident_updates (incident_id, status, body, author_id) VALUES ($1, $2, $3, $4)', [id, status, text, req.user.id]);
    cache = null;
    await audit(req, 'incident.updated', 'success', req.user.id, { id, status });
    return { ok: true };
  }

  @Delete(':id') @HttpCode(204) @Can('settings.manage')
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { rowCount } = await pool.query('DELETE FROM incidents WHERE id = $1', [id]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown incident');
    cache = null;
    await audit(req, 'incident.deleted', 'success', req.user.id, { id });
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
