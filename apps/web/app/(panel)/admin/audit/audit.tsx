"use client";
// The audit log for staff with audit.view: search (action, e-mail, IP, details), outcome and category filters
// kept in the URL, 50 events a page, each event's details on demand.
import { Button, Card, SearchField } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import React, { useState } from 'react';
import { ActivityIcon, outcomeTone, useActionLabel, type AuditEvent } from '../../../../components/activity';
import { I } from '../../../../components/icon';
import { Mono, PageHeader, SelectInput, StatusChip } from '../../../../components/ui';
import { apiFetch } from '../../../../lib/api';
import { downloadCsv } from '../../../../lib/csv';
import { useApiQuery } from '../../../../lib/query';

type Page = { events: AuditEvent[]; nextBefore: string | null; categories: string[] };

export default function Audit() {
  const t = useTranslations('Activity');
  const format = useFormatter();
  const label = useActionLabel();
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [outcome, setOutcome] = useQueryState('outcome', parseAsString.withDefault(''));
  const [category, setCategory] = useQueryState('category', parseAsString.withDefault(''));
  const params = new URLSearchParams({ q, outcome, category }).toString();
  const first = useApiQuery<Page>(['admin', 'audit', params], `/admin/audit?${params}`).data;
  const [more, setMore] = useState<{ params: string; events: AuditEvent[]; next: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const extra = more?.params === params ? more : null;
  const events = [...(first?.events ?? []), ...(extra?.events ?? [])];
  const cursor = extra ? extra.next : first?.nextBefore;
  const dayOf = (at: string | number) => format.dateTime(new Date(at), { year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = dayOf(Date.now()), yesterday = dayOf(Date.now() - 864e5);
  const dayLabel = (at: string) => dayOf(at) === today ? t('today') : dayOf(at) === yesterday ? t('yesterday') : format.dateTime(new Date(at), { dateStyle: 'full' });
  // A person or address in a row narrows the log to it with one click.
  const pick = (v: string) => <button type="button" className="hover:text-accent hover:underline" title={t('filterBy', { v })} onClick={() => setQ(v)}>{v}</button>;

  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')} actions={events.length > 0 && <Button variant="secondary"
      onPress={() => downloadCsv('audit', ['time', 'action', 'outcome', 'actor', 'ip', 'details'], events.map((e) => [e.at, e.action, e.outcome, e.actorEmail ?? e.actorId ?? '', e.ip ?? '', JSON.stringify(e.metadata ?? {})]))}>
      <I name="download" size={16}/>{t('export')}</Button>}/>
    <Card><Card.Content className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
        <SearchField aria-label={t('search')} value={q} onChange={(v) => setQ(v || null)} className="w-full md:w-80">
          <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('searchPlaceholder')}/><SearchField.ClearButton/></SearchField.Group>
        </SearchField>
        <SelectInput className="w-full md:w-44" label={t('outcomeLabel')} value={outcome} onChange={(v) => setOutcome(v || null)}
          options={[{ id: '', label: t('all') }, ...(['success', 'failure', 'denied'] as const).map((o) => ({ id: o, label: t(`outcome.${o}`) }))]}/>
        <SelectInput className="w-full md:w-48" label={t('category')} value={category} onChange={(v) => setCategory(v || null)}
          options={[{ id: '', label: t('all') }, ...(first?.categories ?? []).map((c) => ({ id: c, label: c }))]}/>
      </div>
      {!first ? <p role="status" className="text-sm text-muted">…</p> : !events.length ? <p className="py-8 text-center text-sm text-muted">{t('noMatch')}</p>
      : <ol className="flex flex-col">
        {events.map((e, i) => <React.Fragment key={e.id}>
          {(i === 0 || dayOf(events[i - 1]!.at) !== dayOf(e.at)) && <li className="mt-3 border-b border-separator pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted first:mt-0">
            {dayLabel(e.at)} <span className="font-normal normal-case">· {t('dayCount', { n: events.filter((x) => dayOf(x.at) === dayOf(e.at)).length })}</span></li>}
          <li className="flex gap-3 border-b border-separator py-3 last:border-0">
          <ActivityIcon action={e.action}/>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium">{label(e.action)}</span>
              <StatusChip tone={outcomeTone[e.outcome]}>{t(`outcome.${e.outcome}`)}</StatusChip>
              <span className="ml-auto text-xs text-muted"><time dateTime={e.at} title={format.dateTime(new Date(e.at), { dateStyle: 'medium', timeStyle: 'medium' })}>{format.dateTime(new Date(e.at), { timeStyle: 'medium' })}</time></span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1"><I name="user" size={12}/>{e.actorEmail ? pick(e.actorEmail) : (e.actorId ? e.actorId : t('system'))}</span>
              {e.ip && <span className="flex items-center gap-1"><I name="globe" size={12}/>{pick(e.ip)}</span>}
              <Mono>{e.action}</Mono>
            </div>
            {Object.keys(e.metadata ?? {}).length > 0 && <details className="text-xs">
              <summary className="cursor-pointer text-accent">{t('details')}</summary>
              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-default p-2 font-mono">{JSON.stringify(e.metadata, null, 2)}</pre>
            </details>}
          </div>
        </li></React.Fragment>)}
      </ol>}
      {events.length > 0 && <p className="text-xs text-muted">{t('shown', { n: events.length })}</p>}
      {cursor && <div><Button variant="secondary" size="sm" isPending={busy} onPress={async () => {
        setBusy(true);
        try { const r = await apiFetch<Page>(`/admin/audit?${params}&before=${cursor}`); setMore({ params, events: [...(extra?.events ?? []), ...r.events], next: r.nextBefore }); }
        finally { setBusy(false); }
      }}><I name="chevrons-down" size={15}/>{t('more')}</Button></div>}
    </Card.Content></Card>
  </>;
}
