"use client";
// Saved views for a list whose filters live in the address: name the current filters and order, come back to them
// with one press, make one the default for when the list opens without filters. A menu button that sits next to the
// filters. The views are kept with the signed-in person's account (the API's /saved-views, lib/saved-views.ts): a
// change shows at once and is taken back, with a message, when the API refuses it. Nothing is kept in the browser;
// what an earlier version left there is sent to the account once and removed.
import { Button, Popover, toast } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryStates } from 'nuqs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from '../lib/api';
import { useMe } from '../lib/me';
import { activeView, changeView, cleanName, createView, defaultFor, deleteView, fetchViews, moveLocalViews, removeView, renameView, routeMissing, saveView, setDefaultView,
  viewQuery, viewValues, VIEW_LIMIT, VIEW_NAME_MAX, type SavedView, type ViewKeys } from '../lib/saved-views';
import { I } from './icon';
import { TextInput } from './ui';

// A view that was just added carries this id until the API answers with its own.
const NEW = 'new:';
const newId = () => `${NEW}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const none: SavedView[] = [];
// The API's answer in its place in the list (also where the list was read again meanwhile); one default at most.
const put = (now: SavedView[], made: SavedView, at = made.id): SavedView[] => {
  const rest = (x: SavedView): SavedView => (made.isDefault && x.isDefault ? { id: x.id, name: x.name, query: x.query } : x);
  return now.some((x) => x.id === at) ? now.map((x) => (x.id === at ? made : rest(x))) : [...now.filter((x) => x.id !== made.id).map(rest), made];
};

// `keys`: the list's own address parameters with the value each has when absent (a constant of the calling module).
export function SavedViews({ list, keys, className = '' }: { list: string; keys: ViewKeys; className?: string }) {
  const t = useTranslations('Views');
  const { error } = useErrorText();
  const me = useMe();
  const uid = me?.id;
  // Staff signed in as this person see the person's views and change nothing (the API refuses it too).
  const readOnly = !!me?.impersonatedBy;
  const client = useQueryClient();
  const parsers = useMemo(() => Object.fromEntries(Object.keys(keys).map((k) => [k, parseAsString])), [keys]);
  const [values, setValues] = useQueryStates(parsers);
  const current = viewQuery(values, keys);
  const [applied, setApplied] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const latest = useRef(values);
  latest.current = values;

  // The account's views of this list. An API without the route (an older one) answers 404: asked once, and the
  // control then hides itself. Views an earlier version kept in this browser are sent along on the first read.
  const key = useMemo(() => ['saved-views', uid ?? '', list], [uid, list]);
  const query = useQuery<SavedView[]>({
    queryKey: key,
    enabled: !!uid,
    staleTime: 30_000,
    retry: (failures, e) => failures < 1 && !routeMissing(e),
    refetchOnWindowFocus: (q) => !routeMissing(q.state.error),
    queryFn: async ({ signal }) => {
      const server = await fetchViews(apiFetch, list, keys, signal);
      return readOnly ? server : moveLocalViews(apiFetch, uid!, list, keys, server);
    },
  });
  const views = query.data ?? none;
  const loaded = query.data !== undefined;

  // The default view is applied as soon as the views are known (at once when they were read before), once per
  // opening of the list, and only to a list opened without filters: a parameter that is in the address by then,
  // also one chosen while the views were on their way, is never replaced.
  const opened = useRef('');
  useEffect(() => {
    if (!uid || !query.data || opened.current === `${uid}:${list}`) return;
    opened.current = `${uid}:${list}`;
    const first = defaultFor(query.data, latest.current, keys);
    if (first) { setApplied(first.id); void setValues(viewValues(first.query, keys)); }
  }, [uid, list, keys, query.data, setValues]);

  const { view: active, changed } = activeView(views, current, keys, applied);
  const why = (e: unknown) => {
    const { code, fields } = (e ?? {}) as Partial<ApiError>;
    if (code === 'LIMIT_REACHED') return t('limit', { max: VIEW_LIMIT });
    if (fields?.name === 'NAME_TAKEN') return t('nameTaken');
    return t('failed', { reason: error(e) });
  };
  // Shows `next` at once, then asks the API. Its answer takes its place in the list; a refusal puts the list back
  // as it was, says why, and reads the account's views again.
  const change = async <R,>(next: SavedView[], run: () => Promise<R>, settle: (now: SavedView[], result: R) => SavedView[]): Promise<boolean> => {
    await client.cancelQueries({ queryKey: key });
    const before = client.getQueryData<SavedView[]>(key);
    client.setQueryData<SavedView[]>(key, next);
    setBusy((n) => n + 1);
    try {
      const result = await run();
      client.setQueryData<SavedView[]>(key, (now) => settle(now ?? none, result));
      return true;
    } catch (e) {
      client.setQueryData<SavedView[] | undefined>(key, before);
      toast.danger(why(e));
      void client.invalidateQueries({ queryKey: key });
      return false;
    } finally { setBusy((n) => n - 1); }
  };
  // A control that was pressed may be gone after the change: focus moves to what took its place.
  const focus = (selector: string) => requestAnimationFrame(() => body.current?.querySelector<HTMLElement>(selector)?.focus());
  const apply = (v: SavedView) => { setApplied(v.id); void setValues(viewValues(v.query, keys)); setOpen(false); };
  const reset = () => { setApplied(null); void setValues(viewValues('', keys)); setOpen(false); };
  const typed = cleanName(name);
  const existing = typed ? views.find((v) => v.name.toLocaleLowerCase() === typed.toLocaleLowerCase()) : undefined;
  const full = views.length >= VIEW_LIMIT && !existing;
  const save = async () => {
    const r = saveView(views, name, current, newId());
    if (r.error || !r.id) return;
    const was = { name, applied }, target = existing, at = r.id;
    setApplied(at); setName('');
    const ok = await change(r.views, async () => {
      const made = target ? await changeView(apiFetch, target.id, { name: typed, query: current }, keys) : await createView(apiFetch, list, { name: typed, query: current }, keys);
      setApplied((now) => (now === at ? made.id : now));
      return made;
    }, (now, made) => put(now, made, at));
    if (ok) toast.success(t(target ? 'updated' : 'saved', { name: typed }));
    else { setApplied((now) => (now === at ? was.applied : now)); setName((now) => now || was.name); }
  };
  const update = async (v: SavedView) => {
    if (await change(views.map((x) => (x.id === v.id ? { ...x, query: current } : x)), () => changeView(apiFetch, v.id, { query: current }, keys), put)) toast.success(t('updated', { name: v.name }));
  };
  const rename = () => {
    if (!editing) return;
    const r = renameView(views, editing.id, editing.name);
    if (r.error) { setEditing({ ...editing, error: t(r.error === 'taken' ? 'nameTaken' : 'nameNeeded') }); return; }
    setEditing(null); focus(`[data-view="${editing.id}"]`);
    void change(r.views, () => changeView(apiFetch, editing.id, { name: cleanName(editing.name) }, keys), put);
  };
  const star = (v: SavedView) => void change(setDefaultView(views, v.isDefault ? null : v.id), () => changeView(apiFetch, v.id, { isDefault: !v.isDefault }, keys), put);
  const remove = async (v: SavedView) => {
    if (applied === v.id) setApplied(null);
    focus('[data-view], [data-save] input');
    if (!(await change(deleteView(views, v.id), () => removeView(apiFetch, v.id), (now) => deleteView(now, v.id)))) return;
    // Removed by a slip of the hand: the message brings it back (as a new view of the account), when there is still
    // room for it and its name is free.
    toast.success(t('deleted', { name: v.name }), { actionProps: { children: t('undo'), size: 'sm', variant: 'secondary', onPress: () => {
      const now = client.getQueryData<SavedView[]>(key) ?? none;
      if (now.length >= VIEW_LIMIT || now.some((x) => x.name.toLocaleLowerCase() === v.name.toLocaleLowerCase())) return;
      const back: SavedView = { id: newId(), name: v.name, query: v.query, ...(v.isDefault && !now.some((x) => x.isDefault) ? { isDefault: true } : {}) };
      void change([...now, back], () => createView(apiFetch, list, back, keys), (cur, made) => put(cur, made, back.id));
    } } });
  };
  const icon = 'min-h-9 min-w-9 shrink-0';

  // An API that has no saved views: nothing to offer here.
  if (query.isError && routeMissing(query.error)) return null;
  const failed = query.isError && !loaded;

  return <Popover isOpen={open} onOpenChange={(o) => { setOpen(o); if (o && uid && !busy) void query.refetch(); if (!o) setEditing(null); }}>
    <Button variant="secondary" isDisabled={!uid} isPending={!!uid && query.isPending} className={`min-h-11 max-w-full ${className}`}
      aria-label={active ? t(changed ? 'triggerChanged' : 'triggerActive', { name: active.name }) : t('title')}>
      <I name={active ? 'bookmark-check' : 'bookmark'} size={15} className="shrink-0"/>
      <span className="max-w-40 truncate">{active ? active.name : t('button')}</span>
      {active && changed && <span aria-hidden title={t('changed')} className="size-2 shrink-0 rounded-full bg-warning"/>}
      <I name="chevron-down" size={14} className="shrink-0 text-muted"/>
    </Button>
    <Popover.Content placement="bottom" className="w-[22rem] max-w-[calc(100vw-1.5rem)]">
      <Popover.Dialog>
        <div ref={body} className="flex flex-col gap-3" aria-busy={busy > 0 || undefined}>
          <Popover.Heading className="text-sm font-semibold">{t('title')}</Popover.Heading>
          {failed ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-default px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t('loadFailed')} {error(query.error)}</span>
            <Button size="sm" variant="secondary" isPending={query.isFetching} onPress={() => void query.refetch()}><I name="refresh-cw" size={14}/>{t('retry')}</Button>
          </div> : <>
          {active && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-default px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t(changed ? 'statusChanged' : 'statusActive', { name: active.name })}</span>
            {changed && !readOnly && !active.id.startsWith(NEW) && <Button size="sm" variant="secondary" onPress={() => void update(active)}><I name="save" size={14}/>{t('update')}</Button>}
          </div>}
          {views.length === 0 ? <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">{t('empty')}</p>
          : <ul aria-label={t('title')} className="-mx-1 flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto px-1">
            {views.map((v) => editing?.id === v.id
              ? <li key={v.id}><form data-rename className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2" onSubmit={(e) => { e.preventDefault(); rename(); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); focus(`[data-view="${v.id}"]`); } }}>
                  <TextInput className="min-w-0 flex-1" label={t('nameLabel')} value={editing.name} onChange={(x) => setEditing({ id: v.id, name: x })} maxLength={VIEW_NAME_MAX} error={editing.error} transient/>
                  <Button type="submit" size="sm" isDisabled={!cleanName(editing.name)}>{t('save')}</Button>
                  <Button size="sm" variant="tertiary" onPress={() => { setEditing(null); focus(`[data-view="${v.id}"]`); }}>{t('cancel')}</Button>
                </form></li>
              : <li key={v.id} className="flex items-center gap-0.5">
                  <button type="button" data-view={v.id} aria-current={active?.id === v.id ? 'true' : undefined} aria-label={t('apply', { name: v.name })} onClick={() => apply(v)}
                    className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-default focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none ${active?.id === v.id ? 'bg-accent-soft text-accent-soft-foreground' : ''}`}>
                    <I name={active?.id === v.id ? 'check' : 'bookmark'} size={14} className="shrink-0"/>
                    <span className="min-w-0 truncate font-medium">{v.name}</span>
                    {v.isDefault && <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">{t('default')}</span>}
                    {active?.id === v.id && changed && <span className="shrink-0 text-[11px] text-warning">{t('changed')}</span>}
                  </button>
                  {/* Not while it is on its way to the account (it has no id there yet), and not for staff signed in as the person. */}
                  {!readOnly && <>
                    <Button size="sm" variant="ghost" isIconOnly className={icon} isDisabled={v.id.startsWith(NEW)} aria-pressed={!!v.isDefault} aria-label={t(v.isDefault ? 'clearDefault' : 'makeDefault', { name: v.name })}
                      onPress={() => star(v)}><I name="star" size={15} className={v.isDefault ? 'fill-current text-warning' : 'text-muted'}/></Button>
                    <Button size="sm" variant="ghost" isIconOnly className={icon} isDisabled={v.id.startsWith(NEW)} aria-label={t('rename', { name: v.name })}
                      onPress={() => { setEditing({ id: v.id, name: v.name }); focus('[data-rename] input'); }}><I name="pencil" size={15} className="text-muted"/></Button>
                    <Button size="sm" variant="ghost" isIconOnly className={icon} isDisabled={v.id.startsWith(NEW)} aria-label={t('delete', { name: v.name })} onPress={() => void remove(v)}><I name="trash-2" size={15} className="text-danger"/></Button>
                  </>}
                </li>)}
          </ul>}
          {views.some((v) => v.isDefault) && <p className="text-xs text-muted">{t('defaultHelp')}</p>}
          {readOnly ? <p className="border-t border-separator pt-3 text-xs text-muted">{t('readOnly')}</p>
          : <form data-save className="flex flex-col gap-2 border-t border-separator pt-3" onSubmit={(e) => { e.preventDefault(); if (typed && current && !full && !existing?.id.startsWith(NEW)) void save(); }}>
            <div className="flex items-end gap-2">
              <TextInput className="min-w-0 flex-1" label={t('saveCurrent')} value={name} onChange={setName} maxLength={VIEW_NAME_MAX} placeholder={t('namePlaceholder')} isDisabled={!current} transient/>
              <Button type="submit" size="sm" isDisabled={!typed || !current || full || !!existing?.id.startsWith(NEW)}><I name="plus" size={14}/>{t(existing ? 'update' : 'save')}</Button>
            </div>
            <p className="text-xs text-muted" aria-live="polite">{!current ? t('nothing') : full ? t('limit', { max: VIEW_LIMIT }) : existing ? t('overwrite', { name: existing.name }) : t('storedAccount')}</p>
          </form>}
          </>}
          {current && <div><Button size="sm" variant="ghost" onPress={reset}><I name="funnel-x" size={14}/>{t('reset')}</Button></div>}
        </div>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
