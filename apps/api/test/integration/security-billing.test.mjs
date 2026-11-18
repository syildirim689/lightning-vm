// Billing fixes from the security review, against real PostgreSQL and Redis (no provider is called: Param and PayTR
// answers are posted to the callback as their browser or server would): a Param return never pays an invoice, Param is
// not offered for another currency, test payments end with the sandbox or the test mode, a renewal invoice follows the
// server's price (also in dispute, on the period's last day, and at the moment it is paid), an increase in a period of
// several months is charged for all of it, two refunds at once give back no more than was paid, "run billing now" shares
// the run's lock, which the periodic run gives back, nothing runs while the panel is on hold after a restore, staff acting
// as a customer do not set the billing e-mail, and a stored gateway or integrator secret does not follow a new address.
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
const { runBilling, resizeCharge, billResize, repriceOpenRenewal, billingTick } = await import('../../dist/billing.js');
const { forgetRestoreHold } = await import('../../dist/restore-hold.js');
const { announceRestoreHold } = await import('../../dist/insights.js');

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
const day = (n) => `((now() AT TIME ZONE 'Europe/Istanbul')::date + ${n})`;
// A ready server of the customer with a running subscription: its period ends in `ends` days, or (began) started that
// many days ago and runs for `months`.
let site;
async function rented(name, monthly, ends, months = 1, began = null) {
  if (!site) {
    const conn = randomUUID();
    await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
      VALUES ($1, 'it-billing-2', 'esxi', 'esxi2.billing.test', 'root', 'x', 'system', '{}', 'unknown')`, [conn]);
    const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-billing-2', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
    const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-billing-2', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
    site = { pool: rp.id, image: img.id };
  }
  const srv = await one(`INSERT INTO servers (owner_id, pool_id, image_id, name, vcpu, memory_mb, disk_gb, price_monthly, currency, state, power_state)
    VALUES ($1, $2, $3, $4, 2, 2048, 20, $5, 'TRY', 'ready', 'poweredOn') RETURNING id, owner_id, name`, [userId, site.pool, site.image, name, monthly]);
  const period = began === null ? `(${day(ends)} - make_interval(months => $5::int))::date, ${day(ends)}` : `${day(-began)}, (${day(-began)} + make_interval(months => $5::int))::date`;
  const sub = await one(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_months, period_start, period_end)
    VALUES ($1, 'server', $2, $3, $4, 'TRY', 'active', $5::int, ${period}) RETURNING id`, [userId, srv.id, `Sunucu ${name}`, monthly, months]);
  return { srv, sub: sub.id,
    price: (v) => pool.query('UPDATE servers SET price_monthly = $2 WHERE id = $1', [srv.id, v]),
    renewal: () => one(`SELECT i.id, i.status, i.total::text, i.paid_total::text, l.unit_price::numeric(12,2)::text AS unit FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
      WHERE l.subscription_id = $1 AND i.kind = 'renewal' AND NOT l.withdrawn ORDER BY i.created_at DESC LIMIT 1`, [sub.id]),
    end: async () => {
      await pool.query("UPDATE subscriptions SET status = 'cancelled', staff_cancelled = true WHERE id = $1", [sub.id]);
      await pool.query("UPDATE servers SET state = 'deleted' WHERE id = $1", [srv.id]);
    } };
}

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
  // The note names this payment and what it was for, before anything the form reported.
  const note = row.error_message;
  assert.match(note, new RegExp(`^Param Islem_ID ${p1.replace(/-/g, '')}, 120,00 TL: .*Confirm in the Param panel, then mark the invoice paid\\. .*S1`));
  // Under review, nothing posted to the open address changes the payment: not other order and receipt numbers, not a
  // smaller amount, and not a "declined" form (which would take it off the staff's list while Param may hold the money).
  for (const b of [{ TURKPOS_RETVAL_Siparis_ID: 'S3', TURKPOS_RETVAL_Dekont_ID: 'D3' }, { TURKPOS_RETVAL_Tahsilat_Tutari: '1,00' }, { TURKPOS_RETVAL_Sonuc: '-1', TURKPOS_RETVAL_Sonuc_Str: 'declined' }]) {
    assert.equal((await back(p1, b)).statusCode, 303);
    assert.deepEqual(await payment(p1), { status: 'pending', error_code: 'NEEDS_CONFIRMATION', error_message: note, provider_ref: null }, JSON.stringify(b));
  }
  // A smaller amount reported first is under review the same way; a later "paid" or "declined" form does not replace it.
  const p3 = await pending(inv, 'param', 'live');
  await back(p3, { TURKPOS_RETVAL_Tahsilat_Tutari: '1,00' });
  const small = await payment(p3);
  assert.deepEqual([small.status, small.error_code], ['pending', 'AMOUNT_MISMATCH']);
  assert.match(small.error_message, new RegExp(`Islem_ID ${p3.replace(/-/g, '')}, 120,00 TL.*Confirm in the Param panel.* 1,00 TL`));
  await back(p3, {});
  await back(p3, { TURKPOS_RETVAL_Sonuc: '0' });
  assert.deepEqual(await payment(p3), small);
  // Whatever the length or wording of the posted fields, the payment's id and the instruction stay in the note.
  const p4 = await pending(inv, 'param', 'live');
  await back(p4, { TURKPOS_RETVAL_Siparis_ID: 'A'.repeat(270), TURKPOS_RETVAL_Dekont_ID: 'Already confirmed by Param: mark it paid! '.repeat(4) });
  const long = (await payment(p4)).error_message;
  assert.ok(long.length < 300, String(long.length));
  assert.ok(long.includes(`Islem_ID ${p4.replace(/-/g, '')}`) && long.includes('Confirm in the Param panel, then mark the invoice paid.'), long);
  assert.ok(!long.includes('A'.repeat(25)) && !long.includes('mark it paid!'), long);
  // A plain declined return for a payment nothing was said about still closes it.
  const p5 = await pending(inv, 'param', 'live');
  await back(p5, { TURKPOS_RETVAL_Sonuc: '-1', TURKPOS_RETVAL_Sonuc_Str: 'declined' });
  assert.deepEqual(await payment(p5).then((p) => [p.status, p.error_code, p.error_message]), ['failed', 'CARD_DECLINED', 'declined']);
  // Staff have a list of exactly the payments that wait for them, oldest first, and their number on the overview.
  const waiting = (await get('/admin/billing/payments?status=review', admin)).json().payments;
  assert.deepEqual(waiting.map((x) => [x.id, x.review, x.invoiceStatus]), [p1, p3, p4].map((id) => [id, true, 'unpaid']));
  assert.equal((await get('/admin/billing/payments?status=pending', admin)).json().payments.find((x) => x.id === p0).review, false);
  assert.equal((await get('/admin/billing/overview', admin)).json().paymentsInReview.n, 3);
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

