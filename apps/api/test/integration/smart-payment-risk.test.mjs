// Payment risk against real PostgreSQL and Redis. The customer: an insight when the next renewal will not be collected
// as things stand (the saved card ends before it, or the balance is short), only where the panel collects by itself.
// Staff: the accounts with overdue invoices or repeated failed charges, ordered by the amount at risk, for those who
// may see billing; nothing is sent or changed by looking.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { notificationQueue } = await import('../../dist/notify.js');
const { encryptSecret } = await import('../../dist/secrets.js');

let app, admin, a, aId, b, bId, c, cId, site;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie) => call('POST', url, cookie, payload);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); assert.equal(r.statusCode, 200, r.body); return [cookieOf(r), r.json().user.id]; };
const company = { name: 'Lightning Bilişim A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy', address: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul' };
const billing = { enabled: true, company, autoCharge: true, invoiceDaysBefore: 7, balance: true, sandbox: true, suspendAfterDays: 3, terminateAfterDays: 0, reviewHoldDays: 7 };
const setBilling = async (over = {}) => { const r = await put('/admin/settings/billing', { ...billing, ...over }, admin); assert.equal(r.statusCode, 200, r.body); };
const day = (n) => `((now() AT TIME ZONE 'Europe/Istanbul')::date + ${n})`;
const server = async (ownerId, name) => (await one(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state, vm_moref)
  VALUES ($1, $2, $3, $4, 2, 2048, 20, 80, 'TRY', 'ready', 'poweredOn', $5) RETURNING id`, [ownerId, site.pool, site.image, name, `vm-${name}`])).id;
// The server's running subscription; its period ends in `ends` days.
const subscription = async (ownerId, serverId, ends, amount = '80.00') => (await one(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_months, period_start, period_end)
  VALUES ($1, 'server', $2, 'Sunucu', $3, 'TRY', 'active', 1, (${day(ends)} - interval '1 month')::date, ${day(ends)}) RETURNING id`, [ownerId, serverId, amount])).id;
