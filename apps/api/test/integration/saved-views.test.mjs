// Saved views of the panel's lists against real PostgreSQL and Redis: a person's views are kept with the account,
// per list; nobody sees or changes another person's; at most 12 per list, one name once, one default; staff signed in
// as a user read that person's views and change nothing; the rows go with the account and are in its export.
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
const { notificationQueue } = await import('../../dist/notify.js');

let app, admin, a, aId, b, bId;
const csrf = { 'x-lightning-csrf': '1', origin: 'http://localhost', host: 'localhost' };
const password = 'correct horse battery staple';
const cookieOf = (res) => res.headers['set-cookie']?.toString().match(/lvm.session_token=([^;]+)/)?.[1];
const call = (method, url, cookie, payload) => app.inject({ method, url, payload, headers: { ...csrf, ...(cookie && { cookie: `lvm.session_token=${cookie}` }) } });
const get = (url, cookie) => call('GET', url, cookie);
const post = (url, payload, cookie) => call('POST', url, cookie, payload);
const patch = (url, payload, cookie) => call('PATCH', url, cookie, payload);
const del = (url, cookie) => call('DELETE', url, cookie);
const freshLimits = async () => { for (const k of await redis.keys('rl:*')) await redis.del(k); };
const signUp = async (email) => { await freshLimits(); const r = await post('/auth/sign-up/email', { name: '', email, password }); return [cookieOf(r), r.json().user.id]; };
const views = async (list, cookie) => (await get(`/saved-views?list=${list}`, cookie)).json().views;
const add = (cookie, name, extra = {}) => post('/saved-views', { list: 'servers', name, params: { q: name }, ...extra }, cookie);
const wipe = async () => { await pool.query('DELETE FROM saved_views'); await freshLimits(); };

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
  await call('PUT', '/admin/settings', admin, { registrationOpen: true });
  [a, aId] = await signUp('a@example.test');
  [b, bId] = await signUp('b@example.test');
});
after(async () => { await notificationQueue.close(); await app?.close(); await closeConnections(); });

test('a view is saved, listed, changed and removed; each list has its own', async () => {
  await wipe();
  assert.equal((await get('/saved-views?list=servers')).statusCode, 401);
  assert.equal((await post('/saved-views', { list: 'servers', name: 'x', params: {} })).statusCode, 401);
  assert.deepEqual(await views('servers', a), []);

  const made = await post('/saved-views', { list: 'servers', name: '  Running   web ', params: { q: 'web', state: 'running' } }, a);
  assert.equal(made.statusCode, 201, made.body);
  const view = made.json();
  assert.deepEqual(Object.keys(view).sort(), ['id', 'isDefault', 'name', 'params']);
  assert.deepEqual([view.name, view.params, view.isDefault], ['Running web', { q: 'web', state: 'running' }, false]);
  assert.equal((await post('/saved-views', { list: 'admin-users', name: 'Blocked', params: { status: 'banned' } }, a)).statusCode, 201);
  assert.deepEqual(await views('servers', a), [view]);
  assert.deepEqual((await views('admin-users', a)).map((v) => v.name), ['Blocked']);
  assert.deepEqual(await views('admin-audit', a), []);

  const renamed = await patch(`/saved-views/${view.id}`, { name: 'Web' }, a);
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.deepEqual(renamed.json(), { ...view, name: 'Web' });
  const refiltered = await patch(`/saved-views/${view.id}`, { params: { sort: 'name' } }, a);
  assert.deepEqual(refiltered.json(), { ...view, name: 'Web', params: { sort: 'name' } });
  assert.deepEqual(await views('servers', a), [refiltered.json()]);

  assert.equal((await del(`/saved-views/${view.id}`, a)).statusCode, 204);
  assert.equal((await del(`/saved-views/${view.id}`, a)).statusCode, 404);
  assert.equal((await patch(`/saved-views/${view.id}`, { name: 'Again' }, a)).statusCode, 404);
  assert.deepEqual(await views('servers', a), []);
});

