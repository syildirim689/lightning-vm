// What needs staff: which menu counts and findings a person gets by their permissions, how old snapshots are
// counted, and the two notices added with them (a payment waiting for staff, sign-in details reset by a first proof).
process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/none';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.BETTER_AUTH_SECRET = 'unit-test-only-better-auth-secret-0123456789';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { closeConnections } = await import('../dist/main.js');
const { attentionKeys, attentionNeeds, isStaff, maySeeFinding, countOldSnapshots } = await import('../dist/insights.js');
const { catalog, mailTone } = await import('../dist/notify.js');
const { alwaysSent } = await import('../dist/quiet-hours.js');
const { known } = await import('../dist/permissions.js');
after(() => closeConnections());

test('the menu counts follow the permission of each page; a key one may not see is left out', () => {
  assert.deepEqual(attentionKeys(['*']), ['paymentsInReview', 'failedOperations', 'abuse', 'restoreHold']);
  assert.deepEqual(attentionKeys(['billing.view']), ['paymentsInReview']);
  assert.deepEqual(attentionKeys(['billing.manage']), [], 'managing is not viewing: the payments list asks for billing.view');
  assert.deepEqual(attentionKeys(['servers.view_all']), ['failedOperations', 'abuse']);
  assert.deepEqual(attentionKeys(['dashboard.view']), ['failedOperations', 'restoreHold']);
  assert.deepEqual(attentionKeys(['system.view']), ['restoreHold']);
  assert.deepEqual(attentionKeys(['system.update']), ['restoreHold']);
  assert.deepEqual(attentionKeys(['support.view', 'server.power']), []);
  for (const p of Object.values(attentionNeeds).flat()) assert.ok(known.has(p), p);
});

test('customer permissions make nobody staff', () => {
  assert.equal(isStaff(['servers.create', 'firewalls.manage', 'server.power', 'server.snapshots']), false);
  assert.equal(isStaff([]), false);
  assert.equal(isStaff(['server.power', 'support.view']), true);
  assert.equal(isStaff(['*']), true);
});

test('findings about payments and settings are only for those who may open those pages', () => {
  const review = { code: 'PAYMENTS_IN_REVIEW', link: '/admin/billing?tab=payments&status=review' };
  assert.equal(maySeeFinding(['dashboard.view'], review), false);
  assert.equal(maySeeFinding(['dashboard.view', 'billing.view'], review), true);
  assert.equal(maySeeFinding(['*'], review), true);
  assert.equal(maySeeFinding(['dashboard.view'], { code: 'MAIL_NOT_CONFIGURED', link: '/admin/settings?tab=mail' }), false);
  assert.equal(maySeeFinding(['dashboard.view', 'settings.view'], { code: 'MAIL_NOT_CONFIGURED', link: '/admin/settings?tab=mail' }), true);
  for (const code of ['RESTORE_HOLD', 'OPERATIONS_NEED_DECISION', 'OPERATIONS_FAILED']) assert.equal(maySeeFinding(['dashboard.view'], { code, link: '/admin/system' }), true);
});

test('snapshots older than 30 days are counted; a backup\'s own short snapshot and unreadable dates are not', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const list = [
    { name: 'before upgrade', created: '2026-10-01T00:00:00Z' },                 // 47 days
    { name: 'auto 2026-10-18', created: '2026-10-18T11:59:00Z' },                // just over 30
    { name: 'yesterday', created: '2026-11-16T12:00:00Z' },
    { name: 'on the line', created: '2026-10-18T12:00:00Z' },                    // exactly 30 days: not older
    { name: 'lightning-backup 1f0c', created: '2026-01-01T00:00:00Z' },
    { name: 'no date', created: '' },
  ];
  assert.equal(countOldSnapshots(list, now), 2);
  assert.equal(countOldSnapshots(list, now, 1), 3);
  assert.equal(countOldSnapshots([], now), 0);
});

