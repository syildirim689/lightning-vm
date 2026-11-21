// Power schedule suggestion: when a server's CPU history shows hours of the week in which it has been idle week after
// week, the panel proposes the schedule that would keep it off through them (the rule: schedule-rules.ts) and, on an
// explicit click by someone who may power the server, creates it through the schedules' own code (schedules.ts).
// What it saves is said as it is: billing charges the same for a server that is switched off (a subscription is for
// the period, pay-as-you-go counts every hour the server exists), so no money is promised; the energy the server's
// share of its host used in those hours is, where the platform measures it.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { noCpuKinds } from './capacity';
import type { PoolClient } from 'pg';
import { pool, redis } from './db';
import { apiError } from './errors';
import { Can } from './rbac';
import { addSchedules } from './schedules';
import { scheduleRule, suggestSchedule, type Suggested } from './schedule-rules';
import { findServer } from './servers';
import { validTimeZone } from './time-zone';
import { storedTimeZone } from './time-zone-db';

// A server that is switched off is billed as one that runs (billing.ts: renewals are per period; runHourly adds every
// started hour while the server exists and only stops for a server held for an empty balance). Should billing ever
// charge less for a stopped server, this is the one place that says so to the suggestion.
export const OFF_SERVER_COSTS_LESS = false;
export const scheduleKey = (serverId: string) => `schedule:${serverId}`;

export type ScheduleAdvice = {
  state: 'suggested' | 'not_measured' | 'not_enough_data' | 'scheduled' | 'always_idle' | 'no_window';
  timezone: string; days: number; minDays: number; weeks: number;
  kind?: 'nightly' | 'weekly'; offHours?: number; idleHours?: number; schedules?: Suggested[];
  savesMoney: boolean; energyKwhPerWeek: number | null; hidden: boolean;
};

export async function scheduleAdvice(userId: string, server: { id: string; pool_id: string }, timezone: string): Promise<ScheduleAdvice> {
  const base = { timezone, days: 0, minDays: scheduleRule.minDays, weeks: scheduleRule.weeks, savesMoney: OFF_SERVER_COSTS_LESS, energyKwhPerWeek: null, hidden: false };
  const { rows: [k] } = await pool.query('SELECT c.kind FROM resource_pools p JOIN vmware_connections c ON c.id = p.connection_id WHERE p.id = $1', [server.pool_id]);
  if (!k || noCpuKinds.includes(k.kind)) return { ...base, state: 'not_measured' };
  // A server that already starts or stops by schedule is left to its owner's plan.
  const { rows: [has] } = await pool.query("SELECT 1 FROM power_schedules WHERE server_id = $1 AND enabled AND action IN ('shutdown', 'power_on') LIMIT 1", [server.id]);
  if (has) return { ...base, state: 'scheduled' };
  const { rows } = await pool.query(`SELECT hour, avg_pct::float8 AS avg, max_pct::float8 AS max FROM server_cpu_hourly WHERE server_id = $1 AND hour >= now() - make_interval(days => $2) ORDER BY hour`,
    [server.id, scheduleRule.weeks * 7]);
  const r = suggestSchedule(rows.map((x) => ({ t: new Date(x.hour).getTime(), avg: x.avg, max: x.max })), timezone, Date.now());
  if (!r.enough) return { ...base, state: 'not_enough_data', days: r.days };
  if (r.reason) return { ...base, state: r.reason, days: r.days, idleHours: r.idleHours };
  const [{ rows: [w] }, { rows: [d] }] = await Promise.all([
    // The server's average share of its host's power over the last week (power.mjs), where there is any.
    pool.query(`SELECT (sum(watts * minutes) / nullif(sum(minutes), 0))::float8 AS watts FROM power_server_samples WHERE server_id = $1 AND at > now() - interval '7 days'`, [server.id]),
    pool.query('SELECT 1 FROM insight_dismissals WHERE user_id = $1 AND key = $2 AND (until IS NULL OR until > now())', [userId, scheduleKey(server.id)]),
  ]);
  return { ...base, state: 'suggested', days: r.days, idleHours: r.idleHours, kind: r.kind, offHours: r.offHours, schedules: r.schedules,
    energyKwhPerWeek: w?.watts ? Math.round((w.watts * r.offHours) / 100) / 10 : null, hidden: !!d };
}

