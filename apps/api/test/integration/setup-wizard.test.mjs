// Setup wizard against real PostgreSQL and Redis. Destructive: wipes the *_test database and Redis DB 15.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { issueBootstrapToken, reopenSetup } = await import('../../dist/setup.js');

let app, token, setupCookie, adminCookie, panel, panelOrigin, wrongPanel;
const password = 'correct horse battery staple';
const cookieValue = (res, name) => res.headers['set-cookie']?.toString().match(new RegExp(`${name}=([^;]*)`))?.[1];
const send = (method, path, { payload, setup, session } = {}) => app.inject({
  method, url: path, payload,
  headers: { 'x-lightning-csrf': '1', cookie: [setup && `lvm_setup=${setup}`, session && `lvm_session=${session}`].filter(Boolean).join('; ') },
});

// A real HTTP endpoint on a non-loopback address that forwards to the app, like Caddy would.
function forwardingServer(rewrite = (body) => body) {
  return createServer(async (req, res) => {
    const r = await app.inject({ method: req.method, url: req.url.replace(/^\/api/, '') });
    res.writeHead(r.statusCode, { 'content-type': 'application/json' }).end(rewrite(r.body));
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server.address().port)));
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  panel = forwardingServer();
  panelOrigin = `http://${lanIp}:${await listen(panel)}`;
  wrongPanel = forwardingServer(() => JSON.stringify({ nonce: 'someone-else' }));
  wrongPanel.port = await listen(wrongPanel);
});
after(async () => { panel?.close(); wrongPanel?.close(); await app?.close(); await closeConnections(); });

test('wizard endpoints need the bootstrap token before an admin exists', async () => {
  assert.equal((await send('GET', '/setup/progress')).json().code, 'BOOTSTRAP_REQUIRED');
  ({ token } = await issueBootstrapToken());
  assert.equal((await send('POST', '/setup/session', { payload: { token: 'guess' } })).json().code, 'BOOTSTRAP_TOKEN_INVALID');
  const res = await send('POST', '/setup/session', { payload: { token } });
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['set-cookie'].toString(), /HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/);
  setupCookie = cookieValue(res, 'lvm_setup');
  assert.deepEqual((await send('GET', '/setup/progress', { setup: setupCookie })).json(), { steps: {}, adminCreated: false });
});

test('steps are validated on the server and progress persists', async () => {
  const bad = await send('PUT', '/setup/steps/language', { setup: setupCookie, payload: { status: 'completed', data: { locale: 'de' } } });
  assert.deepEqual(bad.json().fields, { locale: 'INVALID_VALUE' });
  await send('PUT', '/setup/steps/language', { setup: setupCookie, payload: { status: 'completed', data: { locale: 'tr' } } });
  assert.equal((await send('PUT', '/setup/steps/checks', { setup: setupCookie, payload: { status: 'skipped' } })).json().code, 'STEP_REQUIRED');
  assert.equal((await send('PUT', '/setup/steps/vmware', { setup: setupCookie, payload: { status: 'completed' } })).json().code, 'STEP_NOT_AVAILABLE');
  assert.equal((await send('PUT', '/setup/steps/vmware', { setup: setupCookie, payload: { status: 'skipped' } })).statusCode, 200);
  assert.equal((await send('PUT', '/setup/steps/nope', { setup: setupCookie, payload: { status: 'skipped' } })).statusCode, 404);
  const { steps } = (await send('GET', '/setup/progress', { setup: setupCookie })).json();
  assert.deepEqual([steps.language.status, steps.language.data.locale, steps.vmware.status], ['completed', 'tr', 'skipped']);
});

test('system checks report a missing worker and block the step until it is fixed', async () => {
  const { checks } = (await send('POST', '/setup/checks', { setup: setupCookie })).json();
  assert.deepEqual(checks.map((c) => [c.id, c.code]), [['postgres', 'OK'], ['redis', 'OK'], ['migrations', 'OK'], ['worker', 'NO_HEARTBEAT']]);
  assert.equal((await send('PUT', '/setup/steps/checks', { setup: setupCookie, payload: { status: 'completed' } })).json().code, 'CHECKS_FAILED');
  await pool.query("INSERT INTO worker_heartbeats(name) VALUES ('default')");
  assert.equal((await send('PUT', '/setup/steps/checks', { setup: setupCookie, payload: { status: 'completed' } })).statusCode, 200);
  assert.equal((await send('PUT', '/setup/steps/services', { setup: setupCookie, payload: { status: 'completed' } })).statusCode, 200);
});