test('a payment waiting for staff: to those who manage billing, linking to the review list, in both languages', () => {
  const e = catalog['billing.payment_review'], dispute = catalog['billing.dispute_opened'];
  assert.deepEqual([e.audience, e.permission, e.channels, e.defaults], [dispute.audience, dispute.permission, dispute.channels, dispute.defaults]);
  assert.equal(e.link({}), '/admin/billing?tab=payments&status=review');
  const d = { invoiceId: 'i1', number: 'LVM2026000000042', amount: '120.00', currency: 'TRY', provider: 'param', code: 'NEEDS_CONFIRMATION', email: 'ayse@example.test' };
  for (const t of [e.text.tr(d), e.text.en(d)]) {
    assert.ok(t.title.includes('120.00 TRY'), t.title);
    for (const part of [d.number, d.provider, d.code, d.email]) assert.ok(t.body.includes(part), `${part}: ${t.body}`);
  }
  // No number yet (an unpaid invoice) and a reason added later: still a complete sentence.
  for (const t of [e.text.tr({ ...d, number: '', code: 'SOMETHING_NEW' }), e.text.en({ ...d, number: '', code: 'SOMETHING_NEW' })]) assert.ok(!/undefined/.test(t.title + t.body) && t.body.includes('SOMETHING_NEW'));
  assert.equal(mailTone('billing.payment_review'), 'warning');
});

test('sign-in details reset by the first proof of the address: a security notice like the others', () => {
  const e = catalog['auth.credentials_reset'], changed = catalog['auth.password_changed'];
  assert.deepEqual([e.audience, e.channels, e.defaults, e.link({})], [changed.audience, changed.channels, changed.defaults, changed.link({})]);
  assert.ok(e.defaults.includes('inApp') && e.defaults.includes('email'));
  assert.equal(alwaysSent('auth.credentials_reset'), true, 'not held back by quiet hours');
  assert.equal(mailTone('auth.credentials_reset'), 'warning');
  // Both ways the proof happens, everything that goes with it, and what the person has to do afterwards.
  assert.match(e.text.en({}).body, /link or a code, or by resetting the password.*API keys, passkeys.*webhooks, connected apps.*saved SSH keys, saved cards, the billing e-mail and phone, and other sessions.*Forgot password.*renewal needs a card again.*not you, contact support/);
  assert.match(e.text.tr({}).body, /bağlantı ya da kodla girişle veya e-postayla parola sıfırlamayla.*API anahtarları, geçiş anahtarları.*webhooklar, bağlı uygulamalar.*kayıtlı SSH anahtarları, kayıtlı kartlar, fatura e-postası ve telefonu ile diğer oturumlar.*Parolamı unuttum.*yeniden kart.*destek/);
});

test('a hold after a restore: told to those who can release it, in the inbox and by e-mail, linking to the system page', () => {
  const e = catalog['admin.restore_hold'];
  assert.deepEqual([e.audience, e.permission, e.defaults, e.link({})], ['staff', 'system.update', ['inApp', 'email'], '/admin/system']);
  assert.ok(known.has(e.permission));
  assert.equal(mailTone('admin.restore_hold'), 'danger');
  const d = { backup: 'panel-2026-11-01.tar.gz', since: '2026-11-17T09:00:00.000Z' };
  for (const t of [e.text.tr(d), e.text.en(d)]) assert.ok(t.body.includes(d.backup) && /2026/.test(t.body) && !/undefined|Invalid/.test(t.title + t.body), t.body);
  assert.match(e.text.en(d).body, /17 November 2026.*release the hold on the System page/);
  assert.match(e.text.tr(d).body, /17 Kasım 2026.*Sistem sayfasından beklemeyi kaldırın/);
  // Set by hand, with no backup named and no time: still whole sentences.
  for (const t of [e.text.tr({ backup: '', since: '' }), e.text.en({ backup: '', since: '' })]) assert.ok(!/undefined|Invalid|\(\)|""/.test(t.body), t.body);
});
