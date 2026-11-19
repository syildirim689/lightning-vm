import test from 'node:test';
import assert from 'node:assert/strict';
import { isReview, payBlocked, paymentState, paymentTone, waitedFor, waitingSince } from './billing.ts';

test('paying is off while the invoice says a review blocks it, and no longer', () => {
  const now = Date.parse('2026-11-19T10:00:00Z');
  assert.equal(payBlocked({ payBlockedUntil: '2026-11-21T09:00:00.000Z' }, now), true);
  assert.equal(payBlocked({ payBlockedUntil: '2026-11-19T10:00:00.000Z' }, now), false, 'the window is over at that moment');
  assert.equal(payBlocked({ payBlockedUntil: '2026-11-19T09:59:59.000Z' }, now), false, 'a page left open past it');
  assert.equal(payBlocked({ payBlockedUntil: null }, now), false);
  assert.equal(payBlocked({}, now), false, 'an older API: the pay route still refuses');
});

test('a payment under review is told apart from one in progress', () => {
  assert.equal(isReview({ status: 'pending', errorCode: 'FRAUD_REVIEW', review: true }), true);
  assert.equal(isReview({ status: 'pending', errorCode: null, review: false }), false);
  // An older API sends no flag: the reason code decides.
  assert.equal(isReview({ status: 'pending', errorCode: 'AMOUNT_MISMATCH' }), true);
  assert.equal(isReview({ status: 'pending', errorCode: 'NEEDS_CONFIRMATION' }), true);
  assert.equal(isReview({ status: 'pending', errorCode: null }), false);
  assert.equal(isReview({ status: 'pending', errorCode: 'CARD_DECLINED' }), false);
  // Once it is settled either way it no longer waits, whatever the code says.
  assert.equal(isReview({ status: 'succeeded', errorCode: 'NEEDS_CONFIRMATION' }), false);
  assert.equal(isReview({ status: 'failed', errorCode: 'FRAUD_REVIEW', review: true }), false);
  assert.equal(paymentState({ status: 'pending', errorCode: 'FRAUD_REVIEW' }), 'review');
  assert.equal(paymentState({ status: 'pending', errorCode: null }), 'pending');
  assert.equal(paymentState({ status: 'refunded', errorCode: null }), 'refunded');
});

test('tones: review is a warning, not a failure', () => {
  assert.equal(paymentTone('review'), 'warning');
  assert.equal(paymentTone('pending'), 'warning');
  assert.equal(paymentTone('succeeded'), 'success');
  assert.equal(paymentTone('failed'), 'danger');
  assert.equal(paymentTone('refunded'), 'accent');
});

test('waiting time in the largest whole unit', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  assert.deepEqual(waitedFor('2026-11-17T11:59:40Z', now), { unit: 'minute', n: 0 });
  assert.deepEqual(waitedFor('2026-11-17T11:15:00Z', now), { unit: 'minute', n: 45 });
  assert.deepEqual(waitedFor('2026-11-17T11:00:00Z', now), { unit: 'hour', n: 1 });
  assert.deepEqual(waitedFor('2026-11-15T12:30:00Z', now), { unit: 'hour', n: 47 });
  assert.deepEqual(waitedFor('2026-11-15T12:00:00Z', now), { unit: 'day', n: 2 });
  assert.deepEqual(waitedFor('2026-11-07T09:00:00Z', now), { unit: 'day', n: 10 });
  // A clock a little ahead never gives a negative wait; an unreadable time gives none.
  assert.deepEqual(waitedFor('2026-11-17T12:00:30Z', now), { unit: 'minute', n: 0 });
  assert.equal(waitedFor('not a date', now), null);
  assert.equal(waitedFor(null, now), null);
});

test('since when: the time the API gives, else the payment itself', () => {
  assert.equal(waitingSince({ createdAt: 'a' }), 'a');
  assert.equal(waitingSince({ createdAt: 'a', since: 'b' }), 'b');
  assert.equal(waitingSince({ createdAt: 'a', since: 'b', reviewSince: 'c' }), 'c');
  assert.equal(waitingSince({ createdAt: 'a', since: null }), 'a');
});

test('a subscription says what kind of thing it is for, apart from its name', async () => {
  const { subscriptionName } = await import('./billing.ts');
  assert.deepEqual(subscriptionName('Sunucu web-1'), { kind: 'server', name: 'web-1' });
  assert.deepEqual(subscriptionName('Sanal veri merkezi E2E Renewal'), { kind: 'vdc', name: 'E2E Renewal' });
  // A server that is itself called "Sunucu" keeps its name; so does a description of another shape.
  assert.deepEqual(subscriptionName('Sunucu Sunucu'), { kind: 'server', name: 'Sunucu' });
  assert.deepEqual(subscriptionName('Yedekleme hizmeti'), { kind: null, name: 'Yedekleme hizmeti' });
  assert.deepEqual(subscriptionName('Sunucu'), { kind: null, name: 'Sunucu' });
});
