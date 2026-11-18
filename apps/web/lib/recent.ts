// The last things the user opened (servers, tickets, invoices, and for staff the people they looked up), for the
// command palette and the welcome line. Only this browser; storage may be blocked. Entries written before tickets and
// invoices were recorded have no `kind`: they are servers, and the list is still an array of { href, label } under the
// same key.
export type RecentKind = 'server' | 'ticket' | 'invoice' | 'user';
const kinds: readonly unknown[] = ['server', 'ticket', 'invoice', 'user'];
export type Recent = { href: string; label: string; kind?: RecentKind };
const KEY = 'lvm-recent';
export const RECENT_LIMIT = 8;

// What an entry points at, from its own field or (older entries) from its address.
export const recentKind = (r: Pick<Recent, 'href' | 'kind'>): RecentKind =>
  r.kind ?? (/\/support\//.test(r.href) ? 'ticket' : /\/billing\/invoices\//.test(r.href) ? 'invoice' : /^\/admin\/users(?:[/?]|$)/.test(r.href) ? 'user' : 'server');

// Staff pages in the list are shown only to someone who may open them now: the permission the entry's page asks for,
// or null for a page of the person's own (their servers, tickets and invoices). An account that lost the permission,
// or a list left behind in a shared browser, offers nothing it should not.
export function recentPermission(r: Pick<Recent, 'href' | 'kind'>): 'users.view' | 'billing.view' | 'support.view' | 'servers.view_all' | null {
  if (!/^\/admin(?:[/?]|$)/.test(r.href)) return null;
  const kind = recentKind(r);
  return kind === 'user' ? 'users.view' : kind === 'invoice' ? 'billing.view' : kind === 'ticket' ? 'support.view' : 'servers.view_all';
}

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
    out.push({ href, label, ...(kinds.includes(kind) ? { kind: kind as RecentKind } : {}) });
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
