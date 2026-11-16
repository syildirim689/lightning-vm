// Energy sampling: every POWER_SAMPLE_MINUTES (default 5) each connected host's power is stored, measured
// (power.power.average) where the host reports it, otherwise estimated from its profile (idle and full-load
// watts; a default when none is set) and CPU use. Each running server gets a share by its CPU use.
import { adapter, connectionTarget } from './operations.mjs';
import { checkCpu } from './abuse.mjs';
import { countTraffic } from './traffic.mjs';

export const defaultProfile = { idle: 120, max: 400 };

// CPU use as the adapter reports it, or null for "not measured": no sample is stored for it (a zero would read as an
// idle server, an oversized one, a healthy one). Adapters that cannot measure send null; until they all do, the
// platforms known not to measure are not believed when they say exactly 0.
const unmeasured = new Set(['xcpng', 'ovirt', 'libvirt', 'incus']);
export const cpuOf = (kind, mhz) => (mhz === null || mhz === undefined || !Number.isFinite(Number(mhz)) || (unmeasured.has(kind) && Number(mhz) === 0) ? null : Number(mhz));

// Watts for a host without a power counter: linear between idle and full load.
export function estimate(profile, cpuUsed, cpuTotal) {
  const util = cpuTotal > 0 ? Math.min(1, Math.max(0, cpuUsed / cpuTotal)) : 0;
  return { watts: profile.idle + (profile.max - profile.idle) * util, util };
}

// A host's watts shared among its running servers by CPU use (evenly when none uses CPU).
export function shares(watts, vms) {
  const used = vms.reduce((a, v) => a + Math.max(0, v.cpuUsedMhz ?? 0), 0); // not measured: counts as none, so the split is even
  return vms.map((v) => ({ name: v.name, watts: used > 0 ? (watts * Math.max(0, v.cpuUsedMhz ?? 0)) / used : watts / vms.length }));
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
    // Network traffic of every running server on this connection (its own failure never stops the energy sample).
    await countTraffic(db, report.vms ?? [], notify, log).catch((e) => log('warn', 'traffic_failed', { connection: c.id, error: String(e.message).slice(0, 200) }));
    for (const h of report.hosts.filter((x) => x.connected)) {
      // CPU not measured: the estimate is the profile's idle watts (a floor, marked "estimated") and no utilisation is stored.
      const hostCpu = cpuOf(c.kind, h.cpuUsedMhz);
      const est = estimate(profileOf(c.id, h.moref), hostCpu ?? 0, h.cpuTotalMhz);
      const watts = h.watts ?? est.watts;
      await db.query(`INSERT INTO power_samples (connection_id, host_moref, host_name, watts, minutes, source, cpu_util)
        VALUES ($1, $2, $3, $4, LEAST($5, GREATEST(0.1, COALESCE(EXTRACT(EPOCH FROM now() - (SELECT max(at) FROM power_samples WHERE connection_id = $1 AND host_moref = $2)) / 60, $6))), $7, $8)
        ON CONFLICT DO NOTHING`, [c.id, h.moref, h.name, watts.toFixed(2), cap, Number(process.env.POWER_SAMPLE_MINUTES) || 5, h.watts === null || h.watts === undefined ? 'estimated' : 'measured', hostCpu === null ? null : est.util.toFixed(4)]);
      const vms = report.vms.filter((v) => v.host === h.moref).map((v) => ({ ...v, cpuUsedMhz: cpuOf(c.kind, v.cpuUsedMhz) }));
      // Each server's CPU percentage, for the mining check (abuse.mjs).
      for (const v of vms) {
        const id = v.name.slice(4);
        if (!/^[0-9a-f-]{36}$/.test(id) || v.cpuUsedMhz === null) continue; // not measured: no sample (idle, sizing, mining and health read these)
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
