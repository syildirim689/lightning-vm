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

test('a period of several months is that many months of the price: an increase is charged for all of them, for the days left', () => {
  assert.deepEqual([['2026-11-16', '2026-12-16'], ['2026-01-31', '2026-02-28'], ['2026-02-28', '2026-03-28'], ['2026-11-16', '2027-02-16'], ['2026-11-30', '2027-02-28'],
    ['2026-11-16', '2027-05-16'], ['2026-11-16', '2027-11-16'], ['2028-02-29', '2029-02-28']].map(([a, b]) => r.periodMonths(a, b)), [1, 1, 1, 3, 3, 6, 12, 12]);
  // A period staff moved by some days is still its months; never less than one.
  assert.deepEqual([r.periodMonths('2026-11-16', '2026-12-26'), r.periodMonths('2026-11-16', '2026-11-20'), r.periodMonths('2026-11-16', '2026-11-16'), r.periodMonths('2026-11-16', '2027-11-30')], [1, 1, 1, 12]);
  // 100 -> 500 a month, one day into a year: 12 x 400 for 364 of 365 days (one month's difference would be 398.90).
  const months = r.periodMonths('2026-11-16', '2027-11-16');
  assert.equal(r.prorate(40000 * months, '2026-11-17', '2026-11-16', '2027-11-16'), 478685);
  assert.equal(r.prorate(40000, '2026-11-17', '2026-11-16', '2027-11-16'), 39890);
  // A monthly period is unchanged.
  assert.equal(r.prorate(40000 * r.periodMonths('2026-11-16', '2026-12-16'), '2026-11-17', '2026-11-16', '2026-12-16'), 38667);
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

test('a billing hold leaves only stopping and deleting, for everyone but staff and billing itself', () => {
  const nobody = { staff: false, billing: false }; // the owner, a reseller, a schedule's pseudo-request
  assert.equal(r.heldRefuses('power_on', nobody), true);
  assert.equal(r.heldRefuses('snapshot_create', nobody), true);
  assert.equal(r.heldRefuses('reinstall', nobody), true);
  for (const kind of ['delete', 'shutdown', 'power_off']) assert.equal(r.heldRefuses(kind, nobody), false);
  assert.equal(r.heldRefuses('power_on', { staff: true, billing: false }), false);
  assert.equal(r.heldRefuses('power_on', { staff: false, billing: true }), false);
});

test('a payment pays what the invoice still needs; the rest (or all of it, on a closed invoice) becomes balance', () => {
  assert.deepEqual(r.settleSplit(true, 12000, 0, 12000), { invoice: 12000, balance: 0 });
  assert.deepEqual(r.settleSplit(true, 12000, 2000, 5000), { invoice: 5000, balance: 0 });
  assert.deepEqual(r.settleSplit(true, 12000, 10000, 12000), { invoice: 2000, balance: 10000 });
  assert.deepEqual(r.settleSplit(true, 12000, 12000, 500), { invoice: 0, balance: 500 });
  // Cancelled or already paid while the customer was on the provider's page: nothing of it is lost.
  assert.deepEqual(r.settleSplit(false, 12000, 0, 12000), { invoice: 0, balance: 12000 });
});

test('a server costs its package (or shape) plus its extra disks; the hourly price follows', () => {
  assert.equal(r.sumMoney('100.00', []), '100.00');
  assert.equal(r.sumMoney('100.00', ['12.50', '0.75']), '113.25');
  assert.equal(r.hourlyOf(r.sumMoney('730.00', ['73.00'])), '1.1000');
});

test('a renewal is due at the period end, but never sooner than the usual terms after it is made', () => {
  // Made a week ahead, as always: due when the period ends.
  assert.equal(r.renewalDue('2026-11-23', '2026-11-16', 7), '2026-11-23');
  // The period ended long ago (a subscription that was stuck, automatic renewal off): the terms count from today.
  assert.equal(r.renewalDue('2026-08-01', '2026-11-16', 7), '2026-11-23');
  assert.equal(r.renewalDue('2026-11-18', '2026-11-16', 7), '2026-11-23');
  assert.equal(r.renewalDue('2026-11-10', '2026-11-16', 0), '2026-11-16');
});

test('dunning counts from the later of the due date and the day collection of that invoice began', () => {
  assert.equal(r.dueDay('2026-10-01', null), '2026-10-01');
  assert.equal(r.dueDay('2026-10-01', '2026-11-16'), '2026-11-16');
  assert.equal(r.dueDay('2026-12-01', '2026-11-16'), '2026-12-01');
  // An old unpaid invoice that only now enters collection starts at the first step, not at suspension.
  const s = { invoiceDaysBefore: 7, reminderDays: [3, 0], suspendAfterDays: 3, terminateAfterDays: 14 };
  const fresh = { reminded: false, overdueNotified: false, suspended: false, suspendedDays: 0 };
  assert.equal(r.collectionStep(r.daysBetween(r.dueDay('2026-10-01', '2026-11-16'), '2026-11-16'), s, fresh), 'remind');
  assert.equal(r.collectionStep(r.daysBetween(r.dueDay('2026-10-01', null), '2026-11-16'), s, fresh), 'suspend');
});

test('at the upgrade a period that ended in the past moves on by whole periods to today or later; nothing in between is invoiced', () => {
  // Three months behind: the period that contains today.
  assert.deepEqual(r.skipPeriods('2026-07-10', '2026-08-10', 1, '2026-11-16'), { start: '2026-11-10', end: '2026-12-10', skipped: 4 });
  // Ends today: not behind (the run invoices the period that starts today). Ended yesterday: one step.
  assert.deepEqual(r.skipPeriods('2026-10-16', '2026-11-16', 1, '2026-11-16'), { start: '2026-10-16', end: '2026-11-16', skipped: 0 });
  assert.deepEqual(r.skipPeriods('2026-10-15', '2026-11-15', 1, '2026-11-16'), { start: '2026-11-15', end: '2026-12-15', skipped: 1 });
  // Not behind: untouched.
  assert.deepEqual(r.skipPeriods('2026-11-01', '2026-12-01', 1, '2026-11-16'), { start: '2026-11-01', end: '2026-12-01', skipped: 0 });
  // Quarterly and yearly periods move by their own length.
  assert.deepEqual(r.skipPeriods('2025-12-05', '2026-03-05', 3, '2026-11-16'), { start: '2026-09-05', end: '2026-12-05', skipped: 3 });
  assert.deepEqual(r.skipPeriods('2024-06-01', '2025-06-01', 12, '2026-11-16'), { start: '2026-06-01', end: '2027-06-01', skipped: 2 });
  // A month-end day steps as renewals step it (each from the last end, clamped to the month's last day).
  assert.deepEqual(r.skipPeriods('2025-12-31', '2026-01-31', 1, '2026-04-10'), { start: '2026-03-28', end: '2026-04-28', skipped: 3 });
});

test('the next renewal: the earliest day, one currency, summed; invoiced only once every renewal of that day has its invoice', () => {
  const part = (day, cents, over = {}) => ({ day, currency: 'TRY', cents, invoiced: false, ...over });
  assert.equal(r.nextRenewalOf([]), null);
  assert.deepEqual(r.nextRenewalOf([part('2026-12-05', 12000), part('2026-12-01', 6000), part('2026-12-01', 24000)]),
    { day: '2026-12-01', currency: 'TRY', cents: 30000, servers: 2, invoiced: false, mixedCurrencies: false });
  // All of that day's renewals have their unpaid invoice: said so, with their sum.
  assert.deepEqual(r.nextRenewalOf([part('2026-12-01', 6000, { invoiced: true }), part('2026-12-01', 24000, { invoiced: true }), part('2026-12-09', 100)]),
    { day: '2026-12-01', currency: 'TRY', cents: 30000, servers: 2, invoiced: true, mixedCurrencies: false });
  // Only some of them: what is not yet invoiced (the rest is among the open invoices already).
  assert.deepEqual(r.nextRenewalOf([part('2026-12-01', 6000, { invoiced: true }), part('2026-12-01', 24000)]),
    { day: '2026-12-01', currency: 'TRY', cents: 24000, servers: 1, invoiced: false, mixedCurrencies: false });
  // Two currencies on one day: the first by its code, and it is said that there is more.
  assert.deepEqual(r.nextRenewalOf([part('2026-12-01', 6000), part('2026-12-01', 900, { currency: 'EUR' }), part('2026-12-01', 1100, { currency: 'EUR' })]),
    { day: '2026-12-01', currency: 'EUR', cents: 2000, servers: 2, invoiced: false, mixedCurrencies: true });
});

test('a payment under review shelters its invoice: no reminder, suspension or termination; the overdue notice still goes out once', () => {
  const s = { invoiceDaysBefore: 7, reminderDays: [3, 1], suspendAfterDays: 3, terminateAfterDays: 14 };
  const st = { reminded: false, overdueNotified: false, suspended: false, suspendedDays: 0, sheltered: true };
  assert.equal(r.collectionStep(-3, s, st), null, 'nobody is reminded to pay what they may have paid');
  assert.equal(r.collectionStep(1, s, st), 'overdue');
  assert.equal(r.collectionStep(5, s, st), 'overdue', 'past the suspension day: the notice, not the suspension');
  assert.equal(r.collectionStep(5, s, { ...st, overdueNotified: true }), null);
  assert.equal(r.collectionStep(30, s, { ...st, suspended: true, suspendedDays: 20 }), null, 'a suspended one is not terminated');
  // Once the window is over the steps are the usual ones.
  assert.equal(r.collectionStep(5, s, { ...st, sheltered: false, overdueNotified: true }), 'suspend');
  assert.equal(r.collectionStep(30, s, { ...st, sheltered: false, suspended: true, suspendedDays: 20 }), 'terminate');
});

test('the review window runs from when the wait began for the set days; 0 days is no window', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const ago = (days) => new Date(now - days * 86_400_000);
  assert.equal(r.inReviewWindow(ago(0), 7, now), true);
  assert.equal(r.inReviewWindow(ago(6.9), 7, now), true);
  assert.equal(r.inReviewWindow(ago(7), 7, now), false, 'a stuck review shelters nothing after the window');
  assert.equal(r.inReviewWindow(ago(400), 7, now), false);
  assert.equal(r.inReviewWindow(ago(1), 0, now), false);
  assert.equal(r.inReviewWindow(null, 7, now), false, 'no payment under review');
  assert.equal(r.inReviewWindow(ago(2).toISOString(), 7, now), true);
});

test('a reseller price is undone only when today\'s catalog less the discount gives exactly the price the server has', () => {
  assert.equal(r.discounted('100.00', 20), '80.00');
  assert.equal(r.undiscounted('80.00', 20, '100.00', []), '100.00');
  // With extra disks, each discounted by itself as disks.ts does.
  assert.equal(r.undiscounted(r.sumMoney(r.discounted('99.99', 15), [r.discounted('12.35', 15), r.discounted('7.01', 15)]), 15, '99.99', ['12.35', '7.01']), '119.35');
  // Not told: the catalog moved, another discount applied when it was priced, a price staff set, no discount at all.
  assert.equal(r.undiscounted('80.00', 20, '110.00', []), null);
  assert.equal(r.undiscounted('80.00', 25, '100.00', []), null);
  assert.equal(r.undiscounted('79.99', 20, '100.00', []), null);
  assert.equal(r.undiscounted('100.00', 0, '100.00', []), null);
  assert.equal(r.undiscounted('80.00', 20, '100.00', ['10.00']), null, 'a disk the price does not contain');
});

test('monthly totals for a notice are summed per currency', () => {
  assert.equal(r.monthlyTotals([]), '');
  assert.equal(r.monthlyTotals([{ currency: 'TRY', amount: '100.00' }, { currency: 'TRY', amount: '20.50' }]), '120.50 TRY');
  assert.equal(r.monthlyTotals([{ currency: 'TRY', amount: '100.00' }, { currency: 'EUR', amount: '15.00' }]), '15.00 EUR + 100.00 TRY');
});
