// E-mail address verification for registered accounts, against a real PostgreSQL and Redis (destructive, like the
// other files here: it wipes the test database and Redis DB). What is checked: without mail the feature is not there
// and nothing is asked; registration mails a code; the code counts only in a session of that account and for the
// address it was mailed to; a wrong, expired, used or never-sent code answers the same; codes and mails are limited
// per account; nothing on the account is removed; staff acting as the person and API tokens are refused; the routes
// say nothing without a session; the order rule is off by default, refuses an unverified account when on, and asks
// nothing while mail is off; accounts proven the old way stay proven.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcp } from 'node:net';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
process.env.MAINTENANCE_DIR = mkdtempSync(tmpdir() + '/lvm-maint-');

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');

let app, admin, smtp;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload, headers = {}) => app.inject({ method, url: path, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const post = (path, payload, cookie, headers) => call('POST', path, cookie, payload, headers);
const put = (path, payload, cookie) => call('PUT', path, cookie, payload);
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const until = async (check, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const verified = async (email) => (await one('SELECT email_verified FROM users WHERE email = $1', [email])).email_verified;
const state = async (cookie) => (await get('/account/email-verification', cookie)).json();
const confirm = (code, cookie) => post('/account/email-verification/confirm', { code }, cookie);

// A minimal SMTP server: accepts every message and keeps it (plain SMTP, no TLS).
async function fakeSmtp() {
  const mails = [];
  const server = tcp((sock) => {
    let data = false, buf = '', msg = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; mails.push(msg.replace(/=\n/g, '').replace(/=3D/g, '=')); msg = ''; sock.write('250 queued\r\n'); } else msg += line + '\n'; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') sock.write('250-fake\r\n250 OK\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, mails, close: () => new Promise((r) => server.close(r)) };
}
const mailOn = (use = {}) => put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'panel@example.test', use: { passwordReset: true, twoFactor: true, ...use } }, admin);
const mailOff = () => put('/admin/settings/mail', { enabled: false, provider: 'smtp', host: '', port: 587, security: 'starttls', fromAddress: '' }, admin);
// The code of the newest verification mail to this address (the plain-text part has it on a line of its own).
const codeFor = async (email, after = 0) => {
  const mail = await until(() => smtp.mails.slice(after).reverse().find((m) => m.includes(`To: ${email}`) && /^\d{6}$/m.test(m)));
  assert.ok(mail, `a verification mail for ${email}`);
  return { code: mail.match(/^(\d{6})$/m)[1], mail };
};
const register = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: 'Person', email, password }); assert.equal(r.statusCode, 200, r.body); return { cookie: cookieOf(r), id: r.json().user.id }; };

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
  await put('/admin/settings', { registrationOpen: true }, admin);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('public_url', '"https://panel.example.test"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  smtp = await fakeSmtp();
});
after(async () => { await smtp?.close(); await app?.close(); await closeConnections(); });

test('without mail the feature is not there: nothing is mailed, nothing can be asked for, and the order rule asks nothing', async () => {
  const { cookie } = await register('nomail@example.test');
  assert.deepEqual(await state(cookie), { email: 'nomail@example.test', verified: false, available: false, pending: false, resendInSeconds: 0, codeMinutes: 30, requiredToOrder: false });
  const send = await post('/account/email-verification/send', {}, cookie);
  assert.deepEqual([send.statusCode, send.json().code], [501, 'MAIL_NOT_CONFIGURED']);
  assert.equal((await confirm('123456', cookie)).json().code, 'VERIFICATION_CODE_INVALID');
  assert.equal((await get('/auth/me', cookie)).json().emailVerified, false);
  // The rule is on, but nobody could meet it: an unverified account still reaches the order form's own checks.
  assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false, verifiedEmailToOrder: true }, admin)).json().verifiedEmailToOrder, true);
  const order = await post('/servers', {}, cookie, { 'idempotency-key': 'order-nomail-0001' });
  assert.deepEqual([order.statusCode, order.json().code], [400, 'VALIDATION_FAILED']);
  await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false, verifiedEmailToOrder: false }, admin);
});

