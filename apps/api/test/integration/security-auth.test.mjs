// Sign-in and settings hardening, against a real PostgreSQL and Redis (destructive, like the other files here: it
// wipes the test database and Redis DB). What is checked: only the auth routes the panel uses answer; directory and
// single sign-on accounts get a session nowhere but from their directory or provider; captcha and the per-address
// limit come before the directory; role mappings stay within the saver's own permissions; identifiers are bounded;
// mailed links carry the panel's address; staff acting as someone leave nothing lasting, and only while that staff
// member still may; push endpoints are public and owned; settings tests hand back no remote text and stored secrets
// do not follow a changed address; the channels for reset links and codes are the administrator's; what sends a
// message is counted per account and destination; ticket notices follow who may see tickets; logs carry no tokens.
// The re-check of the directory and single sign-on fixes (the last four tests): whoever names the directory server or
// the provider covers the accounts behind it; a removed role leaves the mappings; the settings test counts as a guess;
// an unknown address is asked in one spelling; a directory session has a fixed length; and a password reset by mail is
// the first proof of an address too, with what else an earlier holder could have left.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as tcp } from 'node:net';
import { createRequire } from 'node:module';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
// No host agent here: the panel's address then comes from the setup wizard's setting (public_url).
const { mkdtempSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
process.env.MAINTENANCE_DIR = mkdtempSync(tmpdir() + '/lvm-maint-');

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { notificationQueue, startNotificationWorker } = await import('../../dist/notify.js');

let app;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload, headers = {}) => app.inject({ method, url: path, payload, headers: { ...csrf, ...headers, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const post = (path, payload, cookie, headers) => call('POST', path, cookie, payload, headers);
const put = (path, payload, cookie) => call('PUT', path, cookie, payload);
// Every test signs in from 127.0.0.1: the per-address and per-account limits start again with each test.
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const until = async (check, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const sessionsOf = async (email) => (await one('SELECT count(*)::int AS n FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1', [email])).n;

// ---- fixtures ----
// A directory on this machine: simple bind and one-person search by mail, in just enough BER for the LDAP client.
// people: mail -> { dn, name, password, groups }. attempts counts binds per DN (also the refused ones).
async function fakeLdap(reader, people) {
  const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
  const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
  const str = (s) => tlv(0x04, Buffer.from(s));
  const result = (tag, id, code) => tlv(0x30, id, tlv(tag, tlv(0x0a, Buffer.from([code])), str(''), str('')));
  const read = (buf, at) => {
    if (buf.length < at + 2) return null;
    let size = buf[at + 1], start = at + 2;
    if (size & 0x80) {
      const n = size & 0x7f;
      if (buf.length < start + n) return null;
      size = 0; for (let i = 0; i < n; i++) size = size * 256 + buf[start + i];
      start += n;
    }
    return buf.length < start + size ? null : { tag: buf[at], start, end: start + size };
  };
  const attempts = {};
  const server = tcp((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let m; (m = read(buf, 0));) {
        const idAt = read(buf, m.start), id = buf.subarray(m.start, idAt.end);
        const op = read(buf, idAt.end);
        if (op.tag === 0x60) {
          const version = read(buf, op.start), name = read(buf, version.end), secret = read(buf, name.end);
          const dn = buf.subarray(name.start, name.end).toString(), pw = buf.subarray(secret.start, secret.end).toString();
          attempts[dn] = (attempts[dn] ?? 0) + 1;
          const ok = (dn === reader.dn && pw === reader.password) || Object.values(people).some((p) => p.dn === dn && p.password === pw && pw);
          sock.write(result(0x61, id, ok ? 0 : 49));
        } else if (op.tag === 0x63) {
          const filter = buf.subarray(op.start, op.end).toString('latin1');
          const hit = Object.entries(people).find(([mail]) => filter.includes(mail));
          if (hit) {
            const [mail, p] = hit;
            const attr = (type, values) => tlv(0x30, str(type), tlv(0x31, ...values.map(str)));
            sock.write(tlv(0x30, id, tlv(0x64, str(p.dn), tlv(0x30, attr('mail', [mail]), attr('displayName', [p.name]), ...(p.groups?.length ? [attr('memberOf', p.groups)] : [])))));
          }
          sock.write(result(0x65, id, 0));
        } else if (op.tag === 0x42) sock.end();
        buf = buf.subarray(m.end);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ldap://127.0.0.1:${server.address().port}`, attempts, people, close: () => new Promise((r) => { server.close(r); }) };
}

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

// An HTTP service that answers every request with the same status and a text nobody should get to read.
const marker = 'INTERNAL-ONLY-TEXT-7f3a';
async function fakeInternal(status) {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = status; res.end(`${marker} from the inside`); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

let admin, user, userId, staff, staffId;
const newUser = async (email, name = 'Person') => (await post('/auth/admin/create-user', { email, password, name, role: 'user' }, admin)).json().user.id;

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
  const r = await post('/auth/sign-up/email', { name: 'Ayşe', email: 'ayse@example.test', password });
  user = cookieOf(r); userId = r.json().user.id;
  // Staff who hold the settings permissions and nothing else.
  assert.equal((await post('/admin/roles', { key: 'settings-only', name: 'Settings only', permissions: ['settings.view', 'settings.manage'] }, admin)).statusCode, 201);
  staffId = await newUser('settings@example.test', 'Settings');
  assert.equal((await put(`/admin/users/${staffId}/access`, { roles: ['settings-only'], overrides: [] }, admin)).statusCode, 200);
  staff = cookieOf(await post('/auth/sign-in/email', { email: 'settings@example.test', password }));
  assert.ok(admin && user && staff);
});
after(async () => { await app?.close(); await closeConnections(); });

test('only the auth routes the panel uses answer; the rest of what the plugins bring is closed', async () => {
  await freshLimits();
  await pool.query("UPDATE users SET phone_number = '+905321110000', phone_number_verified = true WHERE id = $1", [userId]);
  // Phone-number sign-in and the phone password reset pair do not exist, with or without a session.
  for (const [path, body] of [['/auth/sign-in/phone-number', { phoneNumber: '+905321110000', password }], ['/auth/phone-number/request-password-reset', { phoneNumber: '+905321110000' }],
    ['/auth/phone-number/reset-password', { phoneNumber: '+905321110000', otp: '000000', newPassword: 'another long password 1' }],
    ['/auth/change-email', { newEmail: 'x@example.test' }], ['/auth/delete-user', {}], ['/auth/get-access-token', { providerId: 'github' }], ['/auth/email-otp/reset-password', { email: 'ayse@example.test', otp: '000000', password }],
    ['/auth/forget-password/email-otp', { email: 'ayse@example.test' }], ['/auth/revoke-sessions', {}]]) {
    for (const cookie of [undefined, user]) {
      const r = await post(path, body, cookie);
      assert.deepEqual([r.statusCode, r.json().code], [404, 'NOT_FOUND'], path);
    }
  }
  assert.equal(await sessionsOf('ayse@example.test'), 1, 'nobody was signed in by any of them');
  // A phone code is sent to a session only, and a correct code never signs anyone in.
  assert.equal((await post('/auth/phone-number/send-otp', { phoneNumber: '+905321110000' })).statusCode, 401);
  assert.equal((await post('/auth/phone-number/verify', { phoneNumber: '+905321110000', code: '000000' })).statusCode, 403);
  assert.equal((await post('/auth/phone-number/verify', { phoneNumber: '+905321110000', code: '000000', disableSession: true })).statusCode, 403);
  // What the panel uses still answers.
  assert.equal((await get('/auth/list-sessions', user)).statusCode, 200);
  assert.equal((await get('/auth/list-accounts', user)).statusCode, 200);
  assert.equal((await get('/auth/passkey/list-user-passkeys', user)).statusCode, 200);
  assert.equal((await get('/auth/me', user)).statusCode, 200);
  // A provider's ID token posted to the sign-in route is refused before any provider is looked at.
  for (const provider of ['oidc', 'google']) {
    const r = await post('/auth/sign-in/social', { provider, idToken: { token: 'eyJhbGciOiJSUzI1NiJ9.e30.x' } });
    assert.equal(r.statusCode, 403, provider);
    assert.equal(cookieOf(r), undefined);
  }
  assert.equal((await post('/auth/link-social', { provider: 'google', idToken: { token: 'x' } }, user)).statusCode, 403);
});

test('identifiers are bounded before a limiter key or an audit row sees them; redirect targets are panel paths', async () => {
  await freshLimits();
  const before = (await one("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login'")).n;
  const long = `${'a'.repeat(5000)}@example.test`;
  for (const [path, body] of [['/auth/sign-in/email', { email: long, password }], ['/auth/sign-in/username', { username: 'u'.repeat(300), password }],
    ['/auth/sign-in/magic-link', { email: long, callbackURL: '/' }], ['/auth/request-password-reset', { email: long, redirectTo: '/reset-password' }]]) {
    const r = await post(path, body);
    assert.deepEqual([r.statusCode, r.json().code], [400, 'VALIDATION_FAILED'], path);
  }
  // A text and nothing else: a list holding a long text is not turned into one.
  for (const [path, body] of [['/auth/sign-in/username', { username: ['u'.repeat(2000)], password }], ['/auth/sign-in/magic-link', { email: [long], callbackURL: '/' }],
    ['/auth/sign-in/email', { email: { a: long }, password }], ['/auth/sign-in/email', { email: 7, password }], ['/auth/phone-number/send-otp', { phoneNumber: ['+905321110000'] }]]) {
    const r = await post(path, body, path.includes('phone') ? user : undefined);
    assert.deepEqual([r.statusCode, r.json().code], [400, 'VALIDATION_FAILED'], `${path} ${JSON.stringify(body).slice(0, 40)}`);
  }
  assert.equal((await redis.keys('rl:login:*')).filter((k) => k.length > 300).length, 0, 'no limiter key was made of it');
  assert.equal((await redis.keys('rl:otp:*')).length, 0);
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login'")).n, before, 'and no audit row');
  // The longest address that is still one is recorded as it is, and nothing in the audit log is longer than its cap.
  const edge = `${'b'.repeat(240)}@example.test`;
  assert.equal((await post('/auth/sign-in/email', { email: edge, password })).statusCode, 401);
  assert.equal((await one("SELECT metadata->>'email' AS email FROM audit_events WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1")).email, edge);
  assert.ok((await one('SELECT coalesce(max(length(metadata::text)), 0)::int AS n FROM audit_events')).n < 4000);
  // Where the browser goes afterwards is a path on the panel, never another site (whatever host the request names).
  for (const target of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)']) {
    assert.equal((await post('/auth/sign-in/social', { provider: 'github', callbackURL: target })).statusCode, 400, target);
    assert.equal((await post('/auth/request-password-reset', { email: 'ayse@example.test', redirectTo: target })).statusCode, 400, target);
    assert.equal((await get(`/auth/reset-password/some-token?callbackURL=${encodeURIComponent(target)}`)).statusCode, 400, target);
  }
});

test('role mappings of the directory and single sign-on stay within what the saver holds', async () => {
  await freshLimits();
  const ldap = { enabled: false, url: 'ldap://127.0.0.1:1', baseDn: 'dc=corp,dc=test', groupRoles: [], defaultRole: 'user', autoCreate: true };
  const oidc = { enabled: false, name: 'SSO', issuer: 'https://idp.example.test', clientId: 'panel', clientSecret: 'secret-1', groupRoles: [], defaultRole: 'user', autoCreate: true };
  // Staff with settings.manage only: a default role or a group that gives more than they hold is refused, on save and on test.
  for (const mapping of [{ defaultRole: 'admin' }, { groupRoles: [{ group: 'cn=admins', roles: ['admin'] }] }, { groupRoles: [{ group: 'cn=mixed', roles: ['user', 'settings-only', 'admin'] }] }]) {
    for (const [method, path, body] of [['PUT', '/admin/settings/directory', { ldap: { ...ldap, ...mapping } }], ['POST', '/admin/settings/directory/test', { ldap: { ...ldap, ...mapping } }],
      ['PUT', '/admin/settings/directory/sso', { oidc: { ...oidc, ...mapping } }], ['POST', '/admin/settings/directory/sso/test', { oidc: { ...oidc, ...mapping } }]]) {
      const r = await call(method, path, staff, body);
      assert.deepEqual([r.statusCode, r.json().code], [403, 'FORBIDDEN_TARGET'], `${method} ${path} ${JSON.stringify(mapping)}`);
    }
  }
  const stored = (await get('/admin/settings/directory', admin)).json();
  assert.deepEqual([stored.ldap.defaultRole, stored.oidc.defaultRole, stored.ldap.groupRoles, stored.oidc.groupRoles], ['user', 'user', [], []], 'nothing was saved');
  // Roles they cover (their own, the customer role) are theirs to map.
  assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, groupRoles: [{ group: 'cn=settings', roles: ['settings-only'] }] } }, staff)).statusCode, 200);
  assert.equal((await put('/admin/settings/directory/sso', { oidc }, staff)).statusCode, 200);
  // An administrator maps to admin; staff who do not cover that mapping can then not move the server underneath it.
  assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, groupRoles: [{ group: 'cn=admins', roles: ['admin'] }] } }, admin)).statusCode, 200);
  assert.equal((await put('/admin/settings/directory/sso', { oidc: { ...oidc, defaultRole: 'admin' } }, admin)).statusCode, 200);
  assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, url: 'ldap://127.0.0.1:2', groupRoles: [{ group: 'cn=admins', roles: ['admin'] }] } }, staff)).json().code, 'FORBIDDEN_TARGET');
  assert.equal((await put('/admin/settings/directory/sso', { oidc: { ...oidc, issuer: 'https://other.example.test', clientSecret: 'x', defaultRole: 'admin' } }, staff)).json().code, 'FORBIDDEN_TARGET');
  // The stored client secret is for the issuer it was entered for.
  assert.equal((await put('/admin/settings/directory/sso', { oidc: { ...oidc, issuer: 'https://other.example.test', clientSecret: '' } }, admin)).json().fields?.clientSecret, 'REQUIRED');
  assert.equal((await put('/admin/settings/directory/sso', { oidc: { ...oidc, clientSecret: '' } }, admin)).statusCode, 200, 'same issuer: kept');
  assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap } }, admin)).statusCode, 200);
  assert.equal((await put('/admin/settings/directory/sso', { oidc: { enabled: false } }, admin)).statusCode, 200);
});

