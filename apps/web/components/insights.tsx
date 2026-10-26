"use client";
// Findings the API computed (capacity, IPs, connections, backups, security...), worst first, each with a
// link to where it is fixed. Severity is shown by icon and text, not colour alone.
import { AnimatePresence, motion } from 'motion/react';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useApiQuery } from '../lib/query';
import { I } from './icon';

type Insight = { code: string; severity: 'danger' | 'warning' | 'info'; params: Record<string, string | number>; link: string; key: string };

export default function Insights({ scope }: { scope: 'staff' | 'mine' }) {
  const t = useTranslations('Insights');
  const q = useApiQuery<{ insights: Insight[] }>(['insights', scope], scope === 'staff' ? '/admin/insights' : '/insights', { refetchInterval: 60_000 });
  const list = q.data?.insights;
  if (!list) return null;
  const style = { danger: 'border-danger/40 bg-danger/5 text-danger', warning: 'border-warning/40 bg-warning/5 text-warning', info: 'border-border bg-surface text-accent' };
  const icon = (s: Insight['severity']) => s === 'danger' ? <I name="octagon-alert" size={18}/> : s === 'warning' ? <I name="triangle-alert" size={18}/> : <I name="lightbulb" size={18}/>;
  const p = (i: Insight) => Object.fromEntries(Object.entries(i.params).map(([k, v]) => [k, k === 'resource' ? t(`resource.${v}` as 'resource.vcpu') : v]));
  return <section aria-labelledby={`insights-${scope}`} className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      <h2 id={`insights-${scope}`} className="text-base font-semibold">{t('title')}</h2>
      {list.length > 0 && <span className="rounded-full bg-default px-2 py-0.5 text-xs font-medium tabular-nums">{list.length}</span>}
    </div>
    {list.length === 0 ? <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/5 px-4 py-3 text-sm">
      <I name="circle-check" size={18} className="text-success"/>{t('allGood')}</motion.p>
      : <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        <AnimatePresence initial>{list.map((i, n) => <motion.li key={i.key} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: n * 0.04 }}>
          <NextLink href={i.link} className={`group flex h-full items-start gap-3 rounded-xl border px-4 py-3 transition-shadow hover:shadow-md ${style[i.severity]}`}>
            <span className="mt-0.5 shrink-0">{icon(i.severity)}</span>
            <span className="min-w-0 flex-1 text-foreground">
              <span className="sr-only">{t(`severity.${i.severity}`)}: </span>
              <span className="block text-sm font-semibold">{t(`codes.${i.code}.title` as 'codes.POOL_NEARLY_FULL.title', p(i))}</span>
              <span className="block text-xs text-muted">{t(`codes.${i.code}.body` as 'codes.POOL_NEARLY_FULL.body', p(i))}</span>
            </span>
            <I name="arrow-right" size={16} className="mt-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5"/>
          </NextLink>
        </motion.li>)}</AnimatePresence>
      </ul>}
  </section>;
}
