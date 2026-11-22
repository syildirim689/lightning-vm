// Services on Admin → System, against a real PostgreSQL and Redis (destructive, like the other files here: it wipes the
// test database and Redis DB). The agent's snapshot (state.json, logs/) is written by hand into a temporary folder; no
// agent runs. What is checked: a restart or a run-again is a request for the host agent with the same permission as
// the other maintenance requests (system.update); the name must be one of the snapshot's services (an allow-list) and
// postgres/redis, one-shot jobs and services outside the compose file are refused with a reason; one request at a
// time; every request is audited; the detail of a service says whether its state is a fault (a one-shot job that
// finished is not), its version, and its last log lines only to administrators, with secrets masked.
// NOT checked here: the agent restarting a container (scripts/install.sh service, run in CI against the Compose stack).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.APP_VERSION = 'v0.5.1-7-gabc1234';
const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const maint = mkdtempSync(tmpdir() + '/lvm-svc-');
process.env.MAINTENANCE_DIR = maint;
process.env.MAINTENANCE_REQUESTS_DIR = maint + '/requests';
mkdirSync(maint + '/requests');
mkdirSync(maint + '/logs');

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
const requests = () => readdirSync(`${maint}/requests`);
const clear = () => { for (const f of requests()) rmSync(`${maint}/requests/${f}`); };
const staff = async (email, permissions) => {
  const key = `svc-${email.split('@')[0]}`;
  assert.equal((await call('POST', '/admin/roles', admin, { key, name: key, permissions })).statusCode, 201);
  const id = (await call('POST', '/auth/admin/create-user', admin, { email, password, name: key, role: 'user' })).json().user.id;
  assert.equal((await call('PUT', `/admin/users/${id}/access`, admin, { roles: [key], overrides: [] })).statusCode, 200);
  return [cookieOf(await call('POST', '/auth/sign-in/email', undefined, { email, password })), id];
};

// The snapshot as the agent writes it (scripts/install.sh state), shaped after the demo's.
const base = { health: '', cpu: 0, memory: '', memoryPercent: 0, restarts: 0, startedAt: '2026-11-22T19:47:53Z', finishedAt: '0001-01-01T00:00:00Z', exitCode: 0, restartPolicy: 'unless-stopped', imageVersion: '', ports: '', awaited: 0, managed: 1 };
const services = [
  { ...base, service: 'api', state: 'running', health: 'healthy', status: 'Up 35 minutes (healthy)', image: 'lightning-vm-api', ports: '4000/tcp' },
  { ...base, service: 'migrate', state: 'exited', status: 'Exited (0) 28 minutes ago', finishedAt: '2026-11-22T19:47:55Z', restartPolicy: 'no', awaited: 1, image: 'lightning-vm-migrate' },
  { ...base, service: 'worker', state: 'running', health: 'unhealthy', status: 'Up 2 minutes (unhealthy)', image: 'lightning-vm-worker', restarts: 4 },
  { ...base, service: 'postgres', state: 'running', health: 'healthy', status: 'Up 2 days (healthy)', image: 'postgres:17-alpine', ports: '5432/tcp' },
  { ...base, service: 'proxy', state: 'running', status: 'Up 1 hour', image: 'caddy:2-alpine', imageVersion: 'v2.11.7', ports: '0.0.0.0:80->80/tcp' },
  { ...base, service: 'grafana', state: 'exited', status: 'Exited (1) 3 minutes ago', exitCode: 1, image: 'grafana/grafana:11.6.0' },
  { ...base, service: 'vcsim-esxi', state: 'running', status: 'Up 47 hours', restartPolicy: 'no', image: 'lightning-vm-vcsim-esxi', managed: 0 },
];
const snapshot = (list = services) => writeFileSync(`${maint}/state.json`, JSON.stringify({ checkedAt: new Date().toISOString(), commit: 'abc1234', services: list, disks: [] }));
const agentSays = (s) => writeFileSync(`${maint}/status.json`, JSON.stringify({ finishedAt: '', exitCode: null, code: '', by: adminId, ...s }));

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
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'on' }));
  snapshot();
});
after(async () => { await app?.close(); await closeConnections(); rmSync(maint, { recursive: true, force: true }); });

