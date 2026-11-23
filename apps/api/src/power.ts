// Energy report: host power (measured or estimated, see apps/worker/power.mjs), energy over time, cost and
// carbon with the admin's price, PUE and grid factor, per host, per location and per server.
import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { getSettings, saveSettings } from './settings-store';

type Input = Record<string, unknown>;
const ranges = { '1d': { interval: '1 day', bucket: 'hour' }, '7d': { interval: '7 days', bucket: 'hour' }, '30d': { interval: '30 days', bucket: 'day' } } as const;
const queue = new Queue('power', { connection: redis });
// kWh of a set of samples: watts x minutes / 60 / 1000.
const kwh = 'COALESCE(sum(watts * minutes) / 60000, 0)::float8';

@Controller('admin') @UseGuards(PermissionGuard)
export class PowerController {
  @Get('power') @Can('dashboard.view', 'system.view')
  async report(@Query('range') r?: string) {
    const range = ranges[(r ?? '1d') as keyof typeof ranges] ?? ranges['1d'];
    const e = await getSettings('energy');
    const facility = (x: number) => x * Number(e.pue);
    const [now, series, totals, hosts, locations, servers] = await Promise.all([
      // The newest sample of each host from the last 15 minutes.
      pool.query(`SELECT DISTINCT ON (connection_id, host_moref) connection_id, host_moref, watts::float8 AS watts, source FROM power_samples
        WHERE at > now() - interval '15 minutes' ORDER BY connection_id, host_moref, at DESC`),
      pool.query(`SELECT date_trunc($2, at) AS t, ${kwh} AS kwh, (sum(watts * minutes) / NULLIF(sum(minutes), 0) * count(DISTINCT (connection_id, host_moref)))::float8 AS watts
        FROM power_samples WHERE at > now() - $1::interval GROUP BY 1 ORDER BY 1`, [range.interval, range.bucket]),
      pool.query(`SELECT (SELECT ${kwh} FROM power_samples WHERE at >= date_trunc('day', now())) AS today,
        (SELECT ${kwh} FROM power_samples WHERE at >= date_trunc('month', now())) AS month,
        (SELECT ${kwh} FROM power_samples WHERE at > now() - $1::interval) AS range`, [range.interval]),
      // lastAt: the host's newest sample, so a view can tell "now" from "earlier in the range" per host (the live wall).
      pool.query(`SELECT s.connection_id AS "connectionId", c.name AS connection, s.host_moref AS moref, max(s.host_name) AS name, ${kwh} AS kwh,
          (array_agg(s.watts::float8 ORDER BY s.at DESC))[1] AS watts, (array_agg(s.source ORDER BY s.at DESC))[1] AS source,
          (array_agg(s.cpu_util::float8 ORDER BY s.at DESC))[1] AS "cpuUtil", max(s.at) AS "lastAt", p.idle_watts AS "idleWatts", p.max_watts AS "maxWatts"
        FROM power_samples s JOIN vmware_connections c ON c.id = s.connection_id
        LEFT JOIN power_host_profiles p ON p.connection_id = s.connection_id AND p.host_moref = s.host_moref
        WHERE s.at > now() - $1::interval GROUP BY s.connection_id, c.name, s.host_moref, p.idle_watts, p.max_watts ORDER BY kwh DESC`, [range.interval]),
      // Per location: hosts belong to a compute resource (vmware_hosts.parent) that a pool of the location uses.
      pool.query(`SELECT l.id, l.name, l.country_code AS "countryCode", ${kwh} AS kwh FROM power_samples s
        JOIN vmware_hosts h ON h.connection_id = s.connection_id AND h.moref = s.host_moref
        JOIN LATERAL (SELECT location_id FROM resource_pools rp WHERE rp.connection_id = s.connection_id AND rp.compute_moref = h.parent AND rp.location_id IS NOT NULL LIMIT 1) rp ON true
        JOIN locations l ON l.id = rp.location_id WHERE s.at > now() - $1::interval GROUP BY l.id ORDER BY kwh DESC`, [range.interval]),
      pool.query(`SELECT v.id, v.name, u.email AS owner, p.location, ${kwh} AS kwh, avg(x.watts)::float8 AS watts
        FROM power_server_samples x JOIN servers v ON v.id = x.server_id JOIN users u ON u.id = v.owner_id JOIN resource_pools p ON p.id = v.pool_id
        WHERE x.at > now() - $1::interval GROUP BY v.id, u.email, p.location ORDER BY kwh DESC LIMIT 50`, [range.interval]),
    ]);
    const t = totals.rows[0];
    const money = (k: number) => (facility(k) * Number(e.pricePerKwh)).toFixed(2);
    const co2 = (k: number) => Math.round(facility(k) * Number(e.co2GramsPerKwh)) / 1000; // kg
    return {
      settings: e,
      now: { watts: now.rows.reduce((a, x) => a + x.watts, 0), facilityWatts: facility(now.rows.reduce((a, x) => a + x.watts, 0)), hosts: now.rows.length,
        measured: now.rows.filter((x) => x.source === 'measured').length },
      energy: { todayKwh: t.today, monthKwh: t.month, rangeKwh: t.range, facilityMonthKwh: facility(t.month), costToday: money(t.today), costMonth: money(t.month), costRange: money(t.range),
        co2MonthKg: co2(t.month), co2RangeKg: co2(t.range) },
      series: series.rows, hosts: hosts.rows, locations: locations.rows, servers: servers.rows,
    };
  }