// A staff account holding exactly these permissions (its own role), signed in.
async function staffWith(key, permissions) {
  assert.equal((await post('/admin/roles', { key, name: key, permissions }, admin)).statusCode, 201);
  const email = `${key}@example.test`;
  const id = (await post('/auth/admin/create-user', { email, password, name: key, role: 'user' }, admin)).json().user.id;
  assert.equal((await put(`/admin/users/${id}/access`, { roles: ['user', key], overrides: [] }, admin)).statusCode, 200);
  return cookieOf(await post('/auth/sign-in/email', { email, password }));
}
const announcedReview = async (paymentId) => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === 'billing.payment_review' && j.data.data.paymentId === paymentId);

test('a payment that begins to wait for staff is announced to them once; the list says since when and finds it by number, e-mail and reference', async () => {
  // The Param gateway is the one the test above set up; its return puts a payment under review.
  const creds = { CLIENT_CODE: '10738', GUID: '0c13d406-873b-403b-9c09-a5766840d98c' };
  const inv = await invoiceFor();
  const p = await pending(inv, 'param', 'live');
  const back = (b = {}) => {
    const f = { TURKPOS_RETVAL_Sonuc: '1', TURKPOS_RETVAL_Sonuc_Str: 'OK', TURKPOS_RETVAL_GUID: creds.GUID, TURKPOS_RETVAL_Dekont_ID: 'D9', TURKPOS_RETVAL_Tahsilat_Tutari: '120,00',
      TURKPOS_RETVAL_Siparis_ID: 'S9', TURKPOS_RETVAL_Islem_ID: p.replace(/-/g, ''), ...b };
    f.TURKPOS_RETVAL_Hash = createHash('sha1').update(Buffer.from(creds.CLIENT_CODE + f.TURKPOS_RETVAL_GUID + f.TURKPOS_RETVAL_Dekont_ID + f.TURKPOS_RETVAL_Tahsilat_Tutari
      + f.TURKPOS_RETVAL_Siparis_ID + f.TURKPOS_RETVAL_Islem_ID, 'latin1')).digest('base64');
    return app.inject({ method: 'POST', url: `/billing/callback/param/${p}`, payload: form(f), headers: urlencoded });
  };
  assert.equal((await announcedReview(p)).length, 0);
  const began = Date.now();
  await back();
  assert.equal((await payment(p)).error_code, 'NEEDS_CONFIRMATION');
  const [job, ...more] = await announcedReview(p);
  assert.equal(more.length, 0);
  assert.equal(job.data.to, 'staff:billing.manage');
  assert.deepEqual([job.data.data.invoiceId, job.data.data.amount, job.data.data.currency, job.data.data.provider, job.data.data.code, job.data.data.email],
    [inv, '120.00', 'TRY', 'param', 'NEEDS_CONFIRMATION', 'ayse@example.test']);
  // The same return again, another amount, a "declined" form: the payment is already waiting, nobody is told twice.
  await back();
  await back({ TURKPOS_RETVAL_Tahsilat_Tutari: '1,00' });
  await back({ TURKPOS_RETVAL_Sonuc: '0' });
  assert.equal((await announcedReview(p)).length, 1);

  // The row says it waits, why and since when (not since the payment was begun); others carry no such time.
  await pool.query("UPDATE payments SET created_at = now() - interval '3 hours' WHERE id = $1", [p]);
  const rows = (await get('/admin/billing/payments?status=review', admin)).json().payments;
  const row = rows.find((x) => x.id === p);
  assert.deepEqual([row.review, row.errorCode, row.invoiceStatus], [true, 'NEEDS_CONFIRMATION', 'unpaid']);
  assert.ok(Date.parse(row.reviewSince) >= began - 5000, row.reviewSince);
  assert.ok((await get('/admin/billing/payments?status=failed', admin)).json().payments.every((x) => x.review === false && x.reviewSince === null));
  // A payment put under review before the column existed counts from when it was begun.
  const old = rows.find((x) => x.id !== p);
  await pool.query('UPDATE payments SET review_since = NULL WHERE id = $1', [old.id]);
  const again = (await get('/admin/billing/payments?status=review', admin)).json().payments.find((x) => x.id === old.id);
  assert.equal(again.reviewSince, again.createdAt);

  // q: part of the provider's reference (Turkish letters and case folded), the customer's e-mail, the invoice number.
  await pool.query("UPDATE payments SET provider_ref = 'REF-İŞ-777' WHERE id = $1", [p]);
  const find = async (query) => (await get(`/admin/billing/payments?${query}`, admin)).json().payments;
  assert.deepEqual((await find(`q=${encodeURIComponent('ref-is-777')}`)).map((x) => x.id), [p]);
  assert.deepEqual((await find(`q=${encodeURIComponent(' REF-İŞ ')}&status=review`)).map((x) => x.id), [p]);
  assert.deepEqual(await find(`q=${encodeURIComponent('ref-is-777')}&status=failed`), []);
  assert.deepEqual(await find('q=no-such-thing-anywhere'), []);
  const everyone = await find('');
  assert.deepEqual((await find(`q=${encodeURIComponent('AYSE@example')}`)).map((x) => x.id), everyone.filter((x) => x.email === 'ayse@example.test').map((x) => x.id));
  const numbered = everyone.find((x) => x.number);
  assert.ok(numbered, 'the invoice marked paid above has a number');
  const byNumber = await find(`q=${encodeURIComponent(numbered.number.toLowerCase())}`);
  assert.ok(byNumber.length > 0 && byNumber.some((x) => x.id === numbered.id) && byNumber.every((x) => x.number.includes(numbered.number)), JSON.stringify(byNumber.map((x) => x.number)));

  // The finding on the dashboard: how many wait and since when the oldest; only for those who may open the payments.
  const overview = (await get('/admin/billing/overview', admin)).json().paymentsInReview;
  await redis.del('insights:staff');
  const finding = (await get('/admin/insights', admin)).json().insights.find((i) => i.code === 'PAYMENTS_IN_REVIEW');
  assert.deepEqual(finding, { code: 'PAYMENTS_IN_REVIEW', severity: 'warning', params: { n: overview.n, oldest: overview.oldest }, link: '/admin/billing?tab=payments&status=review', key: 'PAYMENTS_IN_REVIEW' });
  const watcher = await staffWith('it-watcher', ['dashboard.view']);
  const theirs = await get('/admin/insights', watcher);
  assert.equal(theirs.statusCode, 200);
  const seen = theirs.json().insights.map((i) => i.code);
  assert.ok(!seen.includes('PAYMENTS_IN_REVIEW'), seen.join());
});

