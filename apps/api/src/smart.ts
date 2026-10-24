// Smart features: a server's health score with its reasons and right-sizing advice, the customer's cost
// forecast for this month, and the admin's getting-started checklist. The rules are in smart-rules.ts.
import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { usageOf } from './catalog';
import { pool } from './db';
import { summary as maintenance } from './maintenance';
import { Can, PermissionGuard } from './rbac';
import { findServer } from './servers';
import { mailReady } from './settings-store';
import { health, monthCost, sizing, type CpuStats } from './smart-rules';

// CPU of the servers given over the last 7 days (server_cpu_samples, written with each energy sample).
export async function cpuStats(ids: string[]): Promise<Map<string, CpuStats>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT server_id AS id, avg(cpu_pct)::float8 AS avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_pct)::float8 AS p95,
      count(*)::int AS samples, (EXTRACT(EPOCH FROM max(at) - min(at)) / 86400)::float8 AS days
    FROM server_cpu_samples WHERE server_id = ANY($1::uuid[]) AND at > now() - interval '7 days' GROUP BY server_id`, [ids]);
  return new Map(rows.map((r) => [r.id, { avg: r.avg, p95: r.p95, samples: r.samples, days: r.days }]));
}

@Controller() @UseGuards(SessionGuard)
export class SmartController {
  @Get('servers/:id/health')
  async serverHealth(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const s = await findServer(req, id);
    const [stats, { rows: [x] }] = await Promise.all([cpuStats([id]), pool.query(`SELECT
      (SELECT count(*)::int FROM abuse_findings WHERE server_id = $1 AND resolved_at IS NULL) AS abuse,
      (SELECT count(*)::int FROM operations WHERE server_id = $1 AND status = 'failed' AND created_at > now() - interval '24 hours') AS failed`, [id])]);
    const cpu = stats.get(id) ?? null;
    const size = sizing(s.vcpu, cpu);
    return { ...health({ state: s.state, powerState: s.power_state, abuseOpen: x.abuse, failedOps24h: x.failed, cpuP95: cpu && cpu.samples >= 24 ? cpu.p95 : null, advice: size.advice }),
      cpu: cpu && { avg: Math.round(cpu.avg * 10) / 10, p95: Math.round(cpu.p95 * 10) / 10, samples: cpu.samples, days: Math.round(cpu.days * 10) / 10 }, vcpu: s.vcpu, ...size };
  }

  // Spending of this month per currency (servers and virtual data centers), with the resources in use.
  @Get('usage/summary')
  async usage(@Req() req: AuthedRequest) {
    const { rows } = await pool.query(`SELECT price_monthly::float8 AS price, currency, created_at FROM servers WHERE owner_id = $1 AND state <> 'deleted' AND price_monthly > 0
      UNION ALL SELECT price_monthly::float8, currency, created_at FROM vdcs WHERE owner_id = $1 AND active AND price_monthly > 0`, [req.user.id]);
    const now = new Date();
    const currencies = [...new Set(rows.map((r) => r.currency.trim()))].sort();
    return {
      costs: currencies.map((c) => ({ currency: c, ...monthCost(rows.filter((r) => r.currency.trim() === c).map((r) => ({ price: r.price, createdAt: new Date(r.created_at) })), now) })),
      usage: await usageOf(req.user.id),
    };
  }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class OnboardingController {
  // What a new installation still needs before customers can order, in the order it is usually done.
  @Get('onboarding') @Can('dashboard.view')
  async steps(@Req() req: AuthedRequest) {
    const { rows: [n] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM vmware_connections) AS connection, (SELECT count(*)::int FROM locations) AS location,
      (SELECT count(*)::int FROM resource_pools WHERE active) AS pool, (SELECT count(*)::int FROM os_images WHERE active) AS image,
      (SELECT count(*)::int FROM packages WHERE active) + (SELECT count(*)::int FROM custom_rules WHERE active) AS package,
      (SELECT count(*)::int FROM ip_pools) AS ip, (SELECT two_factor_enabled FROM users WHERE id = $1) AS twofa`, [req.user.id]);
    const done: [string, boolean, string][] = [
      ['connection', n.connection > 0, '/admin/vmware'],
      ['location', n.location > 0, '/admin/catalog?tab=locations'],
      ['pool', n.pool > 0, '/admin/catalog?tab=pools'],
      ['image', n.image > 0, '/admin/catalog?tab=images'],
      ['package', n.package > 0, '/admin/catalog?tab=packages'],
      ['ip', n.ip > 0, '/admin/catalog?tab=ip'],
      ['mail', await mailReady(), '/admin/settings?tab=mail'],
      ['backup', !!maintenance().lastSuccessfulBackup, '/admin/system'],
      ['twoFactor', !!n.twofa, '/account?tab=security'],
    ];
    return { steps: done.map(([key, ok, link]) => ({ key, done: ok, link })) };
  }
}
