// The power schedule suggestion at its edges: no or short history, flat use, a single spike, hours never measured,
// a clock change, nights, weekends, and use around midnight.
import test from 'node:test';
import assert from 'node:assert/strict';

const { suggestSchedule, slotOf, idleSlots, scheduleRule } = await import('../dist/schedule-rules.js');

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse('2026-11-16T00:00:00Z'); // a Monday
// Four weeks of hourly rows; `busy(day, hour)` (local weekday 0 = Monday, local hour) says when the server works.
const history = (busy, { tz = 'UTC', days = 28, skip = () => false } = {}) => {
  const rows = [];
  for (let t = now - days * DAY; t < now; t += HOUR) {
    const slot = slotOf(t, tz), d = Math.floor(slot / 24), h = slot % 24;
    if (skip(d, h, t)) continue;
    rows.push(busy(d, h, t) ? { t, avg: 40, max: 80 } : { t, avg: 0.5, max: 2 });
  }
  return rows;
};
const office = (d, h) => d < 5 && h >= 8 && h < 18;

test('the hour of the week is the local one', () => {
  assert.equal(slotOf(Date.parse('2026-11-16T00:00:00Z'), 'UTC'), 0, 'Monday 00:00');
  assert.equal(slotOf(Date.parse('2026-11-16T00:00:00Z'), 'Europe/Istanbul'), 3, 'Monday 03:00 in Istanbul');
  assert.equal(slotOf(Date.parse('2026-11-15T23:00:00Z'), 'UTC'), 167, 'Sunday 23:00');
  assert.equal(slotOf(Date.parse('2026-11-16T04:30:00Z'), 'America/New_York'), 167, 'still Sunday evening in New York');
});

test('no history and a short history conclude nothing', () => {
  assert.deepEqual(suggestSchedule([], 'UTC', now), { enough: false, reason: 'not_enough_data', days: 0 });
  const short = suggestSchedule(history(office, { days: 14 }), 'UTC', now);
  assert.deepEqual(short, { enough: false, reason: 'not_enough_data', days: 14 });
  assert.equal(suggestSchedule(history(office, { days: 21 }), 'UTC', now).enough, true, `${scheduleRule.minDays} days are enough`);
});

test('office hours: off at night and over the weekend, with an hour to spare on each side', () => {
  const s = suggestSchedule(history(office), 'UTC', now);
  assert.deepEqual(s, { enough: true, reason: null, days: 28, idleHours: 168 - 50, kind: 'nightly', offHours: 168 - 5 * 12, schedules: [
    { action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '07:00' }] });
});

test('flat use, idle around the clock and use spread over the day suggest nothing', () => {
  assert.deepEqual(suggestSchedule(history(() => true), 'UTC', now), { enough: true, reason: 'no_window', days: 28, idleHours: 0 });
  assert.deepEqual(suggestSchedule(history(() => false), 'UTC', now), { enough: true, reason: 'always_idle', days: 28, idleHours: 168 });
  // In use every third hour: no stretch is long enough.
  assert.equal(suggestSchedule(history((d, h) => h % 3 === 0), 'UTC', now).reason, 'no_window');
});

test('a single spike in one week makes that hour "in use" for good; it does not undo the rest', () => {
  const spike = Date.parse('2026-11-04T02:00:00Z'); // a Wednesday night, once
  const s = suggestSchedule(history((d, h, t) => office(d, h) || t === spike), 'UTC', now);
  // 02:00 was in use once, so the night now ends before it: off from 19:00 to 01:00 instead of to 07:00.
  assert.deepEqual([s.kind, s.offHours, s.schedules], ['nightly', 168 - 5 * 18, [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '01:00' }]]);
  // Spikes at 21:00 and 02:00 leave no nightly stretch of six hours after the margins; what is left is the weekend,
  // from Friday evening to Monday morning.
  const second = Date.parse('2026-11-05T21:00:00Z');
  const w = suggestSchedule(history((d, h, t) => office(d, h) || t === spike || t === second), 'UTC', now);
  assert.deepEqual([w.kind, w.offHours, w.schedules], ['weekly', 60, [{ action: 'shutdown', days: [5], time: '19:00' }, { action: 'power_on', days: [1], time: '07:00' }]]);
});

test('hours never measured count as in use, not as idle', () => {
  // The server was switched off every night by hand: there are no samples for those hours.
  const s = suggestSchedule(history(office, { skip: (d, h) => h < 6 || h >= 20 }), 'UTC', now);
  assert.equal(s.enough, true);
  assert.equal(s.reason, 'no_window');
  // Two observations of an hour are fewer than the three needed.
  const idle = idleSlots(history(() => false, { days: 14 }), 'UTC');
  assert.equal(idle.filter(Boolean).length, 0);
});

test('busy day and night on weekdays, idle at the weekend: one weekly window', () => {
  const s = suggestSchedule(history((d) => d < 5), 'UTC', now);
  assert.deepEqual([s.kind, s.offHours, s.schedules], ['weekly', 46, [{ action: 'shutdown', days: [6], time: '01:00' }, { action: 'power_on', days: [7], time: '23:00' }]]);
});

test('use around midnight: the idle stretch is in the day, and the shutdown falls on the next morning', () => {
  // A nightly job window from 22:00 to 03:59 every day; idle from 04:00 to 21:59.
  const s = suggestSchedule(history((d, h) => h >= 22 || h < 4), 'UTC', now);
  assert.deepEqual([s.kind, s.offHours], ['nightly', 7 * 16]);
  assert.deepEqual(s.schedules, [{ action: 'shutdown', days: [1, 2, 3, 4, 5, 6, 7], time: '05:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5, 6, 7], time: '21:00' }]);
  // Only on working days: the job that starts on Friday evening ends on Saturday morning.
  const w = suggestSchedule(history((d, h) => (d < 5 && h >= 22) || (d >= 1 && d <= 5 && h < 4)), 'UTC', now);
  assert.deepEqual(w.schedules, [{ action: 'shutdown', days: [2, 3, 4, 5, 6], time: '05:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '21:00' }]);
});

test('a clock change inside the history does not move the suggestion', () => {
  // Berlin left summer time on 25 October 2026: the four weeks before 16 November contain it.
  const s = suggestSchedule(history(office, { tz: 'Europe/Berlin' }), 'Europe/Berlin', now);
  assert.deepEqual(s.schedules, [{ action: 'shutdown', days: [1, 2, 3, 4, 5], time: '19:00' }, { action: 'power_on', days: [1, 2, 3, 4, 5], time: '07:00' }]);
  // The same history read in another zone gives that zone's clock times.
  const ist = suggestSchedule(history(office), 'Europe/Istanbul', now);
  assert.deepEqual(ist.schedules.map((x) => x.time), ['22:00', '10:00']);
});