test('the routes answer about the signed-in account only', async () => {
  for (const [method, path] of [['GET', '/account/email-verification'], ['POST', '/account/email-verification/send'], ['POST', '/account/email-verification/confirm']]) {
    const r = await call(method, path, undefined, method === 'POST' ? { code: '123456', email: 'nomail@example.test' } : undefined);
    assert.deepEqual([r.statusCode, r.json().code], [401, 'UNAUTHENTICATED'], path);
  }
});

test('registration mails a code; the code verifies the address in that account\'s session and removes nothing', async () => {
  assert.equal((await mailOn()).statusCode, 200);
  assert.equal((await get('/admin/settings/mail', admin)).json().use.verification, true, 'a form without the new switch leaves it on');
  const { cookie, id } = await register('ayse@example.test');
  const { code, mail } = await codeFor('ayse@example.test');
  assert.match(mail, new RegExp(`https://panel\\.example\\.test/account\\?tab=profile&verify=${code}`), 'the link goes to the panel\'s own address');
  const s = await state(cookie);
  assert.deepEqual([s.verified, s.available, s.pending, s.requiredToOrder], [false, true, true, false]);
  assert.ok(s.resendInSeconds > 0 && s.resendInSeconds <= 60);
  // Something the account set up before it verified: it all stays (the person who set it up is the one verifying).
  await pool.query("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'mine', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5q0b3X1x0Yv0bq3mXnXv7wq8n0s3QyYt0mU6pN0aaa a', 'SHA256:test-fingerprint')", [id]);
  const sessionsBefore = (await one('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1', [id])).n;
  // Another account's session cannot use the code.
  const other = await register('other@example.test');
  assert.equal((await confirm(code, other.cookie)).json().code, 'VERIFICATION_CODE_INVALID');
  assert.equal(await verified('ayse@example.test'), false);
  assert.equal(await verified('other@example.test'), false);
  // Neither can staff acting as the person, nor a request without the session.
  const acting = cookieOf(await post('/auth/admin/impersonate-user', { userId: id }, admin));
  assert.ok(acting);
  assert.equal((await confirm(code, acting)).json().code, 'NOT_WHILE_IMPERSONATING');
  assert.equal((await post('/account/email-verification/send', {}, acting)).json().code, 'NOT_WHILE_IMPERSONATING');
  assert.equal(await verified('ayse@example.test'), false);
  const ok = await confirm(` ${code.slice(0, 3)} ${code.slice(3)} `, cookie);
  assert.deepEqual([ok.statusCode, ok.json()], [200, { verified: true }]);
  assert.equal(await verified('ayse@example.test'), true);
  assert.equal((await get('/auth/me', cookie)).json().emailVerified, true);
  assert.equal((await one('SELECT count(*)::int AS n FROM ssh_keys WHERE owner_id = $1', [id])).n, 1, 'the SSH key stays');
  assert.equal((await one('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1', [id])).n, sessionsBefore + 1, 'no session was ended (one more: the staff member\'s)');
  assert.equal((await one("SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'", [id])).n, 1, 'the password stays');
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_events WHERE actor_id = $1 AND action = 'auth.email_verified' AND outcome = 'success'", [id])).n, 1);
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_events WHERE actor_id = $1 AND action = 'auth.address_proven'", [id])).n, 0, 'this is not the first-proof clean-up');
  // The code is used up; asking again says there is nothing to verify.
  assert.deepEqual((await confirm(code, cookie)).json(), { verified: true });
  const again = await post('/account/email-verification/send', {}, cookie);
  assert.deepEqual([again.statusCode, again.json().code], [409, 'EMAIL_ALREADY_VERIFIED']);
  assert.deepEqual(await state(cookie).then((x) => [x.verified, x.pending, x.requiredToOrder]), [true, false, false]);
});

