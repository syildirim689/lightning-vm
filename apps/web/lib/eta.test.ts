import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLate, pickEstimate, sizeGroup, spoken, type Estimates } from './eta.ts';

const table: Estimates = {
  create: { all: { median: 150, p90: 400, n: 30 }, sizes: { s: { median: 100, p90: 160, n: 12 } } },
  resize: { all: null, sizes: { xl: { median: 900, p90: 1200, n: 5 } } },
};

test('the size group of the server decides the estimate, with the kind as a whole as the fallback', () => {
  assert.deepEqual(pickEstimate(table, 'create', 20), { e: { median: 100, p90: 160, n: 12 }, sized: true });
  assert.deepEqual(pickEstimate(table, 'create', 200), { e: { median: 150, p90: 400, n: 30 }, sized: false });
  assert.deepEqual(pickEstimate(table, 'create', null), { e: { median: 150, p90: 400, n: 30 }, sized: false });
});

test('too little history means no estimate at all, never a guess', () => {
  assert.equal(pickEstimate(table, 'resize', 20), null, 'no group and no kind-wide figure');
  assert.equal(pickEstimate(table, 'backup_create', 20), null, 'a kind the API had too few of');
  assert.equal(pickEstimate(undefined, 'create', 20), null, 'estimates not loaded (or an older API)');
  assert.equal(pickEstimate({}, 'create', 20), null);
});

test('size groups match the API', () => {
  assert.deepEqual([1, 40, 41, 100, 101, 300, 301].map(sizeGroup), ['s', 's', 'm', 'm', 'l', 'l', 'xl']);
  assert.equal(sizeGroup(0), null);
});

test('durations are said the way people say them', () => {
  assert.deepEqual(spoken(20), { unit: 'under' });
  assert.deepEqual(spoken(60), { unit: 'minutes', n: 1 });
  assert.deepEqual(spoken(150), { unit: 'minutes', n: 3 });
  assert.deepEqual(spoken(9 * 60 + 20), { unit: 'minutes', n: 9 });
  assert.deepEqual(spoken(23 * 60), { unit: 'minutes', n: 25 });
  assert.deepEqual(spoken(95 * 60), { unit: 'hours', n: 1.5 });
  assert.deepEqual(spoken(4 * 3600 + 100), { unit: 'hours', n: 4 });
});

test('longer than usual is past the slow runs and well past the median', () => {
  const e = { median: 100, p90: 160, n: 12 };
  assert.equal(isLate(e, 150), false);
  assert.equal(isLate(e, 160), false);
  assert.equal(isLate(e, 161), true);
  // A tight spread does not cry wolf a few seconds after the median.
  assert.equal(isLate({ median: 40, p90: 42, n: 9 }, 60), false);
  assert.equal(isLate({ median: 40, p90: 42, n: 9 }, 71), true);
});
