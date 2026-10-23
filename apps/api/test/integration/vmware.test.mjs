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
  method, url: path, payload, headers: { 'x-lightning-csrf': '1', ...(session && { cookie: `lvm_session=${session}` }) } });
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm_session=([^;]+)/)?.[1];

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
  user = cookieOf(await send('POST', '/auth/register', { email: 'user@example.test', password: 'correct horse battery staple' }, null));
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

test('only admins can see or change VMware connections; actions are audited', { skip }, async () => {
  for (const [method, path] of [['GET', '/admin/vmware/connections'], ['POST', '/admin/vmware/test'], ['DELETE', `/admin/vmware/connections/${esxId}`]]) {
    assert.equal((await send(method, path, {}, user)).statusCode, 403, path);
  }
  const { rows } = await pool.query("SELECT action, outcome FROM audit_events WHERE action LIKE 'vmware.%' ORDER BY id");
  assert.deepEqual(rows.map((r) => `${r.action}:${r.outcome}`),
    ['vmware.connection_created:success', 'vmware.connection_created:success', 'vmware.connection_deleted:success', 'vmware.discovery:success', 'vmware.discovery:failure']);
});
