import test from 'node:test';
import assert from 'node:assert/strict';

const r = await import('../dist/billing-rules.js');

test('money stays in cents; lines round per line; tax-inclusive prices are split', () => {
  assert.equal(r.toCents('12.5'), 1250);
  assert.equal(r.toCents('0,99'), 99);
  assert.equal(r.toCents(19.99), 1999);
  assert.throws(() => r.toCents('1.234'));
  assert.equal(r.fromCents(123456), '1234.56');
  assert.equal(r.fromCents(-5), '-0.05');
  assert.deepEqual(r.lineAmounts(10000, 1, 20), { net: 10000, tax: 2000, gross: 12000 });
  assert.deepEqual(r.lineAmounts(12000, 1, 20, true), { net: 10000, tax: 2000, gross: 12000 });
  assert.deepEqual(r.lineAmounts(333, 3, 20), { net: 999, tax: 200, gross: 1199 });
  assert.deepEqual(r.totals([{ net: 1, tax: 2, gross: 3 }, { net: 10, tax: 20, gross: 30 }]), { net: 11, tax: 22, gross: 33 });
});

test('invoice numbers follow the GİB format; identity and tax numbers are checked', () => {
  assert.equal(r.invoiceNumber('LVM', 2026, 1), 'LVM2026000000001');
  assert.equal(r.invoiceNumber('LVM', 2026, 1).length, 16);
  assert.equal(r.validPrefix('LV1'), true);
  assert.equal(r.validPrefix('lvm'), false);
  assert.equal(r.validTckn('10000000146'), true);
  assert.equal(r.validTckn('10000000147'), false);
  assert.equal(r.validTckn('01234567890'), false);
  assert.equal(r.validVkn('1234567890'), true);
  assert.equal(r.validVkn('1234567891'), false);
  assert.equal(r.validVkn('0010000001'), false);
  // A VKN whose check digit is computed from its first nine digits passes, any other last digit fails.
  const base = '123456789';
  const good = [...Array(10).keys()].map((d) => base + d).filter(r.validVkn);
  assert.equal(good.length, 1);
});

test('a billing profile: TCKN for people, VKN and tax office for companies in Turkey, address always', () => {
  const ok = r.cleanProfile({ kind: 'individual', name: 'Ayşe Yılmaz', taxId: '10000000146', city: 'İstanbul', district: 'Kadıköy', address: 'Moda Cd. 1' });
  assert.equal(ok.profile.country, 'TR');
  assert.deepEqual(r.cleanProfile({ kind: 'company', name: 'X', taxId: '1', address: '' }).fields,
    { name: 'REQUIRED', taxId: 'INVALID_VKN', taxOffice: 'REQUIRED', city: 'REQUIRED', district: 'REQUIRED', address: 'REQUIRED' });
  assert.ok(r.cleanProfile({ kind: 'company', name: 'ACME GmbH', taxId: 'DE123456789', country: 'de', address: 'Berlin' }).profile);
  assert.deepEqual(r.taxFor('DE', { taxRate: 20, exportExempt: true }), { rate: 0, exemption: '302' });
  assert.deepEqual(r.taxFor('TR', { taxRate: 20, exportExempt: true }), { rate: 20, exemption: null });
});

test('periods end on the same day of the month, or the last day of a shorter month', () => {
  assert.equal(r.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(r.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(r.addMonths('2026-10-15', 12), '2027-10-15');
  assert.equal(r.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(r.daysBetween('2026-10-01', '2026-10-27'), 26);
});

test('collection: remind before the due date, overdue the day after, suspend, then terminate when set', () => {
  const s = { invoiceDaysBefore: 7, reminderDays: [3, 1], suspendAfterDays: 3, terminateAfterDays: 14 };
  const st = { reminded: false, overdueNotified: false, suspended: false, suspendedDays: 0 };
  assert.equal(r.collectionStep(-5, s, st), null);
  assert.equal(r.collectionStep(-3, s, st), 'remind');
  assert.equal(r.collectionStep(-3, s, { ...st, reminded: true }), null);
  assert.equal(r.collectionStep(1, s, st), 'overdue');
  assert.equal(r.collectionStep(2, s, { ...st, overdueNotified: true }), null);
  assert.equal(r.collectionStep(3, s, { ...st, overdueNotified: true }), 'suspend');
  assert.equal(r.collectionStep(9, s, { ...st, suspended: true, suspendedDays: 13 }), null);
  assert.equal(r.collectionStep(9, s, { ...st, suspended: true, suspendedDays: 14 }), 'terminate');
  assert.equal(r.collectionStep(99, { ...s, terminateAfterDays: 0 }, { ...st, suspended: true, suspendedDays: 99 }), null);
});

test('a resize mid-period charges the increase for the days left; a decrease or the last day costs nothing', () => {
  assert.equal(r.prorate(3000, '2026-10-16', '2026-10-01', '2026-10-31'), 1500);
  assert.equal(r.prorate(3000, '2026-10-01', '2026-10-01', '2026-10-31'), 3000);
  assert.equal(r.prorate(3000, '2026-10-31', '2026-10-01', '2026-10-31'), 0);
  assert.equal(r.prorate(-500, '2026-10-16', '2026-10-01', '2026-10-31'), 0);
  assert.equal(r.prorate(1000, '2026-09-20', '2026-10-01', '2026-10-31'), 1000); // before the period started: never more than the whole difference
});

test('a coupon takes percent or a fixed amount off, never below zero', () => {
  assert.equal(r.couponPrice(10000, 'percent', 2500), 7500);
  assert.equal(r.couponPrice(999, 'percent', 5000), 499); // half of 9.99, rounded
  assert.equal(r.couponPrice(10000, 'percent', 10000), 0);
  assert.equal(r.couponPrice(10000, 'fixed', 1500), 8500);
  assert.equal(r.couponPrice(1000, 'fixed', 1500), 0);
});

test('pay as you go: started hours are charged; the hourly price of a monthly one', () => {
  const t0 = new Date('2026-10-27T10:00:00Z');
  assert.equal(r.hoursDue(t0, new Date('2026-10-27T09:59:00Z')), 0);
  assert.equal(r.hoursDue(t0, t0), 0);
  assert.equal(r.hoursDue(t0, new Date('2026-10-27T10:00:01Z')), 1);
  assert.equal(r.hoursDue(t0, new Date('2026-10-27T12:30:00Z')), 3);
  assert.equal(r.hourlyOf('7.30'), '0.0100');
  assert.equal(r.hourlyOf('10'), '0.0137');
});