test('what is not a list, a name or one of the parameters of the list is refused, and nothing is stored', async () => {
  await wipe();
  const fields = (r) => { assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().code, 'VALIDATION_FAILED'); return r.json().fields; };
  assert.deepEqual(fields(await get('/saved-views', a)), { list: 'INVALID_VALUE' });
  assert.deepEqual(fields(await get('/saved-views?list=nope', a)), { list: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'nope', name: 'x', params: {} }, a)), { list: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: '   ', params: {} }, a)), { name: 'REQUIRED' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x'.repeat(61), params: {} }, a)), { name: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x', params: { owner: 'b@example.test' } }, a)), { params: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x', params: { q: 'y'.repeat(201) } }, a)), { params: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x', params: { q: 1 } }, a)), { params: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x', params: 'q=1' }, a)), { params: 'INVALID_VALUE' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x' }, a)), { params: 'REQUIRED' });
  assert.deepEqual(fields(await post('/saved-views', { list: 'servers', name: 'x', params: {}, isDefault: 'yes' }, a)), { isDefault: 'INVALID_VALUE' });
  assert.equal((await pool.query('SELECT 1 FROM saved_views')).rowCount, 0);

  const { id } = (await add(a, 'kept')).json();
  // The parameters of a change are those of the view's own list.
  assert.deepEqual(fields(await patch(`/saved-views/${id}`, { params: { role: 'admin' } }, a)), { params: 'INVALID_VALUE' });
  assert.deepEqual(fields(await patch(`/saved-views/${id}`, { name: '' }, a)), { name: 'REQUIRED' });
  assert.deepEqual(fields(await patch(`/saved-views/${id}`, {}, a)), { name: 'REQUIRED' });
  assert.equal((await patch('/saved-views/not-a-uuid', { name: 'x' }, a)).statusCode, 400);
  assert.deepEqual((await views('servers', a)).map((v) => [v.name, v.params]), [['kept', { q: 'kept' }]]);
});

test('a name is used once per person and list, whatever its case or Turkish letter forms', async () => {
  await wipe();
  const first = (await add(a, 'Işıklı Sunucular')).json();
  const again = await add(a, 'isikli SUNUCULAR');
  assert.equal(again.statusCode, 409, again.body);
  assert.deepEqual([again.json().code, again.json().fields], ['VALIDATION_FAILED', { name: 'NAME_TAKEN' }]);
  // The same name in another list, and for another person, is free.
  assert.equal((await post('/saved-views', { list: 'admin-servers', name: 'Işıklı Sunucular', params: {} }, a)).statusCode, 201);
  assert.equal((await add(b, 'Işıklı Sunucular')).statusCode, 201);
  const other = (await add(a, 'Other')).json();
  const clash = await patch(`/saved-views/${other.id}`, { name: 'IŞIKLI sunucular' }, a);
  assert.deepEqual([clash.statusCode, clash.json().fields], [409, { name: 'NAME_TAKEN' }]);
  // Its own name in another case is a rename like any other.
  assert.equal((await patch(`/saved-views/${first.id}`, { name: 'IŞIKLI SUNUCULAR' }, a)).json().name, 'IŞIKLI SUNUCULAR');
  assert.deepEqual((await views('servers', a)).map((v) => v.name), ['IŞIKLI SUNUCULAR', 'Other']);
});

test('nobody sees, changes or removes the view of another person', async () => {
  await wipe();
  const mine = (await add(a, 'customer@example.test')).json();
  assert.deepEqual(await views('servers', b), []);
  assert.deepEqual(await views('servers', admin), []);
  for (const other of [b, admin]) {
    assert.equal((await patch(`/saved-views/${mine.id}`, { name: 'taken over' }, other)).statusCode, 404);
    assert.equal((await patch(`/saved-views/${mine.id}`, { isDefault: true }, other)).statusCode, 404);
    assert.equal((await del(`/saved-views/${mine.id}`, other)).statusCode, 404);
  }
  assert.equal((await patch(`/saved-views/${randomUUID()}`, { name: 'x' }, a)).statusCode, 404);
  assert.deepEqual(await views('servers', a), [mine]);
  // A default of one person leaves the other's alone.
  const theirs = (await add(b, 'theirs', { isDefault: true })).json();
  assert.equal(theirs.isDefault, true);
  await patch(`/saved-views/${mine.id}`, { isDefault: true }, a);
  assert.deepEqual(await views('servers', b), [theirs]);
});

test('at most 12 views per person and list, also when they arrive together', async () => {
  await wipe();
  for (let i = 0; i < 12; i++) assert.equal((await add(a, `view ${i}`)).statusCode, 201);
  const over = await add(a, 'one more');
  assert.deepEqual([over.statusCode, over.json().code], [409, 'LIMIT_REACHED']);
  // Another list and another person have their own room; a full list can still be changed.
  assert.equal((await post('/saved-views', { list: 'admin-users', name: 'one more', params: {} }, a)).statusCode, 201);
  assert.equal((await add(b, 'one more')).statusCode, 201);
  const [first] = await views('servers', a);
  assert.equal((await patch(`/saved-views/${first.id}`, { name: 'renamed', isDefault: true }, a)).statusCode, 200);
  assert.equal((await del(`/saved-views/${first.id}`, a)).statusCode, 204);
  const together = await Promise.all(Array.from({ length: 6 }, (_, i) => add(a, `together ${i}`)));
  assert.deepEqual(together.map((r) => r.statusCode).sort(), [201, 409, 409, 409, 409, 409], together.map((r) => r.body).join(' '));
  assert.equal((await views('servers', a)).length, 12);
});

