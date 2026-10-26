// LDAP helpers: values cannot break out of the filter, and groups map to roles.
import test from 'node:test';
import assert from 'node:assert/strict';

const { escapeFilter, userFilter, rolesFromGroups, ldapAuthenticate } = await import('../dist/ldap.js');

test('filter values are escaped (RFC 4515), so an e-mail cannot widen the search', () => {
  assert.equal(escapeFilter('a*)(uid=*'), 'a\\2a\\29\\28uid=\\2a');
  assert.equal(escapeFilter('back\\slash'), 'back\\5cslash');
  assert.equal(userFilter('(&(objectClass=person)(mail={email}))', 'x*@e.com'), '(&(objectClass=person)(mail=x\\2a@e.com))');
});

test('groups to roles: every matching mapping, DNs compared loosely; nobody matched gets the default role', () => {
  const s = { defaultRole: 'user', groupRoles: [{ group: 'CN=Ops,OU=Groups,DC=ex,DC=com', roles: ['support'] }, { group: 'cn=admins,dc=ex,dc=com', roles: ['admin', 'support'] }] };
  assert.deepEqual(rolesFromGroups(s, ['cn=ops, ou=groups, dc=ex, dc=com']), ['support']);
  assert.deepEqual(rolesFromGroups(s, ['CN=Admins,DC=ex,DC=com', 'cn=ops,ou=groups,dc=ex,dc=com']).sort(), ['admin', 'support']);
  assert.deepEqual(rolesFromGroups(s, ['cn=other,dc=ex,dc=com']), ['user']);
});

test('an empty password is never a sign-in (no unauthenticated bind)', async () => {
  assert.deepEqual(await ldapAuthenticate({}, '', 'a@b.c', ''), { ok: false, code: 'LDAP_AUTH_FAILED' });
});
