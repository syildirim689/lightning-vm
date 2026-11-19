"use client";
// Staff support queue: numbers that matter (waiting, overdue, unassigned, first response, rating), filters kept in
// the address, overdue tickets first and each one's deadline.
import { Button, SearchField } from '@heroui/react';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { I } from '../../../../components/icon';
import { SavedViews } from '../../../../components/saved-views';
import { VIEW_LISTS } from '../../../../lib/saved-views';
import { Ago, Empty, PageHeader, SelectInput, Stat } from '../../../../components/ui';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';
import { downloadCsv } from '../../../../lib/csv';
import CannedReplies from './canned';
import { Deadline, departmentName, DraftBadge, PriorityBadge, StatusBadge, useDepartments, useDrafts, type Ticket } from '../../support/ui';

// The status is 'active' when the address does not name one; an empty status means every ticket.
const viewKeys = VIEW_LISTS['admin-support'];
type Stats = { active: number; waiting: number; overdue: number; unassigned: number; firstResponseHours: number | null; rating: number | null };

export default function SupportQueue() {
  const t = useTranslations('Support');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const drafts = useDrafts();
  const deps = useDepartments();
  const me = useMe();
  const [status, setStatus] = useQueryState('status', parseAsString.withDefault('active'));
  const [priority, setPriority] = useQueryState('priority', parseAsString.withDefault(''));
  const [department, setDepartment] = useQueryState('department', parseAsString.withDefault(''));
  const [assignee, setAssignee] = useQueryState('assignee', parseAsString.withDefault(''));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const params = new URLSearchParams({ status, priority, department, assignee, q }).toString();
  const tickets = useApiQuery<{ tickets: (Ticket & { ownerEmail: string })[] }>(['admin', 'support', 'queue', params], `/admin/support/tickets?${params}`, { refetchInterval: 20_000 }).data?.tickets;
  const stats = useApiQuery<Stats>(['admin', 'support', 'stats'], '/admin/support/stats', { refetchInterval: 30_000 }).data;
  const filtered = status !== 'active' || !!priority || !!department || !!assignee || !!q;
  const clear = () => { void setStatus(null); void setPriority(null); void setDepartment(null); void setAssignee(null); void setQ(null); };
  // A number tile is a shortcut to its tickets; pressing it again goes back to all open ones.
  const only = (s: string, a = '') => { const on = status === s && assignee === a && !priority && !department && !q; clear(); if (!on) { void setStatus(s === 'active' ? null : s); void setAssignee(a || null); } };
  const isOnly = (s: string, a = '') => status === s && assignee === a && !priority && !department && !q;
  return <>
    <PageHeader eyebrow={t('staffEyebrow')} title={t('queueTitle')} description={t('queueIntro')} actions={me && can(me.permissions, 'support.manage') ? <CannedReplies/> : undefined}/>
    <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
      <Stat label={t('stat.waiting')} value={stats?.waiting ?? '…'} icon={<I name="inbox" size={16}/>} tone="accent" onPress={() => only('waiting')} pressed={isOnly('waiting')}/>
      <Stat label={t('stat.overdue')} value={stats?.overdue ?? '…'} icon={<I name="alarm-clock-off" size={16}/>} tone={stats?.overdue ? 'danger' : 'default'} onPress={() => only('overdue')} pressed={isOnly('overdue')}/>
      <Stat label={t('stat.unassigned')} value={stats?.unassigned ?? '…'} icon={<I name="user-x" size={16}/>} tone={stats?.unassigned ? 'warning' : 'default'} onPress={() => only('active', 'none')} pressed={isOnly('active', 'none')}/>
      <Stat label={t('stat.active')} value={stats?.active ?? '…'} icon={<I name="life-buoy" size={16}/>} onPress={() => clear()} pressed={!filtered}/>
      <Stat label={t('stat.firstResponse')} value={stats?.firstResponseHours != null ? t('hours', { n: stats.firstResponseHours }) : '–'} icon={<I name="timer" size={16}/>}/>
      <Stat label={t('stat.rating')} value={stats?.rating != null ? `${stats.rating} / 5` : '–'} icon={<I name="star" size={16}/>} tone="success"/>
    </div>
    <div className="mb-4 grid gap-3 rounded-2xl border border-border bg-surface p-3 sm:grid-cols-2 xl:grid-cols-5">
      <SearchField aria-label={t('search')} value={q} onChange={(v) => setQ(v || null)} className="sm:col-span-2 xl:col-span-1">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('search')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <SelectInput label={t('statusLabel')} value={status} onChange={(v) => setStatus(v === 'active' ? null : v)}
        options={[{ id: 'active', label: t('filter.active') }, { id: 'waiting', label: t('stat.waiting') }, { id: 'overdue', label: t('stat.overdue') }, { id: '', label: t('filter.all') }, ...(['open', 'customer_reply', 'answered', 'on_hold', 'closed'] as const).map((s) => ({ id: s, label: t(`status.${s}`) }))]}/>
      <SelectInput label={t('priorityLabel')} value={priority} onChange={(v) => setPriority(v || null)}
        options={[{ id: '', label: t('filter.all') }, ...(['urgent', 'high', 'normal', 'low'] as const).map((p) => ({ id: p, label: t(`priority.${p}`) }))]}/>
      <SelectInput label={t('department')} value={department} onChange={(v) => setDepartment(v || null)}
        options={[{ id: '', label: t('filter.all') }, ...deps.map((d) => ({ id: d.id, label: locale === 'tr' ? d.nameTr : d.nameEn }))]}/>
      <SelectInput label={t('assignee')} value={assignee} onChange={(v) => setAssignee(v || null)}
        options={[{ id: '', label: t('filter.anyone') }, { id: 'me', label: t('filter.me') }, { id: 'none', label: t('unassigned') }]}/>
    </div>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="text-sm text-muted">{tickets ? t('shownCount', { n: tickets.length }) : '…'}</p>
      <div className="flex flex-wrap items-center gap-2">
        {filtered && <Button size="sm" variant="ghost" onPress={clear}><I name="funnel-x" size={15}/>{t('clearFilters')}</Button>}
        <SavedViews list="admin-support" keys={viewKeys}/>
        {tickets && tickets.length > 0 && <Button size="sm" variant="secondary" onPress={() => downloadCsv('support-queue', ['number', 'subject', 'customer', 'department', 'server', 'priority', 'status', 'assignee', 'due', 'updated'],
          tickets.map((x) => [x.number, x.subject, x.ownerEmail, departmentName(x, locale), x.serverName ?? '', t(`priority.${x.priority}`), t(`status.${x.status}`), x.assigneeEmail ?? '', x.dueAt ?? '', x.updatedAt]))}>
          <I name="download" size={15}/>{t('export')}</Button>}
      </div>
    </div>
    {!tickets ? <div className="h-40 animate-pulse rounded-3xl bg-default/50"/>
      : tickets.length === 0 ? (filtered
        ? <div role="status" className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{t('noMatch')}
            <Button size="sm" variant="secondary" onPress={clear}><I name="funnel-x" size={15}/>{t('clearFilters')}</Button></div>
        : <Empty icon={<I name="party-popper" size={28}/>} title={t('queueEmpty')}/>)
      : <ul className="flex flex-col gap-2">{tickets.map((x, i) => <motion.li key={x.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 10) * 0.02 }}>
          <NextLink href={`/admin/support/${x.id}`} className={`flex flex-col gap-2 rounded-2xl border p-3 transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent lg:flex-row lg:items-center lg:gap-4 ${x.dueAt && Date.parse(x.dueAt) < now.getTime() ? 'border-danger/40 bg-danger/5' : 'border-border bg-surface'}`}>
            <span className="w-16 shrink-0 text-sm tabular-nums text-muted">#{x.number}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{x.subject}</span>
              <span className="block truncate text-xs text-muted">{x.ownerEmail} · {departmentName(x, locale)}{x.serverName && ` · ${x.serverName}`} · <Ago at={x.updatedAt}/></span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              {x.assigneeEmail ? <span className="inline-flex items-center gap-1 text-xs text-muted"><I name="user" size={12}/>{x.assigneeEmail.split('@')[0]}</span>
                : <span className="text-xs text-warning">{t('unassigned')}</span>}
              {drafts.has(x.id) && <DraftBadge/>}<Deadline dueAt={x.dueAt}/><PriorityBadge priority={x.priority}/><StatusBadge status={x.status}/>
            </span>
          </NextLink>
        </motion.li>)}</ul>}
  </>;
}
