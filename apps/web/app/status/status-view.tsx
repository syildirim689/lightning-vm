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
  announcement: { tone: string; textTr: string; textEn: string } | null; checkedAt: string;
  history: { days: Record<string, { day: string; ok: number; down: boolean }[]>; uptime: Record<string, number> };
  incidents: { id: string; title: string; impact: 'minor' | 'major' | 'maintenance'; status: string; createdAt: string; resolvedAt: string | null; updates: { status: string; body: string; at: string }[] }[] };

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

    {d.incidents.length > 0 && <section aria-labelledby="incidents" className="flex flex-col gap-3">
      <h2 id="incidents" className="text-sm font-semibold uppercase tracking-wider text-muted">{t('incidents')}</h2>
      {d.incidents.map((i) => <article key={i.id} className={`rounded-2xl border p-4 ${i.resolvedAt ? 'border-border bg-surface' : i.impact === 'major' ? 'border-danger/40 bg-danger/5' : 'border-warning/40 bg-warning/5'}`}>
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{i.title}</h3>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${i.resolvedAt ? 'bg-success/15 text-success' : 'bg-default text-foreground'}`}>{t(`incident.${i.status as 'resolved'}`)}</span>
        </header>
        <p className="mt-0.5 text-xs text-muted">{t(`impact.${i.impact}`)} · {format.dateTime(new Date(i.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</p>
        <ol className="mt-3 flex flex-col gap-2 border-l-2 border-border pl-4">
          {i.updates.map((u, n) => <li key={n} className="relative text-sm">
            <span aria-hidden className={`absolute -left-[1.4rem] top-1.5 size-2.5 rounded-full border-2 border-surface ${u.status === 'resolved' ? 'bg-success' : n === 0 ? 'bg-accent' : 'bg-default-foreground/30'}`}/>
            <span className="font-medium">{t(`incident.${u.status as 'resolved'}`)}</span> <span className="text-xs text-muted">· {format.relativeTime(new Date(Math.min(Date.parse(u.at), now.getTime())), now)}</span>
            <p className="whitespace-pre-line text-muted">{u.body}</p>
          </li>)}
        </ol>
      </article>)}
    </section>}

    {d.announcement && <div className="flex gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4 text-sm">
      <I name="megaphone" size={18} className="mt-0.5 shrink-0 text-accent"/>{locale === 'tr' ? d.announcement.textTr : d.announcement.textEn}</div>}

    <section aria-labelledby="services">
      <h2 id="services" className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{t('services')}</h2>
      <ul className="divide-y divide-separator overflow-hidden rounded-2xl border border-border bg-surface">
        {d.services.map((s, i) => <motion.li key={s.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
          <I name={({ panel: 'layout-dashboard', database: 'database', queue: 'layers', automation: 'cog', virtualization: 'server' } as Record<string, string>)[s.key] ?? 'circle'} size={18} className="shrink-0 text-muted"/>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(`service.${s.key}.name` as 'service.panel.name')}</span><span className="block text-xs text-muted">{t(`service.${s.key}.help` as 'service.panel.help')}</span></span>
          <span className={`inline-flex shrink-0 items-center gap-1.5 text-sm font-medium ${look[s.state].text}`}><span aria-hidden className={`size-2 rounded-full ${look[s.state].dot}`}/>{t(`state.${s.state}`)}</span>
          <UptimeBar days={d.history.days[s.key] ?? []} uptime={d.history.uptime[s.key]}/>
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

// The last 90 days, one bar per day (30 on phones): green all fine, amber partly, red down at some point, grey no data.
function UptimeBar({ days, uptime }: { days: { day: string; ok: number; down: boolean }[]; uptime?: number }) {
  const t = useTranslations('PublicStatus');
  const format = useFormatter();
  const byDay = new Map(days.map((d) => [d.day, d]));
  const list = [...Array(90)].map((_, i) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (89 - i)); const key = d.toISOString().slice(0, 10); return { key, date: d, v: byDay.get(key) }; });
  const color = (v?: { ok: number; down: boolean }) => (!v ? 'bg-default' : v.down ? 'bg-danger' : v.ok < 1 ? 'bg-warning' : 'bg-success');
  return <div className="flex w-full flex-col gap-1">
    <div className="flex h-7 items-stretch gap-[2px]" role="img" aria-label={t('uptimeLabel', { pct: uptime ?? 100 })}>
      {list.map((x, i) => <span key={x.key} title={`${format.dateTime(x.date, { dateStyle: 'medium' })}: ${x.v ? t('dayValue', { pct: Math.round(x.v.ok * 1000) / 10 }) : t('noData')}`}
        className={`min-w-0 flex-1 rounded-[2px] ${color(x.v)} ${i < 60 ? 'hidden sm:block' : ''}`}/>)}
    </div>
    <div className="flex justify-between text-[11px] text-muted"><span><span className="sm:hidden">{t('daysAgo', { n: 30 })}</span><span className="hidden sm:inline">{t('daysAgo', { n: 90 })}</span></span>
      <span>{uptime !== undefined ? t('uptime', { pct: uptime }) : t('noData')}</span><span>{t('today')}</span></div>
  </div>;
}
