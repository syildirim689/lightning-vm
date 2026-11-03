"use client";
// The top of "My servers": a greeting for the time of day, one sentence on what most needs a look (with a link that
// filters the list to it), and the servers last opened in this browser.
import NextLink from 'next/link';
import { motion } from 'motion/react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { Server } from '../app/(panel)/servers-ui';
import { stateGroup } from '../app/(panel)/server-filters';
import { useMe } from '../lib/me';
import { useApiQuery } from '../lib/query';
import { recent, type Recent } from '../lib/recent';
import type { Summary } from '../lib/billing';
import { I } from './icon';

const tones = { danger: 'border-danger/40 bg-danger/5 text-danger', warning: 'border-warning/40 bg-warning/5 text-warning', accent: 'border-accent/40 bg-accent-soft text-accent', success: 'border-success/40 bg-success/5 text-success' };

export default function Welcome() {
  const t = useTranslations('Welcome');
  const me = useMe();
  const servers = useApiQuery<{ servers: Server[] }>(['servers'], '/servers', { refetchInterval: 5_000 }).data?.servers;
  // Things waiting for this person elsewhere: unpaid invoices and tickets support answered (same queries as the menu).
  const billing = useApiQuery<Summary>(['notifications', 'billing-summary'], '/billing/summary').data;
  const support = useApiQuery<{ waiting: number }>(['notifications', 'support-summary'], '/support/summary', { refetchInterval: 60_000 }).data;
  const format = useFormatter();
  // Read after mount: the hour and this browser's history are not known on the server.
  const [hour, setHour] = useState<number>();
  const [last, setLast] = useState<Recent[]>([]);
  useEffect(() => { setHour(new Date().getHours()); setLast(recent()); }, []);
  if (!me || !servers || hour === undefined) return null;
  const part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : hour < 22 ? 'evening' : 'night';
  const first = me.name?.trim().split(/\s+/)[0];
  const count = (g: string) => servers.filter((s) => stateGroup(s) === g).length;
  // The one thing most worth a look, worst first.
  const status = ([['problem', 'danger'], ['busy', 'accent'], ['stopped', 'warning']] as const).map(([g, tone]) => ({ g, tone, n: count(g) })).find((x) => x.n > 0)
    ?? (count('running') ? { g: 'running' as const, tone: 'success' as const, n: count('running') } : null);
  const ids = new Set(servers.map((s) => s.id));
  const unpaid = billing?.enabled && billing.open.n > 0 ? billing.open : null;
  const opened = last.filter((r) => ids.has(r.href.split('/').pop() ?? '')).slice(0, 4);
  return <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} aria-label={t('label')} className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
    <div className="flex min-w-0 items-center gap-3">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent"><I name={{ morning: 'sunrise', day: 'sun', evening: 'sunset', night: 'moon' }[part]} size={20}/></span>
      <div className="min-w-0">
        <p className="truncate text-base font-semibold">{first && !first.includes('@') ? t(`hello.${part}`, { name: first }) : t(`plain.${part}`)}</p>
        {(status || unpaid || !!support?.waiting) && <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          {status && <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[status.tone]}`}>
            <I name={{ problem: 'triangle-alert', busy: 'loader', stopped: 'power', running: 'circle-check' }[status.g]} size={13}/>{t(`status.${status.g}`, { n: status.n })}</span>}
          {status && status.g !== 'running' && <NextLink href={`/?state=${status.g}`} scroll={false} className="text-xs font-medium text-accent hover:underline">{t('show')}</NextLink>}
          {unpaid && <NextLink href="/billing" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium hover:underline ${unpaid.overdue ? tones.danger : tones.warning}`}>
            <I name="receipt-text" size={13}/>{t(unpaid.overdue ? 'overdue' : 'unpaid', { n: unpaid.n, amount: unpaid.currency ? format.number(Number(unpaid.amount), { style: 'currency', currency: unpaid.currency }) : '' })}</NextLink>}
          {!!support?.waiting && <NextLink href="/support" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium hover:underline ${tones.success}`}>
            <I name="message-circle-reply" size={13}/>{t('answered', { n: support.waiting })}</NextLink>}</p>}
      </div>
    </div>
    {opened.length > 0 && <nav aria-label={t('recent')} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="flex items-center gap-1 text-xs text-muted"><I name="history" size={13}/>{t('recent')}</span>
      {opened.map((r) => <NextLink key={r.href} href={r.href} className="flex min-h-8 max-w-48 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs font-medium transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
        <I name="server" size={12} className="shrink-0 text-muted"/><span className="truncate">{r.label}</span></NextLink>)}
    </nav>}
  </motion.section>;
}
