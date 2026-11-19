import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { activeView, changeView, cleanName, createView, defaultFor, deleteView, fetchViews, forgetLocalViews, fromApi, hasLocalViews, moveLocalViews, parseViews, removeView, renameView, routeMissing, saveView,
  setDefaultView, uploadLocalViews, viewParams, viewQuery, viewsKey, viewValues, VIEW_LIMIT, VIEW_LISTS, VIEW_NAME_MAX, type SavedView, type ViewCall } from './saved-views.ts';

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

test('broken or foreign content is dropped', () => {
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

// A stand-in for the API: keeps the views of one list, answers as /saved-views does, and notes every request.
type Row = { id: string; name: string; params: Record<string, string>; isDefault: boolean };
function fakeApi(start: Row[] = [], fail?: (method: string, body: Record<string, unknown>) => string | undefined) {
  let rows = [...start], n = 0;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const call = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? 'GET', body = (init.body ?? {}) as Record<string, unknown>;
    calls.push({ method, path, ...(init.body !== undefined && { body: init.body }) });
    const code = fail?.(method, body);
    if (code) throw { code };
    if (method === 'GET') return { views: rows };
    if (method === 'POST') {
      if (rows.some((r) => r.name.toLowerCase() === String(body.name).toLowerCase())) throw { code: 'VALIDATION_FAILED', fields: { name: 'NAME_TAKEN' } };
      if (rows.length >= VIEW_LIMIT) throw { code: 'LIMIT_REACHED' };
      const row: Row = { id: `s${++n}`, name: String(body.name), params: body.params as Record<string, string>, isDefault: body.isDefault === true };
      if (row.isDefault) rows = rows.map((r) => ({ ...r, isDefault: false }));
      rows.push(row);
      return row;
    }
    const id = path.split('/').pop();
    const at = rows.findIndex((r) => r.id === id);
    if (at < 0) throw { code: 'NOT_FOUND' };
    if (method === 'DELETE') { rows.splice(at, 1); return undefined; }
    if (body.isDefault === true) rows = rows.map((r) => ({ ...r, isDefault: false }));
    rows[at] = { ...rows[at]!, ...(body as Partial<Row>) };
    return rows[at];
  }) as ViewCall;
  return { call, calls };
}
// A stand-in for localStorage that notes whether anything was written.
function fakeStore(start: Record<string, string> = {}) {
  const data = new Map(Object.entries(start));
  let writes = 0;
  return { data, writes: () => writes, getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => { data.delete(k); }, key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; }, setItem: (k: string, v: string) => { writes++; data.set(k, v); } };
}

test('a view goes to the API as the parameters of its list and comes back as one query text', async () => {
  assert.deepEqual(viewParams('q=web&state=running&evil=1', keys), { q: 'web', state: 'running' });
  assert.deepEqual(viewParams('status=', { status: 'active' }), { status: '' });
  assert.deepEqual(viewParams('', keys), {});
  const api = fakeApi();
  const made = await createView(api.call, 'servers', { name: 'Web', query: 'q=web&state=running&page=2', isDefault: true }, keys);
  assert.deepEqual(made, { id: 's1', name: 'Web', query: 'q=web&state=running', isDefault: true });
  assert.deepEqual(api.calls[0], { method: 'POST', path: '/saved-views', body: { list: 'servers', name: 'Web', params: { q: 'web', state: 'running' }, isDefault: true } });
  assert.deepEqual(await fetchViews(api.call, 'servers', keys), [made]);
  assert.equal(api.calls[1]!.path, '/saved-views?list=servers');
  assert.deepEqual(await changeView(api.call, 's1', { query: 'sort=name' }, keys), { id: 's1', name: 'Web', query: 'sort=name', isDefault: true });
  assert.deepEqual(api.calls[2], { method: 'PATCH', path: '/saved-views/s1', body: { params: { sort: 'name' } } });
  await changeView(api.call, 's1', { name: 'Renamed', isDefault: false }, keys);
  assert.deepEqual(api.calls[3]!.body, { name: 'Renamed', isDefault: false });
  await removeView(api.call, 's1');
  assert.deepEqual([api.calls[4]!.method, api.calls[4]!.path], ['DELETE', '/saved-views/s1']);
  assert.deepEqual(await fetchViews(api.call, 'servers', keys), []);
});

test('what the API answers is data: malformed views are dropped and foreign parameters ignored', () => {
  assert.deepEqual(fromApi(null, keys), []);
  assert.deepEqual(fromApi({ views: [] }, keys), []);
  const views = fromApi([null, 'x', { id: 'a', name: 'Ok', params: { q: 'web', evil: '1', state: 7 }, isDefault: true }, { id: 'b', name: 'No params' }, { id: 'c', name: 'List', params: ['q'] },
    { id: 'd', name: 'ok', params: {} }, { id: 'e', name: 'Second default', params: { state: 'all' }, isDefault: true }], keys);
  assert.deepEqual(views, [{ id: 'a', name: 'Ok', query: 'q=web', isDefault: true }, { id: 'e', name: 'Second default', query: '' }]);
});

