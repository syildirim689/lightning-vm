// The last things the user opened (servers, tickets, invoices), for the command palette and the welcome line. Only
// this browser; storage may be blocked. Entries written before tickets and invoices were recorded have no `kind`:
// they are servers, and the list is still an array of { href, label } under the same key.
export type RecentKind = 'server' | 'ticket' | 'invoice';
export type Recent = { href: string; label: string; kind?: RecentKind };
const KEY = 'lvm-recent';
export const RECENT_LIMIT = 8;

// What an entry points at, from its own field or (older entries) from its address.
export const recentKind = (r: Pick<Recent, 'href' | 'kind'>): RecentKind =>
  r.kind ?? (/\/support\//.test(r.href) ? 'ticket' : /\/billing\/invoices\//.test(r.href) ? 'invoice' : 'server');

// Whatever is in storage is read as data: only panel paths with a label survive, each address once, newest first.
export function parseRecent(raw: string | null | undefined, limit = RECENT_LIMIT): Recent[] {
  let v: unknown;
  try { v = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: Recent[] = [];
  for (const x of v) {
    if (out.length >= limit) break;
    if (!x || typeof x !== 'object') continue;
    const { href, label, kind } = x as Record<string, unknown>;
    if (typeof href !== 'string' || typeof label !== 'string' || !label.trim() || !/^\/(?![/\\])/.test(href) || /[\r\n]/.test(href)) continue;
    if (out.some((r) => r.href === href)) continue;
    out.push({ href, label, ...(kind === 'server' || kind === 'ticket' || kind === 'invoice' ? { kind } : {}) });
  }
  return out;
}

// The newest goes first, an address appears once (its label follows a rename), and the list stays short.
export function mergeRecent(list: Recent[], item: Recent, limit = RECENT_LIMIT): Recent[] {
  return [item, ...list.filter((r) => r.href !== item.href)].slice(0, limit);
}

export function recent(): Recent[] {
  try { return parseRecent(localStorage.getItem(KEY)); } catch { return []; }
}

// The list names the last person's servers, tickets and invoices: it goes when their session ends.
export function clearRecent() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export function remember(item: Recent) {
  try { localStorage.setItem(KEY, JSON.stringify(mergeRecent(recent(), item))); } catch { /* private mode */ }
}
