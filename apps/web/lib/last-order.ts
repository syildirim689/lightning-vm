// The order form starts from the person's newest server: its location, image, package (or custom size) and project,
// as far as the catalog still offers them, and it says so ("Filled in from your last server web-3"). Read from the
// servers list the page already has: nothing is stored for it, and nothing secret is involved (no keys, no password).
// A fresh order only: a draft being composed, "order similar" and a shared order link are left alone.
// Pure (node --test lib/*.test.ts).

export type LastServer = { id: string; name: string; state: string; createdAt: string; poolId: string; imageId: string; packageId: string | null;
  vcpu: number; memoryMb: number; diskGb: number; projectId?: string | null; vdcId?: string | null };
export type OfferedCatalog = { pools: { id: string; custom: object | null }[]; images: { id: string; poolIds?: string[] | null }[]; packages: { id: string; poolIds: string[] }[] };
export type Remembered = { from: string; picked: ('location' | 'image' | 'package' | 'size' | 'project')[];
  patch: { poolId: string; imageId?: string; type?: 'package' | 'custom'; packageId?: string; vcpu?: number; memoryMb?: number; diskGb?: number; projectId?: string } };

export function lastChoices(servers: LastServer[] | undefined, catalog: OfferedCatalog | undefined, projectIds: string[] = []): Remembered | null {
  if (!servers?.length || !catalog) return null;
  const newest = servers.filter((s) => s.state !== 'deleted' && s.state !== 'deleting' && !s.vdcId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!newest) return null;
  const pool = catalog.pools.find((p) => p.id === newest.poolId);
  if (!pool) return null; // that location is no longer sold: nothing to carry over
  const out: Remembered = { from: newest.name, picked: ['location'], patch: { poolId: pool.id } };
  const image = catalog.images.find((i) => i.id === newest.imageId && (!i.poolIds || i.poolIds.includes(pool.id)));
  if (image) { out.patch.imageId = image.id; out.picked.push('image'); }
  const pkg = newest.packageId ? catalog.packages.find((p) => p.id === newest.packageId && p.poolIds.includes(pool.id)) : undefined;
  if (pkg) { Object.assign(out.patch, { type: 'package', packageId: pkg.id }); out.picked.push('package'); }
  else if (!newest.packageId && pool.custom) { Object.assign(out.patch, { type: 'custom', vcpu: newest.vcpu, memoryMb: newest.memoryMb, diskGb: newest.diskGb }); out.picked.push('size'); }
  if (newest.projectId && projectIds.includes(newest.projectId)) { out.patch.projectId = newest.projectId; out.picked.push('project'); }
  return out;
}
