// VMware connections against govmomi's vcsim (compose.simulator.yaml) through the real Go adapter.
// Simulated infrastructure only: this proves our handling, not behaviour of a real ESXi/vCenter.
// Destructive: wipes the *_test database and Redis DB 15.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
const vcenter = process.env.VCSIM_VCENTER;
const esxi = process.env.VCSIM_ESXI;
const skip = !vcenter || !esxi || !process.env.VMWARE_SERVICE_URL ? 'needs VCSIM_VCENTER, VCSIM_ESXI and VMWARE_SERVICE_URL (compose.simulator.yaml)' : false;
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');

let app, admin, user, vcPin, esxPin, vcId, esxId;
const vcCreds = { username: 'sim-admin', password: 'sim-password-1' };
const esxCreds = { username: 'sim-root', password: 'sim-password-2' };
const send = (method, path, payload, session = admin) => app.inject({
  method, url: path, payload, headers: { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost', ...(session && { cookie: `lvm.session_token=${session}` }) } });
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm\.session_token=([^;]+)/)?.[1];

before(async () => {
  if (skip) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  admin = cookieOf(await send('POST', '/setup/admin', { token, email: 'admin@example.test', password: 'correct horse battery staple' }, null));
  await send('PUT', '/admin/settings', { registrationOpen: true });
  user = cookieOf(await send('POST', '/auth/sign-up/email', { name: '', email: 'user@example.test', password: 'correct horse battery staple' }, null));
});
after(async () => { await app?.close(); await closeConnections(); });

test('an untrusted certificate is refused and shown, never silently accepted', { skip }, async () => {
  const res = await send('POST', '/admin/vmware/test', { name: 'vc', host: vcenter, port: 8989, ...vcCreds, tls: { mode: 'system' } });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.match(body.code, /^TLS_(UNTRUSTED|HOSTNAME_MISMATCH)$/);
  assert.match(body.certificate.sha256, /^[0-9a-f]{64}$/);
  assert.match(body.certificate.pem, /BEGIN CERTIFICATE/);
  vcPin = body.certificate.sha256;
  esxPin = (await send('POST', '/admin/vmware/test', { name: 'esx', host: esxi, port: 8989, ...esxCreds, tls: { mode: 'system' } })).json().certificate.sha256;
});

test('inputs are validated on the server', { skip }, async () => {
  const res = await send('POST', '/admin/vmware/test', { name: '', host: 'https://x/sdk', port: 70000, username: '', password: '', tls: { mode: 'pinned', sha256: 'zz' } });
  assert.deepEqual(res.json().fields, { name: 'INVALID_VALUE', host: 'INVALID_HOST', port: 'INVALID_PORT', username: 'INVALID_VALUE', password: 'INVALID_VALUE', sha256: 'INVALID_FINGERPRINT' });
});

test('wrong credentials, a wrong pin and blocked addresses get distinct codes', { skip }, async () => {
  const wrongLogin = await send('POST', '/admin/vmware/test', { name: 'vc', host: vcenter, port: 8989, username: 'sim-admin', password: 'nope', tls: { mode: 'pinned', sha256: vcPin } });
  assert.equal(wrongLogin.json().code, 'INVALID_LOGIN');
  // Both simulators serve govmomi's built-in certificate, so a wrong pin is made by changing one byte.
  const otherPin = (vcPin[0] === '0' ? '1' : '0') + vcPin.slice(1);
  const wrongPin = await send('POST', '/admin/vmware/test', { name: 'vc', host: vcenter, port: 8989, ...vcCreds, tls: { mode: 'pinned', sha256: otherPin } });
  assert.equal(wrongPin.json().code, 'TLS_PIN_MISMATCH');
  for (const host of ['postgres', '169.254.169.254', '127.0.0.1']) {
    const blocked = await send('POST', '/admin/vmware/test', { name: 'x', host, port: 443, ...vcCreds, tls: { mode: 'system' } });
    assert.equal(blocked.json().code, 'ENDPOINT_BLOCKED', host);
  }
});

test('vCenter and standalone ESXi are told apart and stored with an encrypted password', { skip }, async () => {
  const vc = await send('POST', '/admin/vmware/connections', { name: 'Sim vCenter', host: vcenter, port: 8989, ...vcCreds, tls: { mode: 'pinned', sha256: vcPin } });
  assert.equal(vc.statusCode, 201, vc.body);
  assert.equal(vc.json().product.kind, 'vcenter');
  assert.equal(vc.json().operations.automationApi, true);
  vcId = vc.json().id;
  const esx = await send('POST', '/admin/vmware/connections', { name: 'Sim ESXi', host: esxi, port: 8989, ...esxCreds, tls: { mode: 'pinned', sha256: esxPin } });
  assert.equal(esx.statusCode, 201, esx.body);
  assert.deepEqual([esx.json().product.kind, esx.json().operations.automationApi, esx.json().operations.cloneFromImage], ['esxi', false, false]);
  esxId = esx.json().id;

  const { rows } = await pool.query('SELECT password_enc FROM vmware_connections');
  assert.ok(rows.every((r) => r.password_enc.startsWith('v1:') && !r.password_enc.includes('sim-password')));
  const list = await send('GET', '/admin/vmware/connections');
  assert.doesNotMatch(list.body, /sim-password|password_enc|v1:/);
  assert.deepEqual(list.json().connections.map((c) => c.kind).sort(), ['esxi', 'vcenter']);
});

test('inventory and physical capacity come from discovery', { skip }, async () => {
  const d = (await send('GET', `/admin/vmware/connections/${vcId}`)).json();
  assert.equal(d.hosts.length, 2);
  assert.ok(d.datastores.length > 0 && d.networks.length > 0 && d.vms.length > 0);
  assert.ok(d.capacity.cpuCores > 0 && d.capacity.memoryBytes > 0 && d.capacity.storageCapacityBytes > 0);
  assert.ok(d.capacity.storageProvisionedBytes >= d.capacity.storageCapacityBytes - d.capacity.storageFreeBytes);
  assert.doesNotMatch(JSON.stringify(d), /sim-password|password_enc/);
});

// The simulated vCenter answers AcquireTicket with a fake WebMKS echo endpoint (test only).
const consoleWs = process.env.CONSOLE_WS_URL;
function openGateway(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(consoleWs, { protocols: ['binary'], headers: { origin: new URL(consoleWs).origin.replace('ws', 'http'), cookie: `lvm_console=${token}` } });
    const result = { messages: [], close: null, ws };
    ws.onmessage = (m) => { result.messages.push(String(m.data)); resolve(result); };
    ws.onclose = (e) => { result.close = { code: e.code, reason: e.reason }; resolve(result); };
  });
}
const closed = (r) => new Promise((resolve) => { if (r.close) resolve(r.close); else r.ws.onclose = (e) => resolve({ code: e.code, reason: e.reason }); });

