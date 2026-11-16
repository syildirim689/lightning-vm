// Power schedules: a server starts, shuts down or takes a snapshot by itself at a local time on chosen weekdays. The scheduler
// (in the API, every minute, one instance at a time) starts an ordinary operation, so the task list, history
// and notifications behave as if the owner had pressed the button.
import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { Can } from './rbac';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { customerMay, findServer, runDueDeletions, startPowerOperation } from './servers';
import { getSettings } from './settings-store';
import { hashOf, startOperation } from './servers';
import { limitsOf } from './permissions';
import { MAX_SNAPSHOTS } from './snapshots';
import { callAdapter, storedTarget } from './vmware';
import { cleanSchedule } from './smart-rules';
import { startBackup } from './backups';

const columns = `id, action, days, to_char(at_time, 'HH24:MI') AS time, timezone, enabled, keep, last_run_at AS "lastRunAt", last_result AS "lastResult"`;

@Controller('servers/:id/schedules') @UseGuards(SessionGuard)
export class SchedulesController {
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await findServer(req, id);
    const { rows } = await pool.query(`SELECT ${columns} FROM power_schedules WHERE server_id = $1 ORDER BY at_time, action`, [id]);
    return { schedules: rows };
  }

  @Post() @HttpCode(201) @Can('server.power', 'server.snapshots', 'server.backups')
  async create(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    const v = valid(body);
    await customerMay(req, v.action === 'snapshot' ? 'snapshots' : v.action === 'backup' ? 'backups' : 'power');
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM power_schedules WHERE server_id = $1', [id]);
    if (n.n >= 10) throw apiError(400, 'VALIDATION_FAILED', 'Too many schedules', { action: 'TOO_MANY' });
    const { rows: [row] } = await pool.query(`INSERT INTO power_schedules (server_id, action, days, at_time, timezone, enabled, keep) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${columns}`,
      [id, v.action, v.days, v.time, v.timezone, v.enabled, v.keep ?? null]);
    await audit(req, 'server.schedule_created', 'success', req.user.id, { serverId: id, scheduleId: row.id, action: v.action, days: v.days, time: v.time, timezone: v.timezone });
    return row;
  }

  @Put(':sid') @Can('server.power', 'server.snapshots', 'server.backups')
  async update(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string, @Body() body: Record<string, unknown>) {
    await findServer(req, id, true);
    const v = valid(body);
    await customerMay(req, v.action === 'snapshot' ? 'snapshots' : v.action === 'backup' ? 'backups' : 'power');
    const { rows: [row] } = await pool.query(`UPDATE power_schedules SET action = $3, days = $4, at_time = $5, timezone = $6, enabled = $7, keep = $8, pending_since = NULL WHERE id = $2 AND server_id = $1 RETURNING ${columns}`,
      [id, sid, v.action, v.days, v.time, v.timezone, v.enabled, v.keep ?? null]);
    if (!row) throw apiError(404, 'NOT_FOUND', 'Unknown schedule');
    await audit(req, 'server.schedule_updated', 'success', req.user.id, { serverId: id, scheduleId: sid, enabled: v.enabled });
    return row;
  }

  @Delete(':sid') @HttpCode(204) @Can('server.power', 'server.snapshots', 'server.backups')
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
// has not run in the last 10 minutes (a late or repeated tick runs it once). A snapshot run that had to make room
// first stays pending (for up to an hour) and is picked up again on the next ticks until it takes the snapshot. shortcut: a tick missed for more
// than 5 minutes (API down) skips that run; a catch-up rule would be needed for longer outages.
export async function runSchedules() {
  const { rows } = await pool.query(`SELECT p.id, p.action, p.keep, p.timezone, s.id AS server_id, s.owner_id, s.state, s.power_state, s.vm_moref, s.pool_id, s.billing_hold, u.role AS owner_role,
      EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.status IN ('pending', 'running')) AS busy
    FROM power_schedules p JOIN servers s ON s.id = p.server_id JOIN users u ON u.id = s.owner_id
    WHERE p.enabled AND s.state <> 'deleted' AND (p.pending_since > now() - interval '1 hour' OR ((p.last_run_at IS NULL OR p.last_run_at < now() - interval '10 minutes')
      AND EXTRACT(ISODOW FROM now() AT TIME ZONE p.timezone)::smallint = ANY (p.days)
      AND ((now() AT TIME ZONE p.timezone)::time - p.at_time) BETWEEN interval '0' AND interval '5 minutes'))`);
  const customer = (await getSettings('servers')).customer;
  const allowed = customer.power;
  for (const r of rows) {
    // Held for an unpaid invoice: no schedule starts it (or anything else on it) until it is paid.
    if (r.billing_hold) {
      await pool.query("UPDATE power_schedules SET last_run_at = now(), last_result = 'skipped_state', pending_since = NULL WHERE id = $1", [r.id]);
      continue;
    }
    if (r.action === 'snapshot' || r.action === 'backup') {
      const { outcome, pending } = await (r.action === 'backup' ? runBackup(r, customer.backups) : runSnapshot(r, customer.snapshots)).catch((e) => {
        logEvent('error', 'schedule_snapshot_failed', { schedule: r.id, code: (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String((e as Error)?.message ?? e).slice(0, 200) });
        return { outcome: 'failed', pending: false };
      });
      await pool.query(`UPDATE power_schedules SET last_run_at = now(), last_result = $2, pending_since = CASE WHEN $3 THEN coalesce(pending_since, now()) END WHERE id = $1`, [r.id, outcome, pending]);
      continue;
    }
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

// One step of an automatic snapshot: make room (remove the oldest automatic snapshot) or take the new one. Manual
// snapshots are never touched; when they alone fill the limit the run is skipped.
async function runSnapshot(r: Record<string, string | number | boolean | null>, allowed: boolean) {
  if (!allowed) return { outcome: 'skipped_disabled', pending: false };
  if (r.busy) return { outcome: 'skipped_busy', pending: true };
  if (r.state !== 'ready' || !r.vm_moref) return { outcome: 'skipped_state', pending: false };
  const { rows: [c] } = await pool.query('SELECT c.* FROM vmware_connections c JOIN resource_pools p ON p.connection_id = c.id WHERE p.id = $1', [r.pool_id]);
  const { snapshots } = await callAdapter<{ snapshots: { id: string; name: string; created: string }[] }>('/v1/vm/snapshots', { ...storedTarget(c), vm: r.vm_moref }, 30_000);
  const max = limitsOf(String(r.owner_role ?? 'user')).maxSnapshots ?? MAX_SNAPSHOTS;
  const keep = Math.min(Number(r.keep ?? 3), max);
  const autos = snapshots.filter((s) => s.name.startsWith('auto ')).sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const pseudo = { id: `schedule:${r.id}`, ip: null, user: { id: null } } as unknown as AuthedRequest;
  const server = { id: String(r.server_id), owner_id: String(r.owner_id) };
  // A fresh key per step: the tick lock and last_run_at/pending_since already keep a run from repeating.
  const step = randomUUID();
  if (autos.length >= keep || snapshots.length >= max) {
    if (!autos.length) return { outcome: 'skipped_limit', pending: false };
    const params = { snapshot: autos[0].id };
    await startOperation(pseudo, server, 'snapshot_delete', `schedule:${r.id}:delete:${step}`, hashOf({ id: server.id, kind: 'snapshot_delete', ...params }), params);
    return { outcome: 'rotating', pending: true };
  }
  // The local date and time of the schedule's zone, e.g. "auto 2026-10-27 02:00".
  const name = `auto ${new Intl.DateTimeFormat('sv-SE', { timeZone: String(r.timezone), dateStyle: 'short', timeStyle: 'short' }).format(new Date())}`;
  const params = { name, description: 'Automatic snapshot (schedule)' };
  await startOperation(pseudo, server, 'snapshot_create', `schedule:${r.id}:create:${step}`, hashOf({ id: server.id, kind: 'snapshot_create', ...params }), params);
  return { outcome: 'started', pending: false };
}

// One step of a scheduled backup: remove the oldest scheduled one when `keep` are there, else take a new one.
// Backups taken by hand are never removed by a schedule.
async function runBackup(r: Record<string, string | number | boolean | null>, allowed: boolean) {
  if (!allowed) return { outcome: 'skipped_disabled', pending: false };
  if (r.busy) return { outcome: 'skipped_busy', pending: true };
  if (r.state !== 'ready' || !r.vm_moref) return { outcome: 'skipped_state', pending: false };
  const pseudo = { id: `schedule:${r.id}`, ip: null, user: { id: null } } as unknown as AuthedRequest;
  const server = { id: String(r.server_id), owner_id: String(r.owner_id), pool_id: String(r.pool_id) };
  const { rows: autos } = await pool.query("SELECT id FROM backups WHERE server_id = $1 AND kind = 'scheduled' AND status = 'ready' ORDER BY created_at", [server.id]);
  const step = randomUUID();
  if (autos.length >= Number(r.keep ?? 3)) {
    const params = { backupId: autos[0].id };
    await startOperation(pseudo, server, 'backup_delete', `schedule:${r.id}:backup-delete:${step}`, hashOf({ id: server.id, kind: 'backup_delete', ...params }), params);
    return { outcome: 'rotating', pending: true };
  }
  await startBackup(pseudo, server, 'scheduled', '', `schedule:${r.id}:backup:${step}`);
  return { outcome: 'started', pending: false };
}

export function startScheduler() {
  const tick = async () => {
    if (!(await redis.set('lock:schedules', '1', 'EX', 50, 'NX').catch(() => null))) return;
    await runSchedules().catch(() => logEvent('error', 'schedules_failed'));
    await runDueDeletions().catch(() => logEvent('error', 'due_deletions_failed'));
  };
  return setInterval(tick, 60_000).unref();
}
