// Usage anomalies, as the panel shows them. The worker judges (apps/worker/anomalies.mjs: a server's CPU or network use
// against its own baseline, hourly) and keeps what it found in usage_anomalies; here the owner reads the findings of
// one server (with the numbers behind each, and whether there is enough history to judge at all), the insights get
// their cards, and staff get the list across all servers with a note when a finding resembles what the abuse module
// watches for. Nothing here acts on a server.
import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { noCpuKinds } from './capacity';
import { pool } from './db';
import { Can, PermissionGuard } from './rbac';
import { findServer } from './servers';

// As the rules need it (apps/worker/anomaly-rules.mjs, cpuRule.minDays: four earlier days and the day judged).
export const ANOMALY_MIN_DAYS = 5;
// How long a closed finding stays in the staff list.
export const ANOMALY_RECENT_DAYS = 7;

export type AnomalyDetail = { recent?: number; value?: number; usual?: number; scale?: number; z?: number; baseline?: number; days?: number; day?: string; outShare?: number | null; hint?: 'cpu_pinned' | 'outbound' | null };
export type Anomaly = { id: string; metric: 'cpu' | 'network'; direction: 'high' | 'low'; openedAt: string; lastSeen: string; detail: AnomalyDetail };
const columns = 'a.id, a.metric, a.direction, a.opened_at AS "openedAt", a.last_seen AS "lastSeen", a.detail';
// The insight key of a finding: a new finding on the same server is a new key, so one that was hidden does not hide the next.
export const anomalyKey = (id: string) => `anomaly:${id}`;

// The customer's open findings, for the insights list.
export async function openAnomaliesOf(userId: string): Promise<(Anomaly & { serverId: string; name: string })[]> {
  const { rows } = await pool.query(`SELECT ${columns}, s.id AS "serverId", s.name FROM usage_anomalies a JOIN servers s ON s.id = a.server_id
    WHERE s.owner_id = $1 AND a.resolved_at IS NULL AND s.state = 'ready' ORDER BY a.opened_at DESC LIMIT 50`, [userId]);
  return rows;
}

// For staff: how many are open, and how many of them resemble abuse.
export async function anomalyCounts(): Promise<{ open: number; suspicious: number }> {
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS open, count(*) FILTER (WHERE detail->>'hint' IS NOT NULL)::int AS suspicious FROM usage_anomalies WHERE resolved_at IS NULL`);
  return r;
}

@Controller('servers/:id/anomalies') @UseGuards(SessionGuard)
export class AnomaliesController {
  // measured: whether this platform reports CPU figures at all; days: distinct days of CPU history in the last 14;
  // enough: whether that is enough to judge. Findings the viewer hid (insight dismissals) are counted, not listed.
  @Get()
  async list(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const [{ rows: [k] }, { rows: [h] }, { rows }] = await Promise.all([
      pool.query('SELECT c.kind FROM resource_pools p JOIN vmware_connections c ON c.id = p.connection_id WHERE p.id = $1', [s.pool_id]),
      pool.query(`SELECT count(DISTINCT date_trunc('day', hour, 'UTC'))::int AS days FROM server_cpu_hourly WHERE server_id = $1 AND hour > now() - interval '14 days'`, [id]),
      pool.query(`SELECT ${columns}, EXISTS (SELECT 1 FROM insight_dismissals d WHERE d.user_id = $2 AND d.key = 'anomaly:' || a.id AND (d.until IS NULL OR d.until > now())) AS hidden
        FROM usage_anomalies a WHERE a.server_id = $1 AND a.resolved_at IS NULL ORDER BY a.opened_at`, [id, req.user.id]),
    ]);
    const measured = !!k && !noCpuKinds.includes(k.kind);
    return { measured, days: h.days, minDays: ANOMALY_MIN_DAYS, enough: measured && h.days >= ANOMALY_MIN_DAYS,
      anomalies: rows.filter((a) => !a.hidden).map(({ hidden: _hidden, ...a }) => a), hidden: rows.filter((a) => a.hidden).length };
  }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class AnomaliesAdminController {
  // Open findings and those closed in the last week, with the owner and, per server, how many findings of the abuse
  // module are open on it (the two lists are kept apart: this one is statistics, that one is evidence).
  @Get('anomalies') @Can('servers.view_all')
  async all() {
    const { rows } = await pool.query(`SELECT ${columns}, a.resolved_at AS "resolvedAt", s.id AS "serverId", s.name AS "serverName", u.email AS owner, p.location,
        (SELECT count(*)::int FROM abuse_findings f WHERE f.server_id = s.id AND f.resolved_at IS NULL) AS "abuseOpen"
      FROM usage_anomalies a JOIN servers s ON s.id = a.server_id JOIN users u ON u.id = s.owner_id JOIN resource_pools p ON p.id = s.pool_id
      WHERE a.resolved_at IS NULL OR a.resolved_at > now() - make_interval(days => $1) ORDER BY a.resolved_at IS NULL DESC, a.last_seen DESC LIMIT 500`, [ANOMALY_RECENT_DAYS]);
    return { anomalies: rows };
  }
}
