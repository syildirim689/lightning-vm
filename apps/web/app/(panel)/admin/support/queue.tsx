"use client";
// Staff support queue: numbers that matter (waiting, overdue, unassigned, first response, rating), filters kept in
// the address, overdue tickets first and each one's deadline.
import { SearchField } from '@heroui/react';
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { I } from '../../../../components/icon';
import { Empty, PageHeader, SelectInput, Stat } from '../../../../components/ui';
import { useApiQuery } from '../../../../lib/query';
import { Deadline, departmentName, PriorityBadge, StatusBadge, useDepartments, type Ticket } from '../../support/ui';

type Stats = { active: number; waiting: number; overdue: number; unassigned: number; firstResponseHours: number | null; rating: number | null };

export default function SupportQueue() {
  const t = useTranslations('Support');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const deps = useDepartments();
  const [status, setStatus] = useQueryState('status', parseAsString.withDefault('active'));
  const [priority, setPriority] = useQueryState('priority', parseAsString.withDefault(''));
  const [department, setDepartment] = useQueryState('department', parseAsString.withDefault(''));
  const [assignee, setAssignee] = useQueryState('assignee', parseAsString.withDefault(''));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const params = new URLSearchParams({ status, priority, department, assignee, q }).toString();
  const tickets = useApiQuery<{ tickets: (Ticket & { ownerEmail: string })[] }>(['admin', 'support', 'queue', params], `/admin/support/tickets?${params}`, { refetchInterval: 20_000 }).data?.tickets;
  const stats = useApiQuery<Stats>(['admin', 'support', 'stats'], '/admin/support/stats', { refetchInterval: 30_000 }).data;
  return <>
    <PageHeader eyebrow={t('staffEyebrow')} title={t('queueTitle')} description={t('queueIntro')}/>
    <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
      <Stat label={t('stat.waiting')} value={stats?.waiting ?? '…'} icon={<I name="inbox" size={16}/>} tone="accent"/>
      <Stat label={t('stat.overdue')} value={stats?.overdue ?? '…'} icon={<I name="alarm-clock-off" size={16}/>} tone={stats?.overdue ? 'danger' : 'default'}/>
      <Stat label={t('stat.unassigned')} value={stats?.unassigned ?? '…'} icon={<I name="user-x" size={16}/>} tone={stats?.unassigned ? 'warning' : 'default'}/>
      <Stat label={t('stat.active')} value={stats?.active ?? '…'} icon={<I name="life-buoy" size={16}/>}/>
      <Stat label={t('stat.firstResponse')} value={stats?.firstResponseHours != null ? t('hours', { n: stats.firstResponseHours }) : '–'} icon={<I name="timer" size={16}/>}/>
      <Stat label={t('stat.rating')} value={stats?.rating != null ? `${stats.rating} / 5` : '–'} icon={<I name="star" size={16}/>} tone="success"/>
    </div>
    <div className="mb-4 grid gap-3 rounded-2xl border border-border bg-surface p-3 sm:grid-cols-2 xl:grid-cols-5">
      <SearchField aria-label={t('search')} value={q} onChange={(v) => setQ(v || null)} className="sm:col-span-2 xl:col-span-1">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('search')}/><SearchField.ClearButton/></SearchField.Group>
      </SearchField>
      <SelectInput label={t('statusLabel')} value={status} onChange={(v) => setStatus(v || null)}
        options={[{ id: 'active', label: t('filter.active') }, { id: '', label: t('filter.all') }, ...(['open', 'customer_reply', 'answered', 'on_hold', 'closed'] as const).map((s) => ({ id: s, label: t(`status.${s}`) }))]}/>
      <SelectInput label={t('priorityLabel')} value={priority} onChange={(v) => setPriority(v || null)}
        options={[{ id: '', label: t('filter.all') }, ...(['urgent', 'high', 'normal', 'low'] as const).map((p) => ({ id: p, label: t(`priority.${p}`) }))]}/>
      <SelectInput label={t('department')} value={department} onChange={(v) => setDepartment(v || null)}
        options={[{ id: '', label: t('filter.all') }, ...deps.map((d) => ({ id: d.id, label: locale === 'tr' ? d.nameTr : d.nameEn }))]}/>
      <SelectInput label={t('assignee')} value={assignee} onChange={(v) => setAssignee(v || null)}
        options={[{ id: '', label: t('filter.anyone') }, { id: 'me', label: t('filter.me') }, { id: 'none', label: t('unassigned') }]}/>
    </div>
    {!tickets ? <div className="h-40 animate-pulse rounded-3xl bg-default/50"/>
      : tickets.length === 0 ? <Empty icon={<I name="party-popper" size={28}/>} title={t('queueEmpty')}/>
      : <ul className="flex flex-col gap-2">{tickets.map((x, i) => <motion.li key={x.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 10) * 0.02 }}>
          <NextLink href={`/admin/support/${x.id}`} className={`flex flex-col gap-2 rounded-2xl border p-3 transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent lg:flex-row lg:items-center lg:gap-4 ${x.dueAt && Date.parse(x.dueAt) < now.getTime() ? 'border-danger/40 bg-danger/5' : 'border-border bg-surface'}`}>
            <span className="w-16 shrink-0 text-sm tabular-nums text-muted">#{x.number}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{x.subject}</span>
              <span className="block truncate text-xs text-muted">{x.ownerEmail} · {departmentName(x, locale)}{x.serverName && ` · ${x.serverName}`} · {format.relativeTime(new Date(Math.min(Date.parse(x.updatedAt), now.getTime())), now)}</span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              {x.assigneeEmail ? <span className="inline-flex items-center gap-1 text-xs text-muted"><I name="user" size={12}/>{x.assigneeEmail.split('@')[0]}</span>
                : <span className="text-xs text-warning">{t('unassigned')}</span>}
              <Deadline dueAt={x.dueAt}/><PriorityBadge priority={x.priority}/><StatusBadge status={x.status}/>
            </span>
          </NextLink>
        </motion.li>)}</ul>}
  </>;
}
