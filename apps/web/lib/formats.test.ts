// Formats of typed values (run with: node --test lib/*.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCIDR, isDomain, isFqdn, isIPv6Prefix, isMoney, isPrivateCidr, isSshKey, isTag, isHostname, isIPv4, isIPv6, isMac, isPortRange, isServerName, isUrl, isValid, normalize, normalizeMac, splitList, suggestServerName } from './formats.ts';

test('IPv4', () => {
  for (const ok of ['0.0.0.0', '10.0.0.1', '255.255.255.255', '203.0.113.10']) assert.equal(isIPv4(ok), true, ok);
  for (const bad of ['256.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5', '', 'a.b.c.d']) assert.equal(isIPv4(bad), false, bad);
});

test('IPv6', () => {
  for (const ok of ['::', '::1', '2001:db8::1', 'fe80::1:2:3:4', '2001:0db8:0000:0000:0000:0000:0000:0001', '::ffff:192.0.2.1']) assert.equal(isIPv6(ok), true, ok);
  for (const bad of ['2001:db8::1::2', '12345::', ':', '1.2.3.4', '2001:db8:0:0:0:0:0:0:1', 'g::1']) assert.equal(isIPv6(bad), false, bad);
});

test('CIDR', () => {
  assert.equal(isCIDR('10.0.0.0/8'), true);
  assert.equal(isCIDR('2001:db8::/32'), true);
  assert.equal(isCIDR('10.0.0.0/33'), false);
  assert.equal(isCIDR('10.0.0.0'), false);
  assert.equal(isCIDR('10.0.0.0/8/1'), false);
});

test('MAC addresses in every spelling become one', () => {
  for (const x of ['00:50:56:AB:CD:EF', '00-50-56-ab-cd-ef', '0050.56ab.cdef', '005056abcdef', ' 00 50 56 ab cd ef ']) assert.equal(normalizeMac(x), '00:50:56:ab:cd:ef', x);
  assert.equal(isMac('0050.56ab.cdef'), true);
  assert.equal(isMac('00:50:56:ab:cd'), false);
});

test('host names, domains and server names', () => {
  assert.equal(isHostname('esxi01.example.com'), true);
  assert.equal(isHostname('-bad.example.com'), false);
  assert.equal(isDomain('example.com'), true);
  assert.equal(isDomain('localhost'), false);
  assert.equal(isDomain('example.c0m'), false);
  assert.equal(isFqdn('mail.example.com.'), true);
  assert.equal(isFqdn('mail'), false);
  assert.equal(isFqdn('mail.123'), false);
  assert.equal(isServerName('web-1'), true);
  assert.equal(isServerName('Web_1'), false);
  assert.equal(isServerName('-web'), false);
  assert.equal(suggestServerName('  Web Sunucusu_1 '), 'web-sunucusu-1');
  assert.equal(suggestServerName('Işık Çağrı'), 'isik-cagri');
});

test('ports, ranges, URLs', () => {
  assert.equal(isPortRange('443'), true);
  assert.equal(isPortRange('8000-8100'), true);
  assert.equal(isPortRange('8100-8000'), false);
  assert.equal(isPortRange('22-22'), true); // the API accepts a one-port range
  assert.equal(isPortRange('0'), false);
  assert.equal(isPortRange('70000'), false);
  assert.equal(normalize('portRange', '8000 – 8100'), '8000-8100');
  assert.equal(isUrl('https://example.com/x'), true);
  assert.equal(isUrl('ftp://example.com'), false);
  assert.equal(normalize('url', 'example.com/path'), 'https://example.com/path');
});

test('tidying keeps meaning and leaves unknown input alone', () => {
  assert.equal(normalize('ip', ' 10.0.0.1 '), '10.0.0.1');
  assert.equal(normalize('ip', '2001:DB8::1'), '2001:db8::1');
  assert.equal(normalize('hostname', 'ESXi01.Example.com'), 'esxi01.example.com');
  assert.equal(normalize('mac', 'not a mac'), 'not a mac');
  assert.equal(isValid('ipOrCidr', '10.0.0.0/24'), true);
  assert.deepEqual(splitList('10.0.0.1, 10.0.0.2\n10.0.0.3;10.0.0.4'), ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
});

test('rules shared with the API: private LANs, IPv6 pools, tags, SSH keys, amounts', () => {
  assert.equal(isPrivateCidr('10.10.0.0/24'), true);
  assert.equal(isPrivateCidr('172.20.0.0/16'), true);
  assert.equal(isPrivateCidr('172.32.0.0/24'), false);
  assert.equal(isPrivateCidr('8.8.8.0/24'), false);
  assert.equal(isPrivateCidr('192.168.0.0/30'), false);
  assert.equal(isIPv6Prefix('2001:db8:40::/64'), true);
  assert.equal(isIPv6Prefix('2001:db8::/32'), false);
  assert.equal(isTag('üretim'), true);
  assert.equal(isTag('-x'), false);
  assert.equal(isTag('a'.repeat(25)), false);
  assert.equal(isSshKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMa0 me@host'), true);
  assert.equal(isSshKey('ssh-dss AAAA'), false);
  assert.equal(isMoney('9,90'), true);
  assert.equal(isMoney('9.9999'), true);
  assert.equal(isMoney('9.99999'), false);
  assert.equal(normalize('money', '9,90'), '9.90');
  assert.equal(normalize('fqdn', 'Mail.Example.com.'), 'mail.example.com');
});