test('directory accounts: the directory decides every sign-in, after the captcha and the per-address limit', async () => {
  await freshLimits();
  const reader = { dn: 'cn=reader,dc=corp,dc=test', password: 'reader-secret' };
  const dir = await fakeLdap(reader, {
    'ada@corp.test': { dn: 'uid=ada,ou=people,dc=corp,dc=test', name: 'Ada Lovelace', password: 'ada-directory-pass-1' },
    'new@corp.test': { dn: 'uid=new,ou=people,dc=corp,dc=test', name: 'New Person', password: 'new-directory-pass-1' },
  });
  const smtp = await fakeSmtp();
  const ada = dir.people['ada@corp.test'];
  const binds = () => dir.attempts[ada.dn] ?? 0;
  const ldap = { enabled: true, url: dir.url, bindDn: reader.dn, bindPassword: reader.password, baseDn: 'dc=corp,dc=test', userFilter: '(&(objectClass=person)(mail={email}))',
    groupRoles: [], defaultRole: 'user', autoCreate: true };
  try {
    assert.equal((await put('/admin/settings/directory', { ldap }, admin)).statusCode, 200);
    // The directory accepts: the account is made, marked, and signed in.
    const first = await post('/auth/sign-in/email', { email: 'ada@corp.test', password: ada.password });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((await get('/auth/me', cookieOf(first))).json().email, 'ada@corp.test');
    assert.equal((await one("SELECT auth_source FROM users WHERE email = 'ada@corp.test'")).auth_source, 'ldap');
    assert.equal(binds(), 1);
    // The password changes in the directory: the old one (still the cached hash) is refused where the directory is asked...
    const old = ada.password; ada.password = 'ada-directory-pass-2';
    assert.equal((await post('/auth/sign-in/email', { email: 'ada@corp.test', password: old })).statusCode, 401);
    // ...and no other route makes a session from it: phone number, SMS code, e-mail code, sign-in link, user name.
    await pool.query("UPDATE users SET phone_number = '+905321112233', phone_number_verified = true, username = 'ada' WHERE email = 'ada@corp.test'");
    assert.equal((await post('/auth/sign-in/phone-number', { phoneNumber: '+905321112233', password: old })).statusCode, 404);
    assert.equal((await post('/auth/phone-number/send-otp', { phoneNumber: '+905321112233' })).statusCode, 401);
    assert.equal((await post('/auth/phone-number/verify', { phoneNumber: '+905321112233', code: '123456' })).statusCode, 403);
    assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'panel@example.test',
      use: { passwordReset: true, twoFactor: true } }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: true }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/sign-in', { magicLink: true, username: true }, admin)).statusCode, 200);
    assert.equal((await post('/auth/email-otp/send-verification-otp', { email: 'ada@corp.test', type: 'sign-in' })).json().code, 'PASSWORD_MANAGED_BY_DIRECTORY');
    assert.equal((await post('/auth/sign-in/email-otp', { email: 'ada@corp.test', otp: '000000' })).json().code, 'PASSWORD_MANAGED_BY_DIRECTORY');
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'ada@corp.test', callbackURL: '/' })).json().code, 'PASSWORD_MANAGED_BY_DIRECTORY');
    assert.equal((await post('/auth/sign-in/username', { username: 'ada', password: old })).statusCode, 401);
    assert.equal(smtp.mails.filter((m) => m.includes('ada@corp.test')).length, 0, 'no code or link was mailed');
    assert.equal(await sessionsOf('ada@corp.test'), 1, 'only the session the directory allowed');

    // Wrong passwords count against the address like any other account's: the 11th is refused without asking the directory.
    await freshLimits();
    const start = binds();
    const answers = [];
    for (let i = 0; i < 12; i++) answers.push((await post('/auth/sign-in/email', { email: ' ADA@corp.test', password: `wrong-guess-${i}` })).json().code);
    assert.deepEqual(answers, [...Array(10).fill('INVALID_EMAIL_OR_PASSWORD'), 'RATE_LIMITED', 'RATE_LIMITED']);
    assert.equal(binds() - start, 10, 'two guesses never reached the directory');

    // With the captcha on, nothing happens without a token: no bind, no account made, and the same answer for a
    // right and a wrong password.
    await freshLimits();
    assert.equal((await put('/admin/settings/captcha', { provider: 'turnstile', siteKey: '1x00000000000000000000AA', secret: '1x0000000000000000000000000000000AA', use: { signIn: true } }, admin)).statusCode, 200);
    const all = () => Object.values(dir.attempts).reduce((a, b) => a + b, 0);
    const quiet = all();
    for (const [email, pw] of [['ada@corp.test', ada.password], ['ada@corp.test', 'wrong-guess-x'], ['new@corp.test', 'new-directory-pass-1']]) {
      assert.equal((await post('/auth/sign-in/email', { email, password: pw })).json().code, 'CAPTCHA_REQUIRED', email);
    }
    assert.equal(all(), quiet, 'the directory was not asked');
    assert.equal((await one("SELECT count(*)::int AS n FROM users WHERE email = 'new@corp.test'")).n, 0, 'and no account was made');
    assert.equal((await put('/admin/settings/captcha', { provider: 'none' }, admin)).statusCode, 200);

    // Directory sign-in turned off: its accounts have no way in (the cached hash is not one), panel accounts are as before.
    await freshLimits();
    assert.equal((await post('/auth/sign-in/email', { email: 'ada@corp.test', password: ada.password })).statusCode, 200, 'the new directory password works (and is now the cached one)');
    assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, enabled: false, bindPassword: '' } }, admin)).statusCode, 200);
    const off = await post('/auth/sign-in/email', { email: 'ada@corp.test', password: ada.password });
    assert.equal(off.statusCode, 401);
    assert.equal(cookieOf(off), undefined);
    assert.equal((await post('/auth/sign-in/email', { email: 'ayse@example.test', password })).statusCode, 200);

    // The same rule where sessions are made, for a single sign-on account that happens to have a panel password hash:
    // the password is right, the session is not made.
    const ssoId = await newUser('grace@corp.test', 'Grace');
    assert.equal((await post('/auth/sign-in/email', { email: 'grace@corp.test', password })).statusCode, 200, 'a panel account signs in');
    await pool.query("UPDATE users SET auth_source = 'oidc' WHERE id = $1", [ssoId]);
    const n = await sessionsOf('grace@corp.test');
    const refused = await post('/auth/sign-in/email', { email: 'grace@corp.test', password });
    assert.ok(refused.statusCode >= 400, String(refused.statusCode));
    assert.equal(cookieOf(refused), undefined);
    assert.equal(await sessionsOf('grace@corp.test'), n);
    // Staff acting as such a person is still possible (support), and is recorded as before.
    const acting = await post('/auth/admin/impersonate-user', { userId: ssoId }, admin);
    assert.equal(acting.statusCode, 200, acting.body);
    assert.equal((await get('/auth/me', cookieOf(acting))).json().email, 'grace@corp.test');
  } finally {
    await put('/admin/settings/captcha', { provider: 'none' }, admin);
    await put('/admin/settings/directory', { ldap: { enabled: false } }, admin);
    await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false }, admin);
    await put('/admin/settings/sign-in', { magicLink: false, username: false }, admin);
    await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
    await smtp.close(); await dir.close();
  }
});

