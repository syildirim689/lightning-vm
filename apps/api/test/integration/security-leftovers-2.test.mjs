// What the leftovers round still left open, against real PostgreSQL and Redis. No hypervisor, adapter, payment or
// directory server: servers, subscriptions and held payments are rows written here, operations stop where the API
// queues them (a worker beside the tests cannot load them, as in security-leftovers.test.mjs).
//   - a payment that waits for staff keeps its invoice from suspension, termination and order expiry, and from being
//     paid a second time, for the review window (Settings → Billing, reviewHoldDays) and no longer;
//   - an account starts only so many card payments an hour;
//   - an API token of a directory or single sign-on account sleeps when the account was not confirmed recently;
//   - the time an operation waits for its account's share of the worker's slots is given back to its deadline (the
//     worker's own statements, run against this database);
//   - what a reseller does on a customer's server besides operations is in the customer's activity, and nobody can
//     write into somebody else's activity through a request body;
//   - leaving a reseller takes the reseller's discount off the prices, only where that can be told; a removal billing
//     decided for a server whose subscription had ended stays; neither leaving nor accepting a server is done by staff
//     acting as the person.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const { runBilling, paymentsPerHour } = await import('../../dist/billing.js');

let app, admin, site;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie, headers) => call('POST', url, cookie, payload, headers);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const del = (url, cookie) => call('DELETE', url, cookie);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); }; // several accounts are made from one address
const signUp = async (email, name = '') => { await freshLimits(); const r = await post('/auth/sign-up/email', { name, email, password }); assert.equal(r.statusCode, 200, r.body); return [cookieOf(r), r.json().user.id]; };
const company = { name: 'Lightning Bilişim A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy', address: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul' };
const billing = { enabled: true, company, autoCharge: false, invoiceDaysBefore: 7, balance: true, sandbox: true, suspendAfterDays: 3, terminateAfterDays: 0, reviewHoldDays: 7 };
const setBilling = async (over = {}) => assert.equal((await put('/admin/settings/billing', { ...billing, ...over }, admin)).statusCode, 200);
const day = (n) => `((now() AT TIME ZONE 'Europe/Istanbul')::date + ${n})`;
// A ready, stopped server as a finished order leaves it.
const server = async (ownerId, name, extra = {}) => {
  const cols = { owner_id: ownerId, pool_id: site.pool, image_id: site.image, name, vcpu: 2, memory_mb: 2048, disk_gb: 20, price_monthly: '80.00', currency: 'TRY', state: 'ready', power_state: 'poweredOff', vm_moref: `vm-${name}`, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO servers (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
// The server's running subscription, paid by `payerId`; its period ends in `ends` days.
const subscription = async (payerId, serverId, ends, amount = '80.00', status = 'active') => (await one(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_months, period_start, period_end)
  VALUES ($1, 'server', $2, 'Sunucu', $3, 'TRY', $4, 1, (${day(ends)} - interval '1 month')::date, ${day(ends)}) RETURNING id`, [payerId, serverId, amount, status])).id;
const sub = (id) => one('SELECT owner_id, status, amount::text, suspended_at FROM subscriptions WHERE id = $1', [id]);
// The open (not withdrawn) renewal invoice of a subscription.
const renewal = (subId) => one(`SELECT i.id, i.owner_id, i.status, i.total::text, l.unit_price::numeric(12,2)::text AS unit FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
  WHERE l.subscription_id = $1 AND i.kind = 'renewal' AND NOT l.withdrawn ORDER BY i.created_at DESC LIMIT 1`, [subId]);
// A payment as a provider's "held for review" answer leaves it (billing.ts, noteReview): open, with the reason on it,
// waiting since `days` days.
const held = async (invoiceId, ownerId, days = 0, code = 'FRAUD_REVIEW') => (await one(`INSERT INTO payments (invoice_id, owner_id, provider, mode, method, status, amount, currency, error_code, error_message, review_since)
  SELECT i.id, $2, 'iyzico', 'live', 'card', 'pending', i.total, i.currency, $4, 'held by the provider', now() - make_interval(days => $3) FROM invoices i WHERE i.id = $1 RETURNING id`, [invoiceId, ownerId, days, code])).id;
const waitsSince = (paymentId, days) => pool.query('UPDATE payments SET review_since = now() - make_interval(days => $2) WHERE id = $1', [paymentId, days]);
const queued = async (event, userId) => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === event && j.data.to.includes(userId));
const reseller = async (email, body = { discountPct: 20 }) => {
  const [cookie, id] = await signUp(email, 'Acme Hosting');
  assert.equal((await put(`/admin/resellers/${id}`, body, admin)).statusCode, 200);
  return [cookie, id];
};
const customerOf = async (resellerId, email) => {
  const [cookie, id] = await signUp(email);
  await pool.query('UPDATE users SET reseller_id = $2 WHERE id = $1', [id, resellerId]);
  return [cookie, id];
};
const activity = async (cookie) => (await get('/activity', cookie)).json().events;
const impersonate = async (userId) => { const r = await post('/auth/admin/impersonate-user', { userId }, admin); assert.equal(r.statusCode, 200, r.body); return cookieOf(r); };

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
  // A worker on this database (run.sh) must leave the queued operations alone: it cannot read this connection's password,
  // so it fails while loading an operation, before it writes anything (as in security-servers.test.mjs).
  const conn = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, 'it-leftovers-2', 'esxi', 'esxi.leftovers2.test', 'root', $2, 'system', '{}', 'unknown')`, [conn, encryptSecret('pw', 'not-this-connection')]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref, extra_disk_price_gb) VALUES ('it-leftovers-2', $1, 'ha-1', '{ds-1}', 'net-1', 0.5) RETURNING id`, [conn]);
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-leftovers-2', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  // The catalog's price for the shape the servers here have: 100.00 a month.
  const pkg = await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('it-leftovers-2', 2, 2048, 20, 100, 'TRY') RETURNING id");
  site = { pool: rp.id, image: img.id, pkg: pkg.id };
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('a payment under review keeps its invoice from suspension and termination, for the review window and no longer', async () => {
  const [, id] = await signUp('held-dunning@example.test');
  const srv = await server(id, 'held-1');
  const s = await subscription(id, srv, 3);
  await runBilling();
  const inv = await renewal(s);
  assert.equal(inv.status, 'unpaid');
  // Five days past its due date: suspension is due (after 3 days).
  await pool.query("UPDATE invoices SET due_at = now() - interval '5 days' WHERE id = $1", [inv.id]);
  const pay = await held(inv.id, id);

  // The setting: 0 to 90 days, 7 unless set.
  assert.equal((await get('/admin/settings/billing', admin)).json().billing.reviewHoldDays, 7);
  const bad = await put('/admin/settings/billing', { ...billing, reviewHoldDays: 91 }, admin);
  assert.deepEqual([bad.statusCode, bad.json().fields.reviewHoldDays], [400, 'OUT_OF_RANGE']);

  // Under review since today: not suspended, the server is not held; the overdue notice goes out once and says the
  // payment is being checked.
  let out = await runBilling();
  assert.deepEqual([out.suspended, out.overdue], [0, 1]);
  assert.equal((await sub(s)).status, 'past_due');
  assert.equal((await one('SELECT billing_hold FROM servers WHERE id = $1', [srv])).billing_hold, false);
  const [notice] = await queued('billing.overdue', id);
  assert.equal(notice.data.data.review, 'true');
  out = await runBilling();
  assert.deepEqual([out.suspended, out.overdue], [0, 0]);

  // Nobody decided for longer than the window: the invoice is collected like any other again.
  await waitsSince(pay, 8);
  out = await runBilling();
  assert.equal(out.suspended, 1);
  assert.equal((await sub(s)).status, 'suspended');
  assert.equal((await one('SELECT billing_hold FROM servers WHERE id = $1', [srv])).billing_hold, true);

  // Termination (after one day suspended) waits the same way: a payment that came under review today shelters it...
  await setBilling({ terminateAfterDays: 1 });
  await pool.query("UPDATE subscriptions SET suspended_at = now() - interval '3 days' WHERE id = $1", [s]);
  await waitsSince(pay, 0);
  out = await runBilling();
  assert.equal(out.terminated, 0);
  assert.deepEqual([(await sub(s)).status, (await one('SELECT status FROM invoices WHERE id = $1', [inv.id])).status], ['suspended', 'unpaid']);
  // ... with the window switched off it does not ...
  await setBilling({ terminateAfterDays: 1, reviewHoldDays: 0 });
  out = await runBilling();
  assert.equal(out.terminated, 1);
  assert.equal((await sub(s)).status, 'ended');
  assert.equal((await one('SELECT billing_remove FROM servers WHERE id = $1', [srv])).billing_remove, 'terminate');
  await setBilling();
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE server_id = $1", [srv]);

  // A review that staff closed shelters nothing: the next run suspends.
  const [, id2] = await signUp('held-closed@example.test');
  const srv2 = await server(id2, 'held-2');
  const s2 = await subscription(id2, srv2, 3);
  await runBilling();
  const inv2 = await renewal(s2);
  await pool.query("UPDATE invoices SET due_at = now() - interval '5 days' WHERE id = $1", [inv2.id]);
  const pay2 = await held(inv2.id, id2);
  await runBilling();
  assert.equal((await sub(s2)).status, 'past_due');
  assert.equal((await post(`/admin/billing/payments/${pay2}/close-review`, { note: 'nothing arrived' }, admin)).statusCode, 200);
  await runBilling();
  assert.equal((await sub(s2)).status, 'suspended');
});

test('an order whose payment is under review does not expire within the window', async () => {
  const [, id] = await signUp('held-order@example.test');
  const srv = await server(id, 'held-order', { state: 'provisioning', vm_moref: null });
  const s = await subscription(id, srv, 30, '80.00', 'pending');
  const inv = (await one(`INSERT INTO invoices (owner_id, kind, status, currency, subtotal, tax_total, total, due_at, buyer, seller)
    VALUES ($1, 'order', 'unpaid', 'TRY', 80, 16, 96, now() - interval '1 hour', '{}', '{}') RETURNING id`, [id])).id;
  await pool.query(`INSERT INTO invoice_lines (invoice_id, subscription_id, description, quantity, unit, unit_price, tax_rate, net, tax, gross, sort) VALUES ($1, $2, 'Sunucu', 1, 'MON', 80, 20, 80, 16, 96, 0)`, [inv, s]);
  const pay = await held(inv, id);
  let out = await runBilling();
  assert.equal(out.expired, 0);
  assert.deepEqual([(await one('SELECT status FROM invoices WHERE id = $1', [inv])).status, (await sub(s)).status], ['unpaid', 'pending']);
  await waitsSince(pay, 8);
  out = await runBilling();
  assert.equal(out.expired, 1);
  assert.deepEqual([(await one('SELECT status FROM invoices WHERE id = $1', [inv])).status, (await sub(s)).status], ['cancelled', 'cancelled']);
});

test('an invoice with a payment under review cannot be paid a second time, by any method; after the window it can; card payments have an hourly budget', async () => {
  const [c, id] = await signUp('held-pay@example.test');
  const invoiceId = (await post('/admin/billing/invoices', { userId: id, currency: 'TRY', lines: [{ description: 'Hizmet', unitPrice: '100' }] }, admin)).json().invoiceId;
  assert.equal((await post('/admin/billing/balance', { userId: id, currency: 'TRY', amount: '500.00', note: 'it: covers the invoice' }, admin)).statusCode, 201);
  const balance = async () => (await one("SELECT coalesce(sum(amount), 0)::numeric(12,2)::text AS v FROM balance_entries WHERE owner_id = $1", [id])).v;
  const payments = async () => (await one('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [invoiceId])).n;
  const pay = await held(invoiceId, id);

  for (const body of [{ method: 'balance' }, { method: 'saved_card' }, { method: 'card', provider: 'sandbox' }]) {
    const r = await post(`/billing/invoices/${invoiceId}/pay`, body, c);
    assert.deepEqual([r.statusCode, r.json().code], [409, 'PAYMENT_IN_REVIEW'], body.method);
  }
  assert.deepEqual([await balance(), await payments(), (await one('SELECT status FROM invoices WHERE id = $1', [invoiceId])).status], ['500.00', 1, 'unpaid']);
  // Another invoice of the same account is not affected.
  const other = (await post('/admin/billing/invoices', { userId: id, currency: 'TRY', lines: [{ description: 'Başka', unitPrice: '10' }] }, admin)).json().invoiceId;
  assert.equal((await post(`/billing/invoices/${other}/pay`, { method: 'balance' }, c)).statusCode, 200);
  assert.equal(await balance(), '488.00');

  // The review outlasted the window: the customer has a way to pay again (the invoice is being collected again too).
  await waitsSince(pay, 8);
  await redis.del(`rl:pay-start:${id}`);
  const started = await post(`/billing/invoices/${invoiceId}/pay`, { method: 'card', provider: 'sandbox' }, c);
  assert.equal(started.statusCode, 200, started.body);
  assert.ok(started.json().paymentId);

  // The budget of started card payments, per account and hour.
  for (let i = 1; i < paymentsPerHour; i++) assert.equal((await post(`/billing/invoices/${invoiceId}/pay`, { method: 'card', provider: 'sandbox' }, c)).statusCode, 200, `payment ${i + 1}`);
  const over = await post(`/billing/invoices/${invoiceId}/pay`, { method: 'card', provider: 'sandbox' }, c);
  assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
  assert.equal(await payments(), 1 + paymentsPerHour, 'the refused one made no payment row');
  // Another account has its own budget; staff recording a payment is not part of it and closes the held one.
  const [c2, id2] = await signUp('held-pay-2@example.test');
  const theirs = (await post('/admin/billing/invoices', { userId: id2, currency: 'TRY', lines: [{ description: 'Hizmet', unitPrice: '100' }] }, admin)).json().invoiceId;
  assert.equal((await post(`/billing/invoices/${theirs}/pay`, { method: 'card', provider: 'sandbox' }, c2)).statusCode, 200);
  await waitsSince(pay, 0);
  const marked = await post(`/admin/billing/invoices/${invoiceId}/mark-paid`, { method: 'other', reference: 'provider panel' }, admin);
  assert.equal(marked.statusCode, 200, marked.body);
  assert.deepEqual(marked.json().closedReviews, [pay]);
});

test('an API token of a directory or SSO account works only while the account was confirmed recently, and the token lists say so', async () => {
  const [c, id] = await signUp('token-sso@example.test');
  const made = await post('/account/api-tokens', { name: 'automation', scope: 'read' }, c);
  assert.equal(made.statusCode, 201, made.body);
  const withToken = () => app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${made.json().token}` } });
  const mine = async () => (await get('/account/api-tokens', c)).json();
  const staffRow = async () => (await get('/admin/api/tokens', admin)).json().tokens.find((t) => t.id === made.json().id);
  const confirmed = (source, days) => pool.query(`UPDATE users SET auth_source = $2, source_confirmed_at = ${days === null ? 'NULL' : 'now() - make_interval(days => $3)'} WHERE id = $1`, days === null ? [id, source] : [id, source, days]);

  // A panel account: no source to confirm it, never asleep.
  assert.equal((await withToken()).statusCode, 200);
  assert.deepEqual([(await mine()).tokens[0].asleep, (await mine()).confirmation, (await staffRow()).asleep], [null, null, null]);

  for (const source of ['oidc', 'ldap']) {
    // Confirmed yesterday: works; the list says until when.
    await confirmed(source, 1);
    assert.equal((await withToken()).statusCode, 200, source);
    let list = await mine();
    assert.equal(list.tokens[0].asleep, null);
    assert.deepEqual([list.confirmation.source, list.confirmation.days], [source, 30]);
    assert.ok(new Date(list.confirmation.until).getTime() > Date.now() + 28 * 86_400_000);
    // Not confirmed for longer than the limit: refused with its own code (the directory is not set up here, so it
    // cannot be asked), and both lists say the token sleeps. The token is not removed.
    await confirmed(source, 31);
    const r = await withToken();
    assert.deepEqual([r.statusCode, r.json().code], [401, 'TOKEN_ACCOUNT_UNCONFIRMED'], source);
    list = await mine();
    assert.deepEqual([list.tokens.length, list.tokens[0].asleep, (await staffRow()).asleep], [1, 'TOKEN_ACCOUNT_UNCONFIRMED', 'TOKEN_ACCOUNT_UNCONFIRMED']);
    // Never confirmed (the directory no longer lists the account): the same.
    await confirmed(source, null);
    assert.equal((await withToken()).json().code, 'TOKEN_ACCOUNT_UNCONFIRMED');
    assert.equal((await mine()).confirmation.until, null);
    // Confirmed again (the person signed in): the token works as before.
    await confirmed(source, 0);
    assert.equal((await withToken()).statusCode, 200);
  }
  // The upgrade marks the directory and SSO accounts that exist as confirmed then (migration 086), panel accounts not.
  const marks = await one("SELECT count(*) FILTER (WHERE auth_source NOT IN ('ldap', 'oidc') AND source_confirmed_at IS NOT NULL)::int AS panel FROM users");
  assert.equal(marks.panel, 0);
  await pool.query("UPDATE users SET auth_source = 'local', source_confirmed_at = NULL WHERE id = $1", [id]);
  assert.equal((await withToken()).statusCode, 200);
});

