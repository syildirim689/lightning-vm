// One account's share of the operation slots (operations.mjs: ownerCap, admit): who is held, who never is, and that a
// held operation goes back to the queue untouched. PostgreSQL and the adapter are stand-ins (harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeAdapter, fakeDb, ids } from './harness.mjs';
import { admit, heldExtensionMs, heldHoursMax, holdDelayMs, ownerCap, processOperation } from '../operations.mjs';

const counts = (busy, ahead = 0) => [[/^SELECT count\(\*\) FILTER \(WHERE started_at IS NOT NULL\)/, () => [{ busy, ahead }]]];
const queued = { kind: 'power_on', capped_for: ids.owner, started_at: null, created_at: new Date('2026-11-18T10:00:00Z') };
// A queue's job: it can be put back with a delay.
const job = (db, moved) => ({ id: db.op.id, attemptsMade: 0, opts: { attempts: 6 }, moveToDelayed: async (at, token) => { moved.push({ at, token }); } });

test('the cap defaults to half of the slots, at least one; OPERATIONS_PER_OWNER sets it and 0 switches it off', () => {
  assert.equal(ownerCap({}), 4);
  assert.equal(ownerCap({ OPERATIONS_CONCURRENCY: '20' }), 10);
  assert.equal(ownerCap({ OPERATIONS_CONCURRENCY: '1' }), 1);
  assert.equal(ownerCap({ OPERATIONS_PER_OWNER: '2', OPERATIONS_CONCURRENCY: '20' }), 2);
  assert.equal(ownerCap({ OPERATIONS_PER_OWNER: '0' }), 0);
  assert.equal(ownerCap({ OPERATIONS_PER_OWNER: 'many' }), 4, 'an unreadable value is the default, not "no cap"');
  assert.equal(ownerCap({ OPERATIONS_PER_OWNER: '-1' }), 4);
});

test('a held operation asks again later the more of its account are ahead of it, at most every minute', () => {
  assert.equal(holdDelayMs(0, 4), 3000);
  assert.equal(holdDelayMs(3, 4), 3000);
  assert.equal(holdDelayMs(4, 4), 6000);
  assert.equal(holdDelayMs(500, 4), 60_000);
});

