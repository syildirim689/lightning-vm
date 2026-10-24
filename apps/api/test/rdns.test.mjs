// Reverse DNS names and default PTR records.
import test from 'node:test';
import assert from 'node:assert/strict';

const { reverseName, renderPtr, hostname } = await import('../dist/rdns-names.js');

test('reverse names for IPv4 and IPv6 (fully expanded nibbles)', () => {
  assert.equal(reverseName('192.0.2.10'), '10.2.0.192.in-addr.arpa.');
  assert.equal(reverseName('2001:db8::10'), '0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.');
  assert.equal(reverseName('2001:db8:1:2:3:4:5:6'), '6.0.0.0.5.0.0.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.');
});

test('the default PTR template fills in the address and the server name', () => {
  assert.equal(renderPtr('{ip-dashed}.static.example.com', '192.0.2.10', 'web-1'), '192-0-2-10.static.example.com.');
  assert.equal(renderPtr('{name}.Customers.Example.com.', '192.0.2.10', 'web-1'), 'web-1.customers.example.com.');
  assert.equal(renderPtr('{ip-dashed}.v6.example.com', '2001:db8::10', 'x'), '2001-db8-10.v6.example.com.');
  assert.equal(renderPtr('', '192.0.2.10', 'x'), '');
  assert.ok(hostname.test('mail.example.com') && !hostname.test('-bad.example.com') && !hostname.test('nodot'));
});
