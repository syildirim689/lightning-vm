import test from 'node:test';
import assert from 'node:assert/strict';
const { poolCapacity, checkCustom, exceededQuota } = await import('../dist/capacity.js');

const GiB = 1024 ** 3;
const pool = { cpu_overcommit: 4, memory_overcommit: 1, storage_overcommit: 2, reserve_cpu_pct: 10, reserve_memory_pct: 10, reserve_storage_pct: 15 };
const hosts = [{ cpu_cores: 16, memory_bytes: 128 * GiB }, { cpu_cores: 16, memory_bytes: 128 * GiB }];
const datastores = [{ capacity_bytes: 1000 * GiB, free_bytes: 600 * GiB, uncommitted_bytes: 300 * GiB }];
const vms = [{ cpu: 8, memory_mb: 16384, template: false }, { cpu: 2, memory_mb: 4096, template: true }];
const none = { vcpu: 0, memoryMb: 0, diskGb: 0 };

test('physical, headroom, offered, used and available are kept apart', () => {
  const c = poolCapacity(pool, hosts, datastores, vms, none);
  assert.deepEqual(c.physical, { cores: 32, memoryMb: 262144, storageGb: 1000 });
  assert.deepEqual(c.headroom, { cores: 4, memoryMb: 26215, storageGb: 150 });
  // CPU is overcommitted 4x, memory not at all, storage 2x (thin): each on its own.
  assert.deepEqual(c.offered, { vcpu: 112, memoryMb: 235929, storageGb: 1700 });
  // Templates do not run and do not count as used.
  assert.deepEqual([c.used.vcpu, c.used.memoryMb], [8, 16384]);
  // Thin disks: written 400 GB, but 700 GB provisioned (may still grow).
  assert.deepEqual([c.used.storageWrittenGb, c.used.storageProvisionedGb], [400, 700]);
  assert.deepEqual(c.available, { vcpu: 104, memoryMb: 219545, storageGb: 1000 });
  assert.deepEqual(c.warnings, []);
});

test('reservations reduce what is available; nothing goes below zero', () => {
  const c = poolCapacity(pool, hosts, datastores, vms, { vcpu: 200, memoryMb: 1000, diskGb: 50 });
  assert.equal(c.available.vcpu, 0);
  assert.equal(c.available.memoryMb, 219545 - 1000);
});

test('thin over-provisioning and low real free space are reported', () => {
  const tight = [{ capacity_bytes: 1000 * GiB, free_bytes: 100 * GiB, uncommitted_bytes: 500 * GiB }];
  assert.deepEqual(poolCapacity(pool, hosts, tight, [], none).warnings, ['STORAGE_FREE_BELOW_HEADROOM', 'STORAGE_OVERPROVISIONED']);
});

const rule = { cpu_min: 1, cpu_max: 16, cpu_step: 1, memory_min_mb: 1024, memory_max_mb: 65536, memory_step_mb: 1024,
  disk_min_gb: 20, disk_max_gb: 1000, disk_step_gb: 10, min_memory_mb_per_vcpu: 1024, max_memory_mb_per_vcpu: 8192 };

test('custom shapes follow ranges, steps and the RAM-per-vCPU ratio', () => {
  assert.deepEqual(checkCustom(rule, { vcpu: 4, memoryMb: 8192, diskGb: 80 }), {});
  assert.deepEqual(checkCustom(rule, { vcpu: 0, memoryMb: 70000, diskGb: 25 }), { vcpu: 'OUT_OF_RANGE', memoryMb: 'OUT_OF_RANGE', diskGb: 'INVALID_STEP' });
  assert.deepEqual(checkCustom(rule, { vcpu: 1, memoryMb: 16384, diskGb: 20 }), { memoryMb: 'RATIO_NOT_ALLOWED' });
  assert.deepEqual(checkCustom(rule, { vcpu: 2.5, memoryMb: 4096, diskGb: 20 }), { vcpu: 'OUT_OF_RANGE' });
});

test('quota reports every limit one more server would cross; null is unlimited', () => {
  const limits = { max_servers: 2, max_vcpu: 8, max_memory_mb: null, max_disk_gb: 100 };
  assert.deepEqual(exceededQuota(limits, { servers: 1, vcpu: 4, memoryMb: 999999, diskGb: 50 }, { vcpu: 4, memoryMb: 8192, diskGb: 50 }), []);
  assert.deepEqual(exceededQuota(limits, { servers: 2, vcpu: 6, memoryMb: 0, diskGb: 80 }, { vcpu: 4, memoryMb: 8192, diskGb: 50 }), ['servers', 'vcpu', 'diskGb']);
});

test('what a platform can do: from the connection kind and the operations its service account was found to have', async () => {
  const { capabilitiesOf } = await import('../dist/capacity.js');
  const all = { console: true, firewall: true };
  assert.deepEqual(capabilitiesOf('vcenter', all), { console: true, firewall: true, migrate: true, image: true, backup: true, iso: true, metrics: true });
  assert.deepEqual(capabilitiesOf('vcenter', { console: false, firewall: false }), { console: false, firewall: false, migrate: true, image: true, backup: true, iso: true, metrics: true });
  // A standalone ESXi host: nowhere to move to and nothing to clone an image with.
  assert.deepEqual(capabilitiesOf('esxi', { console: true, firewall: false }), { console: true, firewall: false, migrate: false, image: false, backup: true, iso: true, metrics: true });
  // The other adapters answer PLATFORM_NOT_SUPPORTED for all of these, whatever was stored.
  for (const kind of ['proxmox', 'xcpng', 'ovirt', 'hyperv', 'libvirt', 'incus']) {
    // Performance samples: only Proxmox VE among them returns any.
    assert.deepEqual(capabilitiesOf(kind, all), { console: false, firewall: false, migrate: false, image: false, backup: false, iso: false, metrics: kind === 'proxmox' });
  }
  assert.deepEqual(capabilitiesOf('vcenter', null), { console: false, firewall: false, migrate: true, image: true, backup: true, iso: true, metrics: true });
});
