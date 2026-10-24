// Insights: findings the panel computes from its own data, each with a severity, the numbers behind it
// and where to fix it. Staff see platform findings; customers see findings about their own servers.
// Critical staff findings are also sent as the "admin.insight" notification, at most once a day each.
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { capacityOf, limitsFor, usageOf } from './catalog';
import { pool, redis } from './db';
import { logEvent } from './log';
import { summary as maintenance } from './maintenance';
import { notify } from './notify';
import { can } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { activeCaptcha, mailReady } from './settings-store';
import { cpuStats } from './smart';
import { sizing } from './smart-rules';

export type Insight = { code: string; severity: 'danger' | 'warning' | 'info'; params: Record<string, string | number>; link: string; key: string };
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export async function staffInsights(): Promise<Insight[]> {
  const out: Insight[] = [];
  const add = (code: string, severity: Insight['severity'], params: Insight['params'], link: string, key = code) => out.push({ code, severity, params, link, key });

  const { rows: pools } = await pool.query('SELECT * FROM resource_pools WHERE active');
  for (const p of pools) {
    const cap = await capacityOf(p);
    for (const [res, unit] of [['vcpu', ''], ['memoryMb', 'MB'], ['storageGb', 'GB']] as const) {
      const offered = cap.offered[res] ?? 0;
      const used = pct(offered - (cap.available[res] ?? 0), offered);
      if (offered > 0 && used >= 90) add('POOL_NEARLY_FULL', 'danger', { pool: p.name, resource: res, used, unit }, '/admin/catalog?tab=pools', `pool:${p.id}:${res}`);
      else if (offered > 0 && used >= 75) add('POOL_FILLING', 'warning', { pool: p.name, resource: res, used, unit }, '/admin/catalog?tab=pools', `pool:${p.id}:${res}`);
    }
    // Linear forecast from the last 30 days of vCPU reservations in this pool.
    const { rows: [g] } = await pool.query(`SELECT COALESCE(sum(vcpu), 0)::int AS vcpu FROM servers WHERE pool_id = $1 AND created_at > now() - interval '30 days' AND state <> 'deleted'`, [p.id]);
    const perDay = g.vcpu / 30;
    const free = cap.available.vcpu ?? 0;
    if (perDay > 0 && free > 0 && free / perDay < 30) add('POOL_FORECAST', 'warning', { pool: p.name, days: Math.max(1, Math.round(free / perDay)) }, '/admin/catalog?tab=pools', `forecast:${p.id}`);
  }

  const { rows: ips } = await pool.query(`SELECT i.id, i.name, (i.range_end - i.range_start + 1 - (SELECT count(*) FROM unnest(i.excluded) x WHERE x BETWEEN i.range_start AND i.range_end)
      - (CASE WHEN i.gateway BETWEEN i.range_start AND i.range_end THEN 1 ELSE 0 END))::int AS size,
    (SELECT count(*)::int FROM ip_allocations a WHERE a.ip_pool_id = i.id AND family(a.address) = 4)
      + (SELECT count(*)::int FROM ip_quarantine q WHERE q.ip_pool_id = i.id AND q.available_at > now() AND family(q.address) = 4) AS used FROM ip_pools i`);
  for (const i of ips) {
    const free = i.size - i.used;
    if (free <= 0) add('IP_POOL_EMPTY', 'danger', { pool: i.name }, '/admin/catalog?tab=ip', `ip:${i.id}`);
    else if (free < 5 || pct(free, i.size) < 10) add('IP_POOL_LOW', 'warning', { pool: i.name, free }, '/admin/catalog?tab=ip', `ip:${i.id}`);
  }

  const { rows: conns } = await pool.query("SELECT id, name, last_error_code FROM vmware_connections WHERE status <> 'ok'");
  for (const c of conns) add('CONNECTION_DOWN', 'danger', { connection: c.name, code: c.last_error_code ?? '' }, `/admin/vmware/${c.id}`, `conn:${c.id}`);

  const { rows: [ops] } = await pool.query(`SELECT count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
    count(*) FILTER (WHERE status IN ('pending', 'running') AND deadline_at < now())::int AS stuck FROM operations`);
  if (ops.stuck) add('OPERATIONS_STUCK', 'danger', { count: ops.stuck }, '/admin/servers?tab=operations');
  if (ops.failed) add('OPERATIONS_FAILED', 'warning', { count: ops.failed }, '/admin/servers?tab=operations');

  const { rows: [rec] } = await pool.query('SELECT count(*)::int AS n FROM reconciliation_findings WHERE resolved_at IS NULL');
  if (rec.n) add('RECONCILE_FINDINGS', 'warning', { count: rec.n }, '/admin/servers?tab=reconcile');

  const { rows: [w] } = await pool.query("SELECT count(*) FILTER (WHERE last_seen > now() - interval '90 seconds')::int AS healthy FROM worker_heartbeats");
  if (!w.healthy) add('WORKER_DOWN', 'danger', {}, '/admin/system');

  const m = maintenance();
  if (m.lastBackup?.status === 'failed') add('BACKUP_FAILED', 'danger', { code: m.lastBackup.code ?? '' }, '/admin/system');
  else if (!m.lastSuccessfulBackup) add('BACKUP_NEVER', 'warning', {}, '/admin/system');
  else if (Date.now() - Date.parse(m.lastSuccessfulBackup.time) > 26 * 3600_000) add('BACKUP_STALE', 'warning', { hours: Math.round((Date.now() - Date.parse(m.lastSuccessfulBackup.time)) / 3600_000) }, '/admin/system');

  // Packages no active location can currently host.
  const { rows: pkgs } = await pool.query(`SELECT p.id, p.name, p.vcpu, p.memory_mb, p.disk_gb, ARRAY(SELECT pool_id FROM package_pools WHERE package_id = p.id) AS pools FROM packages p WHERE p.active`);
  const caps = new Map(await Promise.all(pools.map(async (p) => [p.id, await capacityOf(p)] as const)));
  for (const k of pkgs) {
    const fits = k.pools.some((id: string) => { const c = caps.get(id); return c && k.vcpu <= c.available.vcpu && k.memory_mb <= c.available.memoryMb && k.disk_gb <= c.available.storageGb; });
    if (!fits) add('PACKAGE_UNSELLABLE', 'warning', { package: k.name }, '/admin/catalog?tab=packages', `pkg:${k.id}`);
  }

  const { rows: [a] } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(string_to_array(coalesce(role, ''), ',')) AND NOT two_factor_enabled AND NOT coalesce(banned, false)`);
  if (a.n) add('ADMINS_WITHOUT_2FA', 'warning', { count: a.n }, '/admin/users');
  const { rows: [reg] } = await pool.query("SELECT value FROM settings WHERE key = 'registration_open'");
  const captcha = await activeCaptcha();
  if (reg?.value === true && !(captcha && captcha.use.signUp)) add('REGISTRATION_WITHOUT_CAPTCHA', 'info', {}, '/admin/settings?tab=captcha');
  if (!(await mailReady())) add('MAIL_NOT_CONFIGURED', 'info', {}, '/admin/settings?tab=mail');

  // Servers that use far less CPU than they reserve hold pool capacity other customers could buy.
  const { rows: on } = await pool.query("SELECT id, vcpu FROM servers WHERE state = 'ready' AND power_state = 'poweredOn' AND vdc_id IS NULL");
  const st = await cpuStats(on.map((s) => s.id));
  const spare = on.map((s) => ({ s, r: sizing(s.vcpu, st.get(s.id) ?? null) })).filter((x) => x.r.advice === 'idle' || x.r.advice === 'down');
  if (spare.length) add('OVERSIZED_SERVERS', 'info', { count: spare.length, vcpu: spare.reduce((a, x) => a + x.s.vcpu - x.r.suggestedVcpu, 0) }, '/admin/servers');
  const order = { danger: 0, warning: 1, info: 2 };
  return out.sort((x, y) => order[x.severity] - order[y.severity]);
}

export async function customerInsights(userId: string): Promise<Insight[]> {
  const out: Insight[] = [];
  const add = (code: string, severity: Insight['severity'], params: Insight['params'], link: string, key: string) => out.push({ code, severity, params, link, key });
  const { rows: bad } = await pool.query("SELECT id, name FROM servers WHERE owner_id = $1 AND state IN ('error', 'missing')", [userId]);
  for (const s of bad) add('SERVER_PROBLEM', 'danger', { name: s.name }, `/servers/${s.id}`, `srv:${s.id}`);
  const { rows: off } = await pool.query(`SELECT id, name FROM servers WHERE owner_id = $1 AND state = 'ready' AND power_state = 'poweredOff' AND updated_at < now() - interval '7 days'`, [userId]);
  for (const s of off) add('SERVER_OFF_LONG', 'info', { name: s.name }, `/servers/${s.id}`, `off:${s.id}`);
  // Right-sizing from the last 7 days of CPU use (VDC servers are sized inside their allocation, so skipped).
  const { rows: running } = await pool.query("SELECT id, name, vcpu FROM servers WHERE owner_id = $1 AND state = 'ready' AND power_state = 'poweredOn' AND vdc_id IS NULL", [userId]);
  const stats = await cpuStats(running.map((s) => s.id));
  for (const s of running) {
    const r = sizing(s.vcpu, stats.get(s.id) ?? null);
    const avg = Math.round(stats.get(s.id)?.avg ?? 0);
    if (r.advice === 'idle') add('IDLE_SERVER', 'info', { name: s.name, avg }, `/servers/${s.id}`, `idle:${s.id}`);
    if (r.advice === 'down') add('RIGHT_SIZE_DOWN', 'info', { name: s.name, avg, vcpu: s.vcpu, suggested: r.suggestedVcpu }, `/servers/${s.id}`, `size:${s.id}`);
    if (r.advice === 'up') add('RIGHT_SIZE_UP', 'warning', { name: s.name, avg, vcpu: s.vcpu, suggested: r.suggestedVcpu }, `/servers/${s.id}`, `size:${s.id}`);
  }
  const [limits, usage] = await Promise.all([limitsFor(userId), usageOf(userId)]);
  for (const [k, l] of [['servers', 'max_servers'], ['vcpu', 'max_vcpu'], ['memoryMb', 'max_memory_mb'], ['diskGb', 'max_disk_gb']] as const) {
    const max = (limits as unknown as Record<string, number | null>)?.[l];
    const used = (usage as Record<string, number>)[k];
    if (max && pct(used, max) >= 80) add('QUOTA_NEAR', pct(used, max) >= 100 ? 'danger' : 'warning', { resource: k, used, max }, '/order', `quota:${k}`);
  }
  const { rows: [keys] } = await pool.query('SELECT count(*)::int AS n FROM ssh_keys WHERE owner_id = $1', [userId]);
  if (!keys.n) add('NO_SSH_KEYS', 'info', {}, '/account?tab=keys', 'keys');
  const { rows: [u] } = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [userId]);
  if (!u?.two_factor_enabled) add('ENABLE_2FA', 'info', {}, '/account?tab=security', '2fa');
  return out;
}

// Texts for the notification channels (the panel translates insight codes itself).
const texts: Record<string, { tr: (p: Insight['params']) => [string, string]; en: (p: Insight['params']) => [string, string] }> = {
  POOL_NEARLY_FULL: { tr: (p) => [`${p.pool} dolmak üzere`, `${p.resource} kullanımı %${p.used}.`], en: (p) => [`${p.pool} is nearly full`, `${p.resource} usage is ${p.used}%.`] },
  IP_POOL_EMPTY: { tr: (p) => [`${p.pool}: boş IP kalmadı`, 'Yeni sunucu oluşturulamaz.'], en: (p) => [`${p.pool}: no free IP address`, 'New servers cannot be created.'] },
  CONNECTION_DOWN: { tr: (p) => [`${p.connection} erişilemiyor`, `Hata: ${p.code}`], en: (p) => [`${p.connection} is unreachable`, `Error: ${p.code}`] },
  OPERATIONS_STUCK: { tr: (p) => ['Takılmış işlemler', `${p.count} işlem süresini aştı.`], en: (p) => ['Stuck operations', `${p.count} operations passed their deadline.`] },
  WORKER_DOWN: { tr: () => ['Arka plan çalışanı yanıt vermiyor', 'Sunucu işlemleri ilerlemiyor.'], en: () => ['Background worker not responding', 'Server operations are not progressing.'] },
  BACKUP_FAILED: { tr: (p) => ['Son yedek başarısız', `Kod: ${p.code}`], en: (p) => ['The last backup failed', `Code: ${p.code}`] },
};

// Every 10 minutes: new critical findings go out once per finding per day.
export function startInsightAlerts() {
  const run = async () => {
    if (!(await redis.set('lock:insights', '1', 'EX', 540, 'NX').catch(() => null))) return;
    try {
      for (const i of (await staffInsights()).filter((x) => x.severity === 'danger' && texts[x.code])) {
        if (!(await redis.set(`insight:sent:${i.key}`, '1', 'EX', 86_400, 'NX'))) continue;
        const [titleTr, bodyTr] = texts[i.code].tr(i.params);
        const [titleEn, bodyEn] = texts[i.code].en(i.params);
        await notify('admin.insight', 'staff:dashboard.view', { titleTr, bodyTr, titleEn, bodyEn, code: i.code });
      }
    } catch { logEvent('error', 'insights_failed'); }
  };
  setTimeout(run, 30_000).unref();
  return setInterval(run, 10 * 60_000).unref();
}

@Controller()
export class InsightsController {
  @Get('insights') @UseGuards(SessionGuard)
  mine(@Req() req: AuthedRequest) { return customerInsights(req.user.id).then((insights) => ({ insights })); }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class StaffInsightsController {
  @Get('insights') @Can('dashboard.view')
  async all(@Req() req: AuthedRequest) {
    const insights = await staffInsights();
    // Links into areas the viewer cannot open are dropped.
    return { insights: insights.filter((i) => !i.link.startsWith('/admin/settings') || can(req.user.permissions, 'settings.view') || can(req.user.permissions, 'settings.manage')) };
  }
}
