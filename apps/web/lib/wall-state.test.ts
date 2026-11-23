import test from 'node:test';
import assert from 'node:assert/strict';
import { energyState, freshness, POWER_STALE, SNAPSHOT_STALE, statsState, systemState, type Live, type LiveService, type Power, type Stats } from './wall-state.ts';

const now = Date.parse('2026-11-23T12:00:00Z');
const svc = (service: string, kind: LiveService['kind'], fault = false, over: Partial<LiveService> = {}): LiveService =>
  ({ service, state: kind === 'completed' ? 'exited' : 'running', kind, fault, cpu: 1.5, restarts: 0, version: { panel: true, version: 'v0.5.1' }, ...over });
const live = (over: Partial<Live> = {}): Live => ({
  supported: true, cpu: { percent: 42.5, cores: 4, load: [2, 1.5, 1] }, memory: { total: 8e9, used: 6e9 }, disk: { total: 100e9, free: 5e9 },
  history: [{ at: now - 10_000, cpu: 40, memory: 70, load: 2 }, { at: now - 5_000, cpu: 42.5, memory: 75, load: 2 }],
  state: { checkedAt: new Date(now - 60_000).toISOString(), services: [svc('api', 'healthy'), svc('migrate', 'completed', false, { cpu: 0 }), svc('worker', 'unhealthy', true), svc('grafana', 'failed', true)] },
  agent: { installed: true, busy: false }, ...over });

test('freshness: never answered, answered lately, late by more than two rounds', () => {
  assert.equal(freshness(null, now, 5_000), 'missing');
  assert.equal(freshness(now - 12_000, now, 5_000), 'live');
  assert.equal(freshness(now - 21_000, now, 5_000), 'stale');
});

test('system: gauges, history and units come from the answer; a fault is more than a colour', () => {
  const s = systemState({ live: live(), liveAt: now - 1_000, ready: true, readyAt: now - 1_000, workers: [{ healthy: true, last_seen: new Date(now - 5_000).toISOString() }], now });
  assert.equal(s.freshness, 'live');
  assert.deepEqual(s.gauges.map((g) => [g.key, g.value === null ? null : Math.round(g.value * 10) / 10, g.tone]), [['cpu', 42.5, 'ok'], ['memory', 75, 'warn'], ['disk', 95, 'bad'], ['load', 2, 'ok']]);
  assert.equal(s.gauges[3].level, 0.25); // load 2 on 4 cores: half the cores, a quarter of the scale (twice the cores)
  assert.deepEqual(s.history.cpu, [0.4, 0.425]);
  assert.deepEqual(s.units.map((u) => [u.name, u.led, u.tone, u.fault]), [['api', 'activity', 'ok', false], ['migrate', 'dim', 'none', false], ['worker', 'slow', 'warn', true], ['grafana', 'fast', 'bad', true]]);
  assert.equal(s.api, 'up');
  assert.equal(s.worker, 'running');
  // Two faulty services and the disk at 95 % on the services' list… the disk gauge is the API's data disk, the
  // count is the page's: faults plus full file systems in the snapshot (none listed here).
  assert.equal(s.problems, 2);
  assert.equal(s.verdict, 'bad');
});

test('system: a one-shot job that finished is not a fault, and all well is all well', () => {
  const s = systemState({ live: live({ disk: { total: 100e9, free: 60e9 }, memory: { total: 8e9, used: 2e9 }, state: { checkedAt: new Date(now).toISOString(), services: [svc('api', 'healthy'), svc('migrate', 'completed', false)] } }),
    liveAt: now, ready: true, readyAt: now, workers: [{ healthy: true, last_seen: new Date(now).toISOString() }], now });
  assert.equal(s.problems, 0);
  assert.equal(s.verdict, 'ok');
});

test('system: stale and missing are said, not drawn as alive', () => {
  const stale = systemState({ live: live(), liveAt: now - 60_000, ready: true, readyAt: now, workers: [], now });
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.okAt, now - 60_000);
  assert.equal(stale.worker, 'none');
  const missing = systemState({ live: null, liveAt: null, ready: null, readyAt: null, workers: null, now });
  assert.equal(missing.freshness, 'missing');
  assert.ok(missing.gauges.every((g) => g.value === null && g.level === null && g.tone === 'none'));
  assert.deepEqual([missing.units, missing.api, missing.worker, missing.verdict, missing.agent], [[], 'unknown', 'unknown', 'none', 'unknown']);
  // A host the API cannot read (not Linux): no processor, memory or load figure, not zeros.
  const blind = systemState({ live: live({ supported: false, cpu: { percent: null, cores: 8, load: [0, 0, 0] }, memory: null, history: [] }), liveAt: now, ready: true, readyAt: now, workers: [], now });
  assert.deepEqual(blind.gauges.map((g) => g.value === null), [true, true, false, true]);
  // An agent snapshot older than an hour.
  const old = systemState({ live: live({ state: { checkedAt: new Date(now - SNAPSHOT_STALE - 1).toISOString(), services: [svc('api', 'healthy')] } }), liveAt: now, ready: true, readyAt: now, workers: [], now });
  assert.equal(old.unitsFreshness, 'stale');
  // The API not ready is a problem of its own.
  const down = systemState({ live: live(), liveAt: now, ready: false, readyAt: now, workers: [], now });
  assert.equal(down.api, 'down');
});

