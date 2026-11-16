// The panel server's state, live: processor, memory, load, the data disk and the panel's own processes. The API's
// container shares the host's kernel, so /proc here shows the whole server. A sample is taken every five seconds
// and ten minutes are kept in memory (enough for the small charts on Admin → System). What a container cannot see
// (services, file systems, processes, logs) comes from the host agent's snapshot: scripts/install.sh state.
import { readFileSync, statfsSync } from 'node:fs';
import { cpus, loadavg, release, uptime } from 'node:os';
import { join } from 'node:path';
import { pool, redis } from './db';

const dir = process.env.MAINTENANCE_DIR ?? '/maintenance';
const EVERY = 5_000, KEEP = 120;
type Sample = { at: number; cpu: number; iowait: number; memory: number; load: number };
const samples: Sample[] = [];
let last: { idle: number; iowait: number; total: number } | null = null;

function cpuTimes() {
  try {
    const f = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { idle: f[3] + (f[4] || 0), iowait: f[4] || 0, total: f.reduce((a, b) => a + b, 0) };
  } catch { return null; }
}
export function memory() {
  try {
    const m = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((x) => [x![1], Number(x![2]) * 1024]));
    const total = m.MemTotal ?? 0, available = m.MemAvailable ?? m.MemFree ?? 0;
    return { total, available, used: total - available, cached: (m.Cached ?? 0) + (m.Buffers ?? 0) + (m.SReclaimable ?? 0), swapTotal: m.SwapTotal ?? 0, swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0) };
  } catch { return null; }
}
function sample() {
  const now = cpuTimes(), mem = memory();
  if (now && last && now.total > last.total) {
    const span = now.total - last.total;
    samples.push({ at: Date.now(), cpu: Math.round((1 - (now.idle - last.idle) / span) * 1000) / 10, iowait: Math.round(((now.iowait - last.iowait) / span) * 1000) / 10,
      memory: mem && mem.total ? Math.round((mem.used / mem.total) * 1000) / 10 : 0, load: Math.round(loadavg()[0] * 100) / 100 });
    if (samples.length > KEEP) samples.shift();
  }
  last = now;
}
export function startHostLive() { sample(); setInterval(sample, EVERY).unref(); }

const disk = () => { try { const s = statfsSync(dir); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { return null; } };
export type HostState = { checkedAt: string; services: Record<string, unknown>[]; disks: Record<string, unknown>[]; [k: string]: unknown };
export const hostState = (): HostState | null => { try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as HostState; } catch { return null; } };

// The last lines of one service (or of the system journal) as the agent's snapshot recorded them.
export function hostLog(source: string, lines: number) {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(source)) return null;
  try { return readFileSync(join(dir, 'logs', `${source}.log`), 'utf8').split('\n').filter(Boolean).slice(-lines).map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}…` : l)); } catch { return null; }
}
export function logSources() {
  const state = hostState();
  const names = (state?.services ?? []).map((s) => String(s.service)).filter((n) => hostLog(n, 1) !== null);
  return [...names, ...(hostLog('system', 1) !== null ? ['system'] : [])];
}

export async function hostLive() {
  const list = cpus();
  const [db, connections, store] = await Promise.all([
    pool.query('SELECT pg_database_size(current_database())::float8 AS size').then((r) => Number(r.rows[0].size), () => null),
    pool.query(`SELECT count(*)::int AS open, current_setting('max_connections')::int AS max FROM pg_stat_activity`).then((r) => r.rows[0] as { open: number; max: number }, () => null),
    redis.info('memory').then((t) => { const m = /used_memory:(\d+)/.exec(t); return m ? Number(m[1]) : null; }, () => null),
  ]);
  const now = samples[samples.length - 1] ?? null;
  return { supported: !!last, sampledEvery: EVERY / 1000,
    cpu: { percent: now?.cpu ?? null, iowait: now?.iowait ?? null, cores: list.length, model: list[0]?.model?.replace(/\s+/g, ' ').trim() ?? '', load: loadavg().map((x) => Math.round(x * 100) / 100) },
    memory: memory(), disk: disk(), uptime: Math.round(uptime()), kernel: release(),
    history: samples.map((s) => ({ at: s.at, cpu: s.cpu, memory: s.memory, load: s.load })),
    panel: { apiMemory: process.memoryUsage().rss, apiUptime: Math.round(process.uptime()), node: process.version, databaseSize: db, connections, redisMemory: store },
    state: hostState(), logs: logSources() };
}