test('a list has one default: marking one takes the mark from the other', async () => {
  await wipe();
  const defaults = async () => (await views('servers', a)).filter((v) => v.isDefault).map((v) => v.name);
  const one = (await add(a, 'one', { isDefault: true })).json();
  assert.equal(one.isDefault, true);
  const two = (await add(a, 'two', { isDefault: true })).json();
  assert.deepEqual(await defaults(), ['two']);
  const three = (await add(a, 'three')).json();
  assert.deepEqual(await defaults(), ['two']);
  assert.equal((await patch(`/saved-views/${one.id}`, { isDefault: true }, a)).json().isDefault, true);
  assert.deepEqual(await defaults(), ['one']);
  // Marking the default again changes nothing; another list keeps its own default.
  await patch(`/saved-views/${one.id}`, { isDefault: true }, a);
  assert.equal((await post('/saved-views', { list: 'admin-users', name: 'u', params: {}, isDefault: true }, a)).statusCode, 201);
  assert.deepEqual(await defaults(), ['one']);
  assert.equal((await views('admin-users', a))[0].isDefault, true);
  // Several at once: still exactly one.
  const marks = await Promise.all([one, two, three].map((v) => patch(`/saved-views/${v.id}`, { isDefault: true }, a)));
  assert.deepEqual(marks.map((r) => r.statusCode), [200, 200, 200], marks.map((r) => r.body).join(' '));
  assert.equal((await defaults()).length, 1);
  // A rename keeps the mark; no default at all is fine too.
  const [current] = (await views('servers', a)).filter((v) => v.isDefault);
  assert.equal((await patch(`/saved-views/${current.id}`, { name: 'still default' }, a)).json().isDefault, true);
  assert.equal((await patch(`/saved-views/${current.id}`, { isDefault: false }, a)).json().isDefault, false);
  assert.deepEqual(await defaults(), []);
});

test('staff signed in as a user read the views of that person and change nothing', async () => {
  await wipe();
  const mine = (await add(a, 'mine')).json();
  await add(admin, 'staff only');
  const acting = await post('/auth/admin/impersonate-user', { userId: aId }, admin);
  assert.equal(acting.statusCode, 200, acting.body);
  const as = cookieOf(acting);
  assert.deepEqual(await views('servers', as), [mine]);
  for (const r of [await add(as, 'left behind'), await patch(`/saved-views/${mine.id}`, { name: 'changed' }, as), await del(`/saved-views/${mine.id}`, as)]) {
    assert.deepEqual([r.statusCode, r.json().code], [403, 'NOT_WHILE_IMPERSONATING']);
  }
  assert.deepEqual(await views('servers', a), [mine]);
  assert.deepEqual((await views('servers', admin)).map((v) => v.name), ['staff only']);
});

test('writes are limited per person; reading is not', async () => {
  await wipe();
  await redis.set(`rl:saved-views:${bId}`, 120, 'EX', 600);
  const r = await add(b, 'too many');
  assert.deepEqual([r.statusCode, r.json().code], [429, 'RATE_LIMITED']);
  assert.equal((await get('/saved-views?list=servers', b)).statusCode, 200);
  assert.equal((await add(a, 'fine')).statusCode, 201);
});

test('the views are in the export of the account and go with the account', async () => {
  await wipe();
  await add(b, 'exported', { isDefault: true });
  const file = await get('/account/export', b);
  assert.equal(file.statusCode, 200, file.body);
  const { savedViews } = JSON.parse(file.body);
  assert.deepEqual(savedViews.map((v) => [v.list, v.name, v.params, v.isDefault]), [['servers', 'exported', { q: 'exported' }, true]]);
  assert.equal(JSON.parse((await get('/account/export', a)).body).savedViews.length, 0);
  // The rows are the account's: removing the user removes them (ON DELETE CASCADE).
  const { rows: [gone] } = await pool.query("INSERT INTO users (email, role, locale) VALUES ('gone@example.test', 'user', 'en') RETURNING id");
  await pool.query("INSERT INTO saved_views (user_id, list, name, name_key, params) VALUES ($1, 'servers', 'x', 'x', '{}')", [gone.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [gone.id]);
  assert.equal((await pool.query('SELECT 1 FROM saved_views WHERE user_id = $1', [gone.id])).rowCount, 0);
});
