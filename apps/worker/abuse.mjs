// Abuse monitoring. Ports: every server address is probed (TCP connect, short timeout) on the admin's list of
// risky ports; an open one becomes a finding until it closes. CPU: a server whose CPU stays above the
// threshold for the whole window is a mining suspicion (a signal for a person to look at, not proof).
import { connect } from 'node:net';

export const defaultAbuse = {
  portScan: true, scanMinutes: 30, cpu: true, cpuThreshold: 90, cpuHours: 6, notifyCustomer: false,
  ports: [{ port: 23, label: 'Telnet' }, { port: 445, label: 'SMB' }, { port: 1433, label: 'MS SQL' }, { port: 2375, label: 'Docker API' }, { port: 3306, label: 'MySQL' },
    { port: 5432, label: 'PostgreSQL' }, { port: 6379, label: 'Redis' }, { port: 9200, label: 'Elasticsearch' }, { port: 11211, label: 'Memcached' }, { port: 27017, label: 'MongoDB' }],
};
const settings = async (db) => ({ ...defaultAbuse, ...(await db.query("SELECT value FROM settings WHERE key = 'abuse'")).rows[0]?.value });

export function probe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (open) => { s.destroy(); resolve(open); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Runs fn over items, at most `limit` at a time.
async function pooled(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

async function open(db, notify, s, kind, key, detail, cfg) {
  const { rows: [f] } = await db.query(`INSERT INTO abuse_findings (server_id, kind, address, port, detail) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (server_id, kind, COALESCE(host(address), ''), COALESCE(port, 0)) WHERE resolved_at IS NULL DO UPDATE SET last_seen = now(), detail = EXCLUDED.detail
    RETURNING (xmax = 0) AS created`, [s.id, kind, key.address ?? null, key.port ?? null, detail]);
  if (!f.created) return;
  const data = { serverId: s.id, name: s.name, owner: s.owner, kind, address: key.address ?? '', port: key.port ?? '', label: detail.label ?? '', cpu: detail.avg ?? '' };
  await notify('admin.abuse', 'staff:servers.view_all', data);
  if (kind === 'port' && cfg.notifyCustomer) await notify('server.port_open', [s.owner_id], data);
}

export async function scanPorts(db, log, notify) {
  const cfg = await settings(db);
  if (!cfg.portScan || !cfg.ports.length) return;
  const { rows: targets } = await db.query(`SELECT s.id, s.name, s.owner_id, u.email AS owner, host(a.address) AS address FROM servers s JOIN users u ON u.id = s.owner_id
    JOIN ip_allocations a ON a.server_id = s.id AND family(a.address) = 4 WHERE s.state = 'ready'`);
  const jobs = targets.flatMap((t) => cfg.ports.map((p) => ({ t, p })));
  const seen = new Set();
  await pooled(jobs, 64, async ({ t, p }) => {
    if (!(await probe(t.address, p.port))) return;
    seen.add(`${t.id}|${t.address}|${p.port}`);
    await open(db, notify, t, 'port', { address: t.address, port: p.port }, { label: p.label }, cfg);
  });
  // Findings whose port no longer answers are resolved.
  const { rows: openPorts } = await db.query("SELECT id, server_id, host(address) AS address, port FROM abuse_findings WHERE kind = 'port' AND resolved_at IS NULL");
  for (const f of openPorts) if (!seen.has(`${f.server_id}|${f.address}|${f.port}`)) await db.query('UPDATE abuse_findings SET resolved_at = now() WHERE id = $1', [f.id]);
  log('info', 'port_scan_done', { probes: jobs.length, open: seen.size });
}

// A server's CPU percentage from its host data: used MHz over its vCPUs times the host's core speed.
export const cpuPct = (usedMhz, vcpu, coreMhz) => (vcpu > 0 && coreMhz > 0 ? Math.max(0, (usedMhz / (vcpu * coreMhz)) * 100) : null);

export async function checkCpu(db, notify) {
  const cfg = await settings(db);
  if (!cfg.cpu) return;
  // Suspicious: enough samples to cover most of the window, and (nearly) all of them above the threshold.
  const { rows } = await db.query(`SELECT s.id, s.name, s.owner_id, u.email AS owner, avg(c.cpu_pct)::float8 AS avg, count(*)::int AS n,
      count(*) FILTER (WHERE c.cpu_pct >= $1)::int AS high, min(c.at) AS since
    FROM server_cpu_samples c JOIN servers s ON s.id = c.server_id JOIN users u ON u.id = s.owner_id
    WHERE c.at > now() - make_interval(hours => $2) AND s.state <> 'deleted' GROUP BY s.id, u.email`, [cfg.cpuThreshold, cfg.cpuHours]);
  const expected = (cfg.cpuHours * 60) / (Number(process.env.POWER_SAMPLE_MINUTES) || 5);
  for (const r of rows) {
    const suspicious = r.n >= Math.max(2, expected * 0.8) && r.high / r.n >= 0.9;
    if (suspicious) await open(db, notify, r, 'cpu', {}, { avg: Math.round(r.avg), hours: cfg.cpuHours, since: r.since }, cfg);
    else await db.query("UPDATE abuse_findings SET resolved_at = now() WHERE server_id = $1 AND kind = 'cpu' AND resolved_at IS NULL", [r.id]);
  }
  await db.query("DELETE FROM server_cpu_samples WHERE at < now() - interval '14 days'");
}
