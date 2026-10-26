"use client";
// The public status page: one line on the whole, then each part of the panel and each location, refreshed every
// 30 seconds. Colour always comes with an icon and words.
import { motion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { I } from '../../components/icon';
import { flag } from '../../lib/flag';
import { useApiQuery } from '../../lib/query';

type State = 'ok' | 'degraded' | 'down';
type Status = { overall: State; services: { key: string; state: State }[]; locations: { name: string; city: string; countryCode: string; status: 'active' | 'maintenance' }[];
  announcement: { tone: string; textTr: string; textEn: string } | null; checkedAt: string };

const look: Record<State, { icon: string; text: string; bg: string; dot: string }> = {
  ok: { icon: 'circle-check', text: 'text-success', bg: 'bg-success/10 border-success/30', dot: 'bg-success' },
  degraded: { icon: 'triangle-alert', text: 'text-warning', bg: 'bg-warning/10 border-warning/30', dot: 'bg-warning' },
  down: { icon: 'circle-x', text: 'text-danger', bg: 'bg-danger/10 border-danger/30', dot: 'bg-danger' },
};

export default function StatusView() {
  const t = useTranslations('PublicStatus');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 15_000 });
  const q = useApiQuery<Status>(['public', 'status'], '/public/status', { refetchInterval: 30_000 });
  if (q.isError) return <p className="rounded-2xl border border-border bg-surface p-6 text-center text-sm text-muted">{t('unavailable')}</p>;
  if (!q.data) return <div className="flex flex-col gap-4" aria-busy>{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-default/60"/>)}</div>;
  const d = q.data;
  const o = look[d.overall];
  return <div className="flex flex-col gap-6">
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} role="status" aria-live="polite"
      className={`flex items-center gap-4 rounded-3xl border p-5 sm:p-6 ${o.bg}`}>
      <span className={`relative grid size-12 shrink-0 place-items-center rounded-2xl bg-surface ${o.text}`}>
        {d.overall === 'ok' && <span aria-hidden className="absolute inset-0 animate-ping rounded-2xl bg-success/20 [animation-duration:2.5s]"/>}
        <I name={o.icon} size={24}/></span>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold sm:text-xl">{t(`overall.${d.overall}`)}</h2>
        <p className="text-sm text-muted">{t('checked', { when: format.relativeTime(new Date(Math.min(Date.parse(d.checkedAt), now.getTime())), now) })}</p>
      </div>
    </motion.section>

    {d.announcement && <div className="flex gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4 text-sm">
      <I name="megaphone" size={18} className="mt-0.5 shrink-0 text-accent"/>{locale === 'tr' ? d.announcement.textTr : d.announcement.textEn}</div>}

    <section aria-labelledby="services">
      <h2 id="services" className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{t('services')}</h2>
      <ul className="divide-y divide-separator overflow-hidden rounded-2xl border border-border bg-surface">
        {d.services.map((s, i) => <motion.li key={s.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }} className="flex items-center gap-3 px-4 py-3.5">
          <I name={({ panel: 'layout-dashboard', database: 'database', queue: 'layers', automation: 'cog', virtualization: 'server' } as Record<string, string>)[s.key] ?? 'circle'} size={18} className="shrink-0 text-muted"/>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(`service.${s.key}.name` as 'service.panel.name')}</span><span className="block text-xs text-muted">{t(`service.${s.key}.help` as 'service.panel.help')}</span></span>
          <span className={`inline-flex shrink-0 items-center gap-1.5 text-sm font-medium ${look[s.state].text}`}><span aria-hidden className={`size-2 rounded-full ${look[s.state].dot}`}/>{t(`state.${s.state}`)}</span>
        </motion.li>)}
      </ul>
    </section>

    {d.locations.length > 0 && <section aria-labelledby="locations">
      <h2 id="locations" className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{t('locations')}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {d.locations.map((l) => { const st: State = l.status === 'active' ? 'ok' : 'degraded'; return <li key={l.name} className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
          <span aria-hidden className="text-2xl">{flag(l.countryCode)}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{l.name}</span>{l.city && <span className="block truncate text-xs text-muted">{l.city}</span>}</span>
          <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${look[st].text}`}><span aria-hidden className={`size-2 rounded-full ${look[st].dot}`}/>{t(`location.${l.status}`)}</span>
        </li>; })}
      </ul>
    </section>}

    <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span>{t('refresh')}</span>
      <NextLink href="/" className="inline-flex items-center gap-1 text-accent hover:underline">{t('toPanel')}<I name="arrow-right" size={13}/></NextLink>
    </p>
  </div>;
}
