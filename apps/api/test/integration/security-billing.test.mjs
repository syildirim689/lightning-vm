// Billing fixes from the security review, against real PostgreSQL and Redis (no provider is called: Param and PayTR
// answers are posted to the callback as their browser or server would): a Param return never pays an invoice, Param is
// not offered for another currency, test payments end with the sandbox or the test mode, a renewal invoice follows the
// server's price, two refunds at once give back no more than was paid, and "run billing now" shares the run's lock.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';

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
const { runBilling, resizeCharge, billResize, repriceOpenRenewal } = await import('../../dist/billing.js');

let app, admin, user, userId;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie, headers) => call('POST', url, cookie, payload, headers);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const form = (b) => new URLSearchParams(b).toString();
const urlencoded = { 'content-type': 'application/x-www-form-urlencoded' };
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const company = { name: 'Lightning Bilişim A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy', address: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul' };
// A staff invoice of 100 before tax: 120.00 with the default 20 % (the buyer without a profile counts as Turkish).
const invoiceFor = async (currency = 'TRY') => (await post('/admin/billing/invoices', { userId, currency, lines: [{ description: 'Hizmet', unitPrice: '100' }] }, admin)).json().invoiceId;
const pending = async (invoiceId, provider, mode, currency = 'TRY') => (await one(`INSERT INTO payments (invoice_id, owner_id, provider, mode, method, status, amount, currency)
  VALUES ($1, $2, $3, $4, 'card', 'pending', 120, $5) RETURNING id`, [invoiceId, userId, provider, mode, currency])).id;
const payment = (id) => one('SELECT status, error_code, error_message, provider_ref FROM payments WHERE id = $1', [id]);
const invoice = (id) => one('SELECT status, subtotal::text, tax_total::text, total::text, paid_total::text, refunded_total::text FROM invoices WHERE id = $1', [id]);
const balance = async () => (await one("SELECT coalesce(sum(amount), 0)::numeric(12,2)::text AS v FROM balance_entries WHERE owner_id = $1 AND currency = 'TRY'", [userId])).v;

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
  const r = await post('/auth/sign-up/email', { name: 'Ayşe', email: 'ayse@example.test', password });
  user = cookieOf(r); userId = r.json().user.id;
  assert.equal((await put('/admin/settings/billing', { enabled: true, company, autoCharge: false, invoiceDaysBefore: 7, balance: true, sandbox: true }, admin)).statusCode, 200);
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('Param: a return made from the merchant code and GUID alone never pays the invoice; staff settle it by hand', async () => {
  const creds = { CLIENT_CODE: '10738', CLIENT_USERNAME: 'Test', CLIENT_PASSWORD: 'Test', GUID: '0c13d406-873b-403b-9c09-a5766840d98c' };
  await pool.query(`INSERT INTO payment_gateways (id, enabled, mode, live_enc, live_version, live_check) VALUES ('param', true, 'live', $1, 1, $2)`,
    [encryptSecret(JSON.stringify(creds), 'payments:param:live'), JSON.stringify({ status: 'ok', at: new Date().toISOString(), version: 1 })]);
  const inv = await invoiceFor();
  const back = (id, b) => {
    const f = { TURKPOS_RETVAL_Sonuc: '1', TURKPOS_RETVAL_Sonuc_Str: 'OK', TURKPOS_RETVAL_GUID: creds.GUID, TURKPOS_RETVAL_Dekont_ID: 'D1', TURKPOS_RETVAL_Tahsilat_Tutari: '120,00',
      TURKPOS_RETVAL_Siparis_ID: 'S1', TURKPOS_RETVAL_Islem_ID: id.replace(/-/g, ''), ...b };
    f.TURKPOS_RETVAL_Hash ??= createHash('sha1').update(Buffer.from(creds.CLIENT_CODE + f.TURKPOS_RETVAL_GUID + f.TURKPOS_RETVAL_Dekont_ID + f.TURKPOS_RETVAL_Tahsilat_Tutari
      + f.TURKPOS_RETVAL_Siparis_ID + f.TURKPOS_RETVAL_Islem_ID, 'latin1')).digest('base64');
    // No session and no CSRF header: the address is open to anyone.
    return app.inject({ method: 'POST', url: `/billing/callback/param/${id}`, payload: form(f), headers: urlencoded });
  };
  // Control: a wrong hash changes nothing and leaves no note.
  const p0 = await pending(inv, 'param', 'live');
  assert.equal((await back(p0, { TURKPOS_RETVAL_Hash: 'forged' })).statusCode, 303);
  assert.deepEqual(await payment(p0), { status: 'pending', error_code: null, error_message: null, provider_ref: null });
  // The forgery of the review: every check of the return passes, and the invoice stays unpaid.
  const p1 = await pending(inv, 'param', 'live');
  const r = await back(p1, {});
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, `/billing/invoices/${inv}?payment=${p1}`);
  let row = await payment(p1);
  assert.deepEqual([row.status, row.error_code, row.provider_ref], ['pending', 'NEEDS_CONFIRMATION', null]);
  assert.match(row.error_message, /S1.*D1.*120,00/);
  assert.deepEqual(await invoice(inv).then((i) => [i.status, i.paid_total]), ['unpaid', '0.00']);
  // Posted again it stays as it is; an amount that is not a number is no answer at all.
  assert.equal((await back(p1, {})).statusCode, 303);
  assert.equal((await payment(p1)).status, 'pending');
  const p2 = await pending(inv, 'param', 'live');
  await back(p2, { TURKPOS_RETVAL_Tahsilat_Tutari: 'abc' });
  assert.deepEqual(await payment(p2), { status: 'pending', error_code: null, error_message: null, provider_ref: null });
  assert.equal((await invoice(inv)).status, 'unpaid');
  // The customer sees the open payment and why; staff see it in their list, confirm it at Param and mark the invoice paid.
  const mine = (await get(`/billing/invoices/${inv}`, user)).json().payments.find((x) => x.id === p1);
  assert.deepEqual([mine.status, mine.errorCode], ['pending', 'NEEDS_CONFIRMATION']);
  assert.ok((await get('/admin/billing/payments?status=pending', admin)).json().payments.some((x) => x.id === p1 && x.errorCode === 'NEEDS_CONFIRMATION'));
  assert.equal((await balance()), '0.00');
  assert.equal((await post(`/admin/billing/invoices/${inv}/mark-paid`, { method: 'other', reference: 'Param S1' }, admin)).statusCode, 200);
  assert.equal((await invoice(inv)).status, 'paid');
  // After that the same return still settles nothing (no second payment, no balance).
  await back(p1, {});
  assert.equal((await payment(p1)).status, 'pending');
  assert.equal((await balance()), '0.00');
});

