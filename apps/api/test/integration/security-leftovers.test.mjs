// What the two security reviews left open, against real PostgreSQL and Redis. No hypervisor, adapter, worker, payment
// or messaging provider: servers and subscriptions are rows written here, operations stop where the API queues them,
// and messaging addresses are ones the panel refuses before it connects.
//   - an operation says whose share of the worker's slots it counts against (operations.capped_for): the account that
//     started it, the reseller for a customer's server, nobody for staff (the worker's side is apps/worker/test/fairness);
//   - what a reseller does on a customer's server is in the customer's own activity, without the reseller's address;
//   - a test notification to a messaging address has a budget per address across accounts, and connecting or testing
//     an address has one per account;
//   - a reseller's customer sees who manages the account and is told once; when the account leaves the reseller (the
//     customer, staff for one customer, or the reseller removed) the reseller can no longer act on the servers and the
//     customer pays for them from the first unpaid period.
// Held payments are in security-billing.test.mjs.
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
const { runBilling } = await import('../../dist/billing.js');

let app, admin, site;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie, headers) => call('POST', url, cookie, payload, headers);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const del = (url, cookie) => call('DELETE', url, cookie);
const key = () => ({ 'idempotency-key': randomUUID() });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); }; // several accounts are made from one address
const signUp = async (email, name = '') => { await freshLimits(); const r = await post('/auth/sign-up/email', { name, email, password }); assert.equal(r.statusCode, 200, r.body); return [cookieOf(r), r.json().user.id]; };
const company = { name: 'Lightning Bilişim A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy', address: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul' };
const day = (n) => `((now() AT TIME ZONE 'Europe/Istanbul')::date + ${n})`;
// A ready, stopped server as a finished order leaves it.
const server = async (ownerId, name, extra = {}) => {
  const cols = { owner_id: ownerId, pool_id: site.pool, image_id: site.image, name, vcpu: 2, memory_mb: 2048, disk_gb: 20, price_monthly: '80.00', currency: 'TRY', state: 'ready', power_state: 'poweredOff', vm_moref: `vm-${name}`, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO servers (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
// The server's running subscription, paid by `payerId`; its period ends in `ends` days.
const subscription = async (payerId, serverId, ends, extra = {}) => {
  const id = (await one(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_months, period_start, period_end)
    VALUES ($1, 'server', $2, 'Sunucu', 80, 'TRY', 'active', 1, (${day(ends)} - interval '1 month')::date, ${day(ends)}) RETURNING id`, [payerId, serverId])).id;
  for (const [k, v] of Object.entries(extra)) await pool.query(`UPDATE subscriptions SET ${k} = $2 WHERE id = $1`, [id, v]);
  return id;
};
const sub = (id) => one('SELECT owner_id, status, cancel_at_period_end, auto_renew, suspended_at FROM subscriptions WHERE id = $1', [id]);
// The open (not withdrawn) renewal invoice of a subscription, with who owes it.
const renewal = (subId) => one(`SELECT i.id, i.owner_id, i.status FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
  WHERE l.subscription_id = $1 AND i.kind = 'renewal' AND NOT l.withdrawn ORDER BY i.created_at DESC LIMIT 1`, [subId]);
const settle = (serverId) => pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE server_id = $1 AND status IN ('pending', 'running')", [serverId]);
const powerOn = (ids, cookie) => post('/servers/actions', { action: 'power_on', serverIds: ids }, cookie, key());
const lastOp = (serverId) => one('SELECT id, owner_id, started_by, capped_for FROM operations WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1', [serverId]);
const told = async (userId, step) => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed']))
  .filter((j) => j.data.event === 'account.reseller' && j.data.data.step === step && j.data.to.includes(userId));
const reseller = async (email, body = { discountPct: 20 }) => {
  const [cookie, id] = await signUp(email, 'Acme Hosting');
  assert.equal((await put(`/admin/resellers/${id}`, body, admin)).statusCode, 200);
  return [cookie, id];
};
// An account of its own (it can sign in) that belongs to the reseller, as one the reseller opened does.
const customerOf = async (resellerId, email) => {
  const [cookie, id] = await signUp(email);
  await pool.query('UPDATE users SET reseller_id = $2 WHERE id = $1', [id, resellerId]);
  return [cookie, id];
};

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
  assert.equal((await put('/admin/settings/billing', { enabled: true, company, autoCharge: false, invoiceDaysBefore: 7, balance: true, sandbox: true }, admin)).statusCode, 200);
  // A worker on this database (run.sh) must leave the queued operations alone: it cannot read this connection's password,
  // so it fails while loading an operation, before it writes anything (as in security-servers.test.mjs).
  const conn = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, username, password_enc, tls_mode, product, write_api)
    VALUES ($1, 'it-leftovers', 'esxi', 'esxi.leftovers.test', 'root', $2, 'system', '{}', 'unknown')`, [conn, encryptSecret('pw', 'not-this-connection')]);
  const rp = await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref) VALUES ('it-leftovers', $1, 'ha-1', '{ds-1}', 'net-1') RETURNING id`, [conn]);
  const img = await one(`INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('it-leftovers', 'linux', $1, 'tpl-1') RETURNING id`, [conn]);
  site = { pool: rp.id, image: img.id };
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('an operation counts against the account that started it: the owner, the reseller for a customer\'s server, nobody for staff; the customer sees what the reseller did', async () => {
  const [r, rId] = await reseller('share-reseller@example.test');
  const [c, cId] = await customerOf(rId, 'share-customer@example.test');
  const [s1, s2, s3] = [await server(cId, 'share-1'), await server(cId, 'share-2'), await server(cId, 'share-3')];

  // The owner.
  assert.deepEqual((await powerOn([s1], c)).json(), { started: 1, skipped: 0 });
  assert.deepEqual(await lastOp(s1).then((o) => [o.owner_id, o.started_by, o.capped_for]), [cId, cId, cId]);
  // The reseller, on the customer's server: the reseller's share, whichever customer the server is.
  assert.deepEqual((await powerOn([s2], r)).json(), { started: 1, skipped: 0 });
  assert.deepEqual(await lastOp(s2).then((o) => [o.owner_id, o.started_by, o.capped_for]), [cId, rId, rId]);
  // Staff: not capped, so their operation never waits behind the customer's own.
  assert.deepEqual((await powerOn([s3], admin)).json(), { started: 1, skipped: 0 });
  assert.equal((await lastOp(s3)).capped_for, null);
  // Somebody else's server: nothing is started for it.
  const [stranger] = await signUp('share-stranger@example.test');
  assert.deepEqual((await powerOn([s1], stranger)).json(), { started: 0, skipped: 1 });

  // The customer's own activity: their own action with their address, the reseller's with who it was and no address,
  // and not the staff member's.
  const mine = (await get('/activity', c)).json().events.filter((e) => e.action === 'server.power_on');
  assert.deepEqual(mine.map((e) => e.metadata.serverId).sort(), [s1, s2].sort());
  const own = mine.find((e) => e.metadata.serverId === s1), theirs = mine.find((e) => e.metadata.serverId === s2);
  assert.deepEqual([own.actorId, own.actorEmail, own.metadata.forOwner], [cId, 'share-customer@example.test', undefined]);
  assert.deepEqual([theirs.actorId, theirs.actorEmail, theirs.ip, theirs.metadata.forOwner, theirs.metadata.actingAs], [rId, 'share-reseller@example.test', null, cId, 'reseller']);
  // The reseller's activity is its own; the stranger's has nothing of this.
  assert.ok((await get('/activity', r)).json().events.some((e) => e.action === 'server.power_on' && e.metadata.serverId === s2));
  assert.ok(!(await get('/activity', stranger)).json().events.some((e) => e.action === 'server.power_on'));
  for (const s of [s1, s2, s3]) await settle(s);
});

test('test notifications to a messaging address: a budget per address across accounts; connecting and testing an address: a budget per account', async () => {
  assert.equal((await put('/admin/settings/chat', { apps: ['webhook'] }, admin)).statusCode, 200);
  const [u1, id1] = await signUp('chat-one@example.test');
  const [u2, id2] = await signUp('chat-two@example.test');
  // The same webhook connected on two accounts, as a saved connection holds it. Its address is one the panel refuses
  // before it connects (the send fails without a request), which is all these budgets need: they count before the send.
  const target = (extra = {}) => encryptSecret(JSON.stringify({ url: 'https://127.0.0.1/hook', ...extra }), 'settings:chat');
  const connect = async (userId, enc) => (await one("INSERT INTO chat_connections (user_id, app, label, hint, target_enc) VALUES ($1, 'webhook', 'hook', '127.0.0.1', $2) RETURNING id", [userId, enc])).id;
  const first = await connect(id1, target({ secret: 'one' }));
  await connect(id2, target({ secret: 'two' }));
  const tryIt = (cookie, channel) => post('/notifications/test', { channel }, cookie);
  for (let i = 0; i < 3; i++) {
    const r = await tryIt(u1, 'chat');
    assert.deepEqual([r.statusCode, r.json().code], [422, 'NOTIFICATION_TEST_FAILED'], `first account ${i}`);
    assert.ok(!JSON.stringify(r.json()).includes('127.0.0.1'), 'nothing about the address in the answer');
  }
  for (let i = 0; i < 3; i++) assert.equal((await tryIt(u2, 'chat')).statusCode, 422, `second account ${i}`);
  // The address had its six, three from each account; the second account itself has tests left.
  let over = await tryIt(u2, 'chat');
  assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
  assert.equal((await tryIt(u2, 'inApp')).statusCode, 200);
  // Another address on the same account is another budget.
  await pool.query('DELETE FROM chat_connections WHERE user_id = $1', [id2]);
  await pool.query("INSERT INTO chat_connections (user_id, app, label, hint, target_enc) VALUES ($1, 'webhook', 'other', '127.0.0.2', $2)", [id2, encryptSecret(JSON.stringify({ url: 'https://127.0.0.2/hook' }), 'settings:chat')]);
  assert.equal((await tryIt(u2, 'chat')).statusCode, 422);

  // Testing one connection, and connecting: twenty sends an hour per account, counted when a request would be made.
  for (let i = 0; i < 20; i++) {
    const r = await post(`/chat/connections/${first}/test`, {}, u1);
    assert.deepEqual([r.statusCode, r.json().code], [422, 'CHAT_INVALID_URL'], `test ${i}`);
  }
  over = await post(`/chat/connections/${first}/test`, {}, u1);
  assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
  // Input that is refused before any request is not counted, and still answers what is wrong with it.
  const refused = await post('/chat/connections', { app: 'webhook', fields: { url: 'https://127.0.0.1/x' } }, u1);
  assert.deepEqual([refused.statusCode, refused.json().fields['fields.url']], [400, 'CHAT_INVALID_URL']);
  await put('/admin/settings/chat', { apps: [] }, admin);
});

test('a reseller\'s customer sees who manages the account and is told once; leaving ends the reseller\'s access and moves billing to the customer from the first unpaid period', async () => {
  const [r, rId] = await reseller('leave-reseller@example.test');
  const [c, cId] = await customerOf(rId, 'leave-customer@example.test');
  const [other] = await signUp('leave-other@example.test');
  const s1 = await server(cId, 'leave-1'), s2 = await server(cId, 'leave-2');
  // The reseller pays: one subscription about to renew, one the reseller booked to end with its period.
  const b1 = await subscription(rId, s1, 3), b2 = await subscription(rId, s2, 20, { cancel_at_period_end: true, auto_renew: false });
  await runBilling();
  const owed = await renewal(b1);
  assert.deepEqual([owed.owner_id, owed.status], [rId, 'unpaid'], 'the renewal is the reseller\'s');
  // The key the reseller put on the account for the servers it ordered, beside one of the customer's own.
  const mine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMineMineMineMineMineMineMineMineMineMineMine me', theirs = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIResellerResellerResellerResellerResellerRes r';
  await pool.query("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'laptop', $2, 'fp-mine'), ($1, 'reseller', $3, 'fp-theirs')", [cId, mine, theirs]);
  await pool.query('UPDATE servers SET ssh_public_keys = $2 WHERE id = $1', [s1, [mine, theirs]]);

  // Who manages the account, on the data the account page reads; nobody for an ordinary account or the reseller itself.
  assert.equal((await told(cId, 'managed')).length, 0);
  const summary = (await get('/reseller/summary', c)).json();
  // afterLeave: the prices that would change on leaving (none here: these servers are not priced from the catalog;
  // security-leftovers-2.test.mjs has the ones that are).
  assert.deepEqual(summary, { allocation: null, managedBy: { name: 'Acme Hosting', email: 'leave-reseller@example.test', brand: null, active: true, canLeave: true, afterLeave: [] } });
  assert.deepEqual((await get('/reseller/summary', other)).json(), { allocation: null, managedBy: null });
  assert.equal((await get('/reseller/summary', r)).json().managedBy, null);
  // Told once, the first time they use the panel; the answer stays, the notice is not repeated.
  assert.equal((await get('/reseller/summary', c)).json().managedBy.email, 'leave-reseller@example.test');
  const [notice, ...more] = await told(cId, 'managed');
  assert.equal(more.length, 0);
  assert.deepEqual([notice.data.data.name, notice.data.data.email], ['Acme Hosting', 'leave-reseller@example.test']);
  // Switched off, the reseller cannot act now; the customer still sees whose account it is.
  let saved = await put(`/admin/resellers/${rId}`, { discountPct: 20, active: false }, admin);
  assert.deepEqual(saved.json(), { ok: true, active: false, billedSubscriptions: 2 });
  assert.equal((await get('/reseller/summary', c)).json().managedBy.active, false);
  assert.equal((await get(`/servers/${s1}`, r)).statusCode, 404);
  saved = await put(`/admin/resellers/${rId}`, { discountPct: 20 }, admin);
  assert.deepEqual(saved.json(), { ok: true, active: true, billedSubscriptions: 2 });
  assert.equal((await get(`/servers/${s1}`, r)).statusCode, 200, 'the reseller manages the customer\'s server');

  // Leaving is the customer's: not somebody else's, not the reseller's for them.
  assert.deepEqual(await post('/reseller/leave', {}, other).then((x) => [x.statusCode, x.json().code]), [409, 'NOT_MANAGED']);
  assert.deepEqual(await post('/reseller/leave', {}, r).then((x) => [x.statusCode, x.json().code]), [409, 'NOT_MANAGED']);
  const left = await post('/reseller/leave', {}, c);
  assert.equal(left.statusCode, 200, left.body);
  assert.deepEqual(left.json(), { ok: true, servers: 2, subscriptions: 2, listPrices: [] });
  assert.equal((await one('SELECT reseller_id FROM users WHERE id = $1', [cId])).reseller_id, null);
  assert.equal((await get('/reseller/summary', c)).json().managedBy, null);
  // The reseller no longer reaches the servers, and has no lever left on them: the subscriptions are the customer's,
  // the booked cancellation is gone.
  assert.equal((await get(`/servers/${s1}`, r)).statusCode, 404);
  assert.deepEqual((await powerOn([s1], r)).json(), { started: 0, skipped: 1 });
  assert.deepEqual(await sub(b1), { owner_id: cId, status: 'active', cancel_at_period_end: false, auto_renew: true, suspended_at: null });
  assert.deepEqual(await sub(b2), { owner_id: cId, status: 'active', cancel_at_period_end: false, auto_renew: true, suspended_at: null });
  // The reseller's unpaid renewal is withdrawn; the next run invoices the customer for that period.
  assert.equal((await one('SELECT status FROM invoices WHERE id = $1', [owed.id])).status, 'cancelled');
  assert.equal(await renewal(b1), undefined, 'the period is free to be invoiced again');
  await runBilling();
  const now = await renewal(b1);
  assert.deepEqual([now.owner_id, now.status], [cId, 'unpaid']);
  assert.notEqual(now.id, owed.id);
  assert.equal((await one("SELECT count(*)::int AS n FROM invoices WHERE owner_id = $1 AND status = 'unpaid'", [rId])).n, 0, 'nothing more is asked of the reseller');
  // The reseller's key is no longer offered for a reinstall or a new server; the customer's own stays.
  assert.deepEqual((await pool.query('SELECT name FROM ssh_keys WHERE owner_id = $1', [cId])).rows.map((k) => k.name), ['laptop']);
  assert.deepEqual((await one('SELECT ssh_public_keys FROM servers WHERE id = $1', [s1])).ssh_public_keys, [mine]);
  // Both sides are told, and the event is in the customer's own activity.
  const [bye] = await told(cId, 'left');
  assert.deepEqual([bye.data.data.email, bye.data.data.servers, bye.data.data.keys], ['leave-reseller@example.test', '2', '1']);
  const [lost] = await told(rId, 'customer_left');
  assert.deepEqual([lost.data.data.email, lost.data.data.servers, lost.data.data.left], ['leave-customer@example.test', '2', '0']);
  const event = (await get('/activity', c)).json().events.find((e) => e.action === 'reseller.customer_released');
  assert.deepEqual([event.metadata.by, event.metadata.reseller, event.metadata.subscriptions, event.metadata.withdrawnInvoices, event.metadata.leftInvoices, event.metadata.removedKeys],
    ['customer', rId, 2, [owed.id], [], 1]);
  assert.deepEqual(await post('/reseller/leave', {}, c).then((x) => [x.statusCode, x.json().code]), [409, 'NOT_MANAGED'], 'only once');
});

test('removing a reseller, or staff taking one customer out, moves what its customers run to them: a suspended subscription starts clean, an invoice that is not a plain renewal stays the reseller\'s', async () => {
  const [r, rId] = await reseller('gone-reseller@example.test');
  const [c1, c1Id] = await customerOf(rId, 'gone-one@example.test');
  const [, c2Id] = await customerOf(rId, 'gone-two@example.test');
  const s1 = await server(c1Id, 'gone-1', { billing_hold: true }), s2 = await server(c2Id, 'gone-2');
  // The first customer's server is held for the reseller's arrears; the second's subscription has a resize charge open.
  const b1 = await subscription(rId, s1, -20, { status: 'suspended', suspended_at: new Date() }), b2 = await subscription(rId, s2, 20);
  const charge = (await post('/admin/billing/invoices', { userId: rId, currency: 'TRY', lines: [{ description: 'Fark', unitPrice: '10' }] }, admin)).json().invoiceId;
  await pool.query('UPDATE invoice_lines SET subscription_id = $2 WHERE invoice_id = $1', [charge, b2]);
  assert.equal((await get(`/admin/resellers/${rId}`, admin)).json().reseller.active, true);

  // Staff take the second customer out: not somebody who is not this reseller's customer, and not without the permission.
  assert.equal((await del(`/admin/resellers/${rId}/customers/${c2Id}`, r)).statusCode, 403);
  assert.equal((await del(`/admin/resellers/${rId}/customers/${rId}`, admin)).statusCode, 404);
  const out = await del(`/admin/resellers/${rId}/customers/${c2Id}`, admin);
  assert.equal(out.statusCode, 200, out.body);
  // listPrices / pricesKept: the server's list price cannot be told (it is not priced from the catalog), so it keeps its price.
  assert.deepEqual(out.json(), { ok: true, servers: 1, subscriptions: 1, withdrawnInvoices: [], leftInvoices: [charge], listPrices: [], pricesKept: [s2] });
  assert.equal((await sub(b2)).owner_id, c2Id);
  assert.deepEqual(await one('SELECT owner_id, status FROM invoices WHERE id = $1', [charge]), { owner_id: rId, status: 'unpaid' }, 'the charge stays the reseller\'s debt');
  assert.equal((await told(rId, 'customer_left')).length, 1);
  assert.equal((await one('SELECT reseller_id FROM users WHERE id = $1', [c1Id])).reseller_id, rId, 'the other customer is still the reseller\'s');

  // The reseller is removed: the remaining customer is an ordinary account that pays for its server, from a clean slate.
  assert.equal((await del(`/admin/resellers/${rId}`, admin)).statusCode, 204);
  assert.equal((await get(`/admin/resellers/${rId}`, admin)).json().reseller, null);
  assert.equal((await one('SELECT reseller_id FROM users WHERE id = $1', [c1Id])).reseller_id, null);
  assert.deepEqual(await sub(b1), { owner_id: c1Id, status: 'active', cancel_at_period_end: false, auto_renew: true, suspended_at: null });
  assert.equal((await one('SELECT billing_hold FROM servers WHERE id = $1', [s1])).billing_hold, false);
  assert.equal((await get(`/servers/${s1}`, r)).statusCode, 404);
  assert.equal((await get('/reseller/summary', c1)).json().managedBy, null);
  assert.equal((await told(c1Id, 'left')).length, 1);
  assert.equal((await told(rId, 'customer_left')).length, 1, 'a reseller that is removed is not told about each customer');
  const removed = await one("SELECT metadata FROM audit_events WHERE action = 'reseller.removed' ORDER BY id DESC LIMIT 1");
  assert.deepEqual([removed.metadata.target, removed.metadata.customers, removed.metadata.subscriptions], [rId, 1, 1]);
  // The customer is invoiced for the period nobody paid, with time to pay it.
  await runBilling();
  const due = await renewal(b1);
  assert.deepEqual([due.owner_id, due.status], [c1Id, 'unpaid']);
  assert.equal((await sub(b1)).status, 'active', 'not suspended again by the run that made the invoice');
});
