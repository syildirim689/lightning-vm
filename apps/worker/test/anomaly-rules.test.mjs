// The usage anomaly rules at their edges: no history, flat use, a single spike, a clock change, the two thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { abuseHint, cpuAnomaly, cpuRule, median, spread, trafficAnomaly, trafficRule, HOUR, DAY } from '../anomaly-rules.mjs';

const now = Date.parse('2026-11-18T14:20:00Z'); // the hour in progress is 14:00; judged are 11:00, 12:00 and 13:00
const end = Date.parse('2026-11-18T14:00:00Z');
// `days` whole days of hourly averages before the window, then the window itself.
const history = (days, usual, recent, { wobble = 0 } = {}) => {
  const hours = [];
  for (let t = end - days * DAY; t < end - 3 * HOUR; t += HOUR) hours.push({ t, v: usual + (wobble ? ((t / HOUR) % 3 - 1) * wobble : 0) });
  recent.forEach((v, i) => { if (v !== null) hours.push({ t: end - (3 - i) * HOUR, v }); });
  return hours;
};

test('median and spread', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(spread([5, 5, 5, 5]), 0);
  assert.equal(Math.round(spread([1, 2, 3, 4, 100]) * 100) / 100, 1.48, 'one wild value does not widen it');
});

test('CPU: nothing is concluded without enough history', () => {
  assert.deepEqual(cpuAnomaly([], now), { enough: false, state: null, recent: null, usual: null, scale: null, z: null, baseline: 0, days: 0 });
  const three = cpuAnomaly(history(3, 10, [95, 95, 95]), now);
  assert.equal(three.enough, false, `three earlier days are fewer than ${cpuRule.minDays}`);
  assert.equal(three.state, null);
  assert.equal(cpuAnomaly(history(5, 10, [95, 95, 95]), now).state, 'high', 'five days are enough');
  // The window itself without samples (the server was off): nothing to judge.
  assert.equal(cpuAnomaly(history(10, 10, [null, null, 95]), now).enough, false);
});

test('CPU: flat use is not an anomaly, a real departure is, and says its numbers', () => {
  assert.equal(cpuAnomaly(history(10, 10, [10, 10, 10]), now).state, null);
  assert.equal(cpuAnomaly(history(10, 10, [24, 25, 26]), now).state, null, 'a rise of 15 points on a flat baseline stays below the 20 needed');
  const r = cpuAnomaly(history(10, 10, [80, 90, 85]), now);
  // 46: five hours of the day (10:00 to 14:59) on nine whole earlier days, and the one hour the tenth still has.
  assert.deepEqual(r, { enough: true, state: 'high', recent: 85, usual: 10, scale: 5, z: 15, baseline: 46, days: 10 });
  // A baseline that itself moves a lot needs a larger departure: the same rise is nothing unusual there.
  assert.equal(cpuAnomaly(history(10, 40, [70, 70, 70], { wobble: 25 }), now).state, null);
});

test('CPU: one spike hour is not a finding; two of three are', () => {
  assert.equal(cpuAnomaly(history(10, 10, [10, 100, 10]), now).state, null);
  assert.equal(cpuAnomaly(history(10, 10, [10, 100, 100]), now).state, 'high');
  // A spike in the history does not hide a later departure (the median ignores it).
  const spiky = history(10, 10, [90, 90, 90]);
  spiky.find((h) => h.t === end - DAY - 2 * HOUR).v = 100;
  assert.equal(cpuAnomaly(spiky, now).usual, 10);
  assert.equal(cpuAnomaly(spiky, now).state, 'high');
});

test('CPU: an open finding closes later than a new one would open', () => {
  const between = history(10, 10, [26, 26, 26]); // 16 points and z 3.2: between the two thresholds
  assert.equal(cpuAnomaly(between, now, null).state, null, 'does not open');
  assert.equal(cpuAnomaly(between, now, 'high').state, 'high', 'stays open');
  assert.equal(cpuAnomaly(history(10, 10, [18, 18, 18]), now, 'high').state, null, 'closes below 10 points');
});

test('CPU: a usually busy server that went quiet', () => {
  assert.equal(cpuAnomaly(history(10, 60, [5, 5, 5]), now).state, 'low');
  assert.equal(cpuAnomaly(history(10, 10, [0, 0, 0]), now).state, null, `a server usually below ${cpuRule.lowBaseline}% is never called quiet`);
  assert.equal(cpuAnomaly(history(10, 60, [20, 20, 20]), now, null).state, null);
  assert.equal(cpuAnomaly(history(10, 60, [20, 20, 20]), now, 'low').state, 'low', 'stays until half the usual is back');
  assert.equal(cpuAnomaly(history(10, 60, [31, 31, 31]), now, 'low').state, null);
});

