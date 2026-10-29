"use client";
// Search, state, tag and sort for a server list (the customer's cards and the admin table). The choices live in
// the URL, so a filtered view can be bookmarked and the back button keeps it.
import { Button, Popover, SearchField } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useState } from 'react';
import { I } from '../../components/icon';
import { ConfirmButton, SelectInput, TextInput } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useApiAction } from '../../lib/query';
import type { Server } from './servers-ui';

const groups = ['all', 'running', 'stopped', 'problem', 'busy', 'trash'] as const;
// Running, stopped, problem, busy (being created or deleted), or waiting out its deletion grace period.
export const stateGroup = (s: Pick<Server, 'state' | 'powerState' | 'deleteAt'>) => s.deleteAt ? 'trash' : s.state === 'ready' ? (s.powerState === 'poweredOn' ? 'running' : 'stopped') : s.state === 'error' || s.state === 'missing' ? 'problem' : 'busy';
const fold = (v: string) => v.toLocaleLowerCase('tr');

export function useServerFilters(servers: Server[]) {
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [state, setState] = useQueryState('state', parseAsStringLiteral(groups).withDefault('all'));
  const [tag, setTag] = useQueryState('tag', parseAsString.withDefault(''));
  const [sort, setSort] = useQueryState('sort', parseAsStringLiteral(['newest', 'name'] as const).withDefault('newest'));
  const needle = fold(q.trim());
  const shown = servers.filter((s) => (state === 'all' || stateGroup(s) === state) && (!tag || !!s.tags?.includes(tag))
    && (!needle || [s.name, s.address, s.location, s.poolName, s.imageName, s.ownerEmail, ...(s.tags ?? [])].some((x) => x && fold(x).includes(needle))))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { shown, servers, q, setQ, state, setState, tag, setTag, sort, setSort };
}

// manageTags: the chosen tag can be renamed or removed on all of the caller's own servers (the customer's list).
export function ServerFilters({ f, placeholder, manageTags }: { f: ReturnType<typeof useServerFilters>; placeholder: string; manageTags?: boolean }) {
  const t = useTranslations('Servers');
  const tags = [...new Set(f.servers.flatMap((s) => s.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const counts = f.servers.reduce<Record<string, number>>((acc, s) => { acc[stateGroup(s)] = (acc[stateGroup(s)] ?? 0) + 1; return acc; }, {});
  return <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
    <SearchField aria-label={t('list.search')} value={f.q} onChange={(v) => f.setQ(v || null)} className="w-full md:w-72">
      <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={placeholder}/><SearchField.ClearButton/></SearchField.Group>
    </SearchField>
    <div role="group" aria-label={t('list.state')} className="flex flex-wrap gap-1.5">
      {groups.filter((k) => k === 'all' || counts[k] || f.state === k).map((k) => <button key={k} type="button" aria-pressed={f.state === k} onClick={() => f.setState(k === 'all' ? null : k)}
        className={`min-h-11 rounded-lg border px-3 text-sm transition-colors duration-150 ${f.state === k ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
        {t(`list.filter.${k}`)} <span className="tabular-nums text-muted">{k === 'all' ? f.servers.length : counts[k] ?? 0}</span></button>)}
    </div>
    {tags.length > 0 && <SelectInput className="w-full md:w-48" label={t('list.tag')} value={f.tag} onChange={(v) => f.setTag(v || null)} options={[{ id: '', label: t('list.allTags') }, ...tags.map((x) => ({ id: x, label: x }))]}/>}
    {manageTags && f.tag && tags.includes(f.tag) && <TagTools tag={f.tag} onDone={(next) => f.setTag(next)}/>}
    <SelectInput className="w-full md:ml-auto md:w-44" label={t('list.sort')} value={f.sort} onChange={(v) => f.setSort(v === 'name' ? 'name' : null)}
      options={[{ id: 'newest', label: t('list.newest') }, { id: 'name', label: t('list.byName') }]}/>
  </div>;
}

// Rename the chosen tag (merged into an existing one of the same name) or take it off every server.
function TagTools({ tag, onDone }: { tag: string; onDone: (next: string | null) => void }) {
  const t = useTranslations('Servers.list.tags');
  const [name, setName] = useState(tag);
  const run = useApiAction((to: string | null) => apiFetch<{ changed: number }>('/servers/tags', { method: 'PUT', body: { from: tag, to } }).then((r) => ({ ...r, to })),
    { invalidate: [['servers']], success: (r) => (r.to ? t('renamed', { n: r.changed }) : t('removed', { n: r.changed })), onSuccess: (r) => onDone(r.to) });
  return <div className="flex flex-wrap gap-2 md:mb-0.5">
    <Popover onOpenChange={(open) => open && setName(tag)}>
      <Button size="sm" variant="secondary" className="min-h-11"><I name="pencil" size={15}/>{t('rename')}</Button>
      <Popover.Content placement="bottom" className="w-[18rem] max-w-[calc(100vw-1.5rem)]">
        <Popover.Dialog>
          <Popover.Heading className="mb-2 text-sm font-semibold">{t('renameTitle', { tag })}</Popover.Heading>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== tag) run.mutate(name.trim()); }}>
            <TextInput className="flex-1" label={t('newName')} value={name} onChange={setName} maxLength={24}/>
            <Button type="submit" size="sm" isPending={run.isPending} isDisabled={!name.trim() || name.trim() === tag}>{t('save')}</Button>
          </form>
          <p className="mt-2 text-xs text-muted">{t('renameHelp')}</p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
    <ConfirmButton size="sm" variant="danger-soft" icon={<I name="tag" size={15}/>} label={t('remove')} title={t('removeTitle', { tag })} body={t('removeBody', { tag })}
      confirmLabel={t('remove')} cancelLabel={t('cancel')} onConfirm={() => run.mutateAsync(null).then(() => undefined)}/>
  </div>;
}