const stats = (over: Partial<Stats> = {}): Stats => ({ days: 7, unit: 'day', tz: 'UTC',
  kpis: { servers: { value: 12, change: 20 }, monthly: { value: 340, change: 5, currency: 'EUR' }, signups: { value: 4, change: null, total: 30 }, tickets: { value: 2, change: 0 }, successRate: { value: 98.5, change: 1 } },
  series: [{ at: '2026-11-21', created: 2, deleted: 0, signups: 1, ticketsOpened: 0, ticketsClosed: 0, opsOk: 10, opsFailed: 1 }, { at: '2026-11-22', created: 4, deleted: 1, signups: 0, ticketsOpened: 3, ticketsClosed: 1, opsOk: 20, opsFailed: 0 }],
  byLocation: [{ name: 'Istanbul', servers: 8, vcpu: 16 }, { name: 'Frankfurt', servers: 2, vcpu: 4 }], ...over });

test('statistics: each row against its own maximum; an empty row stays flat', () => {
  const s = statsState(stats(), now, now);
  assert.deepEqual(s.at, ['2026-11-21', '2026-11-22']);
  const row = (k: string) => s.rows.find((r) => r.key === k)!;
  assert.deepEqual(row('created').levels, [0.5, 1]);
  assert.equal(row('created').total, 6);
  assert.deepEqual(row('ticketsClosed').levels, [0, 1]);
  assert.deepEqual(statsState(stats({ series: [{ at: '2026-11-22', created: 0, deleted: 0, signups: 0, ticketsOpened: 0, ticketsClosed: 0, opsOk: 0, opsFailed: 0 }] }), now, now).rows[0].levels, [0]);
  assert.deepEqual(s.locations.map((l) => [l.name, l.level]), [['Istanbul', 1], ['Frankfurt', 0.25]]);
  assert.equal(statsState(null, null, now).freshness, 'missing');
  assert.equal(statsState(stats(), now - 300_000, now).freshness, 'stale');
});

const power = (over: Partial<Power> = {}): Power => ({ settings: { currency: 'EUR', pue: 1.4, pricePerKwh: '0.2', co2GramsPerKwh: 400 },
  now: { watts: 900, facilityWatts: 1260, hosts: 3, measured: 1 },
  energy: { todayKwh: 10, monthKwh: 300, costToday: '2.8', costMonth: '84', co2MonthKg: 168 },
  series: [{ t: '2026-11-23T10:00:00Z', kwh: 0.8, watts: 800 }, { t: '2026-11-23T11:00:00Z', kwh: 0.9, watts: 900 }],
  hosts: [
    { connectionId: 'c', connection: 'vc', moref: 'host-1', name: 'esx-01', watts: 500, source: 'measured', cpuUtil: 40, lastAt: new Date(now - 60_000).toISOString() },
    { connectionId: 'c', connection: 'vc', moref: 'host-2', name: 'esx-02', watts: 300, source: 'estimated', cpuUtil: 20, lastAt: new Date(now - 60_000).toISOString() },
    { connectionId: 'c', connection: 'vc', moref: 'host-3', name: 'esx-03', watts: 100, source: 'estimated', cpuUtil: 5, lastAt: new Date(now - POWER_STALE - 60_000).toISOString() },
  ],
  locations: [{ id: 'l', name: 'Istanbul', kwh: 10 }], ...over });

test('energy: each feed scaled by its real watts; a host without a recent sample carries nothing', () => {
  const e = energyState(power(), now, now);
  assert.equal(e.flowing, true);
  assert.equal(e.watts, 900);
  assert.deepEqual(e.feeds.map((f) => [f.name, f.watts, f.live, f.source]), [['esx-01', 500, true, 'measured'], ['esx-02', 300, true, 'estimated'], ['esx-03', 0, false, 'estimated']]);
  assert.equal(e.feeds[0].level, 1);
  assert.equal(e.feeds[1].share, 300 / 800);
  assert.deepEqual(e.hours.map((h) => h.level), [800 / 900, 1]);
});

test('energy: no sample in fifteen minutes is no flow, and no answer is no figure', () => {
  const e = energyState(power({ now: { watts: 0, facilityWatts: 0, hosts: 0, measured: 0 }, hosts: power().hosts.map((h) => ({ ...h, lastAt: null })) }), now, now);
  assert.equal(e.flowing, false);
  assert.equal(e.watts, null);
  assert.ok(e.feeds.every((f) => !f.live && f.watts === 0));
  const none = energyState(null, null, now);
  assert.deepEqual([none.freshness, none.watts, none.feeds.length], ['missing', null, 0]);
  // More hosts than feeds: the rest are summed, not dropped.
  const many = energyState(power({ hosts: Array.from({ length: 30 }, (_, i) => ({ connectionId: 'c', connection: 'vc', moref: `h${i}`, name: `esx-${i}`, watts: 100 + i, source: 'measured' as const, cpuUtil: null, lastAt: new Date(now).toISOString() })) }), now, now);
  assert.equal(many.feeds.length, 24);
  assert.equal(many.others.hosts, 6);
  assert.equal(many.others.watts, 100 + 101 + 102 + 103 + 104 + 105);
});
