// Turning monitoring on and off from the panel after installation, against a real PostgreSQL and Redis (destructive,
// like the other files here: it wipes the test database and Redis DB). The panel only writes a request for the host
// agent (scripts/install.sh agent), the way it does for a backup or an update; the agent's folders are temporary
// ones here and no agent runs. What is checked: the same permission as the other maintenance requests
// (system.update), and looking needs only system.view; on or off must be said; the request file is exactly what
// the agent accepts (and what the setup wizard writes for the same switch); one request at a time, also against a
// backup or an update; a run the agent abandoned does not block for ever; every request is audited with who asked;
// the state says what the components answer and what the agent last did.
// NOT checked here: the agent starting and stopping the containers (that is install.sh on a real host).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const maint = mkdtempSync(tmpdir() + '/lvm-maint-');
process.env.MAINTENANCE_DIR = maint;
process.env.MAINTENANCE_REQUESTS_DIR = maint + '/requests';
mkdirSync(maint + '/requests');

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');

let app, admin, adminId, user, viewer, operator, operatorId;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload) => app.inject({ method, url: path, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const ask = (body, cookie = admin) => call('POST', '/admin/maintenance/requests', cookie, body);
const state = async (cookie = admin) => (await call('GET', '/admin/maintenance/monitoring', cookie)).json();
const requests = () => readdirSync(`${maint}/requests`);
const clear = () => { for (const f of requests()) rmSync(`${maint}/requests/${f}`); };
const agentSays = (s) => writeFileSync(`${maint}/status.json`, JSON.stringify({ finishedAt: '', exitCode: null, code: '', by: adminId, ...s }));
const staff = async (email, permissions) => {
  const key = `mon-${email.split('@')[0]}`;
  assert.equal((await call('POST', '/admin/roles', admin, { key, name: key, permissions })).statusCode, 201);
  const id = (await call('POST', '/auth/admin/create-user', admin, { email, password, name: key, role: 'user' })).json().user.id;
  assert.equal((await call('PUT', `/admin/users/${id}/access`, admin, { roles: [key], overrides: [] })).statusCode, 200);
  return [cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email, password })), id];
};

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
  adminId = (await call('GET', '/auth/me', admin)).json().id;
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
  user = cookieOf(await call('POST', '/auth/sign-up/email', undefined, { name: '', email: 'user@example.test', password }));
  [viewer] = await staff('viewer@example.test', ['system.view']);
  [operator, operatorId] = await staff('operator@example.test', ['system.view', 'system.update']);
});
after(async () => { await app?.close(); await closeConnections(); rmSync(maint, { recursive: true, force: true }); });

test('who may look and who may switch: the same permission as a backup or an update', async () => {
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'on' }));
  for (const [who, look, change] of [[null, 401, 401], [user, 403, 403], [viewer, 200, 403], [operator, 200, 202]]) {
    assert.equal((await call('GET', '/admin/maintenance/monitoring', who)).statusCode, look);
    assert.equal((await ask({ action: 'monitoring', enabled: true }, who)).statusCode, change);
    if (change !== 202) assert.deepEqual(requests(), [], 'a refused request leaves nothing for the agent');
  }
  // The operator's request is there for the agent, in the form it accepts, with who asked.
  const [file] = requests();
  assert.match(readFileSync(`${maint}/requests/${file}`, 'utf8'), new RegExp(`^action=monitoring\\nswitch=on\\nby=${operatorId}\\nid=${file.slice(0, -4)}\\n$`));
  const { rows: [a] } = await pool.query("SELECT actor_id, metadata FROM audit_events WHERE action = 'maintenance.request' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([a.actor_id, a.metadata.action, a.metadata.switch, a.metadata.id], [operatorId, 'monitoring', 'on', file.slice(0, -4)]);
  clear();
});