test('only a missing route hides the control', () => {
  assert.equal(routeMissing({ code: 'NOT_FOUND' }), true);
  for (const e of [{ code: 'NETWORK' }, { code: 'UNKNOWN' }, { code: 'UNAUTHENTICATED' }, { code: 'RATE_LIMITED' }, null, undefined, 'NOT_FOUND']) assert.equal(routeMissing(e), false);
});

test('views left in the browser move to the account once, name clashes skipped, and the local copy goes', async () => {
  const local = [{ id: 'l1', name: 'Web', query: 'q=web' }, { id: 'l2', name: 'Stopped', query: 'state=stopped&page=4', isDefault: true }, { id: 'l3', name: 'Nothing here', query: 'other=1' }];
  const store = fakeStore({ [viewsKey('u1', 'servers')]: JSON.stringify(local), [viewsKey('u2', 'servers')]: JSON.stringify(local), unrelated: 'x' });
  const api = fakeApi([{ id: 'x', name: 'WEB', params: { q: 'kept' }, isDefault: false }]);
  const server = await fetchViews(api.call, 'servers', keys);
  const after = await moveLocalViews(api.call, 'u1', 'servers', keys, server, store);
  // "Web" is already a name of the account (any case): the account's stays. The one holding nothing for this list is not sent.
  assert.deepEqual(after, [{ id: 'x', name: 'WEB', query: 'q=kept' }, { id: 's1', name: 'Stopped', query: 'state=stopped', isDefault: true }]);
  assert.deepEqual(api.calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ list: 'servers', name: 'Stopped', params: { state: 'stopped' }, isDefault: true }]);
  assert.equal(store.getItem(viewsKey('u1', 'servers')), null);
  assert.notEqual(store.getItem(viewsKey('u2', 'servers')), null, 'the copy of another person is not touched by this move');
  assert.equal(store.writes(), 0);
  // A second visit finds nothing to move and asks nothing.
  const before = api.calls.length;
  assert.equal(await moveLocalViews(api.call, 'u1', 'servers', keys, after, store), after);
  assert.equal(api.calls.length, before);
});

test('the move keeps the default the account already has and stops at the limit', async () => {
  const local = Array.from({ length: VIEW_LIMIT }, (_, i) => ({ id: `l${i}`, name: `local ${i}`, query: `q=${i}`, ...(i === 0 && { isDefault: true }) }));
  const store = fakeStore({ [viewsKey('u1', 'servers')]: JSON.stringify(local) });
  const api = fakeApi(Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, name: `account ${i}`, params: { q: `a${i}` }, isDefault: i === 3 })));
  const after = await moveLocalViews(api.call, 'u1', 'servers', keys, await fetchViews(api.call, 'servers', keys), store);
  assert.equal(after.length, VIEW_LIMIT);
  assert.deepEqual(after.filter((v) => v.isDefault).map((v) => v.name), ['account 3']);
  assert.deepEqual(after.slice(10).map((v) => v.name), ['local 0', 'local 1']);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 2);
  assert.equal(store.data.size, 0);
});

test('a view the API refuses is left out; when the API cannot be reached the local copy waits for the next visit', async () => {
  const local = [{ id: 'l1', name: 'One', query: 'q=1' }, { id: 'l2', name: 'Two', query: 'q=2' }, { id: 'l3', name: 'Three', query: 'q=3' }];
  const key = viewsKey('u1', 'servers');
  let store = fakeStore({ [key]: JSON.stringify(local) });
  let api = fakeApi([], (method, body) => (method === 'POST' && body.name === 'Two' ? 'VALIDATION_FAILED' : undefined));
  assert.deepEqual((await moveLocalViews(api.call, 'u1', 'servers', keys, [], store)).map((v) => v.name), ['One', 'Three']);
  assert.equal(store.getItem(key), null);

  for (const code of ['NETWORK', 'RATE_LIMITED', 'UNAUTHENTICATED', 'NOT_WHILE_IMPERSONATING', 'INTERNAL_ERROR']) {
    store = fakeStore({ [key]: JSON.stringify(local) });
    let down = true;
    api = fakeApi([], (method, body) => (down && method === 'POST' && body.name !== 'One' ? code : undefined));
    const first = await moveLocalViews(api.call, 'u1', 'servers', keys, [], store);
    assert.deepEqual(first.map((v) => v.name), ['One'], code);
    assert.notEqual(store.getItem(key), null, code);
    // Next visit: what was sent is found by its name, the rest follows, and then the copy goes.
    down = false;
    assert.deepEqual((await moveLocalViews(api.call, 'u1', 'servers', keys, first, store)).map((v) => v.name), ['One', 'Two', 'Three'], code);
    assert.equal(store.getItem(key), null, code);
    assert.equal(store.writes(), 0);
  }
});

