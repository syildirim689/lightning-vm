// Server and ownership fixes from the security review, against real PostgreSQL and Redis. No hypervisor, adapter or
// worker: the inventory (connection, host, datastore, location, image, packages) and the servers are rows written here,
// and every request below stops at the queued operation. What the worker does with them is in apps/worker/test.
//   a refused resize changes no price (two at once leave the accepted one's); a failed disk is credited once; a server
//   billed elsewhere is resized only by its billing system; a handed-over server keeps nothing of its previous owner; a
//   server with a copy on order stays where it is; an order is not bound to an unproven account; a VDC lists no foreign
//   image; the ticket list names no staff address; a customer cancels only what they started and nothing under way.
// Second review round: a booked cancellation does not follow a handed-over server; a request of the previous owner
//   that overlaps the hand-over is refused; an order is bound only to the account the billing system created (staff hand
//   another over, emptied); that system's order ignores the customer's role and quota and its customers do not order in
//   the panel while panel billing is off; a retried resize keeps what the server gained since; after a restore nothing
//   starts until staff release the hold.
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
const { forgetRestoreHold } = await import('../../dist/restore-hold.js');
const { readFileSync } = await import('node:fs');

let app, admin, adminId, a, aId, b, bId, connectionId, poolId, imageId, small, large;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload, headers = {}) => app.inject({ method, url, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie, headers) => call('POST', url, cookie, payload, headers);
const put = (url, payload, cookie) => call('PUT', url, cookie, payload);
const key = () => ({ 'idempotency-key': randomUUID() });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const serverRow = (id) => one('SELECT * FROM servers WHERE id = $1', [id]);
const openOps = async (id) => (await pool.query("SELECT * FROM operations WHERE server_id = $1 AND status IN ('pending', 'running')", [id])).rows;
// Nothing here runs operations: an open one is ended by hand so the next request finds the server free.
const settle = (id) => pool.query("UPDATE operations SET status = 'succeeded', finished_at = now() WHERE server_id = $1 AND status IN ('pending', 'running')", [id]);
const freshLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); }; // several accounts are made from one address
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); return [cookieOf(r), r.json().user.id]; };
// A ready server as a finished order leaves it (2 vCPU, 2 GB, 40 GB on the small package at 30.00).
const server = async (ownerId, name, extra = {}) => {
  const cols = { owner_id: ownerId, pool_id: poolId, image_id: imageId, package_id: small, name, vcpu: 2, memory_mb: 2048, disk_gb: 40, price_monthly: '30.00', currency: 'TRY',
    state: 'ready', power_state: 'poweredOff', vm_moref: `vm-${name}`, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO servers (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
const operation = async (serverId, ownerId, startedBy, extra = {}) => {
  const cols = { kind: 'power_on', status: 'pending', idempotency_key: randomUUID(), request_hash: 'x', server_id: serverId, owner_id: ownerId, step: 'queued', started_by: startedBy, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO operations (${names.join(', ')}, deadline_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}, now() + interval '30 minutes') RETURNING id`, Object.values(cols))).id;
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
  adminId = (await one("SELECT id FROM users WHERE email = 'boss@example.test'")).id;
  await put('/admin/settings', { registrationOpen: true }, admin);
  [a, aId] = await signUp('a@example.test');
  [b, bId] = await signUp('b@example.test');
  await put('/admin/settings/servers', { deleteGraceHours: 0 }, admin);

  // The full suite (run.sh) has a worker on this database and queue. These tests are about what the API leaves behind,
  // so the worker must not take the queued operations up: it would mark them running, fail them against a hypervisor
  // that is not there, put a resize's price back and reopen an operation the test had ended. The connection's password
  // is therefore one the worker cannot read (encrypted for another context): it fails while loading the operation,
  // before it writes anything, and every operation stays exactly as the API queued it, with or without a worker. The
  // API never reads this password here (no request below reaches an adapter).
  connectionId = randomUUID();
  await pool.query(`INSERT INTO vmware_connections (id, name, kind, host, port, username, password_enc, tls_mode, product, write_api, operations)
    VALUES ($1, 'Fixture', 'vcenter', 'vc.example.test', 443, 'svc', $2, 'system', '{}', 'available', '{"cloneFromImage": true}')`, [connectionId, encryptSecret('pw', 'not-this-connection')]);
  await pool.query(`INSERT INTO vmware_hosts (connection_id, moref, name, hardware_uuid, cpu_cores, memory_bytes, parent) VALUES ($1, 'host-1', 'esx1', 'hw-1', 64, $2, 'cluster-1')`, [connectionId, 512 * 2 ** 30]);
  await pool.query(`INSERT INTO vmware_datastores (connection_id, moref, name, capacity_bytes, free_bytes, accessible) VALUES ($1, 'ds-1', 'ds1', $2, $2, true)`, [connectionId, 8000 * 2 ** 30]);
  poolId = (await one(`INSERT INTO resource_pools (name, connection_id, compute_moref, datastore_morefs, network_moref, extra_disk_price_gb)
    VALUES ('Fixture', $1, 'cluster-1', '{ds-1}', 'net-1', 0.10) RETURNING id`, [connectionId])).id;
  imageId = (await one("INSERT INTO os_images (name, family, connection_id, template_moref) VALUES ('Public Debian', 'linux', $1, 'tpl-1') RETURNING id", [connectionId])).id;
  small = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('small', 2, 2048, 40, 30, 'TRY') RETURNING id")).id;
  large = (await one("INSERT INTO packages (name, vcpu, memory_mb, disk_gb, price_monthly, currency) VALUES ('large', 8, 16384, 40, 80, 'TRY') RETURNING id")).id;
  await pool.query('INSERT INTO package_pools (package_id, pool_id) VALUES ($1, $3), ($2, $3)', [small, large, poolId]);
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('two resizes at once: one is accepted and the server carries its price; the refused one changes nothing', async () => {
  const id = await server(aId, 'resize-1');
  const body = { type: 'package', packageId: large };
  for (let trial = 0; trial < 5; trial++) {
    const answers = await Promise.all([post(`/servers/${id}/resize`, body, a, key()), post(`/servers/${id}/resize`, body, a, key())]);
    assert.deepEqual(answers.map((r) => r.statusCode).sort(), [202, 409], answers.map((r) => r.body).join(' '));
    assert.equal(answers.find((r) => r.statusCode === 409).json().code, 'OPERATION_IN_PROGRESS');
    const [op, ...more] = await openOps(id);
    assert.equal(more.length, 0);
    const row = await serverRow(id);
    assert.equal(row.price_monthly, op.params.to.priceMonthly, `trial ${trial}: the price is the accepted operation's`);
    assert.deepEqual([row.price_monthly, row.package_id], ['80.00', large]);
    assert.deepEqual([op.params.from.priceMonthly, op.params.from.packageId], ['30.00', small], 'what a failed resize would put back');
    // A third request while that one is open: refused, and nothing is written.
    assert.equal((await post(`/servers/${id}/resize`, body, a, key())).statusCode, 409);
    assert.equal((await serverRow(id)).price_monthly, '80.00');
    // Back to the start for the next trial (the shape never changed: no worker).
    await settle(id);
    await pool.query("UPDATE servers SET price_monthly = 30, package_id = $2 WHERE id = $1", [id, small]);
  }
});

test('a failed extra disk removed by several requests at once is credited once', async () => {
  const id = await server(aId, 'disk-1', { price_monthly: '40.00' });
  for (let trial = 0; trial < 4; trial++) {
    await pool.query('UPDATE servers SET price_monthly = 40 WHERE id = $1', [id]);
    const disk = (await one("INSERT INTO server_disks (server_id, size_gb, price_monthly, status) VALUES ($1, 100, 10, 'failed') RETURNING id", [id])).id;
    const answers = await Promise.all([1, 2, 3, 4].map(() => call('DELETE', `/servers/${id}/disks/${disk}`, a)));
    assert.deepEqual(answers.map((r) => r.statusCode).sort(), [202, 404, 404, 404], `trial ${trial}`);
    assert.equal((await serverRow(id)).price_monthly, '30.00', `trial ${trial}: one credit`);
    assert.equal((await call('DELETE', `/servers/${id}/disks/${disk}`, a)).json().code, 'NOT_FOUND');
    assert.equal((await serverRow(id)).price_monthly, '30.00');
  }
});

test('a server billed by another system: its owner starts nothing priced; staff and the integration do, whatever the customer switch says', async () => {
  const id = await server(aId, 'ext-1', { external_source: 'whmcs', external_ref: 'svc-1' });
  const body = { type: 'package', packageId: large };
  assert.equal((await get(`/servers/${id}`, a)).json().allowed.resize, false, 'the page does not offer it');
  assert.equal((await get(`/servers/${id}`, admin)).json().allowed.resize, true);
  for (const r of [await post(`/servers/${id}/resize/quote`, body, a), await post(`/servers/${id}/resize`, body, a, key()), await post(`/servers/${id}/disks`, { sizeGb: 100 }, a)]) {
    assert.deepEqual([r.statusCode, r.json().code], [409, 'EXTERNALLY_BILLED'], r.body);
  }
  // A copy of it is not ordered in the panel either.
  const sshKey = (await one("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'k', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixtureFix a@x', 'fp-a') RETURNING id", [aId])).id;
  const copy = await post('/servers', { type: 'package', poolId, packageId: small, imageId, name: 'ext-copy', sshKeyIds: [sshKey], cloneFrom: id }, a, key());
  assert.deepEqual([copy.statusCode, copy.json().code], [409, 'EXTERNALLY_BILLED'], copy.body);
  assert.deepEqual([(await serverRow(id)).price_monthly, (await openOps(id)).length, (await one('SELECT count(*)::int AS n FROM server_disks WHERE server_id = $1', [id])).n], ['30.00', 0, 0]);
  // The customer switch is the customers': with it off the billing system's Change Package still goes through.
  await put('/admin/settings/servers', { customer: { resize: false } }, admin);
  assert.equal((await post(`/servers/${id}/resize`, body, a, key())).json().code, 'EXTERNALLY_BILLED');
  const changed = await post('/admin/external/whmcs/servers/svc-1/resize', body, admin);
  assert.equal(changed.statusCode, 202, changed.body);
  await put('/admin/settings/servers', { customer: { resize: true } }, admin);
  const [op] = await openOps(id);
  assert.deepEqual([op.kind, op.params.vcpu, op.started_by], ['resize', 8, null], 'started for the billing system, not by the customer');
  assert.equal((await serverRow(id)).price_monthly, '80.00');
  // ...and the owner cannot cancel what the billing system started.
  assert.equal((await post(`/servers/${id}/operations/${op.id}/cancel`, undefined, a)).statusCode, 409);
  await settle(id);
  await pool.query('UPDATE servers SET vcpu = 8, memory_mb = 16384 WHERE id = $1', [id]); // what the worker would have recorded
  // Staff, on the customer's page: allowed.
  const byStaff = await post(`/servers/${id}/resize`, { type: 'package', packageId: small }, admin, key());
  assert.equal(byStaff.statusCode, 202, byStaff.body);
  await settle(id);
});

test('a handed-over server keeps nothing of its previous owner: keys, password, guest tokens, schedules, labels', async () => {
  const stored = { ssh_public_keys: ['ssh-ed25519 AAAA-previous-owner prev@x'], root_password_hash: '$6$dummy$PREVIOUSOWNERHASH',
    root_password_enc: encryptSecret('PrevOwner-Secret-Pass-1', 'server-root-password'), app_token_hash: 'apphash', tags: ['prod'], notes: 'my notes' };
  for (const how of ['accept', 'staff']) {
    const name = `move-${how}`;
    const id = await server(aId, name, stored);
    // Update tracking as the previous owner turned it on: the token is theirs.
    const enabled = (await post(`/servers/${id}/updates/enable`, undefined, a)).json();
    const token = enabled.command.trim().split(' ').pop();
    const report = () => post('/guest/updates/report', { id, token, os: 'FORGED BY PREVIOUS OWNER', manager: 'apt', total: 0, security: 0 });
    assert.equal((await report()).statusCode, 200);
    await pool.query("INSERT INTO power_schedules (server_id, action, days, at_time, timezone) VALUES ($1, 'shutdown', '{1}', '03:00', 'UTC')", [id]);
    await pool.query("UPDATE servers SET delete_at = now() + interval '1 day' WHERE id = $1", [id]);
    // The previous owner booked the subscription's end (and billing had marked the server to go): neither follows it.
    const sub = (await one(`INSERT INTO subscriptions (owner_id, kind, server_id, description, amount, currency, status, period_start, period_end, auto_renew, cancel_at_period_end)
      VALUES ($1, 'server', $2, 'fixture', 30, 'TRY', 'active', current_date - 10, current_date + 20, false, true) RETURNING id`, [aId, id])).id;
    await pool.query("UPDATE servers SET billing_remove = 'cancel' WHERE id = $1", [id]);
    assert.equal((await get(`/servers/${id}/root-password`, a)).json().password, 'PrevOwner-Secret-Pass-1');

    if (how === 'accept') {
      const offer = await post(`/servers/${id}/transfer`, { email: 'b@example.test' }, a);
      assert.equal(offer.statusCode, 201, offer.body);
      assert.equal((await post(`/transfers/${offer.json().id}/accept`, undefined, b)).statusCode, 200);
    } else assert.equal((await put(`/admin/servers/${id}/owner`, { email: 'b@example.test' }, admin)).statusCode, 200);

    const row = await serverRow(id);
    assert.deepEqual([row.owner_id, row.ssh_public_keys, row.root_password_hash, row.root_password_enc, row.app_token_hash, row.app_script_enc, row.tags, row.notes, row.delete_at],
      [bId, [], null, null, null, null, [], '', null], how);
    assert.equal((await one('SELECT count(*)::int AS n FROM server_updates WHERE server_id = $1', [id])).n, 0);
    assert.equal((await one('SELECT count(*)::int AS n FROM power_schedules WHERE server_id = $1', [id])).n, 0);
    assert.deepEqual(await one('SELECT owner_id, status, cancel_at_period_end, auto_renew FROM subscriptions WHERE id = $1', [sub]),
      { owner_id: bId, status: 'active', cancel_at_period_end: false, auto_renew: true }, `${how}: the subscription follows without the booked cancellation`);
    assert.equal(row.billing_remove, null, `${how}: no removal mark is carried over`);
    // A console ticket the previous owner asked for before the move is refused by the gateway: the marker it reads.
    const marked = Number(await redis.get(`console:revoked:user:${aId}`));
    assert.ok(marked > Date.now() - 60_000 && marked <= Date.now(), `${how}: revocation marker ${marked}`);
    assert.ok((await redis.ttl(`console:revoked:user:${aId}`)) > 60, 'it outlives a ticket');
    await redis.del(`console:revoked:user:${aId}`);
    await pool.query('DELETE FROM subscriptions WHERE id = $1', [sub]);
    assert.equal((await report()).statusCode, 404, 'the old reporter token is dead');
    assert.equal((await get(`/servers/${id}/updates`, b)).json().enabled, false);
    assert.equal((await get(`/servers/${id}`, a)).statusCode, 404);
    assert.equal((await get(`/servers/${id}/root-password`, b)).statusCode, 404, 'the new owner cannot read the old password');

    // A reinstall without keys or a password: a new password, never the stored ones (there are none) and no key.
    const again = await post(`/servers/${id}/reinstall`, { imageId, confirm: name }, b, key());
    assert.equal(again.statusCode, 202, again.body);
    assert.equal(again.json().passwordReplaced, true);
    const fresh = await serverRow(id);
    assert.deepEqual(fresh.ssh_public_keys, []);
    assert.ok(fresh.root_password_hash && fresh.root_password_hash !== stored.root_password_hash);
    const shown = (await get(`/servers/${id}/root-password`, b)).json().password;
    assert.ok(shown && shown !== 'PrevOwner-Secret-Pass-1');
  }
});

test('a server with a copy on order is not handed over, moved, reinstalled or deleted', async () => {
  const id = await server(aId, 'source-1');
  const copy = await server(aId, 'copy-1', { state: 'provisioning', vm_moref: null, clone_from_moref: 'vm-source-1', clone_from_server_id: id });
  assert.equal((await post(`/servers/${id}/transfer`, { email: 'b@example.test' }, a)).json().fields.server, 'CLONE_PENDING');
  assert.equal((await put(`/admin/servers/${id}/owner`, { email: 'b@example.test' }, admin)).json().fields.server, 'CLONE_PENDING');
  assert.equal((await post(`/servers/${id}/reinstall`, { imageId, confirm: 'source-1' }, a, key())).json().code, 'CLONE_PENDING');
  const gone = await call('DELETE', `/servers/${id}`, a, { confirm: 'source-1' }, key());
  assert.deepEqual([gone.statusCode, gone.json().code], [409, 'CLONE_PENDING']);
  assert.equal((await serverRow(id)).state, 'ready');
  // The copy is built (or its order is over): the source is free again.
  await pool.query("UPDATE servers SET state = 'ready', vm_moref = 'vm-copy-1' WHERE id = $1", [copy]);
  const offer = await post(`/servers/${id}/transfer`, { email: 'b@example.test' }, a);
  assert.equal(offer.statusCode, 201, offer.body);
  assert.equal((await post(`/transfers/${offer.json().id}/cancel`, undefined, a)).statusCode, 204);
});

test('an order from the billing system is bound only to the account that system created; staff hand another over, without what its earlier holder had', async () => {
  const lookup = (email, source = 'whmcs') => post(`/admin/external/${source}/customers`, { email }, admin);
  const claim = (id, source = 'whmcs', who = admin) => post(`/admin/external/${source}/customers/${id}/claim`, undefined, who);
  // Somebody registered the buyer's address first (open registration: the account works at once, unverified) and set
  // up ways back in: a session, an API token, a saved SSH key, a phone number.
  const [squat, squatter] = await signUp('buyer@example.test');
  await pool.query("INSERT INTO api_tokens (user_id, name, token_hash, hint, scope) VALUES ($1, 'kept', 'hash-of-kept-token', 'abcd', 'write')", [squatter]);
  await pool.query("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'mine', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISquatterSquatterSquatterSquatterSquatterSqu s@x', 'fp-squatter')", [squatter]);
  await pool.query("UPDATE users SET phone_number = '+905550000001', phone_number_verified = true WHERE id = $1", [squatter]);
  const refused = await lookup('Buyer@Example.test');
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'CUSTOMER_NEEDS_REVIEW'], refused.body);
  // Proven (an e-mail code or link, or staff marked it) says nothing about who made those: still not matched.
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [squatter]);
  assert.equal((await lookup('buyer@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW');
  assert.equal((await get('/servers', squat)).statusCode, 200, 'the registrant is still signed in');
  // Staff hand the account to the billing system: a deliberate step (users.manage), and the account is emptied in it.
  assert.equal((await claim(squatter, 'whmcs', a)).statusCode, 403);
  const handed = await claim(squatter);
  assert.equal(handed.statusCode, 200, handed.body);
  assert.deepEqual([handed.json().removed.apiTokens, handed.json().removed.sshKeys, handed.json().removed.passwords, handed.json().removed.sessions >= 1], [1, 1, 1, true]);
  assert.equal((await get('/servers', squat)).statusCode, 401, 'the registrant\'s session is over');
  await freshLimits();
  assert.notEqual((await post('/auth/sign-in/email', { email: 'buyer@example.test', password })).statusCode, 200, 'and their password opens nothing');
  assert.deepEqual(await one(`SELECT external_source, email_verified, phone_number, two_factor_enabled, (SELECT count(*)::int FROM api_tokens t WHERE t.user_id = u.id) AS tokens,
    (SELECT count(*)::int FROM auth_sessions s WHERE s.user_id = u.id) AS sessions, (SELECT count(*)::int FROM ssh_keys k WHERE k.owner_id = u.id) AS keys,
    (SELECT count(*)::int FROM auth_accounts c WHERE c.user_id = u.id AND c.password IS NOT NULL) AS passwords FROM users u WHERE u.id = $1`, [squatter]),
    { external_source: 'whmcs', email_verified: true, phone_number: null, two_factor_enabled: false, tokens: 0, sessions: 0, keys: 0, passwords: 0 });
  const noted = await one("SELECT actor_id, metadata FROM audit_events WHERE action = 'external.customer_claimed' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([noted.actor_id, noted.metadata.target, noted.metadata.source], [adminId, squatter, 'whmcs']);
  assert.deepEqual((await lookup('buyer@example.test')).json(), { id: squatter, created: false });
  assert.equal((await claim(squatter, 'wisecp')).json().code, 'CUSTOMER_NEEDS_REVIEW', 'not handed on to another system');
  assert.equal((await claim(adminId)).statusCode, 400, 'never one\'s own account');
  // A reseller's customer: created unverified, and never matched (the reseller manages its servers).
  const [reseller, resellerId] = await signUp('reseller@example.test');
  await pool.query('INSERT INTO resellers (user_id) VALUES ($1)', [resellerId]);
  const made = await post('/reseller/customers', { email: 'buyer2@example.test' }, reseller);
  assert.equal(made.statusCode, 201, made.body);
  assert.deepEqual(await one('SELECT email_verified, reseller_id FROM users WHERE id = $1', [made.json().id]), { email_verified: false, reseller_id: resellerId });
  assert.equal((await lookup('buyer2@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW');
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [made.json().id]);
  assert.equal((await lookup('buyer2@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW', 'verified or not, it is the reseller\'s');
  assert.equal((await claim(made.json().id)).json().code, 'CUSTOMER_NEEDS_REVIEW', 'and it cannot be handed over');
  // The reseller's own account is not a buyer's either.
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [resellerId]);
  assert.equal((await lookup('reseller@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW');
  assert.equal((await claim(resellerId)).json().code, 'CUSTOMER_NEEDS_REVIEW');
  assert.equal((await one('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1', [resellerId])).n > 0, true, 'a refused hand-over removes nothing');
  // A new address: created for this system, found again by it, and not handed to another system.
  const fresh = (await lookup('new.client@example.test')).json();
  assert.equal(fresh.created, true);
  assert.equal((await one('SELECT external_source FROM users WHERE id = $1', [fresh.id])).external_source, 'whmcs');
  assert.deepEqual((await lookup('new.client@example.test')).json(), { id: fresh.id, created: false });
  assert.equal((await lookup('new.client@example.test', 'wisecp')).json().code, 'CUSTOMER_NEEDS_REVIEW');
});

test('a virtual data center lists shared images and the caller\'s own, not another customer\'s', async () => {
  await pool.query("INSERT INTO os_images (name, family, connection_id, template_moref, owner_id) VALUES ('A-secret-project-golden-image', 'linux', $1, 'tpl-a', $2), ('B own image', 'linux', $1, 'tpl-b', $3)", [connectionId, aId, bId]);
  await pool.query("INSERT INTO vdcs (owner_id, name, pool_id, vcpu, memory_mb, disk_gb, max_servers) VALUES ($1, 'dc', $2, 8, 8192, 100, 4)", [bId, poolId]);
  const { vdcs } = (await get('/vdcs', b)).json();
  assert.deepEqual(vdcs[0].images.map((i) => i.name).sort(), ['B own image', 'Public Debian']);
});

test('the customer\'s ticket list does not carry the assigned staff member\'s address', async () => {
  const id = (await one("INSERT INTO tickets (owner_id, assignee_id, subject) VALUES ($1, $2, 'Disk is full') RETURNING id", [aId, adminId])).id;
  const [mine] = (await get('/support/tickets', a)).json().tickets;
  assert.deepEqual([mine.id, mine.assigneeEmail], [id, null]);
  assert.ok(!JSON.stringify(mine).includes('boss@example.test'));
  assert.equal((await get(`/support/tickets/${id}`, a)).json().ticket.assigneeEmail, null);
  assert.equal((await get(`/support/tickets/${id}`, admin)).json().ticket.assigneeEmail, 'boss@example.test', 'staff still see who holds it');
});

test('a customer cancels what they started and only before anything is under way; staff may ask for any', async () => {
  const id = await server(aId, 'cancel-1');
  const cancel = (op, who) => post(`/servers/${id}/operations/${op}/cancel`, undefined, who);
  const flagged = async (op) => (await one('SELECT cancel_requested FROM operations WHERE id = $1', [op])).cancel_requested;
  // Started by staff (or by billing, a schedule, the integration: nobody): not the customer's to cancel.
  for (const startedBy of [adminId, null]) {
    const op = await operation(id, aId, startedBy);
    assert.equal((await cancel(op, a)).statusCode, 409);
    assert.equal(await flagged(op), false);
    assert.equal((await cancel(op, admin)).statusCode, 202);
    await settle(id);
  }
  // Their own, not picked up yet: cancelled.
  const queued = await operation(id, aId, aId, { kind: 'resize' });
  assert.equal((await cancel(queued, b)).statusCode, 404, 'not their server');
  assert.equal((await cancel(queued, a)).statusCode, 202);
  assert.equal(await flagged(queued), true);
  await settle(id);
  // Their own, under way (a task may be at the hypervisor): not by the customer; staff may ask, and the worker waits the task out.
  for (const under of [{ status: 'running', step: 'resize' }, { status: 'pending', step: 'resize', attempts: 1 }, { status: 'pending', step: 'queued', provider_task_id: 'task-1' }]) {
    const op = await operation(id, aId, aId, { kind: 'resize', ...under });
    assert.equal((await cancel(op, a)).statusCode, 409, JSON.stringify(under));
    assert.equal(await flagged(op), false);
    await settle(id);
  }
  const running = await operation(id, aId, aId, { kind: 'disk_add', status: 'running', step: 'disk' });
  assert.equal((await cancel(running, admin)).statusCode, 202);
  await settle(id);
  // A build is the exception: cancelling it removes what it made, at any step.
  const build = await operation(id, aId, aId, { kind: 'create', status: 'running', step: 'readiness' });
  assert.equal((await cancel(build, a)).statusCode, 202);
  await settle(id);
});

test('migration 078 marks the accounts the billing system created before the column, and no other', async () => {
  const [, made] = await signUp('old.integration@example.test'); // stands for one the integration made before migration 075
  const [, held] = await signUp('old.registrant@example.test'); // registered by somebody, verified since, owns a server of that system
  await pool.query('UPDATE users SET email_verified = true WHERE id = ANY($1::uuid[])', [[made, held]]);
  await server(held, 'old-ext', { external_source: 'whmcs', external_ref: 'old-1' });
  await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'external.customer_created', 'success', $2)", [adminId, { target: made, source: 'whmcs' }]);
  await pool.query(readFileSync(new URL('../../migrations/078_external_customers_backfill.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await pool.query('SELECT external_source FROM users WHERE id = ANY($1::uuid[]) ORDER BY email', [[made, held]])).rows.map((r) => r.external_source), ['whmcs', null]);
  const lookup = (email) => post('/admin/external/whmcs/customers', { email }, admin);
  assert.deepEqual((await lookup('old.integration@example.test')).json(), { id: made, created: false }, 'the integration\'s own customer keeps matching after the upgrade');
  assert.equal((await lookup('old.registrant@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW', 'owning a server of the system is no proof of who made the account');
});

test('a request of the previous owner that overlaps the hand-over is refused: nothing of theirs lands on the new owner\'s server', async () => {
  const name = 'straddle-1';
  const id = await server(aId, name);
  const keyId = (await one("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'straddle', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStraddleStraddleStraddleStraddleStraddleStraddl a@straddle', 'fp-straddle') RETURNING id", [aId])).id;
  const net = (await one("INSERT INTO private_networks (owner_id, pool_id, name, cidr, vlan, portgroup_moref) VALUES ($1, $2, 'a-net', '10.9.0.0/24', 901, 'pg-901') RETURNING id", [aId, poolId])).id;
  await pool.query("UPDATE resource_pools SET backup_datastore_moref = 'ds-1' WHERE id = $1", [poolId]);
  await pool.query("INSERT INTO quotas (scope, subject_id) VALUES ('user', $1)", [aId]); // no limits: the earlier tests left this account many servers
  const schedule = { action: 'shutdown', days: [1, 2, 3, 4, 5, 6, 7], time: '03:00', timezone: 'UTC' };
  // The routes work for the owner: a schedule is made and removed again.
  const made = await post(`/servers/${id}/schedules`, schedule, a);
  assert.equal(made.statusCode, 201, made.body);
  assert.equal((await call('DELETE', `/servers/${id}/schedules/${made.json().id}`, a)).statusCode, 204);

  const offer = await post(`/servers/${id}/transfer`, { email: 'b@example.test' }, a);
  assert.equal(offer.statusCode, 201, offer.body);
  // The transfer is held open inside its transaction: it has locked the server, run its checks and moved the row, and
  // now waits for the previous owner's star on the server, which another connection holds. The lock only widens the
  // window; it changes no decision.
  await pool.query('INSERT INTO server_favorites (user_id, server_id) VALUES ($1, $2)', [aId, id]);
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM server_favorites WHERE user_id = $1 AND server_id = $2 FOR UPDATE', [aId, id]);
  const waiting = async (n) => {
    for (let i = 0, seen = 0; i < 150; i++) {
      seen = (await one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).n;
      if (seen >= n) return;
      await new Promise((r) => setTimeout(r, 100));
      if (i === 149) assert.fail(`only ${seen} of ${n} statements are waiting on the held transfer: ${JSON.stringify((await pool.query("SELECT state, wait_event_type, wait_event, left(query, 90) AS query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'")).rows)}`);
    }
  };
  let answers;
  const accept = post(`/transfers/${offer.json().id}/accept`, undefined, b);
  try {
    await waiting(1);
    assert.equal((await serverRow(id)).owner_id, aId, 'not committed yet: the previous owner still passes the ownership read');
    // Every write a customer can make on a server, sent by the previous owner now. Each has read the server as theirs.
    const requests = {
      schedule: () => post(`/servers/${id}/schedules`, schedule, a),
      delete: () => call('DELETE', `/servers/${id}`, a, { confirm: name }, key()),
      reinstall: () => post(`/servers/${id}/reinstall`, { imageId, confirm: name, sshKeyIds: [keyId] }, a, key()),
      power: () => post(`/servers/${id}/actions`, { action: 'power_on' }, a, key()),
      lock: () => put(`/servers/${id}/lock`, { locked: true }, a),
      rename: () => put(`/servers/${id}/name`, { name: 'renamed-by-previous-owner' }, a),
      updates: () => post(`/servers/${id}/updates/enable`, undefined, a),
      disk: () => post(`/servers/${id}/disks`, { sizeGb: 10 }, a),
      network: () => post(`/networks/${net}/servers`, { serverId: id }, a),
      backup: () => post(`/servers/${id}/backups`, { note: 'mine' }, a),
    };
    const sent = Object.entries(requests).map(([what, send]) => send().then((r) => [what, r.statusCode]));
    await waiting(1 + sent.length);
    await holder.query('ROLLBACK');
    assert.equal((await accept).statusCode, 200);
    answers = await Promise.all(sent);
  } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); }
  assert.deepEqual(answers, Object.keys({ schedule: 1, delete: 1, reinstall: 1, power: 1, lock: 1, rename: 1, updates: 1, disk: 1, network: 1, backup: 1 }).map((what) => [what, 404]), 'each is answered as after the hand-over');
  const row = await serverRow(id);
  assert.deepEqual([row.owner_id, row.name, row.state, row.locked, row.delete_at, row.ssh_public_keys, row.root_password_hash, row.price_monthly], [bId, name, 'ready', false, null, [], null, '30.00']);
  const left = await one(`SELECT (SELECT count(*)::int FROM power_schedules WHERE server_id = $1) AS schedules, (SELECT count(*)::int FROM operations WHERE server_id = $1) AS operations,
    (SELECT count(*)::int FROM server_updates WHERE server_id = $1) AS updates, (SELECT count(*)::int FROM server_disks WHERE server_id = $1) AS disks,
    (SELECT count(*)::int FROM private_network_members WHERE server_id = $1) AS networks, (SELECT count(*)::int FROM backups WHERE server_id = $1) AS backups`, [id]);
  assert.deepEqual(left, { schedules: 0, operations: 0, updates: 0, disks: 0, networks: 0, backups: 0 });
  // Afterwards it is the new owner's in every respect.
  assert.equal((await post(`/servers/${id}/schedules`, schedule, a)).statusCode, 404);
  assert.equal((await post(`/servers/${id}/schedules`, schedule, b)).statusCode, 201);
  assert.equal((await post(`/servers/${id}/actions`, { action: 'power_on' }, b, key())).statusCode, 202);
  await settle(id);
  await pool.query('UPDATE resource_pools SET backup_datastore_moref = NULL WHERE id = $1', [poolId]);
  await pool.query("DELETE FROM quotas WHERE scope = 'user' AND subject_id = $1", [aId]);
});

test('the billing system\'s order does not depend on the customer\'s role or quota; its customers do not order in the panel while panel billing is off', async () => {
  await pool.query("INSERT INTO ip_pools (name, pool_id, cidr, gateway, range_start, range_end) VALUES ('fixture', $1, '203.0.113.0/24', '203.0.113.1', '203.0.113.10', '203.0.113.60')", [poolId]);
  const customer = (await post('/admin/external/whmcs/customers', { email: 'sold@example.test' }, admin)).json();
  assert.equal(customer.created, true);
  // The operator took ordering from this customer (as from the whole customer role) and gave the account no quota.
  await pool.query("INSERT INTO user_permission_overrides (user_id, permission, effect) VALUES ($1, 'servers.create', 'deny')", [customer.id]);
  await pool.query("INSERT INTO quotas (scope, subject_id, max_servers, max_vcpu, max_memory_mb, max_disk_gb) VALUES ('user', $1, 0, 0, 0, 0)", [customer.id]);
  const body = { type: 'package', poolId, packageId: small, imageId };
  const sold = await post('/admin/external/whmcs/servers', { ...body, reference: 'svc-9', customerId: customer.id, name: 'sold-1',
    sshKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExternalExternalExternalExternalExternalExternal sold@x' }, admin);
  assert.equal(sold.statusCode, 202, sold.body);
  const row = await serverRow(sold.json().serverId);
  assert.deepEqual([row.owner_id, row.external_source, row.external_ref], [customer.id, 'whmcs', 'svc-9']);
  assert.equal((await openOps(row.id))[0].started_by, null);
  // Its change of package (once the server is built) is not held to the quota either.
  await settle(row.id);
  await pool.query("UPDATE servers SET state = 'ready', vm_moref = 'vm-sold-1' WHERE id = $1", [row.id]);
  const bigger = await post('/admin/external/whmcs/servers/svc-9/resize', { type: 'package', packageId: large }, admin);
  assert.equal(bigger.statusCode, 202, bigger.body);
  await settle(row.id);

  // Customers themselves. An account of the billing system does not order in the panel while nobody would bill it...
  const [own, ownId] = await signUp('ext.self@example.test');
  const keyOf = async (ownerId, tag) => (await one("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'k', $2, $3) RETURNING id",
    [ownerId, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISelfOrderSelfOrderSelfOrderSelfOrderSelf${tag} k@x`, `fp-self-${tag}`])).id;
  const order = (who, name, keyId) => post('/servers', { ...body, name, sshKeyIds: [keyId] }, who, key());
  const mine = await keyOf(ownId, 'One');
  await pool.query("UPDATE users SET external_source = 'whmcs' WHERE id = $1", [ownId]);
  const self = await order(own, 'self-1', mine);
  assert.deepEqual([self.statusCode, self.json().code], [409, 'EXTERNALLY_BILLED'], self.body);
  assert.equal((await one('SELECT count(*)::int AS n FROM servers WHERE owner_id = $1', [ownId])).n, 0);
  // ...an ordinary customer still does, and one whose role lacks the permission does not.
  await pool.query('UPDATE users SET external_source = NULL WHERE id = $1', [ownId]);
  const plain = await order(own, 'self-2', mine);
  assert.equal(plain.statusCode, 202, plain.body);
  await pool.query("INSERT INTO user_permission_overrides (user_id, permission, effect) VALUES ($1, 'servers.create', 'deny')", [ownId]);
  assert.equal((await order(own, 'self-3', mine)).statusCode, 403);
});

test('a retried resize keeps what the server gained since, forgets an old cancel request, and is refused when the server changed', async () => {
  const id = await server(aId, 'retry-1');
  const params = { vcpu: 8, memoryMb: 16384, diskGb: 40, powerOn: false, from: { vcpu: 2, memoryMb: 2048, diskGb: 40, priceMonthly: '30.00', packageId: small, trafficGb: null, priceHourly: null },
    to: { priceMonthly: '80.00', packageId: large, trafficGb: null, priceHourly: null, billTo: aId, currency: 'TRY' } };
  const failed = (extra = {}) => operation(id, aId, aId, { kind: 'resize', status: 'failed', step: 'resize', error_code: 'CANCELLED', cancel_requested: true, params, ...extra });
  const retry = (op) => post(`/admin/operations/${op}/retry`, undefined, admin);
  const opRow = (op) => one('SELECT status, cancel_requested, error_code, provider_task_id FROM operations WHERE id = $1', [op]);
  // The resize failed (the worker put 30.00 back); since then the customer added a disk for 10.00 a month.
  const first = await failed();
  await pool.query('UPDATE servers SET price_monthly = 40 WHERE id = $1', [id]);
  assert.equal((await retry(first)).statusCode, 202);
  assert.deepEqual([(await serverRow(id)).price_monthly, (await serverRow(id)).package_id], ['90.00', large], 'the new shape\'s price plus the disk, not the old operation\'s 80.00');
  assert.deepEqual(await opRow(first), { status: 'pending', cancel_requested: false, error_code: null, provider_task_id: null });
  await settle(id);
  // The server was resized by another request meanwhile: this operation's prices describe a server that is gone.
  await pool.query('UPDATE servers SET vcpu = 4, memory_mb = 8192, price_monthly = 55, package_id = NULL WHERE id = $1', [id]);
  const stale = await failed();
  const refused = await retry(stale);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'SERVER_CHANGED'], refused.body);
  assert.deepEqual([(await serverRow(id)).price_monthly, (await opRow(stale)).status, (await opRow(stale)).error_code], ['55.00', 'failed', 'CANCELLED']);
  // Ended without learning what its task did: nothing was undone, so the retry writes no price and keeps the task to read.
  await pool.query('UPDATE servers SET vcpu = 2, memory_mb = 2048, price_monthly = 80, package_id = $2 WHERE id = $1', [id, large]);
  const unknown = await failed({ error_code: 'OUTCOME_UNKNOWN', cancel_requested: false, provider_task_id: 'task-9' });
  assert.equal((await retry(unknown)).statusCode, 202);
  assert.equal((await serverRow(id)).price_monthly, '80.00');
  assert.deepEqual(await opRow(unknown), { status: 'pending', cancel_requested: false, error_code: null, provider_task_id: 'task-9' });
  await settle(id);
});

test('after a restore of an older backup nothing is started until staff release the hold', async () => {
  const id = await server(aId, 'held-1');
  const old = await operation(id, aId, aId, { status: 'failed', error_code: 'TASK_FAILED' });
  await pool.query("INSERT INTO maintenance_state (key, value) VALUES ('restore_hold', $1)", [{ backup: 'backup-2026-11-01', restored_at: '2026-11-17T09:00:00.000Z' }]); // as install.sh writes it
  forgetRestoreHold();
  try {
    const held = (r) => assert.deepEqual([r.statusCode, r.json().code], [409, 'RESTORE_HOLD'], r.body);
    held(await post(`/servers/${id}/actions`, { action: 'power_on' }, a, key()));
    held(await post('/servers', { type: 'package', poolId, packageId: small, imageId, name: 'held-order', sshKeyIds: ['x'] }, a, key()));
    held(await call('DELETE', `/servers/${id}`, a, { confirm: 'held-1' }, key()));
    held(await post(`/admin/operations/${old}/retry`, undefined, admin));
    assert.deepEqual([(await openOps(id)).length, (await serverRow(id)).state], [0, 'ready']);
    // Staff see it and release it; a customer does neither.
    assert.equal((await get('/admin/system/restore-hold', a)).statusCode, 403);
    assert.equal((await call('DELETE', '/admin/system/restore-hold', a)).statusCode, 403);
    const state = (await get('/admin/system/restore-hold', admin)).json();
    assert.deepEqual([state.held, state.backup, state.restoredAt], [true, 'backup-2026-11-01', '2026-11-17T09:00:00.000Z']);
    assert.deepEqual((await call('DELETE', '/admin/system/restore-hold', admin)).json(), { held: false, released: true });
    assert.equal((await one("SELECT actor_id FROM audit_events WHERE action = 'system.restore_hold_released' ORDER BY created_at DESC LIMIT 1")).actor_id, adminId);
    assert.equal((await get('/admin/system/restore-hold', admin)).json().held, false);
    assert.equal((await post(`/servers/${id}/actions`, { action: 'power_on' }, a, key())).statusCode, 202);
    await settle(id);
  } finally { await pool.query("DELETE FROM maintenance_state WHERE key = 'restore_hold'"); forgetRestoreHold(); }
});
