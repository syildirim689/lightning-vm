import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, localEnd, untilWarning, WARN_MS, warnNow } from './session-clock.ts';

test('the end is counted on this browser’s clock from when the answer arrived', () => {
  assert.equal(localEnd({ msLeft: 60_000 }, 1_000), 61_000);
  assert.equal(localEnd({ msLeft: -5 }, 1_000), 1_000);
});

test('the warning shows in the last five minutes, not before, not after the end', () => {
  const end = 10 * 60_000;
  assert.equal(WARN_MS, 300_000);
  assert.equal(warnNow(end, end - WARN_MS - 1, null), false);
  assert.equal(warnNow(end, end - WARN_MS, null), true);
  assert.equal(warnNow(end, end - 1, null), true);
  assert.equal(warnNow(end, end, null), false, 'over: the expired-session handling takes it from here');
});

test('putting the warning away holds for that end only; a new end warns again', () => {
  const end = 10 * 60_000;
  assert.equal(warnNow(end, end - 60_000, end), false);
  assert.equal(warnNow(end + 3_600_000, end + 3_600_000 - 60_000, end), true);
  // The next answer of /auth/me counts the same end a few hundred milliseconds apart: still put away.
  assert.equal(warnNow(end + 400, end - 60_000, end), false);
});

test('one timer until the warning is due', () => {
  assert.equal(untilWarning(10 * 60_000, 0), 5 * 60_000);
  assert.equal(untilWarning(10 * 60_000, 9 * 60_000), 0);
});

test('time left reads as minutes and seconds', () => {
  assert.equal(clock(299_001), '5:00');
  assert.equal(clock(245_000), '4:05');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(-10), '0:00');
});
