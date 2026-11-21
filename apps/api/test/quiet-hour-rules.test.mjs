// The quietest hours at their edges: no or short history, hours seen too rarely, a flat week, a tie, a stretch across
// midnight and across the end of the week, another time zone, and numbers that are not numbers.
import test from 'node:test';
import assert from 'node:assert/strict';

const { quietHours, weekProfile, quietRule } = await import('../dist/quiet-hour-rules.js');
const { slotOf } = await import('../dist/schedule-rules.js');

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse('2026-11-16T00:00:00Z'); // a Monday
// Hourly rows of `days` days; `load(day, hour)` (local weekday 0 = Monday, local hour) gives the busy vCPUs.
const history = (load, { tz = 'UTC', days = 28, skip = () => false, servers = 10 } = {}) => {
  const rows = [];
  for (let t = now - days * DAY; t < now; t += HOUR) {
    const slot = slotOf(t, tz), d = Math.floor(slot / 24), h = slot % 24;
    if (!skip(d, h, t)) rows.push({ t, load: load(d, h, t), servers });
  }
  return rows;
};
// Busy by day, quieter at night, quietest from 03:00 to 05:00; Sundays quieter still, least from 04:00 to 06:00.
const shop = (d, h) => (d === 6 && (h === 4 || h === 5) ? 0.1 : (h >= 9 && h < 21 ? 8 : h === 3 || h === 4 ? 1 : 3) * (d === 6 ? 0.5 : 1));

test('no history and a short history conclude nothing', () => {
  assert.deepEqual(quietHours([], 'UTC', now), { enough: false, days: 0 });
  assert.deepEqual(quietHours(history(shop, { days: 20 }), 'UTC', now), { enough: false, days: 20 });
  assert.equal(quietHours(history(shop, { days: 21 }), 'UTC', now).enough, true);
  // Older than the four weeks read: not history.
  assert.deepEqual(quietHours(history(shop).map((r) => ({ ...r, t: r.t - 40 * DAY })), 'UTC', now), { enough: false, days: 0 });
});

test('the quietest stretch of the week and of the day, with the numbers behind them', () => {
  const r = quietHours(history(shop), 'UTC', now);
  assert.equal(r.enough, true);
  assert.deepEqual([r.days, r.weeks, r.servers], [28, 4, 10]);
  assert.deepEqual([r.weekly.day, r.weekly.time, r.weekly.end, r.weekly.hours], [7, '04:00', '06:00', 2]);
  assert.ok(Math.abs(r.weekly.load - 0.1) < 1e-9, String(r.weekly.load));
  // Every day at the same time: 03:00-05:00 (1 on six days; on Sunday 0.5 and 0.1).
  assert.deepEqual([r.daily.time, r.daily.end, r.daily.hours], ['03:00', '05:00', 2]);
  assert.ok(Math.abs(r.daily.load - (6 * 1 + 0.3) / 7) < 1e-9, String(r.daily.load));
  assert.equal(r.daily.worst, 1);
  assert.equal(r.peak, 8);
  assert.ok(r.usual > r.daily.load && r.usual < r.peak);
});

test('the hours are the local ones of the zone asked for', () => {
  const r = quietHours(history(shop, { tz: 'Europe/Istanbul' }), 'Europe/Istanbul', now);
  assert.deepEqual([r.daily.time, r.weekly.day, r.weekly.time], ['03:00', 7, '04:00']);
  // The same rows read in UTC are three hours earlier.
  const utc = quietHours(history(shop, { tz: 'Europe/Istanbul' }), 'UTC', now);
  assert.deepEqual([utc.daily.time, utc.daily.end, utc.weekly.time], ['00:00', '02:00', '01:00']);
});

test('a stretch may cross midnight and the end of the week', () => {
  // Quiet only from 23:00 to 01:00.
  const night = quietHours(history((d, h) => (h === 23 || h === 0 ? 0.2 : 5)), 'UTC', now);
  assert.deepEqual([night.daily.time, night.daily.end], ['23:00', '01:00']);
  // Quiet only from Sunday 23:00 to Monday 01:00.
  const turn = quietHours(history((d, h) => ((d === 6 && h === 23) || (d === 0 && h === 0) ? 0.2 : 5)), 'UTC', now);
  assert.deepEqual([turn.weekly.day, turn.weekly.time, turn.weekly.end], [7, '23:00', '01:00']);
  assert.ok(Math.abs(turn.weekly.load - 0.2) < 1e-9);
});

test('a flat week gives the first stretch, every time', () => {
  const r = quietHours(history(() => 2), 'UTC', now);
  assert.deepEqual([r.weekly.day, r.weekly.time, r.daily.time, r.weekly.load, r.daily.load, r.daily.worst, r.usual, r.peak], [1, '00:00', '00:00', 2, 2, 2, 2, 2]);
  // Nothing in use at all is still an answer: zero is a measurement.
  assert.equal(quietHours(history(() => 0), 'UTC', now).weekly.load, 0);
});

test('an hour of the week seen in fewer than three weeks is not compared', () => {
  // The quietest hours by far were measured in two weeks only: they are not believed.
  const gap = (d, h, t) => (h === 3 || h === 4) && t < now - 14 * DAY;
  const rows = history(shop, { skip: gap });
  assert.equal(weekProfile(rows, 'UTC')[3].load, null);
  assert.equal(weekProfile(rows, 'UTC')[3].n, 2);
  const r = quietHours(rows, 'UTC', now);
  assert.notEqual(r.daily.time, '03:00');
  assert.ok(!['02:00', '03:00', '04:00'].includes(r.daily.time), r.daily.time); // no stretch touches the unseen hours
  // 22 days of history are enough to answer, but every hour was then seen three or four times only: still compared.
  assert.equal(quietHours(history(shop, { days: 22 }), 'UTC', now).daily.time, '03:00');
  // One hour of one day missing everywhere: no daily stretch can include it, the weekly one avoids it.
  const hole = quietHours(history(() => 1, { skip: (d, h) => d === 2 && h === 0 }), 'UTC', now);
  assert.deepEqual([hole.daily.time, hole.weekly.day, hole.weekly.time], ['01:00', 1, '00:00']);
});

test('when no stretch is seen often enough, both are null', () => {
  // Three weeks of history in which every other hour is missing: no two neighbouring hours are both known.
  const r = quietHours(history(() => 1, { skip: (d, h) => h % 2 === 1 }), 'UTC', now);
  assert.equal(r.enough, true);
  assert.deepEqual([r.weekly, r.daily], [null, null]);
});

test('rows that are not numbers are left out', () => {
  const rows = [...history(shop), { t: now - HOUR, load: NaN, servers: 1 }, { t: now - 2 * HOUR, load: -5, servers: 1 }, { t: now + HOUR, load: 0, servers: 1 }];
  const r = quietHours(rows, 'UTC', now);
  assert.deepEqual([r.daily.time, r.weekly.time], ['03:00', '04:00']);
  assert.equal(quietRule.hours, 2);
});

test('a clock change does not move the answer', () => {
  // Four weeks around the end of summer time in Berlin (25 October 2026): one local hour is seen twice that night.
  const end = Date.parse('2026-11-09T00:00:00Z');
  const rows = [];
  for (let t = end - 28 * DAY; t < end; t += HOUR) { const s = slotOf(t, 'Europe/Berlin'); rows.push({ t, load: shop(Math.floor(s / 24), s % 24), servers: 5 }); }
  const r = quietHours(rows, 'Europe/Berlin', end);
  assert.deepEqual([r.daily.time, r.weekly.day, r.weekly.time], ['03:00', 7, '04:00']);
});