test('mailed links carry the address the panel was given, not the host of the request; a link is not a second factor', async () => {
  await freshLimits();
  const smtp = await fakeSmtp();
  try {
    assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'panel@example.test',
      use: { passwordReset: true, twoFactor: true } }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/sign-in', { magicLink: true }, admin)).statusCode, 200);
    await pool.query(`UPDATE settings SET value = '"https://panel.example.test"' WHERE key = 'public_url'`);
    const evil = { host: 'evil.example', origin: 'http://evil.example' };
    assert.equal((await post('/auth/request-password-reset', { email: 'ayse@example.test', redirectTo: '/reset-password' }, null, evil)).statusCode, 200);
    const linkId = await newUser('link@example.test', 'Link');
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' }, null, evil)).statusCode, 200);
    const reset = await until(() => smtp.mails.find((m) => m.includes('ayse@example.test') && m.includes('/reset-password/')));
    const link = await until(() => smtp.mails.find((m) => m.includes('link@example.test') && m.includes('/magic-link/verify')));
    assert.ok(reset && link, 'both were mailed');
    assert.match(reset, /https:\/\/panel\.example\.test\/api\/auth\/reset-password\//);
    assert.match(link, /https:\/\/panel\.example\.test\/api\/auth\/magic-link\/verify\?token=/);
    for (const m of [reset, link]) assert.doesNotMatch(m, /evil\.example/);
    // No address set (first run, local only): the request's own, as before.
    await pool.query("UPDATE settings SET value = 'null' WHERE key = 'public_url'");
    smtp.mails.length = 0;
    await freshLimits();
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' })).statusCode, 200);
    const local = await until(() => smtp.mails.find((m) => m.includes('/magic-link/verify')));
    assert.match(local, /http:\/\/localhost\/api\/auth\/magic-link\/verify\?token=/);
    // No address known and the request names a host that is neither this machine nor a private network: nothing is
    // mailed (the answer is the same). A private address is taken as it is.
    smtp.mails.length = 0;
    await freshLimits();
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' }, null, evil)).statusCode, 200);
    assert.equal((await post('/auth/request-password-reset', { email: 'ayse@example.test', redirectTo: '/reset-password' }, null, evil)).statusCode, 200);
    const lan = { host: '10.1.2.3:8080', origin: 'http://10.1.2.3:8080' };
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' }, null, lan)).statusCode, 200);
    assert.ok(await until(() => smtp.mails.find((m) => m.includes('http://10.1.2.3:8080/api/auth/magic-link/verify'))));
    assert.equal(smtp.mails.length, 1, 'the two requests under a foreign host name were not mailed');
    // The operator's PANEL_PUBLIC_URL settles it, before anything else.
    process.env.PANEL_PUBLIC_URL = 'https://fixed.example.test/';
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' }, null, evil)).statusCode, 200);
    assert.ok(await until(() => smtp.mails.find((m) => m.includes('https://fixed.example.test/api/auth/magic-link/verify'))));
    delete process.env.PANEL_PUBLIC_URL;
    // While no address is known, the one the first administrator signs in on is kept: not a customer's, not a later one.
    const at = (name) => ({ host: name, origin: `http://${name}` });
    const stored = async () => (await one("SELECT value FROM settings WHERE key = 'public_url'")).value;
    assert.ok(cookieOf(await post('/auth/sign-in/email', { email: 'ayse@example.test', password }, null, at('customer.example'))));
    assert.equal(await stored(), null);
    assert.ok(cookieOf(await post('/auth/sign-in/email', { email: 'boss@example.test', password }, null, at('panel.first.example'))));
    assert.equal(await stored(), 'http://panel.first.example');
    assert.ok(cookieOf(await post('/auth/sign-in/email', { email: 'boss@example.test', password }, null, at('panel.second.example'))));
    assert.equal(await stored(), 'http://panel.first.example');
    await pool.query("UPDATE settings SET value = 'null' WHERE key = 'public_url'");
    // An account with two-factor: neither asking for a link nor an older link signs it in.
    await pool.query('UPDATE users SET two_factor_enabled = true WHERE id = $1', [linkId]);
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' })).json().code, 'TWO_FACTOR_USE_PASSWORD');
    const mailed = new URL(/(https?:\/\/\S+magic-link\/verify[^\s"<]+)/.exec(local)[1]);
    const used = await app.inject({ method: 'GET', url: mailed.pathname.replace(/^\/api/, '') + mailed.search, headers: { host: 'localhost' } });
    assert.equal(cookieOf(used), undefined, 'the link mailed before two-factor was turned on does not sign in');
    assert.equal(await sessionsOf('link@example.test'), 0);
    await post('/auth/admin/remove-user', { userId: linkId }, admin);
  } finally {
    delete process.env.PANEL_PUBLIC_URL;
    await pool.query("UPDATE settings SET value = 'null' WHERE key = 'public_url'");
    await put('/admin/settings/sign-in', { magicLink: false }, admin);
    await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
    await smtp.close();
  }
});

const pushKeys = { p256dh: `B${'A'.repeat(86)}`, auth: 'a'.repeat(22) };
test('staff acting as someone leave nothing that outlives the session', async () => {
  await freshLimits();
  const r = await post('/auth/admin/impersonate-user', { userId }, admin);
  assert.equal(r.statusCode, 200, r.body);
  const as = cookieOf(r);
  assert.ok((await get('/auth/me', as)).json().impersonatedBy);
  const refused = [
    await post('/account/api-tokens', { name: 'kept', scope: 'read' }, as),
    await post('/account/webhooks', { url: 'https://93.184.216.34/hook', events: ['*'] }, as),
    await post('/notifications/push-subscriptions', { endpoint: 'https://93.184.216.34/push/abcdef123456', keys: pushKeys }, as),
    await get('/auth/passkey/generate-register-options', as),
    await post('/auth/link-social', { provider: 'github', callbackURL: '/account?tab=security' }, as),
    await post('/auth/change-password', { currentPassword: password, newPassword: 'another long password 1' }, as),
    await post('/auth/two-factor/enable', { password }, as),
    await post('/auth/phone-number/send-otp', { phoneNumber: '+905329998877' }, as),
  ];
  assert.deepEqual(refused.map((x) => [x.statusCode, x.json().code]), refused.map(() => [403, 'NOT_WHILE_IMPERSONATING']));
  const left = await one(`SELECT (SELECT count(*)::int FROM api_tokens WHERE user_id = $1) AS tokens, (SELECT count(*)::int FROM webhooks WHERE user_id = $1) AS hooks,
    (SELECT count(*)::int FROM push_subscriptions WHERE user_id = $1) AS push, (SELECT count(*)::int FROM auth_passkeys WHERE user_id = $1) AS passkeys,
    (SELECT two_factor_enabled FROM users WHERE id = $1) AS "twoFactor"`, [userId]);
  assert.deepEqual(left, { tokens: 0, hooks: 0, push: 0, passkeys: 0, twoFactor: false });
  // The person themselves is not affected.
  assert.equal((await post('/auth/sign-in/email', { email: 'ayse@example.test', password })).statusCode, 200);
  assert.equal((await get('/auth/passkey/generate-register-options', user)).statusCode, 200);
});

test('push subscriptions: a public HTTPS endpoint under a plain host name, owned by who subscribed it, gone when the sessions are ended', async (t) => {
  await freshLimits();
  // No network here: the push service's name answers with a public address, another name with an internal one.
  const dns = createRequire(import.meta.url)('node:dns/promises'), realLookup = dns.lookup;
  dns.lookup = async (host) => [{ address: host === 'inside.example.test' ? '10.0.0.5' : '93.184.216.34', family: 4 }];
  t.after(() => { dns.lookup = realLookup; });
  // A plain host name only: no address written as a number, nothing in the host that two URL readers split differently.
  for (const endpoint of ['https://127.0.0.1/push/abcdef123456', 'https://10.0.0.5/push/abcdef123456', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/push/abcdef123456',
    'https://[::ffff:10.0.0.1]/push/abcdef', 'https://localhost/push/abcdef123456', 'http://push.example.test/push/abcdef123456', 'https://user:pw@push.example.test/push/abcdef',
    'https://93.184.216.34/push/abcdef123456', 'https://127.0.0.1%2Epush.example.test/push/abcdef', 'https://127.0.0.1;push.example.test/push/abcdef', 'https://2130706433/push/abcdef',
    'https://inside.example.test/push/abcdef123456']) {
    const r = await post('/notifications/push-subscriptions', { endpoint, keys: pushKeys }, user);
    assert.deepEqual([r.statusCode, r.json().fields?.endpoint], [400, 'INVALID_VALUE'], endpoint);
  }
  // Kept as the address that was checked, in its normal form; the browser's own spelling still removes it.
  assert.equal((await post('/notifications/push-subscriptions', { endpoint: 'https://Push.Example.TEST/push/Abc?x=1', keys: pushKeys }, user)).statusCode, 201);
  assert.equal((await one('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [userId])).endpoint, 'https://push.example.test/push/Abc?x=1');
  assert.equal((await call('DELETE', '/notifications/push-subscriptions', user, { endpoint: 'https://Push.Example.TEST/push/Abc?x=1' })).statusCode, 204);
  assert.equal((await one('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId])).n, 0);
  const endpoint = 'https://push.example.test/push/abcdef123456';
  assert.equal((await post('/notifications/push-subscriptions', { endpoint, keys: pushKeys }, user)).statusCode, 201);
  assert.equal((await post('/notifications/push-subscriptions', { endpoint, keys: pushKeys }, user)).statusCode, 201, 'again by its owner');
  // Someone who only knows the address does not take the row; the same browser subscription (its keys) changes hands.
  const otherId = await newUser('other@example.test', 'Other');
  const other = cookieOf(await post('/auth/sign-in/email', { email: 'other@example.test', password }));
  const taken = await post('/notifications/push-subscriptions', { endpoint, keys: { p256dh: `B${'C'.repeat(86)}`, auth: 'c'.repeat(22) } }, other);
  assert.deepEqual([taken.statusCode, taken.json().code], [409, 'PUSH_ENDPOINT_IN_USE']);
  assert.equal((await one('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [endpoint])).user_id, userId);
  assert.equal((await post('/notifications/push-subscriptions', { endpoint, keys: pushKeys }, other)).statusCode, 201);
  assert.equal((await one('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [endpoint])).user_id, otherId);
  // What the web app calls at sign-out: DELETE with the endpoint, by its owner only.
  assert.equal((await call('DELETE', '/notifications/push-subscriptions', user, { endpoint })).statusCode, 204);
  assert.equal((await one('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [endpoint])).n, 1, 'not by someone else');
  assert.equal((await call('DELETE', '/notifications/push-subscriptions', other, { endpoint })).statusCode, 204);
  assert.equal((await one('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [endpoint])).n, 0);
  // Sessions ended by staff: the browsers stop receiving.
  assert.equal((await post('/notifications/push-subscriptions', { endpoint, keys: pushKeys }, other)).statusCode, 201);
  assert.equal((await post('/auth/admin/revoke-user-sessions', { userId: otherId }, admin)).statusCode, 200);
  assert.equal((await one('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [otherId])).n, 0);

  // Every other way sessions end takes the subscriptions along too. Two browsers of one person, each subscribed.
  const signIn = async (agent) => cookieOf(await post('/auth/sign-in/email', { email: 'other@example.test', password }, null, { 'user-agent': agent }));
  const subscribed = async () => (await pool.query('SELECT user_agent FROM push_subscriptions WHERE user_id = $1 ORDER BY user_agent', [otherId])).rows.map((r) => r.user_agent);
  const sessionIds = async () => (await pool.query('SELECT id, user_agent FROM auth_sessions WHERE user_id = $1', [otherId])).rows;
  const two = async (agentA = 'Browser-A', agentB = 'Browser-B') => {
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [otherId]);
    await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [otherId]);
    await freshLimits();
    const a = await signIn(agentA), b = await signIn(agentB);
    assert.equal((await post('/notifications/push-subscriptions', { endpoint: `${endpoint}-a`, keys: pushKeys }, a, { 'user-agent': agentA })).statusCode, 201);
    assert.equal((await post('/notifications/push-subscriptions', { endpoint: `${endpoint}-b`, keys: pushKeys }, b, { 'user-agent': agentB })).statusCode, 201);
    const rows = await sessionIds();
    return { a, b, idA: rows.find((r) => r.user_agent === agentA)?.id, idB: rows.find((r) => r.user_agent === agentB)?.id };
  };
  // The person ends one other session, then all others: the browser in use keeps its own subscription, the ended do not.
  let s = await two();
  assert.equal((await call('DELETE', `/account/sessions/${s.idB}`, s.a, undefined, { 'user-agent': 'Browser-A' })).statusCode, 204);
  assert.deepEqual(await subscribed(), ['Browser-A']);
  s = await two();
  assert.equal((await call('DELETE', '/account/sessions', s.a, undefined, { 'user-agent': 'Browser-A' })).json().ended, 1);
  assert.deepEqual(await subscribed(), ['Browser-A']);
  // Two browsers that cannot be told apart: all subscriptions go.
  s = await two('Same-Browser', 'Same-Browser');
  assert.equal((await call('DELETE', '/account/sessions', s.a, undefined, { 'user-agent': 'Same-Browser' })).json().ended, 1);
  assert.deepEqual(await subscribed(), []);
  // A password change that signs the other devices out.
  s = await two();
  assert.equal((await post('/auth/change-password', { currentPassword: password, newPassword: password, revokeOtherSessions: true }, s.a, { 'user-agent': 'Browser-A' })).statusCode, 200);
  assert.deepEqual(await subscribed(), []);
  s = await two();
  assert.equal((await post('/auth/change-password', { currentPassword: password, newPassword: password }, s.a, { 'user-agent': 'Browser-A' })).statusCode, 200);
  assert.equal((await subscribed()).length, 2, 'without signing anyone out nothing is dropped');
  // Staff end one session of the person; staff end all sessions of several people at once.
  assert.equal((await call('DELETE', `/admin/users/${otherId}/sessions/${s.idB}`, admin)).statusCode, 204);
  assert.deepEqual(await subscribed(), []);
  s = await two();
  assert.equal((await post('/auth/admin/revoke-user-session', { sessionToken: (await one('SELECT token FROM auth_sessions WHERE id = $1', [s.idB])).token }, admin)).statusCode, 200);
  assert.deepEqual(await subscribed(), []);
  s = await two();
  assert.equal((await post('/admin/users/actions', { action: 'end_sessions', userIds: [otherId] }, admin)).json().done, 1);
  assert.deepEqual(await subscribed(), []);
  assert.equal((await sessionIds()).length, 0);
  await post('/auth/admin/remove-user', { userId: otherId }, admin);
});

test('settings tests hand back no text of the address in the form; a stored secret does not follow a changed address', async () => {
  await freshLimits();
  const failing = await fakeInternal(500), answering = await fakeInternal(200);
  try {
    // Reverse DNS: the kind of failure, never the body.
    const rdns = await post('/admin/settings/rdns/test', { apiUrl: `http://127.0.0.1:${failing.port}`, apiKey: 'key-1', serverId: 'localhost' }, staff);
    assert.deepEqual([rdns.statusCode, rdns.json().code, rdns.json().detail], [502, 'RDNS_FAILED', 'HTTP 5xx']);
    assert.doesNotMatch(rdns.body, new RegExp(marker));
    const notJson = await post('/admin/settings/rdns/test', { apiUrl: `http://127.0.0.1:${answering.port}`, apiKey: 'key-1', serverId: 'localhost' }, staff);
    assert.equal(notJson.statusCode, 502);
    assert.doesNotMatch(notJson.body, new RegExp(marker));
    // The stored key is for the address it was entered for.
    const saved = { provider: 'powerdns', apiUrl: `http://127.0.0.1:${failing.port}`, serverId: 'localhost', ttl: 3600 };
    assert.equal((await put('/admin/settings/rdns', { ...saved, apiKey: 'key-1' }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/rdns', { ...saved, apiKey: '' }, staff)).statusCode, 200, 'same address: kept');
    for (const path of ['/admin/settings/rdns', '/admin/settings/rdns/test']) {
      const moved = await call(path.endsWith('test') ? 'POST' : 'PUT', path, staff, { ...saved, apiUrl: `http://127.0.0.1:${answering.port}`, apiKey: '' });
      assert.deepEqual([moved.statusCode, moved.json().fields?.apiKey], [400, 'REQUIRED'], path);
    }
    await put('/admin/settings/rdns', { provider: 'none' }, admin);

    // The custom SMS provider: sent or refused, with the status class; never the answer's text.
    const custom = (port, extra = {}) => ({ provider: 'custom', sender: '', credentials: { url: `http://127.0.0.1:${port}/send?to={to}`, method: 'GET', phoneFormat: 'e164', successPattern: 'INTERNAL', ...extra }, use: {} });
    // With values of their own (an address and a pattern from the form) it is the administrator's to try.
    const sent = await post('/admin/settings/sms/test', { ...custom(answering.port), to: '+905321234567' }, admin);
    assert.equal(sent.statusCode, 200, sent.body);
    assert.doesNotMatch(sent.body, new RegExp(marker));
    const rejected = await post('/admin/settings/sms/test', { ...custom(failing.port), to: '+905321234567' }, admin);
    assert.deepEqual([rejected.statusCode, rejected.json().code, rejected.json().detail], [422, 'SMS_REJECTED', 'HTTP 5xx']);
    assert.doesNotMatch(rejected.body, new RegExp(marker));
    const closed = await post('/admin/settings/sms/test', { ...custom(1), to: '+905321234567' }, admin);
    assert.deepEqual([closed.statusCode, closed.json().code, closed.json().detail], [422, 'SMS_PROVIDER_UNREACHABLE', undefined]);
    // Staff with settings.manage: nothing unsaved (their pattern would tell them what an internal address answers)...
    const unsaved = await post('/admin/settings/sms/test', { ...custom(answering.port), to: '+905321234567' }, staff);
    assert.deepEqual([unsaved.statusCode, unsaved.json().code], [403, 'FORBIDDEN']);
    // Its secret headers are for the server they were entered for.
    assert.equal((await put('/admin/settings/sms', custom(answering.port, { headers: '{"x-api-key":"s3cret"}' }), admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/sms', custom(answering.port), admin)).statusCode, 200, 'same server: kept');
    const elsewhere = await post('/admin/settings/sms/test', { ...custom(failing.port), to: '+905321234567' }, admin);
    assert.deepEqual([elsewhere.statusCode, elsewhere.json().fields?.['credentials.headers']], [400, 'REQUIRED']);
    // ...only what is saved, whatever their form says, answered with sent or not and nothing else.
    const guess = (port, successPattern) => post('/admin/settings/sms/test', { ...custom(port, { successPattern }), to: '+905321234567' }, staff);
    for (const r of [await guess(failing.port, '^NOT-THE-TEXT'), await guess(answering.port, 'INTERNAL-ONLY-TEXT-7f3a')]) assert.deepEqual([r.statusCode, r.json().sent], [200, true], 'the saved address and pattern were used');
    assert.equal((await put('/admin/settings/sms', custom(failing.port, { headers: '{"x-api-key":"s3cret"}' }), admin)).statusCode, 200);
    for (const r of [await guess(answering.port, 'INTERNAL'), await guess(1, 'x')]) assert.deepEqual([r.statusCode, r.json().code, r.json().detail], [422, 'SMS_REJECTED', undefined]);
    await put('/admin/settings/sms', { provider: 'none' }, admin);

    // Outgoing mail: another host in the form needs the password again; the failure is a code, not the server's words.
    assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: 1, security: 'none', username: 'panel', password: 'p4ssw0rd-stored', fromAddress: 'panel@example.test' }, admin)).statusCode, 200);
    const mailForm = { to: 'boss@example.test', enabled: true, provider: 'smtp', host: 'localhost', port: failing.port, security: 'none', username: 'panel', fromAddress: 'panel@example.test' };
    assert.equal((await post('/admin/settings/mail/test', mailForm, staff)).json().fields?.password, 'REQUIRED');
    const mailTest = await post('/admin/settings/mail/test', { ...mailForm, host: '127.0.0.1', port: 1 }, staff);
    assert.deepEqual([mailTest.statusCode, mailTest.json().code, mailTest.json().detail], [422, 'MAIL_CONNECTION_FAILED', undefined]);
    await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
  } finally { await failing.close(); await answering.close(); }
});

// The library's own limiter counts per client address (every test calls from one): cleared where a test is about the
// panel's counts per account and per destination, which stay.
const clearAddressLimits = async () => { for (const k of await redis.keys('rl:ba:*')) await redis.del(k); };
const tokenOf = (cookie) => decodeURIComponent(cookie).split('.')[0];

test('the channels that carry reset links and sign-in codes, and switching a safeguard off, are the administrator\'s', async () => {
  await freshLimits();
  const denied = (r, what) => assert.deepEqual([r.statusCode, r.json().code, r.json().need], [403, 'FORBIDDEN', ['*']], what);
  const before = await one("SELECT (SELECT value FROM settings WHERE key = 'mail') AS mail, (SELECT value FROM settings WHERE key = 'sms') AS sms");
  denied(await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: 1, security: 'none', fromAddress: 'takeover@example.test' }, staff), 'mail transport and sender');
  denied(await put('/admin/settings/sms', { provider: 'none' }, staff), 'SMS provider');
  denied(await put('/admin/settings/sign-in', { magicLink: true }, staff), 'sign-in links on');
  denied(await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: true }, staff), 'e-mail codes on');
  assert.deepEqual(await one("SELECT (SELECT value FROM settings WHERE key = 'mail') AS mail, (SELECT value FROM settings WHERE key = 'sms') AS sms"), before, 'nothing was saved');
  assert.equal((await get('/admin/settings/sign-in', staff)).json().magicLink, false);
  assert.equal((await get('/admin/settings/security', staff)).json().emailCodeSignIn, false);
  // What stays with settings.manage: the other settings of the same pages, and reading all of them.
  assert.equal((await put('/admin/settings/sign-in', { magicLink: false, username: false }, staff)).statusCode, 200);
  assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false, apiTokens: 'staff' }, staff)).statusCode, 200);
  assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false, apiTokens: 'everyone' }, staff)).statusCode, 200);
  for (const page of ['mail', 'security', 'captcha']) assert.equal((await get(`/admin/settings/${page}`, staff)).statusCode, 200, page);
  assert.equal((await get('/admin/settings/sms', staff)).statusCode, 200);
  // The captcha: staff may turn it on or keep it; taking it away (at all, from one form, by a lower score) is not theirs.
  const captcha = { provider: 'recaptcha-v3', siteKey: 'site-key-0123456789', secret: 'secret-key-0123456789', minScore: 0.5, use: { signIn: false, signUp: true, passwordReset: true } };
  try {
    assert.equal((await put('/admin/settings/captcha', captcha, staff)).statusCode, 200);
    denied(await put('/admin/settings/captcha', { provider: 'none' }, staff), 'captcha off');
    denied(await put('/admin/settings/captcha', { ...captcha, secret: '', use: { ...captcha.use, signUp: false } }, staff), 'captcha off for one form');
    denied(await put('/admin/settings/captcha', { ...captcha, secret: '', minScore: 0.1 }, staff), 'a lower score');
    assert.equal((await put('/admin/settings/captcha', { ...captcha, secret: '', use: { ...captcha.use, signIn: false } }, staff)).statusCode, 200, 'unchanged');
    assert.equal((await get('/admin/settings/captcha', staff)).json().use.signUp, true);
  } finally { assert.equal((await put('/admin/settings/captcha', { provider: 'none' }, admin)).statusCode, 200); }
});

test('a session started as someone else ends with the access of the staff member who started it, and an hour after it began', async () => {
  await freshLimits();
  assert.equal((await post('/admin/roles', { key: 'helper', name: 'Helper', permissions: ['users.view', 'users.impersonate'] }, admin)).statusCode, 201);
  const helperId = await newUser('helper@example.test', 'Helper');
  const grant = async () => assert.equal((await put(`/admin/users/${helperId}/access`, { roles: ['helper'], overrides: [] }, admin)).statusCode, 200);
  // The helper with their access (back), signed in, acting as the customer.
  const start = async () => {
    await post('/auth/admin/unban-user', { userId: helperId }, admin);
    await pool.query('UPDATE users SET banned = false WHERE id = $1', [helperId]);
    await grant();
    await freshLimits();
    const helper = cookieOf(await post('/auth/sign-in/email', { email: 'helper@example.test', password }));
    const r = await post('/auth/admin/impersonate-user', { userId }, helper);
    assert.equal(r.statusCode, 200, r.body);
    return cookieOf(r);
  };
  const row = (cookie) => one('SELECT id, expires_at, created_at FROM auth_sessions WHERE token = $1', [tokenOf(cookie)]);
  // atOnce: the route that took the access away removed the session itself; otherwise its next request does.
  const gone = async (cookie, what, atOnce = true) => {
    if (atOnce) assert.equal(await row(cookie), undefined, `${what}: the session is removed`);
    assert.equal((await get('/auth/me', cookie)).statusCode, 401, what);
    assert.equal(await row(cookie), undefined, what);
  };

  // One hour, whatever the browser sends: used without the cookie that asks the library not to extend it, the
  // session's end stays where it was; and an hour after it began it is over even if its row said otherwise.
  let as = await start();
  assert.equal((await get('/auth/me', as)).json().impersonatedBy, helperId);
  const began = await row(as);
  assert.ok(began.expires_at.getTime() - began.created_at.getTime() <= 3_600_000 + 2000);
  for (let i = 0; i < 3; i++) assert.equal((await get('/auth/get-session', as)).statusCode, 200);
  assert.equal((await row(as)).expires_at.getTime(), began.expires_at.getTime(), 'using it does not move its end');
  await pool.query("UPDATE auth_sessions SET expires_at = now() + interval '12 hours' WHERE id = $1", [began.id]);
  assert.equal((await row(as)).expires_at.getTime(), began.expires_at.getTime(), 'nothing moves its end later');
  // (An ordinary session still slides.)
  const mine = await row(user);
  await pool.query("UPDATE auth_sessions SET expires_at = now() + interval '12 hours' WHERE id = $1", [mine.id]);
  assert.ok((await row(user)).expires_at.getTime() >= mine.expires_at.getTime());
  await pool.query("UPDATE auth_sessions SET created_at = now() - interval '61 minutes' WHERE id = $1", [began.id]);
  assert.equal((await get('/auth/me', as)).statusCode, 401, 'an hour after it began');
  assert.equal(await row(as), undefined);

  // The staff member is demoted, banned, has their sessions ended (all, or one), gets a new password, is removed.
  as = await start();
  assert.equal((await put(`/admin/users/${helperId}/access`, { roles: ['user'], overrides: [] }, admin)).statusCode, 200);
  await gone(as, 'demoted');
  for (const [path, body] of [['/auth/admin/ban-user', { userId: helperId }], ['/auth/admin/revoke-user-sessions', { userId: helperId }],
    ['/auth/admin/set-user-password', { userId: helperId, newPassword: password }]]) {
    as = await start();
    assert.equal((await post(path, body, admin)).statusCode, 200, path);
    await gone(as, path);
  }
  as = await start();
  const own = await one('SELECT id, token FROM auth_sessions WHERE user_id = $1 LIMIT 1', [helperId]);
  assert.equal((await call('DELETE', `/admin/users/${helperId}/sessions/${own.id}`, admin)).statusCode, 204);
  await gone(as, 'one session ended by staff');
  as = await start();
  assert.equal((await post('/admin/users/actions', { action: 'end_sessions', userIds: [helperId] }, admin)).json().done, 1);
  await gone(as, 'sessions ended for several people');
  as = await start();
  assert.equal((await put('/admin/roles/helper', { name: 'Helper', permissions: ['users.view'] }, admin)).statusCode, 200);
  await gone(as, 'the role lost the permission');
  assert.equal((await put('/admin/roles/helper', { name: 'Helper', permissions: ['users.view', 'users.impersonate'] }, admin)).statusCode, 200);

  // However the access went (here straight in the database, past every route): the session's next request notices.
  // A "yes" is remembered for five seconds: wait them out once, then never ask before the change.
  await new Promise((r) => setTimeout(r, 5200));
  as = await start();
  await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [helperId]);
  await gone(as, 'no longer holds users.impersonate', false);
  as = await start();
  await pool.query('UPDATE users SET banned = true WHERE id = $1', [helperId]);
  await gone(as, 'banned', false);
  as = await start();
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
  try { await gone(as, 'the person now holds more than the staff member', false); } finally { await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [userId]); }
  as = await start();
  assert.equal((await post('/auth/admin/remove-user', { userId: helperId }, admin)).statusCode, 200);
  await gone(as, 'removed');
  assert.equal((await call('DELETE', '/admin/roles/helper', admin)).statusCode, 204);
  // The customer's own session was never touched.
  assert.equal((await get('/auth/me', user)).statusCode, 200);
});

test('the password step of an account with two-factor is not a sign-in; its codes are counted per account', async () => {
  await freshLimits();
  const id = await newUser('twofa@example.test', 'Two');
  const c = cookieOf(await post('/auth/sign-in/email', { email: 'twofa@example.test', password }));
  const enabled = await post('/auth/two-factor/enable', { password }, c);
  assert.equal(enabled.statusCode, 200, enabled.body);
  const [backup] = enabled.json().backupCodes;
  await pool.query('UPDATE users SET two_factor_enabled = true WHERE id = $1', [id]);
  const count = async (action) => (await one("SELECT count(*)::int AS n FROM audit_events WHERE actor_id = $1 AND action = $2 AND outcome = 'success'", [id, action])).n;
  const announced = async () => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => /^auth\.(sign_in|new_device)$/.test(j.data.event) && j.data.to?.[0] === id).length;
  const [logins, notices] = [await count('auth.login'), await announced()];

  // From a browser and a network this account never signed in from.
  const elsewhere = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'x-forwarded-for': '198.51.100.7' };
  const step = await post('/auth/sign-in/email', { email: 'twofa@example.test', password }, null, elsewhere);
  assert.equal(step.json().twoFactorRedirect, true, step.body);
  assert.equal(cookieOf(step), undefined);
  assert.equal(await count('auth.login'), logins, 'no sign-in is recorded for the password alone');
  assert.equal(await count('auth.password_step'), 1, 'the step is recorded as what it is');
  assert.equal(await announced(), notices, 'and nobody is told they signed in');
  assert.equal(await sessionsOf('twofa@example.test'), 1, 'only the session from before');

  // Codes by SMS or e-mail for the pending step: a few an hour for the account, from however many addresses.
  const jar = [step.headers['set-cookie']].flat().map((v) => v.split(';')[0]).filter((v) => !v.endsWith('=')).join('; ');
  const second = (path, payload) => app.inject({ method: 'POST', url: path, payload, headers: { ...csrf, ...elsewhere, cookie: jar } });
  for (let i = 0; i < 8; i++) { await clearAddressLimits(); assert.equal((await second('/auth/two-factor/send-otp', {})).statusCode, 200, `code ${i + 1}`); }
  await clearAddressLimits();
  const over = await second('/auth/two-factor/send-otp', {});
  assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);

  // The second step makes the session: now it is a sign-in, recorded once, from a device not seen before.
  await clearAddressLimits();
  const done = await second('/auth/two-factor/verify-backup-code', { code: backup });
  assert.equal(done.statusCode, 200, done.body);
  assert.ok(cookieOf(done));
  assert.equal(await count('auth.login'), logins + 1);
  assert.equal((await one("SELECT metadata->>'method' AS method FROM audit_events WHERE actor_id = $1 AND action = 'auth.login' ORDER BY id DESC LIMIT 1", [id])).method, 'password+2fa');
  const told = (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.to?.[0] === id && j.data.data?.method === 'password+2fa');
  assert.deepEqual(told.map((j) => j.data.event), ['auth.new_device'], 'the password step did not make this device a known one');
  await post('/auth/admin/remove-user', { userId: id }, admin);
});

test('what makes the panel send a message is counted per account and per destination, not only per client address', async () => {
  await freshLimits();
  const answering = await fakeInternal(200);
  const person = async (email) => { const id = await newUser(email); await freshLimits(); return { id, c: cookieOf(await post('/auth/sign-in/email', { email, password })) }; };
  try {
    assert.equal((await put('/admin/settings/sms', { provider: 'custom', sender: '', credentials: { url: `http://127.0.0.1:${answering.port}/send?to={to}`, method: 'GET', phoneFormat: 'e164', successPattern: 'INTERNAL' },
      use: { phoneVerification: true, twoFactor: true } }, admin)).statusCode, 200);
    const p1 = await person('sender1@example.test'), p2 = await person('sender2@example.test');
    await freshLimits();
    // Verification codes: five a day to one number whoever asks, five a day from one account wherever to.
    const code = async (who, phoneNumber) => { await clearAddressLimits(); return post('/auth/phone-number/send-otp', { phoneNumber }, who.c); };
    for (let i = 0; i < 3; i++) assert.equal((await code(p1, '+905550000001')).statusCode, 200, `first account ${i}`);
    for (let i = 0; i < 2; i++) assert.equal((await code(p2, '+905550000001')).statusCode, 200, `second account ${i}`);
    let over = await code(p2, '+905550000001');
    assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED'], 'the number had its five');
    assert.equal((await code(p2, '+905550000002')).statusCode, 200);
    assert.equal((await code(p2, '+905550000003')).statusCode, 200);
    over = await code(p2, '+905550000004');
    assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED'], 'the account had its five');
    assert.equal((await code(p2, 'not a number')).statusCode, 400, 'what is not a number is not counted, only refused');

    // Notification tests: six an hour per account over all channels; for SMS also per number, across accounts.
    await pool.query("UPDATE users SET phone_number = '+905550000009', phone_number_verified = true WHERE id = ANY($1::uuid[])", [[p1.id]]);
    const tryIt = (who, channel) => post('/notifications/test', { channel }, who.c);
    for (let i = 0; i < 6; i++) assert.equal((await tryIt(p1, i % 2 ? 'sms' : 'inApp')).statusCode, 200, `test ${i}`);
    for (const channel of ['inApp', 'sms']) {
      over = await tryIt(p1, channel);
      assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED'], channel);
    }
    // The same number on another account (it moved there): three were sent to it, three are left.
    await pool.query('UPDATE users SET phone_number = NULL, phone_number_verified = false WHERE id = $1', [p1.id]);
    await pool.query("UPDATE users SET phone_number = '+905550000009', phone_number_verified = true WHERE id = $1", [p2.id]);
    for (let i = 0; i < 3; i++) assert.equal((await tryIt(p2, 'sms')).statusCode, 200, `other account ${i}`);
    over = await tryIt(p2, 'sms');
    assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
    assert.equal((await tryIt(p2, 'inApp')).statusCode, 200, 'the account itself still has tests left');

    // Reset mail: five an hour per mailbox, known or not, from however many addresses.
    for (let i = 0; i < 5; i++) { await clearAddressLimits(); assert.equal((await post('/auth/request-password-reset', { email: 'Nobody@example.test', redirectTo: '/reset-password' })).statusCode, 200); }
    await clearAddressLimits();
    over = await post('/auth/request-password-reset', { email: 'nobody@example.test', redirectTo: '/reset-password' });
    assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
    for (const p of [p1, p2]) await post('/auth/admin/remove-user', { userId: p.id }, admin);
  } finally {
    await put('/admin/settings/sms', { provider: 'none' }, admin);
    await answering.close();
  }
});

test('ticket replies and ratings are paced and tell staff once; a ticket\'s notices follow who may still see tickets', async (t) => {
  await freshLimits();
  const adminId = (await get('/auth/me', admin)).json().id;
  const [dep] = (await get('/support/departments', user)).json().departments;
  const open = async (subject) => { const r = await post('/support/tickets', { subject, departmentId: dep.id, body: 'Please look' }, user); assert.equal(r.statusCode, 201, r.body); return r.json().id; };
  const reply = (id, body, who = user) => post(`/support/tickets/${id}/messages`, { body }, who);
  const first = await open('Disk is full');
  const queued = async (event, id) => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === event && j.data.data.ticketId === id).length;

  // A burst of replies is one notice; after staff answered, the next reply tells them again.
  for (let i = 0; i < 3; i++) assert.equal((await reply(first, `More ${i}`)).statusCode, 201);
  assert.equal(await queued('support.customer_message', first), 1);
  assert.equal((await reply(first, 'Looking into it', admin)).statusCode, 201);
  assert.equal((await reply(first, 'Thanks')).statusCode, 201);
  assert.equal(await queued('support.customer_message', first), 2);
  // Ten customer writes on one ticket in ten minutes; staff are not counted.
  for (let i = 0; i < 6; i++) assert.equal((await reply(first, `Again ${i}`)).statusCode, 201, `reply ${i}`);
  const over = await reply(first, 'One too many');
  assert.deepEqual([over.statusCode, over.json().code], [429, 'RATE_LIMITED']);
  assert.equal((await one('SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = $1 AND NOT staff', [first])).n, 11, 'the refused one was not stored');
  assert.equal((await reply(first, 'Still here', admin)).statusCode, 201);

  // A rating tells staff the first time only, whichever way it is changed afterwards; ratings are paced with replies.
  assert.equal((await post(`/support/tickets/${first}/close`, {}, admin)).statusCode, 200);
  await freshLimits();
  for (const rating of [1, 5, 2, 4, 1]) assert.equal((await post(`/support/tickets/${first}/rating`, { rating, comment: `It was a ${rating}` }, user)).statusCode, 200);
  assert.equal(await queued('support.low_rating', first), 1);
  for (let i = 0; i < 5; i++) assert.equal((await post(`/support/tickets/${first}/rating`, { rating: 3 + (i % 2) }, user)).statusCode, 200);
  assert.equal((await post(`/support/tickets/${first}/rating`, { rating: 1 }, user)).statusCode, 429);
  const good = await open('Thank you');
  assert.equal((await post(`/support/tickets/${good}/close`, {}, admin)).statusCode, 200);
  for (const rating of [5, 1]) assert.equal((await post(`/support/tickets/${good}/rating`, { rating }, user)).statusCode, 200);
  assert.equal(await queued('support.low_rating', good), 0, 'a good first rating changed later tells nobody');

  // Only someone who can answer tickets is assigned one; when they can no longer see tickets, theirs go back to the team.
  await freshLimits();
  const agentId = await newUser('agent2@example.test', 'Agent');
  assert.equal((await put(`/admin/users/${agentId}/access`, { roles: ['support'], overrides: [] }, admin)).statusCode, 200);
  const second = await open('Assigned one');
  const assign = (assigneeId) => call('PATCH', `/admin/support/tickets/${second}`, admin, { assigneeId });
  const assignee = async () => (await one('SELECT assignee_id FROM tickets WHERE id = $1', [second])).assignee_id;
  for (const notStaff of [userId, '00000000-0000-4000-8000-000000000000', 'x']) assert.equal((await assign(notStaff)).json().fields?.assigneeId, 'INVALID_VALUE', notStaff);
  assert.equal((await assign(agentId)).statusCode, 200);
  assert.equal(await assignee(), agentId);
  assert.equal((await put(`/admin/users/${agentId}/access`, { roles: ['support'], overrides: [{ permission: 'users.view', effect: 'allow' }] }, admin)).statusCode, 200);
  assert.equal(await assignee(), agentId, 'an access change that keeps support.view keeps the ticket');
  assert.equal((await put(`/admin/users/${agentId}/access`, { roles: ['support'], overrides: [{ permission: 'support.view', effect: 'deny' }] }, admin)).statusCode, 200);
  assert.equal(await assignee(), null, 'support.view taken away');
  assert.equal((await put(`/admin/users/${agentId}/access`, { roles: ['support'], overrides: [] }, admin)).statusCode, 200);
  assert.equal((await assign(agentId)).statusCode, 200);
  assert.equal((await post('/auth/admin/ban-user', { userId: agentId }, admin)).statusCode, 200);
  assert.equal(await assignee(), null, 'banned');
  await post('/auth/admin/unban-user', { userId: agentId }, admin);

  // A ticket that still names someone who left support some other way: the notice goes to the team, never to them.
  assert.equal((await put(`/admin/users/${agentId}/access`, { roles: ['user'], overrides: [] }, admin)).statusCode, 200);
  await pool.query('UPDATE tickets SET assignee_id = $2 WHERE id = $1', [second, agentId]);
  const worker = startNotificationWorker();
  t.after(() => worker.close());
  assert.equal((await reply(second, 'Any news?')).statusCode, 201);
  const got = (id) => pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND event = 'support.customer_message' AND link = $2", [id, `/admin/support/${second}`]).then((r) => r.rowCount);
  assert.ok(await until(() => got(adminId), 30_000), 'the team was told instead');
  assert.equal(await got(agentId), 0, 'the former agent was not');
  assert.equal((await get(`/support/tickets/${second}`, cookieOf(await post('/auth/sign-in/email', { email: 'agent2@example.test', password })))).statusCode, 404);
  await post('/auth/admin/remove-user', { userId: agentId }, admin);
});

test('service logs are read by administrators only, and what a URL carried as a secret is masked in them', async () => {
  await freshLimits();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = process.env.MAINTENANCE_DIR;
  mkdirSync(`${dir}/logs`, { recursive: true });
  writeFileSync(`${dir}/logs/proxy.log`, ['{"request":{"method":"GET","uri":"/api/auth/reset-password/SECRET-RESET-TOKEN?callbackURL=%2Freset-password"},"status":302}',
    '{"request":{"method":"GET","uri":"/api/auth/magic-link/verify?token=SECRET-LINK-TOKEN&callbackURL=%2F"},"status":302}',
    '{"request":{"method":"GET","uri":"/api/auth/callback/google?state=SECRET-STATE&code=SECRET-CODE"},"status":302}', 'an ordinary line'].join('\n'));
  writeFileSync(`${dir}/state.json`, JSON.stringify({ checkedAt: new Date().toISOString(), services: [{ service: 'proxy' }], disks: [] }));
  const read = await get('/admin/host/logs?source=proxy&lines=50', admin);
  assert.equal(read.statusCode, 200, read.body);
  assert.doesNotMatch(read.body, /SECRET-/);
  assert.deepEqual(read.json().lines.map((l) => (l.match(/\[masked\]/g) ?? []).length), [1, 1, 2, 0]);
  assert.equal(read.json().lines[3], 'an ordinary line');
  assert.deepEqual((await get('/admin/host/live', admin)).json().logs, ['proxy']);
  // system.update without being an administrator: the page's other parts, but neither the logs nor their list.
  assert.equal((await post('/admin/roles', { key: 'host-operator', name: 'Host operator', permissions: ['system.view', 'system.update'] }, admin)).statusCode, 201);
  const opId = await newUser('operator@example.test', 'Operator');
  assert.equal((await put(`/admin/users/${opId}/access`, { roles: ['host-operator'], overrides: [] }, admin)).statusCode, 200);
  const op = cookieOf(await post('/auth/sign-in/email', { email: 'operator@example.test', password }));
  const refused = await get('/admin/host/logs?source=proxy', op);
  assert.deepEqual([refused.statusCode, refused.json().code], [403, 'FORBIDDEN']);
  assert.doesNotMatch(refused.body, /SECRET-/);
  const live = await get('/admin/host/live', op);
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json().logs, []);
  await post('/auth/admin/remove-user', { userId: opId }, admin);
  await call('DELETE', '/admin/roles/host-operator', admin);
});

test('the first sign-in by link or e-mail code proves the address: what an earlier holder of the account had is removed, once', async () => {
  await freshLimits();
  const smtp = await fakeSmtp();
  try {
    assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'panel@example.test',
      use: { passwordReset: true, twoFactor: true } }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/sign-in', { magicLink: true }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: true }, admin)).statusCode, 200);
    const state = async (id) => one(`SELECT email_verified AS verified, phone_number AS phone,
      (SELECT count(*)::int FROM auth_accounts a WHERE a.user_id = u.id) AS accounts, (SELECT count(*)::int FROM auth_sessions s WHERE s.user_id = u.id) AS sessions,
      (SELECT count(*)::int FROM api_tokens t WHERE t.user_id = u.id) AS tokens, (SELECT count(*)::int FROM push_subscriptions p WHERE p.user_id = u.id) AS push,
      (SELECT count(*)::int FROM audit_events e WHERE e.actor_id = u.id AND e.action = 'auth.address_proven') AS proofs FROM users u WHERE id = $1`, [id]);
    const withToken = (token) => app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    // How often the person was told that what had been set up before is gone (auth.credentials_reset).
    const told = async (id) => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === 'auth.credentials_reset' && j.data.to?.[0] === id).length;
    // Whoever registered the address first: a password, a session, an API token, a browser subscribed, a phone number.
    const register = async (email) => {
      const r = await post('/auth/sign-up/email', { name: 'First', email, password });
      assert.equal(r.statusCode, 200, r.body);
      const id = r.json().user.id, c = cookieOf(r);
      const made = await post('/account/api-tokens', { name: 'kept by the first holder', scope: 'read' }, c);
      assert.equal(made.statusCode, 201, made.body);
      await pool.query('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)', [id, `https://push.example.test/${id}`, pushKeys.p256dh, pushKeys.auth, 'First-Browser']);
      await pool.query("UPDATE users SET phone_number = $2, phone_number_verified = true WHERE id = $1", [id, `+90555${String(Date.now()).slice(-7)}`]);
      assert.equal((await withToken(made.json().token)).statusCode, 200);
      const before = await state(id);
      assert.deepEqual({ ...before, phone: !!before.phone }, { verified: false, phone: true, accounts: 1, sessions: 1, tokens: 1, push: 1, proofs: 0 });
      return { id, c, token: made.json().token };
    };
    // After the owner's proof: the session it made is the only way in that is left.
    const proven = async (who, email, session, how) => {
      assert.deepEqual(await state(who.id), { verified: true, phone: null, accounts: 0, sessions: 1, tokens: 0, push: 0, proofs: 1 }, how);
      assert.equal((await get('/auth/me', session)).statusCode, 200, `${how}: the session from the proof works`);
      assert.equal((await get('/auth/me', who.c)).statusCode, 401, `${how}: the earlier session is over`);
      assert.equal((await withToken(who.token)).statusCode, 401, `${how}: the earlier API token is refused`);
      const old = await post('/auth/sign-in/email', { email, password });
      assert.equal(old.statusCode, 401, `${how}: the earlier password no longer signs in`);
      assert.equal(cookieOf(old), undefined);
      const row = await one("SELECT metadata FROM audit_events WHERE actor_id = $1 AND action = 'auth.address_proven'", [who.id]);
      assert.deepEqual([row.metadata.removed.apiTokens, row.metadata.removed.pushSubscriptions, row.metadata.removed.phoneNumber], [1, 1, 1], how);
      assert.equal(await told(who.id), 1, `${how}: the person is told once`);
    };
    // What the owner sets up afterwards stays through later sign-ins of the same kind.
    const again = async (who, session, signInAgain, how) => {
      const made = await post('/account/api-tokens', { name: 'the owner\'s own', scope: 'read' }, session);
      assert.equal(made.statusCode, 201, made.body);
      const second = await signInAgain();
      assert.ok(second, `${how}: signs in again`);
      assert.deepEqual(await state(who.id), { verified: true, phone: null, accounts: 0, sessions: 2, tokens: 1, push: 0, proofs: 1 }, `${how}: nothing is removed the second time`);
      assert.equal((await get('/auth/me', session)).statusCode, 200);
      assert.equal((await withToken(made.json().token)).statusCode, 200);
      assert.equal(await told(who.id), 1, `${how}: not told again`);
    };

    // By link.
    const byLink = await register('first-link@example.test');
    const useLink = async () => {
      smtp.mails.length = 0;
      assert.equal((await post('/auth/sign-in/magic-link', { email: 'first-link@example.test', callbackURL: '/' })).statusCode, 200);
      const mail = await until(() => smtp.mails.find((m) => m.includes('first-link@example.test') && m.includes('/magic-link/verify')));
      const link = new URL(/(https?:\/\/\S+magic-link\/verify[^\s"<]+)/.exec(mail)[1]);
      return cookieOf(await app.inject({ method: 'GET', url: link.pathname.replace(/^\/api/, '') + link.search, headers: { host: 'localhost' } }));
    };
    const linkSession = await useLink();
    assert.ok(linkSession, 'the link signed in');
    await proven(byLink, 'first-link@example.test', linkSession, 'link');
    await again(byLink, linkSession, useLink, 'link');

    // By code.
    const byCode = await register('first-code@example.test');
    const useCode = async () => {
      smtp.mails.length = 0;
      assert.equal((await post('/auth/email-otp/send-verification-otp', { email: 'first-code@example.test', type: 'sign-in' })).statusCode, 200);
      const mail = await until(() => smtp.mails.find((m) => m.includes('first-code@example.test') && /^\d{6}$/m.test(m)));
      return cookieOf(await post('/auth/sign-in/email-otp', { email: 'first-code@example.test', otp: /^(\d{6})$/m.exec(mail)[1] }));
    };
    const codeSession = await useCode();
    assert.ok(codeSession, 'the code signed in');
    await proven(byCode, 'first-code@example.test', codeSession, 'code');
    await again(byCode, codeSession, useCode, 'code');

    // Staff marking an address verified by hand is not the owner's proof: nothing is removed, then or later.
    const byStaff = await register('first-staff@example.test');
    assert.equal((await put(`/admin/users/${byStaff.id}/email-verified`, { verified: true }, admin)).statusCode, 200);
    const kept = await state(byStaff.id);
    assert.deepEqual({ ...kept, phone: !!kept.phone }, { verified: true, phone: true, accounts: 1, sessions: 1, tokens: 1, push: 1, proofs: 0 });
    assert.equal((await withToken(byStaff.token)).statusCode, 200);
    assert.equal(await told(byStaff.id), 0);

    // An account nothing was set up on (no password, session, key or phone) loses nothing by the proof: nobody is told.
    const bare = await register('first-bare@example.test');
    for (const table of ['auth_accounts', 'auth_sessions', 'api_tokens', 'push_subscriptions']) await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [bare.id]);
    await pool.query('UPDATE users SET phone_number = NULL, phone_number_verified = false WHERE id = $1', [bare.id]);
    await freshLimits();
    smtp.mails.length = 0;
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'first-bare@example.test', callbackURL: '/' })).statusCode, 200);
    const bareMail = await until(() => smtp.mails.find((m) => m.includes('first-bare@example.test') && m.includes('/magic-link/verify')));
    const bareLink = new URL(/(https?:\/\/\S+magic-link\/verify[^\s"<]+)/.exec(bareMail)[1]);
    assert.ok(cookieOf(await app.inject({ method: 'GET', url: bareLink.pathname.replace(/^\/api/, '') + bareLink.search, headers: { host: 'localhost' } })), 'the link signed in');
    assert.deepEqual(await state(bare.id), { verified: true, phone: null, accounts: 0, sessions: 1, tokens: 0, push: 0, proofs: 1 });
    assert.equal(await told(bare.id), 0);
    for (const p of [byLink, byCode, byStaff, bare]) await post('/auth/admin/remove-user', { userId: p.id }, admin);
  } finally {
    await put('/admin/settings/security', { require2fa: 'none', emailCodeSignIn: false }, admin);
    await put('/admin/settings/sign-in', { magicLink: false }, admin);
    await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
    await smtp.close();
  }
});

test('open consoles and terminals are closed when access shrinks or two-factor is reset', async () => {
  await freshLimits();
  const hashes = [];
  const sub = redis.duplicate();
  await sub.subscribe('console:revoke');
  sub.on('message', (_channel, message) => { hashes.push(JSON.parse(message).authHash); });
  const hashesOf = async (id) => (await pool.query('SELECT token FROM auth_sessions WHERE user_id = $1', [id])).rows.map((r) => createHash('sha256').update(r.token).digest('hex'));
  try {
    // A person's roles change.
    const mine = await hashesOf(staffId);
    assert.ok(mine.length > 0);
    assert.equal((await put(`/admin/users/${staffId}/access`, { roles: ['user'], overrides: [] }, admin)).statusCode, 200);
    // How many times this person's sessions were told to close what they have open.
    const told = () => hashes.filter((h) => mine.includes(h)).length / mine.length;
    assert.ok(await until(() => told() >= 1), 'their sessions were told to close what is open');
    // A role loses a permission: its members.
    assert.equal((await put(`/admin/users/${staffId}/access`, { roles: ['settings-only'], overrides: [] }, admin)).statusCode, 200);
    assert.ok(await until(() => told() >= 2));
    assert.equal((await put('/admin/roles/settings-only', { name: 'Settings only', permissions: ['settings.view', 'settings.manage', 'users.view'] }, admin)).statusCode, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(told(), 2, 'a role that only gains permissions closes nothing');
    assert.equal((await put('/admin/roles/settings-only', { name: 'Settings only', permissions: ['settings.view'] }, admin)).statusCode, 200);
    assert.ok(await until(() => told() >= 3));
    // Two-factor reset by staff ends the sessions without better-auth: what they had open is closed first.
    assert.equal((await call('DELETE', `/admin/users/${staffId}/two-factor`, admin)).statusCode, 204);
    assert.ok(await until(() => told() >= 4));
    assert.equal(await sessionsOf('settings@example.test'), 0);
  } finally { await sub.quit(); }
});

// ---- the re-check of the directory and single sign-on fixes, and what an unproven account leaves behind ----
const dirReader = { dn: 'cn=reader,dc=corp,dc=test', password: 'reader-secret' };

test('naming the directory server needs cover for the accounts behind it; a removed role leaves the mappings; the settings test counts as a guess', async () => {
  await freshLimits();
  const kimDn = 'uid=kim,ou=people,dc=corp,dc=test';
  const dir = await fakeLdap(dirReader, { 'kim@corp.test': { dn: kimDn, name: 'Kim', password: 'kim-directory-pass-1' } });
  // A directory of the settings manager's own: it accepts the password they chose for anybody.
  const rogue = await fakeLdap(dirReader, { 'kim@corp.test': { dn: 'uid=kim,ou=people,dc=evil,dc=test', name: 'Kim', password: 'chosen-by-somebody-else-1' } });
  const ldap = { enabled: true, url: dir.url, bindDn: dirReader.dn, bindPassword: dirReader.password, baseDn: 'dc=corp,dc=test', userFilter: '(&(objectClass=person)(mail={email}))',
    groupRoles: [], defaultRole: 'user', autoCreate: true };
  const oidc = { enabled: false, name: 'SSO', issuer: 'https://idp.example.test', clientId: 'panel', clientSecret: 'secret-1', groupRoles: [], defaultRole: 'user', autoCreate: true };
  const created = [];
  try {
    // Staff who hold the settings permissions and nothing else.
    assert.equal((await post('/admin/roles', { key: 'dir-settings', name: 'Directory settings', permissions: ['settings.view', 'settings.manage'] }, admin)).statusCode, 201);
    const managerId = await newUser('dir-settings@example.test', 'Manager');
    created.push(managerId);
    assert.equal((await put(`/admin/users/${managerId}/access`, { roles: ['dir-settings'], overrides: [] }, admin)).statusCode, 200);
    const manager = cookieOf(await post('/auth/sign-in/email', { email: 'dir-settings@example.test', password }));
    assert.ok(manager);
    assert.equal((await put('/admin/settings/directory', { ldap }, admin)).statusCode, 200);
    // Kim comes from the directory and is made an administrator in the panel. No group is mapped, so the role stays
    // at every later sign-in: the mapping itself (everybody a customer) is one the manager covers.
    assert.equal((await post('/auth/sign-in/email', { email: 'kim@corp.test', password: 'kim-directory-pass-1' })).statusCode, 200);
    const kim = await one("SELECT id, auth_source FROM users WHERE email = 'kim@corp.test'");
    assert.equal(kim.auth_source, 'ldap');
    created.push(kim.id);
    assert.equal((await put(`/admin/users/${kim.id}/access`, { roles: ['admin'], overrides: [] }, admin)).statusCode, 200);
    // Moving the server underneath that account would be a way into it: refused, also for a save that changes nothing.
    const moved = await put('/admin/settings/directory', { ldap: { ...ldap, url: rogue.url } }, manager);
    assert.deepEqual([moved.statusCode, moved.json().code], [403, 'FORBIDDEN_TARGET'], moved.body);
    assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, bindPassword: '' } }, manager)).json().code, 'FORBIDDEN_TARGET');
    assert.equal((await get('/admin/settings/directory', admin)).json().ldap.url, dir.url, 'the server was not moved');
    await freshLimits();
    const asKim = await post('/auth/sign-in/email', { email: 'kim@corp.test', password: 'chosen-by-somebody-else-1' });
    assert.equal(asKim.statusCode, 401);
    assert.equal(cookieOf(asKim), undefined);
    assert.equal(Object.keys(rogue.attempts).length, 0, 'the other directory was never asked');
    // A single permission given to the account on top of the customer role counts the same.
    assert.equal((await put(`/admin/users/${kim.id}/access`, { roles: ['user'], overrides: [{ permission: 'users.manage', effect: 'allow' }] }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, url: rogue.url } }, manager)).json().code, 'FORBIDDEN_TARGET');
    // Only customers behind the server: it is the manager's to save, as before.
    assert.equal((await put(`/admin/users/${kim.id}/access`, { roles: ['user'], overrides: [] }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, bindPassword: '' } }, manager)).statusCode, 200);

    // The same for the single sign-on provider and its accounts.
    const ssoId = await newUser('sso-staff@corp.test', 'Sso');
    created.push(ssoId);
    await pool.query("UPDATE users SET auth_source = 'oidc' WHERE id = $1", [ssoId]);
    assert.equal((await put(`/admin/users/${ssoId}/access`, { roles: ['user'], overrides: [{ permission: 'users.view', effect: 'allow' }] }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/directory/sso', { oidc }, admin)).statusCode, 200);
    const other = await put('/admin/settings/directory/sso', { oidc: { ...oidc, issuer: 'https://rogue.example.test', clientSecret: 'secret-2' } }, manager);
    assert.deepEqual([other.statusCode, other.json().code], [403, 'FORBIDDEN_TARGET'], other.body);
    assert.equal((await get('/admin/settings/directory', admin)).json().oidc.issuer, 'https://idp.example.test');
    assert.equal((await put(`/admin/users/${ssoId}/access`, { roles: ['user'], overrides: [] }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/directory/sso', { oidc: { ...oidc, clientSecret: '' } }, manager)).statusCode, 200);

    // The settings test with somebody's password is a guess at it: the tenth is the last in fifteen minutes, and the
    // sign-in form counts on the same address.
    await freshLimits();
    const binds = () => dir.attempts[kimDn] ?? 0;
    const start = binds();
    const answers = [];
    for (let i = 0; i < 12; i++) answers.push((await post('/admin/settings/directory/test', { ldap: { ...ldap, bindPassword: '' }, email: 'kim@corp.test', password: `wrong-guess-${i}` }, manager)).json().code);
    assert.deepEqual(answers, [...Array(10).fill('LDAP_AUTH_FAILED'), 'RATE_LIMITED', 'RATE_LIMITED']);
    assert.equal(binds() - start, 10, 'two guesses never reached the directory');
    assert.equal((await post('/auth/sign-in/email', { email: 'kim@corp.test', password: 'kim-directory-pass-1' })).json().code, 'RATE_LIMITED');
    // Without a password it is a look-up, not a guess.
    assert.equal((await post('/admin/settings/directory/test', { ldap: { ...ldap, bindPassword: '' }, email: 'kim@corp.test' }, manager)).statusCode, 200);

    // A role that is removed leaves both mappings, so a role made later under its key is not handed out by them.
    assert.equal((await post('/admin/roles', { key: 'tmp-ops', name: 'Ops', permissions: ['support.view'] }, admin)).statusCode, 201);
    assert.equal((await put('/admin/settings/directory', { ldap: { ...ldap, bindPassword: '', groupRoles: [{ group: 'cn=ops', roles: ['tmp-ops'] }, { group: 'cn=mixed', roles: ['tmp-ops', 'user'] }] } }, admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/directory/sso', { oidc: { ...oidc, clientSecret: '', defaultRole: 'tmp-ops' } }, admin)).statusCode, 200);
    assert.equal((await call('DELETE', '/admin/roles/tmp-ops', admin)).statusCode, 204);
    const after = (await get('/admin/settings/directory', admin)).json();
    assert.deepEqual([after.ldap.groupRoles, after.ldap.defaultRole, after.oidc.defaultRole], [[{ group: 'cn=mixed', roles: ['user'] }], 'user', 'user']);
  } finally {
    await put('/admin/settings/directory', { ldap: { enabled: false } }, admin);
    await put('/admin/settings/directory/sso', { oidc: { enabled: false } }, admin);
    for (const id of created) await post('/auth/admin/remove-user', { userId: id }, admin);
    await call('DELETE', '/admin/roles/dir-settings', admin);
    await dir.close(); await rogue.close();
  }
});

test('directory sign-in: an unknown address is asked in one spelling; the session has a fixed length that a two-factor change does not renew', async () => {
  await freshLimits();
  const dir = await fakeLdap(dirReader, {
    'lee@corp.test': { dn: 'uid=lee,ou=people,dc=corp,dc=test', name: 'Lee', password: 'lee-directory-pass-1' },
    'fresh@corp.test': { dn: 'uid=fresh,ou=people,dc=corp,dc=test', name: 'Fresh', password: 'fresh-directory-pass-1' },
  });
  const ldap = { enabled: true, url: dir.url, bindDn: dirReader.dn, bindPassword: dirReader.password, baseDn: 'dc=corp,dc=test', userFilter: '(&(objectClass=person)(mail={email}))',
    groupRoles: [], defaultRole: 'user', autoCreate: true };
  const row = (cookie) => one('SELECT id, created_at, expires_at FROM auth_sessions WHERE token = $1', [tokenOf(cookie)]);
  const age = (cookie, interval) => pool.query(`UPDATE auth_sessions SET created_at = now() - interval '${interval}' WHERE token = $1`, [tokenOf(cookie)]);
  const created = [];
  try {
    assert.equal((await put('/admin/settings/directory', { ldap }, admin)).statusCode, 200);
    // Spellings a directory takes for the same mailbox (an invisible character, a space) would each have a limit of
    // their own: for an address without an account the directory is not asked at all, right password or not.
    const asked = () => Object.values(dir.attempts).reduce((a, b) => a + b, 0);
    const quiet = asked();
    for (const email of ['fresh@corp.test​', 'fresh@corp.test️', '­fresh@corp.test', 'fresh@corp.test ​']) {
      const r = await post('/auth/sign-in/email', { email, password: 'fresh-directory-pass-1' });
      assert.ok(r.statusCode >= 400, `${JSON.stringify(email)} ${r.statusCode}`);
      assert.equal(cookieOf(r), undefined);
    }
    assert.equal(asked(), quiet, 'no search and no bind');
    assert.equal((await one("SELECT count(*)::int AS n FROM users WHERE email LIKE '%fresh@corp.test%'")).n, 0, 'and no account was made');
    // The plain spelling is asked and signs in.
    const fresh = await post('/auth/sign-in/email', { email: 'fresh@corp.test', password: 'fresh-directory-pass-1' });
    assert.equal(fresh.statusCode, 200, fresh.body);
    created.push(fresh.json().user.id);

    // A two-factor change swaps the session for a new one, checked against the cached hash only: the new one is as old
    // as the one it replaces.
    const lee = await post('/auth/sign-in/email', { email: 'lee@corp.test', password: 'lee-directory-pass-1' });
    assert.equal(lee.statusCode, 200, lee.body);
    created.push(lee.json().user.id);
    let c = cookieOf(lee);
    await age(c, '30 minutes');
    const was = await row(c);
    const on = await post('/auth/two-factor/enable', { password: 'lee-directory-pass-1', method: 'otp' }, c);
    assert.equal(on.statusCode, 200, on.body);
    const next = cookieOf(on);
    assert.ok(next && next !== c, 'the change gave a new session');
    assert.equal(await row(c), undefined, 'and ended the old one');
    const now = await row(next);
    assert.ok(Math.abs(now.created_at.getTime() - was.created_at.getTime()) < 1000, `made ${now.created_at.toISOString()}, the one before ${was.created_at.toISOString()}`);
    assert.ok(now.expires_at.getTime() > Date.now());
    c = next;
    assert.equal((await get('/auth/me', c)).statusCode, 200);
    // Longer ago than any session length that can be set: over, although its row has not expired, and removed.
    await age(c, '31 days');
    assert.equal((await get('/auth/me', c)).statusCode, 401);
    assert.equal(await row(c), undefined);
    // A panel account's session of the same age is left to its expiry, as before.
    const plainId = await newUser('plain-age@example.test', 'Plain');
    created.push(plainId);
    const plain = cookieOf(await post('/auth/sign-in/email', { email: 'plain-age@example.test', password }));
    await age(plain, '31 days');
    assert.equal((await get('/auth/me', plain)).statusCode, 200);
    // The directory account signs in again where its password lives.
    await freshLimits();
    assert.equal((await post('/auth/sign-in/email', { email: 'lee@corp.test', password: 'wrong-guess-1' })).statusCode, 401);
  } finally {
    await put('/admin/settings/directory', { ldap: { enabled: false } }, admin);
    for (const id of created) await post('/auth/admin/remove-user', { userId: id }, admin);
    await dir.close();
  }
});

test('a password set through a mailed reset link is the first proof as well: keys, cards, the billing address and a pending second step do not outlive it', async () => {
  await freshLimits();
  const smtp = await fakeSmtp();
  const created = [];
  try {
    assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'panel@example.test',
      use: { passwordReset: true, twoFactor: true } }, admin)).statusCode, 200);
    const state = async (id) => one(`SELECT email_verified AS verified, phone_number AS phone, coalesce(two_factor_enabled, false) AS "twoFactor",
      (SELECT count(*)::int FROM auth_accounts a WHERE a.user_id = u.id AND a.provider_id <> 'credential') AS linked, (SELECT count(*)::int FROM auth_sessions s WHERE s.user_id = u.id) AS sessions,
      (SELECT count(*)::int FROM api_tokens t WHERE t.user_id = u.id) AS tokens, (SELECT count(*)::int FROM ssh_keys k WHERE k.owner_id = u.id) AS keys,
      (SELECT count(*)::int FROM saved_cards c WHERE c.owner_id = u.id) AS cards, (SELECT b.email FROM billing_profiles b WHERE b.user_id = u.id) AS "billingEmail",
      (SELECT count(*)::int FROM audit_events e WHERE e.actor_id = u.id AND e.action = 'auth.address_proven') AS proofs FROM users u WHERE id = $1`, [id]);
    const withToken = (token) => app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    const told = async (id) => (await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === 'auth.credentials_reset' && j.data.to?.[0] === id).length;
    // Whoever registered the address first: a password, a session, an API token, a linked sign-in, a phone number, a
    // saved SSH key, a stored card and their own address for the invoices.
    let n = 0;
    const register = async (email) => {
      const r = await post('/auth/sign-up/email', { name: 'First', email, password });
      assert.equal(r.statusCode, 200, r.body);
      const id = r.json().user.id, c = cookieOf(r);
      created.push(id);
      const made = await post('/account/api-tokens', { name: 'kept by the first holder', scope: 'read' }, c);
      assert.equal(made.statusCode, 201, made.body);
      await pool.query("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'first', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFirstHolderKeyFirstHolderKeyFirstHolderKey00 first@holder', $2)", [id, `SHA256:first-${id}`]);
      await pool.query("INSERT INTO saved_cards (owner_id, provider, token_enc, brand, last4, is_default) VALUES ($1, 'sandbox', 'not-a-real-token', 'visa', '4242', true)", [id]);
      await pool.query("INSERT INTO billing_profiles (user_id, kind, name, tax_id, email, phone) VALUES ($1, 'individual', 'First Holder', '11111111111', 'first-holder@elsewhere.test', '+905550000000')", [id]);
      await pool.query("INSERT INTO auth_accounts (account_id, provider_id, user_id, updated_at) VALUES ($1, 'github', $2, now())", [`gh-${id}`, id]);
      await pool.query('UPDATE users SET phone_number = $2, phone_number_verified = true WHERE id = $1', [id, `+9054400000${String(10 + n++)}`]);
      assert.equal((await withToken(made.json().token)).statusCode, 200);
      const before = await state(id);
      assert.deepEqual({ ...before, phone: !!before.phone }, { verified: false, phone: true, twoFactor: false, linked: 1, sessions: 1, tokens: 1, keys: 1, cards: 1, billingEmail: 'first-holder@elsewhere.test', proofs: 0 });
      return { id, c, token: made.json().token };
    };
    // The owner of the mailbox: "forgot password", the link from the mail, a new password.
    const resetWith = async (email, newPassword) => {
      await freshLimits();
      smtp.mails.length = 0;
      assert.equal((await post('/auth/request-password-reset', { email, redirectTo: '/reset-password' })).statusCode, 200);
      const mail = await until(() => smtp.mails.find((m) => m.includes(email) && m.includes('/reset-password/')));
      assert.ok(mail, 'the reset link was mailed');
      return post('/auth/reset-password', { token: /\/reset-password\/([\w-]+)/.exec(mail)[1], newPassword });
    };

    const first = await register('first-reset@example.test');
    const done = await resetWith('first-reset@example.test', 'the owner chose this one 1');
    assert.equal(done.statusCode, 200, done.body);
    assert.deepEqual(await state(first.id), { verified: true, phone: null, twoFactor: false, linked: 0, sessions: 0, tokens: 0, keys: 0, cards: 0, billingEmail: null, proofs: 1 });
    assert.equal((await get('/auth/me', first.c)).statusCode, 401, 'the earlier session is over');
    assert.equal((await withToken(first.token)).statusCode, 401, 'the earlier API token is refused');
    await freshLimits();
    assert.equal((await post('/auth/sign-in/email', { email: 'first-reset@example.test', password })).statusCode, 401, 'the earlier password no longer signs in');
    const proof = (await one("SELECT metadata FROM audit_events WHERE actor_id = $1 AND action = 'auth.address_proven'", [first.id])).metadata;
    assert.equal(proof.method, 'password-reset');
    assert.deepEqual([proof.removed.apiTokens, proof.removed.sshKeys, proof.removed.savedCards, proof.removed.billingContact, proof.removed.phoneNumber], [1, 1, 1, 1, 1]);
    assert.equal(proof.kept.servers, 0, 'what stays with the account is written down');
    assert.equal(await told(first.id), 1, 'the person is told once');
    // What the owner sets up afterwards stays through a later reset.
    const owner = cookieOf(await post('/auth/sign-in/email', { email: 'first-reset@example.test', password: 'the owner chose this one 1' }));
    assert.ok(owner, 'the new password signs in');
    const own = await post('/account/api-tokens', { name: 'the owner\'s own', scope: 'read' }, owner);
    assert.equal(own.statusCode, 201, own.body);
    assert.equal((await resetWith('first-reset@example.test', 'and later this one 22')).statusCode, 200);
    assert.equal((await withToken(own.json().token)).statusCode, 200, 'nothing is removed the second time');
    const later = await state(first.id);
    assert.deepEqual([later.tokens, later.proofs], [1, 1]);
    assert.equal(await told(first.id), 1, 'not told again');

    // Staff marking the address verified by hand is not the owner's proof, here either: a reset then replaces the
    // password and ends the sessions, and nothing else.
    const marked = await register('marked-reset@example.test');
    assert.equal((await put(`/admin/users/${marked.id}/email-verified`, { verified: true }, admin)).statusCode, 200);
    assert.equal((await resetWith('marked-reset@example.test', 'the owner chose this one 3')).statusCode, 200);
    const kept = await state(marked.id);
    assert.deepEqual([kept.tokens, kept.keys, kept.cards, kept.linked, kept.proofs], [1, 1, 1, 1, 0]);
    assert.equal((await withToken(marked.token)).statusCode, 200);

    // An earlier holder with two-factor on, between the password and the code when the owner proves the address: the
    // step they had open does not end in a session afterwards. The two-factor itself stays for staff to reset.
    const held = await register('held-reset@example.test');
    const enabled = await post('/auth/two-factor/enable', { password }, held.c);
    assert.equal(enabled.statusCode, 200, enabled.body);
    const [backup] = enabled.json().backupCodes;
    await pool.query('UPDATE users SET two_factor_enabled = true WHERE id = $1', [held.id]);
    await freshLimits();
    const step = await post('/auth/sign-in/email', { email: 'held-reset@example.test', password });
    assert.equal(step.json().twoFactorRedirect, true, step.body);
    const jar = [step.headers['set-cookie']].flat().map((v) => v.split(';')[0]).filter((v) => !v.endsWith('=')).join('; ');
    assert.equal((await resetWith('held-reset@example.test', 'the owner chose this one 4')).statusCode, 200);
    await freshLimits();
    const late = await app.inject({ method: 'POST', url: '/auth/two-factor/verify-backup-code', payload: { code: backup }, headers: { ...csrf, cookie: jar } });
    assert.ok(late.statusCode >= 400, `${late.statusCode} ${late.body}`);
    assert.equal(cookieOf(late), undefined);
    assert.equal(await sessionsOf('held-reset@example.test'), 0);
    const after = await state(held.id);
    assert.deepEqual([after.verified, after.twoFactor, after.tokens, after.proofs], [true, true, 0, 1]);
    assert.ok((await one("SELECT metadata FROM audit_events WHERE actor_id = $1 AND action = 'auth.address_proven'", [held.id])).metadata.removed.pendingSignIns >= 1);
  } finally {
    for (const id of created) await post('/auth/admin/remove-user', { userId: id }, admin);
    await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
    await smtp.close();
  }
});

test('accounts nobody could have registered first are proven from the start: the setup administrator and those staff create; a reseller\'s customer is not', async () => {
  await freshLimits();
  const smtp = await fakeSmtp();
  const created = [];
  const verified = async (email) => (await one('SELECT email_verified FROM users WHERE email = $1', [email])).email_verified;
  try {
    assert.equal((await put('/admin/settings/mail', { enabled: true, provider: 'smtp', host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'panel@example.test',
      use: { passwordReset: true, twoFactor: true } }, admin)).statusCode, 200);
    // The administrator made with the bootstrap token, and an account made in Admin → Users.
    assert.equal(await verified('boss@example.test'), true);
    const madeId = await newUser('made-by-staff@example.test', 'Made');
    created.push(madeId);
    assert.equal(await verified('made-by-staff@example.test'), true);
    // What such a person sets up is theirs: the first password reset by mail removes none of it.
    const c = cookieOf(await post('/auth/sign-in/email', { email: 'made-by-staff@example.test', password }));
    const token = await post('/account/api-tokens', { name: 'their own', scope: 'read' }, c);
    assert.equal(token.statusCode, 201, token.body);
    await pool.query("INSERT INTO ssh_keys (owner_id, name, public_key, fingerprint) VALUES ($1, 'own', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnKeyOwnKeyOwnKeyOwnKeyOwnKeyOwnKeyOwnKey000 own@key', 'SHA256:own-key')", [madeId]);
    await freshLimits();
    assert.equal((await post('/auth/request-password-reset', { email: 'made-by-staff@example.test', redirectTo: '/reset-password' })).statusCode, 200);
    const mail = await until(() => smtp.mails.find((m) => m.includes('made-by-staff@example.test') && m.includes('/reset-password/')));
    assert.ok(mail, 'the reset link was mailed');
    assert.equal((await post('/auth/reset-password', { token: /\/reset-password\/([\w-]+)/.exec(mail)[1], newPassword: 'a new one of their own 1' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token.json().token}` } })).statusCode, 200, 'the API token is still theirs');
    const left = await one(`SELECT (SELECT count(*)::int FROM ssh_keys WHERE owner_id = $1) AS keys,
      (SELECT count(*)::int FROM audit_events WHERE actor_id = $1 AND action = 'auth.address_proven') AS proofs`, [madeId]);
    assert.deepEqual(left, { keys: 1, proofs: 0 });
    assert.equal((await notificationQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => j.data.event === 'auth.credentials_reset' && j.data.to?.[0] === madeId).length, 0);

    // A reseller types a customer's address; that is not the customer proving it. Nor is registering it oneself.
    const resellerId = await newUser('reseller-proof@example.test', 'Reseller');
    created.push(resellerId);
    assert.equal((await put(`/admin/resellers/${resellerId}`, {}, admin)).statusCode, 200);
    await freshLimits();
    const reseller = cookieOf(await post('/auth/sign-in/email', { email: 'reseller-proof@example.test', password }));
    const customer = await post('/reseller/customers', { email: 'resold@example.test', name: 'Resold' }, reseller);
    assert.equal(customer.statusCode, 201, customer.body);
    created.unshift(customer.json().id);
    assert.equal(await verified('resold@example.test'), false);
    const self = await post('/auth/sign-up/email', { name: 'Self', email: 'self-proof@example.test', password });
    assert.equal(self.statusCode, 200, self.body);
    created.push(self.json().user.id);
    assert.equal(await verified('self-proof@example.test'), false);
  } finally {
    for (const id of created) await post('/auth/admin/remove-user', { userId: id }, admin);
    await put('/admin/settings/mail', { enabled: false, port: 587, security: 'starttls' }, admin);
    await smtp.close();
  }
});

test('migration 085 marks the accounts staff vouched for before the upgrade as proven, and no other', async () => {
  await freshLimits();
  const created = [];
  const signUp = async (email) => { const r = await post('/auth/sign-up/email', { name: 'Old', email, password }); assert.equal(r.statusCode, 200, r.body); created.push(r.json().user.id); return r.json().user.id; };
  const bossId = (await get('/auth/me', admin)).json().id;
  try {
    const madeId = await newUser('old-made-by-staff@example.test', 'Old'); // a customer staff made in Admin → Users: the audit row says so
    created.push(madeId);
    const supportId = await signUp('old-support@example.test'); // registered, then given a role next to the customer one
    assert.equal((await put(`/admin/users/${supportId}/access`, { roles: ['user', 'support'], overrides: [] }, admin)).statusCode, 200);
    const selfId = await signUp('old-self@example.test');
    const billedId = await signUp('old-billed@example.test'); // stands for one the billing integration made: its audit row is another action
    await pool.query("UPDATE users SET external_source = 'whmcs' WHERE id = $1", [billedId]);
    await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'external.customer_created', 'success', $2)", [bossId, { target: billedId, source: 'whmcs' }]);
    const resellerId = await newUser('old-reseller@example.test', 'Reseller');
    created.push(resellerId);
    assert.equal((await put(`/admin/resellers/${resellerId}`, {}, admin)).statusCode, 200);
    await freshLimits();
    const reseller = cookieOf(await post('/auth/sign-in/email', { email: 'old-reseller@example.test', password }));
    const resold = await post('/reseller/customers', { email: 'old-resold@example.test', name: 'Resold' }, reseller);
    assert.equal(resold.statusCode, 201, resold.body);
    created.unshift(resold.json().id);
    // A row that names an account as its own maker, and one of a refused attempt, vouch for nothing.
    const forgedId = await signUp('old-forged@example.test');
    await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'admin.user.create', 'success', $2), ($3, 'admin.user.create', 'denied', $2)", [forgedId, { target: forgedId }, bossId]);

    const ids = [bossId, staffId, madeId, supportId, selfId, billedId, resold.json().id, forgedId];
    const sql = readFileSync(new URL('../../migrations/085_staff_addresses_proven.sql', import.meta.url), 'utf8');
    const proven = async () => { const { rows } = await pool.query('SELECT id, email_verified FROM users WHERE id = ANY($1::uuid[])', [ids]); return ids.map((id) => rows.find((r) => r.id === id).email_verified); };
    await pool.query('UPDATE users SET email_verified = false WHERE id = ANY($1::uuid[])', [ids]); // as they all were before the upgrade
    await pool.query(sql);
    assert.deepEqual(await proven(), [true, true, true, true, false, false, false, false], 'administrator, custom staff role, made by staff, role next to customer; not: self-registered, billing system, customer of a reseller, self-named row');
    await pool.query(sql);
    assert.deepEqual(await proven(), [true, true, true, true, false, false, false, false], 'a second run changes nothing');
  } finally {
    await pool.query('UPDATE users SET email_verified = true WHERE id = ANY($1::uuid[])', [[bossId, staffId]]);
    for (const id of created) await post('/auth/admin/remove-user', { userId: id }, admin);
  }
});
