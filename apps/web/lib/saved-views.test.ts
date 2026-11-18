import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeView, cleanName, defaultFor, deleteView, parseViews, renameView, saveView, setDefaultView, viewQuery, viewsKey, viewValues, VIEW_LIMIT, VIEW_NAME_MAX, type SavedView } from './saved-views.ts';

const keys = { q: '', state: 'all', sort: 'newest' };

test('the state of a list is one comparable text: its own parameters, defaults left out, sorted', () => {
  assert.equal(viewQuery({ state: 'running', q: 'web', sort: 'newest', tab: 'servers' }, keys), 'q=web&state=running');
  assert.equal(viewQuery('?sort=name&q=web&page=3', keys), 'q=web&sort=name');
  assert.equal(viewQuery(new URLSearchParams('state=all'), keys), '');
  assert.equal(viewQuery({ q: null, state: undefined }, keys), '');
  // An empty value is a choice of its own where the default is something else ("all statuses").
  assert.equal(viewQuery({ status: '' }, { status: 'active' }), 'status=');
});

test('applying a view writes every parameter of the list and nothing else', () => {
  assert.deepEqual(viewValues('q=web&state=running&evil=1', keys), { q: 'web', state: 'running', sort: null });
  assert.deepEqual(viewValues('state=all', keys), { q: null, state: null, sort: null });
  assert.deepEqual(viewValues('status=', { status: 'active' }), { status: '' });
});

test('saving adds a view, and the same name (any case) updates it in place', () => {
  let r = saveView([], '  Running   web ', 'q=web&state=running', 'a');
  assert.deepEqual(r, { views: [{ id: 'a', name: 'Running web', query: 'q=web&state=running' }], id: 'a' });
  r = saveView(setDefaultView(r.views, 'a'), 'running WEB', 'q=db', 'b');
  assert.deepEqual(r, { views: [{ id: 'a', name: 'running WEB', query: 'q=db', isDefault: true }], id: 'a' });
  assert.equal(saveView(r.views, '   ', 'q=x', 'c').error, 'name');
  assert.equal(saveView([], 'x'.repeat(200), 'q=x', 'c').views[0].name.length, VIEW_NAME_MAX);
});

test('the list of views stays within its limit, but an existing one can still be updated', () => {
  let views: SavedView[] = [];
  for (let i = 0; i < VIEW_LIMIT; i++) views = saveView(views, `v${i}`, `q=${i}`, `id${i}`).views;
  assert.equal(views.length, VIEW_LIMIT);
  const over = saveView(views, 'one more', 'q=x', 'idx');
  assert.equal(over.error, 'limit');
  assert.equal(over.views, views);
  const updated = saveView(views, 'V3', 'q=new', 'idy');
  assert.equal(updated.error, undefined);
  assert.equal(updated.views.length, VIEW_LIMIT);
  assert.equal(updated.views[3].query, 'q=new');
});

test('rename keeps the view, refuses an empty or taken name', () => {
  const views = [{ id: 'a', name: 'One', query: 'q=1', isDefault: true }, { id: 'b', name: 'Two', query: 'q=2' }];
  assert.deepEqual(renameView(views, 'a', ' First ').views[0], { id: 'a', name: 'First', query: 'q=1', isDefault: true });
  assert.equal(renameView(views, 'a', 'two').error, 'taken');
  assert.equal(renameView(views, 'a', ' ').error, 'name');
  assert.equal(renameView(views, 'zz', 'x').error, 'missing');
  // Changing only the case of its own name is allowed.
  assert.equal(renameView(views, 'a', 'ONE').views[0].name, 'ONE');
});

test('delete removes one view; the default mark moves, and there is only ever one', () => {
  const views = [{ id: 'a', name: 'One', query: 'q=1' }, { id: 'b', name: 'Two', query: 'q=2' }];
  const d = setDefaultView(setDefaultView(views, 'a'), 'b');
  assert.deepEqual(d, [{ id: 'a', name: 'One', query: 'q=1' }, { id: 'b', name: 'Two', query: 'q=2', isDefault: true }]);
  assert.deepEqual(setDefaultView(d, null), views);
  assert.deepEqual(deleteView(d, 'b'), [{ id: 'a', name: 'One', query: 'q=1' }]);
  assert.deepEqual(deleteView(d, 'nope'), d);
});

