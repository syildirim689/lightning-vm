import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastChoices, type LastServer, type OfferedCatalog } from './last-order.ts';

const catalog: OfferedCatalog = {
  pools: [{ id: 'ist', custom: null }, { id: 'fra', custom: { cpuMin: 1 } }],
  images: [{ id: 'ubuntu', poolIds: null }, { id: 'debian', poolIds: ['fra'] }],
  packages: [{ id: 'small', poolIds: ['ist', 'fra'] }, { id: 'big', poolIds: ['fra'] }],
};
const server = (over: Partial<LastServer>): LastServer => ({ id: 's', name: 'web-1', state: 'ready', createdAt: '2026-11-01T00:00:00Z', poolId: 'ist', imageId: 'ubuntu',
  packageId: 'small', vcpu: 2, memoryMb: 4096, diskGb: 40, projectId: null, vdcId: null, ...over });

test('the newest server gives location, image, package and project, and its name', () => {
  const r = lastChoices([server({ name: 'old', createdAt: '2026-01-01T00:00:00Z', poolId: 'fra' }), server({ name: 'web-3', projectId: 'p1' })], catalog, ['p1']);
  assert.deepEqual(r, { from: 'web-3', picked: ['location', 'image', 'package', 'project'], patch: { poolId: 'ist', imageId: 'ubuntu', type: 'package', packageId: 'small', projectId: 'p1' } });
});

test('a custom size is carried over only where the location sells custom sizes', () => {
  assert.deepEqual(lastChoices([server({ poolId: 'fra', packageId: null, vcpu: 4, memoryMb: 8192, diskGb: 80 })], catalog)?.patch,
    { poolId: 'fra', imageId: 'ubuntu', type: 'custom', vcpu: 4, memoryMb: 8192, diskGb: 80 });
  assert.deepEqual(lastChoices([server({ packageId: null })], catalog)?.picked, ['location', 'image']);
});

test('what the catalog no longer offers is left out, never guessed', () => {
  assert.deepEqual(lastChoices([server({ imageId: 'debian' })], catalog)?.picked, ['location', 'package'], 'debian is not sold in ist');
  assert.deepEqual(lastChoices([server({ packageId: 'big' })], catalog)?.picked, ['location', 'image'], 'big is not sold in ist');
  assert.equal(lastChoices([server({ poolId: 'gone' })], catalog), null, 'the location itself is gone');
  assert.deepEqual(lastChoices([server({ projectId: 'p-deleted' })], catalog, ['p1'])?.picked, ['location', 'image', 'package']);
});

test('nothing to go by: no servers, only deleted or data-centre servers, or no catalog yet', () => {
  assert.equal(lastChoices([], catalog), null);
  assert.equal(lastChoices(undefined, catalog), null);
  assert.equal(lastChoices([server({ state: 'deleting' }), server({ vdcId: 'v1' })], catalog), null);
  assert.equal(lastChoices([server({})], undefined), null);
});