test('who may restart: the system permission (system.update), as for a backup or an update; the request is what the agent accepts, audited', async () => {
  for (const [who, code] of [[null, 401], [user, 403], [viewer, 403], [operator, 202]]) {
    assert.equal((await ask({ action: 'service', service: 'worker', act: 'restart' }, who)).statusCode, code);
    if (code !== 202) assert.deepEqual(requests(), [], 'a refused request leaves nothing for the agent');
  }
  const [file] = requests();
  assert.equal(readFileSync(`${maint}/requests/${file}`, 'utf8'), `action=service\nservice=worker\nact=restart\nby=${operatorId}\nid=${file.slice(0, -4)}\n`);
  const { rows: [a] } = await pool.query("SELECT actor_id, metadata FROM audit_events WHERE action = 'maintenance.request' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([a.actor_id, a.metadata.action, a.metadata.service, a.metadata.act, a.metadata.id], [operatorId, 'service', 'worker', 'restart', file.slice(0, -4)]);
  clear();
});

test('the name is checked against the snapshot (an allow-list); refusals say why; nothing else travels in the request', async () => {
  for (const service of ['worker; reboot', '../api', 'API', '', 'worker\nact=run', 5, null]) {
    const r = await ask({ action: 'service', service, act: 'restart' });
    assert.deepEqual([r.statusCode, r.json().fields], [400, { service: 'INVALID_VALUE' }], JSON.stringify(service));
  }
  const unknown = await ask({ action: 'service', service: 'loki', act: 'restart' });
  assert.deepEqual([unknown.statusCode, unknown.json().fields], [400, { service: 'UNKNOWN_SERVICE' }]);
  for (const act of ['stop', 'rm -f', undefined]) assert.deepEqual((await ask({ action: 'service', service: 'worker', act })).json().fields, { act: 'INVALID_VALUE' });
  for (const [service, act, code] of [['postgres', 'restart', 'SERVICE_PROTECTED'], ['migrate', 'restart', 'SERVICE_ONE_SHOT'], ['worker', 'run', 'SERVICE_NOT_ONE_SHOT'], ['vcsim-esxi', 'restart', 'SERVICE_NOT_MANAGED']]) {
    const r = await ask({ action: 'service', service, act });
    assert.deepEqual([r.statusCode, r.json().code], [409, code], `${service} ${act}`);
  }
  assert.deepEqual(requests(), []);
  // Allowed: the panel's own services (the agent restarts them after this answer) and migrate run again.
  for (const [service, act] of [['api', 'restart'], ['proxy', 'restart'], ['migrate', 'run']]) {
    const r = await ask({ action: 'service', service, act, switch: 'on', to: 'v9.9.9', by: 'someone-else', id: 'chosen' });
    assert.equal(r.statusCode, 202, `${service} ${act}: ${r.body}`);
    assert.equal(readFileSync(`${maint}/requests/${r.json().id}.req`, 'utf8'), `action=service\nservice=${service}\nact=${act}\nby=${adminId}\nid=${r.json().id}\n`);
    clear();
  }
  // Without a snapshot there is nothing to check a name against.
  rmSync(`${maint}/state.json`);
  assert.deepEqual([(await ask({ action: 'service', service: 'worker', act: 'restart' })).statusCode, (await ask({ action: 'service', service: 'worker', act: 'restart' })).json().code], [409, 'HOST_STATE_MISSING']);
  snapshot();
});

test('one restart at a time, with every other maintenance task; no agent, no request', async () => {
  assert.equal((await ask({ action: 'service', service: 'worker', act: 'restart' })).statusCode, 202);
  for (const body of [{ action: 'service', service: 'api', act: 'restart' }, { action: 'backup' }]) assert.equal((await ask(body)).json().code, 'MAINTENANCE_BUSY');
  clear();
  agentSays({ id: '00000000-0000-4000-8000-000000000010', action: 'service', state: 'running', startedAt: new Date().toISOString() });
  assert.equal((await ask({ action: 'service', service: 'worker', act: 'restart' })).json().code, 'MAINTENANCE_BUSY');
  agentSays({ id: '00000000-0000-4000-8000-000000000010', action: 'service', state: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0 });
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'off' }));
  assert.equal((await ask({ action: 'service', service: 'worker', act: 'restart' })).json().code, 'MAINTENANCE_AGENT_MISSING');
  writeFileSync(`${maint}/settings.json`, JSON.stringify({ agent: 'on' }));
  assert.deepEqual(requests(), []);
});