test('the default view applies only when none of the list parameters is in the address', () => {
  const views = [{ id: 'a', name: 'One', query: 'q=1' }, { id: 'b', name: 'Two', query: 'state=running', isDefault: true }];
  assert.equal(defaultFor(views, '', keys)?.id, 'b');
  assert.equal(defaultFor(views, '?tab=servers', keys)?.id, 'b');
  assert.equal(defaultFor(views, { q: null, state: null, sort: null }, keys)?.id, 'b');
  // Present parameters win, whatever they hold: even one, even an empty one, even one equal to the default.
  assert.equal(defaultFor(views, '?q=web', keys), null);
  assert.equal(defaultFor(views, '?q=', keys), null);
  assert.equal(defaultFor(views, '?state=all', keys), null);
  assert.equal(defaultFor(views, { q: null, state: null, sort: 'name' }, keys), null);
  // No default, or a default that holds nothing for this list: nothing to apply.
  assert.equal(defaultFor(setDefaultView(views, null), '', keys), null);
  assert.equal(defaultFor([{ id: 'c', name: 'Empty', query: 'state=all&other=1', isDefault: true }], '', keys), null);
});

test('the active view is the one applied last, and it says when the list has moved on from it', () => {
  const views = [{ id: 'a', name: 'One', query: 'q=1' }, { id: 'b', name: 'Two', query: 'state=running' }];
  assert.deepEqual(activeView(views, 'q=1', keys), { view: views[0], changed: false });
  assert.deepEqual(activeView(views, 'q=1', keys, 'b'), { view: views[1], changed: true });
  assert.deepEqual(activeView(views, 'state=running', keys, 'b'), { view: views[1], changed: false });
  assert.deepEqual(activeView(views, 'q=other', keys), { view: null, changed: false });
  assert.deepEqual(activeView(views, '', keys), { view: null, changed: false });
  // The applied view was deleted: fall back to an exact match.
  assert.deepEqual(activeView(views, 'q=1', keys, 'gone'), { view: views[0], changed: false });
});

test('broken or foreign storage content is dropped', () => {
  assert.deepEqual(parseViews('not json'), []);
  assert.deepEqual(parseViews('{"id":"a"}'), []);
  assert.deepEqual(parseViews(null), []);
  const raw = JSON.stringify([null, 7, 'x', { id: 'a', name: 'Ok', query: 'q=1', isDefault: true, extra: 1 }, { id: 'a', name: 'Same id', query: '' }, { id: 'b', name: 'ok', query: '' },
    { id: 'c', name: '   ', query: '' }, { id: 'd', name: 'No query' }, { id: '', name: 'No id', query: '' }, { id: 'e', name: 'Long', query: 'x'.repeat(5000) },
    { id: 'f', name: `Second\n default ${'y'.repeat(100)}`, query: 'q=2', isDefault: true }, { id: 'g', name: 'Truthy', query: '', isDefault: 'yes' }]);
  const views = parseViews(raw);
  assert.deepEqual(views.map((v) => v.id), ['a', 'f', 'g']);
  assert.deepEqual(views[0], { id: 'a', name: 'Ok', query: 'q=1', isDefault: true });
  assert.equal(views[1].isDefault, undefined);
  assert.equal(views[1].name.length, VIEW_NAME_MAX);
  assert.equal(/\n/.test(views[1].name), false);
  assert.equal(views[2].isDefault, undefined);
  const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, name: `n${i}`, query: '' })));
  assert.equal(parseViews(many).length, VIEW_LIMIT);
});

test('names are tidied and each user and list has its own storage key', () => {
  assert.equal(cleanName('  a \n b\t c  '), 'a b c');
  assert.notEqual(viewsKey('u1', 'admin-users'), viewsKey('u2', 'admin-users'));
  assert.notEqual(viewsKey('u1', 'admin-audit'), viewsKey('u1', 'admin-users'));
});
