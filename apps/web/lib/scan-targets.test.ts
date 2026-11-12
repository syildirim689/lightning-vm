import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets, block24 } from './scan-targets.ts';

// The full cases are in apps/api/test/scan-targets.test.mjs; this copy must agree with the API.
test('the web copy counts like the API', () => {
  assert.equal(parseTargets('192.168.10.0/24, 10.0.0.250-252\n10.0.1.*').addresses.length, 254 + 3 + 254);
  assert.equal(parseTargets('10.0.0.0/16').items[0].error, 'RANGE_TOO_LARGE');
  assert.equal(block24('172.16.5.40'), '172.16.5.0/24');
});
