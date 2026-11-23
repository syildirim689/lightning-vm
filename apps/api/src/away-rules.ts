// "While you were away" (GET /notifications/away): which of a person's own notifications belong in the summary and
// under which heading. Pure (unit tests: test/away-rules.test.mjs); away.ts reads the rows.
export type AwayKind = 'done' | 'failed' | 'billing' | 'support';
const kinds: Record<string, AwayKind> = {
  'server.ready': 'done', 'server.backup': 'done', 'server.snapshot': 'done', 'server.power': 'done',
  'server.failed': 'failed', 'server.firewall_failed': 'failed',
  'billing.invoice': 'billing', 'billing.reminder': 'billing', 'billing.overdue': 'billing', 'billing.payment_failed': 'billing',
  'support.reply': 'support',
};
export const awayEvents = Object.keys(kinds);
export const awayDays = 30; // never further back than this, also for a first visit
export const awayMax = 30;  // newest first; the counts cover everything since

export function awaySince(seenAt: Date | null, createdAt: Date, now = Date.now()): Date {
  const floor = now - awayDays * 86_400_000;
  return new Date(Math.max(floor, (seenAt ?? createdAt).getTime()));
}

export type AwayRow = { id: string; event: string; createdAt: Date | string };
export function awaySummary<T extends AwayRow>(rows: T[]) {
  const counts: Record<AwayKind, number> = { done: 0, failed: 0, billing: 0, support: 0 };
  const items: (T & { kind: AwayKind })[] = [];
  for (const r of rows) {
    const kind = kinds[r.event];
    if (!kind) continue;
    counts[kind]++;
    if (items.length < awayMax) items.push({ ...r, kind });
  }
  return { counts, items, total: counts.done + counts.failed + counts.billing + counts.support };
}