test('a wrong, expired, replaced or never-sent code answers the same, and a code takes five tries', async () => {
  const { cookie, id } = await register('tries@example.test');
  const first = await codeFor('tries@example.test');
  const wrong = String((Number(first.code) + 1) % 1_000_000).padStart(6, '0');
  const answers = [];
  // Never sent (another fresh account), malformed, wrong.
  const fresh = await register('fresh@example.test');
  await codeFor('fresh@example.test');
  await redis.del(`emailverify:${fresh.id}`);
  for (const r of [await confirm(first.code, fresh.cookie), await confirm('12345', cookie), await confirm({ $gt: '' }, cookie), await confirm(wrong, cookie)]) answers.push([r.statusCode, r.json()]);
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.deepEqual([answers[0][0], answers[0][1].code], [400, 'VERIFICATION_CODE_INVALID']);
  // A new mail replaces the code: the first one no longer works.
  await freshLimits();
  const mailsBefore = smtp.mails.length;
  assert.equal((await post('/account/email-verification/send', {}, cookie)).statusCode, 200);
  const second = await codeFor('tries@example.test', mailsBefore);
  if (second.code !== first.code) assert.deepEqual((await confirm(first.code, cookie)).json(), answers[0][1]);
  // Five tries per code: after them even the right code is refused, until a new one is mailed.
  await freshLimits();
  assert.equal((await post('/account/email-verification/send', {}, cookie)).statusCode, 200);
  const third = await codeFor('tries@example.test', mailsBefore + 1);
  const bad = String((Number(third.code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i++) assert.equal((await confirm(bad, cookie)).json().code, 'VERIFICATION_CODE_INVALID');
  assert.equal((await confirm(third.code, cookie)).json().code, 'VERIFICATION_CODE_INVALID', 'the right code after five wrong ones');
  assert.equal(await verified('tries@example.test'), false);
  assert.equal((await state(cookie)).pending, false);
  // An expired code.
  await freshLimits();
  const n = smtp.mails.length;
  assert.equal((await post('/account/email-verification/send', {}, cookie)).statusCode, 200);
  const fourth = await codeFor('tries@example.test', n);
  assert.ok(await redis.ttl(`emailverify:${id}`) > 29 * 60);
  await redis.expire(`emailverify:${id}`, 0);
  assert.equal((await confirm(fourth.code, cookie)).json().code, 'VERIFICATION_CODE_INVALID');
  // The code is kept as a hash, never as it was mailed.
  await freshLimits();
  const m = smtp.mails.length;
  assert.equal((await post('/account/email-verification/send', {}, cookie)).statusCode, 200);
  const fifth = await codeFor('tries@example.test', m);
  assert.ok(!JSON.stringify(await redis.hgetall(`emailverify:${id}`)).includes(fifth.code));
  // A code mailed to the old address does not verify an address staff changed meanwhile.
  await pool.query("UPDATE users SET email = 'moved@example.test' WHERE id = $1", [id]);
  assert.equal((await confirm(fifth.code, cookie)).json().code, 'VERIFICATION_CODE_INVALID');
  assert.equal(await verified('moved@example.test'), false);
  assert.ok((await one("SELECT count(*)::int AS n FROM audit_events WHERE actor_id = $1 AND action = 'auth.email_verified' AND outcome = 'failure'", [id])).n >= 7);
});

test('mails are limited per account: one a minute, five an hour; tries twenty a day', async () => {
  const { cookie, id } = await register('limits@example.test');
  await codeFor('limits@example.test');
  // The registration mail counts: a second one within the minute is refused.
  const soon = await post('/account/email-verification/send', {}, cookie);
  assert.deepEqual([soon.statusCode, soon.json().code], [429, 'RATE_LIMITED']);
  let sent = 1;
  for (let i = 0; i < 6; i++) {
    await redis.del(`rl:emailverify:send:minute:${id}`);
    for (const k of await redis.keys('rl:ba:*')) await redis.del(k);
    const r = await post('/account/email-verification/send', {}, cookie);
    if (r.statusCode === 200) sent++; else assert.equal(r.json().code, 'RATE_LIMITED');
  }
  assert.equal(sent, 5, 'five mails in the hour, the registration mail included');
  await until(() => smtp.mails.filter((x) => x.includes('To: limits@example.test')).length >= 5);
  assert.equal(smtp.mails.filter((x) => x.includes('To: limits@example.test')).length, 5);
  // Twenty tries a day, whatever codes are mailed in between.
  let refused = 0;
  for (let i = 0; i < 22; i++) { const r = await confirm('000000', cookie); if (r.statusCode === 429) refused++; }
  assert.equal(refused, 2);
});

test('an API token cannot verify, and the administrator can turn the mail off', async () => {
  const { cookie, id } = await register('token@example.test');
  const { code } = await codeFor('token@example.test');
  const made = await post('/account/api-tokens', { name: 'script', scope: 'write' }, cookie);
  assert.equal(made.statusCode, 201, made.body);
  const bearer = { authorization: `Bearer ${made.json().token}` };
  const viaToken = await app.inject({ method: 'POST', url: '/account/email-verification/confirm', payload: { code }, headers: bearer });
  assert.deepEqual([viaToken.statusCode, viaToken.json().code], [403, 'TOKEN_NOT_ALLOWED']);
  assert.equal((await app.inject({ method: 'POST', url: '/account/email-verification/send', headers: bearer })).json().code, 'TOKEN_NOT_ALLOWED');
  assert.equal(await verified('token@example.test'), false);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: bearer })).json().emailVerified, false);
  // Settings → E-mail: this use of mail turned off. The section is gone and registration mails nothing.
  assert.equal((await mailOn({ verification: false })).json().use.verification, false);
  assert.equal((await state(cookie)).available, false);
  assert.equal((await post('/account/email-verification/send', {}, cookie)).json().code, 'MAIL_NOT_CONFIGURED');
  const n = smtp.mails.length;
  await register('quiet@example.test');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(smtp.mails.slice(n).filter((x) => x.includes('To: quiet@example.test')).length, 0);
  assert.equal((await mailOn({ verification: true })).json().use.verification, true);
  assert.ok(id);
});

