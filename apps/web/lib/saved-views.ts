// Saved views of a list: a name for the filters and the order the address holds. Kept in this browser, per user and
// per list, so a shared computer does not mix two people's views. Everything read from storage is treated as data:
// only well-formed views survive, and only the list's own parameters are ever written back to the address.
export type SavedView = { id: string; name: string; query: string; isDefault?: boolean };
// The list's parameters and the value each has when it is absent from the address ('' unless the list says otherwise).
export type ViewKeys = Record<string, string>;
export const VIEW_LIMIT = 12;
export const VIEW_NAME_MAX = 40;
const QUERY_MAX = 2000;

export const viewsKey = (userId: string, list: string) => `lvm:views:${userId}:${list}`;

// One spelling for a name: no line breaks, single spaces, no longer than the limit.
export const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, VIEW_NAME_MAX).trim();
const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

// The list's state as one comparable text: only its own parameters, without those at their default, sorted by name.
export function viewQuery(values: Record<string, string | null | undefined> | URLSearchParams | string, keys: ViewKeys): string {
  const read = typeof values === 'string' ? new URLSearchParams(values) : values;
  const get = (k: string) => (read instanceof URLSearchParams ? read.get(k) : read[k]);
  const out = new URLSearchParams();
  for (const k of Object.keys(keys).sort()) {
    const v = get(k);
    if (typeof v === 'string' && v !== keys[k]) out.set(k, v);
  }
  return out.toString();
}

// What applying a view writes: every parameter of the list, null for those the view leaves at their default.
export function viewValues(query: string, keys: ViewKeys): Record<string, string | null> {
  const read = new URLSearchParams(query);
  return Object.fromEntries(Object.keys(keys).map((k) => { const v = read.get(k); return [k, v === null || v === keys[k] ? null : v]; }));
}

export function parseViews(raw: string | null | undefined, limit = VIEW_LIMIT): SavedView[] {
  let v: unknown;
  try { v = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: SavedView[] = [];
  let hasDefault = false;
  for (const x of v) {
    if (out.length >= limit) break;
    if (!x || typeof x !== 'object') continue;
    const { id, name, query, isDefault } = x as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.length > 64 || typeof name !== 'string' || typeof query !== 'string' || query.length > QUERY_MAX) continue;
    const clean = cleanName(name);
    if (!clean || out.some((o) => o.id === id || sameName(o.name, clean))) continue;
    // Only one default: the first one marked wins.
    const def = isDefault === true && !hasDefault;
    if (def) hasDefault = true;
    out.push({ id, name: clean, query, ...(def ? { isDefault: true } : {}) });
  }
  return out;
}

export type ViewChange = { views: SavedView[]; error?: 'name' | 'limit' | 'taken' | 'missing'; id?: string };

// A new view, or new filters for the view that already has this name (its id and default mark stay).
export function saveView(views: SavedView[], name: string, query: string, newId: string, limit = VIEW_LIMIT): ViewChange {
  const clean = cleanName(name);
  if (!clean) return { views, error: 'name' };
  const q = query.slice(0, QUERY_MAX);
  const existing = views.find((v) => sameName(v.name, clean));
  if (existing) return { views: views.map((v) => (v === existing ? { ...v, name: clean, query: q } : v)), id: existing.id };
  if (views.length >= limit) return { views, error: 'limit' };
  return { views: [...views, { id: newId, name: clean, query: q }], id: newId };
}

export function renameView(views: SavedView[], id: string, name: string): ViewChange {
  const clean = cleanName(name);
  if (!clean) return { views, error: 'name' };
  if (!views.some((v) => v.id === id)) return { views, error: 'missing' };
  if (views.some((v) => v.id !== id && sameName(v.name, clean))) return { views, error: 'taken' };
  return { views: views.map((v) => (v.id === id ? { ...v, name: clean } : v)), id };
}

export const deleteView = (views: SavedView[], id: string): SavedView[] => views.filter((v) => v.id !== id);

// Marks one view as the default (null: none).
export const setDefaultView = (views: SavedView[], id: string | null): SavedView[] =>
  views.map(({ isDefault: _, ...v }) => (v.id === id ? { ...v, isDefault: true } : v));

// The view to apply when the list opens: the default one, and only when the address carries none of the list's
// parameters. A parameter that is present (a link, a bookmark, the back button) is never overridden.
export function defaultFor(views: SavedView[], present: Record<string, string | null | undefined> | URLSearchParams | string, keys: ViewKeys): SavedView | null {
  const read = typeof present === 'string' ? new URLSearchParams(present) : present;
  const has = (k: string) => (read instanceof URLSearchParams ? read.has(k) : typeof read[k] === 'string');
  if (Object.keys(keys).some(has)) return null;
  const view = views.find((v) => v.isDefault);
  return view && viewQuery(view.query, keys) ? view : null;
}

// The view shown as active: the one applied last while it still exists, else one whose filters match exactly.
// `changed` says the list no longer shows what that view holds.
export function activeView(views: SavedView[], current: string, keys: ViewKeys, appliedId?: string | null): { view: SavedView | null; changed: boolean } {
  const applied = appliedId ? views.find((v) => v.id === appliedId) : undefined;
  if (applied) return { view: applied, changed: viewQuery(applied.query, keys) !== current };
  const match = current ? views.find((v) => viewQuery(v.query, keys) === current) : undefined;
  return { view: match ?? null, changed: false };
}

export function readViews(userId: string, list: string): SavedView[] {
  try { return parseViews(localStorage.getItem(viewsKey(userId, list))); } catch { return []; }
}
// False when the browser would not keep it (storage blocked or full).
export function writeViews(userId: string, list: string, views: SavedView[]): boolean {
  try {
    if (views.length) localStorage.setItem(viewsKey(userId, list), JSON.stringify(views)); else localStorage.removeItem(viewsKey(userId, list));
    return true;
  } catch { return false; }
}
