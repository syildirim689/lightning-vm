// Insights: findings the panel computes from its own data, each with a severity, the numbers behind it
// and where to fix it. Staff see platform findings; customers see findings about their own servers.
// Critical staff findings are also sent as the "admin.insight" notification, at most once a day each.
import { Body, Controller, Delete, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { paymentsInReview } from './billing';
import { capacityOf, limitsFor, usageOf } from './catalog';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { summary as maintenance } from './maintenance';
import { notify } from './notify';
import { can, customerLevel, type Permission } from './permissions';
import { Can, PermissionGuard } from './rbac';
import { restoreHold } from './restore-hold';
import { activeCaptcha, mailReady } from './settings-store';
import { cpuStats } from './smart';
import { sizing } from './smart-rules';
import { callAdapter, storedTarget } from './vmware';

// action: a one-click fix the card offers next to its link (customer findings about one server).
export type Insight = { code: string; severity: 'danger' | 'warning' | 'info'; params: Record<string, string | number>; link: string; key: string; action?: { kind: 'power_on' | 'restore'; serverId: string } };
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// Shared by the findings below and the staff menu's counts (GET /admin/attention), so both always say the same.
const restoreHoldState = async (): Promise<{ since: Date; backup: string | null } | null> => {
  const { rows: [h] } = await pool.query("SELECT value->>'backup' AS backup, at FROM maintenance_state WHERE key = 'restore_hold'");
  return h ? { since: h.at, backup: h.backup ?? null } : null;
};

export async function staffInsights(): Promise<Insight[]> {
  const out: Insight[] = [];
  const add = (code: string, severity: Insight['severity'], params: Insight['params'], link: string, key = code) => out.push({ code, severity, params, link, key });

  // Restored from a backup and not yet released: the panel acts on nothing by itself. First in the list.
  if (await restoreHold()) {
    const h = await restoreHoldState();
    if (h) add('RESTORE_HOLD', 'danger', { since: new Date(h.since).toISOString(), backup: h.backup ?? '' }, '/admin/system');
  }

  const { rows: pools } = await pool.query('SELECT * FROM resource_pools WHERE active');
  // Each pool's capacity once, for both the fill levels and the packages below.
  const caps = new Map(await Promise.all(pools.map(async (p) => [p.id, await capacityOf(p)] as const)));
  for (const p of pools) {
    const cap = caps.get(p.id)!;
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

  // Ended without learning what the platform did (OUTCOME_UNKNOWN) or on a VM that is not the server's (VM_MISMATCH):
  // nothing was undone and nothing retries by itself, so someone has to look. Gone once the server has an operation
  // that succeeded afterwards (a retry of the same operation takes it out of "failed" at once).
  const { rows: [decide] } = await pool.query(`SELECT count(*)::int AS n FROM operations o JOIN servers s ON s.id = o.server_id
    WHERE o.status = 'failed' AND o.error_code IN ('OUTCOME_UNKNOWN', 'VM_MISMATCH') AND coalesce(o.finished_at, o.updated_at) > now() - interval '14 days' AND s.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM operations l WHERE l.server_id = o.server_id AND l.status = 'succeeded' AND l.created_at > o.created_at)`);
  if (decide.n) add('OPERATIONS_NEED_DECISION', 'danger', { n: decide.n }, '/admin/servers?tab=operations');

  const review = await paymentsInReview();
  if (review.n) add('PAYMENTS_IN_REVIEW', 'warning', { n: review.n, oldest: new Date(review.oldest!).toISOString() }, '/admin/billing?tab=payments&status=review');

  const { rows: [rec] } = await pool.query('SELECT count(*)::int AS n FROM reconciliation_findings WHERE resolved_at IS NULL');
  if (rec.n) add('RECONCILE_FINDINGS', 'warning', { count: rec.n }, '/admin/servers?tab=reconcile');

  // minutes: since the last heartbeat of any copy (none ever: a large number), so alerts can wait out a restart.
  const { rows: [w] } = await pool.query(`SELECT count(*) FILTER (WHERE last_seen > now() - interval '90 seconds')::int AS healthy,
    coalesce(floor(extract(epoch FROM now() - max(last_seen)) / 60), 9999)::int AS minutes FROM worker_heartbeats`);
  if (!w.healthy) add('WORKER_DOWN', 'danger', { minutes: w.minutes }, '/admin/system');

  const m = maintenance();
  if (m.lastBackup?.status === 'failed') add('BACKUP_FAILED', 'danger', { code: m.lastBackup.code ?? '' }, '/admin/system');
  else if (!m.lastSuccessfulBackup) add('BACKUP_NEVER', 'warning', {}, '/admin/system');
  else if (Date.now() - Date.parse(m.lastSuccessfulBackup.time) > 26 * 3600_000) add('BACKUP_STALE', 'warning', { hours: Math.round((Date.now() - Date.parse(m.lastSuccessfulBackup.time)) / 3600_000) }, '/admin/system');

  // Packages no active location can currently host.
  const { rows: pkgs } = await pool.query(`SELECT p.id, p.name, p.vcpu, p.memory_mb, p.disk_gb, ARRAY(SELECT pool_id FROM package_pools WHERE package_id = p.id) AS pools FROM packages p WHERE p.active`);
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
  const withOld = (await oldSnapshots(userId)).filter((s) => s.n > 0);
  // One server: the finding leads to it (and names it); several: to the list.
  if (withOld.length) add('SNAPSHOTS_OLD', 'info', { n: withOld.reduce((a, s) => a + s.n, 0), servers: withOld.length, ...(withOld.length === 1 && { serverId: withOld[0].id, name: withOld[0].name }) },
    withOld.length === 1 ? `/servers/${withOld[0].id}` : '/servers', 'snapshots-old');
  const { rows: [keys] } = await pool.query('SELECT count(*)::int AS n FROM ssh_keys WHERE owner_id = $1', [userId]);
  if (!keys.n) add('NO_SSH_KEYS', 'info', {}, '/account?tab=keys', 'keys');
  const { rows: [u] } = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [userId]);
  if (!u?.two_factor_enabled) add('ENABLE_2FA', 'info', {}, '/account?tab=security', '2fa');
  return out;
}

// Snapshots older than 30 days, per server. Snapshots live on the platform, not in the database, so only servers that
// could have one are asked about: those with a snapshot taken through the panel over 30 days ago (at most 20). The
// answer is kept for six hours under the server's latest operation, so taking or removing a snapshot asks again; a
// platform that does not answer within a few seconds is skipped (and not asked again for five minutes).
export const snapshotAgeDays = 30;
// Pure: how many of a server's snapshots are older than the limit. The short snapshot a backup takes is not one.
export function countOldSnapshots(snapshots: { name?: string; created?: string }[], now = Date.now(), days = snapshotAgeDays) {
  return snapshots.filter((s) => !String(s.name ?? '').startsWith('lightning-backup ') && now - Date.parse(String(s.created ?? '')) > days * 86_400_000).length;
}
async function oldSnapshots(userId: string): Promise<{ id: string; name: string; n: number }[]> {
  const { rows } = await pool.query(`SELECT s.id, s.name, s.vm_moref, c.id AS connection, (SELECT o.id || ':' || o.status FROM operations o WHERE o.server_id = s.id ORDER BY o.created_at DESC LIMIT 1) AS latest
    FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN vmware_connections c ON c.id = p.connection_id
    WHERE s.owner_id = $1 AND s.deleted_at IS NULL AND s.state IN ('ready', 'error') AND s.vm_moref IS NOT NULL AND c.status = 'ok'
      AND EXISTS (SELECT 1 FROM operations o WHERE o.server_id = s.id AND o.kind = 'snapshot_create' AND o.status = 'succeeded' AND o.created_at < now() - make_interval(days => $2))
    ORDER BY s.name LIMIT 20`, [userId, snapshotAgeDays]);
  return Promise.all(rows.map(async (s) => {
    const key = `insight:snapshots:${s.id}:${s.vm_moref}:${s.latest}`;
    let list: { name?: string; created?: string }[] | null = null;
    const hit = await redis.get(key).catch(() => null);
    if (hit) list = JSON.parse(hit);
    else {
      list = await pool.query('SELECT * FROM vmware_connections WHERE id = $1', [s.connection])
        .then(({ rows: [c] }) => callAdapter<{ snapshots: { name: string; created: string }[] }>('/v1/vm/snapshots', { ...storedTarget(c), vm: s.vm_moref, expectName: `lvm-${s.id}` }, 5_000))
        .then((r) => r.snapshots.map((x) => ({ name: x.name, created: x.created })), () => null);
      await redis.set(key, JSON.stringify(list ?? []), 'EX', list ? 6 * 3600 : 300).catch(() => undefined);
    }
    return { id: s.id as string, name: s.name as string, n: countOldSnapshots(list ?? []) };
  }));
}

// Texts for the notification channels (the panel translates insight codes itself).
const texts: Record<string, { tr: (p: Insight['params']) => [string, string]; en: (p: Insight['params']) => [string, string] }> = {
  POOL_NEARLY_FULL: { tr: (p) => [`${p.pool} dolmak üzere`, `${p.resource} kullanımı %${p.used}.`], en: (p) => [`${p.pool} is nearly full`, `${p.resource} usage is ${p.used}%.`] },
  IP_POOL_EMPTY: { tr: (p) => [`${p.pool}: boş IP kalmadı`, 'Yeni sunucu oluşturulamaz.'], en: (p) => [`${p.pool}: no free IP address`, 'New servers cannot be created.'] },
  CONNECTION_DOWN: { tr: (p) => [`${p.connection} erişilemiyor`, `Hata: ${p.code}`], en: (p) => [`${p.connection} is unreachable`, `Error: ${p.code}`] },
  OPERATIONS_STUCK: { tr: (p) => ['Takılmış işlemler', `${p.count} işlem süresini aştı.`], en: (p) => ['Stuck operations', `${p.count} operations passed their deadline.`] },
  WORKER_DOWN: { tr: (p) => ['Arka plan çalışanı yanıt vermiyor', `Son sinyal ${p.minutes} dakika önce geldi; sunucu işlemleri bu sürede ilerlemiyor. Durumu Sistem sayfasında görebilirsiniz.`],
    en: (p) => ['Background worker not responding', `Its last heartbeat was ${p.minutes} minutes ago; server operations are not progressing. The System page shows its state.`] },
  BACKUP_FAILED: { tr: (p) => ['Son yedek başarısız', `Kod: ${p.code}`], en: (p) => ['The last backup failed', `Code: ${p.code}`] },
};

// Every 10 minutes: new critical findings go out once per finding per day.
export function startInsightAlerts() {
  const run = async () => {
    if (!(await redis.set('lock:insights', '1', 'EX', 540, 'NX').catch(() => null))) return;
    try {
      // A stopped worker is only reported once it stayed silent for 5 minutes, and not in the API's first 5 minutes:
      // an update or a restart stops it for a while, and that is not an outage.
      const outage = (x: Insight) => x.code !== 'WORKER_DOWN' || (Number(x.params.minutes) >= 5 && process.uptime() > 300);
      for (const i of (await staffInsights()).filter((x) => x.severity === 'danger' && texts[x.code] && outage(x))) {
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

// The staff list for the dashboard, shared by all staff for 60 seconds (it reads every pool, IP range and
// VMware capacity). The alerts above keep computing it fresh.
const staffKey = 'insights:staff';
async function cachedStaffInsights(): Promise<Insight[]> {
  const hit = await redis.get(staffKey).catch(() => null);
  if (hit) return JSON.parse(hit);
  const list = await staffInsights();
  await redis.set(staffKey, JSON.stringify(list), 'EX', 60).catch(() => undefined);
  return list;
}

// Findings about an area only those who may open it see (the list is computed once for all staff).
const findingNeeds: Record<string, Permission[]> = { PAYMENTS_IN_REVIEW: ['billing.view'] };
export const maySeeFinding = (permissions: string[], i: Pick<Insight, 'code' | 'link'>) =>
  (!i.link.startsWith('/admin/settings') || can(permissions, 'settings.view') || can(permissions, 'settings.manage'))
  && (!findingNeeds[i.code] || findingNeeds[i.code].some((p) => can(permissions, p)));

// The counts the staff menu shows next to its entries. Pure: which of them this person gets, by the permission each
// entry's own page asks for (its list route); a key they may not see is left out, not sent as zero.
export type Attention = { paymentsInReview: number; failedOperations: number; abuse: number; restoreHold: { since: string; backup: string | null } | null };
export const attentionNeeds: Record<keyof Attention, Permission[]> = {
  paymentsInReview: ['billing.view'],                       // GET /admin/billing/payments
  failedOperations: ['servers.view_all', 'dashboard.view'],  // GET /admin/operations
  abuse: ['servers.view_all'],                              // GET /admin/abuse
  restoreHold: ['system.view', 'dashboard.view', 'system.update'], // GET /admin/system, /admin/maintenance, /admin/system/restore-hold
};
export const attentionKeys = (permissions: string[]) => (Object.keys(attentionNeeds) as (keyof Attention)[]).filter((k) => attentionNeeds[k].some((p) => can(permissions, p)));
// Staff: anyone holding more than the permissions customers have on their own servers (as auth.ts decides it).
export const isStaff = (permissions: string[]) => permissions.some((p) => !customerLevel(p));

@Controller('admin') @UseGuards(SessionGuard)
export class AttentionController {
  // Polled by the menu once a minute: four small statements at most, only those the caller may see.
  @Get('attention')
  async attention(@Req() req: AuthedRequest) {
    if (!isStaff(req.user.permissions)) {
      await audit(req, 'admin.access', 'denied', req.user.id, { path: req.routeOptions.url, need: [] });
      throw apiError(403, 'FORBIDDEN', 'Permission required', undefined, { need: [] });
    }
    const one = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
    const read: { [K in keyof Attention]: () => Promise<Attention[K]> } = {
      paymentsInReview: async () => (await paymentsInReview()).n,
      // Failed in the last 24 hours, as the dashboard and the OPERATIONS_FAILED finding count them.
      failedOperations: () => one("SELECT count(*)::int AS n FROM operations WHERE status = 'failed' AND created_at > now() - interval '24 hours'"),
      // Open findings, as the abuse page's "open" tab lists them (acknowledged ones stay open until they are resolved).
      abuse: () => one('SELECT count(*)::int AS n FROM abuse_findings WHERE resolved_at IS NULL'),
      restoreHold: async () => { const h = await restoreHoldState(); return h && { since: new Date(h.since).toISOString(), backup: h.backup }; },
    };
    const keys = attentionKeys(req.user.permissions);
    const values = await Promise.all(keys.map((k) => read[k]()));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Partial<Attention>;
  }
}

@Controller('admin') @UseGuards(PermissionGuard)
export class StaffInsightsController {
  @Get('insights') @Can('dashboard.view')
  async all(@Req() req: AuthedRequest) {
    const insights = await cachedStaffInsights();
    // Findings about areas the viewer cannot open are dropped.
    return visible(req.user.id, insights.filter((i) => maySeeFinding(req.user.permissions, i)));
  }
}