test('the order rule: off by default, refuses an unverified account when on, and lets a verified one through', async () => {
  const { cookie } = await register('buyer@example.test');
  const { code } = await codeFor('buyer@example.test');
  const order = (key, c = cookie) => post('/servers', {}, c, { 'idempotency-key': key });
  assert.equal((await get('/admin/settings/security', admin)).json().verifiedEmailToOrder, false, 'off unless the administrator turns it on');
  assert.equal((await order('order-buyer-0001')).json().code, 'VALIDATION_FAILED', 'as before: the order reaches its own checks');
  // A form from before the setting existed leaves it as it is.
  assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false, verifiedEmailToOrder: true }, admin)).json().verifiedEmailToOrder, true);
  assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false }, admin)).json().verifiedEmailToOrder, true);
  assert.equal((await state(cookie)).requiredToOrder, true);
  const refused = await order('order-buyer-0002');
  assert.deepEqual([refused.statusCode, refused.json().code], [403, 'EMAIL_NOT_VERIFIED']);
  assert.equal((await confirm(code, cookie)).statusCode, 200);
  assert.equal((await state(cookie)).requiredToOrder, false);
  assert.equal((await order('order-buyer-0003')).json().code, 'VALIDATION_FAILED');
  // The administrator (proven at setup) and accounts staff made are not asked.
  assert.equal((await order('order-admin-0001', admin)).json().code, 'VALIDATION_FAILED');
  await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false, verifiedEmailToOrder: false }, admin);
});

test('an account proven the old way stays proven, and that proof drops a waiting code', async () => {
  assert.equal(await verified('boss@example.test'), true);
  const made = (await post('/auth/admin/create-user', { email: 'made@example.test', password, name: 'Made', role: 'user' }, admin)).json().user.id;
  assert.equal((await one('SELECT email_verified FROM users WHERE id = $1', [made])).email_verified, true);
  // A registered account that resets its password by mail before using the code: the first proof (and its clean-up) happens, the code is gone.
  const { cookie, id } = await register('reset@example.test');
  const { code } = await codeFor('reset@example.test');
  await freshLimits();
  assert.equal((await post('/auth/request-password-reset', { email: 'reset@example.test', redirectTo: '/reset-password' })).statusCode, 200);
  const mail = await until(() => smtp.mails.find((m) => m.includes('To: reset@example.test') && m.includes('/reset-password/')));
  const token = mail.match(/\/reset-password\/([\w-]+)/)[1];
  assert.equal((await post('/auth/reset-password', { token, newPassword: 'another long password 7' })).statusCode, 200);
  assert.equal(await verified('reset@example.test'), true);
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_events WHERE actor_id = $1 AND action = 'auth.address_proven'", [id])).n, 1);
  assert.equal(await redis.exists(`emailverify:${id}`), 0);
  assert.equal((await get('/auth/me', cookie)).statusCode, 401, 'the session from before the reset ended, as it always did');
  const fresh = cookieOf(await post('/auth/sign-in/email', { email: 'reset@example.test', password: 'another long password 7' }));
  assert.deepEqual((await confirm(code, fresh)).json(), { verified: true });
  await mailOff();
});