test('an account with its share under way: the next one is held, under the account lock, and nothing is marked running', async () => {
  const db = fakeDb({ op: queued, routes: counts(4, 2) });
  assert.deepEqual(await admit(db, db.op, 4), { held: 3000 });
  assert.equal(db.op.status, 'pending');
  // The one write of a hold: since when it waits (the deadline does not run meanwhile; the tests below).
  assert.deepEqual(db.log.map((q) => q.sql.split(/[ (]/)[0] + (q.sql.includes('pg_advisory_xact_lock') ? ' lock' : '')), ['BEGIN', 'SELECT lock', 'SELECT', 'UPDATE', 'COMMIT']);
  assert.match(db.ran(/^UPDATE/)[0].sql, /^UPDATE operations SET held_since = COALESCE\(held_since, now\(\)\) WHERE id = \$1 AND started_at IS NULL/);
  assert.deepEqual(db.ran(/pg_advisory_xact_lock/)[0].params, [ids.owner]);
  assert.deepEqual(db.ran(/^SELECT count/)[0].params.slice(0, 2), [ids.owner, ids.op], 'counted for its account, without itself');
});

test('below its share it starts, in the same transaction as the count', async () => {
  const db = fakeDb({ op: queued, routes: counts(3) });
  assert.deepEqual(await admit(db, db.op, 4), {});
  assert.equal(db.op.status, 'running');
  assert.deepEqual(db.log.map((q) => q.sql.split(/[ (]/)[0]), ['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'COMMIT']);
});

test('never held: staff and billing operations (no capped_for), one that has begun, one to be cancelled, and with the cap off', async () => {
  for (const [over, cap] of [[{ capped_for: null }, 4], [{ started_at: new Date() }, 4], [{ cancel_requested: true }, 4], [{}, 0]]) {
    const db = fakeDb({ op: { ...queued, ...over }, routes: counts(99) });
    assert.deepEqual(await admit(db, db.op, cap), {});
    assert.equal(db.op.status, 'running');
    assert.equal(db.ran(/^SELECT count/).length, 0, 'not even counted');
  }
});

test('a held operation is put back with a delay and its lock token: no step, no attempt, no adapter call', async () => {
  const db = fakeDb({ op: queued, routes: counts(4, 8) });
  const calls = fakeAdapter(() => ({})), moved = [], logged = [];
  const before = Date.now();
  await assert.rejects(processOperation(db, job(db, moved), (level, event, f) => logged.push({ event, ...f }), undefined, undefined, 'tok-1'), { name: 'DelayedError' });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].token, 'tok-1');
  assert.ok(moved[0].at >= before + 9000 && moved[0].at <= Date.now() + 9000, 'two rounds of its account are ahead: 9 seconds');
  assert.equal(db.op.status, 'pending');
  assert.equal(db.op.attempts, 0);
  assert.equal(calls.length, 0);
  // Nothing of the operation is written but since when it waits: no status, step, attempt or task.
  assert.deepEqual(db.ran(/^UPDATE/).map((q) => q.sql.split(' WHERE')[0]), ['UPDATE operations SET held_since = COALESCE(held_since, now())']);
  assert.deepEqual(logged.map((l) => l.event), ['operation_held_for_owner']);
});

test('with room it runs as before; a retry of one that has begun is not asked again', async () => {
  const db = fakeDb({ op: queued, server: { power_state: 'poweredOff' }, routes: counts(0) });
  fakeAdapter((path) => (path === '/v1/vm/find' ? { vm: { moref: 'vm-1', powerState: 'poweredOn', toolsRunning: true, ips: [] } } : {}));
  const moved = [];
  await processOperation(db, job(db, moved), () => {});
  assert.equal(db.op.status, 'succeeded');
  assert.equal(moved.length, 0);

  const resumed = fakeDb({ op: { ...queued, started_at: new Date(), attempts: 1 }, routes: counts(99) });
  await processOperation(resumed, job(resumed, moved), () => {});
  assert.equal(resumed.op.status, 'succeeded');
  assert.equal(moved.length, 0);
});

// The wait behind the account's share does not count against the operation's deadline (held_since, migration 087).
const holdMark = (expired) => [/^UPDATE operations SET held_since/, () => [{ expired }]];

test('the time held is given back to the deadline, within OPERATIONS_HELD_HOURS (default 6)', () => {
  assert.equal(heldHoursMax({}), 6);
  assert.equal(heldHoursMax({ OPERATIONS_HELD_HOURS: '2' }), 2);
  assert.equal(heldHoursMax({ OPERATIONS_HELD_HOURS: '0' }), 0, '0: the wait counts against the deadline, as before');
  assert.equal(heldHoursMax({ OPERATIONS_HELD_HOURS: 'long' }), 6);
  assert.equal(heldHoursMax({ OPERATIONS_HELD_HOURS: '-1' }), 6);
  const t = Date.parse('2026-11-19T10:00:00Z');
  assert.equal(heldExtensionMs(null, t, 6), 0, 'never held: nothing is added');
  assert.equal(heldExtensionMs(new Date(t - 20 * 60_000), t, 6), 20 * 60_000);
  assert.equal(heldExtensionMs(new Date(t - 9 * 3_600_000), t, 6), 6 * 3_600_000, 'never more than the bound');
  assert.equal(heldExtensionMs(new Date(t + 5000), t, 6), 0, 'a clock that went back adds nothing');
  assert.equal(heldExtensionMs(new Date(t - 3_600_000), t, 0), 0);
});

test('an operation that was held starts with its deadline moved on and the mark cleared; one never held starts as before', async () => {
  const held = fakeDb({ op: { ...queued, held_since: new Date(Date.now() - 600_000) }, routes: counts(1) });
  assert.deepEqual(await admit(held, held.op, 4, 6), {});
  assert.equal(held.op.status, 'running');
  const start = held.ran(/^UPDATE operations SET status = 'running'/)[0];
  assert.match(start.sql, /deadline_at = CASE WHEN started_at IS NULL AND held_since IS NOT NULL THEN deadline_at \+ LEAST\(GREATEST\(now\(\) - held_since, interval '0'\), \$2::float8 \* interval '1 hour'\) ELSE deadline_at END/);
  assert.match(start.sql, /held_since = NULL/);
  assert.deepEqual(start.params, [ids.op, 6]);

  const fresh = fakeDb({ op: queued, routes: counts(1) });
  await admit(fresh, fresh.op, 4, 6);
  assert.doesNotMatch(fresh.ran(/^UPDATE operations SET status = 'running'/)[0].sql, /deadline_at/, 'its deadline is not touched');
});

test('held again and again it keeps the first moment; once even the longest extension has passed it is let through to time out', async () => {
  const waiting = fakeDb({ op: { ...queued, held_since: new Date(Date.now() - 3_600_000) }, routes: [...counts(4, 1), holdMark(false)] });
  assert.deepEqual(await admit(waiting, waiting.op, 4, 6), { held: 3000 });
  assert.equal(waiting.op.status, 'pending');
  assert.deepEqual(waiting.ran(/^UPDATE operations SET held_since/)[0].params, [ids.op, 6], 'the bound is asked with the mark');

  // deadline + bound is over: no longer held, although its account is still at its share.
  const over = fakeDb({ op: { ...queued, held_since: new Date(Date.now() - 9 * 3_600_000), late: true }, routes: [...counts(4, 1), holdMark(true)] });
  assert.deepEqual(await admit(over, over.op, 4, 6), {});
  assert.equal(over.op.status, 'running');
  // ... and the deadline check ends it, for good, without a step or an adapter call.
  const db = fakeDb({ op: { ...queued, held_since: new Date(Date.now() - 9 * 3_600_000), late: true }, routes: [...counts(4, 1), holdMark(true)] });
  const calls = fakeAdapter(() => ({})), moved = [];
  await assert.rejects(processOperation(db, job(db, moved), () => {}, undefined, undefined, 'tok-2'), { name: 'UnrecoverableError', message: 'TIMEOUT' });
  assert.equal(moved.length, 0);
  assert.equal(db.op.status, 'failed');
  assert.equal(db.op.error_code, 'TIMEOUT');
  assert.equal(calls.length, 0);
});

test('with the cap switched off since, or a cancel asked for, an operation that was held still gets its time back', async () => {
  for (const [over, cap] of [[{}, 0], [{ cancel_requested: true }, 4]]) {
    const db = fakeDb({ op: { ...queued, held_since: new Date(Date.now() - 60_000), ...over }, routes: counts(99) });
    assert.deepEqual(await admit(db, db.op, cap, 6), {});
    assert.match(db.ran(/^UPDATE operations SET status = 'running'/)[0].sql, /held_since = NULL/);
  }
});
