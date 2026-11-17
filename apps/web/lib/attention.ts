// What waits for staff, as GET /admin/attention answers it: one small read behind the menu's counts and the
// restore-hold bar. A key is absent when the caller may not see that area (or the API is older), which counts as none.
// Pure functions (run with: node --test lib/*.test.ts).
export type Attention = { paymentsInReview?: number; failedOperations?: number; abuse?: number; restoreHold?: { since?: string | null; backup?: string | null } | null };
export type AttentionKind = 'review' | 'failedOps' | 'abuse';

const field = { review: 'paymentsInReview', failedOps: 'failedOperations', abuse: 'abuse' } as const;
export const isAttentionKind = (k: string): k is AttentionKind => Object.hasOwn(field, k);

// A whole count of at least 0, whatever arrived (nothing, a string, a negative).
export function attentionCount(a: Attention | null | undefined, kind: AttentionKind): number {
  const n = Number(a?.[field[kind]] ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
// The number as a badge shows it.
export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));
// The hold as the bar needs it: null when there is none, the moment it began when that can be read.
export function restoreHoldOf(a: Attention | null | undefined): { since: Date | null; backup: string | null } | null {
  const h = a?.restoreHold;
  if (!h || typeof h !== 'object') return null;
  const at = h.since ? new Date(h.since) : null;
  return { since: at && !Number.isNaN(at.getTime()) ? at : null, backup: h.backup || null };
}
