"use client";
// "While you were away" on the dashboard (GET /notifications/away, rules in apps/api/src/away-rules.ts): the person's
// own finished and failed operations, invoices and ticket answers since they last pressed "Seen", as one list with a
// link to each. Nothing new is computed or sent: these are the inbox's own notifications. "Seen" is only ever a
// click (POST /notifications/away/seen); the list then starts again from that moment and those are read in the inbox.
import { Button } from '@heroui/react';
import NextLink from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { readableNotification } from '../lib/notification-text';
import { useApiAction, useApiQuery } from '../lib/query';
import { mayLeave } from '../lib/edits';
import { useNotificationSay } from './notification-bell';
import { I } from './icon';
import { Ago } from './ui';

type Kind = 'done' | 'failed' | 'billing' | 'support';
type Text = { title: string; body: string };
type Item = Text & { id: string; event: string; link: string | null; createdAt: string; readAt: string | null; texts: { tr: Text; en: Text } | null; kind: Kind };
type Away = { since: string; total: number; counts: Record<Kind, number>; items: Item[] };

const look: Record<Kind, { icon: string; tone: string }> = {
  failed: { icon: 'circle-x', tone: 'text-danger' },
  billing: { icon: 'wallet', tone: 'text-warning' },
  support: { icon: 'message-circle-reply', tone: 'text-accent' },
  done: { icon: 'circle-check', tone: 'text-success' },
};
const order: Kind[] = ['failed', 'billing', 'support', 'done'];

export function AwaySummary() {
  const t = useTranslations('Away');
  const locale = useLocale() === 'tr' ? 'tr' : 'en';
  const say = useNotificationSay();
  const client = useQueryClient();
  const q = useApiQuery<Away>(['notifications', 'away'], '/notifications/away', { refetchInterval: 120_000 });
  const seen = useApiAction((ids: string[]) => apiFetch('/notifications/away/seen', { method: 'POST', body: { ids } }),
    { invalidate: [['notifications']], success: t('seenDone') });
  const d = q.data;
  if (!d || d.total === 0) return null;
  const items = d.items.map((n) => { const text = { ...n, ...n.texts?.[locale] }; return { ...text, ...readableNotification(n.event, text, say) }; });
  const open = (n: Item) => { if (!n.readAt) void apiFetch('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).then(() => client.invalidateQueries({ queryKey: ['notifications'] }), () => undefined); };
  return <section aria-labelledby="away-title" className="rounded-2xl border border-border bg-surface p-4" data-away>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id="away-title" className="flex items-center gap-2 text-base font-semibold"><I name="history" size={18} className="text-accent"/>{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('since')} <Ago at={d.since}/></p>
      </div>
      <Button size="sm" variant="secondary" isPending={seen.isPending} onPress={() => seen.mutate(d.items.map((i) => i.id))}><I name="check-check" size={15}/>{t('seen')}</Button>
    </div>
    {/* The counts first, worst first, in words: "1 failed · 2 invoices · 3 finished". */}
    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm" role="status">
      {order.filter((k) => d.counts[k] > 0).map((k) => <span key={k} className="inline-flex items-center gap-1.5" data-count={k}>
        <I name={look[k].icon} size={15} className={look[k].tone}/>{t(`count.${k}`, { n: d.counts[k] })}</span>)}
    </p>
    <ul className="mt-3 flex flex-col divide-y divide-separator">
      {order.flatMap((k) => items.filter((n) => n.kind === k)).map((n) => <li key={n.id}>
        {n.link ? <NextLink href={n.link} onClick={(e) => { if (!mayLeave(n.link!)) e.preventDefault(); else open(n); }}
          className="flex min-h-11 items-start gap-3 rounded-lg px-1 py-2 hover:bg-default/60 focus-visible:outline-2 focus-visible:outline-accent">
          <Row n={n}/></NextLink> : <div className="flex min-h-11 items-start gap-3 px-1 py-2"><Row n={n}/></div>}
      </li>)}
    </ul>
    {d.total > d.items.length && <p className="mt-2 text-xs text-muted">{t('more', { n: d.total - d.items.length })}</p>}
  </section>;
}

function Row({ n }: { n: Item }) {
  const t = useTranslations('Away');
  return <>
    <I name={look[n.kind].icon} size={16} className={`mt-0.5 shrink-0 ${look[n.kind].tone}`}/>
    <span className="min-w-0 flex-1">
      <span className="sr-only">{t(`kind.${n.kind}`)}: </span>
      <span className="block truncate text-sm font-medium">{n.title}</span>
      {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
    </span>
    <span className="shrink-0 text-xs text-muted"><Ago at={n.createdAt}/></span>
  </>;
}
