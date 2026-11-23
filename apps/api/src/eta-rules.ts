// How long an operation usually takes on this installation: the median (and the 90th percentile) of the operations of
// the same kind that finished well before, grouped by the server's disk size, because a copy of 400 GB is not a copy
// of 20 GB. Pure functions (unit tests: test/eta-rules.test.mjs); the query is in servers.ts (GET /operations/estimates).
//
// Honest by construction: with fewer than MIN_SAMPLES finished operations there is no estimate at all, and the panel
// says nothing rather than a guess. A size group with too little history falls back to the kind as a whole, which
// is then said ("all sizes"); a kind with too little history has no estimate.

// Kinds a person waits for. Power actions and the like finish in seconds and need no estimate.
export const ETA_KINDS = ['create', 'delete', 'resize', 'reinstall', 'snapshot_create', 'snapshot_revert', 'snapshot_delete', 'backup_create', 'backup_restore',
  'migrate', 'disk_add', 'image_create'] as const;
export const MIN_SAMPLES = 5;
// Only operations of the last 90 days, at most the newest 200 per kind: a faster storage bought last month counts.
export const WINDOW_DAYS = 90;
export const MAX_PER_KIND = 200;
// A run longer than this waited for something else (a payment, a staff decision, a stuck task): not a duration.
export const MAX_SECONDS = 6 * 3600;

export type SizeGroup = 's' | 'm' | 'l' | 'xl';
// Disk sizes in GB: up to 40, up to 100, up to 300, more.
export function sizeGroup(diskGb: number | null | undefined): SizeGroup | null {
  if (diskGb == null || !Number.isFinite(diskGb) || diskGb <= 0) return null;
  return diskGb <= 40 ? 's' : diskGb <= 100 ? 'm' : diskGb <= 300 ? 'l' : 'xl';
}

export type Estimate = { median: number; p90: number; n: number };
// Nearest-rank percentile of sorted seconds.
const rank = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
export function estimate(seconds: number[]): Estimate | null {
  const ok = seconds.filter((s) => Number.isFinite(s) && s >= 0 && s <= MAX_SECONDS).sort((a, b) => a - b);
  if (ok.length < MIN_SAMPLES) return null;
  const mid = ok.length / 2;
  const median = ok.length % 2 ? ok[Math.floor(mid)] : (ok[mid - 1] + ok[mid]) / 2;
  return { median: Math.round(median), p90: Math.round(rank(ok, 0.9)), n: ok.length };
}

export type Sample = { kind: string; diskGb: number | null; seconds: number };
export type Estimates = Record<string, { all: Estimate | null; sizes: Partial<Record<SizeGroup, Estimate>> }>;
export function estimates(samples: Sample[]): Estimates {
  const out: Estimates = {};
  for (const kind of ETA_KINDS) {
    const mine = samples.filter((s) => s.kind === kind);
    const sizes: Partial<Record<SizeGroup, Estimate>> = {};
    for (const g of ['s', 'm', 'l', 'xl'] as SizeGroup[]) {
      const e = estimate(mine.filter((s) => sizeGroup(s.diskGb) === g).map((s) => s.seconds));
      if (e) sizes[g] = e;
    }
    const all = estimate(mine.map((s) => s.seconds));
    if (all || Object.keys(sizes).length) out[kind] = { all, sizes };
  }
  return out;
}
