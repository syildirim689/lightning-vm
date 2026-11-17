// The last servers the user opened, for the command palette. Only this browser; storage may be blocked.
export type Recent = { href: string; label: string };
const KEY = 'lvm-recent';

export function recent(): Recent[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.slice(0, 5) : []; } catch { return []; }
}

// The list names the last person's servers: it goes when their session ends.
export function clearRecent() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export function remember(item: Recent) {
  try { localStorage.setItem(KEY, JSON.stringify([item, ...recent().filter((r) => r.href !== item.href)].slice(0, 5))); } catch { /* private mode */ }
}