test('Param collects lira only: it is refused for an invoice in another currency, and its return never settles one', async () => {
  // Offered with the currencies it can take, so the pay page can leave it out.
  const offered = (await get('/billing/summary', user)).json().methods.cards;
  assert.deepEqual(offered.find((c) => c.id === 'param').currencies, ['TRY']);
  assert.equal(offered.find((c) => c.id === 'sandbox').currencies, null);
  const usd = await invoiceFor('USD');
  const r = await post(`/billing/invoices/${usd}/pay`, { method: 'card', provider: 'param' }, user);
  assert.deepEqual([r.statusCode, r.json().code], [409, 'PAYMENT_METHOD_UNAVAILABLE']);
  assert.equal((await one('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [usd])).n, 0, 'no payment is begun');
  // Another provider takes the dollar invoice (the sandbox here).
  const other = await post(`/billing/invoices/${usd}/pay`, { method: 'card', provider: 'sandbox' }, user);
  assert.equal(other.statusCode, 200);
  await post(`/billing/payments/${other.json().paymentId}/sandbox`, { cancel: true }, user);
  // A dollar payment begun at Param before this rule: "120,00" in its return is lira, not 120 USD.
  const old = await pending(usd, 'param', 'live', 'USD');
  const creds = { CLIENT_CODE: '10738', GUID: '0c13d406-873b-403b-9c09-a5766840d98c' };
  const f = { TURKPOS_RETVAL_Sonuc: '1', TURKPOS_RETVAL_GUID: creds.GUID, TURKPOS_RETVAL_Dekont_ID: 'D2', TURKPOS_RETVAL_Tahsilat_Tutari: '120,00', TURKPOS_RETVAL_Siparis_ID: 'S2', TURKPOS_RETVAL_Islem_ID: old.replace(/-/g, '') };
  f.TURKPOS_RETVAL_Hash = createHash('sha1').update(Buffer.from(creds.CLIENT_CODE + f.TURKPOS_RETVAL_GUID + f.TURKPOS_RETVAL_Dekont_ID + f.TURKPOS_RETVAL_Tahsilat_Tutari + f.TURKPOS_RETVAL_Siparis_ID + f.TURKPOS_RETVAL_Islem_ID, 'latin1')).digest('base64');
  assert.equal((await app.inject({ method: 'POST', url: `/billing/callback/param/${old}`, payload: form(f), headers: urlencoded })).statusCode, 303);
  const row = await payment(old);
  assert.deepEqual([row.status, row.error_code], ['pending', 'AMOUNT_MISMATCH']);
  assert.equal((await invoice(usd)).status, 'unpaid');
  await pool.query("DELETE FROM payment_gateways WHERE id = 'param'");
});

test('sandbox: switched off, pending test payments are closed and a test card pays nothing; so are test-mode payments of a provider that goes live', async () => {
  const top = (await post('/billing/topup', { amount: '500', currency: 'TRY' }, user)).json().invoiceId;
  const a = (await post(`/billing/invoices/${top}/pay`, { method: 'card', provider: 'sandbox' }, user)).json().paymentId;
  const b = (await post(`/billing/invoices/${top}/pay`, { method: 'card', provider: 'sandbox' }, user)).json().paymentId;
  assert.ok(a && b);
  const before = await balance();
  assert.equal((await put('/admin/settings/billing', { sandbox: false }, admin)).statusCode, 200);
  for (const id of [a, b]) assert.deepEqual(await payment(id).then((p) => [p.status, p.error_code]), ['failed', 'TEST_MODE_OFF']);
  // Control: a new sandbox payment cannot be started.
  assert.equal((await post(`/billing/invoices/${top}/pay`, { method: 'card', provider: 'sandbox' }, user)).json().code, 'PAYMENT_METHOD_UNAVAILABLE');
  // The settling route itself refuses: also a payment that is somehow still pending (one begun as the switch was thrown).
  const late = await pending(top, 'sandbox', 'test');
  for (const id of [a, late]) {
    const r = await post(`/billing/payments/${id}/sandbox`, { card: '4242 4242 4242 4242' }, user);
    assert.deepEqual([r.statusCode, r.json().code], [409, 'PAYMENT_METHOD_UNAVAILABLE']);
  }
  assert.equal((await payment(late)).status, 'pending');
  assert.equal((await invoice(top)).status, 'unpaid');
  assert.equal(await balance(), before, 'no balance appears after the switch-off');
  // Giving up stays possible.
  assert.deepEqual((await post(`/billing/payments/${late}/sandbox`, { cancel: true }, user)).json(), { status: 'failed', code: 'CANCELLED_BY_CUSTOMER' });
  // Switched on again, the closed payments stay closed.
  await put('/admin/settings/billing', { sandbox: true }, admin);
  assert.equal((await post(`/billing/payments/${a}/sandbox`, { card: '4242 4242 4242 4242' }, user)).json().status, 'failed');
  assert.equal(await balance(), before);

  // PayTR in test mode with a payment left open; then the provider is switched to live.
  const creds = { merchant_id: '123', merchant_key: 'k3y', merchant_salt: 's4lt' };
  await pool.query(`INSERT INTO payment_gateways (id, enabled, mode, test_enc, test_version, live_enc, live_version) VALUES ('paytr', false, 'test', $1, 1, $2, 1)`,
    [encryptSecret(JSON.stringify(creds), 'payments:paytr:test'), encryptSecret(JSON.stringify(creds), 'payments:paytr:live')]);
  const inv = await invoiceFor();
  const open = await pending(inv, 'paytr', 'test');
  assert.equal((await post('/admin/settings/payments/paytr/state', { enabled: false, mode: 'live' }, admin)).statusCode, 200);
  assert.deepEqual(await payment(open).then((p) => [p.status, p.error_code]), ['failed', 'TEST_MODE_OFF']);
  // A test payment still pending after the switch is not settled by a genuine test notification either.
  const stray = await pending(inv, 'paytr', 'test');
  const n = { merchant_oid: stray.replace(/-/g, ''), status: 'success', total_amount: '12000', payment_amount: '12000' };
  n.hash = createHmac('sha256', creds.merchant_key).update(`${n.merchant_oid}${creds.merchant_salt}${n.status}${n.total_amount}`).digest('base64');
  assert.equal((await app.inject({ method: 'POST', url: '/billing/callback/paytr', payload: form(n), headers: urlencoded })).statusCode, 409);
  assert.equal((await payment(stray)).status, 'pending');
  assert.equal((await invoice(inv)).status, 'unpaid');
  // Back in test mode the same notification is PayTR's word again.
  await post('/admin/settings/payments/paytr/state', { enabled: false, mode: 'test' }, admin);
  assert.equal((await app.inject({ method: 'POST', url: '/billing/callback/paytr', payload: form(n), headers: urlencoded })).body, 'OK');
  assert.equal((await invoice(inv)).status, 'paid');
  await pool.query("DELETE FROM payment_gateways WHERE id = 'paytr'");
});

test('a renewal invoice not yet begun follows the server\'s price: shrinking before it is made and enlarging after it does not buy a cheap period', async () => {
  const day = (n) => `((now() AT TIME ZONE 'Europe/Istanbul')::date + ${n})`;
  const conn = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, 'it-billing', 'esxi', 'esxi.billing.test', 'root', 'x', 'system', '{}', 'unknown')`, [conn]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-billing', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-billing', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  const srv = await one(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state)
    VALUES ($1, $2, $3, 'it-billing', 2, 2048, 20, 500, 'TRY', 'ready', 'poweredOn') RETURNING id, owner_id, name`, [userId, rp.id, img.id]);
  const sub = await one(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_start, period_end)
    VALUES ($1, 'server', $2, 'Sunucu it-billing', 500, 'TRY', 'active', (${day(8)} - interval '1 month')::date, ${day(8)}) RETURNING id`, [userId, srv.id]);
  const price = (v) => pool.query('UPDATE servers SET price_monthly = $2 WHERE id = $1', [srv.id, v]);
  const amount = async () => (await one('SELECT amount::text FROM subscriptions WHERE id = $1', [sub.id])).amount;
  const shape = { vcpu: 2, memoryMb: 2048, diskGb: 20 };
  const renewals = async () => (await pool.query(`SELECT i.id, i.status, i.subtotal::text, i.tax_total::text, i.total::text, l.unit_price::numeric(12,2)::text AS unit, l.gross::text
    FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id WHERE l.subscription_id = $1 AND i.kind = 'renewal' AND NOT l.withdrawn ORDER BY i.created_at`, [sub.id])).rows;

  // Eight days before the period ends the customer takes a smaller shape: free, and nothing is invoiced yet.
  assert.equal((await resizeCharge(srv.id, '500.00', '100.00')).chargeNow, '0.00');
  await price('100.00');
  let run = await runBilling();
  assert.equal(run.renewals, 0, JSON.stringify(run));
  assert.equal(await amount(), '100.00', 'the subscription follows the server');
  // A day later the run makes the renewal invoice, at the small price.
  await pool.query(`UPDATE subscriptions SET period_start = (${day(7)} - interval '1 month')::date, period_end = ${day(7)} WHERE id = $1`, [sub.id]);
  run = await runBilling();
  assert.equal(run.renewals, 1, JSON.stringify(run));
  let [renewal] = await renewals();
  assert.deepEqual([renewal.status, renewal.unit, renewal.total], ['unpaid', '100.00', '120.00']);
  // Right after it the customer takes the large shape back (what the resize route does: the quote, the price, the invoice).
  const charge = await resizeCharge(srv.id, '100.00', '500.00');
  assert.ok(Number(charge.chargeNow) > 0 && Number(charge.chargeNow) < 400, charge.chargeNow);
  await price('500.00');
  const diff = await billResize(srv, charge.chargeNow, 'TRY', shape);
  assert.equal((await one('SELECT subtotal::text FROM invoices WHERE id = $1', [diff])).subtotal, charge.chargeNow, 'the rest of the running period');
  // The next period is billed at the price of the shape that will run in it, on the same invoice.
  [renewal] = await renewals();
  assert.deepEqual([renewal.status, renewal.unit, renewal.subtotal, renewal.tax_total, renewal.total, renewal.gross], ['unpaid', '500.00', '500.00', '100.00', '600.00', '600.00']);
  assert.equal(await amount(), '500.00');
  run = await runBilling();
  assert.deepEqual([run.renewals, run.repriced], [0, 0], 'one renewal per period, already at the right price');
  assert.equal((await renewals()).length, 1);

  // A price change billing is not told about (a smaller shape, a removed disk) reaches the invoice with the next run, both ways.
  await price('100.00');
  assert.equal((await runBilling()).repriced, 1);
  assert.equal((await renewals())[0].total, '120.00');
  await price('500.00');
  assert.equal(await repriceOpenRenewal(srv.id), 1);
  assert.equal(await repriceOpenRenewal(srv.id), 0, 'nothing left to change');
  assert.equal((await renewals())[0].total, '600.00');
  // Not while the invoice is in dispute; once the dispute is closed it follows.
  await pool.query('UPDATE invoices SET disputed = true WHERE id = $1', [renewal.id]);
  await price('300.00');
  assert.equal((await runBilling()).repriced, 0);
  assert.equal((await renewals())[0].total, '600.00');
  await pool.query('UPDATE invoices SET disputed = false WHERE id = $1', [renewal.id]);
  assert.equal((await runBilling()).repriced, 1);
  assert.equal((await renewals())[0].total, '360.00');
  await price('500.00');
  await runBilling();
  assert.equal((await renewals())[0].total, '600.00');
  // A payment begun for the old total and finished after the invoice grew leaves the rest owed.
  await price('100.00');
  await runBilling();
  const early = (await post(`/billing/invoices/${renewal.id}/pay`, { method: 'card', provider: 'sandbox' }, user)).json().paymentId;
  await price('500.00');
  await runBilling();
  assert.equal((await post(`/billing/payments/${early}/sandbox`, { card: '4242 4242 4242 4242' }, user)).json().status, 'succeeded');
  assert.deepEqual(await invoice(renewal.id).then((i) => [i.status, i.total, i.paid_total]), ['unpaid', '600.00', '120.00']);
  // Never below what was already paid: a smaller price now leaves this invoice alone.
  await price('50.00');
  await runBilling();
  assert.deepEqual(await invoice(renewal.id).then((i) => [i.status, i.total]), ['unpaid', '600.00']);
  await price('500.00');
  await runBilling();

  // The renewal unpaid and its period begun: the invoice stays, and an increase is charged for the rest of that period
  // (the subscription itself is still on the period before, which is over).
  await pool.query(`UPDATE subscriptions SET period_start = (${day(-3)} - interval '1 month')::date, period_end = ${day(-3)} WHERE id = $1`, [sub.id]);
  await pool.query(`UPDATE invoice_lines SET period_start = ${day(-3)}, period_end = (${day(-3)} + interval '1 month')::date WHERE invoice_id = $1`, [renewal.id]);
  const begun = await resizeCharge(srv.id, '500.00', '800.00');
  assert.ok(Number(begun.chargeNow) > 200 && Number(begun.chargeNow) < 300, begun.chargeNow);
  assert.equal(begun.periodEnd, (await one(`SELECT (${day(-3)} + interval '1 month')::date::text AS d`)).d);
  await price('800.00');
  assert.equal(await repriceOpenRenewal(srv.id), 0);
  assert.equal((await invoice(renewal.id)).total, '600.00');
  await pool.query("UPDATE subscriptions SET status = 'cancelled', staff_cancelled = true WHERE id = $1", [sub.id]);
  await pool.query("UPDATE servers SET state = 'deleted' WHERE id = $1", [srv.id]);
});

test('two refunds of one invoice at the same moment give back no more than was paid', async () => {
  const inv = await invoiceFor();
  assert.equal((await post(`/admin/billing/invoices/${inv}/mark-paid`, { method: 'bank_transfer' }, admin)).statusCode, 200);
  const before = Number(await balance());
  // Two identical requests at once are already turned away at the door (main.ts: DUPLICATE_REQUEST); these differ in
  // their reason, as two members of staff refunding the same invoice would, and meet at the invoice's lock.
  const same = await Promise.all([1, 2].map(() => post(`/admin/billing/invoices/${inv}/refund`, { amount: '1.00', toBalance: true, reason: 'same' }, admin)));
  assert.deepEqual(same.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(same.find((r) => r.statusCode === 409).json().code, 'DUPLICATE_REQUEST');
  const both = await Promise.all([1, 2].map((n) => post(`/admin/billing/invoices/${inv}/refund`, { amount: '100.00', toBalance: true, reason: `staff ${n}` }, admin)));
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 400], both.map((r) => r.body).join(' | '));
  assert.equal(both.find((r) => r.statusCode === 400).json().fields.amount, 'OUT_OF_RANGE');
  assert.deepEqual(await invoice(inv).then((i) => [i.status, i.refunded_total]), ['partially_refunded', '101.00']);
  assert.equal(Number(await balance()) - before, 101);
  // What is left can still be refunded, once.
  const rest = await Promise.all([1, 2, 3].map((n) => post(`/admin/billing/invoices/${inv}/refund`, { amount: '19.00', toBalance: true, reason: `rest ${n}` }, admin)));
  assert.equal(rest.filter((r) => r.statusCode === 200).length, 1);
  assert.deepEqual(await invoice(inv).then((i) => [i.status, i.refunded_total]), ['refunded', '120.00']);
  assert.equal(Number(await balance()) - before, 120);
  // A card refund goes through the same lock: a sandbox payment is given back once.
  const top = (await post('/billing/topup', { amount: '200', currency: 'TRY' }, user)).json().invoiceId;
  const pay = (await post(`/billing/invoices/${top}/pay`, { method: 'card', provider: 'sandbox' }, user)).json().paymentId;
  assert.equal((await post(`/billing/payments/${pay}/sandbox`, { card: '4242 4242 4242 4242' }, user)).json().status, 'succeeded');
  const held = Number(await balance());
  const cards = await Promise.all([1, 2].map((n) => post(`/admin/billing/invoices/${top}/refund`, { amount: '200.00', reason: `card ${n}` }, admin)));
  assert.deepEqual(cards.map((r) => r.statusCode).sort(), [200, 409], cards.map((r) => r.body).join(' | '));
  assert.equal(cards.find((r) => r.statusCode === 409).json().code, 'INVOICE_NOT_REFUNDABLE', 'the second waited, then found the invoice refunded');
  assert.equal((await one('SELECT refunded::text, status FROM payments WHERE id = $1', [pay])).refunded, '200.00');
  assert.equal(held - Number(await balance()), 200, 'the top-up leaves the balance once');
});

test('"run billing now" waits for a run in progress instead of running beside it', async () => {
  await redis.set('lock:billing', '1', 'EX', 240);
  const busy = await post('/admin/billing/run', {}, admin);
  assert.deepEqual([busy.statusCode, busy.json().code], [409, 'BILLING_RUNNING']);
  assert.equal(await redis.get('lock:billing'), '1', 'the other run keeps its lock');
  await redis.del('lock:billing');
  const ran = await post('/admin/billing/run', {}, admin);
  assert.equal(ran.statusCode, 200);
  assert.equal(typeof ran.json().renewals, 'number');
  assert.equal(await redis.get('lock:billing'), null, 'given back when done');
  assert.equal((await post('/admin/billing/run', {}, user)).statusCode, 403);
  assert.equal((await post('/admin/billing/run', {}, admin)).statusCode, 200);
});
