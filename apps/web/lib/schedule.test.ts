import test from 'node:test';
import assert from 'node:assert/strict';
import { clashes, nextRun, sameJob } from './schedule.ts';

const z = 'Europe/Istanbul';
const at = (s: string) => new Date(s);
const sch = (time: string, days: number[], enabled = true, timezone = z) => ({ time, days, enabled, timezone });

test('the next run is the soonest enabled schedule in this zone', () => {
  const now = at('2026-11-03T10:00:00'); // a Tuesday
  const r = nextRun([sch('19:00', [1, 2, 3, 4, 5]), sch('08:00', [1, 2, 3, 4, 5])], z, now)!;
  assert.equal(r.s.time, '19:00');
  assert.equal(r.at.getDate(), 3);
});

test('a time already past today moves to the next listed day; weekend-only waits for Saturday', () => {
  const now = at('2026-11-03T20:00:00');
  assert.equal(nextRun([sch('19:00', [1, 2, 3, 4, 5])], z, now)!.at.getDate(), 4);
  assert.equal(nextRun([sch('09:00', [6, 7])], z, now)!.at.getDate(), 7);
});

test('disabled schedules and other zones are skipped', () => {
  const now = at('2026-11-03T10:00:00');
  assert.equal(nextRun([sch('19:00', [2], false), sch('19:00', [2], true, 'UTC')], z, now), null);
});

test('the same job is found whatever the order of its days', () => {
  const a = { action: 'shutdown', time: '19:00', timezone: 'Europe/Istanbul', days: [1, 2, 3] };
  assert.equal(sameJob(a, { ...a, days: [3, 1, 2] }), true);
  assert.equal(sameJob(a, { ...a, time: '19:30' }), false);
  assert.equal(sameJob(a, { ...a, action: 'power_on' }), false);
});

test('start and shutdown at the same minute on a shared day clash', () => {
  const z = 'UTC';
  const list = [{ action: 'power_on', time: '08:00', timezone: z, days: [1, 2, 6], enabled: true },
    { action: 'shutdown', time: '08:00', timezone: z, days: [2, 6, 7], enabled: true },
    { action: 'shutdown', time: '19:00', timezone: z, days: [1], enabled: true },
    { action: 'shutdown', time: '08:00', timezone: z, days: [1], enabled: false }];
  assert.deepEqual(clashes(list), [{ time: '08:00', days: [2, 6] }]);
});
