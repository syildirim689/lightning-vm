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

// The value handed back is the normalised one: dot segments, written out or percent-encoded, must not turn a
// panel path into //host, which a browser reads as another site.
test('dot segments that normalise to another site are refused', () => {
  for (const bad of ['/.//evil.example', '/..//evil.example', '/x/..//evil.example', '/x/y/../..//evil.example/z?a=1', '/%2e//evil.example', '/%2e%2e//evil.example', '/%2E%2E//evil.example', '/x/%2e%2e//evil.example', '/./%2e/.//evil.example#h']) {
    const got = backTo(bad);
    assert.equal(got, null, bad);
  }
  // Whatever is returned stays on the panel's own origin.
  for (const ok of ['/servers/../billing', '/a/./b?x=//y', '/servers/x//y', '/x/%2e%2e/servers']) {
    const got = backTo(ok);
    assert.ok(got && !got.startsWith('//') && new URL(got, 'https://panel.example').origin === 'https://panel.example', `${ok} => ${got}`);
  }
  assert.equal(backTo('/servers/../billing'), '/billing');
});

test('the block list reads the normalised, decoded path in any case', () => {
  for (const bad of ['/LOGIN', '/Api/auth/me', '/%61pi/auth/me', '/x/../login', '/x/%2e%2e/api/servers', '/%6cogin?next=/x', '/_NEXT/static/x.js', '/x/..', '/%ff'])
    assert.equal(backTo(bad), null, bad);
  assert.equal(backTo('/apiary'), '/apiary');
});

test('the sign-in link carries the reason and the page', () => {
  assert.equal(loginFrom('/billing?tab=invoices', 'expired'), '/login?reason=expired&next=%2Fbilling%3Ftab%3Dinvoices');
  assert.equal(loginFrom('/'), '/login');
  assert.equal(loginFrom('/login', 'expired'), '/login?reason=expired');
});