// For the insights: the customer's running servers that have a suggestion, in the account's time zone (UTC when none
// is set; the server's page works it out again in the browser's). At most 20 servers, each answer kept for six hours.
export async function scheduleInsights(userId: string): Promise<{ id: string; name: string; offHours: number; kind: string }[]> {
  const { rows: [u] } = await pool.query('SELECT time_zone FROM users WHERE id = $1', [userId]);
  const timezone = validTimeZone(u?.time_zone) ?? 'UTC';
  const { rows } = await pool.query(`SELECT id, name, pool_id FROM servers WHERE owner_id = $1 AND state = 'ready' AND power_state = 'poweredOn' AND delete_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM power_schedules p WHERE p.server_id = servers.id AND p.enabled AND p.action IN ('shutdown', 'power_on')) ORDER BY name LIMIT 20`, [userId]);
  const out: { id: string; name: string; offHours: number; kind: string }[] = [];
  for (const s of rows) {
    const key = `insight:schedule:${s.id}:${timezone}`;
    const hit = await redis.get(key).catch(() => null);
    let a: Pick<ScheduleAdvice, 'state' | 'offHours' | 'kind'>;
    if (hit) a = JSON.parse(hit);
    else {
      const full = await scheduleAdvice(userId, s, timezone);
      a = { state: full.state, offHours: full.offHours, kind: full.kind };
      await redis.set(key, JSON.stringify(a), 'EX', 6 * 3600).catch(() => undefined);
    }
    if (a.state === 'suggested') out.push({ id: s.id, name: s.name, offHours: a.offHours ?? 0, kind: a.kind ?? 'nightly' });
  }
  return out;
}

@Controller('servers/:id/schedule-suggestion') @UseGuards(SessionGuard)
export class ScheduleSuggestionController {
  // timezone: the zone the times are worked out in and the schedules would be saved with (the browser's); the
  // account's own, else UTC, when it is left out.
  @Get()
  async read(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Query('timezone') timezone?: string) {
    const s = await findServer(req, id);
    return scheduleAdvice(req.user.id, s, await this.zone(req, timezone));
  }

  // Creates the suggested schedules. The suggestion is worked out again here, from the history as it is now: nothing
  // the browser sends decides what is created. The schedules are ordinary ones afterwards (edit, pause, remove).
  @Post() @HttpCode(201) @Can('server.power')
  async apply(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: { timezone?: unknown }) {
    const s = await findServer(req, id, true);
    // Saved under a name the database knows (the scheduler reads the clock in it): the zone asked for, or its other name.
    const timezone = await storedTimeZone(await this.zone(req, body?.timezone));
    if (!timezone) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { timezone: 'INVALID_VALUE' });
    const none = () => apiError(409, 'NO_SUGGESTION', 'There is no schedule to suggest for this server now');
    const a = await scheduleAdvice(req.user.id, s, timezone);
    if (a.state !== 'suggested' || !a.schedules) throw none();
    // Both schedules or neither, and once: written in one transaction under the server's lock, in which "it has no
    // power schedule yet" is looked at again. A second click, or the same request from another tab, waits for the
    // first and then finds the server scheduled; a server one schedule short of its limit gets none of the two,
    // not a shutdown without its start.
    const created = await addSchedules(req, s, a.schedules.map((x) => ({ ...x, timezone, enabled: true })), { suggested: true, offHours: a.offHours }, async (db: PoolClient) => {
      if ((await db.query("SELECT 1 FROM power_schedules WHERE server_id = $1 AND enabled AND action IN ('shutdown', 'power_on') LIMIT 1", [id])).rowCount) throw none();
    });
    // (The insights do not need telling: they ask only about servers without a power schedule.)
    return { schedules: created };
  }

  private async zone(req: AuthedRequest, given: unknown) {
    if (given !== undefined && given !== null && given !== '') {
      const tz = validTimeZone(given);
      if (!tz) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { timezone: 'INVALID_VALUE' });
      return tz;
    }
    const { rows: [u] } = await pool.query('SELECT time_zone FROM users WHERE id = $1', [req.user.id]);
    return validTimeZone(u?.time_zone) ?? 'UTC';
  }
}
