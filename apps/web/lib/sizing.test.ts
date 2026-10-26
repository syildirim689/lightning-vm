// The workload advisor's rules (run with: node --test lib/*.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { needs, pick, snap } from './sizing.ts';

const pkgs = [
  { id: 's', vcpu: 1, memoryMb: 2048, diskGb: 25, priceMonthly: '5' },
  { id: 'm', vcpu: 2, memoryMb: 4096, diskGb: 50, priceMonthly: '10' },
  { id: 'l', vcpu: 4, memoryMb: 8192, diskGb: 100, priceMonthly: '20' },
  { id: 'm2', vcpu: 2, memoryMb: 4096, diskGb: 60, priceMonthly: '12' },
];

test('needs grow with traffic, disk in steps of 5 GB and never below the image minimum', () => {
  assert.deepEqual(needs('website', 'low'), { vcpu: 1, memoryMb: 2048, diskGb: 25 });
  assert.deepEqual(needs('website', 'medium'), { vcpu: 2, memoryMb: 4096, diskGb: 40 });
  assert.deepEqual(needs('dev', 'low', 30), { vcpu: 1, memoryMb: 1024, diskGb: 30 });
});

test('the cheapest package that fits; otherwise the biggest, marked as not enough', () => {
  assert.deepEqual(pick(pkgs, needs('website', 'medium')), { pkg: pkgs[1], enough: true });
  assert.deepEqual(pick(pkgs, needs('database', 'high')), { pkg: pkgs[2], enough: false });
  assert.deepEqual(pick([], needs('dev', 'low')), { pkg: null, enough: false });
});

test('a custom shape snaps up to the steps and stays in range', () => {
  const r = { cpuMin: 1, cpuMax: 8, cpuStep: 1, memoryMinMb: 1024, memoryMaxMb: 16384, memoryStepMb: 1024, diskMinGb: 20, diskMaxGb: 200, diskStepGb: 10 };
  assert.deepEqual(snap({ vcpu: 3, memoryMb: 3000, diskGb: 25 }, r), { vcpu: 3, memoryMb: 3072, diskGb: 30 });
  assert.deepEqual(snap({ vcpu: 16, memoryMb: 65536, diskGb: 500 }, r), { vcpu: 8, memoryMb: 16384, diskGb: 200 });
});

test('sellable: whole servers that still fit, and the resource that runs out first', async () => {
  const { sellable } = await import('./sizing.ts');
  assert.deepEqual(sellable({ vcpu: 10, memoryMb: 8192, storageGb: 1000 }, { vcpu: 2, memoryMb: 2048, diskGb: 50 }), { count: 4, limit: 'ram' });
  assert.deepEqual(sellable({ vcpu: 3, memoryMb: 65536, storageGb: 1000 }, { vcpu: 2, memoryMb: 2048, diskGb: 50 }), { count: 1, limit: 'cpu' });
  assert.deepEqual(sellable({}, { vcpu: 1, memoryMb: 1024, diskGb: 10 }).count, 0);
});
