// Payment risk rules at their edges: when a card ends, which renewals are warned about and with what, and how the
// staff list is chosen and ordered.
import test from 'node:test';
import assert from 'node:assert/strict';

const { cardExpiresBefore, renewalRisks, rankRisk, riskRule } = await import('../dist/payment-risk-rules.js');

const now = new Date('2026-11-21T09:00:00Z');
const inDays = (n) => new Date(now.getTime() + n * 86_400_000);
const card = (expMonth, expYear, extra = {}) => ({ last4: '4242', expMonth, expYear, isDefault: false, ...extra });
const renewal = (days, amount = 100) => ({ at: inDays(days), amount, currency: 'EUR' });

test('a card is good through the last day of its month', () => {
  assert.equal(cardExpiresBefore(card(11, 2026), new Date('2026-11-30T23:59:59Z')), false);
  assert.equal(cardExpiresBefore(card(11, 2026), new Date('2026-12-01T00:00:00Z')), true);
  assert.equal(cardExpiresBefore(card(12, 2026), new Date('2027-01-01T00:00:00Z')), true, 'December ends the year');
  assert.equal(cardExpiresBefore(card(12, 26), new Date('2026-12-31T12:00:00Z')), false, 'a two-digit year');
  assert.equal(cardExpiresBefore(card(null, null), inDays(400)), false, 'no expiry known: nothing concluded');
  assert.equal(cardExpiresBefore(card(13, 2026), inDays(400)), false);
});

test('no renewal, one already invoiced, one too far away or in the past: nothing is said', () => {
  const cards = [card(11, 2026)];
  assert.deepEqual(renewalRisks({ renewal: null, cards, balance: 0, now }), []);
  assert.deepEqual(renewalRisks({ renewal: { ...renewal(12), invoiced: true }, cards, balance: 0, now }), []);
  assert.deepEqual(renewalRisks({ renewal: renewal(riskRule.lookaheadDays + 1), cards, balance: 0, now }), []);
  assert.deepEqual(renewalRisks({ renewal: renewal(-1), cards, balance: 0, now }), []);
  assert.deepEqual(renewalRisks({ renewal: renewal(12, 0), cards, balance: 0, now }), []);
});

test('the saved card ends before the renewal: said with the card and the date, unless the balance covers it', () => {
  // Renewal on 3 December; the card ends with November.
  const r = renewalRisks({ renewal: renewal(12), cards: [card(11, 2026, { isDefault: true })], balance: 0, now });
  assert.deepEqual(r, [{ kind: 'CARD_EXPIRES_BEFORE_RENEWAL', last4: '4242', expiry: '11/26', at: inDays(12).toISOString(), amount: 100, currency: 'EUR' }]);
  // Billing charges one card, the default (else the first of its list, the newest), and no other: when that one
  // lasts, fine; a spare that lasts does not help when the one that is charged ends.
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(6, 2028), card(11, 2026)], balance: 0, now }), []);
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(11, 2026), card(6, 2028, { isDefault: true })], balance: 0, now }), [], 'the default lasts, wherever it stands in the list');
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(6, 2028), card(11, 2026, { isDefault: true })], balance: 0, now }).map((x) => x.kind), ['CARD_EXPIRES_BEFORE_RENEWAL']);
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(11, 2026), card(6, 2028)], balance: 0, now }).map((x) => x.kind), ['CARD_EXPIRES_BEFORE_RENEWAL'], 'no default: the first is charged');
  // The balance pays it whatever the card does.
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(11, 2026)], balance: 100, now }), []);
  // Two cards, both ending: the default one is named.
  const two = renewalRisks({ renewal: renewal(12), cards: [card(10, 2026, { last4: '1111' }), card(11, 2026, { last4: '2222', isDefault: true })], balance: 0, now });
  assert.equal(two[0].last4, '2222');
  // A card good through the renewal's month.
  assert.deepEqual(renewalRisks({ renewal: renewal(5), cards: [card(11, 2026)], balance: 0, now }), []);
});

test('a balance that is there but too small: the shortfall; an account with neither card nor balance pays by hand', () => {
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [], balance: 30.5, now }), [{ kind: 'RENEWAL_NOT_COVERED', balance: 30.5, short: 69.5, at: inDays(12).toISOString(), amount: 100, currency: 'EUR' }]);
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [], balance: 0, now }), []);
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [], balance: 100, now }), []);
  // An ending card and a small balance: both are said.
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(11, 2026)], balance: 20, now }).map((x) => x.kind), ['CARD_EXPIRES_BEFORE_RENEWAL', 'RENEWAL_NOT_COVERED']);
  // A lasting card: the balance does not matter.
  assert.deepEqual(renewalRisks({ renewal: renewal(12), cards: [card(1, 2030)], balance: 20, now }), []);
});

const facts = (email, extra) => ({ userId: email, email, currency: 'EUR', overdue: 0, overdueCount: 0, oldestDays: 0, newOverdue: 0, failedCharges: 0, failedAmount: 0, ...extra });

test('staff list: overdue or repeated failures, ordered by the amount at risk', () => {
  const list = rankRisk([
    facts('fine@example.test', {}),
    facts('once@example.test', { failedCharges: 1, failedAmount: 500 }),
    facts('small@example.test', { overdue: 40, overdueCount: 1, oldestDays: 3, newOverdue: 40 }),
    facts('big@example.test', { overdue: 900, overdueCount: 3, oldestDays: 40, newOverdue: 300 }),
    facts('cards@example.test', { failedCharges: 3, failedAmount: 120 }),
    facts('both@example.test', { overdue: 120, overdueCount: 1, oldestDays: 10, failedCharges: 2, failedAmount: 120 }),
  ]);
  assert.deepEqual(list.map((r) => [r.email, r.atRisk, r.reasons]), [
    ['big@example.test', 900, ['OVERDUE_GROWING']],
    ['both@example.test', 120, ['OVERDUE', 'REPEATED_FAILURES']],
    ['cards@example.test', 120, ['REPEATED_FAILURES']],
    ['small@example.test', 40, ['OVERDUE']],
  ]);
  // One failed charge is not "repeated"; all of the overdue being new is not "growing".
  assert.equal(rankRisk([facts('a', { failedCharges: riskRule.minFailures - 1, failedAmount: 10 })]).length, 0);
  assert.deepEqual(rankRisk([]), []);
});
