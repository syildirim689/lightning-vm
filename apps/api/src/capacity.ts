// Capacity arithmetic for one resource pool. Every figure is shown separately so that "physical",
// "kept back", "offered", "reserved" and "really used" are never confused.

export type PoolSettings = {
  cpu_overcommit: number; memory_overcommit: number; storage_overcommit: number;
  reserve_cpu_pct: number; reserve_memory_pct: number; reserve_storage_pct: number;
};
export type Host = { cpu_cores: number | null; memory_bytes: number | string | null };
export type Datastore = { capacity_bytes: number | string; free_bytes: number | string; uncommitted_bytes: number | string };
export type Vm = { cpu: number | null; memory_mb: number | null; committed_bytes: number | string | null; template: boolean };
export type Reserved = { vcpu: number; memoryMb: number; diskGb: number };

const GiB = 1024 ** 3;
const n = (v: number | string | null | undefined) => Number(v ?? 0);

export function poolCapacity(p: PoolSettings, hosts: Host[], datastores: Datastore[], vms: Vm[], reserved: Reserved) {
  // vCPUs are counted against physical cores (not hyper-threads); CPU overcommit applies on top.
  const physical = {
    cores: hosts.reduce((s, h) => s + n(h.cpu_cores), 0),
    memoryMb: Math.floor(hosts.reduce((s, h) => s + n(h.memory_bytes), 0) / 1024 ** 2),
    storageGb: Math.floor(datastores.reduce((s, d) => s + n(d.capacity_bytes), 0) / GiB),
  };
  const headroom = {
    cores: Math.ceil((physical.cores * p.reserve_cpu_pct) / 100),
    memoryMb: Math.ceil((physical.memoryMb * p.reserve_memory_pct) / 100),
    storageGb: Math.ceil((physical.storageGb * p.reserve_storage_pct) / 100),
  };
  const offered = {
    vcpu: Math.floor((physical.cores - headroom.cores) * p.cpu_overcommit),
    memoryMb: Math.floor((physical.memoryMb - headroom.memoryMb) * p.memory_overcommit),
    storageGb: Math.floor((physical.storageGb - headroom.storageGb) * p.storage_overcommit),
  };
  const live = vms.filter((v) => !v.template);
  // What already runs there, whoever created it, plus thin disks that may still grow.
  const used = {
    vcpu: live.reduce((s, v) => s + n(v.cpu), 0),
    memoryMb: live.reduce((s, v) => s + n(v.memory_mb), 0),
    storageWrittenGb: Math.ceil(datastores.reduce((s, d) => s + n(d.capacity_bytes) - n(d.free_bytes), 0) / GiB),
    storageProvisionedGb: Math.ceil(datastores.reduce((s, d) => s + n(d.capacity_bytes) - n(d.free_bytes) + n(d.uncommitted_bytes), 0) / GiB),
  };
  const available = {
    vcpu: Math.max(0, offered.vcpu - used.vcpu - reserved.vcpu),
    memoryMb: Math.max(0, offered.memoryMb - used.memoryMb - reserved.memoryMb),
    storageGb: Math.max(0, offered.storageGb - used.storageProvisionedGb - reserved.diskGb),
  };
  // Thin provisioning can promise more than exists; real free space must still cover the headroom.
  const realFreeGb = Math.floor(datastores.reduce((s, d) => s + n(d.free_bytes), 0) / GiB);
  const warnings = [
    ...(realFreeGb < headroom.storageGb ? ['STORAGE_FREE_BELOW_HEADROOM'] : []),
    ...(used.storageProvisionedGb > physical.storageGb ? ['STORAGE_OVERPROVISIONED'] : []),
    ...(used.memoryMb > physical.memoryMb ? ['MEMORY_OVERCOMMITTED'] : []),
  ];
  return { physical, headroom, offered, used, reserved, available, realFreeGb, warnings };
}

export type CustomRule = {
  cpu_min: number; cpu_max: number; cpu_step: number;
  memory_min_mb: number; memory_max_mb: number; memory_step_mb: number;
  disk_min_gb: number; disk_max_gb: number; disk_step_gb: number;
  min_memory_mb_per_vcpu: number; max_memory_mb_per_vcpu: number;
};
export type Shape = { vcpu: number; memoryMb: number; diskGb: number };

// Field codes for a custom server shape; empty when the rule allows it.
export function checkCustom(rule: CustomRule, s: Shape): Record<string, string> {
  const fields: Record<string, string> = {};
  const check = (name: keyof Shape, value: number, min: number, max: number, step: number) => {
    if (!Number.isInteger(value) || value < min || value > max) fields[name] = 'OUT_OF_RANGE';
    else if ((value - min) % step !== 0) fields[name] = 'INVALID_STEP';
  };
  check('vcpu', s.vcpu, rule.cpu_min, rule.cpu_max, rule.cpu_step);
  check('memoryMb', s.memoryMb, rule.memory_min_mb, rule.memory_max_mb, rule.memory_step_mb);
  check('diskGb', s.diskGb, rule.disk_min_gb, rule.disk_max_gb, rule.disk_step_gb);
  if (!fields.vcpu && !fields.memoryMb) {
    const perCpu = s.memoryMb / s.vcpu;
    if (perCpu < rule.min_memory_mb_per_vcpu || perCpu > rule.max_memory_mb_per_vcpu) fields.memoryMb = 'RATIO_NOT_ALLOWED';
  }
  return fields;
}

export type Limits = { max_servers: number | null; max_vcpu: number | null; max_memory_mb: number | null; max_disk_gb: number | null };
export type Usage = { servers: number; vcpu: number; memoryMb: number; diskGb: number };

// Quota fields that one more server of this shape would exceed. NULL limits are unlimited.
export function exceededQuota(limits: Limits, usage: Usage, s: Shape): string[] {
  const over: string[] = [];
  if (limits.max_servers !== null && usage.servers + 1 > limits.max_servers) over.push('servers');
  if (limits.max_vcpu !== null && usage.vcpu + s.vcpu > limits.max_vcpu) over.push('vcpu');
  if (limits.max_memory_mb !== null && usage.memoryMb + s.memoryMb > limits.max_memory_mb) over.push('memoryMb');
  if (limits.max_disk_gb !== null && usage.diskGb + s.diskGb > limits.max_disk_gb) over.push('diskGb');
  return over;
}
