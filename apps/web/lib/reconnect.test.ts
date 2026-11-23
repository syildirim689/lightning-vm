import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBack, MAX_RETRY_MS, retryDelay, secondsLeft } from './reconnect.ts';

test('retries back off from 2 s to at most 30 s and stay there', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(retryDelay), [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  assert.equal(retryDelay(-3), 2000);
  assert.equal(retryDelay(1e9), MAX_RETRY_MS);
});

test('the countdown is in whole seconds and never says zero while an attempt is due', () => {
  assert.equal(secondsLeft(10_000, 0), 10);
  assert.equal(secondsLeft(10_000, 9_100), 1);
  assert.equal(secondsLeft(10_000, 10_500), 1);
  assert.equal(secondsLeft(10_000, 2_001), 8);
});

test('only a healthy answer counts as back', () => {
  assert.equal(isBack(200), true);
  assert.equal(isBack(204), true);
  assert.equal(isBack(503), false, 'the API answered but cannot work (database down)');
  assert.equal(isBack(502), false);
  assert.equal(isBack(null), false, 'no answer at all');
});
