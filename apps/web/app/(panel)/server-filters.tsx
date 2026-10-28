"use client";
// Search, state, tag and sort for a server list (the customer's cards and the admin table). The choices live in
// the URL, so a filtered view can be bookmarked and the back button keeps it.
import { SearchField } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { SelectInput } from '../../components/ui';
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

export function ServerFilters({ f, placeholder }: { f: ReturnType<typeof useServerFilters>; placeholder: string }) {
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
    <SelectInput className="w-full md:ml-auto md:w-44" label={t('list.sort')} value={f.sort} onChange={(v) => f.setSort(v === 'name' ? 'name' : null)}
      options={[{ id: 'newest', label: t('list.newest') }, { id: 'name', label: t('list.byName') }]}/>
  </div>;
}
