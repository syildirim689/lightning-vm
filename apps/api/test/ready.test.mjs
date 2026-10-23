// Dependencies point at closed ports: readiness must fail closed, liveness must not.
process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/none';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
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

test('system returns 503 instead of 500 when PostgreSQL is unreachable', async () => {
  const res = await app.inject({ method: 'GET', url: '/system' });
  assert.equal(res.statusCode, 503);
});

test('unknown routes return a stable error code', async () => {
  const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});
