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

test('bodies are small by default; only the routes that carry files take more, and each of those exists', async () => {
  const { largeBodies } = await import('../dist/main.js');
  const fastify = app.getHttpAdapter().getInstance();
  for (const key of Object.keys(largeBodies)) {
    const [method, url] = key.split(' ');
    assert.ok(fastify.hasRoute({ method, url }), `${key} is a route`);
  }
  const big = (n) => JSON.stringify({ email: 'a'.repeat(n) });
  // Sign-in routes: 64 KB. Refused while reading the body, before better-auth, its limiter or the database see it.
  const auth = await app.inject({ method: 'POST', url: '/auth/sign-in/email', headers: { 'x-lightning-csrf': '1', 'content-type': 'application/json' }, payload: big(70_000) });
  assert.equal(auth.statusCode, 413);
  // Every other route: 256 KB, anonymous ones included.
  const anon = await app.inject({ method: 'POST', url: '/guest/updates/report', headers: { 'x-lightning-csrf': '1', 'content-type': 'application/json' }, payload: big(300_000) });
  assert.equal(anon.statusCode, 413);
  const callback = await app.inject({ method: 'POST', url: '/billing/callback/none', headers: { 'content-type': 'application/json' }, payload: big(300_000) });
  assert.equal(callback.statusCode, 413);
  // A file route takes a body of that size, but not from a caller who shows no session cookie and no API token: they
  // are asked who they are before it is read (a body that is not even JSON gets the same answer, not a parse error).
  for (const key of Object.keys(largeBodies)) {
    const [method, url] = key.split(' ');
    for (const payload of [big(300_000), '{"not json']) {
      const upload = await app.inject({ method, url: url.replace(':id', '00000000-0000-4000-8000-000000000000'), headers: { 'x-lightning-csrf': '1', 'content-type': 'application/json' }, payload });
      assert.deepEqual([upload.statusCode, upload.json().code], [401, 'UNAUTHENTICATED'], key);
    }
  }
  // With a cookie or a token the body is read (here: found broken) before the guard looks at who it is.
  for (const headers of [{ cookie: 'lvm.session_token=nobody' }, { cookie: 'a=1; __Secure-lvm.session_token=nobody' }, { authorization: 'Bearer lvm_nobody' }]) {
    const read = await app.inject({ method: 'POST', url: '/support/tickets', headers: { 'x-lightning-csrf': '1', 'content-type': 'application/json', ...headers }, payload: '{"not json' });
    assert.equal(read.statusCode, 400, JSON.stringify(headers));
  }
});

test('audit details: no text longer than the cap is stored, other values stay as they are', async () => {
  const { capped } = await import('../dist/auth.js');
  const at = new Date();
  const out = capped({ email: 'x'.repeat(5000), n: 3, at, list: ['y'.repeat(2000), 'ok'], deep: { note: 'z'.repeat(1001) }, none: null });
  assert.equal(out.email.length, 1000);
  assert.deepEqual([out.n, out.at, out.none, out.list[1]], [3, at, null, 'ok']);
  assert.equal(out.list[0].length, 1000);
  assert.equal(out.deep.note.length, 1000);
});

test('mail settings: a stored SMTP password is not reused for another host, port or security', async () => {
  const { readMail } = await import('../dist/settings-store.js');
  const saved = { enabled: true, provider: 'smtp', host: 'smtp.example.com', port: 587, security: 'starttls', username: 'panel', passwordEnc: 'v1:stored', api: {}, apiSecretEnc: null,
    fromName: '', fromAddress: 'panel@example.com', use: { passwordReset: true, twoFactor: true } };
  const form = { enabled: true, provider: 'smtp', host: 'smtp.example.com', port: 587, security: 'starttls', username: 'panel', fromAddress: 'panel@example.com' };
  assert.equal(readMail(form, saved).value.passwordEnc, 'v1:stored');
  for (const change of [{ host: 'evil.example.net' }, { port: 2525 }, { security: 'none' }]) {
    assert.throws(() => readMail({ ...form, ...change }, saved), (e) => e.getResponse().fields.password === 'REQUIRED', JSON.stringify(change));
  }
});

test('what a URL carries as a secret is masked before it is logged or shown to staff', async () => {
  const { maskSecrets } = await import('../dist/log.js');
  const amp = `${String.fromCharCode(92)}u0026`; // how a JSON access log may write "&"
  const cases = [
    ['/auth/reset-password/AbC123xyz?callbackURL=%2Freset-password', '/auth/reset-password/[masked]?callbackURL=%2Freset-password'],
    ['/auth/magic-link/verify?token=tok-1&callbackURL=%2F', '/auth/magic-link/verify?token=[masked]&callbackURL=%2F'],
    ['/auth/verify-email?token=tok-2', '/auth/verify-email?token=[masked]'],
    ['/auth/callback/google?code=4/0abc&state=st-1&scope=email', '/auth/callback/google?code=[masked]&state=[masked]&scope=email'],
    ['/billing/callback/stripe/p1?session_id=cs_test_1', '/billing/callback/stripe/p1?session_id=[masked]'],
    [`{"uri":"/api/auth/magic-link/verify?token=tok-3${amp}callbackURL=/","status":302}`, `{"uri":"/api/auth/magic-link/verify?token=[masked]${amp}callbackURL=/","status":302}`],
    [`{"uri":"/api/auth/callback/github?x=1${amp}code=c-1${amp}state=s-1"}`, `{"uri":"/api/auth/callback/github?x=1${amp}code=[masked]${amp}state=[masked]"}`],
    ['"Referer":["https://panel.example/reset-password?token=tok-4"]', '"Referer":["https://panel.example/reset-password?token=[masked]"]'],
    ['GET /api/auth/reset-password/tok-5 HTTP/1.1', 'GET /api/auth/reset-password/[masked] HTTP/1.1'],
  ];
  for (const [line, masked] of cases) assert.equal(maskSecrets(line), masked);
  // Ordinary lines and parameters that only resemble those names are left as they are.
  for (const line of ['/servers?page=2&statecode=1', '/reset-password', 'worker started', '/admin/users?q=token']) assert.equal(maskSecrets(line), line);
});
