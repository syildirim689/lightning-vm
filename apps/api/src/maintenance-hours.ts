// The quietest hours for work that disturbs servers (the rule: quiet-hour-rules.ts), read from the hourly CPU roll-up
// the usage watch keeps (server_cpu_hourly, apps/worker/anomalies.mjs): for the whole installation, in the panel
// server's own time zone, as a suggestion for the automatic update window; and for one connection and each of its
// hosts, in the viewer's time zone, next to where a host is emptied for maintenance. It only suggests: the update
// window changes through the existing request to the host agent (POST /admin/maintenance/requests, system.update,
// audited), and nothing here moves a server.
// Cost: one grouped statement over at most four weeks of hourly rows per answer; the answer is kept for 30 minutes
// (the roll-up itself changes once an hour).
import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from './auth';
import { noCpuKinds } from './capacity';
import { pool, redis } from './db';
import { apiError } from './errors';
import { hostInfo, settings } from './maintenance';
import { quietHours, quietRule, type LoadRow, type QuietStretch } from './quiet-hour-rules';
import { Can, PermissionGuard } from './rbac';
import { validTimeZone } from './time-zone';

export type QuietAdvice = {
  state: 'suggested' | 'not_measured' | 'not_enough_data';
  days: number; minDays: number; weeks: number;
  servers?: number; usual?: number; peak?: number; weekly?: QuietStretch | null; daily?: (QuietStretch & { worst: number }) | null;
};
const base = { days: 0, minDays: quietRule.minDays, weeks: quietRule.weeks };
const round = (x: number) => Math.round(x * 100) / 100;
const rounded = <T extends QuietStretch>(s: T | null): T | null => (s ? { ...s, load: round(s.load), ...('worst' in s && { worst: round((s as T & { worst: number }).worst) }) } : null);

// now: the start of the hour in progress, as the statement below reads the history (whole hours, four weeks of them).
export function adviceOf(rows: LoadRow[], timeZone: string, now = Math.floor(Date.now() / 3_600_000) * 3_600_000): QuietAdvice {
  const r = quietHours(rows, timeZone, now);
  if (!r.enough || (!r.weekly && !r.daily)) return { ...base, state: 'not_enough_data', days: r.days };
  return { ...base, state: 'suggested', days: r.days, weeks: r.weeks, servers: r.servers, usual: round(r.usual), peak: round(r.peak), weekly: rounded(r.weekly), daily: rounded(r.daily) };
}

// Hourly load per group. Servers that are gone do not count, nor do platforms whose CPU figures are not believed.
// A server counts for the host it runs on now (the last inventory), also for the hours before it was moved there.
const MAX_ROWS = 200 * quietRule.weeks * 7 * 24;
async function loads(group: 'all' | 'connection' | 'host', connectionId?: string): Promise<Map<string, LoadRow[]>> {
  const key = group === 'all' ? "'all'" : group === 'connection' ? 'p.connection_id::text' : 'v.host_moref';
  const { rows } = await pool.query(`SELECT ${key} AS k, h.hour, sum(h.avg_pct * s.vcpu / 100)::float8 AS load, count(*)::int AS servers
    FROM server_cpu_hourly h JOIN servers s ON s.id = h.server_id JOIN resource_pools p ON p.id = s.pool_id JOIN vmware_connections c ON c.id = p.connection_id
      ${group === 'host' ? 'JOIN vmware_vms v ON v.connection_id = p.connection_id AND v.moref = s.vm_moref AND v.host_moref IS NOT NULL' : ''}
    WHERE h.hour >= date_trunc('hour', now()) - make_interval(days => $1) AND h.hour < date_trunc('hour', now()) AND s.deleted_at IS NULL AND s.state <> 'deleted'
      AND c.kind <> ALL($2::text[]) AND ($3::uuid IS NULL OR p.connection_id = $3)
    GROUP BY 1, 2 ORDER BY 2 LIMIT ${MAX_ROWS}`, [quietRule.weeks * 7, noCpuKinds, connectionId ?? null]);
  const out = new Map<string, LoadRow[]>();
  for (const r of rows) {
    const list = out.get(r.k) ?? [];
    if (!list.length) out.set(r.k, list);
    list.push({ t: new Date(r.hour).getTime(), load: r.load, servers: r.servers });
  }
  return out;
}

