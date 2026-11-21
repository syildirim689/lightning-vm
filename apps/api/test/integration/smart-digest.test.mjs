// The periodic digest against real PostgreSQL and Redis: off unless turned on (customers only once the administrator
// has turned the event on, and then by their own choice); the next one is due when the person's own clock passes the
// chosen hour; each period is worked out exactly once however many copies run at the same moment; staff get the
// panel's digest with only what they may see, a customer their own account and never another's; the next digest says
// what opened and closed; one with nothing to say is not sent; the preview goes out now without counting as a
// period; and the notification consumer delivers it through the channels the person chose.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL ?? '';
if (!/\/\w+_test(\?|$)/.test(url) || process.env.REDIS_DB !== '15') {
  console.error('Set TEST_DATABASE_URL to a database named *_test and REDIS_DB=15.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { createApp, closeConnections } = await import('../../dist/main.js');
const { pool, redis } = await import('../../dist/db.js');
const { issueBootstrapToken } = await import('../../dist/setup.js');
const { runMigrations } = await import('../../dist/migrate.js');
const { notificationQueue, startNotificationWorker, catalog, policies, notify } = await import('../../dist/notify.js');
const { encryptSecret } = await import('../../dist/secrets.js');
const { runDigests } = await import('../../dist/periodic-digest.js');
const { nextSlot } = await import('../../dist/digest-rules.js');
const { seedSite } = await import('./seed-history.mjs');

let app, admin, adminId, viewer, viewerId, a, aId, b, bId, c, cId, site, worker, broken;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, path, cookie, payload) => app.inject({ method, url: path, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (path, cookie) => call('GET', path, cookie);
const put = (path, payload, cookie) => call('PUT', path, cookie, payload);
const post = (path, payload, cookie) => call('POST', path, cookie, payload);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); assert.equal(r.statusCode, 200, r.body); return [cookieOf(r), r.json().user.id]; };
const server = async (ownerId, name, extra = {}) => {
  const cols = { owner_id: ownerId, pool_id: site.pool, image_id: site.image, name, vcpu: 2, memory_mb: 2048, disk_gb: 20, price_monthly: '80.00', currency: 'TRY', state: 'ready', power_state: 'poweredOn', vm_moref: `vm-${name}`, ...extra };
  const names = Object.keys(cols);
  return (await one(`INSERT INTO servers (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).id;
};
const staff = async (email, permissions) => {
  const key = `digest-${email.split('@')[0]}`;
  assert.equal((await post('/admin/roles', { key, name: key, permissions }, admin)).statusCode, 201);
  const id = (await post('/auth/admin/create-user', { email, password, name: key, role: 'user' }, admin)).json().user.id;
  assert.equal((await put(`/admin/users/${id}/access`, { roles: [key], overrides: [] }, admin)).statusCode, 200);
  return [cookieOf(await post('/auth/sign-in/email', { email, password })), id];
};
// The digests queued for one person (the consumer is not running unless a test starts it), oldest first.
const queued = async (userId) => (await notificationQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']))
  .filter((j) => (j.data?.event === 'admin.digest' || j.data?.event === 'account.digest') && j.data.to?.[0] === userId).sort((x, y) => x.timestamp - y.timestamp)
  .map((j) => ({ event: j.data.event, preview: j.data.data.preview === '1', digest: JSON.parse(j.data.data.payload) }));
const row = (userId) => one('SELECT enabled, frequency, day, hour, timezone, next_at, last_run_at, last_sent_at, seen FROM digest_preferences WHERE user_id = $1', [userId]);
// Makes everyone's digest due at `now`.
const due = (now, ids) => pool.query('UPDATE digest_preferences SET next_at = $1 WHERE user_id = ANY($2::uuid[])', [new Date(now.getTime() - 60_000), ids]);
const on = { enabled: true, frequency: 'weekly', day: 1, hour: 8, timezone: 'Europe/Istanbul' };

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
  adminId = (await get('/auth/me', admin)).json().id;
  await put('/admin/settings', { registrationOpen: true }, admin);
  [a, aId] = await signUp('a@example.test');
  [b, bId] = await signUp('b@example.test');
  [c, cId] = await signUp('c@example.test');
  [viewer, viewerId] = await staff('viewer@example.test', ['dashboard.view']);
  site = await seedSite(pool, encryptSecret, { name: 'digest' });
  broken = await server(aId, 'a-broken', { state: 'error' });
  await server(aId, 'a-web');
  await server(bId, 'b-secret', { state: 'error' });
});
after(async () => { await worker?.close(); await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('off unless turned on: staff by their own choice, customers only once the administrator has turned the event on', async () => {
  assert.equal((await get('/account/digest')).statusCode, 401);
  assert.deepEqual([catalog['account.digest'].off, (await policies())['account.digest'].enabled, (await policies())['admin.digest'].enabled], [true, false, true]);
  const mine = (await get('/account/digest', admin)).json();
  assert.deepEqual(mine, { kind: 'staff', event: 'admin.digest', available: true, enabled: false, frequency: 'weekly', day: 1, hour: 8, timezone: null, nextAt: null, lastSentAt: null, channels: ['email'], reach: [] });
  const theirs = (await get('/account/digest', a)).json();
  assert.deepEqual([theirs.kind, theirs.event, theirs.available, theirs.enabled], ['customer', 'account.digest', false, false]);
  // The event is not among a customer's notifications either, until it is turned on.
  assert.equal((await get('/notifications/preferences', a)).json().events.some((e) => e.event.endsWith('.digest')), false);
  assert.equal((await get('/notifications/preferences', admin)).json().events.some((e) => e.event === 'admin.digest'), true);
  const refused = await put('/account/digest', on, a);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'DIGEST_NOT_AVAILABLE']);
  assert.equal((await post('/account/digest/preview', {}, a)).statusCode, 409);
  assert.equal(await row(aId), undefined);
  // Nobody has one: a run finds nothing due.
  assert.deepEqual(await runDigests(), { due: 0, sent: 0, empty: 0, skipped: 0, failed: 0 });

  // What is sent is checked field by field.
  for (const [body, fields] of [[{ ...on, enabled: 'yes' }, { enabled: 'INVALID_VALUE' }], [{ ...on, frequency: 'hourly' }, { frequency: 'INVALID_VALUE' }], [{ ...on, day: 8 }, { day: 'INVALID_VALUE' }],
    [{ ...on, hour: 24 }, { hour: 'INVALID_VALUE' }], [{ ...on, timezone: 'Mars/Olympus' }, { timezone: 'INVALID_VALUE' }], [{ enabled: true }, { timezone: 'INVALID_VALUE' }]]) {
    const r = await put('/account/digest', body, admin);
    assert.deepEqual([r.statusCode, r.json().fields], [400, fields], JSON.stringify(body));
  }
  assert.equal(await row(adminId), undefined);
});

test('turned on: the next digest is due when the person\'s own clock passes the hour; the choice is recorded', async () => {
  const t0 = Date.now();
  const saved = await put('/account/digest', on, admin);
  assert.equal(saved.statusCode, 200, saved.body);
  const s = saved.json();
  assert.deepEqual([s.enabled, s.frequency, s.day, s.hour, s.timezone], [true, 'weekly', 1, 8, 'Europe/Istanbul']);
  // Monday 08:00 in Istanbul is 05:00 UTC, within the coming week.
  const next = new Date(s.nextAt);
  assert.deepEqual([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()], [1, 5, 0]);
  assert.ok(next.getTime() > t0 && next.getTime() - t0 <= 7 * 86_400_000 + 60_000);
  assert.equal(next.getTime(), nextSlot(on, next.getTime() - 60_000));
  const { rows: [audit] } = await pool.query("SELECT actor_id, metadata FROM audit_events WHERE action = 'account.digest' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([audit.actor_id, audit.metadata.enabled, audit.metadata.day, audit.metadata.timezone], [adminId, true, 1, 'Europe/Istanbul']);
  // Daily: within a day. Off: nothing is due any more.
  const daily = (await put('/account/digest', { ...on, frequency: 'daily', hour: 23 }, admin)).json();
  assert.ok(new Date(daily.nextAt).getTime() - Date.now() <= 86_400_000);
  const off = (await put('/account/digest', { ...on, enabled: false }, admin)).json();
  assert.deepEqual([off.enabled, off.nextAt, (await row(adminId)).next_at], [false, null, null]);
  await due(new Date(), [adminId]);
  assert.equal((await runDigests()).due, 0, 'a digest that is off is never due');

  // The administrator turns the customers' digest on; a customer may then turn their own on.
  assert.equal((await put('/admin/settings/notifications', { event: 'account.digest', enabled: true, allowed: ['inApp', 'email', 'chat'], defaults: ['inApp'], userCanChange: true }, a)).statusCode, 403);
  assert.equal((await put('/admin/settings/notifications', { event: 'account.digest', enabled: true, allowed: ['inApp', 'email', 'chat'], defaults: ['inApp'], userCanChange: true }, admin)).statusCode, 200);
  assert.deepEqual([(await get('/account/digest', a)).json().available, (await get('/account/digest', a)).json().channels, (await get('/account/digest', a)).json().reach], [true, ['inApp'], ['inApp']]);
  assert.equal((await get('/notifications/preferences', a)).json().events.some((e) => e.event === 'account.digest'), true);
  for (const who of [admin, viewer, a, c]) assert.equal((await put('/account/digest', on, who)).statusCode, 200);
  assert.equal((await row(bId)), undefined, 'b did not turn it on');
});

test('exactly once per period, however many copies run at the same moment', async () => {
  await pool.query(`INSERT INTO operations (kind, status, idempotency_key, request_hash, server_id, owner_id, step, deadline_at, created_at, finished_at, error_code)
    VALUES ('power_on', 'failed', $1, 'x', $2, $3, 'done', now(), now() - interval '1 hour', now(), 'PROVIDER_ERROR')`, [randomUUID(), broken, aId]);
  const now = new Date();
  await due(now, [adminId, viewerId, aId, cId]);
  const runs = await Promise.all([runDigests(now), runDigests(now), runDigests(now), runDigests(now)]);
  const total = (k) => runs.reduce((n, r) => n + r[k], 0);
  assert.deepEqual([total('due'), total('sent'), total('failed'), total('skipped')], [4, 4, 0, 0], JSON.stringify(runs));
  for (const id of [adminId, viewerId, aId, cId]) {
    assert.equal((await queued(id)).length, 1, 'one digest each');
    const r = await row(id);
    assert.ok(new Date(r.next_at) > now, 'the next one is due later');
    assert.equal(new Date(r.next_at).getTime(), nextSlot(on, now.getTime()));
    assert.deepEqual([new Date(r.last_run_at).getTime(), new Date(r.last_sent_at).getTime()], [now.getTime(), now.getTime()]);
  }
  assert.equal((await queued(bId)).length, 0);
  // The same moment again, and five minutes later: nothing is due.
  assert.equal((await runDigests(now)).due, 0);
  assert.equal((await runDigests(new Date(now.getTime() + 300_000))).due, 0);
});

test('staff get the panel\'s digest with only what they may see; a customer their own account and nobody else\'s', async () => {
  const [boss] = await queued(adminId);
  assert.deepEqual([boss.event, boss.preview, boss.digest.kind, boss.digest.first], ['admin.digest', false, 'staff', true]);
  const codes = boss.digest.findings.map((f) => f.code);
  for (const code of ['BACKUP_NEVER', 'MAIL_NOT_CONFIGURED', 'WORKER_DOWN']) assert.ok(codes.includes(code), `${code} in ${codes}`);
  assert.deepEqual([boss.digest.opened, boss.digest.closed], [[], []], 'the first digest compares with nothing');
  assert.deepEqual(boss.digest.risk, { accounts: 0, top: [] });
  assert.equal(boss.digest.failedOperations, 1);
  assert.ok(Date.now() - Date.parse(boss.digest.since) > 6.9 * 86_400_000, 'the first weekly digest looks a week back');
  // dashboard.view alone: no payment figures, and no finding about an area the person cannot open.
  const [limited] = await queued(viewerId);
  assert.equal(limited.digest.risk, null);
  assert.ok(!limited.digest.findings.some((f) => ['MAIL_NOT_CONFIGURED', 'PAYMENT_RISK', 'PAYMENTS_IN_REVIEW', 'USAGE_ANOMALIES'].includes(f.code)), JSON.stringify(limited.digest.findings.map((f) => f.code)));
  assert.ok(limited.digest.findings.some((f) => f.code === 'BACKUP_NEVER'));

  const [mine] = await queued(aId);
  assert.deepEqual([mine.event, mine.digest.kind, mine.digest.first], ['account.digest', 'customer', true]);
  assert.deepEqual(mine.digest.findings.filter((f) => f.code === 'SERVER_PROBLEM').map((f) => [f.key, f.params.name, f.severity]), [[`srv:${broken}`, 'a-broken', 'danger']]);
  assert.deepEqual(mine.digest.forecast.map((f) => [f.currency, Number(f.forecast) > 0, f.budget]), [['TRY', true, null]]);
  assert.equal(mine.digest.renewal, null, 'billing is off: no renewal');
  assert.doesNotMatch(JSON.stringify(mine.digest), /b-secret|b@example/, 'nothing of another customer');
  // The words, as the consumer will write them.
  const text = catalog['account.digest'].text.en({ payload: JSON.stringify(mine.digest), preview: '' });
  assert.match(text.title, /^Your account digest: \d+ open findings$/);
  assert.match(text.body, /\(!\) a-broken: the server has a problem/);
  assert.match(text.body, /This month: \d+\.\d\d TRY so far, \d+\.\d\d TRY forecast by month end/);
  assert.match(catalog['account.digest'].text.tr({ payload: JSON.stringify(mine.digest), preview: '' }).title, /^Hesap özetiniz: \d+ açık bulgu$/);
  assert.deepEqual(catalog['admin.digest'].text.en({ payload: 'not json' }), { title: 'Digest', body: '' });
});

test('the next digest says what opened and closed; hiding a finding does not close it', async () => {
  // The broken server is repaired, another one breaks, and the customer hides the note about two-factor.
  await pool.query("UPDATE servers SET state = 'ready' WHERE id = $1", [broken]);
  const other = await server(aId, 'a-db', { state: 'missing' });
  assert.equal((await put('/insights/dismissals', { key: '2fa', days: null }, a)).statusCode, 204);
  const now = new Date(Date.now() + 1000);
  await due(now, [aId]);
  assert.deepEqual(await runDigests(now), { due: 1, sent: 1, empty: 0, skipped: 0, failed: 0 });
  const [, second] = await queued(aId);
  assert.equal(second.digest.first, false);
  assert.deepEqual(second.digest.opened.map((f) => [f.code, f.key]), [['SERVER_PROBLEM', `srv:${other}`]]);
  assert.deepEqual(second.digest.closed.map((f) => [f.code, f.key, f.params.name]), [['SERVER_PROBLEM', `srv:${broken}`, 'a-broken']]);
  assert.ok(!second.digest.findings.some((f) => f.key === '2fa'), 'hidden: not listed');
  assert.ok(!second.digest.closed.some((f) => f.key === '2fa'), 'hidden is not closed');
  assert.ok(Math.abs(Date.parse(second.digest.since) - new Date((await queued(aId))[0].digest.since).getTime()) > 0);
  const text = catalog['account.digest'].text.en({ payload: JSON.stringify(second.digest), preview: '' }).body;
  assert.match(text, /Opened since the last digest: 1\n\+ a-db: the server has a problem\nClosed since the last digest: 1\n✓ a-broken: the server has a problem/);
});

test('a digest with nothing to say is not sent, and the period still passes', async () => {
  // c has no servers: after the first digest listed the standing notes, nothing is news.
  const now = new Date(Date.now() + 2000);
  await due(now, [cId]);
  assert.deepEqual(await runDigests(now), { due: 1, sent: 0, empty: 1, skipped: 0, failed: 0 });
  assert.equal((await queued(cId)).length, 1, 'only the first one');
  const r = await row(cId);
  assert.ok(new Date(r.next_at) > now);
  assert.equal(new Date(r.last_run_at).getTime(), now.getTime());
  assert.ok(new Date(r.last_sent_at) < now, 'the last one sent is still the first');
  // The preview says the same instead of sending.
  const p = await post('/account/digest/preview', {}, c);
  assert.deepEqual([p.statusCode, p.json().sent, p.json().empty], [200, false, true]);
  assert.equal((await queued(cId)).length, 1);
});

test('the preview goes out now, marked as one, and does not count as a period; five an hour', async () => {
  await freshLimits();
  const before = await row(adminId);
  // E-mail is the default, and no mail server is set up here: the words come back, and the answer says nothing went out.
  const unsent = await post('/account/digest/preview', {}, admin);
  assert.deepEqual([unsent.statusCode, unsent.json().sent, unsent.json().empty, unsent.json().channels], [200, false, false, []]);
  assert.equal((await queued(adminId)).length, 1);
  assert.equal((await put('/notifications/preferences', { event: 'admin.digest', channels: ['inApp', 'email'] }, admin)).statusCode, 200);
  const p = await post('/account/digest/preview', {}, admin);
  assert.equal(p.statusCode, 200, p.body);
  assert.deepEqual([p.json().sent, p.json().empty, p.json().channels], [true, false, ['inApp']]);
  assert.match(p.json().title, /^Preview: Panel digest: \d+ open findings$/);
  assert.match(p.json().body, /^Since \d{4}-\d\d-\d\d\.\nOpen findings: /);
  const jobs = await queued(adminId);
  assert.deepEqual(jobs.map((j) => j.preview), [false, true]);
  const afterwards = await row(adminId);
  assert.deepEqual([afterwards.next_at, afterwards.last_run_at, afterwards.last_sent_at, afterwards.seen], [before.next_at, before.last_run_at, before.last_sent_at, before.seen]);
  // No channel chosen: the words come back, nothing is queued.
  assert.equal((await put('/notifications/preferences', { event: 'admin.digest', channels: [] }, admin)).statusCode, 200);
  const silent = await post('/account/digest/preview', {}, admin);
  assert.deepEqual([silent.json().sent, silent.json().empty, silent.json().channels], [false, false, []]);
  assert.equal((await queued(adminId)).length, 2);
  for (let i = 0; i < 2; i++) assert.equal((await post('/account/digest/preview', {}, admin)).statusCode, 200);
  assert.equal((await post('/account/digest/preview', {}, admin)).statusCode, 429);
  assert.equal((await post('/account/digest/preview', {})).statusCode, 401);
});

test('delivery is the notification consumer\'s: the channels the person chose, nothing where none is chosen or the event is off', async () => {
  for (const j of await notificationQueue.getJobs(['waiting', 'delayed'])) await j.remove();
  worker = startNotificationWorker();
  // The administrator chose no channel above; the viewer chooses the inbox; a keeps the policy's default (the inbox).
  assert.equal((await put('/notifications/preferences', { event: 'admin.digest', channels: ['inApp'] }, viewer)).statusCode, 200);
  const now = new Date(Date.now() + 3000);
  await pool.query("UPDATE servers SET state = 'error' WHERE id = $1", [broken]);
  await due(now, [adminId, viewerId, aId]);
  const run = await runDigests(now);
  assert.deepEqual([run.due, run.sent], [3, 3]);
  const inbox = (id) => pool.query("SELECT event, title, body, link, texts FROM notifications WHERE user_id = $1 AND event LIKE '%.digest' ORDER BY created_at", [id]).then((r) => r.rows);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && ((await inbox(viewerId)).length < 1 || (await inbox(aId)).length < 1)) await new Promise((r) => setTimeout(r, 200));
  const [v] = await inbox(viewerId);
  assert.deepEqual([v.event, v.link], ['admin.digest', '/admin']);
  assert.match(v.title, /^Panel digest: \d+ open findings$/);
  assert.match(v.texts.tr.title, /^Panel özeti: \d+ açık bulgu$/);
  const [m] = await inbox(aId);
  assert.deepEqual([m.event, m.link], ['account.digest', '/']);
  assert.match(m.body, /a-broken: the server has a problem/);
  assert.deepEqual(await inbox(adminId), [], 'no channel chosen: nothing delivered');
  // A staff digest addressed to someone who may not see the dashboard (the permission went between the run and the
  // delivery) goes to nobody: other staff notices fall back to the team, a person's own digest does not.
  await notify('admin.digest', [bId], { payload: JSON.stringify((await queued(viewerId)).at(-1)?.digest ?? {}), preview: '' });
  await new Promise((r) => setTimeout(r, 2000));
  assert.deepEqual([(await inbox(bId)).length, (await inbox(viewerId)).length, (await inbox(adminId)).length], [0, 1, 0]);

  // The administrator turns the customers' digest off again: the period passes without one.
  assert.equal((await put('/admin/settings/notifications', { event: 'account.digest', enabled: false, allowed: ['inApp', 'email', 'chat'], defaults: ['inApp'], userCanChange: true }, admin)).statusCode, 200);
  const later = new Date(Date.now() + 4000);
  await due(later, [aId]);
  assert.deepEqual(await runDigests(later), { due: 1, sent: 0, empty: 0, skipped: 1, failed: 0 });
  assert.deepEqual([(await get('/account/digest', a)).json().available, (await get('/account/digest', a)).json().enabled], [false, false]);
  // A banned account is not written to at all.
  await pool.query('UPDATE users SET banned = true WHERE id = $1', [viewerId]);
  await due(later, [viewerId]);
  assert.equal((await runDigests(later)).due, 0);
});