test('the move survives no storage, blocked storage and broken content', async () => {
  const api = fakeApi();
  assert.deepEqual(await moveLocalViews(api.call, 'u1', 'servers', keys, [], null), []);
  const blocked = { getItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); }, key: () => null, length: 0 };
  assert.deepEqual(await moveLocalViews(api.call, 'u1', 'servers', keys, [], blocked), []);
  const store = fakeStore({ [viewsKey('u1', 'servers')]: 'not json' });
  assert.deepEqual(await moveLocalViews(api.call, 'u1', 'servers', keys, [], store), []);
  assert.equal(store.data.size, 0, 'broken content is removed, not kept forever');
  assert.equal(api.calls.length, 0);
});

test('forgetting removes the leftover views of every person from the browser and nothing else, and never throws', () => {
  const store = fakeStore({ [viewsKey('u1', 'servers')]: '[]', [viewsKey('u2', 'admin-users')]: '[{"id":"a"}]', 'lvm:drafts:u1': 'keep', other: 'keep' });
  forgetLocalViews(store);
  assert.deepEqual([...store.data.keys()].sort(), ['lvm:drafts:u1', 'other']);
  forgetLocalViews(store);
  forgetLocalViews(null);
  forgetLocalViews({ getItem: () => null, removeItem: () => { throw new Error('blocked'); }, key: () => { throw new Error('blocked'); }, length: 3 });
  forgetLocalViews(); // no localStorage here at all
});

test('a sign-out sends the views of the account that signs out, of every list, and of nobody else', async () => {
  const own = [{ id: 'l1', name: 'Stopped', query: 'state=stopped', isDefault: true }];
  const staff = [{ id: 'l2', name: 'Banned', query: 'status=banned&q=ada%40example.test' }];
  const store = fakeStore({ [viewsKey('u1', 'servers')]: JSON.stringify(own), [viewsKey('u1', 'admin-users')]: JSON.stringify(staff), [viewsKey('u1', 'no-such-list')]: JSON.stringify(own),
    [viewsKey('u2', 'servers')]: JSON.stringify([{ id: 'x', name: 'Of another person', query: 'q=secret' }]), [viewsKey('u11', 'servers')]: JSON.stringify(own), unrelated: 'x' });
  assert.equal(hasLocalViews(store), true);
  const api = fakeApi();
  assert.equal(await uploadLocalViews(api.call, 'u1', store), 2);
  assert.deepEqual(api.calls.filter((c) => c.method === 'POST').map((c) => c.body), [
    { list: 'servers', name: 'Stopped', params: { state: 'stopped' }, isDefault: true },
    { list: 'admin-users', name: 'Banned', params: { status: 'banned', q: 'ada@example.test' } }]);
  // What was sent is gone from the browser; a list the panel does not know, and everything of other people
  // (also of an id that only begins the same), is left as it was for forgetLocalViews to remove unsent.
  assert.deepEqual([...store.data.keys()].sort(), [viewsKey('u1', 'no-such-list'), viewsKey('u11', 'servers'), viewsKey('u2', 'servers'), 'unrelated'].sort());
  assert.equal(store.writes(), 0);
  forgetLocalViews(store);
  assert.deepEqual([...store.data.keys()], ['unrelated']);
  assert.equal(hasLocalViews(store), false);
});

test('a sign-out with nothing to send, nobody to send for or an API that does not answer asks little and never throws', async () => {
  const api = fakeApi();
  assert.equal(await uploadLocalViews(api.call, 'u1', fakeStore({ [viewsKey('u2', 'servers')]: '[]' })), 0);
  assert.equal(await uploadLocalViews(api.call, '', fakeStore({ [viewsKey('', 'servers')]: '[]' })), 0);
  assert.equal(await uploadLocalViews(api.call, 'u1', null), 0);
  assert.equal(api.calls.length, 0);
  // The API refuses the read (the session is already gone): nothing is sent and the copy stays for the removal.
  const down = fakeApi([], () => 'UNAUTHENTICATED');
  const store = fakeStore({ [viewsKey('u1', 'servers')]: JSON.stringify([{ id: 'l1', name: 'Web', query: 'q=web' }]) });
  assert.equal(await uploadLocalViews(down.call, 'u1', store), 0);
  assert.deepEqual(down.calls.map((c) => c.method), ['GET']);
  assert.notEqual(store.getItem(viewsKey('u1', 'servers')), null);
  assert.equal(hasLocalViews(null), false);
  assert.equal(hasLocalViews({ getItem: () => null, removeItem: () => undefined, key: () => { throw new Error('blocked'); }, length: 2 }), false);
});

test('the lists and their parameters are the ones the API keeps views for', () => {
  const source = new URL('../../api/src/saved-views.ts', import.meta.url);
  if (!existsSync(source)) return; // the web app built on its own (its image): nothing to compare with
  const block = /VIEW_LISTS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(readFileSync(source, 'utf8'))?.[1] ?? '';
  assert.ok(block, 'the API\'s list of lists was not found where it used to be');
  const api = Object.fromEntries([...block.matchAll(/^\s*'?([\w-]+)'?:\s*\[([^\]]*)\]/gm)].map((m) => [m[1]!, [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort()]));
  assert.deepEqual(api, Object.fromEntries(Object.entries(VIEW_LISTS).map(([list, keys]) => [list, Object.keys(keys).sort()])));
});
