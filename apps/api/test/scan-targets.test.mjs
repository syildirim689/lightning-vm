// Network scan targets: addresses, blocks, ranges and wildcards; limits and errors per item.
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseTargets, block24, scanLimit } = await import('../dist/scan-targets.js');

test('a /24 leaves out the network and broadcast address; /31 and /32 do not', () => {
  const t = parseTargets('192.168.10.0/24');
  assert.equal(t.addresses.length, 254);
  assert.equal(t.addresses[0], '192.168.10.1');
  assert.equal(t.addresses.at(-1), '192.168.10.254');
  assert.deepEqual(parseTargets('10.0.0.4/31').addresses, ['10.0.0.4', '10.0.0.5']);
  assert.deepEqual(parseTargets('10.0.0.9/32').addresses, ['10.0.0.9']);
  // A host address with a prefix means its block.
  assert.equal(parseTargets('10.0.0.77/30').addresses.join(), '10.0.0.77,10.0.0.78');
});

test('ranges, short ranges, wildcards and single addresses; duplicates counted once', () => {
  assert.deepEqual(parseTargets('10.0.0.10-10.0.0.12').addresses, ['10.0.0.10', '10.0.0.11', '10.0.0.12']);
  assert.deepEqual(parseTargets('10.0.0.250-252').addresses, ['10.0.0.250', '10.0.0.251', '10.0.0.252']);
  assert.equal(parseTargets('10.0.1.*').addresses.length, 254);
  const t = parseTargets('10.0.0.5, 10.0.0.5\n10.0.0.4-6;fd00::10');
  assert.deepEqual(t.addresses, ['10.0.0.5', '10.0.0.4', '10.0.0.6', 'fd00::10']);
  assert.deepEqual(t.items.map((i) => i.count), [1, 1, 3, 1]);
});

test('errors per item; the rest still counts', () => {
  const t = parseTargets('10.0.0.0/16 esxi.local 10.0.0.300 fd00::/64 10.0.0.9-3 10.0.0.1');
  assert.deepEqual(t.items.map((i) => i.error ?? 'ok'), ['RANGE_TOO_LARGE', 'INVALID_TARGET', 'INVALID_TARGET', 'IPV6_RANGE', 'INVALID_TARGET', 'ok']);
  assert.deepEqual(t.addresses, ['10.0.0.1']);
  assert.equal(parseTargets('010.0.0.1').items[0].error, 'INVALID_TARGET');
});

test('at most 4096 addresses in all', () => {
  assert.equal(parseTargets('10.0.0.0/20').addresses.length, 4094);
  const t = parseTargets('10.0.0.0/20 10.1.0.0/24');
  assert.equal(t.addresses.length, scanLimit);
  assert.equal(t.tooMany, true);
});

test('the /24 of an address for suggestions', () => {
  assert.equal(block24('172.16.5.40'), '172.16.5.0/24');
  assert.equal(block24('vc.example.com'), null);
  assert.equal(block24('fd00::1'), null);
});
