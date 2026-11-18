"use client";
// Search, state, tag and sort for a server list (the customer's cards and the admin table). The choices live in
// the URL, so a filtered view can be bookmarked and the back button keeps it.
import { Button, Popover, SearchField } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useState } from 'react';
import { I } from '../../components/icon';
import { SavedViews } from '../../components/saved-views';
import { ConfirmButton, SelectInput, TextInput } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { fold } from '../../lib/note-line';
import { useApiAction, useApiQuery } from '../../lib/query';
import type { Server } from './servers-ui';

const groups = ['all', 'running', 'stopped', 'problem', 'busy', 'trash'] as const;
// Running, stopped, problem, busy (being created or deleted), or waiting out its deletion grace period.
export const stateGroup = (s: Pick<Server, 'state' | 'powerState' | 'deleteAt'>) => s.deleteAt ? 'trash' : s.state === 'ready' ? (s.powerState === 'poweredOn' ? 'running' : 'stopped') : s.state === 'error' || s.state === 'missing' ? 'problem' : 'busy';

const attention = ['problem', 'busy', 'stopped', 'running', 'trash'];
// What a saved view of each list holds: its address parameters and the value each has when absent.
const ownViews = { q: '', state: 'all', tag: '', project: '', sort: 'newest' };
const staffViews = { q: '', state: 'all', tag: '', owner: '', sort: 'newest', starred: 'false' };

