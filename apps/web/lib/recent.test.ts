import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRecent, parseRecent, recentKind, recentPermission, RECENT_LIMIT, type Recent } from './recent.ts';

test('the list written before tickets and invoices is still read, as servers', () => {
  const old = JSON.stringify([{ href: '/servers/a', label: 'web-1' }, { href: '/servers/b', label: 'db-1' }]);
  const list = parseRecent(old);
  assert.deepEqual(list, [{ href: '/servers/a', label: 'web-1' }, { href: '/servers/b', label: 'db-1' }]);
  assert.deepEqual(list.map(recentKind), ['server', 'server']);
});

test('kinds are kept, and guessed from the address when missing', () => {
  assert.equal(recentKind({ href: '/support/1' }), 'ticket');
  assert.equal(recentKind({ href: '/admin/support/1' }), 'ticket');
  assert.equal(recentKind({ href: '/billing/invoices/1' }), 'invoice');
  assert.equal(recentKind({ href: '/servers/1', kind: 'invoice' }), 'invoice');
  assert.deepEqual(parseRecent(JSON.stringify([{ href: '/support/1', label: '#1001 Disk', kind: 'ticket' }])), [{ href: '/support/1', label: '#1001 Disk', kind: 'ticket' }]);
});

test('broken or foreign storage content is dropped', () => {
  assert.deepEqual(parseRecent('not json'), []);
  assert.deepEqual(parseRecent('{"href":"/servers/a"}'), []);
  assert.deepEqual(parseRecent(null), []);
  const raw = JSON.stringify([null, 3, { href: 'https://evil.example/x', label: 'x' }, { href: '//evil.example', label: 'x' }, { href: '/\\evil', label: 'x' }, { href: '/servers/a' },
    { href: '/servers/a', label: '  ' }, { href: '/servers/ok', label: 'ok', kind: 'nonsense' }, { href: '/servers/ok', label: 'again' }]);
  assert.deepEqual(parseRecent(raw), [{ href: '/servers/ok', label: 'ok' }]);
});

test('the newest goes first, once, and the list stays within its limit', () => {
  let list: Recent[] = [];
  for (let i = 0; i < RECENT_LIMIT + 4; i++) list = mergeRecent(list, { href: `/servers/${i}`, label: `s${i}`, kind: 'server' });
  assert.equal(list.length, RECENT_LIMIT);
  assert.equal(list[0].href, `/servers/${RECENT_LIMIT + 3}`);
  const again = mergeRecent(list, { href: list[3].href, label: 'renamed', kind: 'server' });
  assert.equal(again.length, RECENT_LIMIT);
  assert.deepEqual(again[0], { href: list[3].href, label: 'renamed', kind: 'server' });
  assert.equal(again.filter((r) => r.href === list[3].href).length, 1);
  assert.equal(parseRecent(JSON.stringify([...list, ...list, { href: '/x', label: 'x' }])).length, RECENT_LIMIT);
});

test('people staff looked up are kept as their own kind, next to the older entries', () => {
  const raw = JSON.stringify([{ href: '/admin/users?q=ada%40example.com', label: 'Ada (ada@example.com)', kind: 'user' }, { href: '/servers/a', label: 'web-1' },
    { href: '/admin/billing/invoices/9', label: 'INV-9', kind: 'invoice' }]);
  const list = parseRecent(raw);
  assert.deepEqual(list, [{ href: '/admin/users?q=ada%40example.com', label: 'Ada (ada@example.com)', kind: 'user' }, { href: '/servers/a', label: 'web-1' },
    { href: '/admin/billing/invoices/9', label: 'INV-9', kind: 'invoice' }]);
  assert.deepEqual(list.map(recentKind), ['user', 'server', 'invoice']);
  assert.equal(recentKind({ href: '/admin/users?q=x' }), 'user');
  assert.equal(recentKind({ href: '/admin/users' }), 'user');
  // A server whose address merely starts alike is still a server.
  assert.equal(recentKind({ href: '/servers/admin-users' }), 'server');
  const merged = mergeRecent(list, { href: '/admin/users?q=ada%40example.com', label: 'Ada Lovelace (ada@example.com)', kind: 'user' });
  assert.equal(merged.length, 3);
  assert.equal(merged[0].label, 'Ada Lovelace (ada@example.com)');
});

test('staff pages ask for their permission, the person\'s own pages for none', () => {
  assert.equal(recentPermission({ href: '/admin/users?q=x', kind: 'user' }), 'users.view');
  assert.equal(recentPermission({ href: '/admin/billing/invoices/1', kind: 'invoice' }), 'billing.view');
  assert.equal(recentPermission({ href: '/admin/billing/invoices/1' }), 'billing.view');
  assert.equal(recentPermission({ href: '/admin/support/1', kind: 'ticket' }), 'support.view');
  assert.equal(recentPermission({ href: '/admin/servers?owner=x' }), 'servers.view_all');
  assert.equal(recentPermission({ href: '/billing/invoices/1', kind: 'invoice' }), null);
  assert.equal(recentPermission({ href: '/support/1', kind: 'ticket' }), null);
  assert.equal(recentPermission({ href: '/servers/1', kind: 'server' }), null);
  assert.equal(recentPermission({ href: '/administrator', kind: 'server' }), null);
});
