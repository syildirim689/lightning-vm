// This server's settings: host names, time zones, time and DNS server lists, as the host agent will accept them.
import test from 'node:test';
import assert from 'node:assert/strict';

const { validHostname, readList, readHostChange } = await import('../dist/host-rules.js');
const { validTimeZone } = await import('../dist/time-zone.js');

test('host names: RFC 1123 labels, lowercase, at most 253 characters', () => {
  for (const ok of ['panel', 'panel-1', 'vm.example.com', 'a'.repeat(63)]) assert.ok(validHostname(ok), ok);
  for (const bad of ['', '-panel', 'panel-', 'pa_nel', 'panel..com', 'a'.repeat(64), 'x;reboot', 'Panel', `${'a.'.repeat(127)}a`]) assert.ok(!validHostname(bad), bad);
});

test('time zones: known IANA names only', () => {
  assert.equal(validTimeZone('Europe/Istanbul'), 'Europe/Istanbul');
  assert.equal(validTimeZone('UTC'), 'UTC');
  for (const bad of ['Mars/Base', '../etc/passwd', 'Europe/Istanbul; rm -rf /', '', 5]) assert.equal(validTimeZone(bad), null, String(bad));
});

test('server lists: up to four, names only for time servers, "default" resets', () => {
  assert.equal(readList('time.cloudflare.com, 0.tr.pool.ntp.org', 'ntp'), 'time.cloudflare.com,0.tr.pool.ntp.org');
  assert.equal(readList('1.1.1.1 2606:4700:4700::1111', 'dns'), '1.1.1.1,2606:4700:4700::1111');
  assert.equal(readList('default', 'dns'), 'default');
  assert.equal(readList('dns.google', 'dns'), null, 'DNS servers are addresses');
  assert.equal(readList('1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4,9.9.9.9', 'dns'), null, 'at most four');
  assert.equal(readList('300.1.1.1', 'dns'), null);
  assert.equal(readList('a.b;reboot', 'ntp'), null);
  for (const bad of ['999.1.1.1', '12', '1.2.3', '1.2.3.4.5', '256.0.0.1', 'time.example.com 300.1.1.1']) assert.equal(readList(bad, 'ntp'), null, bad);
  assert.equal(readList('192.0.2.1, 0.pool.ntp.org, 1e100.net', 'ntp'), '192.0.2.1,0.pool.ntp.org,1e100.net');
});

test('a change keeps only what was sent; errors per field', () => {
  assert.deepEqual(readHostChange({ hostname: 'Panel.Example.com', timezone: 'Europe/Istanbul' }), { change: { hostname: 'panel.example.com', timezone: 'Europe/Istanbul' }, fields: {} });
  assert.deepEqual(readHostChange({}), { change: {}, fields: {} });
  assert.deepEqual(readHostChange({ hostname: 'bad name', ntp: 'x;y', dns: 'dns.google' }).fields, { hostname: 'INVALID_HOSTNAME', ntp: 'INVALID_VALUE', dns: 'INVALID_VALUE' });
});
