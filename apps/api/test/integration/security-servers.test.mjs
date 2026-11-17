// Server and ownership fixes from the security review, against real PostgreSQL and Redis. No hypervisor, adapter or
// worker: the inventory (connection, host, datastore, location, image, packages) and the servers are rows written here,
// and every request below stops at the queued operation. What the worker does with them is in apps/worker/test.
//   a refused resize changes no price (two at once leave the accepted one's); a failed disk is credited once; a server
//   billed elsewhere is resized only by its billing system; a handed-over server keeps nothing of its previous owner; a
//   server with a copy on order stays where it is; an order is not bound to an unproven account; a VDC lists no foreign
//   image; the ticket list names no staff address; a customer cancels only what they started and nothing under way.
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

test('an order from the billing system is bound only to its own account or to one whose address was proven', async () => {
  const lookup = (email, source = 'whmcs') => post(`/admin/external/${source}/customers`, { email }, admin);
  // Somebody registered the buyer's address first (open registration: the account works at once, unverified).
  const [, squatter] = await signUp('buyer@example.test');
  const refused = await lookup('Buyer@Example.test');
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'CUSTOMER_NEEDS_REVIEW'], refused.body);
  // Proven (e-mail code or link, or staff marked it): matched.
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [squatter]);
  assert.deepEqual((await lookup('buyer@example.test')).json(), { id: squatter, created: false });
  // A reseller's customer: created unverified, and never matched (the reseller manages its servers).
  const [reseller, resellerId] = await signUp('reseller@example.test');
  await pool.query('INSERT INTO resellers (user_id) VALUES ($1)', [resellerId]);
  const made = await post('/reseller/customers', { email: 'buyer2@example.test' }, reseller);
  assert.equal(made.statusCode, 201, made.body);
  assert.deepEqual(await one('SELECT email_verified, reseller_id FROM users WHERE id = $1', [made.json().id]), { email_verified: false, reseller_id: resellerId });
  assert.equal((await lookup('buyer2@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW');
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [made.json().id]);
  assert.equal((await lookup('buyer2@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW', 'verified or not, it is the reseller\'s');
  // The reseller's own account is not a buyer's either.
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [resellerId]);
  assert.equal((await lookup('reseller@example.test')).json().code, 'CUSTOMER_NEEDS_REVIEW');
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
