// Saved views of a list: a name for the filters and the order the address holds. Kept with the account (the API's
// /saved-views), per person and per list; nothing about them stays in the browser, where a search term or a customer's
// address typed by staff would outlive the session. Everything read back is treated as data: only well-formed views
// survive, and only the list's own parameters are ever written to the address.
export type SavedView = { id: string; name: string; query: string; isDefault?: boolean };
// The list's parameters and the value each has when it is absent from the address ('' unless the list says otherwise).
export type ViewKeys = Record<string, string>;
export const VIEW_LIMIT = 12;
export const VIEW_NAME_MAX = 60;
const QUERY_MAX = 2000;

// Where an earlier version kept a person's views of a list in the browser (read once more, to move them; see below).
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

// ---- The account's copy (API) ----
// The API holds a view's filters as { parameter: text }; here they are one query text (viewQuery's spelling).
export type ApiView = { id: string; name: string; params: Record<string, string>; isDefault: boolean };
// lib/api.ts apiFetch, handed in so this module stays free of the browser.
export type ViewCall = <T = unknown>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<T>;
export const viewsPath = (list: string) => `/saved-views?list=${encodeURIComponent(list)}`;

// What is sent for a query text: the list's own parameters it names.
export function viewParams(query: string, keys: ViewKeys): Record<string, string> {
  const read = new URLSearchParams(query);
  return Object.fromEntries(Object.keys(keys).filter((k) => read.has(k)).map((k) => [k, read.get(k)!]));
}

// The answer of the API as views of this list: malformed entries are dropped, foreign parameters ignored.
export function fromApi(rows: unknown, keys: ViewKeys, limit = VIEW_LIMIT): SavedView[] {
  if (!Array.isArray(rows)) return [];
  return parseViews(JSON.stringify(rows.map((r) => {
    const { id, name, params, isDefault } = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const values = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : null;
    return values ? { id, name, isDefault, query: viewQuery(Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string')) as Record<string, string>, keys) } : null;
  })), limit);
}
const one = (row: unknown, keys: ViewKeys): SavedView => {
  const [view] = fromApi([row], keys);
  if (!view) throw { code: 'UNKNOWN' };
  return view;
};

export const fetchViews = async (call: ViewCall, list: string, keys: ViewKeys, signal?: AbortSignal) =>
  fromApi((await call<{ views?: unknown }>(viewsPath(list), { signal }))?.views, keys);
export const createView = async (call: ViewCall, list: string, view: { name: string; query: string; isDefault?: boolean }, keys: ViewKeys) =>
  one(await call('/saved-views', { method: 'POST', body: { list, name: view.name, params: viewParams(view.query, keys), ...(view.isDefault && { isDefault: true }) } }), keys);
export const changeView = async (call: ViewCall, id: string, change: { name?: string; query?: string; isDefault?: boolean }, keys: ViewKeys) =>
  one(await call(`/saved-views/${encodeURIComponent(id)}`, { method: 'PATCH', body: {
    ...(change.name !== undefined && { name: change.name }), ...(change.query !== undefined && { params: viewParams(change.query, keys) }),
    ...(change.isDefault !== undefined && { isDefault: change.isDefault }) } }), keys);
export const removeView = (call: ViewCall, id: string) => call<void>(`/saved-views/${encodeURIComponent(id)}`, { method: 'DELETE' });

const codeOf = (e: unknown) => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined);
// An API from before views were kept with the account has no such route: the control then hides itself.
export const routeMissing = (e: unknown) => codeOf(e) === 'NOT_FOUND';
// A refusal that will not change by asking again (the name is taken, the list is full, a value is not accepted).
const refused = (e: unknown) => codeOf(e) === 'VALIDATION_FAILED' || codeOf(e) === 'LIMIT_REACHED';

// ---- What an earlier version left in the browser ----
const LOCAL_PREFIX = 'lvm:views:';
type Store = Pick<Storage, 'getItem' | 'removeItem' | 'key' | 'length'>;
const browserStore = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
const moving = new Set<string>();

// One time per person and list: the views this browser still holds are sent to the account (those whose name the
// account already has, and those that hold nothing for this list, are left out), then the browser's copy is removed.
// When the API cannot be reached, or says "not now", the copy stays for the next visit; what was already sent is then
// found by its name. Nothing is ever written to the browser. Answers the account's views after the move.
export async function moveLocalViews(call: ViewCall, userId: string, list: string, keys: ViewKeys, server: SavedView[], store: Store | null = browserStore()): Promise<SavedView[]> {
  const key = viewsKey(userId, list);
  let raw: string | null = null;
  try { raw = store?.getItem(key) ?? null; } catch { return server; }
  if (raw === null || moving.has(key)) return server;
  moving.add(key);
  let views = server, later = false;
  try {
    for (const local of parseViews(raw)) {
      const query = viewQuery(local.query, keys);
      if (!query || views.some((v) => sameName(v.name, local.name))) continue;
      if (views.length >= VIEW_LIMIT) break;
      try {
        views = [...views, await createView(call, list, { name: local.name, query, isDefault: !!local.isDefault && !views.some((v) => v.isDefault) }, keys)];
      } catch (e) {
        if (refused(e)) continue;
        later = true;
        break;
      }
    }
    if (!later) try { store?.removeItem(key); } catch { /* storage is blocked: nothing to remove */ }
  } finally { moving.delete(key); }
  return views;
}

// Removes every saved view an earlier version left in this browser, whoever it belonged to. Safe to call always
// (no storage, blocked storage, nothing there). Called when a session ends (lib/session-end.ts).
export function forgetLocalViews(store: Store | null = browserStore()) {
  try {
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k?.startsWith(LOCAL_PREFIX)) keys.push(k); }
    for (const k of keys) store.removeItem(k);
  } catch { /* storage is blocked */ }
}
