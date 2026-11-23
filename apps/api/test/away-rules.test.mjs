import test from 'node:test';
import assert from 'node:assert/strict';
import { awaySince, awaySummary, awayMax } from '../dist/away-rules.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const day = 86_400_000;

test('since the last "seen"; a first visit from the account\'s start; never more than 30 days back', () => {
  assert.equal(awaySince(new Date(now - 2 * day), new Date(now - 90 * day), now).getTime(), now - 2 * day);
  assert.equal(awaySince(null, new Date(now - 5 * day), now).getTime(), now - 5 * day);
  assert.equal(awaySince(null, new Date(now - 90 * day), now).getTime(), now - 30 * day);
  assert.equal(awaySince(new Date(now - 60 * day), new Date(now - 90 * day), now).getTime(), now - 30 * day);
});

test('notifications are put under finished, failed, billing and support; everything else is left out', () => {
  const rows = ['server.ready', 'server.failed', 'billing.overdue', 'support.reply', 'auth.sign_in', 'server.snapshot', 'billing.paid']
    .map((event, i) => ({ id: String(i), event, createdAt: new Date(now - i * 1000) }));
  const s = awaySummary(rows);
  assert.deepEqual(s.counts, { done: 2, failed: 1, billing: 1, support: 1 });
  assert.equal(s.total, 5);
  assert.deepEqual(s.items.map((x) => [x.event, x.kind]), [['server.ready', 'done'], ['server.failed', 'failed'], ['billing.overdue', 'billing'], ['support.reply', 'support'], ['server.snapshot', 'done']]);
});

test('the list stops at the newest ones; the counts still cover everything', () => {
  const rows = Array.from({ length: awayMax + 5 }, (_, i) => ({ id: String(i), event: 'server.ready', createdAt: new Date(now - i * 1000) }));
  const s = awaySummary(rows);
  assert.equal(s.items.length, awayMax);
  assert.equal(s.counts.done, awayMax + 5);
});