test('console sessions are one-time, cookie-only and the ticket never reaches the browser', { skip: skip || (!consoleWs && 'needs CONSOLE_WS_URL') }, async () => {
  const { rows: [vm] } = await pool.query("SELECT moref, name FROM vmware_vms WHERE connection_id = $1 AND power_state = 'poweredOn' AND NOT template AND name NOT LIKE 'lvm-%' ORDER BY name LIMIT 1", [vcId]);
  const res = await send('POST', `/admin/vmware/connections/${vcId}/vms/${vm.moref}/console`);
  assert.equal(res.statusCode, 201, res.body);
  assert.doesNotMatch(res.body, /ticket|wss:/);
  const cookie = res.headers['set-cookie'].toString();
  assert.match(cookie, /lvm_console=[^;]+; Max-Age=60; Path=\/console\/ws; HttpOnly; SameSite=Strict/);
  const token = cookie.match(/lvm_console=([^;]+)/)[1];
  const keys = await redis.keys('console:session:*');
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(token), 'only a hash of the token is used as the key');
  assert.ok((await redis.ttl(keys[0])) <= 60);

  const first = await openGateway(token);
  assert.deepEqual(first.messages, [`fake-webmks ${vm.name}`], 'relayed from the (simulated) VM console endpoint');
  const second = await openGateway(token);
  assert.deepEqual([second.close?.code, second.close?.reason], [4401, 'CONSOLE_SESSION_INVALID'], 'a session works once');

  // Signing out revokes this session's live consoles.
  await send('POST', '/auth/sign-out', {});
  assert.deepEqual(await closed(first), { code: 4403, reason: 'CONSOLE_REVOKED' });
  admin = cookieOf(await send('POST', '/auth/sign-in/email', { email: 'admin@example.test', password: 'correct horse battery staple' }, null));

  assert.equal((await send('POST', `/admin/vmware/connections/${vcId}/vms/${vm.moref}/console`, undefined, user)).statusCode, 403);
  const missing = await send('POST', `/admin/vmware/connections/${vcId}/vms/vm-999999/console`);
  assert.equal(missing.json().code, 'VM_NOT_FOUND');

  // The worker turns gateway events into audit records.
  let actions = [];
  for (let i = 0; i < 30 && !actions.includes('console.closed'); i++) {
    await new Promise((r) => setTimeout(r, 200));
    actions = (await pool.query("SELECT action FROM audit_events WHERE action LIKE 'console.%'")).rows.map((r) => r.action);
  }
  for (const a of ['console.session_issued', 'console.opened', 'console.denied', 'console.closed']) assert.ok(actions.includes(a), `${a} in ${actions}`);
});

