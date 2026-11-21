// Usage anomalies, the hourly run: (1) the raw CPU samples (one per server every few minutes, kept 14 days) are
// rolled up into one row per server and hour (server_cpu_hourly, kept 63 days: the power schedule suggestion and the
// "quietest hour" read weeks of it); (2) every ready server's last hours of CPU and last days of traffic are judged
// against its own baseline (anomaly-rules.mjs) and a finding is opened, kept or closed. The owner is told once when a
// finding opens (event server.usage_anomaly). Nothing here acts on a server.
// Cost per run: the roll-up reads only the samples since the newest rolled-up hour; the check reads, for 200 servers at
// a time, their hourly rows of 14 days (at most 336 each) and their traffic rows of 16 days.
import { abuseHint, cpuAnomaly, cpuRule, trafficAnomaly, trafficRule, DAY } from './anomaly-rules.mjs';

export const ROLLUP_KEEP_DAYS = 63;
export const RESOLVED_KEEP_DAYS = 90;
// An open finding that cannot be judged now (no recent samples: the platform did not answer, the worker was down, the
// server is switched off) is kept this long from when its numbers last held, then closed. Closing it at once meant
// that a gap of two hours in the samples closed every open finding, and the next run opened them again and told
// every owner a second time.
export const UNJUDGED_KEEP_HOURS = 6;
const BATCH = 200;

export async function rollupCpu(db) {
  // The newest rolled-up hour is computed again (it may have been in progress last time); an empty table takes all there is.
  await db.query(`INSERT INTO server_cpu_hourly (server_id, hour, avg_pct, max_pct, samples)
    SELECT server_id, date_trunc('hour', at, 'UTC'), round(avg(cpu_pct), 2), max(cpu_pct), count(*)::int FROM server_cpu_samples
    WHERE at >= coalesce((SELECT max(hour) FROM server_cpu_hourly), '-infinity'::timestamptz) GROUP BY 1, 2
    ON CONFLICT (server_id, hour) DO UPDATE SET avg_pct = EXCLUDED.avg_pct, max_pct = EXCLUDED.max_pct, samples = EXCLUDED.samples`);
  await db.query('DELETE FROM server_cpu_hourly WHERE hour < now() - make_interval(days => $1)', [ROLLUP_KEEP_DAYS]);
}

const iso = (d) => new Date(d).toISOString().slice(0, 10);

