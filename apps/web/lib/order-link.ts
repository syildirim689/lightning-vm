// An order configuration as a link: /order?loc=…&pkg=…&image=…&period=… (or cpu/ram/disk for a custom size).
// Only what the catalog offers is carried: ids of the location, package and image, three numbers and the billing
// period. No name, SSH key, password, coupon, project or firewall ever goes into the address. A link is read as
// untrusted text: every value is checked against the catalog and what does not fit is ignored.
type Range = { cpuMin: number; cpuMax: number; cpuStep: number; memoryMinMb: number; memoryMaxMb: number; memoryStepMb: number; diskMinGb: number; diskMaxGb: number; diskStepGb: number };
export type LinkCatalog = {
  pools: { id: string; custom: Range | null }[];
  packages: { id: string; poolIds: string[] }[];
  images: { id: string; poolIds?: string[] }[];
};
export type LinkDraft = { poolId: string; imageId: string; type: 'package' | 'custom'; packageId: string; vcpu: number; memoryMb: number; diskGb: number; billingCycle: 'monthly' | 'hourly' };
export const orderLinkKeys = ['loc', 'pkg', 'cpu', 'ram', 'disk', 'image', 'period'] as const;

// The query string for a configuration (without the leading "?"). Unset choices are left out.
export function orderLinkQuery(d: LinkDraft): string {
  const p = new URLSearchParams();
  if (d.poolId) p.set('loc', d.poolId);
  if (d.type === 'package') { if (d.packageId) p.set('pkg', d.packageId); }
  else { p.set('cpu', String(d.vcpu)); p.set('ram', String(d.memoryMb)); p.set('disk', String(d.diskGb)); }
  if (d.imageId) p.set('image', d.imageId);
  if (d.billingCycle === 'hourly') p.set('period', 'hourly');
  return p.toString();
}

const whole = (v: string | null) => (v !== null && /^[1-9]\d{0,6}$/.test(v) ? Number(v) : null);
const onStep = (v: number | null, min: number, max: number, step: number) => v !== null && v >= min && v <= max && (step > 0 ? (v - min) % step === 0 : v === min);

// The part of a link that the catalog really offers, as a patch for the order draft; null when nothing in it is
// usable. `current` is the location chosen so far (kept when the link names none), `hourly` whether paying by the
// hour is on for this account.
export function parseOrderLink(params: URLSearchParams, catalog: LinkCatalog, opts: { current?: string; hourly?: boolean } = {}): Partial<LinkDraft> | null {
  const patch: Partial<LinkDraft> = {};
  const linked = catalog.pools.find((p) => p.id === params.get('loc'));
  // A package is taken only where it is sold: at the link's location, else at the current one, else at its first.
  const pkg = catalog.packages.find((p) => p.id === params.get('pkg') && p.poolIds.some((id) => catalog.pools.some((x) => x.id === id)) && (!linked || p.poolIds.includes(linked.id)));
  const here = catalog.pools.find((p) => p.id === opts.current);
  const pool = linked ?? (pkg ? (here && pkg.poolIds.includes(here.id) ? here : catalog.pools.find((p) => pkg.poolIds.includes(p.id))) : here) ?? catalog.pools[0];
  if (!pool) return null;
  if (linked || (pkg && pool.id !== opts.current)) patch.poolId = pool.id;

  if (pkg) { patch.type = 'package'; patch.packageId = pkg.id; }
  else if (pool.custom && !params.has('pkg')) {
    const c = pool.custom;
    const cpu = whole(params.get('cpu')), ram = whole(params.get('ram')), disk = whole(params.get('disk'));
    const size: Partial<LinkDraft> = {};
    if (onStep(cpu, c.cpuMin, c.cpuMax, c.cpuStep)) size.vcpu = cpu!;
    if (onStep(ram, c.memoryMinMb, c.memoryMaxMb, c.memoryStepMb)) size.memoryMb = ram!;
    if (onStep(disk, c.diskMinGb, c.diskMaxGb, c.diskStepGb)) size.diskGb = disk!;
    if (Object.keys(size).length) Object.assign(patch, size, { type: 'custom' as const });
  }

  const image = catalog.images.find((i) => i.id === params.get('image') && (!i.poolIds || i.poolIds.includes(pool.id)));
  if (image) patch.imageId = image.id;

  const period = params.get('period');
  if (period === 'monthly' || (period === 'hourly' && opts.hourly)) patch.billingCycle = period;

  // Moved to another location without a package of the link: the one chosen before may not be sold there (the
  // same reset as picking the location by hand).
  if (patch.poolId && patch.poolId !== opts.current && !pkg && patch.type !== 'custom') patch.packageId = '';
  return Object.keys(patch).length ? patch : null;
}