test('the time an operation waits for its account\'s share is given back to its deadline, within a bound (the worker\'s statements on this database)', async (t) => {
  // The worker's code, copied beside the API's modules so that its imports (pg, bullmq) resolve here.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '..', '..', '..', 'worker'), copy = join(here, `.worker-${process.pid}`);
  let admit;
  try {
    mkdirSync(copy, { recursive: true });
    for (const f of readdirSync(src).filter((f) => f.endsWith('.mjs'))) cpSync(join(src, f), join(copy, f));
    ({ admit } = await import(pathToFileURL(join(copy, 'operations.mjs')).href));
  } catch (e) { rmSync(copy, { recursive: true, force: true }); return t.skip(`the worker's code cannot be loaded here: ${e.message}`); }
  t.after(() => rmSync(copy, { recursive: true, force: true }));

  const [, id] = await signUp('held-ops@example.test');
  const srv = [await server(id, 'ops-1'), await server(id, 'ops-2'), await server(id, 'ops-3')];
  // deadline: minutes from now (negative: passed); started: under way already.
  const op = async (serverId, deadline, started = false) => (await one(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, capped_for, started_at)
    VALUES ('power_on', $4, $1, 'h', $2, $3, 'queued', now() + make_interval(mins => $5), $3, CASE WHEN $6 THEN now() END) RETURNING id`, [randomUUID(), serverId, id, started ? 'running' : 'pending', deadline, started])).id;
  const row = (opId) => one(`SELECT *, round(extract(epoch FROM deadline_at - now()) / 60)::int AS minutes_left FROM operations WHERE id = $1`, [opId]);

  const busy = await op(srv[0], 10, true);
  const waiting = await op(srv[1], 10);
  // The account's one slot is taken: held, since now; nothing else of the operation changes.
  assert.deepEqual(Object.keys(await admit(pool, await row(waiting), 1, 6)), ['held']);
  let w = await row(waiting);
  assert.deepEqual([w.status, w.attempts, w.started_at, w.minutes_left], ['pending', 0, null, 10]);
  assert.ok(w.held_since);
  // Half an hour later it is still held, and its deadline (10 minutes) has passed on the clock; the first moment stays.
  await pool.query("UPDATE operations SET held_since = now() - interval '30 minutes', deadline_at = now() - interval '20 minutes' WHERE id = $1", [waiting]);
  assert.deepEqual(Object.keys(await admit(pool, await row(waiting), 1, 6)), ['held']);
  w = await row(waiting);
  assert.ok(Date.now() - new Date(w.held_since).getTime() > 29 * 60_000);
  // The slot frees: it starts, with the half hour given back (the deadline is 10 minutes away again) and the mark cleared.
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE id = $1", [busy]);
  assert.deepEqual(await admit(pool, await row(waiting), 1, 6), {});
  w = await row(waiting);
  assert.deepEqual([w.status, w.attempts, w.held_since, w.minutes_left], ['running', 1, null, 10]);
  assert.ok(w.started_at);

  // The bound: held for nine hours, six are given back at most; with the account still at its share and even the
  // longest extension over, the operation is no longer held (the worker's deadline check then ends it as TIMEOUT).
  const late = await op(srv[2], -7 * 60);
  await pool.query("UPDATE operations SET held_since = now() - interval '9 hours' WHERE id = $1", [late]);
  assert.deepEqual(await admit(pool, await row(late), 1, 6), {});
  const l = await row(late);
  assert.deepEqual([l.status, l.held_since, l.minutes_left], ['running', null, -60]);
  await pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE owner_id = $1", [id]);
});

test('what a reseller does on a customer\'s server besides operations is in the customer\'s activity, with who it was; a request body cannot write into another account\'s activity', async () => {
  const [r, rId] = await reseller('acts-reseller@example.test');
  const [c, cId] = await customerOf(rId, 'acts-customer@example.test');
  const [stranger, strangerId] = await signUp('acts-stranger@example.test');
  assert.equal((await put('/reseller/brand', { name: 'Acme Cloud' }, r)).statusCode, 200);
  const theirs = await server(cId, 'acts-1'), own = await server(rId, 'acts-own');

  // A schedule made, changed and removed, and the labels, by the reseller on the customer's server.
  const schedule = { action: 'shutdown', days: [1, 2], time: '03:00', timezone: 'Europe/Istanbul' };
  const made = await post(`/servers/${theirs}/schedules`, schedule, r);
  assert.equal(made.statusCode, 201, made.body);
  assert.equal((await put(`/servers/${theirs}/schedules/${made.json().id}`, { ...schedule, enabled: false }, r)).statusCode, 200);
  assert.equal((await del(`/servers/${theirs}/schedules/${made.json().id}`, r)).statusCode, 204);
  assert.equal((await put(`/servers/${theirs}/labels`, { tags: ['prod'], notes: 'looked after by Acme' }, r)).statusCode, 200);
  // The same on the reseller's own server is nobody else's business.
  assert.equal((await put(`/servers/${own}/labels`, { tags: ['mine'], notes: '' }, r)).statusCode, 200);

  const seen = (await activity(c)).filter((e) => e.actorId === rId);
  assert.deepEqual(seen.map((e) => e.action).sort(), ['server.labels', 'server.schedule_created', 'server.schedule_deleted', 'server.schedule_updated']);
  for (const e of seen) {
    assert.deepEqual([e.actorEmail, e.actorName, e.ip, e.metadata.forOwner, e.metadata.actingAs, e.metadata.serverId], ['acts-reseller@example.test', 'Acme Cloud', null, cId, 'reseller', theirs], e.action);
  }
  // The reseller sees its own actions with its own address; a stranger sees none of it; staff acting on the server
  // leave nothing in the customer's activity.
  assert.equal((await activity(r)).filter((e) => e.action === 'server.labels').length, 2);
  assert.ok((await activity(r)).every((e) => e.actorName !== undefined));
  assert.equal((await activity(stranger)).filter((e) => e.action.startsWith('server.')).length, 0);
  assert.equal((await put(`/servers/${theirs}/labels`, { tags: ['staff'], notes: '' }, admin)).statusCode, 200);
  assert.equal((await activity(c)).filter((e) => e.action === 'server.labels').length, 1);

  // A customer types forOwner and actingAs into a request whose body used to be stored as it came: the event keeps
  // only what the route read, and the other account's activity does not show it.
  const sSrv = await server(strangerId, 'acts-stranger');
  const sSub = await subscription(strangerId, sSrv, 20);
  const crafted = await put(`/billing/subscriptions/${sSub}`, { autoRenew: false, forOwner: cId, actingAs: 'reseller', serverId: theirs, note: 'your reseller cancelled this' }, stranger);
  assert.equal(crafted.statusCode, 200, crafted.body);
  const stored = await one("SELECT metadata FROM audit_events WHERE action = 'billing.subscription_changed' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [strangerId]);
  assert.deepEqual(stored.metadata, { subscriptionId: sSub, autoRenew: false });
  // The staff route as well: only its validated fields.
  assert.equal((await put(`/admin/billing/subscriptions/${sSub}`, { periodMonths: 3, forOwner: cId, actingAs: 'reseller', junk: 'x' }, admin)).statusCode, 200);
  const staffStored = await one("SELECT metadata FROM audit_events WHERE action = 'billing.subscription_updated' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(staffStored.metadata, { subscriptionId: sSub, target: strangerId, periodMonths: 3 });
  // Any other route that repeats input: the two fields never come from the caller (here the labels' own metadata).
  assert.equal((await put(`/servers/${sSrv}/labels`, { tags: ['x'], notes: '', forOwner: cId, actingAs: 'reseller' }, stranger)).statusCode, 200);
  // And a row written before this version, body and all, is not shown to the account it names.
  await pool.query(`INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'billing.subscription_changed', 'success', $2)`,
    [strangerId, { subscriptionId: sSub, forOwner: cId, actingAs: 'reseller', note: 'from before' }]);
  const after = await activity(c);
  assert.equal(after.filter((e) => e.actorId === strangerId || e.action.startsWith('billing.subscription')).length, 0);
  assert.ok(!JSON.stringify(after).includes('acts-stranger'));
  // The actor still sees their own events.
  assert.ok((await activity(stranger)).some((e) => e.action === 'billing.subscription_changed'));
});

test('leaving a reseller takes the discount off the prices where it can be told, for the next invoice; billing\'s removals of ended subscriptions stay; not done by staff acting as the customer', async () => {
  const [, rId] = await reseller('price-reseller@example.test'); // 20 % off
  const [c, cId] = await customerOf(rId, 'price-customer@example.test');
  // The catalog's shape at the reseller's price; the same with an extra disk (10 GB at 0.50: 5.00, the reseller's 4.00);
  // one at a price nobody can derive (staff set it); and one whose subscription the reseller had cancelled.
  const plain = await server(cId, 'price-plain', { package_id: site.pkg });
  const disk = await server(cId, 'price-disk', { package_id: site.pkg, price_monthly: '84.00' });
  const diskId = (await one("INSERT INTO server_disks (server_id, size_gb, price_monthly, status) VALUES ($1, 10, 4, 'ready') RETURNING id", [disk])).id;
  const odd = await server(cId, 'price-odd', { package_id: site.pkg, price_monthly: '70.00' });
  const subs = { plain: await subscription(rId, plain, 20), disk: await subscription(rId, disk, 3, '84.00'), odd: await subscription(rId, odd, 20, '70.00') };
  // The reseller's renewal for the server with the disk exists and is partly paid: it stays the reseller's debt.
  await runBilling();
  const resellers = await renewal(subs.disk);
  assert.deepEqual([resellers.owner_id, resellers.unit], [rId, '84.00']);
  await pool.query('UPDATE invoices SET paid_total = 10 WHERE id = $1', [resellers.id]);
  // Cancelled by the reseller at its period's end; the run decided to delete the server and could not yet (made after
  // the run above, which would have deleted it).
  const gone = await server(cId, 'price-gone', { package_id: site.pkg, billing_remove: 'cancel' });
  subs.gone = await subscription(rId, gone, 20, '80.00', 'cancelled');

  // Before deciding, the customer is shown what the servers would cost.
  const shown = (await get('/reseller/summary', c)).json().managedBy.afterLeave;
  assert.deepEqual(shown.map((p) => [p.name, p.from, p.to, p.currency]), [['price-disk', '84.00', '105.00', 'TRY'], ['price-plain', '80.00', '100.00', 'TRY']]);
  assert.equal((await one('SELECT price_monthly::text AS p FROM servers WHERE id = $1', [plain])).p, '80.00', 'asking changes nothing');

  // Staff acting as the customer cannot leave for them (nor accept a server for them).
  const as = await impersonate(cId);
  const refused = await post('/reseller/leave', {}, as);
  assert.deepEqual([refused.statusCode, refused.json().code], [403, 'NOT_WHILE_IMPERSONATING']);
  const accept = await post(`/transfers/${randomUUID()}/accept`, {}, as);
  assert.deepEqual([accept.statusCode, accept.json().code], [403, 'NOT_WHILE_IMPERSONATING']);
  assert.equal((await one('SELECT reseller_id FROM users WHERE id = $1', [cId])).reseller_id, rId);

  const left = await post('/reseller/leave', {}, c);
  assert.equal(left.statusCode, 200, left.body);
  assert.deepEqual(left.json().listPrices.map((p) => [p.name, p.from, p.to]), [['price-disk', '84.00', '105.00'], ['price-plain', '80.00', '100.00']]);
  const price = async (id) => (await one('SELECT price_monthly::text AS p FROM servers WHERE id = $1', [id])).p;
  assert.deepEqual([await price(plain), await price(disk), await price(odd), await price(gone)], ['100.00', '105.00', '70.00', '80.00']);
  assert.equal((await one('SELECT price_monthly::text AS p FROM server_disks WHERE id = $1', [diskId])).p, '5.00');
  assert.deepEqual([(await sub(subs.plain)).amount, (await sub(subs.disk)).amount, (await sub(subs.odd)).amount], ['100.00', '105.00', '70.00']);
  for (const s of [subs.plain, subs.disk, subs.odd]) assert.equal((await sub(s)).owner_id, cId);
  // The server billing had decided to delete keeps that decision, and its ended subscription stays the reseller's.
  assert.equal((await one('SELECT billing_remove FROM servers WHERE id = $1', [gone])).billing_remove, 'cancel');
  assert.deepEqual([(await sub(subs.gone)).owner_id, (await sub(subs.gone)).status], [rId, 'cancelled']);
  // The notice names the new amount; the audit event says which prices changed and which could not be told.
  const [bye] = (await queued('account.reseller', cId)).filter((j) => j.data.data.step === 'left');
  assert.deepEqual([bye.data.data.priced, bye.data.data.monthly, bye.data.data.was], ['2', '205.00 TRY', '164.00 TRY']);
  const event = await one("SELECT metadata FROM audit_events WHERE action = 'reseller.customer_released' AND metadata->>'target' = $1", [cId]);
  assert.deepEqual([event.metadata.listPrices.length, event.metadata.pricesKept, event.metadata.forOwner], [2, [odd], cId]);
  assert.ok((await activity(c)).some((e) => e.action === 'reseller.customer_released'));

  // Nothing is charged for the period the reseller paid: no invoice appears for the customer now. The next renewal is
  // at the list price; the reseller's partly paid invoice keeps the price it was made at.
  await runBilling();
  assert.equal((await one('SELECT count(*)::int AS n FROM invoices WHERE owner_id = $1', [cId])).n, 0);
  await pool.query(`UPDATE subscriptions SET period_start = (${day(3)} - interval '1 month')::date, period_end = ${day(3)} WHERE id = $1`, [subs.plain]);
  await runBilling();
  const first = await renewal(subs.plain);
  assert.deepEqual([first.owner_id, first.unit, first.total], [cId, '100.00', '120.00']);
  const kept = await renewal(subs.disk);
  assert.deepEqual([kept.id, kept.owner_id, kept.unit], [resellers.id, rId, '84.00']);
  // No fresh subscription was made for the server that is being removed.
  assert.equal((await one("SELECT count(*)::int AS n FROM subscriptions WHERE server_id = $1 AND status NOT IN ('cancelled', 'ended')", [gone])).n, 0);

  // Staff taking a customer out behaves the same.
  const [, c2Id] = await customerOf(rId, 'price-customer-2@example.test');
  const theirs = await server(c2Id, 'price-staff', { package_id: site.pkg });
  const theirSub = await subscription(rId, theirs, 20);
  const released = await del(`/admin/resellers/${rId}/customers/${c2Id}`, admin);
  assert.equal(released.statusCode, 200, released.body);
  assert.deepEqual([released.json().listPrices.map((p) => [p.from, p.to]), released.json().pricesKept], [[['80.00', '100.00']], []]);
  assert.deepEqual([await price(theirs), (await sub(theirSub)).amount, (await sub(theirSub)).owner_id], ['100.00', '100.00', c2Id]);
  const [told] = (await queued('account.reseller', c2Id)).filter((j) => j.data.data.step === 'left');
  assert.deepEqual([told.data.data.priced, told.data.data.monthly], ['1', '100.00 TRY']);

  // A reseller without a discount: nothing to take off, whatever the catalog says today.
  const [, r0] = await reseller('price-reseller-0@example.test', { discountPct: 0 });
  const [c3, c3Id] = await customerOf(r0, 'price-customer-3@example.test');
  const flat = await server(c3Id, 'price-flat', { package_id: site.pkg });
  await subscription(r0, flat, 20);
  const out = await post('/reseller/leave', {}, c3);
  assert.deepEqual([out.statusCode, out.json().listPrices], [200, []]);
  assert.equal(await price(flat), '80.00');
});
