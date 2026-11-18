// Saved views: what a name, a list and its parameters may be (the database rules are in test/integration).
process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/none';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.BETTER_AUTH_SECRET = 'unit-test-only-better-auth-secret-0123456789';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { closeConnections } = await import('../dist/db.js');
const { VIEW_LISTS, VIEW_NAME_MAX, VIEW_PARAMS_MAX, VIEW_VALUE_MAX, viewInput, viewName, viewNameKey, viewParams } = await import('../dist/saved-views.js');
after(() => closeConnections());

test('the lists and their parameters are the ones the panel uses', () => {
  assert.deepEqual(Object.keys(VIEW_LISTS).sort(), ['admin-audit', 'admin-invoices', 'admin-payments', 'admin-servers', 'admin-support', 'admin-users', 'servers']);
  assert.deepEqual(VIEW_LISTS.servers, ['q', 'state', 'tag', 'project', 'sort']);
  assert.deepEqual(VIEW_LISTS['admin-servers'], ['q', 'state', 'tag', 'owner', 'sort', 'starred']);
  assert.deepEqual(VIEW_LISTS['admin-support'], ['status', 'priority', 'department', 'assignee', 'q']);
  for (const keys of Object.values(VIEW_LISTS)) assert.ok(keys.length <= VIEW_PARAMS_MAX);
});

test('a name is tidied, 1 to 60 characters, and compared without case or Turkish letter forms', () => {
  assert.equal(viewName('  Running \n  web\t servers '), 'Running web servers');
  assert.equal(viewName('x'.repeat(VIEW_NAME_MAX)), 'x'.repeat(VIEW_NAME_MAX));
  assert.equal(viewName('x'.repeat(VIEW_NAME_MAX + 1)), null);
  assert.equal(viewName('   '), null);
  assert.equal(viewName(''), null);
  assert.equal(viewName(7), null);
  assert.equal(viewName(null), null);
  assert.equal(viewNameKey('ISPARTA İşleri'), viewNameKey('ısparta isleri'));
  assert.equal(viewNameKey('Çalışan'), viewNameKey('calisan'));
  assert.notEqual(viewNameKey('one'), viewNameKey('two'));
});

test('parameters: only the names of the list, text values of a bounded length', () => {
  assert.deepEqual(viewParams('servers', { q: 'web', state: 'running' }), { q: 'web', state: 'running' });
  assert.deepEqual(viewParams('servers', {}), {});
  // An empty value is a choice of its own ("every status").
  assert.deepEqual(viewParams('admin-support', { status: '' }), { status: '' });
  assert.deepEqual(viewParams('servers', { q: 'x'.repeat(VIEW_VALUE_MAX) }), { q: 'x'.repeat(VIEW_VALUE_MAX) });
  assert.equal(viewParams('servers', { q: 'x'.repeat(VIEW_VALUE_MAX + 1) }), null);
  assert.equal(viewParams('servers', { owner: 'a@example.test' }), null, 'a parameter of another list');
  assert.equal(viewParams('servers', { page: '3' }), null);
  assert.equal(viewParams('servers', { q: 7 }), null);
  assert.equal(viewParams('servers', { q: ['a'] }), null);
  assert.equal(viewParams('servers', { q: null }), null);
  assert.equal(viewParams('servers', JSON.parse('{"__proto__":"x"}')), null);
  assert.equal(viewParams('servers', { constructor: 'x' }), null);
  assert.equal(viewParams('servers', ['q']), null);
  assert.equal(viewParams('servers', 'q=web'), null);
  assert.equal(viewParams('servers', null), null);
  assert.equal(viewParams('unknown', { q: 'web' }), null);
  assert.equal(viewParams('constructor', {}), null);
  assert.equal(viewParams('servers', Object.fromEntries(Array.from({ length: VIEW_PARAMS_MAX + 1 }, (_, i) => [`k${i}`, 'v']))), null);
});

test('a new view needs a list, a name and parameters; the default mark is a boolean', () => {
  assert.deepEqual(viewInput('servers', { name: ' Web ', params: { q: 'web' } }, false), { name: 'Web', params: { q: 'web' } });
  assert.deepEqual(viewInput('servers', { name: 'Web', params: { q: 'web' }, isDefault: true, extra: 1 }, false), { name: 'Web', params: { q: 'web' }, isDefault: true });
  assert.deepEqual(viewInput('servers', {}, false), { fields: { name: 'REQUIRED', params: 'REQUIRED' } });
  assert.deepEqual(viewInput('servers', null, false), { fields: { name: 'REQUIRED', params: 'REQUIRED' } });
  assert.deepEqual(viewInput('servers', { name: 'x'.repeat(61), params: { nope: '1' } }, false), { fields: { name: 'INVALID_VALUE', params: 'INVALID_VALUE' } });
  assert.deepEqual(viewInput('servers', { name: 'Web', params: {}, isDefault: 'yes' }, false), { fields: { isDefault: 'INVALID_VALUE' } });
  // An unknown list is named once: its parameters cannot be judged.
  assert.deepEqual(viewInput('nope', { name: 'Web', params: { q: 'web' } }, false), { fields: { list: 'INVALID_VALUE' } });
  assert.deepEqual(viewInput('', { name: 'Web', params: {} }, false), { fields: { list: 'INVALID_VALUE' } });
  assert.deepEqual(viewInput('__proto__', { name: 'Web', params: {} }, false), { fields: { list: 'INVALID_VALUE' } });
});

test('a change carries only what is sent, and at least one thing', () => {
  assert.deepEqual(viewInput('servers', { name: 'New' }, true), { name: 'New' });
  assert.deepEqual(viewInput('servers', { params: { state: 'stopped' } }, true), { params: { state: 'stopped' } });
  assert.deepEqual(viewInput('servers', { isDefault: false }, true), { isDefault: false });
  assert.deepEqual(viewInput('servers', { name: ' ' }, true), { fields: { name: 'REQUIRED' } });
  assert.deepEqual(viewInput('servers', { params: { owner: 'x' } }, true), { fields: { params: 'INVALID_VALUE' } });
  assert.deepEqual(viewInput('servers', { params: null }, true), { fields: { params: 'REQUIRED' } });
  assert.deepEqual(viewInput('servers', {}, true), { fields: { name: 'REQUIRED' } });
  assert.deepEqual(viewInput('servers', { list: 'admin-users' }, true), { fields: { name: 'REQUIRED' } }, 'a view does not move to another list');
});
