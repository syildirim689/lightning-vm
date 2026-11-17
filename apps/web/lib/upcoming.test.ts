import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueInvoices, nextRenewal, runOut, type UpcomingInvoice, type UpcomingSubscription } from './upcoming.ts';

const now = Date.parse('2026-11-17T10:00:00Z');
const sub = (over: Partial<UpcomingSubscription>): UpcomingSubscription => ({ id: 'a', serverId: 's1', description: 'web-1', amount: '100.00', currency: 'TRY', periodMonths: 1, status: 'active',
  periodEnd: '2026-12-01', cancelAtPeriodEnd: false, ...over });
const inv = (over: Partial<UpcomingInvoice>): UpcomingInvoice => ({ id: 'i1', number: 'LVM-1', kind: 'renewal', status: 'unpaid', currency: 'TRY', total: '120.00', paidTotal: '0', dueAt: '2026-11-20T00:00:00Z', overdue: false, ...over });

test('the next renewal is the earliest one that will really renew', () => {
  const r = nextRenewal([sub({ id: 'late', periodEnd: '2026-12-20' }), sub({ id: 'cancelled', periodEnd: '2026-11-18', cancelAtPeriodEnd: true }),
    sub({ id: 'ended', periodEnd: '2026-11-18', status: 'ended' }), sub({ id: 'pending', periodEnd: null, status: 'pending' }), sub({ id: 'next', periodEnd: '2026-11-25', description: 'db-1' })], now);
  assert.deepEqual(r, { at: '2026-11-25', currency: 'TRY', amount: 100, items: [{ id: 'next', serverId: 's1', description: 'db-1' }] });
});

test('servers renewing on the same day are one charge; other currencies and later days are not', () => {
  const r = nextRenewal([sub({ id: 'a', amount: '100.00' }), sub({ id: 'b', amount: '50.50', periodMonths: 3, description: 'db-1', serverId: 's2' }),
    sub({ id: 'eur', currency: 'EUR' }), sub({ id: 'later', periodEnd: '2026-12-02' })], now);
  assert.equal(r?.amount, 251.5);
  assert.deepEqual(r?.items.map((x) => x.id), ['a', 'b']);
});

test('a period that ends today counts, an older one does not, and nothing gives nothing', () => {
  assert.equal(nextRenewal([sub({ periodEnd: '2026-11-17' })], now)?.at, '2026-11-17');
  assert.equal(nextRenewal([sub({ periodEnd: '2026-11-10' })], now), null);
  assert.equal(nextRenewal([sub({ periodEnd: 'nonsense' })], now), null);
  assert.equal(nextRenewal([], now), null);
});

test('invoices: overdue ones and those due within seven days, most pressing first', () => {
  const list = dueInvoices([inv({ id: 'soon' }), inv({ id: 'far', dueAt: '2026-12-10T00:00:00Z' }), inv({ id: 'late', dueAt: '2026-11-01T00:00:00Z', overdue: true }),
    inv({ id: 'paid', status: 'paid' }), inv({ id: 'topup', kind: 'topup' }), inv({ id: 'edge', dueAt: '2026-11-24T10:00:00Z', total: '50.00', paidTotal: '20.00' })], now);
  assert.deepEqual(list.map((i) => i.id), ['late', 'soon', 'edge']);
  assert.equal(list[0].overdue, true);
  assert.equal(list[2].amount, 30);
  // Past its due time although the API's flag is older than the clock.
  assert.equal(dueInvoices([inv({ dueAt: '2026-11-17T09:00:00Z' })], now)[0].overdue, true);
  assert.deepEqual(dueInvoices([], now), []);
});

test('pay as you go: when the balance runs out, and when a top-up is worth offering', () => {
  const servers = [{}];
  const [a] = runOut({ servers, available: [{ currency: 'TRY', amount: '48.00', perHour: '2.0000' }] }, now);
  assert.equal(a.hours, 24);
  assert.equal(a.at, now + 24 * 3_600_000);
  assert.equal(a.soon, true);
  assert.equal(a.empty, false);
  const [b] = runOut({ servers, available: [{ currency: 'TRY', amount: '1000.00', perHour: '2.0000' }] }, now);
  assert.equal(b.soon, false);
  const [c] = runOut({ servers, available: [{ currency: 'TRY', amount: '-3.00', perHour: '2.0000' }] }, now);
  assert.deepEqual([c.hours, c.soon, c.empty, c.at], [0, true, true, now]);
  // No hourly server, or nothing being spent: no line.
  assert.deepEqual(runOut({ servers: [], available: [{ currency: 'TRY', amount: '5', perHour: '1' }] }, now), []);
  assert.deepEqual(runOut({ servers, available: [{ currency: 'TRY', amount: '5', perHour: '0.0000' }] }, now), []);
  assert.deepEqual(runOut(undefined, now), []);
});
