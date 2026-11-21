// Statistics (Admin → Statistics): growth and activity over a chosen period, each headline number beside the
// same-length period before it, what the live servers are made of, the biggest customers and when people work.
// Read-only aggregates over servers, users, operations and tickets. Days and hours follow the viewer's time zone.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { pool } from './db';
import { Can, PermissionGuard } from './rbac';
import { storedTimeZone } from './time-zone-db';

export const ranges = [7, 30, 90, 365] as const;
type Row = Record<string, unknown>;
const int = (v: unknown) => Number(v ?? 0);
// "Live at a moment": created before it and not deleted by then.
const liveAt = (at: string, p = '') => `${p}created_at <= ${at} AND (${p}deleted_at IS NULL OR ${p}deleted_at > ${at}) AND ${p}state <> 'provisioning'`;

// Change against the previous period, in percent; null when there is nothing to compare with.
export const change = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : now > 0 ? null : 0);

@Controller('admin/stats') @UseGuards(PermissionGuard)
export class StatsController {
  @Get() @Can('dashboard.view')
  async stats(@Query('days') raw?: string, @Query('tz') rawTz?: string) {
    // Read in SQL below: a name the database knows (time-zone.ts), else UTC.
    const tz = (await storedTimeZone(rawTz).catch(() => null)) ?? 'UTC';
    const days = ranges.find((r) => String(r) === raw) ?? 30;
    // A year is drawn by week; shorter periods by day.
    const unit = days > 90 ? 'week' : 'day';
    const args = [days, unit, tz];
    const start = 'now() - make_interval(days => $1)', prev = 'now() - make_interval(days => $1 * 2)';
    const q = (sql: string, a: unknown[] = args) => pool.query(sql, a).then((r) => r.rows as Row[]);

    const [buckets, created, deleted, signups, opened, closed, ops] = await Promise.all([
      q(`SELECT to_char(generate_series(date_trunc($2, (${start}) AT TIME ZONE $3), date_trunc($2, now() AT TIME ZONE $3), ('1 ' || $2)::interval), 'YYYY-MM-DD') AS at`),
      q(`SELECT to_char(date_trunc($2, created_at AT TIME ZONE $3), 'YYYY-MM-DD') AS at, count(*)::int AS n FROM servers WHERE created_at > ${start} GROUP BY 1`),
      q(`SELECT to_char(date_trunc($2, deleted_at AT TIME ZONE $3), 'YYYY-MM-DD') AS at, count(*)::int AS n FROM servers WHERE deleted_at > ${start} GROUP BY 1`),
      q(`SELECT to_char(date_trunc($2, created_at AT TIME ZONE $3), 'YYYY-MM-DD') AS at, count(*)::int AS n FROM users WHERE created_at > ${start} GROUP BY 1`),
      q(`SELECT to_char(date_trunc($2, created_at AT TIME ZONE $3), 'YYYY-MM-DD') AS at, count(*)::int AS n FROM tickets WHERE created_at > ${start} GROUP BY 1`),
      q(`SELECT to_char(date_trunc($2, closed_at AT TIME ZONE $3), 'YYYY-MM-DD') AS at, count(*)::int AS n FROM tickets WHERE closed_at > ${start} GROUP BY 1`),
      q(`SELECT to_char(date_trunc($2, created_at AT TIME ZONE $3), 'YYYY-MM-DD') AS at, count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM operations WHERE created_at > ${start} GROUP BY 1`),
    ]);
    const key = (v: unknown) => String(v);
    const index = (rows: Row[], field = 'n') => new Map(rows.map((r) => [key(r.at), int(r[field])]));
    const [c, d, s, o, cl, ok, bad] = [index(created), index(deleted), index(signups), index(opened), index(closed), index(ops, 'ok'), index(ops, 'failed')];
    const series = buckets.map((b) => { const k = key(b.at); return { at: k, created: c.get(k) ?? 0, deleted: d.get(k) ?? 0, signups: s.get(k) ?? 0, ticketsOpened: o.get(k) ?? 0,
      ticketsClosed: cl.get(k) ?? 0, opsOk: ok.get(k) ?? 0, opsFailed: bad.get(k) ?? 0 }; });

    const [[k], money, byLocation, byImage, byPackage, byPower, top, heat] = await Promise.all([
      q(`SELECT
          (SELECT count(*) FROM servers WHERE ${liveAt('now()')})::int AS servers,
          (SELECT count(*) FROM servers WHERE ${liveAt(start)})::int AS "serversBefore",
          (SELECT count(*) FROM users WHERE created_at > ${start})::int AS signups,
          (SELECT count(*) FROM users WHERE created_at > ${prev} AND created_at <= ${start})::int AS "signupsBefore",
          (SELECT count(*) FROM users)::int AS users,
          (SELECT count(*) FROM tickets WHERE created_at > ${start})::int AS tickets,
          (SELECT count(*) FROM tickets WHERE created_at > ${prev} AND created_at <= ${start})::int AS "ticketsBefore",
          (SELECT round(avg(rating)::numeric, 2)::float8 FROM tickets WHERE rating IS NOT NULL AND closed_at > ${start}) AS rating,
          (SELECT round(avg(extract(epoch FROM first_response_at - created_at) / 3600)::numeric, 1)::float8 FROM tickets WHERE created_at > ${start} AND first_response_at IS NOT NULL) AS "firstResponseHours",
          (SELECT count(*) FILTER (WHERE status = 'succeeded')::int FROM operations WHERE created_at > ${start}) AS "opsOk",
          (SELECT count(*) FILTER (WHERE status IN ('succeeded', 'failed'))::int FROM operations WHERE created_at > ${start}) AS "opsDone",
          (SELECT count(*) FILTER (WHERE status = 'succeeded')::int FROM operations WHERE created_at > ${prev} AND created_at <= ${start}) AS "opsOkBefore",
          (SELECT count(*) FILTER (WHERE status IN ('succeeded', 'failed'))::int FROM operations WHERE created_at > ${prev} AND created_at <= ${start}) AS "opsDoneBefore",
          (SELECT coalesce(sum(vcpu), 0)::int FROM servers WHERE ${liveAt('now()')}) AS vcpu,
          (SELECT coalesce(sum(memory_mb), 0)::bigint FROM servers WHERE ${liveAt('now()')}) AS "memoryMb",
          (SELECT coalesce(sum(disk_gb), 0)::bigint FROM servers WHERE ${liveAt('now()')}) AS "diskGb"`, [days]),
      // Monthly amount of the live servers, now and at the start, in each currency.
      q(`SELECT currency, coalesce(sum(price_monthly) FILTER (WHERE ${liveAt('now()')}), 0)::float8 AS now, coalesce(sum(price_monthly) FILTER (WHERE ${liveAt(start)}), 0)::float8 AS before,
         count(*) FILTER (WHERE ${liveAt('now()')})::int AS servers FROM servers GROUP BY currency ORDER BY 4 DESC`, [days]),
      q(`SELECT coalesce(l.name, p.name) AS name, count(*)::int AS servers, sum(s.vcpu)::int AS vcpu FROM servers s JOIN resource_pools p ON p.id = s.pool_id
         LEFT JOIN locations l ON l.id = p.location_id WHERE ${liveAt('now()', 's.')} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, []),
      q(`SELECT i.name, i.family, count(*)::int AS servers FROM servers s JOIN os_images i ON i.id = s.image_id
         WHERE ${liveAt('now()', 's.')} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`, []),
      q(`SELECT coalesce(k.name, '') AS name, count(*)::int AS servers FROM servers s LEFT JOIN packages k ON k.id = s.package_id
         WHERE ${liveAt('now()', 's.')} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, []),
      q(`SELECT power_state AS state, count(*)::int AS servers FROM servers WHERE ${liveAt('now()')} GROUP BY 1 ORDER BY 2 DESC`, []),
      q(`SELECT u.id, u.email, coalesce(u.name, '') AS name, count(*)::int AS servers, sum(s.price_monthly)::float8 AS monthly, s.currency, sum(s.vcpu)::int AS vcpu
         FROM servers s JOIN users u ON u.id = s.owner_id WHERE ${liveAt('now()', 's.')}
         GROUP BY u.id, s.currency ORDER BY monthly DESC, servers DESC LIMIT 8`, []),
      // When things happen: operations by weekday (1 = Monday) and hour.
      q(`SELECT extract(isodow FROM created_at AT TIME ZONE $2)::int AS day, extract(hour FROM created_at AT TIME ZONE $2)::int AS hour, count(*)::int AS n FROM operations WHERE created_at > ${start} GROUP BY 1, 2`, [days, tz]),
    ]);
    const main = money[0];
    const rate = (okN: number, done: number) => (done ? Math.round((okN / done) * 1000) / 10 : null);
    const successRate = rate(int(k.opsOk), int(k.opsDone)), successBefore = rate(int(k.opsOkBefore), int(k.opsDoneBefore));
    return {
      days, unit, tz,
      kpis: {
        servers: { value: int(k.servers), change: change(int(k.servers), int(k.serversBefore)) },
        monthly: main ? { value: main.now, currency: main.currency, change: change(Number(main.now), Number(main.before)) } : null,
        signups: { value: int(k.signups), change: change(int(k.signups), int(k.signupsBefore)), total: int(k.users) },
        tickets: { value: int(k.tickets), change: change(int(k.tickets), int(k.ticketsBefore)), rating: k.rating, firstResponseHours: k.firstResponseHours },
        successRate: { value: successRate, change: successRate !== null && successBefore !== null ? Math.round((successRate - successBefore) * 10) / 10 : null },
        resources: { vcpu: int(k.vcpu), memoryGb: Math.round(int(k.memoryMb) / 1024), diskGb: int(k.diskGb) },
      },
      currencies: money.filter((m) => int(m.servers) > 0),
      series, byLocation, byImage, byPackage, byPower, top, heat,
    };
  }
}
