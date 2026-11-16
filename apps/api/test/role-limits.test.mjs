// Role limits: several roles combine to the most generous, two-factor if any role asks, addresses by CIDR.
import test from 'node:test';
import assert from 'node:assert/strict';

const { combineLimits, ipAllowed, readLimits } = await import('../dist/role-limits.js');

test('several roles: a limit holds only if every role sets it, at the highest value; two-factor if any role asks', () => {
  assert.deepEqual(combineLimits([]), {});
  assert.deepEqual(combineLimits([{ maxServers: 2, maxVcpu: 4 }, { maxServers: 5 }]), { maxServers: 5 });
  assert.deepEqual(combineLimits([{ maxServers: 2, require2fa: true }, { maxServers: 1 }]), { maxServers: 2, require2fa: true });
  assert.deepEqual(combineLimits([{ allowedLocations: ['a'] }, { allowedLocations: ['b', 'a'] }]), { allowedLocations: ['a', 'b'] });
  assert.deepEqual(combineLimits([{ allowedIps: ['10.0.0.0/8'] }, {}]), {});
});

test('addresses: single IPs and CIDR blocks, IPv6, and IPv4 reported as IPv4-mapped IPv6', () => {
  assert.equal(ipAllowed(undefined, '1.2.3.4'), true);
  assert.equal(ipAllowed([], '1.2.3.4'), true);
  assert.equal(ipAllowed(['203.0.113.0/24'], '203.0.113.9'), true);
  assert.equal(ipAllowed(['203.0.113.0/24'], '203.0.114.9'), false);
  assert.equal(ipAllowed(['203.0.113.7'], '::ffff:203.0.113.7'), true);
  assert.equal(ipAllowed(['2001:db8::/32'], '2001:db8:1::5'), true);
  assert.equal(ipAllowed(['2001:db8::/32'], 'not-an-ip'), false);
});

test('the form: empty is unlimited, numbers within range, known locations, valid CIDRs', () => {
  const known = (id) => id === 'loc-1';
  assert.deepEqual(readLimits({ maxServers: '', maxVcpu: null, require2fa: false }, known), { limits: {}, fields: {} });
  assert.deepEqual(readLimits({ maxServers: '3', sessionHours: 8, require2fa: true, allowedLocations: ['loc-1'], allowedIps: ['10.0.0.0/8', ' 192.0.2.1 '] }, known).limits,
    { maxServers: 3, sessionHours: 8, require2fa: true, allowedLocations: ['loc-1'], allowedIps: ['10.0.0.0/8', '192.0.2.1'] });
  const bad = readLimits({ maxServers: -1, maxSnapshots: 99, operationsPerHour: 0, allowedLocations: ['nope'], allowedIps: ['10.0.0.0/33'] }, known).fields;
  assert.deepEqual(Object.keys(bad).sort(), ['limits.allowedIps', 'limits.allowedLocations', 'limits.maxServers', 'limits.maxSnapshots', 'limits.operationsPerHour']);
});

test('create-user: the role is read where better-auth reads it, and data carries nothing but the language', async () => {
  const { createUserRequest } = await import('../dist/role-limits.js');
  assert.deepEqual(createUserRequest({ role: 'user' }), { role: 'user', extra: [] });
  assert.deepEqual(createUserRequest({}), { role: 'user', extra: [] });
  // Without a top-level role better-auth takes data.role: that is the role to check.
  assert.equal(createUserRequest({ data: { role: 'admin' } }).role, 'admin');
  assert.equal(createUserRequest({ role: 'user', data: { role: 'admin' } }).role, 'user');
  assert.equal(createUserRequest({ role: ['user', 'admin'] }).role, 'user,admin');
  assert.deepEqual(createUserRequest({ role: 'user', data: { locale: 'tr', role: 'user', emailVerified: true, banned: false } }).extra, ['emailVerified', 'banned']);
});

test('a narrowed API token changes something only where the route names a permission it holds', async () => {
  const { narrowedTokenMay } = await import('../dist/role-limits.js');
  const has = ['server.power', 'firewalls.manage'];
  // Reading is never the question here (the token's read scope and each route's own checks decide that).
  assert.equal(narrowedTokenMay('GET', undefined, false, has), true);
  assert.equal(narrowedTokenMay('HEAD', undefined, false, []), true);
  // A route that names no permission is closed to it: paying, transferring, deleting keys, support...
  assert.equal(narrowedTokenMay('POST', undefined, false, has), false);
  assert.equal(narrowedTokenMay('DELETE', [], false, has), false);
  // A named permission: one of them must be among the token's.
  assert.equal(narrowedTokenMay('POST', ['server.power'], false, has), true);
  assert.equal(narrowedTokenMay('POST', ['server.delete', 'server.power'], false, has), true);
  assert.equal(narrowedTokenMay('DELETE', ['server.delete'], false, has), false);
  assert.equal(narrowedTokenMay('POST', ['billing.manage'], false, ['*']), true);
  // Routes marked as harmless for any token (a price quote).
  assert.equal(narrowedTokenMay('POST', undefined, true, []), true);
});
