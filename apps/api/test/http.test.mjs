// Dependencies point at closed ports: readiness must fail closed, liveness must not,
// and request checks that need no database must still answer correctly.
process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/none';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.BETTER_AUTH_SECRET = 'unit-test-only-better-auth-secret-0123456789';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp, closeConnections } = await import('../dist/main.js');
const app = await createApp();
await app.init();
await app.getHttpAdapter().getInstance().ready();
after(async () => { await app.close(); await closeConnections(); });

test('health stays alive without dependencies', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
});

test('ready returns 503 when PostgreSQL and Redis are unreachable', async () => {
  const res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'DEPENDENCY_UNAVAILABLE');
});

test('unknown routes return a stable error code', async () => {
  const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});

test('admin endpoints require a session', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/system' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'UNAUTHENTICATED');
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in/email', payload: { email: 'a@b.co', password: 'x'.repeat(12) } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'CSRF_REJECTED');
});

test('cross-origin requests are rejected even with the header', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in/email', headers: { 'x-lightning-csrf': '1', origin: 'https://evil.example', host: 'panel.local' }, payload: {} });
  assert.equal(res.json().code, 'CSRF_REJECTED');
});

test('sign-in fails closed when the database and Redis are unreachable', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in/email', headers: { 'x-lightning-csrf': '1' }, payload: { email: 'a@example.test', password: 'long enough password' } });
  assert.ok(res.statusCode >= 500, String(res.statusCode));
  assert.equal(res.headers['set-cookie'], undefined);
});