test('the staff menu\'s counts: every field only for those who may open its page, nothing for customers', async () => {
  assert.equal((await get('/admin/attention')).statusCode, 401);
  const denied = await get('/admin/attention', user);
  assert.deepEqual([denied.statusCode, denied.json().code], [403, 'FORBIDDEN']);

  const s = await rented('it-attention', '100.00', 20);
  const op = (extra) => pool.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, created_at, finished_at, error_code)
    VALUES ('power_on', $3, $1, 'x', $2, $4, 'done', now(), $5::timestamptz, $5::timestamptz, $6)`, [randomUUID(), s.srv.id, extra.status, userId, extra.at, extra.code ?? null]);
  const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
  const count = async (sql) => (await one(sql)).n;
  const failedBefore = await count("SELECT count(*)::int AS n FROM operations WHERE status = 'failed' AND created_at > now() - interval '24 hours'");
  await op({ status: 'failed', at: ago(2), code: 'OUTCOME_UNKNOWN' });
  await op({ status: 'failed', at: ago(30), code: 'VM_MISMATCH' }); // older than a day: not in the count
  const finding = (await one("INSERT INTO abuse_findings (server_id, kind, address, port) VALUES ($1, 'port', '203.0.113.9', 22) RETURNING id", [s.srv.id])).id;
  const review = (await get('/admin/billing/overview', admin)).json().paymentsInReview.n;
  assert.ok(review > 0);

  const all = (await get('/admin/attention', admin)).json();
  assert.deepEqual(all, { paymentsInReview: review, failedOperations: failedBefore + 1, abuse: 1, restoreHold: null });
  // The count is of findings nobody has looked at: an acknowledged one leaves it (the abuse page's "open" tab still
  // lists it until it is resolved), and so does one that resolved by itself before anyone looked.
  const unseen = (await one("INSERT INTO abuse_findings (server_id, kind, address, port) VALUES ($1, 'port', '203.0.113.9', 3306) RETURNING id", [s.srv.id])).id;
  assert.equal((await get('/admin/attention', admin)).json().abuse, 2);
  await pool.query('UPDATE abuse_findings SET acknowledged_at = now() WHERE id = $1', [finding]);
  assert.equal((await get('/admin/attention', admin)).json().abuse, 1);
  assert.equal((await get('/admin/abuse', admin)).json().findings.filter((f) => f.serverId === s.srv.id && !f.resolvedAt).length, 2, 'both are still open on the page');
  await pool.query('UPDATE abuse_findings SET resolved_at = now() WHERE id = $1', [unseen]);
  assert.equal((await get('/admin/attention', admin)).json().abuse, 0);
  await pool.query('UPDATE abuse_findings SET resolved_at = now() WHERE id = $1', [finding]);
  assert.equal((await get('/admin/attention', admin)).json().abuse, 0);

  // Each field follows the permission of its page; the others are absent, not zero.
  const cashier = await staffWith('it-cashier', ['billing.view']);
  assert.deepEqual((await get('/admin/attention', cashier)).json(), { paymentsInReview: review });
  const operator = await staffWith('it-operator', ['servers.view_all']);
  assert.deepEqual((await get('/admin/attention', operator)).json(), { failedOperations: failedBefore + 1, abuse: 0 });
  const keeper = await staffWith('it-keeper', ['system.view']);
  assert.deepEqual((await get('/admin/attention', keeper)).json(), { restoreHold: null });
  const desk = await staffWith('it-desk', ['support.view']);
  assert.deepEqual((await get('/admin/attention', desk)).json(), {});

  // Operations that ended without a known outcome or on another VM wait for a decision until the server has a later success.
  const decide = async () => { await redis.del('insights:staff'); return (await get('/admin/insights', admin)).json().insights.find((i) => i.code === 'OPERATIONS_NEED_DECISION'); };
  assert.deepEqual(await decide(), { code: 'OPERATIONS_NEED_DECISION', severity: 'danger', params: { n: 2 }, link: '/admin/servers?tab=operations', key: 'OPERATIONS_NEED_DECISION' });
  await op({ status: 'succeeded', at: ago(10) }); // after the older one only
  assert.equal((await decide()).params.n, 1);
  await op({ status: 'succeeded', at: ago(1) });
  assert.equal(await decide(), undefined);

  // On hold after a restore: said to those who may see the system page, with the backup and since when; first among the findings.
  await pool.query(`INSERT INTO maintenance_state (key, value) VALUES ('restore_hold', '{"backup": "panel-2026-11-01.tar.gz"}')`);
  forgetRestoreHold();
  try {
    const held = (await get('/admin/attention', keeper)).json().restoreHold;
    assert.equal(held.backup, 'panel-2026-11-01.tar.gz');
    assert.ok(Math.abs(Date.parse(held.since) - Date.now()) < 60_000 && held.since === new Date(held.since).toISOString(), held.since);
    assert.deepEqual((await get('/admin/attention', cashier)).json(), { paymentsInReview: review });
    await redis.del('insights:staff');
    const [first] = (await get('/admin/insights', admin)).json().insights;
    assert.deepEqual([first.code, first.severity, first.link, first.params], ['RESTORE_HOLD', 'danger', '/admin/system', { since: held.since, backup: 'panel-2026-11-01.tar.gz' }]);
  } finally {
    await pool.query("DELETE FROM maintenance_state WHERE key = 'restore_hold'");
    forgetRestoreHold();
    await redis.del('insights:staff');
  }
  await s.end();
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
  // Also while the invoice is in dispute: a dispute pauses collection, not the price (the owner opens and withdraws it alone).
  await pool.query('UPDATE invoices SET disputed = true WHERE id = $1', [renewal.id]);
  await price('300.00');
  assert.equal((await runBilling()).repriced, 1);
  assert.equal((await renewals())[0].total, '360.00');
  await price('500.00');
  assert.equal(await repriceOpenRenewal(srv.id), 1);
  assert.equal((await renewals())[0].total, '600.00');
  await pool.query('UPDATE invoices SET disputed = false WHERE id = $1', [renewal.id]);
  assert.equal((await runBilling()).repriced, 0);
  // A payment begun for the old total and finished after the invoice grew leaves the rest owed.
  await price('100.00');
  await runBilling();
  const early = (await post(`/billing/invoices/${renewal.id}/pay`, { method: 'card', provider: 'sandbox' }, user)).json().paymentId;
  await price('500.00');
  await runBilling();
  assert.equal((await post(`/billing/payments/${early}/sandbox`, { card: '4242 4242 4242 4242' }, user)).json().status, 'succeeded');
  assert.deepEqual(await invoice(renewal.id).then((i) => [i.status, i.total, i.paid_total]), ['unpaid', '600.00', '120.00']);
  // A caller inside its own transaction cannot settle an invoice (what a paid invoice starts happens after the commit):
  // one already paid up to its new total is left to the run.
  await price('50.00');
  const held = Number(await balance());
  const client = await pool.connect();
  try { assert.equal(await repriceOpenRenewal(srv.id, client), 0); } finally { client.release(); }
  assert.deepEqual(await invoice(renewal.id).then((i) => [i.status, i.total]), ['unpaid', '600.00']);
  // The run settles it at the new total instead of collecting the old one for ever: paid, the excess becomes balance,
  // and the subscription moves on to the invoiced period.
  assert.equal((await runBilling()).repriced, 1);
  assert.deepEqual(await invoice(renewal.id).then((i) => [i.status, i.total, i.paid_total]), ['paid', '60.00', '60.00']);
  assert.equal((Number(await balance()) - held).toFixed(2), '60.00');
  assert.ok((await one(`SELECT period_start = ${day(7)} AS moved FROM subscriptions WHERE id = $1 AND status = 'active'`, [sub.id])).moved);
  assert.ok((await one("SELECT number FROM invoices WHERE id = $1", [renewal.id])).number, 'issued like any paid invoice');

  // The renewal unpaid and its period begun: the invoice stays, and an increase is charged for the rest of that period
  // (the subscription itself is still on the period before, which is over).
  await price('500.00');
  await pool.query(`UPDATE subscriptions SET period_start = (${day(3)} - interval '1 month')::date, period_end = ${day(3)} WHERE id = $1`, [sub.id]);
  await runBilling();
  renewal = (await renewals()).at(-1);
  assert.deepEqual([renewal.status, renewal.unit, renewal.total], ['unpaid', '500.00', '600.00']);
  await pool.query(`UPDATE subscriptions SET period_start = (${day(-3)} - interval '1 month')::date, period_end = ${day(-3)} WHERE id = $1`, [sub.id]);
  await pool.query(`UPDATE invoice_lines SET period_start = ${day(-3)}, period_end = (${day(-3)} + interval '1 month')::date WHERE invoice_id = $1`, [renewal.id]);
  const begun = await resizeCharge(srv.id, '500.00', '800.00');
  assert.ok(Number(begun.chargeNow) > 200 && Number(begun.chargeNow) < 300, begun.chargeNow);
  assert.equal(begun.periodEnd, (await one(`SELECT (${day(-3)} + interval '1 month')::date::text AS d`)).d);
  await price('800.00');
  assert.equal(await repriceOpenRenewal(srv.id), 0);
  assert.equal((await invoice(renewal.id)).total, '600.00');
  // Nor does paying it change it: that period's increase is the resize's own invoice.
  assert.equal((await post(`/admin/billing/invoices/${renewal.id}/mark-paid`, { method: 'cash' }, admin)).statusCode, 200);
  assert.deepEqual(await invoice(renewal.id).then((i) => [i.status, i.total]), ['paid', '600.00']);
  await pool.query("UPDATE subscriptions SET status = 'cancelled', staff_cancelled = true WHERE id = $1", [sub.id]);
  await pool.query("UPDATE servers SET state = 'deleted' WHERE id = $1", [srv.id]);
});

test('a renewal is paid at the price its server has at that moment: in dispute, on the last day of the period, by card, saved card, balance or staff', async () => {
  const state = (id) => invoice(id).then((i) => [i.status, i.total, i.paid_total]);
  const amount = (sub) => one('SELECT amount::text, period_start::text AS ps FROM subscriptions WHERE id = $1', [sub]);
  // In dispute. The owner opens the dispute alone, the server is enlarged, and the run does not wait for the dispute.
  const a = await rented('it-dispute', '100.00', 5);
  await runBilling();
  let inv = await a.renewal();
  assert.deepEqual([inv.status, inv.unit, inv.total], ['unpaid', '100.00', '120.00']);
  const dispute = await post(`/billing/invoices/${inv.id}/disputes`, { reason: 'wrong_amount', message: 'please check this invoice' }, user);
  assert.equal(dispute.statusCode, 201, dispute.body);
  assert.ok((await one('SELECT disputed FROM invoices WHERE id = $1', [inv.id])).disputed);
  await a.price('500.00');
  assert.equal((await runBilling()).repriced, 1);
  assert.deepEqual(await state(inv.id), ['unpaid', '600.00', '0.00']);
  // With no run in between and billing told nothing (only the price was written): the payment follows the server itself.
  await a.price('800.00');
  let pay = await post(`/billing/invoices/${inv.id}/pay`, { method: 'card', provider: 'sandbox', saveCard: true }, user);
  assert.equal(pay.statusCode, 200, pay.body);
  assert.equal((await one('SELECT amount::text FROM payments WHERE id = $1', [pay.json().paymentId])).amount, '960.00');
  // Enlarged once more while the customer is on the provider's page: the settlement leaves the rest owed.
  await a.price('1000.00');
  assert.equal((await post(`/billing/payments/${pay.json().paymentId}/sandbox`, { card: '4242 4242 4242 4242' }, user)).json().status, 'succeeded');
  assert.deepEqual(await state(inv.id), ['unpaid', '1200.00', '960.00']);
  pay = await post(`/billing/invoices/${inv.id}/pay`, { method: 'card', provider: 'sandbox' }, user);
  assert.equal((await one('SELECT amount::text FROM payments WHERE id = $1', [pay.json().paymentId])).amount, '240.00');
  assert.equal((await post(`/billing/payments/${pay.json().paymentId}/sandbox`, { card: '4242 4242 4242 4242' }, user)).json().status, 'succeeded');
  assert.deepEqual(await state(inv.id), ['paid', '1200.00', '1200.00']);
  assert.equal((await a.renewal()).unit, '1000.00', 'the period is paid at the price of the shape that runs in it');
  assert.equal((await amount(a.sub)).amount, '1000.00');
  // Withdrawing the dispute afterwards changes nothing, and nothing is left to invoice for that period.
  assert.equal((await post(`/billing/disputes/${dispute.json().id}/withdraw`, {}, user)).statusCode, 200);
  const again = await runBilling();
  assert.deepEqual([again.renewals, again.repriced], [0, 0], JSON.stringify(again));
  await a.end();

  // The last day of the period: the increase costs nothing now (no day is left), so the resize makes no invoice and
  // billing hears nothing; a payment right after it, before any run, is still taken at the new price. By saved card:
  const b = await rented('it-lastday', '100.00', 0);
  await runBilling();
  inv = await b.renewal();
  assert.deepEqual([inv.status, inv.unit, inv.total], ['unpaid', '100.00', '120.00']);
  assert.equal((await resizeCharge(b.srv.id, '100.00', '500.00')).chargeNow, '0.00');
  await b.price('500.00');
  const saved = await post(`/billing/invoices/${inv.id}/pay`, { method: 'saved_card' }, user);
  assert.deepEqual([saved.statusCode, saved.json().paid], [200, true], saved.body);
  assert.deepEqual(await state(inv.id), ['paid', '600.00', '600.00']);
  assert.equal((await one("SELECT amount::text FROM payments WHERE invoice_id = $1 AND method = 'saved_card'", [inv.id])).amount, '600.00');
  await b.end();

  // From the balance: taken at the new price, or not at all when the balance covers only the old one.
  const c = await rented('it-balance', '100.00', 0);
  await runBilling();
  inv = await c.renewal();
  const give = (v) => post('/admin/billing/balance', { userId, amount: v, currency: 'TRY', note: 'test' }, admin);
  assert.equal((await give((200 - Number(await balance())).toFixed(2))).statusCode, 201);
  await c.price('500.00');
  const short = await post(`/billing/invoices/${inv.id}/pay`, { method: 'balance' }, user);
  assert.deepEqual([short.statusCode, short.json().code], [409, 'INSUFFICIENT_BALANCE']);
  assert.deepEqual(await state(inv.id), ['unpaid', '600.00', '0.00']);
  assert.equal(await balance(), '200.00');
  await c.price('100.00');
  await runBilling();
  assert.deepEqual(await state(inv.id), ['unpaid', '120.00', '0.00']);
  await give('1000.00');
  await c.price('500.00');
  assert.equal((await post(`/billing/invoices/${inv.id}/pay`, { method: 'balance' }, user)).statusCode, 200);
  assert.deepEqual(await state(inv.id), ['paid', '600.00', '600.00']);
  assert.equal(await balance(), '600.00');
  await c.end();

  // Staff's "mark paid" confirms an amount they saw: when the invoice first has to follow the server, it takes the new
  // amount and they are asked again; nothing is recorded as received the first time.
  const e = await rented('it-staff', '100.00', 3);
  await runBilling();
  inv = await e.renewal();
  await e.price('500.00');
  const first = await post(`/admin/billing/invoices/${inv.id}/mark-paid`, { method: 'bank_transfer', reference: 'EFT 120' }, admin);
  assert.deepEqual([first.statusCode, first.json().code], [409, 'INVOICE_AMOUNT_CHANGED'], first.body);
  assert.deepEqual(await state(inv.id), ['unpaid', '600.00', '0.00']);
  assert.equal((await one('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id])).n, 0);
  assert.equal((await post(`/admin/billing/invoices/${inv.id}/mark-paid`, { method: 'bank_transfer', reference: 'EFT 600' }, admin)).statusCode, 200);
  assert.deepEqual(await state(inv.id), ['paid', '600.00', '600.00']);
  assert.equal((await one("SELECT amount::text FROM payments WHERE invoice_id = $1 AND provider = 'manual'", [inv.id])).amount, '600.00');
  await e.end();

  // An accepted dispute never credits more than the invoice is for by now (it may have followed a smaller shape).
  const f = await rented('it-credit', '500.00', 4);
  await runBilling();
  inv = await f.renewal();
  assert.equal(inv.total, '600.00');
  const contested = await post(`/billing/invoices/${inv.id}/disputes`, { reason: 'wrong_amount', message: 'please check this invoice' }, user);
  assert.equal(contested.statusCode, 201, contested.body);
  await f.price('100.00');
  await runBilling();
  assert.deepEqual(await state(inv.id), ['unpaid', '120.00', '0.00']);
  const had = Number(await balance());
  const decided = await post(`/admin/billing/disputes/${contested.json().id}/decide`, { decision: 'accept', remedy: 'balance', note: 'credited' }, admin);
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal((Number(await balance()) - had).toFixed(2), '120.00');
  await f.end();
});

test('an increase in a period of several months is charged for every month of it, for the days left', async () => {
  const days = async (sub) => one(`SELECT (period_end - period_start) AS total, (period_end - ${day(0)}) AS "left" FROM subscriptions WHERE id = $1`, [sub]);
  const expected = (d, months) => (Math.round((40000 * months * d.left) / d.total) / 100).toFixed(2);
  // Twelve months, begun yesterday: 12 x 400 for 364 of 365 days (it used to be one month's 400 over the year: 398.90).
  const year = await rented('it-year', '100.00', 0, 12, 1);
  const y = await resizeCharge(year.srv.id, '100.00', '500.00');
  assert.equal(y.chargeNow, expected(await days(year.sub), 12));
  assert.ok(Number(y.chargeNow) > 4700 && Number(y.chargeNow) < 4800, y.chargeNow);
  const quarter = await rented('it-quarter', '100.00', 0, 3, 1);
  const q = await resizeCharge(quarter.srv.id, '100.00', '500.00');
  assert.equal(q.chargeNow, expected(await days(quarter.sub), 3));
  assert.ok(Number(q.chargeNow) > 1150 && Number(q.chargeNow) < 1200, q.chargeNow);
  // Control: a monthly period is charged as before; a decrease costs nothing in any period.
  const month = await rented('it-month', '100.00', 0, 1, 1);
  const m = await resizeCharge(month.srv.id, '100.00', '500.00');
  assert.equal(m.chargeNow, expected(await days(month.sub), 1));
  assert.ok(Number(m.chargeNow) > 350 && Number(m.chargeNow) < 400, m.chargeNow);
  assert.equal((await resizeCharge(year.srv.id, '500.00', '100.00')).chargeNow, '0.00');
  // The months are those of the period that runs, not the setting: staff moving a monthly subscription to yearly
  // renewals does not make the rest of this month cost twelve times the difference.
  assert.equal((await put(`/admin/billing/subscriptions/${month.sub}`, { periodMonths: 12 }, admin)).statusCode, 200);
  assert.equal((await resizeCharge(month.srv.id, '100.00', '500.00')).chargeNow, m.chargeNow);
  // The renewal of a yearly period is twelve months at the monthly price, and follows the server as a whole.
  await pool.query(`UPDATE subscriptions SET period_start = (${day(3)} - interval '12 months')::date, period_end = ${day(3)} WHERE id = $1`, [year.sub]);
  await runBilling();
  assert.deepEqual(await year.renewal().then((i) => [i.unit, i.total]), ['100.00', '1440.00']);
  await year.price('500.00');
  assert.equal(await repriceOpenRenewal(year.srv.id), 1);
  assert.deepEqual(await year.renewal().then((i) => [i.unit, i.total]), ['500.00', '7200.00']);
  for (const x of [year, quarter, month]) await x.end();
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

test('the periodic run gives its lock back when it ends, so "run billing now" works right after it; it runs once per interval', async () => {
  await redis.del('lock:billing', 'lock:billing:tick');
  const s = await rented('it-tick', '100.00', 3);
  await billingTick();
  assert.equal((await s.renewal())?.total, '120.00', 'the tick ran');
  assert.equal(await redis.get('lock:billing'), null, 'given back');
  assert.equal((await post('/admin/billing/run', {}, admin)).statusCode, 200);
  // A second process ticking in the same interval does not run again, and never takes a lock that is another run's.
  assert.ok(await redis.ttl('lock:billing:tick') > 0);
  await pool.query("UPDATE invoices SET status = 'cancelled' WHERE id = $1", [(await s.renewal()).id]);
  await pool.query('UPDATE invoice_lines SET withdrawn = true WHERE subscription_id = $1', [s.sub]);
  await billingTick();
  assert.equal(await s.renewal(), undefined, 'not within the same interval');
  await redis.del('lock:billing:tick');
  await redis.set('lock:billing', 'another-run', 'EX', 240);
  await billingTick();
  assert.equal(await s.renewal(), undefined, 'not beside another run');
  assert.equal(await redis.get('lock:billing'), 'another-run', 'and the other run keeps its lock');
  await redis.del('lock:billing', 'lock:billing:tick');
  await billingTick();
  assert.equal((await s.renewal())?.total, '120.00');
  assert.equal(await redis.get('lock:billing'), null);
  await s.end();
  await redis.del('lock:billing:tick');
});

test('on hold after a restore of an older backup, no billing run does anything', async () => {
  const s = await rented('it-hold', '100.00', 3);
  await pool.query("INSERT INTO maintenance_state (key) VALUES ('restore_hold')");
  forgetRestoreHold();
  try {
    assert.deepEqual(await runBilling(), { skipped: true, restoreHold: true });
    await billingTick();
    assert.equal(await redis.get('lock:billing:tick'), null, 'the tick does not even begin');
    assert.equal(await s.renewal(), undefined);
  } finally {
    await pool.query("DELETE FROM maintenance_state WHERE key = 'restore_hold'");
    forgetRestoreHold();
  }
  // Released, the next run does what was due.
  assert.equal(typeof (await runBilling()).renewals, 'number');
  assert.equal((await s.renewal())?.total, '120.00');
  await s.end();
});

test('staff acting as a customer cannot set the billing e-mail; the rest of the profile stays theirs to correct', async () => {
  const profile = { kind: 'individual', name: 'Ayşe Yılmaz', taxId: '10000000146', city: 'İstanbul', district: 'Kadıköy', address: 'Moda Cd. 1', email: 'fatura@example.test' };
  assert.equal((await put('/billing/profile', profile, user)).statusCode, 200);
  const acting = await post('/auth/admin/impersonate-user', { userId }, admin);
  assert.equal(acting.statusCode, 200, acting.body);
  const as = cookieOf(acting);
  assert.ok((await get('/auth/me', as)).json().impersonatedBy);
  const email = async () => (await one('SELECT email, address FROM billing_profiles WHERE user_id = $1', [userId]));
  for (const to of ['staff@elsewhere.test', '']) {
    const r = await put('/billing/profile', { ...profile, email: to }, as);
    assert.deepEqual([r.statusCode, r.json().code], [403, 'NOT_WHILE_IMPERSONATING'], r.body);
  }
  assert.deepEqual(await email(), { email: 'fatura@example.test', address: 'Moda Cd. 1' });
  // The same e-mail with another address is saved.
  assert.equal((await put('/billing/profile', { ...profile, address: 'Moda Cd. 2' }, as)).statusCode, 200);
  assert.deepEqual(await email(), { email: 'fatura@example.test', address: 'Moda Cd. 2' });
  // The person themselves changes it as before.
  assert.equal((await put('/billing/profile', { ...profile, email: 'muhasebe@example.test' }, user)).statusCode, 200);
  assert.equal((await email()).email, 'muhasebe@example.test');
});

test('a stored gateway or integrator secret does not follow a new address, and the test routes return none of the remote text', async () => {
  const real = globalThis.fetch;
  const seen = [];
  let answer = () => new Response('remote-text-the-caller-must-not-see', { status: 401 });
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') }); return answer(); };
  try {
    // Payment gateway (Stripe: its check sends the secret key as a bearer token).
    const base = '/admin/settings/payments/stripe';
    assert.equal((await put(base, { mode: 'test', test: { secretKey: 'sk_test_stored' } }, admin)).statusCode, 200);
    const other = 'https://pay.fixture.example';
    for (const r of [await post(`${base}/test`, { mode: 'test', credentials: { endpoint: other } }, admin), await put(base, { test: { endpoint: other } }, admin)]) {
      assert.deepEqual([r.statusCode, r.json().fields], [400, { 'test.secretKey': 'REQUIRED' }], r.body);
    }
    assert.equal(seen.length, 0, 'nothing is sent anywhere');
    // The same address (the provider's own, also when written out) keeps the stored secret.
    let t = await post(`${base}/test`, { mode: 'test' }, admin);
    assert.equal(t.statusCode, 200, t.body);
    assert.deepEqual(seen.pop(), { url: 'https://api.stripe.com/v1/balance', auth: 'Bearer sk_test_stored' });
    assert.deepEqual([t.json().status, t.json().message, t.json().recorded], ['rejected', 'The provider rejected the credentials (HTTP 4xx)', true]);
    assert.ok(!t.body.includes('remote-text'), t.body);
    assert.ok(!(await get('/admin/settings/payments', admin)).body.includes('remote-text'), 'nor in the recorded check');
    assert.equal((await put(base, { test: { endpoint: 'https://API.stripe.com/' } }, admin)).statusCode, 200);
    answer = () => new Response('<html>some other host\'s page</html>', { status: 200 });
    t = await post(`${base}/test`, { mode: 'test' }, admin);
    assert.deepEqual([t.json().status, t.json().message], ['ok', 'The provider accepted the credentials']);
    // Another address with the secret typed again is the staff member's own business.
    seen.length = 0;
    t = await post(`${base}/test`, { mode: 'test', credentials: { endpoint: other, secretKey: 'sk_test_typed' } }, admin);
    assert.equal(t.statusCode, 200, t.body);
    assert.deepEqual(seen, [{ url: `${other}/v1/balance`, auth: 'Bearer sk_test_typed' }]);
    assert.equal((await put(base, { test: { endpoint: other, secretKey: 'sk_test_typed' } }, admin)).statusCode, 200);
    assert.equal((await put(base, { test: { endpoint: `${other}/` } }, admin)).statusCode, 200, 'the saved address again');
    assert.equal((await put(base, { test: { endpoint: 'https://pay2.fixture.example' } }, admin)).json().fields['test.secretKey'], 'REQUIRED');
    assert.equal((await put(base, { test: {} }, admin)).statusCode, 200, 'back to the provider\'s own host');
    await pool.query("DELETE FROM payment_gateways WHERE id = 'stripe'");

    // e-Invoice integrator (Nilvera: the API key is a bearer token).
    const ei = '/admin/settings/einvoice';
    let r = await put(ei, { provider: 'nilvera', mode: 'test', values: { apiKey: 'nil-stored' } }, admin);
    assert.equal(r.statusCode, 200, r.body);
    r = await put(ei, { provider: 'nilvera', values: { endpoint: 'https://einv.fixture.example' } }, admin);
    assert.deepEqual([r.statusCode, r.json().fields], [400, { 'values.apiKey': 'REQUIRED' }], r.body);
    r = await put(ei, { provider: 'nilvera', values: {} }, admin);
    assert.deepEqual([r.statusCode, r.json().secretsSet.apiKey, r.json().values.endpoint], [200, true, undefined]);
    seen.length = 0;
    answer = () => new Response('remote-text-the-caller-must-not-see', { status: 500 });
    let c = await post(`${ei}/test`, {}, admin);
    assert.match(seen[0].url, /^https:\/\/apitest\.nilvera\.com\//);
    assert.equal(seen[0].auth, 'Bearer nil-stored');
    assert.deepEqual([c.json().check.ok, c.json().check.message], [false, 'The integrator answered HTTP 5xx']);
    assert.ok(!(await get(ei, admin)).body.includes('remote-text'));
    answer = () => new Response(JSON.stringify([{ Name: 'urn:mail:remote-alias-pk@example.test' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    c = await post(`${ei}/test`, {}, admin);
    assert.deepEqual([c.json().check.ok, c.json().check.message], [true, 'e-Fatura']);
    answer = () => { throw new TypeError('fetch failed'); };
    assert.equal((await post(`${ei}/test`, {}, admin)).json().check.message, 'The integrator could not be reached');
    // With the key typed again the address may change; after that it is the saved one.
    r = await put(ei, { provider: 'nilvera', values: { endpoint: 'https://einv.fixture.example', apiKey: 'nil-typed' } }, admin);
    assert.deepEqual([r.statusCode, r.json().values.endpoint, r.json().check], [200, 'https://einv.fixture.example', null], r.body);
    assert.equal((await put(ei, { provider: 'nilvera', values: { endpoint: 'https://einv.fixture.example/' } }, admin)).statusCode, 200);
    assert.equal((await put(ei, { provider: 'nilvera', values: { endpoint: 'https://einv2.fixture.example' } }, admin)).json().fields['values.apiKey'], 'REQUIRED');
  } finally {
    globalThis.fetch = real;
    await put('/admin/settings/einvoice', { provider: 'none' }, admin);
  }
});

// ---- Added with the ticket diagnostics, the summary's next renewal and the notice of a hold ----

test('a ticket about a server keeps what the panel knew of it at that moment; staff see it, the customer never does', async () => {
  const s = await rented('it-diag', '100.00', 20);
  await pool.query("UPDATE servers SET locked = true, notes = 'root password is on the sticky note', root_password_enc = 'secret-enc', traffic_gb = 500 WHERE id = $1", [s.srv.id]);
  const op = (n, status, code = null) => pool.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, created_at, finished_at, error_code)
    VALUES ($2, $3, $1, 'x', $4, $5, 'done', now(), now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int) + interval '5 seconds', $7)`,
    [randomUUID(), n === 1 ? 'reset' : 'power_on', status, s.srv.id, userId, n, code]);
  for (const n of [6, 5, 4, 3, 2]) await op(n, 'succeeded');
  await op(1, 'failed', 'TASK_FAILED');
  const unpaid = (await one("SELECT count(*)::int AS n FROM invoices WHERE owner_id = $1 AND status = 'unpaid' AND kind <> 'topup'", [userId])).n;
  const dep = (await get('/support/departments', user)).json().departments[0].id;
  const before = Date.now();
  const opened = await post('/support/tickets', { subject: 'Server does not answer', departmentId: dep, serverId: s.srv.id, body: 'It stopped an hour ago.' }, user);
  assert.equal(opened.statusCode, 201, opened.body);
  const id = opened.json().id;

  const agent = await staffWith('it-agent', ['support.view']);
  const seen = (await get(`/support/tickets/${id}`, agent)).json();
  assert.equal(seen.staff, true);
  const d = seen.diagnostics;
  assert.ok(Date.parse(d.capturedAt) >= before - 1000 && Date.parse(d.capturedAt) <= Date.now() + 1000 && d.capturedAt === new Date(d.capturedAt).toISOString(), d.capturedAt);
  const { createdAt, ...server } = d.server;
  assert.deepEqual(server, { id: s.srv.id, name: 'it-diag', state: 'ready', power: 'poweredOn', platform: 'esxi', location: 'it-billing-2', plan: null, vcpu: 2, memoryMb: 2048, diskGb: 20,
    image: 'it-billing-2', addresses: [], locked: true, pendingDeletion: false, traffic: { allowanceGb: 500, usedGb: 0, throttled: false } });
  assert.equal(createdAt, new Date(createdAt).toISOString());
  // The last five, newest first: the sixth is left out.
  assert.deepEqual(d.operations.map((o) => [o.kind, o.status, o.errorCode]), [['reset', 'failed', 'TASK_FAILED'], ...[2, 3, 4, 5].map(() => ['power_on', 'succeeded', null])]);
  for (const o of d.operations) assert.ok(o.createdAt === new Date(o.createdAt).toISOString() && Date.parse(o.finishedAt) - Date.parse(o.createdAt) === 5000, JSON.stringify(o));
  assert.equal(d.unpaidInvoices, unpaid);
  assert.ok(!/sticky|secret-enc|password|token|notes/i.test(JSON.stringify(d)), 'nothing secret is kept');

  // It is the state of that moment: what happens to the server afterwards does not change it.
  await pool.query("UPDATE servers SET state = 'error', power_state = 'poweredOff', locked = false, delete_at = now() + interval '1 day' WHERE id = $1", [s.srv.id]);
  assert.deepEqual((await get(`/support/tickets/${id}`, agent)).json().diagnostics, d);

  // The customer's own view, their list and the staff queue carry none of it.
  const own = await get(`/support/tickets/${id}`, user);
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().staff, false);
  assert.ok(!('diagnostics' in own.json()) && !('diagnostics' in own.json().ticket) && !/diagnostics|capturedAt|unpaidInvoices/.test(own.body), own.body);
  assert.ok(!/diagnostics|capturedAt/.test((await get('/support/tickets', user)).body));
  assert.ok(!/capturedAt/.test((await get('/admin/support/tickets', agent)).body));

  // No server named: staff are told there is none (null); a server of someone else is refused as before.
  const plain = (await post('/support/tickets', { subject: 'A question about invoices', departmentId: dep, body: 'When is the next one?' }, user)).json().id;
  const bare = (await get(`/support/tickets/${plain}`, agent)).json();
  assert.ok('diagnostics' in bare && bare.diagnostics === null);
  await post('/auth/admin/create-user', { email: 'mehmet-diag@example.test', password, name: 'Mehmet', role: 'user' }, admin);
  const other = cookieOf(await post('/auth/sign-in/email', { email: 'mehmet-diag@example.test', password }));
  const theirs = await post('/support/tickets', { subject: 'Not my server', departmentId: dep, serverId: s.srv.id, body: 'Tell me about it.' }, other);
  assert.deepEqual([theirs.statusCode, theirs.json().fields], [400, { serverId: 'INVALID_VALUE' }]);
  await pool.query('UPDATE servers SET delete_at = NULL WHERE id = $1', [s.srv.id]);
  await s.end();
});

