// The admin dashboard's setup checklist (GET /admin/onboarding, apps/api/src/onboarding-rules.ts). "Hide until
// something changes" remembers which steps were still open when it was pressed; the list comes back as soon as a step
// is open that was not open then (a regression, or a new step). Kept in this browser only (a preference: it names
// nobody's data). Pure (node --test lib/*.test.ts).

export type SetupStep = { key: string; group: 'start' | 'health'; done: boolean; link: string; detail?: Record<string, string | number> };
export const HIDDEN_KEY = 'lvm-setup-hidden';

export function parseHidden(raw: string | null | undefined): string[] | null {
  try { const v = JSON.parse(raw ?? 'null'); return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null; } catch { return null; }
}

export const openKeys = (steps: SetupStep[]) => steps.filter((s) => !s.done).map((s) => s.key);

// Shown while anything is open, unless it was put away with exactly these (or more) steps open.
export function checklistShown(steps: SetupStep[], hidden: string[] | null): boolean {
  const open = openKeys(steps);
  if (!open.length) return false;
  return !hidden || open.some((k) => !hidden.includes(k));
}

// The steps that brought the list back after it was put away: said at the top, so the reason is plain.
export const reopenedBy = (steps: SetupStep[], hidden: string[] | null) => (hidden ? openKeys(steps).filter((k) => !hidden.includes(k)) : []);