test('access test tells DNS, refused, wrong target, loopback and success apart', async () => {
  const probe = async (publicUrl) => (await send('POST', '/setup/test/access', { setup: setupCookie, payload: { publicUrl } })).json();
  for (const invalid of ['ftp://panel.example.com', 'http://panel.example.com/path', 'https://user:pw@panel.example.com', 'nonsense']) {
    assert.deepEqual((await probe(invalid)).fields, { publicUrl: 'INVALID_URL' }, invalid);
  }
  assert.equal((await probe('http://127.0.0.1:8080')).checks[0].code, 'LOOPBACK_NOT_VERIFIABLE');
  assert.equal((await probe('http://lightning-vm-does-not-exist.invalid')).checks[0].code, 'DNS_FAILED');
  // Port 1 would be refused by fetch's bad-port list, not by the network; use a port that was just freed.
  const closed = createServer(); const closedPort = await listen(closed); await new Promise((r) => closed.close(r));
  assert.equal((await probe(`http://${lanIp}:${closedPort}`)).checks[0].code, 'CONNECTION_REFUSED');
  assert.equal((await probe(`http://${lanIp}:${wrongPanel.port}`)).checks[0].code, 'WRONG_TARGET');
  const ok = await probe(`${panelOrigin}/`);
  assert.deepEqual([ok.publicUrl, ok.checks[0].code], [panelOrigin, 'OK']);
});

test('finishing needs an admin; creating it moves the wizard to the admin session', async () => {
  assert.equal((await send('POST', '/setup/complete', { setup: setupCookie })).json().code, 'ADMIN_REQUIRED');
  const res = await send('POST', '/setup/admin', { setup: setupCookie, payload: { email: 'admin@example.test', password } });
  assert.equal(res.statusCode, 201);
  assert.equal(cookieValue(res, 'lvm_setup'), '');
  adminCookie = cookieValue(res, 'lvm_session');
  assert.equal((await send('GET', '/setup/progress', { setup: setupCookie })).json().code, 'UNAUTHENTICATED');
  assert.equal((await send('GET', '/setup/progress', { session: adminCookie })).json().adminCreated, true);
});

test('setup cannot complete with required steps missing, then closes for good', async () => {
  const early = (await send('POST', '/setup/complete', { session: adminCookie })).json();
  assert.deepEqual([early.code, early.fields], ['STEPS_INCOMPLETE', { access: 'REQUIRED' }]);
  const saved = (await send('PUT', '/setup/steps/access', { session: adminCookie, payload: { status: 'completed', data: { publicUrl: panelOrigin } } })).json();
  assert.deepEqual([saved.data.publicUrl, saved.data.verified], [panelOrigin, true]);
  assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'public_url'")).rows[0].value, panelOrigin);
  assert.equal((await send('POST', '/setup/complete', { session: adminCookie })).statusCode, 200);

  assert.deepEqual((await send('GET', '/setup/status')).json(), { adminCreated: true, completed: true });
  for (const [method, path] of [['GET', '/setup/progress'], ['POST', '/setup/checks'], ['PUT', '/setup/steps/language'], ['POST', '/setup/complete']]) {
    assert.equal((await send(method, path, { session: adminCookie, payload: { status: 'completed', data: { locale: 'en' } } })).json().code, 'SETUP_CLOSED', path);
  }
  assert.equal((await send('POST', '/setup/session', { payload: { token } })).json().code, 'SETUP_CLOSED');
  assert.equal(await issueBootstrapToken(), null);
});

test('recovery reopens the wizard for admins only and keeps accounts', async () => {
  assert.equal(await reopenSetup(), true);
  assert.equal((await send('GET', '/setup/progress', { session: adminCookie })).statusCode, 200);
  assert.equal((await send('GET', '/setup/progress')).json().code, 'UNAUTHENTICATED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  const audited = await pool.query("SELECT action FROM audit_events WHERE action IN ('setup.completed', 'setup.reopened') ORDER BY id");
  assert.deepEqual(audited.rows.map((r) => r.action), ['setup.completed', 'setup.reopened']);
});