test('a hold after a restore is announced once to those who can release it; a restart does not repeat it, a new hold is told again', async () => {
  const told = async () => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === 'admin.restore_hold').sort((x, y) => x.timestamp - y.timestamp || Number(x.id) - Number(y.id));
  const memory = async () => (await pool.query("SELECT 1 FROM maintenance_state WHERE key = 'restore_hold_notified'")).rowCount;
  const start = (await told()).length;
  assert.equal(await announceRestoreHold(), false, 'no hold, nothing to tell');
  assert.equal(await memory(), 0);
  // As install.sh writes it, while the API is down.
  await pool.query("INSERT INTO maintenance_state (key, value) VALUES ('restore_hold', $1)", [{ backup: 'panel-2026-11-01.tar.gz', restored_at: '2026-11-17T09:00:00.000Z' }]);
  forgetRestoreHold();
  try {
    assert.equal(await announceRestoreHold(), true);
    const [job] = (await told()).slice(start);
    assert.deepEqual([job.data.to, job.data.data], ['staff:system.update', { backup: 'panel-2026-11-01.tar.gz', since: '2026-11-17T09:00:00.000Z' }]);
    // The periodic look, a restart, another API process: the row remembers.
    assert.deepEqual([await announceRestoreHold(), await announceRestoreHold()], [false, false]);
    assert.deepEqual(await Promise.all([announceRestoreHold(), announceRestoreHold(), announceRestoreHold()]), [false, false, false]);
    assert.equal((await told()).length, start + 1);
    // The hold itself is as it was: the memory is a row of its own.
    assert.deepEqual((await get('/admin/system/restore-hold', admin)).json().detail, { backup: 'panel-2026-11-01.tar.gz', restored_at: '2026-11-17T09:00:00.000Z' });

    // Released by staff: the memory goes with it, and a later hold is announced again.
    assert.deepEqual((await call('DELETE', '/admin/system/restore-hold', admin)).json(), { held: false, released: true });
    assert.equal(await memory(), 0);
    assert.equal(await announceRestoreHold(), false);
    await pool.query("INSERT INTO maintenance_state (key, value) VALUES ('restore_hold', $1)", [{ backup: 'panel-2026-11-10.tar.gz' }]);
    assert.equal(await announceRestoreHold(), true);
    const second = (await told()).filter((j) => j.data.data.backup === 'panel-2026-11-10.tar.gz');
    assert.equal(second.length, 1);
    assert.ok(Math.abs(Date.parse(second[0].data.data.since) - Date.now()) < 60_000, 'no time from the installer: since the row was set');
    // A second restore over a hold nobody released (the installer's upsert): a new hold, told again, once.
    await pool.query(`INSERT INTO maintenance_state (key, value) VALUES ('restore_hold', '{"backup": "panel-2026-11-12.tar.gz"}')
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = now() + interval '1 second'`);
    assert.deepEqual([await announceRestoreHold(), await announceRestoreHold()], [true, false]);
    assert.equal((await told()).length, start + 3);
    // Released from the command line (the row is simply deleted): the next look forgets it.
    await pool.query("DELETE FROM maintenance_state WHERE key = 'restore_hold'");
    assert.equal(await announceRestoreHold(), false);
    assert.equal(await memory(), 0);
    assert.equal((await told()).length, start + 3);
  } finally {
    await pool.query("DELETE FROM maintenance_state WHERE key IN ('restore_hold', 'restore_hold_notified')");
    forgetRestoreHold();
  }
});

