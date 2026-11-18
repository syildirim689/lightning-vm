"use client";
// Saved views for a list whose filters live in the address: name the current filters and order, come back to them
// with one press, make one the default for when the list opens without filters. A menu button that sits next to the
// filters; the views are kept in this browser for the signed-in person (lib/saved-views.ts).
import { Button, Popover, toast } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryStates } from 'nuqs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMe } from '../lib/me';
import { activeView, cleanName, defaultFor, deleteView, readViews, renameView, saveView, setDefaultView, viewQuery, viewValues, writeViews,
  VIEW_LIMIT, VIEW_NAME_MAX, type SavedView, type ViewKeys } from '../lib/saved-views';
import { I } from './icon';
import { TextInput } from './ui';

// crypto.randomUUID exists only on HTTPS and localhost; an id for a view only has to be unique in its list.
const newId = () => { try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; } };

// `keys`: the list's own address parameters with the value each has when absent (a constant of the calling module).
export function SavedViews({ list, keys, className = '' }: { list: string; keys: ViewKeys; className?: string }) {
  const t = useTranslations('Views');
  const uid = useMe()?.id;
  const parsers = useMemo(() => Object.fromEntries(Object.keys(keys).map((k) => [k, parseAsString])), [keys]);
  const [values, setValues] = useQueryStates(parsers);
  const current = viewQuery(values, keys);
  const [views, setViews] = useState<SavedView[]>([]);
  const [applied, setApplied] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; error?: string } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const latest = useRef(values);
  latest.current = values;

  // Read once the person is known; the default view is applied then, and only to a list opened without filters.
  const opened = useRef('');
  useEffect(() => {
    if (!uid) return;
    const stored = readViews(uid, list);
    setViews(stored);
    if (opened.current === `${uid}:${list}`) return;
    opened.current = `${uid}:${list}`;
    const first = defaultFor(stored, latest.current, keys);
    if (first) { setApplied(first.id); void setValues(viewValues(first.query, keys)); }
  }, [uid, list, keys, setValues]);

  const { view: active, changed } = activeView(views, current, keys, applied);
  const store = (next: SavedView[]) => {
    if (!uid || !writeViews(uid, list, next)) { toast.warning(t('failed')); return false; }
    setViews(next);
    return true;
  };
  // A control that was pressed may be gone after the change: focus moves to what took its place.
  const focus = (selector: string) => requestAnimationFrame(() => body.current?.querySelector<HTMLElement>(selector)?.focus());
  const apply = (v: SavedView) => { setApplied(v.id); void setValues(viewValues(v.query, keys)); setOpen(false); };
  const reset = () => { setApplied(null); void setValues(viewValues('', keys)); setOpen(false); };
  const typed = cleanName(name);
  const existing = typed ? views.find((v) => v.name.toLocaleLowerCase() === typed.toLocaleLowerCase()) : undefined;
  const full = views.length >= VIEW_LIMIT && !existing;
  const save = () => {
    const r = saveView(views, name, current, newId());
    if (r.error || !store(r.views)) return;
    setApplied(r.id ?? null); setName('');
    toast.success(t(existing ? 'updated' : 'saved', { name: typed }));
  };
  const update = (v: SavedView) => { if (store(views.map((x) => (x.id === v.id ? { ...x, query: current } : x)))) toast.success(t('updated', { name: v.name })); };
  const rename = () => {
    if (!editing) return;
    const r = renameView(views, editing.id, editing.name);
    if (r.error) { setEditing({ ...editing, error: t(r.error === 'taken' ? 'nameTaken' : 'nameNeeded') }); return; }
    if (!store(r.views)) return;
    setEditing(null); focus(`[data-view="${editing.id}"]`);
  };
  const remove = (v: SavedView) => {
    const at = views.indexOf(v);
    if (!store(deleteView(views, v.id))) return;
    if (applied === v.id) setApplied(null);
    focus('[data-view], [data-save] input');
    // Removed by a slip of the hand: the message brings it back to where it was, when there is still room for it.
    toast.success(t('deleted', { name: v.name }), { actionProps: { children: t('undo'), size: 'sm', variant: 'secondary', onPress: () => {
      if (!uid) return;
      const now = readViews(uid, list);
      if (now.length >= VIEW_LIMIT || now.some((x) => x.id === v.id || x.name.toLocaleLowerCase() === v.name.toLocaleLowerCase())) return;
      const back = now.some((x) => x.isDefault) ? { ...v, isDefault: undefined } : v;
      store([...now.slice(0, at), back, ...now.slice(at)]);
    } } });
  };
  const icon = 'min-h-9 min-w-9 shrink-0';

  return <Popover isOpen={open} onOpenChange={(o) => { setOpen(o); if (o && uid) setViews(readViews(uid, list)); if (!o) setEditing(null); }}>
    <Button variant="secondary" isDisabled={!uid} className={`min-h-11 max-w-full ${className}`}
      aria-label={active ? t(changed ? 'triggerChanged' : 'triggerActive', { name: active.name }) : t('title')}>
      <I name={active ? 'bookmark-check' : 'bookmark'} size={15} className="shrink-0"/>
      <span className="max-w-40 truncate">{active ? active.name : t('button')}</span>
      {active && changed && <span aria-hidden title={t('changed')} className="size-2 shrink-0 rounded-full bg-warning"/>}
      <I name="chevron-down" size={14} className="shrink-0 text-muted"/>
    </Button>
    <Popover.Content placement="bottom" className="w-[22rem] max-w-[calc(100vw-1.5rem)]">
      <Popover.Dialog>
        <div ref={body} className="flex flex-col gap-3">
          <Popover.Heading className="text-sm font-semibold">{t('title')}</Popover.Heading>
          {active && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-default px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t(changed ? 'statusChanged' : 'statusActive', { name: active.name })}</span>
            {changed && <Button size="sm" variant="secondary" onPress={() => update(active)}><I name="save" size={14}/>{t('update')}</Button>}
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
                  <Button size="sm" variant="ghost" isIconOnly className={icon} aria-pressed={!!v.isDefault} aria-label={t(v.isDefault ? 'clearDefault' : 'makeDefault', { name: v.name })}
                    onPress={() => store(setDefaultView(views, v.isDefault ? null : v.id))}><I name="star" size={15} className={v.isDefault ? 'fill-current text-warning' : 'text-muted'}/></Button>
                  <Button size="sm" variant="ghost" isIconOnly className={icon} aria-label={t('rename', { name: v.name })}
                    onPress={() => { setEditing({ id: v.id, name: v.name }); focus('[data-rename] input'); }}><I name="pencil" size={15} className="text-muted"/></Button>
                  <Button size="sm" variant="ghost" isIconOnly className={icon} aria-label={t('delete', { name: v.name })} onPress={() => remove(v)}><I name="trash-2" size={15} className="text-danger"/></Button>
                </li>)}
          </ul>}
          {views.some((v) => v.isDefault) && <p className="text-xs text-muted">{t('defaultHelp')}</p>}
          <form data-save className="flex flex-col gap-2 border-t border-separator pt-3" onSubmit={(e) => { e.preventDefault(); if (typed && current && !full) save(); }}>
            <div className="flex items-end gap-2">
              <TextInput className="min-w-0 flex-1" label={t('saveCurrent')} value={name} onChange={setName} maxLength={VIEW_NAME_MAX} placeholder={t('namePlaceholder')} isDisabled={!current} transient/>
              <Button type="submit" size="sm" isDisabled={!typed || !current || full}><I name="plus" size={14}/>{t(existing ? 'update' : 'save')}</Button>
            </div>
            <p className="text-xs text-muted" aria-live="polite">{!current ? t('nothing') : full ? t('limit', { max: VIEW_LIMIT }) : existing ? t('overwrite', { name: existing.name }) : t('storedHere')}</p>
          </form>
          {current && <div><Button size="sm" variant="ghost" onPress={reset}><I name="funnel-x" size={14}/>{t('reset')}</Button></div>}
        </div>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