test('the same vCenter cannot be added twice under another address', { skip }, async () => {
  const again = await send('POST', '/admin/vmware/connections', { name: 'Sim vCenter by IP', host: process.env.VCSIM_VCENTER_IP ?? '172.29.250.10', port: 8989, ...vcCreds, tls: { mode: 'pinned', sha256: vcPin } });
  assert.equal(again.json().code, 'CONNECTION_EXISTS');
});

test('a host already counted through another connection is not counted again', { skip }, async () => {
  // Simulate an earlier standalone ESXi connection to one of vCenter's hosts: give the ESXi
  // connection's host the hardware UUID of a vCenter host, then add the vCenter again.
  const { rows: [vcHost] } = await pool.query('SELECT hardware_uuid, name FROM vmware_hosts WHERE connection_id = $1 LIMIT 1', [vcId]);
  assert.equal((await send('DELETE', `/admin/vmware/connections/${vcId}`)).statusCode, 204);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vmware_hosts WHERE connection_id = $1', [vcId])).rows[0].n, 0);
  await pool.query('UPDATE vmware_hosts SET hardware_uuid = $1 WHERE connection_id = $2', [vcHost.hardware_uuid, esxId]);
  const res = await send('POST', '/admin/vmware/connections', { name: 'Sim vCenter', host: vcenter, port: 8989, ...vcCreds, tls: { mode: 'pinned', sha256: vcPin } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'HOSTS_ALREADY_MANAGED');
  assert.deepEqual(res.json().conflicts.map((c) => c.connection), ['Sim ESXi']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM vmware_connections WHERE name = 'Sim vCenter'")).rows[0].n, 0, 'nothing half-saved');
});

test('refresh re-discovers with the stored password; failures are recorded', { skip }, async () => {
  const ok = await send('POST', `/admin/vmware/connections/${esxId}/discover`);
  assert.equal(ok.statusCode, 200, ok.body);
  await pool.query("UPDATE vmware_connections SET tls_sha256 = repeat('0', 64) WHERE id = $1", [esxId]);
  const bad = await send('POST', `/admin/vmware/connections/${esxId}/discover`);
  assert.equal(bad.json().code, 'TLS_PIN_MISMATCH');
  const { rows: [c] } = await pool.query('SELECT status, last_error_code FROM vmware_connections WHERE id = $1', [esxId]);
  assert.deepEqual([c.status, c.last_error_code], ['error', 'TLS_PIN_MISMATCH']);
});

test('a failing connection is fixed by editing it; an empty password keeps the stored one', { skip }, async () => {
  const base = { name: 'Sim ESXi', host: esxi, port: 8989, username: esxCreds.username, password: '', tls: { mode: 'pinned', sha256: esxPin } };
  const { rows: [before] } = await pool.query('SELECT password_enc FROM vmware_connections WHERE id = $1', [esxId]);
  const wrongLogin = await send('PUT', `/admin/vmware/connections/${esxId}`, { ...base, password: 'nope' });
  assert.equal(wrongLogin.json().code, 'INVALID_LOGIN');
  const other = await send('PUT', `/admin/vmware/connections/${esxId}`, { ...base, host: vcenter, ...vcCreds, tls: { mode: 'pinned', sha256: vcPin } });
  assert.equal(other.json().code, 'ENDPOINT_CHANGED', 'pools and images refer to this endpoint\'s inventory');
  const { rows: [still] } = await pool.query('SELECT status, password_enc FROM vmware_connections WHERE id = $1', [esxId]);
  assert.deepEqual([still.status, still.password_enc], ['error', before.password_enc], 'nothing saved by a failed edit');
  const ok = await send('PUT', `/admin/vmware/connections/${esxId}`, base);
  assert.equal(ok.statusCode, 200, ok.body);
  const { rows: [c] } = await pool.query('SELECT status, last_error_code, tls_sha256 FROM vmware_connections WHERE id = $1', [esxId]);
  assert.deepEqual([c.status, c.last_error_code, c.tls_sha256], ['ok', null, esxPin]);
  assert.equal((await send('POST', `/admin/vmware/connections/${esxId}/discover`)).statusCode, 200, 'the stored password still works');
});

test('only admins can see or change VMware connections; actions are audited', { skip }, async () => {
  for (const [method, path] of [['GET', '/admin/vmware/connections'], ['POST', '/admin/vmware/test'], ['PUT', `/admin/vmware/connections/${esxId}`], ['DELETE', `/admin/vmware/connections/${esxId}`]]) {
    assert.equal((await send(method, path, {}, user)).statusCode, 403, path);
  }
  const { rows } = await pool.query("SELECT action, outcome FROM audit_events WHERE action LIKE 'vmware.%' ORDER BY id");
  assert.deepEqual(rows.map((r) => `${r.action}:${r.outcome}`),
    ['vmware.connection_created:success', 'vmware.connection_created:success', 'vmware.connection_deleted:success', 'vmware.discovery:success', 'vmware.discovery:failure',
      'vmware.connection_updated:success', 'vmware.discovery:success']);
});
