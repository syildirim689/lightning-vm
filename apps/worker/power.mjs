// Energy sampling: every POWER_SAMPLE_MINUTES (default 5) each connected host's power is stored, measured
// (power.power.average) where the host reports it, otherwise estimated from its profile (idle and full-load
// watts; a default when none is set) and CPU use. Each running server gets a share by its CPU use.
import { adapter, connectionTarget } from './operations.mjs';
import { checkCpu } from './abuse.mjs';

export const defaultProfile = { idle: 120, max: 400 };

// Watts for a host without a power counter: linear between idle and full load.
export function estimate(profile, cpuUsed, cpuTotal) {
  const util = cpuTotal > 0 ? Math.min(1, Math.max(0, cpuUsed / cpuTotal)) : 0;
  return { watts: profile.idle + (profile.max - profile.idle) * util, util };
}

// A host's watts shared among its running servers by CPU use (evenly when none uses CPU).
export function shares(watts, vms) {
  const used = vms.reduce((a, v) => a + Math.max(0, v.cpuUsedMhz), 0);
  return vms.map((v) => ({ name: v.name, watts: used > 0 ? (watts * Math.max(0, v.cpuUsedMhz)) / used : watts / vms.length }));
}

export async function samplePower(db, log, notify = async () => {}) {
  const { rows: conns } = await db.query("SELECT * FROM vmware_connections WHERE status IS DISTINCT FROM 'error'");
  const { rows: profiles } = await db.query('SELECT connection_id, host_moref, idle_watts, max_watts FROM power_host_profiles');
  const profileOf = (c, h) => { const p = profiles.find((x) => x.connection_id === c && x.host_moref === h); return p ? { idle: p.idle_watts, max: p.max_watts } : defaultProfile; };
  const cap = 15; // a gap longer than this (worker down) is not counted as consumption
  for (const c of conns) {
    let report;
    try { report = await adapter('/v1/power', connectionTarget(c)); }
    catch (e) { log('warn', 'power_sample_failed', { connection: c.id, code: e.code }); continue; }
    for (const h of report.hosts.filter((x) => x.connected)) {
      const est = estimate(profileOf(c.id, h.moref), h.cpuUsedMhz, h.cpuTotalMhz);
      const watts = h.watts ?? est.watts;
      await db.query(`INSERT INTO power_samples (connection_id, host_moref, host_name, watts, minutes, source, cpu_util)
        VALUES ($1, $2, $3, $4, LEAST($5, GREATEST(0.1, COALESCE(EXTRACT(EPOCH FROM now() - (SELECT max(at) FROM power_samples WHERE connection_id = $1 AND host_moref = $2)) / 60, $6))), $7, $8)
        ON CONFLICT DO NOTHING`, [c.id, h.moref, h.name, watts.toFixed(2), cap, Number(process.env.POWER_SAMPLE_MINUTES) || 5, h.watts === null || h.watts === undefined ? 'estimated' : 'measured', est.util.toFixed(4)]);
      const vms = report.vms.filter((v) => v.host === h.moref);
      // Each server's CPU percentage, for the mining check (abuse.mjs).
      for (const v of vms) {
        const id = v.name.slice(4);
        if (!/^[0-9a-f-]{36}$/.test(id)) continue;
        await db.query(`INSERT INTO server_cpu_samples (server_id, cpu_pct) SELECT id, $2 * 100 / (vcpu * $3::float8) FROM servers WHERE id = $1 AND vcpu > 0 AND $3::float8 > 0
          ON CONFLICT DO NOTHING`, [id, v.cpuUsedMhz, h.coreMhz ?? 0]);
      }
      for (const s of shares(watts, vms)) {
        const id = s.name.slice(4); // lvm-<server id>
        if (!/^[0-9a-f-]{36}$/.test(id)) continue;
        await db.query(`INSERT INTO power_server_samples (server_id, watts, minutes)
          SELECT $1, $2, LEAST($3, GREATEST(0.1, COALESCE(EXTRACT(EPOCH FROM now() - (SELECT max(at) FROM power_server_samples WHERE server_id = $1)) / 60, $4)))
          WHERE EXISTS (SELECT 1 FROM servers WHERE id = $1) ON CONFLICT DO NOTHING`, [id, s.watts.toFixed(2), cap, Number(process.env.POWER_SAMPLE_MINUTES) || 5]);
      }
    }
  }
  await checkCpu(db, notify);
  // Raw samples are kept for 400 days (host) and 120 days (servers).
  await db.query("DELETE FROM power_samples WHERE at < now() - interval '400 days'");
  await db.query("DELETE FROM power_server_samples WHERE at < now() - interval '120 days'");
}
