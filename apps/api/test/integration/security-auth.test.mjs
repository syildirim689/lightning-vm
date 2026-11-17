// Sign-in and settings hardening, against a real PostgreSQL and Redis (destructive, like the other files here: it
// wipes the test database and Redis DB). What is checked: only the auth routes the panel uses answer; directory and
// single sign-on accounts get a session nowhere but from their directory or provider; captcha and the per-address
// limit come before the directory; role mappings stay within the saver's own permissions; identifiers are bounded;
// mailed links carry the panel's address; staff acting as someone leave nothing lasting; push endpoints are public
// and owned; settings tests hand back no remote text and stored secrets do not follow a changed address.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as tcp } from 'node:net';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
// No host agent here: the panel's address then comes from the setup wizard's setting (public_url).
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
process.env.MAINTENANCE_DIR = mkdtempSync(tmpdir() + '/lvm-maint-');

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');

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
  assert.equal((await redis.keys('rl:login:*')).filter((k) => k.length > 300).length, 0, 'no limiter key was made of it');
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
    // An account with two-factor: neither asking for a link nor an older link signs it in.
    await pool.query('UPDATE users SET two_factor_enabled = true WHERE id = $1', [linkId]);
    assert.equal((await post('/auth/sign-in/magic-link', { email: 'link@example.test', callbackURL: '/' })).json().code, 'TWO_FACTOR_USE_PASSWORD');
    const mailed = new URL(/(https?:\/\/\S+magic-link\/verify[^\s"<]+)/.exec(local)[1]);
    const used = await app.inject({ method: 'GET', url: mailed.pathname.replace(/^\/api/, '') + mailed.search, headers: { host: 'localhost' } });
    assert.equal(cookieOf(used), undefined, 'the link mailed before two-factor was turned on does not sign in');
    assert.equal(await sessionsOf('link@example.test'), 0);
    await post('/auth/admin/remove-user', { userId: linkId }, admin);
  } finally {
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

test('push subscriptions: a public HTTPS endpoint, owned by who subscribed it, gone when the sessions are ended', async () => {
  await freshLimits();
  for (const endpoint of ['https://127.0.0.1/push/abcdef123456', 'https://10.0.0.5/push/abcdef123456', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/push/abcdef123456',
    'https://[::ffff:10.0.0.1]/push/abcdef', 'https://localhost/push/abcdef123456', 'http://93.184.216.34/push/abcdef123456', 'https://user:pw@93.184.216.34/push/abcdef']) {
    const r = await post('/notifications/push-subscriptions', { endpoint, keys: pushKeys }, user);
    assert.deepEqual([r.statusCode, r.json().fields?.endpoint], [400, 'INVALID_VALUE'], endpoint);
  }
  const endpoint = 'https://93.184.216.34/push/abcdef123456';
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
    const sent = await post('/admin/settings/sms/test', { ...custom(answering.port), to: '+905321234567' }, staff);
    assert.equal(sent.statusCode, 200, sent.body);
    assert.doesNotMatch(sent.body, new RegExp(marker));
    const rejected = await post('/admin/settings/sms/test', { ...custom(failing.port), to: '+905321234567' }, staff);
    assert.deepEqual([rejected.statusCode, rejected.json().code, rejected.json().detail], [422, 'SMS_REJECTED', 'HTTP 5xx']);
    assert.doesNotMatch(rejected.body, new RegExp(marker));
    const closed = await post('/admin/settings/sms/test', { ...custom(1), to: '+905321234567' }, staff);
    assert.deepEqual([closed.statusCode, closed.json().code, closed.json().detail], [422, 'SMS_PROVIDER_UNREACHABLE', undefined]);
    // Its secret headers are for the server they were entered for.
    assert.equal((await put('/admin/settings/sms', custom(answering.port, { headers: '{"x-api-key":"s3cret"}' }), admin)).statusCode, 200);
    assert.equal((await put('/admin/settings/sms', custom(answering.port), staff)).statusCode, 200, 'same server: kept');
    const elsewhere = await post('/admin/settings/sms/test', { ...custom(failing.port), to: '+905321234567' }, staff);
    assert.deepEqual([elsewhere.statusCode, elsewhere.json().fields?.['credentials.headers']], [400, 'REQUIRED']);
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
