// LDAP helpers: values cannot break out of the filter, and groups map to roles; a removed role leaves the mappings;
// an unknown address is asked in one spelling; directory sessions have a fixed length.
import test from 'node:test';
import assert from 'node:assert/strict';

const { escapeFilter, userFilter, rolesFromGroups, ldapAuthenticate, withoutRole, spelledOnce, directorySessionOver } = await import('../dist/ldap.js');

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

test('a removed role leaves the mappings: its groups lose it (or go), a default that named it is the customer role again', () => {
  const s = { defaultRole: 'ops', groupRoles: [{ group: 'cn=ops', roles: ['ops'] }, { group: 'cn=both', roles: ['ops', 'support'] }, { group: 'cn=support', roles: ['support'] }], url: 'ldap://x' };
  assert.deepEqual(withoutRole(s, 'ops'), { defaultRole: 'user', groupRoles: [{ group: 'cn=both', roles: ['support'] }, { group: 'cn=support', roles: ['support'] }], url: 'ldap://x' });
  assert.deepEqual(withoutRole(s, 'nope'), s, 'a role no mapping names changes nothing');
  assert.deepEqual(s.groupRoles[0].roles, ['ops'], 'the stored value is not changed in place');
  // What the removed role would have given is what nobody gets now.
  assert.deepEqual(rolesFromGroups(withoutRole(s, 'ops'), ['cn=ops']), ['user']);
});

test('an address without an account is put to the directory in one spelling only', () => {
  for (const ok of ['ada@corp.test', 'ada.lovelace+panel@corp.test', 'o\'brien@corp.test', 'ayşe@şirket.test']) assert.equal(spelledOnce(ok), true, ok);
  // What a directory counts for nothing, or folds into something else (RFC 4518): each would be a sign-in limit of its own.
  for (const [bad, why] of [['ada@corp.test​', 'zero-width space'], ['a­da@corp.test', 'soft hyphen'], ['ada@corp.test️', 'variation selector'], ['ada͏@corp.test', 'grapheme joiner'],
    ['ada @corp.test', 'space'], ['ada @corp.test', 'no-break space'], ['ada@corp.test\u0000', 'control character'], ['﻿ada@corp.test', 'byte order mark'],
    ['ａda@corp.test', 'full-width letter'], ['adá@corp.test', 'a letter and its accent apart'], ['ada᠆@corp.test', 'Mongolian soft hyphen'], ['ada￼@corp.test', 'object replacement'],
    ['ada', 'no @'], ['', 'empty']]) assert.equal(spelledOnce(bad), false, why);
});

test('a directory or single sign-on session ends a fixed time after it was made; other sessions are not touched', () => {
  const now = Date.parse('2026-11-18T12:00:00Z'), hour = 3_600_000;
  for (const source of ['ldap', 'oidc']) {
    assert.equal(directorySessionOver(source, new Date(now - 11 * hour), 12, now), false, source);
    assert.equal(directorySessionOver(source, new Date(now - 12 * hour - 1), 12, now), true, source);
    assert.equal(directorySessionOver(source, new Date(now - 13 * hour).toISOString(), 12, now), true, `${source}, a date as text`);
  }
  for (const source of ['local', 'social', undefined, null]) assert.equal(directorySessionOver(source, new Date(now - 1000 * hour), 12, now), false, String(source));
});
