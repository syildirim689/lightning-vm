// Insights: findings the panel computes from its own data, each with a severity, the numbers behind it
// and where to fix it. Staff see platform findings; customers see findings about their own servers.
// Critical staff findings are also sent as the "admin.insight" notification, at most once a day each.
import { Body, Controller, Delete, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from './auth';
import { capacityOf, limitsFor, usageOf } from './catalog';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { summary as maintenance } from './maintenance';
import { notify } from './notify';
import { can } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { activeCaptcha, mailReady } from './settings-store';
import { cpuStats } from './smart';
import { sizing } from './smart-rules';

// action: a one-click fix the card offers next to its link (customer findings about one server).
export type Insight = { code: string; severity: 'danger' | 'warning' | 'info'; params: Record<string, string | number>; link: string; key: string; action?: { kind: 'power_on' | 'restore'; serverId: string } };
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
    // Linear forecast per resource: what the last 30 days added (new servers less removed ones) against what is free.
    const { rows: [g] } = await pool.query(`SELECT
        coalesce(sum(vcpu) FILTER (WHERE created_at > now() - interval '30 days'), 0) - coalesce(sum(vcpu) FILTER (WHERE deleted_at > now() - interval '30 days'), 0) AS vcpu,
        coalesce(sum(memory_mb) FILTER (WHERE created_at > now() - interval '30 days'), 0) - coalesce(sum(memory_mb) FILTER (WHERE deleted_at > now() - interval '30 days'), 0) AS "memoryMb",
        coalesce(sum(disk_gb) FILTER (WHERE created_at > now() - interval '30 days'), 0) - coalesce(sum(disk_gb) FILTER (WHERE deleted_at > now() - interval '30 days'), 0) AS "storageGb"
      FROM servers WHERE pool_id = $1 AND vdc_id IS NULL`, [p.id]);
    const soonest = (['vcpu', 'memoryMb', 'storageGb'] as const).map((res) => ({ res, perDay: Number(g[res]) / 30, free: cap.available[res] ?? 0 }))
      .filter((x) => x.perDay > 0 && x.free > 0).map((x) => ({ res: x.res, days: x.free / x.perDay })).sort((a, b) => a.days - b.days)[0];
    if (soonest && soonest.days < 30) add('POOL_FORECAST', soonest.days < 7 ? 'danger' : 'warning', { pool: p.name, days: Math.max(1, Math.round(soonest.days)), resource: soonest.res }, '/admin/catalog?tab=pools', `forecast:${p.id}`);
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
  // Staff accounts nobody has used for 90 days: open doors with permissions (worth disabling or removing).
  const { rows: [idle] } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE coalesce(role, 'user') <> 'user' AND NOT coalesce(banned, false) AND disabled_at IS NULL
    AND created_at < now() - interval '90 days' AND coalesce(last_seen_at, (SELECT max(s.created_at) FROM auth_sessions s WHERE s.user_id = users.id), created_at) < now() - interval '90 days'`);
  if (idle.n) add('STAFF_INACTIVE', 'warning', { count: idle.n }, '/admin/users');
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
  const add = (code: string, severity: Insight['severity'], params: Insight['params'], link: string, key: string, action?: Insight['action']) => out.push({ code, severity, params, link, key, ...(action && { action }) });
  const { rows: bad } = await pool.query("SELECT id, name FROM servers WHERE owner_id = $1 AND state IN ('error', 'missing')", [userId]);
  for (const s of bad) add('SERVER_PROBLEM', 'danger', { name: s.name }, `/servers/${s.id}`, `srv:${s.id}`);
  const { rows: trash } = await pool.query('SELECT id, name, delete_at FROM servers WHERE owner_id = $1 AND delete_at IS NOT NULL', [userId]);
  for (const s of trash) add('PENDING_DELETION', 'warning', { name: s.name, hours: Math.max(1, Math.ceil((new Date(s.delete_at).getTime() - Date.now()) / 3600_000)) }, `/servers/${s.id}`, `trash:${s.id}`, { kind: 'restore', serverId: s.id });
  const { rows: off } = await pool.query(`SELECT id, name FROM servers WHERE owner_id = $1 AND state = 'ready' AND power_state = 'poweredOff' AND delete_at IS NULL AND updated_at < now() - interval '7 days'`, [userId]);
  for (const s of off) add('SERVER_OFF_LONG', 'info', { name: s.name }, `/servers/${s.id}`, `off:${s.id}`, { kind: 'power_on', serverId: s.id });
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
  // Turned off for over a week but still billed: delete it if it is not needed (a snapshot keeps nothing after delete).
  const { rows: idleOff } = await pool.query(`SELECT s.id, s.name, s.price_monthly::text AS price, trim(s.currency) AS currency,
      (SELECT max(o.finished_at) FROM operations o WHERE o.server_id = s.id AND o.kind IN ('shutdown', 'power_off') AND o.status = 'succeeded') AS off_at
    FROM servers s WHERE s.owner_id = $1 AND s.state = 'ready' AND s.power_state = 'poweredOff' AND s.delete_at IS NULL AND s.price_monthly > 0`, [userId]);
  for (const s of idleOff) {
    const days = s.off_at ? Math.floor((Date.now() - new Date(s.off_at).getTime()) / 86_400_000) : 0;
    // Says more than SERVER_OFF_LONG about the same server (same key), so it takes its place.
    const prev = out.findIndex((x) => x.key === `off:${s.id}`);
    if (days >= 7 && prev >= 0) out.splice(prev, 1);
    if (days >= 7) add('OFF_BUT_BILLED', 'info', { name: s.name, days, price: s.price, currency: s.currency }, `/servers/${s.id}`, `off:${s.id}`, { kind: 'power_on', serverId: s.id });
  }
  const [limits, usage] = await Promise.all([limitsFor(userId), usageOf(userId)]);
  for (const [k, l] of [['servers', 'max_servers'], ['vcpu', 'max_vcpu'], ['memoryMb', 'max_memory_mb'], ['diskGb', 'max_disk_gb']] as const) {
    const max = (limits as unknown as Record<string, number | null>)?.[l];
    const used = (usage as Record<string, number>)[k];
    if (max && pct(used, max) >= 80) add('QUOTA_NEAR', pct(used, max) >= 100 ? 'danger' : 'warning', { resource: k, used, max }, '/order', `quota:${k}`);
  }
  // Servers where a firewall could be enforced but none is attached: everything coming in is open.
  const { rows: open } = await pool.query(`SELECT s.name FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN vmware_connections c ON c.id = p.connection_id
    WHERE s.owner_id = $1 AND s.state = 'ready' AND s.delete_at IS NULL AND c.operations->>'firewall' = 'true' AND NOT EXISTS (SELECT 1 FROM firewall_servers fs WHERE fs.server_id = s.id) ORDER BY s.name`, [userId]);
  if (open.length) add('NO_FIREWALL', 'info', { n: open.length, name: open[0].name }, '/firewalls', 'firewall');
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

// Drops the findings this person hid; `hidden` says how many, so the list can offer to show them again.
async function visible(userId: string, list: Insight[]) {
  const { rows } = await pool.query('SELECT key FROM insight_dismissals WHERE user_id = $1 AND (until IS NULL OR until > now())', [userId]);
  const hide = new Set(rows.map((r) => r.key));
  const insights = list.filter((i) => !hide.has(i.key));
  return { insights, hidden: list.length - insights.length };
}

@Controller('insights') @UseGuards(SessionGuard)
export class InsightsController {
  @Get()
  async mine(@Req() req: AuthedRequest) { return visible(req.user.id, await customerInsights(req.user.id)); }

  // Hide one finding for 1 or 7 days, or for good (days null). It comes back by itself when it is gone and returns.
  @Put('dismissals') @HttpCode(204)
  async dismiss(@Req() req: AuthedRequest, @Body() b: { key?: unknown; days?: unknown }) {
    if (typeof b?.key !== 'string' || !b.key || b.key.length > 200) throw apiError(400, 'VALIDATION_FAILED', 'Check the key', { key: 'INVALID_VALUE' });
    if (b.days !== null && b.days !== 1 && b.days !== 7) throw apiError(400, 'VALIDATION_FAILED', 'Check the days', { days: 'INVALID_VALUE' });
    await pool.query(`INSERT INTO insight_dismissals (user_id, key, until) VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END)
      ON CONFLICT (user_id, key) DO UPDATE SET until = EXCLUDED.until`, [req.user.id, b.key, b.days]);
  }

  @Delete('dismissals') @HttpCode(204)
  async restore(@Req() req: AuthedRequest) { await pool.query('DELETE FROM insight_dismissals WHERE user_id = $1', [req.user.id]); }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class StaffInsightsController {
  @Get('insights') @Can('dashboard.view')
  async all(@Req() req: AuthedRequest) {
    const insights = await staffInsights();
    // Links into areas the viewer cannot open are dropped.
    return visible(req.user.id, insights.filter((i) => !i.link.startsWith('/admin/settings') || can(req.user.permissions, 'settings.view') || can(req.user.permissions, 'settings.manage')));
  }
}
