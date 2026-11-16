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

test('CPU that was not measured is no sample: null always, and an exact 0 from a platform that cannot measure', async () => {
  const { cpuOf } = await import('../power.mjs');
  assert.equal(cpuOf('vcenter', null), null);
  assert.equal(cpuOf('vcenter', undefined), null);
  assert.equal(cpuOf('vcenter', 0), 0, 'a measured zero is a sample');
  assert.equal(cpuOf('proxmox', 0), 0);
  for (const kind of ['xcpng', 'ovirt', 'libvirt', 'incus']) { assert.equal(cpuOf(kind, 0), null); assert.equal(cpuOf(kind, 150), 150); }
  assert.deepEqual(shares(300, [{ name: 'a', cpuUsedMhz: null }, { name: 'b', cpuUsedMhz: null }]).map((s) => s.watts), [150, 150]);
});

test('a host and servers without CPU figures: an estimated idle-watts sample without utilisation, energy shares, no CPU samples', async () => {
  const { connection, fakeAdapter, fakeDb } = await import('./harness.mjs');
  const { samplePower } = await import('../power.mjs');
  const [a, b] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const run = async (kind, cpu) => {
    const db = fakeDb({ routes: [[/^SELECT \* FROM vmware_connections WHERE status/, () => [connection({ kind })]], [/^SELECT value FROM settings/, () => [{ value: { cpu: false } }]]] });
    fakeAdapter(() => ({ hosts: [{ moref: 'h1', name: 'h1', connected: true, watts: null, cpuUsedMhz: cpu, cpuTotalMhz: 8000, coreMhz: 2000 }],
      vms: [{ name: `lvm-${a}`, host: 'h1', cpuUsedMhz: cpu }, { name: `lvm-${b}`, host: 'h1', cpuUsedMhz: cpu }] }));
    await samplePower(db, () => {});
    return db;
  };
  for (const [kind, cpu] of [['libvirt', 0], ['vcenter', null]]) {
    const db = await run(kind, cpu);
    const host = db.ran(/^INSERT INTO power_samples/)[0].params;
    assert.deepEqual([host[3], host[6], host[7]], ['120.00', 'estimated', null], kind);
    assert.equal(db.ran(/^INSERT INTO server_cpu_samples/).length, 0, kind);
    assert.deepEqual(db.ran(/^INSERT INTO power_server_samples/).map((q) => q.params[1]), ['60.00', '60.00'], kind);
  }
  const measured = await run('vcenter', 0);
  assert.equal(measured.ran(/^INSERT INTO power_samples/)[0].params[7], '0.0000');
  assert.equal(measured.ran(/^INSERT INTO server_cpu_samples/).length, 2, 'a measured zero is stored');
});
