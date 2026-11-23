// How long an operation usually takes: median and 90th percentile of past ones, by kind and disk size, and nothing
// at all with too little history.
import test from 'node:test';
import assert from 'node:assert/strict';

const { estimate, estimates, sizeGroup, MIN_SAMPLES, MAX_SECONDS } = await import('../dist/eta-rules.js');

test('fewer than the minimum number of finished operations gives no estimate', () => {
  assert.equal(MIN_SAMPLES, 5);
  assert.equal(estimate([]), null);
  assert.equal(estimate([60, 70, 80, 90]), null);
  assert.deepEqual(estimate([60, 70, 80, 90, 100]), { median: 80, p90: 100, n: 5 });
});

test('the median of an even count is the middle pair, the 90th percentile is by nearest rank', () => {
  assert.deepEqual(estimate([10, 20, 30, 40, 50, 60]), { median: 35, p90: 60, n: 6 });
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((x) => x * 10);
  assert.deepEqual(estimate(ten), { median: 55, p90: 90, n: 10 });
});

test('runs that waited for something else, and nonsense values, are not durations', () => {
  assert.equal(estimate([60, 60, 60, 60, MAX_SECONDS + 1]), null);
  assert.equal(estimate([60, 60, 60, -1, Number.NaN]), null);
  assert.deepEqual(estimate([60, 60, 60, 60, 60, MAX_SECONDS + 1]), { median: 60, p90: 60, n: 5 });
});

test('disk sizes fall into four groups; no size means no group', () => {
  assert.deepEqual([20, 40, 41, 100, 101, 300, 301, 2000].map(sizeGroup), ['s', 's', 'm', 'm', 'l', 'l', 'xl', 'xl']);
  assert.equal(sizeGroup(null), null);
  assert.equal(sizeGroup(0), null);
  assert.equal(sizeGroup(undefined), null);
});

test('estimates are per kind and size group; a group with too little history is left out, the kind still counts', () => {
  const samples = [
    ...[100, 110, 120, 130, 140].map((seconds) => ({ kind: 'create', diskGb: 20, seconds })),
    ...[600, 700].map((seconds) => ({ kind: 'create', diskGb: 500, seconds })),
    ...[30, 40, 50].map((seconds) => ({ kind: 'resize', diskGb: 20, seconds })),
    { kind: 'power_on', diskGb: 20, seconds: 5 }, { kind: 'power_on', diskGb: 20, seconds: 5 }, { kind: 'power_on', diskGb: 20, seconds: 5 },
    { kind: 'power_on', diskGb: 20, seconds: 5 }, { kind: 'power_on', diskGb: 20, seconds: 5 },
  ];
  const e = estimates(samples);
  assert.deepEqual(e.create.sizes, { s: { median: 120, p90: 140, n: 5 } });
  assert.deepEqual(e.create.all, { median: 130, p90: 700, n: 7 });
  assert.equal(e.resize, undefined, 'three resizes are not enough');
  assert.equal(e.power_on, undefined, 'power actions get no estimate');
});
