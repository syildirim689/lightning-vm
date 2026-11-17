// Network traffic per server: the energy sample (power.mjs) brings each running VM's last 15 minutes of realtime
// network counters (KB/s per 20-second sample). Each sample is counted once, by its time, into the server's day;
// a server with a monthly allowance is warned at 80 % and 100 % (once each per month). In and out both count.
import { adapter, connectionTarget } from './operations.mjs';

const uuid = /^[0-9a-f-]{36}$/;

// A speed limit on the server's distributed ports (0 lifts it). False: there is no VM to limit.
async function shape(db, serverId, mbps) {
  const { rows: [s] } = await db.query(`SELECT s.vm_moref, c.* FROM servers s JOIN resource_pools p ON p.id = s.pool_id JOIN vmware_connections c ON c.id = p.connection_id WHERE s.id = $1`, [serverId]);
  if (!s?.vm_moref) return false;
  await adapter('/v1/vm/shaping', { ...connectionTarget(s), vm: s.vm_moref, expectName: `lvm-${serverId}`, mbps });
  return true;
}
// Errors after which there is nothing to slow down or to lift: the platform has no shaping, or the VM is gone.
const unshapeable = new Set(['PLATFORM_NOT_SUPPORTED', 'VM_NOT_FOUND']);

// Bytes in the samples newer than `since`, and the newest sample's time.
export function counted(samples, since) {
  let rx = 0, tx = 0, last = since ? new Date(since) : null;
  for (const s of samples) {
    const t = new Date(s.t);
    if (since && t <= new Date(since)) continue;
    rx += s.rx * 1024 * 20;
    tx += s.tx * 1024 * 20;
    if (!last || t > last) last = t;
  }
  return { rx: Math.round(rx), tx: Math.round(tx), last };
}

// Which warning a month's use calls for (null: none, or already sent).
export function warning(usedBytes, allowanceGb, warned, month) {
  if (!allowanceGb) return null;
  const pct = usedBytes / (allowanceGb * 1024 ** 3) * 100;
  const level = pct >= 100 ? 100 : pct >= 80 ? 80 : null;
  if (!level) return null;
  const [m, l] = (warned ?? '').split(':');
  return m === month && Number(l) >= level ? null : level;
}

export async function countTraffic(db, vms, notify = async () => {}, log = () => {}) {
  for (const v of vms) {
    const id = v.name.slice(4); // lvm-<server id>
    if (!uuid.test(id) || !v.traffic?.length) continue;
    const { rows: [s] } = await db.query('SELECT traffic_counted_at FROM servers WHERE id = $1', [id]);
    if (!s) continue;
    const c = counted(v.traffic, s.traffic_counted_at);
    if (!c.last || (s.traffic_counted_at && c.last.getTime() === new Date(s.traffic_counted_at).getTime())) continue;
    await db.query(`INSERT INTO server_traffic (server_id, day, rx_bytes, tx_bytes) VALUES ($1, current_date, $2, $3)
      ON CONFLICT (server_id, day) DO UPDATE SET rx_bytes = server_traffic.rx_bytes + EXCLUDED.rx_bytes, tx_bytes = server_traffic.tx_bytes + EXCLUDED.tx_bytes`, [id, c.rx, c.tx]);
    await db.query('UPDATE servers SET traffic_counted_at = $2 WHERE id = $1', [id, c.last]);
  }
  const { rows } = await db.query(`SELECT s.id, s.name, s.owner_id, s.traffic_gb, s.traffic_warned, s.traffic_throttled, to_char(current_date, 'YYYY-MM') AS month,
      COALESCE((SELECT sum(rx_bytes + tx_bytes) FROM server_traffic t WHERE t.server_id = s.id AND t.day >= date_trunc('month', current_date)), 0)::float8 AS used
    FROM servers s WHERE s.traffic_gb IS NOT NULL AND s.state NOT IN ('deleted', 'deleting')`);
  const { rows: [st] } = await db.query("SELECT value FROM settings WHERE key = 'servers'");
  const policy = { overLimit: 'throttle', throttleMbps: 10, ...st?.value?.traffic };
  // Over the allowance: slowed down (once) when the admin chose so. Each server on its own: one that cannot be slowed
  // (a platform without shaping, an adapter error) must not stop the others, the lifting or the warnings below. The mark
  // is set only once the limit is really on; a platform without shaping gets the notification alone, an error is tried
  // again on the next run.
  const slowed = new Set(rows.filter((r) => r.traffic_throttled).map((r) => r.id));
  for (const s of rows.filter((r) => policy.overLimit === 'throttle' && !r.traffic_throttled && r.used >= r.traffic_gb * 1024 ** 3)) {
    try {
      if (!(await shape(db, s.id, policy.throttleMbps))) continue;
      await db.query('UPDATE servers SET traffic_throttled = true WHERE id = $1', [s.id]);
      slowed.add(s.id);
    } catch (e) { if (!unshapeable.has(e.code)) log('warn', 'traffic_throttle_failed', { serverId: s.id, code: e.code ?? 'INTERNAL_ERROR' }); }
  }
  // Covered again (a new month, a bigger package, the limit removed or the policy changed): full speed.
  const { rows: lift } = await db.query(`SELECT s.id, s.state FROM servers s WHERE s.traffic_throttled AND (s.traffic_gb IS NULL OR $1 = 'notify' OR s.state IN ('deleted', 'deleting')
      OR COALESCE((SELECT sum(rx_bytes + tx_bytes) FROM server_traffic t WHERE t.server_id = s.id AND t.day >= date_trunc('month', current_date)), 0) < s.traffic_gb::float8 * 1024 ^ 3)`, [policy.overLimit]);
  for (const s of lift) {
    try {
      // The mark goes once the limit is off (or there is nothing left to lift it from); an error keeps it for the next run.
      const gone = ['deleted', 'deleting'].includes(s.state);
      await shape(db, s.id, 0).catch((e) => { if (!gone && !unshapeable.has(e.code)) throw e; });
      await db.query('UPDATE servers SET traffic_throttled = false WHERE id = $1', [s.id]);
      slowed.delete(s.id);
    } catch (e) { log('warn', 'traffic_unthrottle_failed', { serverId: s.id, code: e.code ?? 'INTERNAL_ERROR' }); }
  }
  for (const s of rows) {
    const level = warning(s.used, s.traffic_gb, s.traffic_warned, s.month);
    if (!level) continue;
    await db.query('UPDATE servers SET traffic_warned = $2 WHERE id = $1', [s.id, `${s.month}:${level}`]);
    const d = { serverId: s.id, name: s.name, level: String(level), usedGb: (s.used / 1024 ** 3).toFixed(1), allowanceGb: String(s.traffic_gb),
      throttled: level === 100 && slowed.has(s.id) ? String(policy.throttleMbps) : '' }; // only a limit that is really on is announced
    await notify('server.traffic', [s.owner_id], d);
    if (level === 100) await notify('admin.traffic_exceeded', 'staff:servers.view_all', d);
  }
  await db.query("DELETE FROM server_traffic WHERE day < current_date - 400");
}
