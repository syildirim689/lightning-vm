// Energy estimate without a power counter, and a host's watts shared among its servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, shares } from '../power.mjs';

test('estimate is linear between idle and full load and clamps the utilisation', () => {
  assert.deepEqual(estimate({ idle: 100, max: 300 }, 0, 1000), { watts: 100, util: 0 });
  assert.equal(estimate({ idle: 100, max: 300 }, 500, 1000).watts, 200);
  assert.equal(estimate({ idle: 100, max: 300 }, 5000, 1000).watts, 300);
  assert.equal(estimate({ idle: 100, max: 300 }, 10, 0).watts, 100);
});

test('watts are shared by CPU use, evenly when nobody uses CPU', () => {
  assert.deepEqual(shares(300, [{ name: 'a', cpuUsedMhz: 100 }, { name: 'b', cpuUsedMhz: 200 }]).map((s) => s.watts), [100, 200]);
  assert.deepEqual(shares(300, [{ name: 'a', cpuUsedMhz: 0 }, { name: 'b', cpuUsedMhz: 0 }]).map((s) => s.watts), [150, 150]);
  assert.deepEqual(shares(300, []), []);
});