const invoice = async (ownerId, total, dueDays, extra = {}) => {
  const cols = { owner_id: ownerId, kind: 'renewal', status: 'unpaid', currency: 'TRY', subtotal: total, tax_total: 0, total, buyer: '{}', seller: '{}', ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO invoices (${names.join(', ')}, due_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}, now() + make_interval(days => $${names.length + 1})) RETURNING id`, [...Object.values(cols), dueDays])).id;
};
const failed = (invoiceId, ownerId, amount, daysAgo = 1) => pool.query(`INSERT INTO payments (invoice_id, owner_id, provider, mode, method, status, amount, currency, error_code, automatic, created_at)
  VALUES ($1, $2, 'sandbox', 'test', 'saved_card', 'failed', $3, 'TRY', 'CARD_DECLINED', true, now() - make_interval(days => $4))`, [invoiceId, ownerId, amount, daysAgo]);
const card = (ownerId, month, year, last4 = '4242', isDefault = true) => pool.query(`INSERT INTO saved_cards (owner_id, provider, token_enc, brand, last4, exp_month, exp_year, is_default) VALUES ($1, 'sandbox', 'not-a-real-token', 'visa', $2, $3, $4, $5)`, [ownerId, last4, month, year, isDefault]);
const cards = async (cookie) => (await get('/insights', cookie)).json().insights.filter((i) => ['CARD_EXPIRES_BEFORE_RENEWAL', 'RENEWAL_NOT_COVERED'].includes(i.code));
const risk = async () => (await get('/admin/billing/risk', admin)).json();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await post('/setup/admin', { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await post('/auth/sign-in/email', { email: 'boss@example.test', password }));
  await put('/admin/settings', { registrationOpen: true }, admin);
  await setBilling();
  [a, aId] = await signUp('a@example.test');
  [b, bId] = await signUp('b@example.test');
  [c, cId] = await signUp('c@example.test');
  const conn = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, 'it-risk', 'esxi', 'esxi.risk.test', 'root', $2, 'system', '{}', 'unknown')`, [conn, encryptSecret('pw', 'not-this-connection')]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-risk', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-risk', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  site = { pool: rp.id, image: img.id };
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('the saved card ends before the next renewal: the owner is told which card, when and how much; a card that lasts ends it', async () => {
  const srv = await server(aId, 'a-1');
  await subscription(aId, srv, 20);
  assert.deepEqual(await cards(a), [], 'no card, no balance: this account pays by hand');
  // A card that ended last month cannot be charged in 20 days.
  const past = new Date(Date.now() - 40 * 86_400_000);
  await card(aId, past.getUTCMonth() + 1, past.getUTCFullYear(), '1881');
  const [x] = await cards(a);
  assert.deepEqual([x.code, x.severity, x.link, x.params.last4, x.params.currency], ['CARD_EXPIRES_BEFORE_RENEWAL', 'warning', '/billing?tab=cards', '1881', 'TRY']);
  assert.match(x.params.expiry, /^\d{2}\/\d{2}$/);
  assert.match(x.params.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(x.key, `card-expiry:${x.params.date}`);
  assert.ok(Number(x.params.price) >= 80, `the renewal as billing will invoice it: ${x.params.price}`);
  assert.deepEqual(await cards(b), [], 'nobody else sees it');
  // The panel does not collect by itself: nothing is said.
  await setBilling({ autoCharge: false });
  assert.deepEqual(await cards(a), []);
  await setBilling();
  // A second card that lasts.
  await card(aId, 12, new Date().getUTCFullYear() + 3, '4242', false);
  assert.deepEqual(await cards(a), []);
});

test('a balance that is there but does not cover the renewal: the shortfall; enough balance, or a renewal far away, says nothing', async () => {
  const srv = await server(bId, 'b-1');
  const sub = await subscription(bId, srv, 10);
  await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, note) VALUES ($1, 30, 'TRY', 'adjustment', 'test')", [bId]);
  const [x] = await cards(b);
  assert.deepEqual([x.code, x.link, x.params.balance, x.params.currency], ['RENEWAL_NOT_COVERED', '/billing?tab=balance', '30.00', 'TRY']);
  assert.equal(Number(x.params.short).toFixed(2), (Number(x.params.price) - 30).toFixed(2));
  await pool.query("INSERT INTO balance_entries (owner_id, amount, currency, reason, note) VALUES ($1, 500, 'TRY', 'adjustment', 'test')", [bId]);
  assert.deepEqual(await cards(b), []);
  await pool.query('DELETE FROM balance_entries WHERE owner_id = $1 AND amount = 500', [bId]);
  assert.equal((await cards(b)).length, 1);
  // The renewal is more than 30 days away.
  await pool.query(`UPDATE subscriptions SET period_end = ${day(45)} WHERE id = $1`, [sub]);
  assert.deepEqual(await cards(b), []);
  // Balances switched off in the billing settings: the balance is not what renewals are paid from.
  await pool.query(`UPDATE subscriptions SET period_end = ${day(10)} WHERE id = $1`, [sub]);
  await setBilling({ balance: false });
  assert.deepEqual(await cards(b), []);
  await setBilling();
});

test('staff: accounts with overdue invoices or repeated failed charges, the largest amount at risk first; not for customers', async () => {
  assert.equal((await get('/admin/billing/risk')).statusCode, 401);
  assert.equal((await get('/admin/billing/risk', a)).statusCode, 403);
  assert.deepEqual((await risk()).accounts, []);
  assert.deepEqual((await risk()).rule, { lookaheadDays: 30, failedDays: 30, minFailures: 2, growthDays: 7 });

  // a: 900 overdue for 40 days and 300 more since 3 days ago. b: one invoice not yet due with three failed charges.
  // c: one failed charge (not repeated), an overdue top-up and an overdue disputed invoice (neither counts).
  await invoice(aId, 900, -40);
  await invoice(aId, 300, -3);
  const open = await invoice(bId, 120, 5);
  for (const d of [1, 2, 3]) await failed(open, bId, 120, d);
  await failed(await invoice(cId, 50, 5), cId, 50);
  await invoice(cId, 70, -10, { kind: 'topup' });
  await invoice(cId, 80, -10, { disputed: true });
  // Old failures are out of the window.
  await failed(await invoice(cId, 60, 5), cId, 60, 45);

  const { accounts } = await risk();
  assert.deepEqual(accounts.map((r) => [r.email, r.currency, r.atRisk, r.reasons]), [
    ['a@example.test', 'TRY', 1200, ['OVERDUE_GROWING']],
    ['b@example.test', 'TRY', 120, ['REPEATED_FAILURES']],
  ]);
  const [first, second] = accounts;
  assert.deepEqual([first.overdue, first.overdueCount, first.oldestDays, first.newOverdue, first.failedCharges], [1200, 2, 40, 300, 0]);
  assert.deepEqual([second.overdue, second.overdueCount, second.failedCharges, second.failedAmount], [0, 0, 3, 120]);

  // The summary finding for staff who may see billing.
  await redis.del('insights:staff');
  const finding = (await get('/admin/insights', admin)).json().insights.find((i) => i.code === 'PAYMENT_RISK');
  assert.deepEqual([finding.severity, finding.link, finding.params], ['warning', '/admin/billing?tab=risk', { count: 2, price: '1200.00', currency: 'TRY', email: 'a@example.test' }]);

  // Paid: the account leaves the list. Looking changed nothing else.
  await pool.query("UPDATE invoices SET status = 'paid', paid_total = total, paid_at = now() WHERE owner_id = $1", [aId]);
  assert.deepEqual((await risk()).accounts.map((r) => r.email), ['b@example.test']);
  assert.equal((await one("SELECT count(*)::int AS n FROM invoices WHERE status = 'unpaid'")).n, 5);
});