export function useServerFilters(all: Server[]) {
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [state, setState] = useQueryState('state', parseAsStringLiteral(groups).withDefault('all'));
  const [tag, setTag] = useQueryState('tag', parseAsString.withDefault(''));
  const [project, setProject] = useQueryState('project', parseAsString.withDefault('')); // the customer's own projects; "none" = in no project
  const [owner, setOwner] = useQueryState('owner', parseAsString.withDefault('')); // staff: one customer's servers, by exact e-mail
  const [sort, setSort] = useQueryState('sort', parseAsStringLiteral(['newest', 'name', 'size', 'price', 'state'] as const).withDefault('newest'));
  const servers = owner ? all.filter((s) => s.ownerEmail === owner) : all; // the counts and tags follow the chosen owner too
  const needle = fold(q.trim());
  const shown = servers.filter((s) => (state === 'all' || stateGroup(s) === state) && (!tag || !!s.tags?.includes(tag))
    && (!project || (project === 'none' ? !s.projectId : s.projectId === project))
    && (!needle || [s.name, s.address, s.location, s.poolName, s.imageName, s.ownerEmail, s.notes, ...(s.tags ?? [])].some((x) => x && fold(x).includes(needle))))
    // Names sort numerically (web-2 before web-10); size puts the biggest machines (RAM, then vCPU) first;
    // state puts what needs a look first (problems, then busy, stopped, running, trash), newest first within each.
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : sort === 'size' ? b.memoryMb - a.memoryMb || b.vcpu - a.vcpu
      : sort === 'price' ? Number(b.priceMonthly) - Number(a.priceMonthly) || a.name.localeCompare(b.name, undefined, { numeric: true })
      : (sort === 'state' ? attention.indexOf(stateGroup(a)) - attention.indexOf(stateGroup(b)) : 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const filtered = !!q || state !== 'all' || !!tag || !!project;
  const clear = () => { void setQ(null); void setState(null); void setTag(null); void setProject(null); };
  return { shown, servers, q, setQ, state, setState, tag, setTag, project, setProject, owner, setOwner, sort, setSort, filtered, clear };
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
    {f.owner && <button type="button" onClick={() => f.setOwner(null)} aria-label={t('list.ownerClear', { email: f.owner })}
      className="flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-accent bg-accent-soft px-3 text-sm text-accent-soft-foreground">
      <I name="user" size={14}/><span className="truncate">{f.owner}</span><I name="x" size={14}/></button>}
    <div role="group" aria-label={t('list.state')} className="flex flex-wrap gap-1.5">
      {groups.filter((k) => k === 'all' || counts[k] || f.state === k).map((k) => <button key={k} type="button" aria-pressed={f.state === k} onClick={() => f.setState(k === 'all' ? null : k)}
        className={`min-h-11 rounded-lg border px-3 text-sm transition-colors duration-150 ${f.state === k ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
        {t(`list.filter.${k}`)} <span className="tabular-nums text-muted">{k === 'all' ? f.servers.length : counts[k] ?? 0}</span></button>)}
    </div>
    {/* A few tags are one tap each (with how many servers carry them); many go in a menu. */}
    {tags.length > 0 && tags.length <= 12 ? <div role="group" aria-label={t('list.tag')} className="flex flex-wrap gap-1.5">
      {tags.map((x) => <button key={x} type="button" aria-pressed={f.tag === x} onClick={() => f.setTag(f.tag === x ? null : x)}
        className={`flex min-h-11 items-center gap-1 rounded-lg border border-dashed px-3 text-sm transition-colors duration-150 ${f.tag === x ? 'border-solid border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>
        <I name="tag" size={13} className="text-muted"/>{x} <span className="tabular-nums text-muted">{f.servers.filter((s) => s.tags?.includes(x)).length}</span></button>)}
    </div>
    : tags.length > 12 && <SelectInput className="w-full md:w-48" label={t('list.tag')} value={f.tag} onChange={(v) => f.setTag(v || null)} options={[{ id: '', label: t('list.allTags') }, ...tags.map((x) => ({ id: x, label: x }))]}/>}
    {manageTags && f.tag && tags.includes(f.tag) && <TagTools tag={f.tag} onDone={(next) => f.setTag(next)}/>}
    {manageTags && <ProjectFilter f={f}/>}
    {f.filtered && <Button variant="ghost" className="min-h-11 self-start md:self-auto" onPress={f.clear}><I name="funnel-x" size={15}/>{t('list.clearFilters')}</Button>}
    {/* The customer's list and the staff table keep their views apart (the staff one also holds the owner and the favourites switch). */}
    <SavedViews list={manageTags ? 'servers' : 'admin-servers'} keys={manageTags ? ownViews : staffViews} className="self-start md:self-auto"/>
    <SelectInput className="w-full md:ml-auto md:w-60" label={t('list.sort')} value={f.sort} onChange={(v) => f.setSort(v === 'name' || v === 'size' || v === 'price' || v === 'state' ? v : null)}
      options={[{ id: 'newest', label: t('list.newest') }, { id: 'name', label: t('list.byName') }, { id: 'size', label: t('list.bySize') }, { id: 'price', label: t('list.byPrice') }, { id: 'state', label: t('list.byState') }]}/>
  </div>;
}

// Only when the customer has projects: each with how many servers it holds, and the servers in none.
function ProjectFilter({ f }: { f: ReturnType<typeof useServerFilters> }) {
  const t = useTranslations('Servers.list');
  const projects = useApiQuery<{ projects: { id: string; name: string }[] }>(['projects'], '/projects').data?.projects ?? [];
  if (!projects.length && !f.project) return null;
  const n = (id: string | null) => f.servers.filter((s) => (s.projectId ?? null) === id).length;
  return <SelectInput className="w-full md:w-52" label={t('project')} value={f.project} onChange={(v) => f.setProject(v || null)}
    options={[{ id: '', label: t('allProjects') }, ...projects.map((p) => ({ id: p.id, label: `${p.name} (${n(p.id)})` })), { id: 'none', label: `${t('noProject')} (${n(null)})` }]}/>;
}

// What the shown servers add up to (they follow the filters): size, and the monthly price per currency.
export function ServerTotals({ servers }: { servers: Server[] }) {
  const t = useTranslations('Servers.list.totals');
  const format = useFormatter();
  if (servers.length < 2) return null;
  const sum = (k: 'vcpu' | 'memoryMb' | 'diskGb') => servers.reduce((n, s) => n + s[k], 0);
  const money = Object.entries(servers.reduce<Record<string, number>>((acc, s) => { acc[s.currency] = (acc[s.currency] ?? 0) + Number(s.priceMonthly || 0); return acc; }, {}))
    .filter(([, v]) => v > 0).map(([c, v]) => format.number(v, { style: 'currency', currency: c }));
  const item = (icon: string, text: string) => <span className="flex items-center gap-1.5"><I name={icon} size={14} className="text-muted"/>{text}</span>;
  return <p role="status" aria-label={t('label')} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm tabular-nums">
    <span className="font-medium">{t('servers', { n: servers.length })}</span>
    {item('cpu', t('vcpu', { n: sum('vcpu') }))}
    {item('memory-stick', t('memory', { n: Math.round(sum('memoryMb') / 102.4) / 10 }))}
    {item('hard-drive', t('disk', { n: sum('diskGb') }))}
    {money.length > 0 && <span className="flex items-center gap-1.5 sm:ml-auto"><I name="wallet" size={14} className="text-muted"/>{t('monthly', { price: money.join(' + ') })}</span>}
  </p>;
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
