// "Usually about 2 minutes" for a running operation: the API's medians of earlier operations of the same kind on this
// installation (GET /operations/estimates, apps/api/src/eta-rules.ts), picked by the server's disk size, and whether
// this one is taking longer than usual. No estimate is shown when the API has none (too little history).
// Pure functions (node --test lib/*.test.ts).

// The kinds the API estimates (eta-rules.ts ETA_KINDS): the ones a person waits for.
export const ETA_KINDS = ['create', 'delete', 'resize', 'reinstall', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'backup_create', 'backup_restore',
  'migrate', 'disk_add', 'image_create'] as const;

export type Estimate = { median: number; p90: number; n: number };
export type SizeGroup = 's' | 'm' | 'l' | 'xl';
export type Estimates = Record<string, { all: Estimate | null; sizes: Partial<Record<SizeGroup, Estimate>> }>;

// The same groups as the API: disks up to 40, 100 and 300 GB, and larger.
export function sizeGroup(diskGb: number | null | undefined): SizeGroup | null {
  if (diskGb == null || !Number.isFinite(diskGb) || diskGb <= 0) return null;
  return diskGb <= 40 ? 's' : diskGb <= 100 ? 'm' : diskGb <= 300 ? 'l' : 'xl';
}

// The estimate for this kind and disk: the size group's when there is one, else the kind's ("all sizes"), else none.
export function pickEstimate(table: Estimates | null | undefined, kind: string, diskGb?: number | null): { e: Estimate; sized: boolean } | null {
  const k = table?.[kind];
  if (!k) return null;
  const g = sizeGroup(diskGb);
  const sized = g ? k.sizes?.[g] : undefined;
  if (sized) return { e: sized, sized: true };
  return k.all ? { e: k.all, sized: false } : null;
}

// A duration as people say it: under a minute, whole minutes (nearest five above ten), or hours to the half.
export type Spoken = { unit: 'under' } | { unit: 'minutes'; n: number } | { unit: 'hours'; n: number };
export function spoken(seconds: number): Spoken {
  if (seconds < 60) return { unit: 'under' };
  const min = seconds / 60;
  if (min < 90) return { unit: 'minutes', n: min < 10 ? Math.max(1, Math.round(min)) : Math.round(min / 5) * 5 };
  return { unit: 'hours', n: Math.round((min / 60) * 2) / 2 };
}

// Longer than usual: past the slower runs (90th percentile) and half as long again as the median, by at least 30 s.
// Said, not acted on: the operation keeps running and the worker's own deadline decides when it fails.
export function isLate(e: Estimate, elapsedSeconds: number): boolean {
  return elapsedSeconds > Math.max(e.p90, e.median * 1.5, e.median + 30);
}
