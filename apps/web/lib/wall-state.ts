// Live walls: the panel's answers turned into what a scene shows. Every number, colour and motion on a wall comes
// from here, and here only from the API's answers: what is missing stays missing (null, "none"), what is old says
// since when (freshness), and a scene draws "stale" as dimmed and still instead of as alive. Pure, so it is tested.

export type Freshness = 'live' | 'stale' | 'missing';
export type Tone = 'ok' | 'warn' | 'bad' | 'none';
// An answer's age against how often it is asked for: late by more than two rounds (and a margin for a slow answer)
// means the wall no longer knows; never answered means it never knew.
export function freshness(okAt: number | null, now: number, every: number): Freshness {
  if (okAt === null) return 'missing';
  return now - okAt > every * 2 + 10_000 ? 'stale' : 'live';
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const toneOf = (p: number): Tone => (p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok');

// ---- System ---------------------------------------------------------------------------------------------------------
type Kind = 'running' | 'healthy' | 'starting' | 'completed' | 'unhealthy' | 'restarting' | 'failed' | 'stopped' | 'created' | 'paused';
export type LiveService = { service: string; state: string; kind: Kind; fault: boolean; oneShot?: boolean; cpu: number; restarts: number;
  version?: { panel: true; version: string } | { panel: false; tag: string; label: string; reported: string } };
export type Live = {
  supported: boolean; sampledEvery?: number;
  cpu: { percent: number | null; cores: number; load: number[] };
  memory: { total: number; used: number } | null; disk: { total: number; free: number } | null;
  history: { at: number; cpu: number; memory: number; load: number }[];
  state: { checkedAt: string; services: LiveService[]; disks?: { mount: string; total: number; used: number }[]; inodesPercent?: number; failedUnits?: unknown[] } | null;
  agent?: { installed: boolean; busy: boolean };
};
export type Worker = { healthy: boolean; last_seen: string };
// LED: what the unit's light does. A fault is told by more than its colour: it blinks fast and its unit stands out of
// the rack with a striped plate. A one-shot job that finished is a dim steady light, not a fault.
export type Led = 'steady' | 'activity' | 'slow' | 'fast' | 'dim' | 'off';
export type UnitState = { name: string; version: string; tone: Tone; led: Led; fault: boolean; kind: Kind; cpu: number; restarts: number };
export type Gauge = { key: 'cpu' | 'memory' | 'disk' | 'load'; value: number | null; level: number | null; tone: Tone };
export type SystemState = {
  freshness: Freshness; okAt: number | null;
  gauges: Gauge[]; cores: number | null;
  history: { at: number[]; cpu: number[]; memory: number[]; load: number[] }; // 0..1 of each gauge's full scale
  units: UnitState[]; unitsAt: number | null; unitsFreshness: Freshness; agent: 'on' | 'off' | 'unknown';
  api: 'up' | 'down' | 'unknown'; worker: 'running' | 'stale' | 'none' | 'unknown'; workerSeen: number | null;
  problems: number; verdict: Tone;
};

const ledOf = (kind: Kind, fault: boolean): Led => {
  if (fault) return kind === 'unhealthy' || kind === 'paused' || kind === 'created' ? 'slow' : 'fast';
  if (kind === 'completed') return 'dim';
  if (kind === 'starting') return 'slow';
  return kind === 'running' || kind === 'healthy' ? 'activity' : 'off';
};
export function versionLabel(v: LiveService['version']) {
  if (!v) return '';
  return v.panel ? v.version : v.reported || v.label || v.tag || '';
}
// The agent's snapshot is taken when Admin → System (or the wall) opens and on demand, not on a clock: older than an
// hour it is shown as stale.
export const SNAPSHOT_STALE = 3_600_000;

export function systemState(i: { live: Live | null; liveAt: number | null; ready: boolean | null; readyAt: number | null; workers: Worker[] | null; now: number; every?: number }): SystemState {
  const every = i.every ?? 5_000, d = i.live;
  const fresh = freshness(i.liveAt, i.now, every);
  const known = !!d && fresh !== 'missing';
  const cpu = known && d!.cpu.percent !== null ? d!.cpu.percent : null;
  const mem = known && d!.memory && d!.memory.total ? (d!.memory.used / d!.memory.total) * 100 : null;
  const disk = known && d!.disk && d!.disk.total ? ((d!.disk.total - d!.disk.free) / d!.disk.total) * 100 : null;
  const cores = known ? d!.cpu.cores || 1 : 1;
  const load = known && d!.supported && d!.cpu.load.length ? d!.cpu.load[0] : null;
  const loadPct = load === null ? null : (load / cores) * 100;
  const gauges: Gauge[] = [
    { key: 'cpu', value: cpu, level: cpu === null ? null : clamp01(cpu / 100), tone: cpu === null ? 'none' : toneOf(cpu) },
    { key: 'memory', value: mem, level: mem === null ? null : clamp01(mem / 100), tone: mem === null ? 'none' : toneOf(mem) },
    { key: 'disk', value: disk, level: disk === null ? null : clamp01(disk / 100), tone: disk === null ? 'none' : toneOf(disk) },
    // Load against the cores: a full scale of twice the cores; over the cores is a warning, over 1.5× a danger.
    { key: 'load', value: load, level: loadPct === null ? null : clamp01(loadPct / 200), tone: loadPct === null ? 'none' : loadPct >= 150 ? 'bad' : loadPct >= 100 ? 'warn' : 'ok' },
  ];
  const h = known ? d!.history : [];
  const history = { at: h.map((x) => x.at), cpu: h.map((x) => clamp01(x.cpu / 100)), memory: h.map((x) => clamp01(x.memory / 100)), load: h.map((x) => clamp01(x.load / cores / 2)) };

  const s = d?.state ?? null;
  const unitsAt = s ? Date.parse(s.checkedAt) : null;
  const unitsFreshness: Freshness = !s || unitsAt === null || Number.isNaN(unitsAt) ? 'missing' : i.now - unitsAt > SNAPSHOT_STALE ? 'stale' : 'live';
  const units: UnitState[] = (s?.services ?? []).map((x) => ({
    name: x.service, version: versionLabel(x.version), kind: x.kind, fault: x.fault, cpu: x.cpu ?? 0, restarts: x.restarts ?? 0,
    tone: x.fault ? (x.kind === 'unhealthy' || x.kind === 'paused' || x.kind === 'created' ? 'warn' : 'bad') : x.kind === 'completed' || x.kind === 'stopped' ? 'none' : 'ok',
    led: ledOf(x.kind, x.fault),
  }));

  const worker = i.workers?.find((w) => w.healthy) ?? null;
  const workerSeen = worker ? Date.parse(worker.last_seen) : null;
  const workerState = i.workers === null ? 'unknown' : !worker ? 'none' : i.now - workerSeen! > 120_000 ? 'stale' : 'running';
  const api = i.ready === null ? 'unknown' : freshness(i.readyAt, i.now, 15_000) === 'stale' ? 'unknown' : i.ready ? 'up' : 'down';

  // The same count as the "N warnings" chip of Admin → System (host-state.tsx).
  const faults = units.filter((u) => u.fault).length;
  const fullDisks = (s?.disks ?? []).filter((x) => x.total && x.used / x.total >= 0.9).length;
  const problems = (cpu !== null && cpu >= 90 ? 1 : 0) + (mem !== null && mem >= 90 ? 1 : 0) + (loadPct !== null && loadPct >= 150 ? 1 : 0)
    + fullDisks + ((s?.inodesPercent ?? 0) >= 90 ? 1 : 0) + faults + (s?.failedUnits?.length ?? 0);
  const severe = units.some((u) => u.fault && u.tone === 'bad') || (cpu ?? 0) >= 90 || (mem ?? 0) >= 90 || fullDisks > 0 || api === 'down';
  const verdict: Tone = fresh === 'missing' ? 'none' : severe ? 'bad' : problems || workerState === 'stale' || workerState === 'none' ? 'warn' : 'ok';
  return { freshness: fresh, okAt: i.liveAt, gauges, cores: known ? d!.cpu.cores || null : null, history, units, unitsAt: unitsFreshness === 'missing' ? null : unitsAt, unitsFreshness,
    agent: d?.agent ? (d.agent.installed ? 'on' : 'off') : 'unknown', api, worker: workerState, workerSeen, problems: problems + (api === 'down' ? 1 : 0), verdict };
}

// ---- Statistics -----------------------------------------------------------------------------------------------------
type Kpi = { value: number; change: number | null };
export type Stats = {
  days: number; unit: 'day' | 'week'; tz: string;
  kpis: { servers: Kpi; monthly: (Kpi & { currency: string }) | null; signups: Kpi & { total: number }; tickets: Kpi; successRate: { value: number | null; change: number | null } };
  series: { at: string; created: number; deleted: number; signups: number; ticketsOpened: number; ticketsClosed: number; opsOk: number; opsFailed: number }[];
  byLocation: { name: string; servers: number; vcpu: number }[];
};
export const statRows = ['created', 'deleted', 'signups', 'ticketsOpened', 'ticketsClosed', 'opsOk', 'opsFailed'] as const;
export type StatRow = typeof statRows[number];
export type StatsState = {
  freshness: Freshness; okAt: number | null; unit: 'day' | 'week' | null;
  at: string[];                                            // the buckets, oldest first
  rows: { key: StatRow; values: number[]; max: number; total: number; levels: number[] }[]; // levels: 0..1 of the row's own maximum
  locations: { name: string; servers: number; level: number }[];
};
export function statsState(s: Stats | null, okAt: number | null, now: number, every = 60_000): StatsState {
  const fresh = freshness(okAt, now, every);
  if (!s || fresh === 'missing') return { freshness: fresh, okAt, unit: null, at: [], rows: [], locations: [] };
  const rows = statRows.map((key) => {
    const values = s.series.map((p) => Math.max(0, Number(p[key]) || 0));
    const max = values.reduce((a, b) => Math.max(a, b), 0);
    return { key, values, max, total: values.reduce((a, b) => a + b, 0), levels: values.map((v) => (max ? v / max : 0)) };
  });
  const most = s.byLocation.reduce((a, l) => Math.max(a, l.servers), 0);
  return { freshness: fresh, okAt, unit: s.unit, at: s.series.map((p) => p.at), rows,
    locations: s.byLocation.slice(0, 8).map((l) => ({ name: l.name, servers: l.servers, level: most ? l.servers / most : 0 })) };
}

// ---- Energy ---------------------------------------------------------------------------------------------------------
export type Power = {
  settings: { currency: string; pue: number; pricePerKwh: string; co2GramsPerKwh: number };
  now: { watts: number; facilityWatts: number; hosts: number; measured: number };
  energy: { todayKwh: number; monthKwh: number; costToday: string; costMonth: string; co2MonthKg: number };
  series: { t: string; kwh: number; watts: number | null }[];
  hosts: { connectionId: string; connection: string; moref: string; name: string; watts: number | null; source: 'measured' | 'estimated'; cpuUtil: number | null; lastAt?: string | null }[];
  locations: { id: string; name: string; kwh: number }[];
};
// A host's newest sample older than this is not "now": the worker samples every five minutes (apps/worker/power.mjs),
// and the report's "now" takes the last fifteen.
export const POWER_STALE = 15 * 60_000;
export const MAX_FEEDS = 24;
export type Feed = { key: string; name: string; connection: string; watts: number; share: number; level: number; source: 'measured' | 'estimated'; live: boolean; lastAt: number | null };
export type EnergyState = {
  freshness: Freshness; okAt: number | null;
  watts: number | null; facilityWatts: number | null; pue: number | null; flowing: boolean; // flowing: a sample in the last 15 minutes
  feeds: Feed[]; others: { hosts: number; watts: number };
  hours: { t: string; watts: number; level: number }[];
  locations: { name: string; kwh: number; level: number }[];
};
export function energyState(r: Power | null, okAt: number | null, now: number, every = 60_000): EnergyState {
  const fresh = freshness(okAt, now, every);
  if (!r || fresh === 'missing') return { freshness: fresh, okAt, watts: null, facilityWatts: null, pue: null, flowing: false, feeds: [], others: { hosts: 0, watts: 0 }, hours: [], locations: [] };
  const flowing = r.now.hosts > 0;
  const all = r.hosts.map((h) => {
    const lastAt = h.lastAt ? Date.parse(h.lastAt) : null;
    // Without a time (an API before this field) a host counts as live when the report has a sample from the last 15 minutes.
    const live = lastAt !== null && !Number.isNaN(lastAt) ? now - lastAt <= POWER_STALE : flowing;
    return { key: `${h.connectionId}/${h.moref}`, name: h.name || h.moref, connection: h.connection, watts: live ? Math.max(0, h.watts ?? 0) : 0, source: h.source, live,
      lastAt: lastAt !== null && !Number.isNaN(lastAt) ? lastAt : null };
  }).sort((a, b) => b.watts - a.watts || a.name.localeCompare(b.name));
  const total = all.reduce((a, h) => a + h.watts, 0);
  const top = all.reduce((a, h) => Math.max(a, h.watts), 0);
  const shown = all.slice(0, MAX_FEEDS), rest = all.slice(MAX_FEEDS);
  const series = r.series.slice(-24).map((p) => ({ t: p.t, watts: Math.max(0, p.watts ?? 0) }));
  const peak = series.reduce((a, p) => Math.max(a, p.watts), 0);
  const most = r.locations.reduce((a, l) => Math.max(a, l.kwh), 0);
  return {
    freshness: fresh, okAt, watts: flowing ? r.now.watts : null, facilityWatts: flowing ? r.now.facilityWatts : null, pue: r.settings.pue, flowing,
    feeds: shown.map((h) => ({ ...h, share: total ? h.watts / total : 0, level: top ? h.watts / top : 0 })),
    others: { hosts: rest.length, watts: rest.reduce((a, h) => a + h.watts, 0) },
    hours: series.map((p) => ({ ...p, level: peak ? p.watts / peak : 0 })),
    locations: r.locations.slice(0, 8).map((l) => ({ name: l.name, kwh: l.kwh, level: most ? l.kwh / most : 0 })),
  };
}
