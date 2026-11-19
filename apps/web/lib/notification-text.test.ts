import assert from 'node:assert/strict';
import test from 'node:test';
import { readableNotification, type Say } from './notification-text.ts';

const say: Say = {
  operation: (k) => ({ power_on: 'Açma', snapshot_revert: 'Anlık görüntüye dönme' } as Record<string, string>)[k] ?? null,
  failure: (c) => ({ SNAPSHOT_NOT_FOUND: 'Bu anlık görüntü artık yok.' } as Record<string, string>)[c] ?? null,
  priority: (p) => ({ high: 'Yüksek', normal: 'Normal' } as Record<string, string>)[p] ?? null,
  money: (n, c) => `${c} ${n.toFixed(2)}`,
  operationDone: (name, op) => `${name}: ${op} tamamlandı`,
  operationFailed: (op, reason) => `“${op}” işlemi tamamlanamadı: ${reason}`,
};

test('a finished power operation is named, in both languages the API writes', () => {
  assert.equal(readableNotification('server.power', { title: 'web-1: power_on tamamlandı', body: 'Güç işlemi tamamlandı.' }, say).title, 'web-1: Açma tamamlandı');
  assert.equal(readableNotification('server.power', { title: 'web-1: power_on done', body: '' }, say).title, 'web-1: Açma tamamlandı');
  // A server whose own name has a colon keeps it.
  assert.equal(readableNotification('server.power', { title: 'a: b: power_on done', body: '' }, say).title, 'a: b: Açma tamamlandı');
});

test('what the panel does not recognise is shown as it came', () => {
  const resize = { title: 'web-1: kaynaklar değiştirildi', body: 'İşlemci, bellek ve disk yeni değerlerinde.' };
  assert.deepEqual(readableNotification('server.power', resize, say), resize);
  const unknown = { title: 'web-1: warp_drive done', body: '' };
  assert.deepEqual(readableNotification('server.power', unknown, say), unknown);
  const other = { title: 'web-1: power_on done', body: '' };
  assert.deepEqual(readableNotification('server.ready', other, say), other);
});

test('a failed operation says what and why, without the code when the reason is known', () => {
  assert.equal(readableNotification('server.failed', { title: 'web-1: işlem başarısız', body: 'snapshot_revert işlemi tamamlanamadı (SNAPSHOT_NOT_FOUND).' }, say).body,
    '“Anlık görüntüye dönme” işlemi tamamlanamadı: Bu anlık görüntü artık yok.');
  assert.equal(readableNotification('server.failed', { title: 'x', body: 'The power_on operation could not finish (SOMETHING_NEW).' }, say).body,
    '“Açma” işlemi tamamlanamadı: SOMETHING_NEW');
});

test('staff: the operation is named and the code stays', () => {
  assert.equal(readableNotification('admin.operation_failed', { title: 'Operation failed: web-1', body: 'power_on · TIMEOUT · a@example.test' }, say).body, 'Açma · TIMEOUT · a@example.test');
});

test('a ticket priority is said in words', () => {
  assert.equal(readableNotification('support.ticket_created', { title: 'New support ticket #1002', body: 'Cannot reach my server · a@example.test · high' }, say).body, 'Cannot reach my server · a@example.test · Yüksek');
  // Only as the last part: a subject that ends in "high" without the separator is left alone.
  assert.equal(readableNotification('support.reply', { title: 't', body: 'load is high' }, say).body, 'load is high');
});

test('amounts are written as the panel writes money', () => {
  assert.equal(readableNotification('admin.billing_payment_review', { title: 'A payment waits for your decision: 120.00 TRY', body: 'Invoice · a@example.test' }, say).title, 'A payment waits for your decision: TRY 120.00');
  assert.equal(readableNotification('billing.low_balance', { title: 't', body: '0.5 EUR left to spend; about 12 more hours.' }, say).body, 'EUR 0.50 left to spend; about 12 more hours.');
  // Not an amount: part of a longer number or word, or another unit.
  for (const body of ['IP 10.0.0.120 TRYING', '22 GB disk', 'v1.2.30 USDT']) assert.equal(readableNotification('x', { title: '', body }, say).body, body);
});
