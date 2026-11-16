// Metrics and the backup/update summary against a real PostgreSQL and Redis. Destructive: wipes the
// *_test database and Redis DB 15. The history file stands in for what scripts/install.sh writes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
const dir = mkdtempSync(join(tmpdir(), 'lvm-maintenance-'));
process.env.MAINTENANCE_DIR = dir;
process.env.APP_VERSION = 'v9.9.9-test';

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');

let app, admin, user;
const password = 'correct horse battery staple';
const send = (method, path, payload, session) => app.inject({ method, url: path, payload, headers: { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost', ...(session && { cookie: `lvm.session_token=${session}` }) } });
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm\.session_token=([^;]+)/)?.[1];
const metric = (text, name) => text.split('\n').filter((l) => l.startsWith(name));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await redis.flushdb();
  await runMigrations(pool);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const { token } = await issueBootstrapToken();
  admin = cookieOf(await send('POST', '/setup/admin', { token, email: 'admin@example.test', password }));
  await send('PUT', '/admin/settings', { registrationOpen: true }, admin);
  user = cookieOf(await send('POST', '/auth/sign-up/email', { name: '', email: 'user@example.test', password }));
});
after(async () => { await app?.close(); await closeConnections(); });

test('metrics come from the database and use bounded labels', async () => {
  await pool.query("INSERT INTO worker_heartbeats(name, last_seen) VALUES ('default', now() - interval '42 seconds') ON CONFLICT (name) DO UPDATE SET last_seen = EXCLUDED.last_seen");
  for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) await send('GET', `/servers/${id}`, undefined, user);
  const text = (await send('GET', '/metrics')).body;
  assert.deepEqual(metric(text, 'lightning_dependency_up{').sort(), ['lightning_dependency_up{dependency="postgres"} 1', 'lightning_dependency_up{dependency="redis"} 1']);
  const age = Number(metric(text, 'lightning_worker_heartbeat_age_seconds ')[0].split(' ')[1]);
  // With a real worker beside the tests (run.sh), its own fresh heartbeat is the youngest one.
  assert.ok((process.env.WORKER_TEST ? age >= 0 : age >= 42) && age < 60, `heartbeat age ${age}`);
  assert.ok(metric(text, 'lightning_operations_open{status="pending"} 0').length === 1);
  assert.ok(metric(text, 'lightning_queue_jobs{queue="operations",state="waiting"} 0').length === 1);
  // Two different server ids are one route template, not two series.
  const routes = metric(text, 'lightning_api_http_request_duration_seconds_count{').filter((l) => l.includes('/servers'));
  assert.deepEqual(routes, ['lightning_api_http_request_duration_seconds_count{method="GET",route="/servers/:id",status="4xx"} 2']);
  assert.ok(metric(text, 'lightning_info{version="v9.9.9-test"} 1').length === 1);
  // No backup has run: the timestamp is 0 (the alert fires) and no result series exists yet.
  assert.ok(metric(text, 'lightning_backup_last_success_timestamp_seconds 0').length === 1);
  assert.deepEqual(metric(text, 'lightning_maintenance_last_ok{'), []);
});

test('backup and update results are read from the host history, admins only', async () => {
  writeFileSync(join(dir, 'history.jsonl'), [
    '{"time":"2026-10-20T03:00:01Z","kind":"backup","status":"ok","code":"-","version":"v1.0.0","file":"a.tar.enc","bytes":100}',
    'not json — a torn line must not break the page',
    '{"time":"2026-10-21T03:00:01Z","kind":"backup","status":"failed","code":"E_BACKUP_DB","version":"v1.0.0"}',
    '{"time":"2026-10-21T03:10:00Z","kind":"update","status":"failed","code":"E_UPDATE_FAILED","version":"v1.0.0","from":"v1.0.0","to":"v1.1.0","rolledBack":true}',
    '{"time":"2026-10-21T04:00:00Z","kind":"update","status":"postponed","code":"W_UPDATE_BUSY","version":"v1.0.0"}',
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'settings.json'), '{"schedule":"on","autoUpdate":"off"}');
  assert.equal((await send('GET', '/admin/maintenance', undefined, user)).statusCode, 403);
  const s = (await send('GET', '/admin/maintenance', undefined, admin)).json();
  assert.equal(s.version, 'v9.9.9-test');
  assert.equal(s.lastSuccessfulBackup.file, 'a.tar.enc');
  assert.equal(s.lastBackup.code, 'E_BACKUP_DB');
  assert.equal(s.lastUpdate.code, 'E_UPDATE_FAILED', 'a postponed run is not the last result');
  assert.equal(s.history.length, 4);
  assert.equal(s.settings.schedule, 'on');
  const text = (await send('GET', '/metrics')).body;
  assert.ok(metric(text, `lightning_backup_last_success_timestamp_seconds ${Date.parse('2026-10-20T03:00:01Z') / 1000}`).length === 1);
  assert.deepEqual(metric(text, 'lightning_maintenance_last_ok{').sort(), ['lightning_maintenance_last_ok{kind="backup"} 0', 'lightning_maintenance_last_ok{kind="update"} 0']);
});