test('CPU: a daily pattern is compared with the same time of day, and survives a clock change', () => {
  // Busy every day from 11:00 to 13:59 UTC (a nightly job, a working day), idle otherwise.
  const daily = (shift) => {
    const hours = [];
    for (let t = end - 10 * DAY; t < end; t += HOUR) {
      const hod = (t / HOUR) % 24;
      // The last two days run one hour later (the local clock changed).
      const s = t >= end - 2 * DAY ? shift : 0;
      hours.push({ t, v: hod >= 11 + s && hod < 14 + s ? 80 : 5 });
    }
    return hours;
  };
  assert.equal(cpuAnomaly(daily(0), now).state, null, 'busy now, as every day at this time');
  assert.equal(cpuAnomaly(daily(0), now).usual, 80);
  assert.equal(cpuAnomaly(daily(1), now).state, null, 'the pattern moved by one hour: still usual');
  // The same load at a time of day that is always idle is a finding.
  const night = daily(0).map((h) => (h.t >= end - 3 * HOUR ? h : h)).map((h) => ({ ...h }));
  const at = Date.parse('2026-11-18T05:20:00Z');
  for (const h of night) if (h.t >= Date.parse('2026-11-18T02:00:00Z') && h.t < Date.parse('2026-11-18T05:00:00Z')) h.v = 80;
  assert.equal(cpuAnomaly(night.filter((h) => h.t < Date.parse('2026-11-18T05:00:00Z')), at).state, 'high');
});

const GiB = 1024 ** 3;
const traffic = (n, usual, yesterday, today, share = 0.5) => {
  const days = [];
  const t0 = Date.parse('2026-11-18T00:00:00Z');
  for (let i = n + 1; i >= 2; i--) days.push({ day: new Date(t0 - i * DAY).toISOString().slice(0, 10), rx: usual / 2, tx: usual / 2 });
  if (yesterday !== null) days.push({ day: '2026-11-17', rx: yesterday * (1 - share), tx: yesterday * share });
  if (today !== null) days.push({ day: '2026-11-18', rx: today * (1 - share), tx: today * share });
  return days;
};

test('network: no history, a short history and a quiet server conclude nothing', () => {
  assert.equal(trafficAnomaly([], '2026-11-18').enough, false);
  assert.equal(trafficAnomaly(traffic(6, 2 * GiB, 50 * GiB, 0), '2026-11-18').enough, false, `six days are fewer than ${trafficRule.minDays}`);
  assert.equal(trafficAnomaly(traffic(14, 0.1 * GiB, 3 * GiB, 0), '2026-11-18').state, null, 'thirty times the usual, but under the 5 GiB floor');
  assert.equal(trafficAnomaly(traffic(14, 10 * GiB, 10 * GiB, 4 * GiB), '2026-11-18').state, null, 'flat');
});

test('network: a day far above the usual, judged on today so far or yesterday, with the outbound share', () => {
  const y = trafficAnomaly(traffic(14, 10 * GiB, 80 * GiB, 1 * GiB, 0.95), '2026-11-18');
  assert.equal(y.state, 'high');
  assert.deepEqual([y.day, y.usual, y.baseline, y.outShare], ['2026-11-17', 10 * GiB, 14, 0.95]);
  const t = trafficAnomaly(traffic(14, 10 * GiB, 10 * GiB, 60 * GiB), '2026-11-18');
  assert.deepEqual([t.state, t.day], ['high', '2026-11-18'], 'today is already too much');
  assert.equal(trafficAnomaly(traffic(14, 10 * GiB, 25 * GiB, 0), '2026-11-18').state, null, 'two and a half times the usual does not open');
  assert.equal(trafficAnomaly(traffic(14, 10 * GiB, 25 * GiB, 0), '2026-11-18', 'high').state, 'high', 'but keeps an open one');
  assert.equal(trafficAnomaly(traffic(14, 10 * GiB, 12 * GiB, 0), '2026-11-18', 'high').state, null);
});

test('what a finding resembles, for staff', () => {
  assert.equal(abuseHint('cpu', 'high', { recent: 97 }), 'cpu_pinned');
  assert.equal(abuseHint('cpu', 'high', { recent: 70 }), null);
  assert.equal(abuseHint('cpu', 'low', { recent: 0 }), null);
  assert.equal(abuseHint('network', 'high', { outShare: 0.93 }), 'outbound');
  assert.equal(abuseHint('network', 'high', { outShare: 0.5 }), null);
});