test('the list and the detail: a finished one-shot job is not a fault, versions are named, the log only for administrators and masked', async () => {
  const live = (await call('GET', '/admin/host/live', operator)).json();
  const by = Object.fromEntries(live.state.services.map((s) => [s.service, s]));
  assert.deepEqual([by.migrate.kind, by.migrate.fault, by.migrate.oneShot], ['completed', false, true]);
  assert.deepEqual([by.worker.kind, by.worker.fault], ['unhealthy', true]);
  assert.deepEqual([by.grafana.kind, by.grafana.fault, by.grafana.exitCode], ['failed', true, 1]);
  assert.deepEqual([by.api.kind, by.api.fault], ['healthy', false]);
  assert.deepEqual(by.api.version, { panel: true, version: 'v0.5.1-7-gabc1234', commit: 'abc1234' });
  assert.deepEqual(by.proxy.version, { panel: false, tag: '2-alpine', label: 'v2.11.7', reported: '' });
  assert.deepEqual([by.postgres.rule.refused, by.migrate.rule.run, by.api.rule.interrupts], ['SERVICE_PROTECTED', true, 'panel']);

  writeFileSync(`${maint}/logs/worker.log`, [
    '2026-11-22T19:47:56Z worker ready',
    '2026-11-22T19:48:00Z connecting to postgresql://lightning:s3cr3t@postgres:5432/lightning',
    '2026-11-22T19:48:01Z {"level":"error","msg":"call failed","headers":{"authorization":"Bearer abcdefgh12345678"}}',
    '2026-11-22T19:48:02Z REDIS_PASSWORD=hunter2 seen in env dump',
  ].join('\n') + '\n');
  const detail = (await call('GET', '/admin/host/services/worker', admin)).json();
  assert.deepEqual([detail.service.kind, detail.service.restarts, detail.agent.installed], ['unhealthy', 4, true]);
  assert.equal(detail.logs.length, 4);
  assert.equal(detail.logs[0], '2026-11-22T19:47:56Z worker ready');
  const text = detail.logs.join('\n');
  for (const secret of ['s3cr3t', 'abcdefgh12345678', 'hunter2']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /postgresql:\/\/lightning:\[masked\]@postgres/);
  // The agent's last restart of a service, with its log.
  assert.deepEqual([detail.agent.status.action, detail.agent.status.state], ['service', 'succeeded']);
  // Staff with system.view see the state but not the log lines; customers see nothing.
  const seen = (await call('GET', '/admin/host/services/worker', viewer)).json();
  assert.deepEqual([seen.service.kind, seen.logs], ['unhealthy', null]);
  assert.equal((await call('GET', '/admin/host/services/worker', user)).statusCode, 403);
  for (const name of ['nope', '..%2Fstate', 'API']) assert.equal((await call('GET', `/admin/host/services/${name}`, admin)).statusCode, 404, name);
  // The same masking on the log page.
  const logs = (await call('GET', '/admin/host/logs?source=worker', admin)).json().lines.join('\n');
  for (const secret of ['s3cr3t', 'abcdefgh12345678', 'hunter2']) assert.ok(!logs.includes(secret), secret);
  // PostgreSQL says which version it runs.
  assert.match((await call('GET', '/admin/host/services/postgres', admin)).json().service.version.reported, /^\d+(\.\d+)?/);
});

test('the version list says when it was written for another version than the one running', async () => {
  const list = { checkedAt: new Date().toISOString(), channel: 'stable', current: 'v0.3.0-384-gfc25fdd', commit: 'fc25fdd', base: 'v0.3.0', latest: 'v0.3.0', updateAvailable: false, error: '',
    releases: [{ version: 'v0.3.0', date: '2026-10-24T20:54:33+03:00', notes: 'x', newer: false, running: false }] };
  writeFileSync(`${maint}/releases.json`, JSON.stringify(list));
  assert.equal((await call('GET', '/admin/maintenance', viewer)).json().releases.stale, true);
  writeFileSync(`${maint}/releases.json`, JSON.stringify({ ...list, current: 'v0.5.1-7-gabc1234' }));
  assert.equal((await call('GET', '/admin/maintenance', viewer)).json().releases.stale, false);
});
