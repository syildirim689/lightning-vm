// Power schedules: a server starts or shuts down by itself at a local time on chosen weekdays. The scheduler
// (in the API, every minute, one instance at a time) starts an ordinary operation, so the task list, history
// and notifications behave as if the owner had pressed the button.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { customerMay, findServer, startPowerOperation } from './servers';
import { getSettings } from './settings-store';
import { cleanSchedule } from './smart-rules';

const columns = `id, action, days, to_char(at_time, 'HH24:MI') AS time, timezone, enabled, last_run_at AS "lastRunAt", last_result AS "lastResult"`;

@Controller('servers/:id/schedules') @UseGuards(SessionGuard)
export class SchedulesController {
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id);
    const { rows } = await pool.query(`SELECT ${columns} FROM power_schedules WHERE server_id = $1 ORDER BY at_time, action`, [id]);
    return { schedules: rows };
  }

  @Post() @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    await customerMay(req, 'power');
    const v = valid(body);
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM power_schedules WHERE server_id = $1', [id]);
    if (n.n >= 10) throw apiError(400, 'VALIDATION_FAILED', 'Too many schedules', { action: 'TOO_MANY' });
    const { rows: [row] } = await pool.query(`INSERT INTO power_schedules (server_id, action, days, at_time, timezone, enabled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${columns}`,
      [id, v.action, v.days, v.time, v.timezone, v.enabled]);
    await audit(req, 'server.schedule_created', 'success', req.user.id, { serverId: id, scheduleId: row.id, action: v.action, days: v.days, time: v.time, timezone: v.timezone });
    return row;
  }

  @Put(':sid')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    await customerMay(req, 'power');
    const v = valid(body);
    const { rows: [row] } = await pool.query(`UPDATE power_schedules SET action = $3, days = $4, at_time = $5, timezone = $6, enabled = $7 WHERE id = $2 AND server_id = $1 RETURNING ${columns}`,
      [id, sid, v.action, v.days, v.time, v.timezone, v.enabled]);
    if (!row) throw apiError(404, 'NOT_FOUND', 'Unknown schedule');
    await audit(req, 'server.schedule_updated', 'success', req.user.id, { serverId: id, scheduleId: sid, enabled: v.enabled });
    return row;
  }

  @Delete(':sid') @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string) {
    await findServer(req, id, true);
    const { rowCount } = await pool.query('DELETE FROM power_schedules WHERE id = $2 AND server_id = $1', [id, sid]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown schedule');
    await audit(req, 'server.schedule_deleted', 'success', req.user.id, { serverId: id, scheduleId: sid });
  }
}

function valid(body: Record<string, unknown>) {
  const v = cleanSchedule(body);
  if ('fields' in v) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', v.fields);
  return v;
}

// Schedules due now: the local time is within 5 minutes after the set time on a chosen weekday, and the schedule
// has not run in the last 10 minutes (a late or repeated tick runs it once). shortcut: a tick missed for more
// than 5 minutes (API down) skips that run; a catch-up rule would be needed for longer outages.
export async function runSchedules() {
  const { rows } = await pool.query(`SELECT p.id, p.action, s.id AS server_id, s.owner_id, s.state, s.power_state, s.vm_moref,
      EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) AS busy
    FROM power_schedules p JOIN servers s ON s.id = p.server_id
    WHERE p.enabled AND s.state <> 'deleted' AND (p.last_run_at IS NULL OR p.last_run_at < now() - interval '10 minutes')
      AND EXTRACT(ISODOW FROM now() AT TIME ZONE p.timezone)::smallint = ANY (p.days)
      AND ((now() AT TIME ZONE p.timezone)::time - p.at_time) BETWEEN interval '0' AND interval '5 minutes'`);
  const allowed = (await getSettings('servers')).customer.power;
  for (const r of rows) {
    const wanted = r.action === 'power_on' ? 'poweredOff' : 'poweredOn';
    const result = !allowed ? 'skipped_disabled' : r.busy ? 'skipped_busy' : r.state !== 'ready' || !r.vm_moref || r.power_state !== wanted ? 'skipped_state' : 'started';
    let outcome = result;
    if (result === 'started') {
      // The scheduler acts for nobody in particular: the audit row has no actor and names the schedule.
      const pseudo = { id: `schedule:${r.id}`, ip: null, user: { id: null } } as unknown as AuthedRequest;
      outcome = await startPowerOperation(pseudo, { id: r.server_id, owner_id: r.owner_id }, r.action, `schedule:${r.id}:${Math.floor(Date.now() / 600_000)}`)
        .then(() => 'started', () => 'failed');
    }
    await pool.query('UPDATE power_schedules SET last_run_at = now(), last_result = $2 WHERE id = $1', [r.id, outcome]);
  }
  return rows.length;
}

export function startScheduler() {
  const tick = async () => {
    if (!(await redis.set('lock:schedules', '1', 'EX', 50, 'NX').catch(() => null))) return;
    await runSchedules().catch(() => logEvent('error', 'schedules_failed'));
  };
  return setInterval(tick, 60_000).unref();
}