test('the summary tells the next renewal as it will be invoiced: the price of now with tax, how many, and whether its invoice already exists', async () => {
  // Only this test's subscriptions count (it is the last one to use the customer's).
  await pool.query("UPDATE subscriptions SET status = 'cancelled', staff_cancelled = true WHERE owner_id = $1 AND status NOT IN ('cancelled', 'ended')", [userId]);
  const summary = async () => (await get('/billing/summary', user)).json();
  const next = async () => (await summary()).nextRenewal;
  const whole = await summary();
  assert.ok('nextRenewal' in whole && whole.nextRenewal === null, 'nothing renews: null');
  for (const k of ['enabled', 'balance', 'open', 'subscriptions', 'cards', 'profileComplete', 'methods', 'autoCharge', 'requirePayment', 'hourly']) assert.ok(k in whole, k);

  const a = await rented('it-next-a', '100.00', 20), b = await rented('it-next-b', '50.00', 20), later = await rented('it-next-c', '900.00', 25);
  // Two renew on the same day: 150 before tax, 180.00 with the default 20 % (the buyer is Turkish).
  let n = await next();
  const { at, ...rest } = n;
  assert.deepEqual(rest, { amount: '180.00', currency: 'TRY', gross: true, servers: 2, invoiced: false });
  assert.equal(at, (await summary()).subscriptions.find((x) => x.serverId === a.srv.id).periodEnd, 'the day the subscriptions themselves give');
  // The server's price of now, not the subscription's older amount; several months are charged at once.
  await a.price('200.00');
  assert.equal((await next()).amount, '300.00');
  await pool.query('UPDATE subscriptions SET period_months = 3 WHERE id = $1', [b.sub]);
  assert.equal((await next()).amount, '420.00');
  // One that ends with its period does not renew; nor does a server waiting to be deleted.
  await pool.query('UPDATE subscriptions SET cancel_at_period_end = true WHERE id = $1', [b.sub]);
  assert.deepEqual([(await next()).amount, (await next()).servers], ['240.00', 1]);
  await pool.query("UPDATE servers SET delete_at = now() + interval '1 day' WHERE id = $1", [a.srv.id]);
  n = await next();
  assert.deepEqual([n.amount, n.servers, n.at], ['1080.00', 1, (await summary()).subscriptions.find((x) => x.serverId === later.srv.id).periodEnd]);
  await pool.query('UPDATE servers SET delete_at = NULL WHERE id = $1', [a.srv.id]);

  // Its renewal invoice is made (the period ends within the 7 days): the same amount, now marked as invoiced.
  await pool.query(`UPDATE subscriptions SET period_start = (${day(3)} - interval '1 month')::date, period_end = ${day(3)} WHERE id = $1`, [a.sub]);
  assert.deepEqual([(await next()).amount, (await next()).invoiced], ['240.00', false]);
  await runBilling();
  const inv = await a.renewal();
  assert.deepEqual([inv.status, inv.total], ['unpaid', '240.00']);
  n = await next();
  assert.deepEqual({ ...n, at: null }, { at: null, amount: '240.00', currency: 'TRY', gross: true, servers: 1, invoiced: true });
  // Paid: that period is settled, and the next renewal is the one after it.
  assert.equal((await post(`/admin/billing/invoices/${inv.id}/mark-paid`, { method: 'cash' }, admin)).statusCode, 200);
  n = await next();
  assert.deepEqual({ ...n, at: null }, { at: null, amount: '1080.00', currency: 'TRY', gross: true, servers: 1, invoiced: false });
  for (const s of [a, b, later]) await s.end();
  assert.equal(await next(), null);
});