  // Idle and full-load watts of a host without a power counter (both empty: back to the default profile).
  @Put('power/profiles') @Can('settings.manage')
  async profile(@Req() req: AuthedRequest, @Body() body: Input) {
    const c = String(body?.connectionId ?? ''), h = String(body?.hostMoref ?? '');
    if (!/^[0-9a-f-]{36}$/.test(c) || !/^[\w-]{1,80}$/.test(h)) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { hostMoref: 'INVALID_VALUE' });
    if (body.idleWatts === null && body.maxWatts === null) {
      await pool.query('DELETE FROM power_host_profiles WHERE connection_id = $1 AND host_moref = $2', [c, h]);
    } else {
      const idle = Number(body.idleWatts), max = Number(body.maxWatts);
      const fields: Record<string, string> = {};
      if (!Number.isInteger(idle) || idle < 0 || idle > 20000) fields.idleWatts = 'OUT_OF_RANGE';
      if (!Number.isInteger(max) || max < 1 || max > 20000 || max < idle) fields.maxWatts = 'OUT_OF_RANGE';
      if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
      await pool.query(`INSERT INTO power_host_profiles (connection_id, host_moref, idle_watts, max_watts) VALUES ($1, $2, $3, $4)
        ON CONFLICT (connection_id, host_moref) DO UPDATE SET idle_watts = $3, max_watts = $4`, [c, h, idle, max]);
    }
    await audit(req, 'power.profile', 'success', req.user.id, { connectionId: c, hostMoref: h, idleWatts: body.idleWatts ?? null, maxWatts: body.maxWatts ?? null });
    return { ok: true };
  }

  @Post('power/sample') @HttpCode(202) @Can('dashboard.view', 'system.view')
  async sample() {
    await queue.add('sample', {}, { removeOnComplete: true, removeOnFail: true });
    return { queued: true };
  }

  @Get('settings/energy') @Can('settings.view', 'settings.manage')
  energy() { return getSettings('energy'); }

  @Put('settings/energy') @Can('settings.manage')
  async saveEnergy(@Req() req: AuthedRequest, @Body() body: Input) {
    const fields: Record<string, string> = {};
    const price = String(body?.pricePerKwh ?? '0').replace(',', '.');
    if (!/^\d{1,4}(\.\d{1,4})?$/.test(price)) fields.pricePerKwh = 'INVALID_AMOUNT';
    const currency = String(body?.currency ?? 'TRY').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) fields.currency = 'INVALID_VALUE';
    const pue = Number(body?.pue ?? 1.5), co2 = Number(body?.co2GramsPerKwh ?? 420);
    if (!(pue >= 1 && pue <= 3)) fields.pue = 'OUT_OF_RANGE';
    if (!(Number.isInteger(co2) && co2 >= 0 && co2 <= 2000)) fields.co2GramsPerKwh = 'OUT_OF_RANGE';
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    const value = { pricePerKwh: price, currency, pue: Math.round(pue * 100) / 100, co2GramsPerKwh: co2 };
    await saveSettings('energy', value);
    await audit(req, 'settings.energy', 'success', req.user.id, value);
    return value;
  }
}
