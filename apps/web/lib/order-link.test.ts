import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderLinkQuery, parseOrderLink, type LinkCatalog, type LinkDraft } from './order-link.ts';

const custom = { cpuMin: 1, cpuMax: 16, cpuStep: 1, memoryMinMb: 1024, memoryMaxMb: 65536, memoryStepMb: 1024, diskMinGb: 20, diskMaxGb: 500, diskStepGb: 10 };
const catalog: LinkCatalog = {
  pools: [{ id: 'ist', custom }, { id: 'fra', custom: null }],
  packages: [{ id: 'small', poolIds: ['ist', 'fra'] }, { id: 'fra-only', poolIds: ['fra'] }, { id: 'orphan', poolIds: ['gone'] }],
  images: [{ id: 'ubuntu' }, { id: 'debian', poolIds: ['ist'] }],
};
const draft: LinkDraft = { poolId: 'ist', imageId: 'ubuntu', type: 'package', packageId: 'small', vcpu: 2, memoryMb: 4096, diskGb: 40, billingCycle: 'monthly' };
const read = (q: string, opts: { current?: string; hourly?: boolean } = {}) => parseOrderLink(new URLSearchParams(q), catalog, opts);

test('a package configuration survives the round trip', () => {
  const q = orderLinkQuery(draft);
  assert.equal(q, 'loc=ist&pkg=small&image=ubuntu');
  assert.deepEqual(read(q), { poolId: 'ist', type: 'package', packageId: 'small', imageId: 'ubuntu' });
});

test('a custom configuration survives the round trip, with the hourly period only where it is offered', () => {
  const q = orderLinkQuery({ ...draft, type: 'custom', vcpu: 4, memoryMb: 8192, diskGb: 80, billingCycle: 'hourly' });
  assert.equal(q, 'loc=ist&cpu=4&ram=8192&disk=80&image=ubuntu&period=hourly');
  assert.deepEqual(read(q, { hourly: true }), { poolId: 'ist', type: 'custom', vcpu: 4, memoryMb: 8192, diskGb: 80, imageId: 'ubuntu', billingCycle: 'hourly' });
  assert.deepEqual(read(q), { poolId: 'ist', type: 'custom', vcpu: 4, memoryMb: 8192, diskGb: 80, imageId: 'ubuntu' });
});

test('the link carries nothing but the configuration', () => {
  const q = orderLinkQuery({ ...draft, name: 'web-1', sshKeyIds: ['k1'], projectId: 'p', cloneFrom: 's', applicationId: 'a' } as LinkDraft);
  assert.deepEqual([...new URLSearchParams(q).keys()], ['loc', 'pkg', 'image']);
});

test('unknown ids are ignored, the rest is kept', () => {
  assert.deepEqual(read('loc=nowhere&pkg=small&image=nothing', { current: 'ist' }), { type: 'package', packageId: 'small' });
  assert.equal(read('loc=nowhere&pkg=nothing&image=nothing&period=weekly'), null);
  assert.equal(read(''), null);
  assert.equal(read('pkg=orphan'), null);
  assert.equal(read('name=web&sshKeyIds=k1&rootPassword=x', { current: 'ist' }), null);
});

test('a package is only taken where it is sold', () => {
  assert.deepEqual(read('loc=ist&pkg=fra-only'), { poolId: 'ist', packageId: '' });
  assert.deepEqual(read('pkg=fra-only', { current: 'ist' }), { poolId: 'fra', type: 'package', packageId: 'fra-only' });
  assert.deepEqual(read('pkg=small', { current: 'fra' }), { type: 'package', packageId: 'small' });
});

test('an image is only taken where it exists', () => {
  assert.deepEqual(read('loc=fra&image=debian', { current: 'fra' }), { poolId: 'fra' });
  assert.deepEqual(read('loc=ist&image=debian', { current: 'ist' }), { poolId: 'ist', imageId: 'debian' });
});

test('custom sizes must be whole numbers inside the range and on its steps', () => {
  assert.deepEqual(read('loc=ist&cpu=4&ram=8192&disk=80', { current: 'ist' }), { poolId: 'ist', type: 'custom', vcpu: 4, memoryMb: 8192, diskGb: 80 });
  // Out of range, off the step: each value is dropped by itself.
  assert.deepEqual(read('cpu=64&ram=8192&disk=85', { current: 'ist' }), { type: 'custom', memoryMb: 8192 });
  for (const bad of ['cpu=abc', 'cpu=-2', 'cpu=2.5', 'cpu=1e3', 'cpu=0', 'cpu=99999999999', 'cpu=%3Cscript%3E', 'ram=1000', 'disk=25'])
    assert.equal(read(bad, { current: 'ist' }), null, bad);
  // No custom sizes at this location: the numbers mean nothing there.
  assert.deepEqual(read('loc=fra&cpu=4&ram=8192&disk=80'), { poolId: 'fra', packageId: '' });
  // A link that names a package (even an unknown one) is not read as a custom size.
  assert.equal(read('pkg=nothing&cpu=4', { current: 'ist' }), null);
});

test('the period is one of the two known ones', () => {
  assert.deepEqual(read('period=monthly', { current: 'ist' }), { billingCycle: 'monthly' });
  assert.equal(read('period=hourly', { current: 'ist' }), null);
  assert.deepEqual(read('period=hourly', { current: 'ist', hourly: true }), { billingCycle: 'hourly' });
});
