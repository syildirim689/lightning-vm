// The run locks (reconcile, energy sample, port scan): one run at a time, released only by its holder, never a throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withLock } from '../lock.mjs';

// SET key value EX n NX, and the release script (compare, then delete), like Redis answers them.
const fakeRedis = () => {
  const keys = new Map();
  return { keys,
    async set(key, value) { if (keys.has(key)) return null; keys.set(key, value); return 'OK'; },
    async eval(_script, _n, key, token) { if (keys.get(key) !== token) return 0; keys.delete(key); return 1; } };
};

test('a held lock skips the run; a finished run frees it', async () => {
  const redis = fakeRedis();
  let ran = 0;
  assert.equal(await withLock(redis, 'lock:x', 60, async () => { ran++; assert.equal(await withLock(redis, 'lock:x', 60, () => { ran += 10; }), false); }), true);
  assert.equal(ran, 1);
  assert.equal(redis.keys.size, 0);
});

test('a run that outlived its lock does not delete the lock of the copy that started after it', async () => {
  const redis = fakeRedis();
  await withLock(redis, 'lock:x', 1, async () => { redis.keys.set('lock:x', 'the-other-copy'); }); // expired and taken meanwhile
  assert.equal(redis.keys.get('lock:x'), 'the-other-copy');
});

test('a requested run waits for the one already running', async () => {
  const redis = fakeRedis();
  redis.keys.set('lock:x', 'busy');
  setTimeout(() => redis.keys.delete('lock:x'), 20);
  assert.equal(await withLock(redis, 'lock:x', 60, () => {}, { wait: true, pauseMs: 5 }), true);
});

test('a Redis error or a failing run is logged, never thrown (these start from timers)', async () => {
  const events = [];
  const log = (_level, event) => events.push(event);
  const down = { set: async () => { throw new Error('LOADING Redis is loading the dataset'); }, eval: async () => 0 };
  assert.equal(await withLock(down, 'lock:x', 60, () => assert.fail('must not run'), { log }), false);
  const flaky = { ...fakeRedis(), eval: async () => { throw new Error('READONLY'); } };
  assert.equal(await withLock(flaky, 'lock:x', 60, () => { throw new Error('boom'); }, { log }), true);
  assert.deepEqual(events, ['lock_failed', 'locked_run_failed', 'unlock_failed']);
});

test('an ISO copy stops only on an answer that shows another state, never on a failed progress update', async () => {
  const { copyStopped } = await import('../iso.mjs');
  assert.equal(copyStopped(null), false, 'the update failed: unknown, keep copying');
  assert.equal(copyStopped({ rows: [{ state: 'copying' }] }), false);
  assert.equal(copyStopped({ rows: [{ state: 'deleting' }] }), true);
  assert.equal(copyStopped({ rows: [] }), true, 'the row is gone');
});
