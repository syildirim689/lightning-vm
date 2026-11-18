import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupRuns, type Groupable } from './notification-groups.ts';

let seq = 0;
const n = (over: Partial<Groupable>): Groupable => ({ id: `n${++seq}`, event: 'support.reply', link: '/support/t1', createdAt: '2026-11-18T10:00:00Z', readAt: null, ...over });

test('neighbours with the same event and link become one row: the newest shown, all counted', () => {
  const list = [n({ id: 'c', createdAt: '2026-11-18T10:03:00Z' }), n({ id: 'b', createdAt: '2026-11-18T10:02:00Z', readAt: '2026-11-18T10:02:30Z' }), n({ id: 'a', createdAt: '2026-11-18T10:01:00Z' })];
  const [g, ...rest] = groupRuns(list);
  assert.equal(rest.length, 0);
  assert.equal(g.latest.id, 'c');
  assert.deepEqual(g.items.map((x) => x.id), ['c', 'b', 'a']);
  // Marking the row read sends every unread one in it, and only those.
  assert.deepEqual(g.unread, ['c', 'a']);
  // Named after the oldest, so a newer arrival does not rename (and so close) an opened row.
  assert.equal(g.key, 'a');
  assert.equal(groupRuns([n({ id: 'd' }), ...list])[0].key, 'a');
});

test('another event, another subject or something in between starts a new row', () => {
  const list = [n({ id: '1' }), n({ id: '2', link: '/support/t2' }), n({ id: '3', link: '/support/t2', event: 'support.closed' }),
    n({ id: '4' }), n({ id: '5', event: 'server.ready', link: '/servers/s1' }), n({ id: '6' })];
  assert.deepEqual(groupRuns(list).map((g) => g.items.map((x) => x.id)), [['1'], ['2'], ['3'], ['4'], ['5'], ['6']]);
});

test('without a link there is no subject to compare: each stays alone', () => {
  const list = [n({ id: '1', link: null, event: 'auth.signin' }), n({ id: '2', link: null, event: 'auth.signin' }), n({ id: '3', link: '', event: 'auth.signin' })];
  assert.equal(groupRuns(list).length, 3);
});

test('a run does not cross a bucket (the day heading)', () => {
  const day = (x: Groupable) => x.createdAt.slice(0, 10);
  const list = [n({ id: '1', createdAt: '2026-11-18T09:00:00Z' }), n({ id: '2', createdAt: '2026-11-18T08:00:00Z' }), n({ id: '3', createdAt: '2026-11-17T23:00:00Z' })];
  assert.deepEqual(groupRuns(list, day).map((g) => g.items.length), [2, 1]);
  assert.deepEqual(groupRuns(list).map((g) => g.items.length), [3]);
});

test('read rows have nothing to mark; an empty inbox gives no rows; the input is left alone', () => {
  const list = [n({ id: '1', readAt: 'x' }), n({ id: '2', readAt: 'x' })];
  const copy = structuredClone(list);
  assert.deepEqual(groupRuns(list)[0].unread, []);
  assert.deepEqual(list, copy);
  assert.deepEqual(groupRuns([]), []);
});
