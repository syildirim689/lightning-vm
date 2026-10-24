// Right-sizing, the health score and this month's cost forecast.
import test from 'node:test';
import assert from 'node:assert/strict';

const { sizing, health, monthCost } = await import('../dist/smart-rules.js');
const week = { samples: 2000, days: 7 };

test('sizing waits for enough data, then finds idle, oversized and saturated servers', () => {
  assert.equal(sizing(4, null).advice, null);
  assert.equal(sizing(4, { avg: 1, p95: 2, samples: 10, days: 1 }).advice, null);
  assert.deepEqual(sizing(4, { avg: 1, p95: 3, ...week }), { advice: 'idle', suggestedVcpu: 1 });
  assert.deepEqual(sizing(8, { avg: 6, p95: 20, ...week }), { advice: 'down', suggestedVcpu: 3 });
  assert.equal(sizing(1, { avg: 6, p95: 20, ...week }).advice, null);
  assert.deepEqual(sizing(2, { avg: 70, p95: 95, ...week }), { advice: 'up', suggestedVcpu: 4 });
  assert.equal(sizing(4, { avg: 40, p95: 60, ...week }).advice, null);
});

test('health starts at 100 and each problem lowers it, with its reason', () => {
  const ok = { state: 'ready', powerState: 'poweredOn', abuseOpen: 0, failedOps24h: 0, cpuP95: 40, advice: null };
  assert.deepEqual(health(ok), { score: 100, grade: 'good', factors: [] });
  const bad = health({ ...ok, abuseOpen: 3, failedOps24h: 1, cpuP95: 97 });
  assert.equal(bad.score, 100 - 30 - 10 - 15);
  assert.equal(bad.grade, 'poor');
  assert.deepEqual(bad.factors.map((f) => f.code), ['ABUSE_OPEN', 'OPS_FAILED', 'CPU_SATURATED']);
  assert.equal(health({ ...ok, state: 'error' }).score, 40);
});

test('the month is prorated by the days each item exists', () => {
  const now = new Date(Date.UTC(2026, 3, 16)); // April: 30 days, 15 have passed
  const c = monthCost([{ price: 30, createdAt: new Date(Date.UTC(2026, 0, 1)) }, { price: 30, createdAt: new Date(Date.UTC(2026, 3, 11)) }], now);
  assert.deepEqual(c, { monthly: 60, accrued: 15 + 5, forecast: 30 + 20, daysLeft: 15 });
});
