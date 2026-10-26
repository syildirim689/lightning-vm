// "What will you run?" on the order page: typical needs per workload, scaled by expected traffic, and the cheapest
// offer that meets them. Rules of thumb for a starting size; the server can be resized later.
export const workloads = {
  website: { vcpu: 1, memoryMb: 2048, diskGb: 25 },     // a site or blog (WordPress, static + PHP)
  ecommerce: { vcpu: 2, memoryMb: 4096, diskGb: 50 },   // shop with a database on the same server
  database: { vcpu: 2, memoryMb: 8192, diskGb: 80 },    // PostgreSQL / MySQL: memory for the cache matters most
  app: { vcpu: 2, memoryMb: 4096, diskGb: 40 },         // an API or web application
  containers: { vcpu: 4, memoryMb: 8192, diskGb: 80 },  // Docker / Kubernetes node
  game: { vcpu: 4, memoryMb: 8192, diskGb: 50 },        // Minecraft and similar
  mail: { vcpu: 2, memoryMb: 4096, diskGb: 60 },
  dev: { vcpu: 1, memoryMb: 1024, diskGb: 20 },         // development and tests
} as const;
export type Workload = keyof typeof workloads;
export type Traffic = 'low' | 'medium' | 'high';
const scale = { low: { cpu: 1, mem: 1, disk: 1 }, medium: { cpu: 2, mem: 2, disk: 1.5 }, high: { cpu: 4, mem: 4, disk: 2 } } as const;

export type Shape = { vcpu: number; memoryMb: number; diskGb: number };
export function needs(w: Workload, traffic: Traffic, minDiskGb = 0): Shape {
  const b = workloads[w], s = scale[traffic];
  return { vcpu: b.vcpu * s.cpu, memoryMb: b.memoryMb * s.mem, diskGb: Math.max(minDiskGb, Math.ceil((b.diskGb * s.disk) / 5) * 5) };
}
export const fits = (p: Shape, n: Shape) => p.vcpu >= n.vcpu && p.memoryMb >= n.memoryMb && p.diskGb >= n.diskGb;

// The cheapest package that fits; if none fits, the biggest one (and the caller says it falls short).
export function pick<P extends Shape & { id: string; priceMonthly: string }>(packages: P[], n: Shape): { pkg: P | null; enough: boolean } {
  const ok = packages.filter((p) => fits(p, n)).sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly));
  if (ok.length) return { pkg: ok[0], enough: true };
  const big = [...packages].sort((a, b) => b.vcpu * 1024 + b.memoryMb - (a.vcpu * 1024 + a.memoryMb))[0] ?? null;
  return { pkg: big, enough: false };
}

// A custom shape snapped up to the offer's steps and clamped to its range.
export function snap(n: Shape, r: { cpuMin: number; cpuMax: number; cpuStep: number; memoryMinMb: number; memoryMaxMb: number; memoryStepMb: number; diskMinGb: number; diskMaxGb: number; diskStepGb: number }): Shape {
  const up = (v: number, min: number, max: number, step: number) => Math.min(max, Math.max(min, min + Math.ceil((v - min) / step) * step));
  return { vcpu: up(n.vcpu, r.cpuMin, r.cpuMax, r.cpuStep), memoryMb: up(n.memoryMb, r.memoryMinMb, r.memoryMaxMb, r.memoryStepMb), diskGb: up(n.diskGb, r.diskMinGb, r.diskMaxGb, r.diskStepGb) };
}

// How many more servers of a shape fit in a pool's free capacity, and which resource runs out first.
export function sellable(available: { vcpu?: number; memoryMb?: number; storageGb?: number }, s: Shape): { count: number; limit: 'cpu' | 'ram' | 'disk' } {
  const by = [['cpu', (available.vcpu ?? 0) / s.vcpu], ['ram', (available.memoryMb ?? 0) / s.memoryMb], ['disk', (available.storageGb ?? 0) / s.diskGb]] as const;
  const [limit, n] = by.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { count: Math.max(0, Math.floor(n)), limit };
}
