"use client";
// Admin dashboard: what happened since this browser last opened it (new people and servers, failures, alarms,
// refused access). The time of the visit is kept in this browser only; the first visit looks at the last day.
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useApiQuery } from '../lib/query';
import { I } from './icon';

type Counts = { users: number; servers: number; failedOperations: number; doneOperations: number; abuse: number; alerts: number; denied: number; failedSignIns: number };
const key = 'lvm-dashboard-seen';
const items: { k: keyof Counts; icon: string; href: string; tone: 'default' | 'warning' | 'danger' | 'success' }[] = [
  { k: 'failedOperations', icon: 'circle-x', href: '/admin/servers', tone: 'danger' },
  { k: 'alerts', icon: 'siren', href: '/admin/system', tone: 'danger' },
  { k: 'abuse', icon: 'shield-alert', href: '/admin/abuse', tone: 'warning' },
  { k: 'failedSignIns', icon: 'lock-keyhole', href: '/admin/audit?category=auth&outcome=failure', tone: 'warning' },
  { k: 'denied', icon: 'ban', href: '/admin/audit?outcome=denied', tone: 'warning' },
  { k: 'users', icon: 'user-plus', href: '/admin/users', tone: 'default' },
  { k: 'servers', icon: 'server', href: '/admin/servers', tone: 'default' },
  { k: 'doneOperations', icon: 'circle-check', href: '/admin/servers', tone: 'success' },
];
const toneClass = { default: 'bg-default text-foreground', warning: 'bg-warning/15 text-warning', danger: 'bg-danger/15 text-danger', success: 'bg-success/15 text-success' };

export default function Digest() {
  const t = useTranslations('Digest');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  // Read once: the previous visit. The new one is written after the counts arrive.
  const [since] = useState(() => { try { return localStorage.getItem(key); } catch { return null; } });
  const q = useApiQuery<{ since: string; counts: Counts }>(['admin', 'digest', since ?? ''], `/admin/digest${since ? `?since=${encodeURIComponent(since)}` : ''}`);
  useEffect(() => { if (q.data) try { localStorage.setItem(key, new Date().toISOString()); } catch { /* storage off */ } }, [q.data]);
  if (!q.data) return null;
  const shown = items.filter((i) => q.data.counts[i.k] > 0);
  return <section aria-labelledby="digest" className="rounded-3xl border border-border bg-surface p-4 sm:p-5">
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="digest" className="flex items-center gap-2 font-semibold"><I name="history" size={17} className="text-accent"/>{since ? t('title') : t('titleDay')}</h2>
      <span className="text-xs text-muted">{format.relativeTime(new Date(q.data.since), now)}</span>
    </div>
    {shown.length === 0 ? <p className="flex items-center gap-2 text-sm text-muted"><I name="circle-check" size={15} className="text-success"/>{t('nothing')}</p>
      : <ul className="flex flex-wrap gap-2">{shown.map((i, n) => <motion.li key={i.k} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: n * 0.04 }}>
          <NextLink href={i.href} className={`inline-flex min-h-10 items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-accent ${toneClass[i.tone]}`}>
            <I name={i.icon} size={15}/><span className="font-semibold tabular-nums">{q.data.counts[i.k]}</span>{t(`k.${i.k}`, { n: q.data.counts[i.k] })}</NextLink>
        </motion.li>)}</ul>}
  </section>;
}
