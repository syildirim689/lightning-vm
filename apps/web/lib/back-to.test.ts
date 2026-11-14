import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backTo, loginFrom } from './back-to.ts';

test('panel paths are kept with their query', () => {
  assert.equal(backTo('/servers/1f2e?tab=disks'), '/servers/1f2e?tab=disks');
  assert.equal(backTo('/admin/users?q=a%40b'), '/admin/users?q=a%40b');
});

test('other sites, the API, sign-in pages and the home page are refused', () => {
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/x', 'evil', '/api/auth/me', '/login?next=/x', '/register', '/', '', null, undefined, '/x\nSet-Cookie: a'])
    assert.equal(backTo(bad as string), null, String(bad));
});

test('the sign-in link carries the reason and the page', () => {
  assert.equal(loginFrom('/billing?tab=invoices', 'expired'), '/login?reason=expired&next=%2Fbilling%3Ftab%3Dinvoices');
  assert.equal(loginFrom('/'), '/login');
  assert.equal(loginFrom('/login', 'expired'), '/login?reason=expired');
});
