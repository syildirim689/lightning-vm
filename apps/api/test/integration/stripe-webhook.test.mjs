// Stripe's webhook, against a real PostgreSQL and Redis (destructive, like the other files here: it wipes the test
// database and Redis DB). NOTHING IS SENT TO STRIPE: the events are made here and signed with a test secret, and the
// two other ways a Stripe payment is recorded (the browser's return and the billing run, which ask Stripe) get their
// answer from a stand-in for fetch that fails the test if anything but that stand-in is asked.
// What is checked: the signature is verified over the body's bytes as they arrived, with the endpoint's secret of
// that mode; a missing, wrong, altered or old signature changes nothing; without a saved secret the address is not
// there; a paid event pays the invoice once whichever of the three ways arrives first, in any order, together or
// repeated; the card is kept when the payment asked for it, once; another amount is left for staff; an expired
// page closes the payment; events of the other mode, of unknown payments and of other kinds are acknowledged and
// leave everything alone; the secret is stored encrypted and never returned.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

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
const { runBilling } = await import('../../dist/billing.js');

let app, admin, userId;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const testSecret = 'whsec_test_0123456789abcdefABCDEF', liveSecret = 'whsec_live_zyxwvutsrqponmlkjihgfe';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload) => app.inject({ method, url: path, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const company = { name: 'Lightning Bilişim A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy', address: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul' };
// A staff invoice of 100 before tax: 120.00 with the default 20 %.
const invoiceFor = async () => (await call('POST', '/admin/billing/invoices', admin, { userId, currency: 'TRY', lines: [{ description: 'Hizmet', unitPrice: '100' }] })).json().invoiceId;
let sessions = 0;
// A card payment begun at Stripe: its Checkout session is kept on it, as startCardPayment leaves it.
const pending = async (invoiceId, extra = {}) => {
  const cols = { invoice_id: invoiceId, owner_id: userId, provider: 'stripe', mode: 'test', method: 'card', status: 'pending', amount: 120, currency: 'TRY', provider_ref: `cs_test_${++sessions}`, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO payments (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
const payment = (id) => one('SELECT status, error_code, provider_ref, completed_at FROM payments WHERE id = $1', [id]);
const invoice = (id) => one('SELECT status, total::text, paid_total::text FROM invoices WHERE id = $1', [id]);
const balance = async () => (await one("SELECT coalesce(sum(amount), 0)::numeric(12,2)::text AS v FROM balance_entries WHERE owner_id = $1", [userId])).v;

// An event as Stripe sends it, and its delivery: the body's bytes are signed as they are sent.
let events = 0;
const paid = (paymentId, object = {}, extra = {}) => ({ id: `evt_${++events}_${randomUUID().replace(/-/g, '')}`, object: 'event', api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), livemode: false,
  type: 'payment_intent.succeeded', ...extra,
  data: { object: { id: `pi_${events}`, object: 'payment_intent', status: 'succeeded', amount: 12000, amount_received: 12000, currency: 'try', customer: 'cus_1', payment_method: 'pm_1', setup_future_usage: null,
    metadata: { payment_id: paymentId }, ...object } } });
const sign = (raw, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
const deliver = (event, { secret = testSecret, t, raw = JSON.stringify(event), signature } = {}) => app.inject({ method: 'POST', url: '/billing/callback/stripe', payload: raw,
  headers: { 'content-type': 'application/json; charset=utf-8', ...(signature !== null && { 'stripe-signature': signature ?? sign(raw, secret, t) }) } });

// Stripe, for the two ways that ask it: answers a session by its id from `sessions here`; anything else fails the test.
const realFetch = globalThis.fetch;
const asked = [];
const stripeSessions = new Map();
const session = (paymentId, ref, over = {}) => stripeSessions.set(ref, { id: ref, object: 'checkout.session', client_reference_id: paymentId, payment_status: 'paid', status: 'complete', amount_total: 12000, currency: 'try',
  customer: 'cus_1', payment_intent: { id: `pi_of_${ref}`, payment_method: 'pm_1', setup_future_usage: null }, ...over });
const cameBack = (paymentId, ref) => app.inject({ method: 'GET', url: `/billing/callback/stripe/${paymentId}?session_id=${ref}` });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  assert.equal((await call('POST', '/setup/admin', undefined, { token, email: 'boss@example.test', password })).statusCode, 201);
  admin = cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email: 'boss@example.test', password }));
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
  userId = (await call('POST', '/auth/sign-up/email', undefined, { name: 'Ayşe', email: 'ayse@example.test', password })).json().user.id;
  assert.equal((await call('PUT', '/admin/settings/billing', admin, { enabled: true, company, autoCharge: false, balance: true })).statusCode, 200);
  globalThis.fetch = async (input) => {
    const u = String(input?.url ?? input);
    asked.push(u);
    const m = /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_\w+)\?/.exec(u);
    if (!m) throw new Error(`the test asked the outside world: ${u}`);
    const s = stripeSessions.get(m[1]);
    return new Response(JSON.stringify(s ?? { error: { message: 'No such checkout.session' } }), { status: s ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
});
after(async () => { globalThis.fetch = realFetch; await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('without a saved signing secret the address is not there', async () => {
  const p = await pending(await invoiceFor());
  const r = await deliver(paid(p));
  assert.deepEqual([r.statusCode, r.json().code], [404, 'WEBHOOK_NOT_CONFIGURED']);
  assert.equal((await payment(p)).status, 'pending');
});

test('the signing secret is saved like the other secrets: encrypted, never returned; the settings name the address and the events', async () => {
  const saved = await call('PUT', '/admin/settings/payments/stripe', admin, { test: { secretKey: 'sk_test_0123456789abcdef', webhookSecret: testSecret }, live: { secretKey: 'sk_live_0123456789abcdef', webhookSecret: liveSecret } });
  assert.equal(saved.statusCode, 200, saved.body);
  const list = await call('GET', '/admin/settings/payments', admin);
  assert.ok(!list.body.includes(testSecret) && !list.body.includes(liveSecret) && !list.body.includes('sk_test_0123456789abcdef'), 'no secret in the settings answer');
  assert.deepEqual(list.json().providers.find((x) => x.id === 'stripe').webhook, { path: '/billing/callback/stripe', events: ['payment_intent.succeeded', 'checkout.session.expired'] });
  assert.equal(list.json().providers.find((x) => x.id === 'paytr').webhook, null);
  const row = await one("SELECT test_enc, live_enc FROM payment_gateways WHERE id = 'stripe'");
  assert.ok(row.test_enc && !row.test_enc.includes('whsec_') && !row.live_enc.includes('whsec_'), 'stored encrypted');
  assert.equal(asked.length, 0, 'saving asks nobody');
});

test('a body counts only with a signature over its own bytes, made with the endpoint\'s secret, and not older than five minutes', async () => {
  const inv = await invoiceFor();
  const p = await pending(inv);
  const event = paid(p);
  const raw = JSON.stringify(event);
  const untouched = async (why) => { assert.equal((await payment(p)).status, 'pending', why); assert.equal((await invoice(inv)).status, 'unpaid', why); };
  const refused = async (r, code, why) => { assert.deepEqual([r.statusCode, r.json().code], [400, code], why); await untouched(why); };
  await refused(await deliver(event, { signature: null }), 'WEBHOOK_SIGNATURE_INVALID', 'no signature');
  await refused(await deliver(event, { signature: '' }), 'WEBHOOK_SIGNATURE_INVALID', 'an empty signature');
  await refused(await deliver(event, { signature: 'v1=abc' }), 'WEBHOOK_SIGNATURE_INVALID', 'no timestamp');
  await refused(await deliver(event, { signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }), 'WEBHOOK_SIGNATURE_INVALID', 'a made-up signature');
  await refused(await deliver(event, { secret: 'whsec_somebody_elses_secret_0000' }), 'WEBHOOK_SIGNATURE_INVALID', 'another secret');
  await refused(await deliver(event, { secret: '' }), 'WEBHOOK_SIGNATURE_INVALID', 'an empty secret');
  // Signed for one body, sent with another: the same event with a different amount, or only re-spaced (the same JSON to a parser).
  const good = sign(raw, testSecret);
  await refused(await deliver(event, { raw: raw.replace('"amount_received":12000', '"amount_received":1'), signature: good }), 'WEBHOOK_SIGNATURE_INVALID', 'an altered body');
  await refused(await deliver(event, { raw: JSON.stringify(event, null, 2), signature: good }), 'WEBHOOK_SIGNATURE_INVALID', 'the same JSON in other bytes');
  // The signature's own timestamp altered: it no longer matches.
  await refused(await deliver(event, { signature: good.replace(/^t=\d+/, `t=${Math.floor(Date.now() / 1000) + 1}`) }), 'WEBHOOK_SIGNATURE_INVALID', 'a moved timestamp');
  // A delivery captured earlier and sent again later: its signature is right and too old (also one dated ahead).
  const old = Math.floor(Date.now() / 1000) - 301;
  await refused(await deliver(event, { t: old }), 'WEBHOOK_TIMESTAMP_OUT_OF_RANGE', 'replayed after the tolerance');
  await refused(await deliver(event, { t: Math.floor(Date.now() / 1000) + 900 }), 'WEBHOOK_TIMESTAMP_OUT_OF_RANGE', 'dated ahead');
  // An event that says it is of the other mode than the secret that signed it.
  await refused(await deliver({ ...event, livemode: true }), 'WEBHOOK_EVENT_INVALID', 'livemode under the test secret');
  await refused(await deliver({ ...event, id: 'not-an-event-id' }), 'WEBHOOK_EVENT_INVALID', 'no event id');
  // Not JSON at all, rightly signed: the parser refuses it before anything looks at it.
  const junk = await deliver(event, { raw: '{"id":', signature: sign('{"id":', testSecret) });
  assert.equal(junk.statusCode, 400);
  await untouched('a broken body');
  // Bytes a serialiser would never write (spaces, a trailing newline): signed as sent, they count. Four minutes old is within the tolerance.
  const spaced = ` ${JSON.stringify(event, null, 1)}\n`;
  const ok = await deliver(event, { raw: spaced, t: Math.floor(Date.now() / 1000) - 240 });
  assert.deepEqual([ok.statusCode, ok.json()], [200, { received: true }]);
  assert.deepEqual([(await payment(p)).status, (await payment(p)).provider_ref], ['succeeded', event.data.object.id]);
  assert.deepEqual(await invoice(inv), { status: 'paid', total: '120.00', paid_total: '120.00' });
  assert.equal(asked.length, 0, 'Stripe was not asked');
});

test('a paid payment is recorded once, whichever of the three ways arrives first, in any order, together or repeated', async () => {
  const before = await balance();
  const paidOnce = async (inv, p, why) => {
    assert.deepEqual(await invoice(inv), { status: 'paid', total: '120.00', paid_total: '120.00' }, why);
    assert.equal((await payment(p)).status, 'succeeded', why);
    assert.equal(await balance(), before, `${why}: nothing was credited beside the invoice`);
    assert.equal((await one('SELECT count(*)::int AS n FROM balance_entries WHERE payment_id = $1', [p])).n, 0, why);
  };
  // 1. The event first; then the customer's browser comes back; then the billing run asks; then Stripe delivers again.
  let inv = await invoiceFor(), p = await pending(inv), ref = (await payment(p)).provider_ref;
  session(p, ref);
  const event = paid(p);
  assert.deepEqual((await deliver(event)).json(), { received: true });
  const first = (await payment(p)).completed_at;
  assert.equal((await cameBack(p, ref)).statusCode, 303);
  await pool.query("UPDATE payments SET created_at = now() - interval '10 minutes' WHERE id = $1", [p]);
  await runBilling();
  assert.deepEqual((await deliver(event)).json(), { received: true, duplicate: true });
  assert.deepEqual((await deliver({ ...event, id: `evt_again_${events}` })).json(), { received: true }, 'the same outcome under a new event id');
  await paidOnce(inv, p, 'event, return, billing run, event');
  assert.equal((await payment(p)).completed_at.getTime(), first.getTime(), 'recorded when the event came, not again');
  // 2. The browser first, the event afterwards.
  inv = await invoiceFor(); p = await pending(inv); ref = (await payment(p)).provider_ref;
  session(p, ref);
  asked.length = 0;
  assert.equal((await cameBack(p, ref)).statusCode, 303);
  assert.equal(asked.length, 1, 'the return asked the stand-in once');
  assert.equal((await payment(p)).provider_ref, `pi_of_${ref}`);
  assert.deepEqual((await deliver(paid(p))).json(), { received: true });
  await paidOnce(inv, p, 'return, event');
  assert.equal((await payment(p)).provider_ref, `pi_of_${ref}`, 'the later event rewrites nothing');
  // 3. The billing run first (the customer closed the tab), the event afterwards.
  inv = await invoiceFor(); p = await pending(inv); ref = (await payment(p)).provider_ref;
  session(p, ref);
  await pool.query("UPDATE payments SET created_at = now() - interval '10 minutes' WHERE id = $1", [p]);
  assert.equal((await runBilling()).paymentsRechecked, 1);
  assert.deepEqual((await deliver(paid(p))).json(), { received: true });
  await paidOnce(inv, p, 'billing run, event');
  // 4. All at once, several times over: the return, the event twice (one id) and the event under another id.
  for (let trial = 0; trial < 5; trial++) {
    inv = await invoiceFor(); p = await pending(inv); ref = (await payment(p)).provider_ref;
    session(p, ref);
    const e = paid(p);
    const answers = await Promise.all([cameBack(p, ref), deliver(e), deliver(e), deliver({ ...e, id: `evt_twin_${trial}_${events}` })]);
    assert.deepEqual(answers.map((r) => r.statusCode), [303, 200, 200, 200], answers.map((r) => r.body).join(' '));
    await paidOnce(inv, p, `trial ${trial}: together`);
    assert.equal((await one("SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1 AND status = 'succeeded'", [inv])).n, 1);
  }
});

test('the card is kept when the payment asked for it, once, whichever way records it', async () => {
  const cards = async () => (await one("SELECT count(*)::int AS n FROM saved_cards WHERE owner_id = $1 AND provider = 'stripe'", [userId])).n;
  assert.equal(await cards(), 0);
  // Asked for, and the event says the card may be used later: kept.
  let inv = await invoiceFor(), p = await pending(inv, { save_card: true }), ref = (await payment(p)).provider_ref;
  session(p, ref, { payment_intent: { id: `pi_of_${ref}`, payment_method: 'pm_1', setup_future_usage: 'off_session' } });
  const e = paid(p, { setup_future_usage: 'off_session', customer: 'cus_9', payment_method: 'pm_9' });
  const answers = await Promise.all([deliver(e), cameBack(p, ref), deliver({ ...e, id: `evt_card_${events}` })]);
  assert.deepEqual(answers.map((r) => r.statusCode), [200, 303, 200]);
  assert.equal(await cards(), 1, 'one card, not one per way');
  // Not asked for: nothing is kept, whatever the event carries.
  inv = await invoiceFor(); p = await pending(inv);
  assert.equal((await deliver(paid(p, { setup_future_usage: 'off_session' }))).statusCode, 200);
  assert.equal((await payment(p)).status, 'succeeded');
  assert.equal(await cards(), 1);
  // The card's token is stored encrypted.
  assert.ok(!(await one("SELECT token_enc FROM saved_cards WHERE owner_id = $1 AND provider = 'stripe'", [userId])).token_enc.includes('pm_9'));
});

test('another amount or currency is left for staff; an expired page closes the payment; a paid one is not closed by it', async () => {
  let inv = await invoiceFor(), p = await pending(inv);
  for (const object of [{ amount_received: 1200 }, { currency: 'usd' }]) {
    assert.equal((await deliver(paid(p, object))).statusCode, 200);
    assert.deepEqual([(await payment(p)).status, (await payment(p)).error_code], ['pending', 'AMOUNT_MISMATCH']);
    assert.equal((await invoice(inv)).status, 'unpaid');
  }
  // Not yet succeeded (a state Stripe does not send under this event's name): nothing.
  const other = await pending(await invoiceFor());
  assert.equal((await deliver(paid(other, { status: 'processing' }))).statusCode, 200);
  assert.deepEqual([(await payment(other)).status, (await payment(other)).error_code], ['pending', null]);
  // The payment page expired unpaid.
  const expired = (paymentId, o = {}) => ({ id: `evt_x_${++events}`, object: 'event', livemode: false, type: 'checkout.session.expired',
    data: { object: { id: 'cs_test_x', object: 'checkout.session', client_reference_id: paymentId, payment_status: 'unpaid', status: 'expired', ...o } } });
  assert.deepEqual((await deliver(expired(other))).json(), { received: true });
  assert.deepEqual([(await payment(other)).status, (await payment(other)).error_code], ['failed', 'EXPIRED']);
  // Then a payment for it after all: a closed payment stays closed, the invoice unpaid.
  assert.equal((await deliver(paid(other))).statusCode, 200);
  assert.equal((await payment(other)).status, 'failed');
  // An "expired" for a payment already recorded as paid changes nothing.
  inv = await invoiceFor(); p = await pending(inv);
  assert.equal((await deliver(paid(p))).statusCode, 200);
  assert.equal((await deliver(expired(p))).statusCode, 200);
  assert.deepEqual([(await payment(p)).status, (await invoice(inv)).status], ['succeeded', 'paid']);
});

test('events of the other mode, of unknown payments, of other providers and of other kinds are acknowledged and change nothing', async () => {
  const inv = await invoiceFor();
  const p = await pending(inv);
  const ignored = async (r, why) => { assert.deepEqual([r.statusCode, r.json()], [200, { received: true, ignored: true }], why); assert.equal((await payment(p)).status, 'pending', why); };
  // Signed with the live secret (a live event) for a payment begun in test mode.
  await ignored(await deliver(paid(p, {}, { livemode: true }), { secret: liveSecret }), 'a live event for a test payment');
  // A payment id nobody has, and one that is not an id.
  await ignored(await deliver(paid(randomUUID())), 'an unknown payment');
  await ignored(await deliver(paid("x' OR '1'='1")), 'not an id');
  await ignored(await deliver(paid(undefined, { metadata: {} })), 'no payment named');
  // Another provider's payment under the same id is not Stripe's to settle.
  const sandbox = await pending(inv, { provider: 'sandbox', provider_ref: null });
  assert.deepEqual((await deliver(paid(sandbox))).json(), { received: true, ignored: true });
  assert.equal((await payment(sandbox)).status, 'pending');
  // Other kinds of events, also ones that name the payment.
  for (const type of ['payment_intent.payment_failed', 'payment_intent.created', 'charge.succeeded', 'checkout.session.completed', 'customer.created']) {
    await ignored(await deliver(paid(p, {}, { type })), type);
  }
  assert.equal((await invoice(inv)).status, 'unpaid');
  // A live payment is settled by a live event, not by a test one.
  const live = await pending(inv, { mode: 'live' });
  assert.deepEqual((await deliver(paid(live))).json(), { received: true, ignored: true });
  assert.equal((await payment(live)).status, 'pending');
  assert.deepEqual((await deliver(paid(live, {}, { livemode: true }), { secret: liveSecret })).json(), { received: true });
  assert.equal((await payment(live)).status, 'succeeded');
  assert.deepEqual(await invoice(inv), { status: 'paid', total: '120.00', paid_total: '120.00' });
});

test('wrong signatures from one address are counted', async () => {
  for (const k of await redis.keys('rl:stripe-webhook:*')) await redis.del(k);
  const event = paid(randomUUID());
  let limited = 0;
  for (let i = 0; i < 125; i++) if ((await deliver(event, { signature: `t=1,v1=${'a'.repeat(64)}` })).statusCode === 429) limited++;
  assert.equal(limited, 5);
  // A rightly signed delivery is not held back by them.
  assert.equal((await deliver(event)).statusCode, 200);
});
