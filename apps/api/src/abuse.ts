// Abuse monitoring (apps/worker/abuse.mjs finds them): open risky ports and mining suspicions, their
// acknowledgement by staff, and the settings (ports, intervals, CPU threshold, customer notification).
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { pool, redis } from './db';
import { apiError } from './errors';
import { audit, type AuthedRequest } from './auth';
import { Can, PermissionGuard } from './rbac';
import { getSettings, saveSettings } from './settings-store';

type Input = Record<string, unknown>;
const scans = new Queue('abuse', { connection: redis });
const power = new Queue('power', { connection: redis });

@Controller('admin') @UseGuards(PermissionGuard)
export class AbuseController {
  @Get('abuse') @Can('servers.view_all')
  async findings() {
    const { rows } = await pool.query(`SELECT f.id, f.kind, host(f.address) AS address, f.port, f.detail, f.first_seen AS "firstSeen", f.last_seen AS "lastSeen",
        f.resolved_at AS "resolvedAt", f.acknowledged_at AS "acknowledgedAt", a.email AS "acknowledgedBy", f.note,
        s.id AS "serverId", s.name AS "serverName", s.state, u.email AS owner, p.location
      FROM abuse_findings f JOIN servers s ON s.id = f.server_id JOIN users u ON u.id = s.owner_id JOIN resource_pools p ON p.id = s.pool_id
      LEFT JOIN users a ON a.id = f.acknowledged_by
      WHERE f.resolved_at IS NULL OR f.resolved_at > now() - interval '7 days' ORDER BY f.resolved_at IS NULL DESC, f.last_seen DESC LIMIT 500`);
    return { findings: rows, settings: await getSettings('abuse') };
  }

  // Port scan now (and a CPU check with the next energy sample).
  @Post('abuse/scan') @HttpCode(202) @Can('servers.view_all')
  async scan(@Req() req: AuthedRequest) {
    await scans.add('scan', {}, { removeOnComplete: true, removeOnFail: true });
    await power.add('sample', {}, { removeOnComplete: true, removeOnFail: true });
    await audit(req, 'abuse.scan', 'success', req.user.id);
    return { queued: true };
  }

  @Put('abuse/:id/acknowledge') @Can('servers.manage_all')
  async acknowledge(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: Input) {
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const { rowCount } = await pool.query('UPDATE abuse_findings SET acknowledged_at = now(), acknowledged_by = $2, note = $3 WHERE id = $1', [id, req.user.id, note]);
    if (!rowCount) throw apiError(404, 'NOT_FOUND', 'Unknown finding');
    await audit(req, 'abuse.acknowledged', 'success', req.user.id, { id });
    return { id };
  }

  @Get('settings/abuse') @Can('settings.view', 'settings.manage')
  settings() { return getSettings('abuse'); }

  @Put('settings/abuse') @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() b: Input) {
    const fields: Record<string, string> = {};
    const int = (k: string, min: number, max: number) => { const v = Number(b?.[k]); if (!Number.isInteger(v) || v < min || v > max) fields[k] = 'OUT_OF_RANGE'; return v; };
    const ports = Array.isArray(b?.ports) ? b.ports : [];
    const list = ports.map((p) => ({ port: Number((p as Input)?.port), label: String((p as Input)?.label ?? '').trim().slice(0, 40) }));
    if (list.length > 100 || list.some((p) => !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) || new Set(list.map((p) => p.port)).size !== list.length) fields.ports = 'INVALID_PORT_LIST';
    const value = { portScan: b?.portScan === true, scanMinutes: int('scanMinutes', 5, 1440), cpu: b?.cpu === true, cpuThreshold: int('cpuThreshold', 50, 100),
      cpuHours: int('cpuHours', 1, 72), notifyCustomer: b?.notifyCustomer === true, ports: list.sort((x, y) => x.port - y.port) };
    if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
    await saveSettings('abuse', value);
    await audit(req, 'settings.abuse', 'success', req.user.id, { ...value, ports: value.ports.length });
    return value;
  }
}