const KEEP_SECONDS = 1800;
async function kept<T>(key: string, work: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key).catch(() => null);
  if (hit) { try { return JSON.parse(hit) as T; } catch { /* worked out again below */ } }
  const value = await work();
  await redis.set(key, JSON.stringify(value), 'EX', KEEP_SECONDS).catch(() => undefined);
  return value;
}
export const quietKey = (scope: string, timeZone: string) => `quiet:${scope}:${timeZone}`;

// The whole installation, for the update window. Not measured: no connection whose platform reports CPU figures.
export async function panelQuietHours(timeZone: string): Promise<QuietAdvice> {
  return kept(quietKey('all', timeZone), async () => {
    const { rows: [m] } = await pool.query('SELECT count(*)::int AS n FROM vmware_connections WHERE kind <> ALL($1::text[])', [noCpuKinds]);
    if (!m.n) return { ...base, state: 'not_measured' as const };
    return adviceOf((await loads('all')).get('all') ?? [], timeZone);
  });
}

// The daily stretch as the update window is written ("03:00-05:00").
export const windowOf = (a: QuietAdvice) => (a.state === 'suggested' && a.daily ? `${a.daily.time}-${a.daily.end}` : null);

@Controller('admin') @UseGuards(PermissionGuard)
export class MaintenanceHoursController {
  // For Admin → System → Updates. The update window is read by the host in its own time zone (scripts/install.sh,
  // in_window), so the hours are worked out in that zone; when the agent has not recorded it, they are in UTC and
  // `zoneKnown` is false: the page then shows them without offering to apply.
  @Get('maintenance/quiet-hours') @Can('system.view', 'dashboard.view')
  async panel() {
    const zone = validTimeZone(hostInfo()?.timezone);
    const advice = await panelQuietHours(zone ?? 'UTC');
    return { ...advice, timezone: zone ?? 'UTC', zoneKnown: !!zone, window: windowOf(advice), current: settings().updateWindow ?? null };
  }

  // For a connection's page: the connection as a whole and each host that runs panel servers, in the viewer's zone.
  @Get('vmware/connections/:id/quiet-hours') @Can('vmware.view', 'vmware.manage', 'catalog.manage')
  async connection(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Query('timezone') given?: string) {
    let timezone: string | null;
    if (given !== undefined && given !== '') {
      timezone = validTimeZone(given);
      if (!timezone) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { timezone: 'INVALID_VALUE' });
    } else {
      const { rows: [u] } = await pool.query('SELECT time_zone FROM users WHERE id = $1', [req.user.id]);
      timezone = validTimeZone(u?.time_zone) ?? 'UTC';
    }
    const { rows: [c] } = await pool.query('SELECT kind FROM vmware_connections WHERE id = $1', [id]);
    if (!c) throw apiError(404, 'NOT_FOUND', 'Unknown connection');
    const zone = timezone;
    return kept(quietKey(`conn:${id}`, zone), async () => {
      if (noCpuKinds.includes(c.kind)) return { timezone: zone, connection: { ...base, state: 'not_measured' as const }, hosts: [] };
      const [whole, perHost, { rows: hosts }] = await Promise.all([loads('connection', id), loads('host', id),
        pool.query('SELECT moref, name FROM vmware_hosts WHERE connection_id = $1 ORDER BY name LIMIT 200', [id])]);
      return { timezone: zone, connection: adviceOf(whole.get(id) ?? [], zone),
        // Only hosts that run panel servers now: for the others there is nothing to disturb and nothing to read.
        hosts: hosts.filter((h) => perHost.has(h.moref)).map((h) => ({ moref: h.moref as string, name: h.name as string, ...adviceOf(perHost.get(h.moref) ?? [], zone) })) };
    });
  }
}