export async function detectAnomalies(db, notify = async () => {}, log = () => {}, now = new Date()) {
  const out = { servers: 0, opened: 0, resolved: 0 };
  // The database's own day, as traffic.mjs counts into (current_date).
  const { rows: [{ today }] } = await db.query('SELECT current_date::text AS today');
  // A server that is gone, being deleted or not ready has nothing to judge: its findings close.
  const gone = await db.query(`UPDATE usage_anomalies a SET resolved_at = now() WHERE a.resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = a.server_id AND s.state = 'ready' AND s.delete_at IS NULL)`);
  out.resolved += gone.rowCount;
  const { rows: servers } = await db.query("SELECT id, name, owner_id, created_at FROM servers WHERE state = 'ready' AND delete_at IS NULL ORDER BY id");
  for (let i = 0; i < servers.length; i += BATCH) {
    const batch = servers.slice(i, i + BATCH), ids = batch.map((s) => s.id);
    const [{ rows: hours }, { rows: traffic }, { rows: open }] = await Promise.all([
      db.query('SELECT server_id, hour, avg_pct::float8 AS v FROM server_cpu_hourly WHERE server_id = ANY($1::uuid[]) AND hour >= $2', [ids, new Date(now.getTime() - (cpuRule.baselineDays + 1) * DAY)]),
      db.query('SELECT server_id, day::text AS day, rx_bytes::float8 AS rx, tx_bytes::float8 AS tx FROM server_traffic WHERE server_id = ANY($1::uuid[]) AND day >= $2::date - $3::int', [ids, today, trafficRule.baselineDays + 2]),
      db.query('SELECT id, server_id, metric, direction, last_seen FROM usage_anomalies WHERE resolved_at IS NULL AND server_id = ANY($1::uuid[])', [ids]),
    ]);
    // The rows of the batch are sorted to their servers once (searching all of them again for every server made a
    // batch of 200 servers with two weeks of hours take ten times as long as the reading itself).
    const hoursOf = new Map(), trafficOf = new Map();
    for (const h of hours) { let list = hoursOf.get(h.server_id); if (!list) hoursOf.set(h.server_id, list = []); list.push({ t: new Date(h.hour).getTime(), v: h.v }); }
    for (const t of traffic) { let list = trafficOf.get(t.server_id); if (!list) trafficOf.set(t.server_id, list = []); list.push(t); }
    for (const s of batch) {
      out.servers++;
      const was = (metric) => open.find((a) => a.server_id === s.id && a.metric === metric)?.direction ?? null;
      const cpu = cpuAnomaly(hoursOf.get(s.id) ?? [], now.getTime(), was('cpu'));
      // Traffic: a row of zeros for each day the server existed without any; no row before it was created. A server
      // that has never had a traffic row (a platform that reports none) is not judged at all.
      const mine = trafficOf.get(s.id) ?? [];
      const days = [];
      if (mine.length) {
        const first = Math.max(Date.parse(`${iso(s.created_at)}T00:00:00Z`) + DAY, Date.parse(`${today}T00:00:00Z`) - (trafficRule.baselineDays + 1) * DAY);
        for (let t = first; t <= Date.parse(`${today}T00:00:00Z`); t += DAY) days.push(mine.find((x) => x.day === iso(t)) ?? { day: iso(t), rx: 0, tx: 0 });
      }
      const net = trafficAnomaly(days, today, was('network'));
      for (const [metric, r] of [['cpu', cpu], ['network', net]]) {
        if (!r.state) {
          // Judged and within its usual range: closed. Not enough to judge: kept for a few hours (see above), then closed too.
          const held = open.find((a) => a.server_id === s.id && a.metric === metric);
          if (held && !r.enough && now.getTime() - new Date(held.last_seen).getTime() < UNJUDGED_KEEP_HOURS * 3_600_000) continue;
          if (was(metric)) out.resolved += (await db.query('UPDATE usage_anomalies SET resolved_at = now() WHERE server_id = $1 AND metric = $2 AND resolved_at IS NULL', [s.id, metric])).rowCount;
          continue;
        }
        const { enough, state, ...numbers } = r;
        const detail = { ...numbers, hint: abuseHint(metric, state, numbers) };
        const { rows: [f] } = await db.query(`INSERT INTO usage_anomalies (server_id, metric, direction, detail) VALUES ($1, $2, $3, $4)
          ON CONFLICT (server_id, metric) WHERE resolved_at IS NULL DO UPDATE SET last_seen = now(), direction = EXCLUDED.direction, detail = EXCLUDED.detail
          RETURNING id, (xmax = 0) AS created`, [s.id, metric, state, detail]);
        if (!f.created) continue;
        out.opened++;
        // Numbers as text for the notice: CPU in percent, traffic in GB (one decimal).
        const figure = (x) => (metric === 'cpu' ? String(Math.round(x)) : (x / 1e9).toFixed(1));
        await notify('server.usage_anomaly', [s.owner_id], { serverId: s.id, name: s.name, metric, direction: state,
          recent: figure(metric === 'cpu' ? r.recent : r.value), usual: figure(r.usual) });
      }
    }
  }
  await db.query('DELETE FROM usage_anomalies WHERE resolved_at < now() - make_interval(days => $1)', [RESOLVED_KEEP_DAYS]);
  if (out.opened || out.resolved) log('info', 'usage_anomalies', out);
  return out;
}

export async function runAnomalies(db, notify, log, now = new Date()) {
  await rollupCpu(db);
  return detectAnomalies(db, notify, log, now);
}