test('on or off must be said; nothing else travels in the request', async () => {
  for (const enabled of [undefined, null, 'on', 'off', 'true', 1, 0, {}, []]) {
    const r = await ask({ action: 'monitoring', enabled });
    assert.deepEqual([r.statusCode, r.json().fields], [400, { enabled: 'INVALID_VALUE' }], JSON.stringify(enabled));
  }
  assert.deepEqual(requests(), []);
  const off = await ask({ action: 'monitoring', enabled: false, switch: 'on; rm -rf /', to: 'v9.9.9', channel: 'edge', window: '00:00-01:00', by: 'someone-else', id: 'chosen' });
  assert.equal(off.statusCode, 202, off.body);
  assert.equal(readFileSync(`${maint}/requests/${off.json().id}.req`, 'utf8'), `action=monitoring\nswitch=off\nby=${adminId}\nid=${off.json().id}\n`);
  clear();
});

test('one request at a time, with every other maintenance task; an abandoned run does not block for ever; no agent, no request', async () => {
  // Queued and not yet taken by the agent: nothing else is queued behind it, monitoring or not.
  const first = await ask({ action: 'monitoring', enabled: true });
  assert.equal(first.statusCode, 202);
  for (const body of [{ action: 'monitoring', enabled: false }, { action: 'backup' }, { action: 'update' }]) assert.equal((await ask(body)).json().code, 'MAINTENANCE_BUSY');
  assert.equal(requests().length, 1);
  assert.deepEqual([(await state()).agent.pending, (await state()).agent.busy], [1, true]);
  clear();
  // The agent took it and is running: still busy. The same while a backup or an update runs.
  for (const action of ['monitoring', 'update', 'backup']) {
    agentSays({ id: first.json().id, action, state: 'running', startedAt: new Date().toISOString() });
    assert.equal((await ask({ action: 'monitoring', enabled: false })).json().code, 'MAINTENANCE_BUSY', action);
    assert.equal((await state()).agent.busy, true);
  }
  assert.deepEqual(requests(), []);
  // A run "running" for more than three hours is one the agent gave up: not busy any more.
  agentSays({ id: first.json().id, action: 'monitoring', state: 'running', startedAt: new Date(Date.now() - 3 * 3600_000 - 60_000).toISOString() });
  assert.equal((await state()).agent.busy, false);
  assert.equal((await ask({ action: 'monitoring', enabled: false })).statusCode, 202);
  clear();
  // Without the host agent there is nobody to hand the request to.
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'off' }));
  const none = await ask({ action: 'monitoring', enabled: true });
  assert.deepEqual([none.statusCode, none.json().code], [409, 'MAINTENANCE_AGENT_MISSING']);
  assert.deepEqual([requests(), (await state()).agent.installed], [[], false]);
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'on' }));
});

test('the state: what the components answer now, and what the agent last did about monitoring', async () => {
  // Nothing called prometheus, grafana or loki answers on this machine: off, each with why.
  agentSays({ id: '00000000-0000-4000-8000-000000000001', action: 'backup', state: 'succeeded', startedAt: new Date().toISOString(), exitCode: 0 });
  let s = await state(viewer);
  assert.equal(s.state, 'off');
  assert.deepEqual(s.checks.map((c) => [c.id, c.ok]), [['prometheus', false], ['grafana', false], ['loki', false]]);
  assert.ok(s.checks.every((c) => /^[A-Z_]+$/.test(c.code) && c.code !== 'OK'));
  assert.deepEqual([s.agent.installed, s.agent.busy, s.agent.status, s.agent.log], [true, false, null, []], 'another task\'s run is not shown as the switch');
  // The agent's own run of the switch, with the last lines of its log.
  const id = '00000000-0000-4000-8000-000000000002';
  mkdirSync(`${maint}/runs`, { recursive: true });
  writeFileSync(`${maint}/runs/${id}.log`, 'INFO  STEP                   Building and starting the observability components\nOK    MONITORING             Monitoring on: Prometheus, Grafana, Loki and Alertmanager are running\n');
  agentSays({ id, action: 'monitoring', state: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0 });
  s = await state();
  assert.deepEqual([s.agent.status.state, s.agent.status.action, s.agent.log.length, s.agent.busy], ['succeeded', 'monitoring', 2, false]);
  agentSays({ id, action: 'monitoring', state: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 18, code: 'E_PROFILE' });
  assert.deepEqual([(await state()).agent.status.state, (await state()).agent.status.code], ['failed', 'E_PROFILE']);
});
