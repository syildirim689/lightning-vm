import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionCount, badgeText, isAttentionKind, restoreHoldOf } from './attention.ts';

test('counts: absent keys and odd values are none', () => {
  assert.equal(attentionCount({ paymentsInReview: 3 }, 'review'), 3);
  assert.equal(attentionCount({ paymentsInReview: 3 }, 'failedOps'), 0);
  assert.equal(attentionCount({ failedOperations: 2, abuse: 7 }, 'abuse'), 7);
  assert.equal(attentionCount(undefined, 'abuse'), 0);
  assert.equal(attentionCount(null, 'review'), 0);
  assert.equal(attentionCount({ abuse: -1 }, 'abuse'), 0);
  assert.equal(attentionCount({ abuse: '4' as unknown as number }, 'abuse'), 4);
  assert.equal(attentionCount({ abuse: 'x' as unknown as number }, 'abuse'), 0);
});

test('badge text and kinds', () => {
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(isAttentionKind('review'), true);
  assert.equal(isAttentionKind('unpaid'), false);
  assert.equal(isAttentionKind('toString'), false);
});

test('restore hold: none, with and without a readable time', () => {
  assert.equal(restoreHoldOf(undefined), null);
  assert.equal(restoreHoldOf({}), null);
  assert.equal(restoreHoldOf({ restoreHold: null }), null);
  assert.deepEqual(restoreHoldOf({ restoreHold: { since: '2026-11-16T08:00:00Z', backup: 'daily-1.tar' } }), { since: new Date('2026-11-16T08:00:00Z'), backup: 'daily-1.tar' });
  assert.deepEqual(restoreHoldOf({ restoreHold: { since: 'soon', backup: null } }), { since: null, backup: null });
});
