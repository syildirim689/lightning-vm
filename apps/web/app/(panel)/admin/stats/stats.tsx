"use client";
// Admin → Statistics: a period (7 days to a year) and, against the period before it, how the platform grew and
// worked: headline numbers with their trend, growth and activity over time, what the live servers are made of,
// the biggest customers and when people act (weekday × hour). Everything animates in, except for people who
// prefer less motion. Data: GET /admin/stats?days=&tz= (days and hours in the viewer's time zone).
import { Button, Card } from '@heroui/react';
import { motion, useReducedMotion } from 'motion/react';
import NextLink from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { usePercent } from '../../../../lib/percent';
import { parseAsInteger, useQueryState } from 'nuqs';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import CountUp from '../../../../components/count-up';
import { I } from '../../../../components/icon';
import { Empty, PageHeader } from '../../../../components/ui';
import { useApiQuery } from '../../../../lib/query';
import { highlights, seriesCsv } from '../../../../lib/stats';
import { useMe } from '../../../../lib/me';
import { browserTimeZone } from '../../../../components/time-zone-picker';

type Point = { at: string; /* YYYY-MM-DD, a local day */ created: number; deleted: number; signups: number; ticketsOpened: number; ticketsClosed: number; opsOk: number; opsFailed: number };
type Kpi = { value: number; change: number | null };
type Stats = {
  days: number; unit: 'day' | 'week'; tz: string;
  kpis: { servers: Kpi; monthly: (Kpi & { currency: string }) | null; signups: Kpi & { total: number }; tickets: Kpi & { rating: number | null; firstResponseHours: number | null };
    successRate: { value: number | null; change: number | null }; resources: { vcpu: number; memoryGb: number; diskGb: number } };
  currencies: { currency: string; now: number; before: number; servers: number }[];
  series: Point[]; byLocation: { name: string; servers: number; vcpu: number }[]; byImage: { name: string; family: string; servers: number }[];
  byPackage: { name: string; servers: number }[]; byPower: { state: string; servers: number }[];
  top: { id: string; email: string; name: string; servers: number; monthly: number; currency: string; vcpu: number }[];
  heat: { day: number; hour: number; n: number }[];
};

const ranges = [7, 30, 90, 365] as const;
const axis = { tick: { fill: 'var(--muted)', fontSize: 12 }, stroke: 'var(--separator)' };
const tooltipStyle = { background: 'var(--overlay)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--overlay-foreground)', fontSize: 12 };
const cursor = { fill: 'color-mix(in oklab, var(--muted) 12%, transparent)' };
const rise = (i: number, reduce: boolean | null) => (reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { delay: i * 0.06, type: 'spring' as const, stiffness: 260, damping: 26 } });

export default function Statistics() {
  const percent = usePercent();
  const t = useTranslations('Stats');
  const format = useFormatter();
  const reduce = useReducedMotion();
  const [days, setDays] = useQueryState('days', parseAsInteger.withDefault(30));
  const me = useMe();
  const tz = me?.timeZone ?? browserTimeZone();
  const q = useApiQuery<Stats>(['admin', 'stats', days, tz], `/admin/stats?days=${days}&tz=${encodeURIComponent(tz)}`, { refetchInterval: 60_000 });
  const s = q.data;
  // A local calendar day from the API, read as such (not as UTC midnight).
  const day = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
  const label = (ymd: string) => format.dateTime(day(ymd), s?.unit === 'week' ? { day: 'numeric', month: 'short' } : days <= 7 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' });
  const series = (s?.series ?? []).map((p) => ({ ...p, label: label(p.at), net: p.created - p.deleted }));
  const anim = { isAnimationActive: !reduce, animationDuration: 900 };

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro', { tz: s?.tz ?? tz })} actions={<div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" isDisabled={!s} onPress={() => s && download(`statistics-${days}d.csv`, seriesCsv(s.series, ['date', ...(['created', 'deleted', 'signups', 'opened', 'closed', 'opsOk', 'opsFailed'] as const).map((k) => t(`csv.${k}`))]))}>
        <I name="download" size={16}/>{t('csv.button')}</Button>
      <div role="radiogroup" aria-label={t('range')} className="relative flex rounded-full border border-border bg-surface p-1">
        {ranges.map((r) => <button key={r} type="button" role="radio" aria-checked={days === r} onClick={() => void setDays(r === 30 ? null : r)}
          className={`relative min-h-9 rounded-full px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${days === r ? 'text-accent-foreground' : 'text-muted hover:text-foreground'}`}>
          {days === r && <motion.span layoutId="stats-range" className="absolute inset-0 rounded-full bg-accent" transition={{ type: 'spring', stiffness: 500, damping: 38 }}/>}
          <span className="relative">{t(`ranges.${r}`)}</span>
        </button>)}
      </div></div>}/>

    {!s ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{[...Array(5)].map((_, i) => <div key={i} className="h-36 animate-pulse rounded-3xl bg-default/50"/>)}</div> : <>
      {/* Headline numbers, each against the period before. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard i={0} icon="server" label={t('kpi.servers')} kpi={s.kpis.servers} spark={series.map((p) => p.net)} hint={t('kpi.serversHint')}/>
        <KpiCard i={1} icon="wallet" label={t('kpi.monthly')} kpi={s.kpis.monthly ?? { value: 0, change: 0 }} spark={series.map((p) => p.created)}
          format={(n) => (s.kpis.monthly ? format.number(n, { style: 'currency', currency: s.kpis.monthly.currency, maximumFractionDigits: 0 }) : '–')}
          hint={s.currencies.length > 1 ? t('kpi.otherCurrencies', { n: s.currencies.length - 1 }) : t('kpi.monthlyHint')}/>
        <KpiCard i={2} icon="user-plus" label={t('kpi.signups')} kpi={s.kpis.signups} spark={series.map((p) => p.signups)} hint={t('kpi.signupsHint', { n: s.kpis.signups.total })}/>
        <KpiCard i={3} icon="life-buoy" label={t('kpi.tickets')} kpi={s.kpis.tickets} spark={series.map((p) => p.ticketsOpened)} invert
          hint={s.kpis.tickets.rating != null ? t('kpi.ticketsHint', { rating: s.kpis.tickets.rating, hours: s.kpis.tickets.firstResponseHours ?? '–' }) : t('kpi.noRatings')}/>
        <KpiCard i={4} icon="circle-check" label={t('kpi.success')} kpi={{ value: s.kpis.successRate.value ?? 0, change: s.kpis.successRate.change }} points
          spark={series.map((p) => p.opsOk)}
          format={(n) => (s.kpis.successRate.value == null ? '–' : percent(n, 1))} hint={t('kpi.successHint')}/>
      </div>

      {/* The numbers in words: what changed most, what needs a look. */}
      <ul aria-label={t('highlights.title')} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {highlights(s.kpis, s.series).map((h, j) => <motion.li key={h.key} {...(reduce ? {} : { initial: { opacity: 0, scale: 0.94 }, animate: { opacity: 1, scale: 1 }, transition: { delay: 0.35 + j * 0.08, type: 'spring', stiffness: 300, damping: 22 } })}
          className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${{ success: 'border-success/30 bg-success/5', warning: 'border-warning/30 bg-warning/5', danger: 'border-danger/30 bg-danger/5', accent: 'border-accent/30 bg-accent/5' }[h.tone]}`}>
          <span aria-hidden className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ${{ success: 'bg-success/15 text-success', warning: 'bg-warning/15 text-warning', danger: 'bg-danger/15 text-danger', accent: 'bg-accent/15 text-accent' }[h.tone]}`}>
            <I name={({ signupsUp: 'trending-up', signupsDown: 'trending-down', ticketsUp: 'life-buoy', ticketsDown: 'life-buoy', failures: 'triangle-alert', growth: 'rocket', shrink: 'trending-down', peakDay: 'calendar-days', quiet: 'coffee' } as Record<string, string>)[h.key]} size={15}/>
          </span>
          <span>{t(`highlights.${h.key}`, { ...h.values, ...(h.key === 'peakDay' ? { at: format.dateTime(day(String(h.values.at)), { weekday: 'long', day: 'numeric', month: 'long' }) } : {}) })}</span>
        </motion.li>)}
      </ul>

      {/* What the live servers use. */}
      <motion.div {...rise(5, reduce)} className="grid grid-cols-3 gap-px overflow-hidden rounded-3xl border border-border bg-separator">
        {([['cpu', 'vcpu', s.kpis.resources.vcpu, ''], ['memory-stick', 'memory', s.kpis.resources.memoryGb, ' GB'], ['hard-drive', 'disk', s.kpis.resources.diskGb, ' GB']] as const).map(([icon, k, v, unit]) =>
          <div key={k} className="flex flex-col items-center gap-1 bg-surface px-3 py-4 text-center sm:flex-row sm:justify-center sm:gap-3">
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-accent/10 text-accent">
              <I name={({ cpu: 'cpu', 'memory-stick': 'memory-stick', 'hard-drive': 'hard-drive' } as Record<string, string>)[icon]} size={18}/></span>
            <span><span className="block text-xl font-semibold"><CountUp value={v} format={(n) => `${format.number(Math.round(n))}${unit}`}/></span><span className="text-xs text-muted">{t(`resources.${k}`)}</span></span>
          </div>)}
      </motion.div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard i={6} title={t('charts.servers')} description={t('charts.serversHelp')}>
          <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="g-created" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35}/><stop offset="100%" stopColor="var(--accent)" stopOpacity={0}/></linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--separator)"/>
            <XAxis dataKey="label" {...axis} minTickGap={24}/><YAxis allowDecimals={false} width={32} {...axis}/>
            <Tooltip contentStyle={tooltipStyle}/>
            <Legend wrapperStyle={{ fontSize: 12 }}/>
            <Area type="monotone" dataKey="created" name={t('series.created')} stroke="var(--accent)" strokeWidth={2} fill="url(#g-created)" {...anim}/>
            <Area type="monotone" dataKey="deleted" name={t('series.deleted')} stroke="var(--muted)" strokeWidth={2} fill="transparent" strokeDasharray="4 3" {...anim}/>
          </AreaChart>
        </ChartCard>
        <ChartCard i={7} title={t('charts.signups')} description={t('charts.signupsHelp')}>
          <BarChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--separator)"/>
            <XAxis dataKey="label" {...axis} minTickGap={24}/><YAxis allowDecimals={false} width={32} {...axis}/>
            <Tooltip contentStyle={tooltipStyle} cursor={cursor}/>
            <Bar dataKey="signups" name={t('series.signups')} fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={28} {...anim}/>
          </BarChart>
        </ChartCard>
        <ChartCard i={8} title={t('charts.operations')} description={t('charts.operationsHelp')}>
          <BarChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--separator)"/>
            <XAxis dataKey="label" {...axis} minTickGap={24}/><YAxis allowDecimals={false} width={32} {...axis}/>
            <Tooltip contentStyle={tooltipStyle} cursor={cursor}/>
            <Legend wrapperStyle={{ fontSize: 12 }}/>
            <Bar dataKey="opsOk" name={t('series.opsOk')} stackId="ops" fill="var(--success)" maxBarSize={28} {...anim}/>
            <Bar dataKey="opsFailed" name={t('series.opsFailed')} stackId="ops" fill="var(--danger)" radius={[4, 4, 0, 0]} maxBarSize={28} {...anim}/>
          </BarChart>
        </ChartCard>
        <ChartCard i={9} title={t('charts.tickets')} description={t('charts.ticketsHelp')}>
          <LineChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--separator)"/>
            <XAxis dataKey="label" {...axis} minTickGap={24}/><YAxis allowDecimals={false} width={32} {...axis}/>
            <Tooltip contentStyle={tooltipStyle}/>
            <Legend wrapperStyle={{ fontSize: 12 }}/>
            <Line type="monotone" dataKey="ticketsOpened" name={t('series.opened')} stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 5 }} {...anim}/>
            <Line type="monotone" dataKey="ticketsClosed" name={t('series.closed')} stroke="var(--muted)" strokeWidth={2} strokeDasharray="4 3" dot={false} activeDot={{ r: 5 }} {...anim}/>
          </LineChart>
        </ChartCard>
      </div>

      {/* What the live servers are made of. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Breakdown i={10} title={t('by.location')} icon="map-pin" rows={s.byLocation.map((r) => ({ label: r.name, value: r.servers }))}/>
        <Breakdown i={11} title={t('by.image')} icon="disc" rows={s.byImage.map((r) => ({ label: r.name, value: r.servers }))}/>
        <Breakdown i={12} title={t('by.package')} icon="package" rows={s.byPackage.map((r) => ({ label: r.name || t('by.custom'), value: r.servers }))}/>
        <PowerCard i={13} rows={s.byPower}/>
      </div>

      {/* One column on a phone, and it may shrink below its content (grid-cols-1 is minmax(0,1fr)): an implicit column is as
          wide as its widest item, and the heatmap, 34rem wide inside its own scroll box, pushed the page 202 px sideways. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <TopCustomers i={14} rows={s.top}/>
        <Heatmap i={15} cells={s.heat}/>
      </div>
    </>}
  </div>;
}

// Saves text as a file in the browser (no server round-trip).
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Delta({ change, invert, points }: { change: number | null; invert?: boolean; points?: boolean }) {
  const percent = usePercent();
  const t = useTranslations('Stats');
  if (change === null) return <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t('new')}</span>;
  // More tickets is not good news: the colour follows what the change means, the arrow follows its direction.
  const good = change === 0 ? null : (change > 0) !== !!invert;
  return <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 18, delay: 0.3 }}
    className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${good === null ? 'bg-default text-muted' : good ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}
    title={t('vsBefore')}>
    <I name={change > 0 ? 'trending-up' : change < 0 ? 'trending-down' : 'minus'} size={12}/>{points ? `${change > 0 ? '+' : ''}${change} ${t('points')}` : percent(change, 1, true)}
    <span className="sr-only"> {t('vsBefore')}</span>
  </motion.span>;
}

function KpiCard({ i, icon, label, kpi, spark, hint, format, invert, points }: { i: number; icon: string; label: string; kpi: Kpi; spark: number[]; hint?: string;
  format?: (n: number) => string; invert?: boolean; points?: boolean }) {
  const reduce = useReducedMotion();
  const data = spark.map((v, x) => ({ x, v }));
  return <motion.div {...rise(i, reduce)} whileHover={reduce ? undefined : { y: -3 }}>
    <Card className="relative h-full overflow-hidden">
      <Card.Content className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
          <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent/10 text-accent">
            <I name={({ server: 'server', wallet: 'wallet', 'user-plus': 'user-plus', 'life-buoy': 'life-buoy', 'circle-check': 'circle-check' } as Record<string, string>)[icon]} size={16}/></span>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight"><CountUp value={kpi.value} format={format}/></span>
          <Delta change={kpi.change} invert={invert} points={points}/>
        </div>
        {hint && <p className="text-xs text-muted">{hint}</p>}
        <div aria-hidden className="-mx-4 -mb-4 mt-1 h-12">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, bottom: 0, left: 0, right: 0 }}>
              <defs><linearGradient id={`spark-${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3}/><stop offset="100%" stopColor="var(--accent)" stopOpacity={0}/></linearGradient></defs>
              <Area type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} fill={`url(#spark-${i})`} isAnimationActive={!reduce} animationDuration={1100} animationBegin={i * 80}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card.Content>
    </Card>
  </motion.div>;
}

function ChartCard({ i, title, description, children }: { i: number; title: string; description: string; children: React.ReactElement }) {
  const reduce = useReducedMotion();
  return <motion.div {...rise(i, reduce)}>
    <Card className="h-full">
      <Card.Header><Card.Title className="text-base font-semibold">{title}</Card.Title><Card.Description className="text-sm text-muted">{description}</Card.Description></Card.Header>
      <Card.Content><div className="h-64"><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div></Card.Content>
    </Card>
  </motion.div>;
}

// Ranked bars in one hue: a longer bar is more servers; the number is written beside it.
function Breakdown({ i, title, icon, rows }: { i: number; title: string; icon: string; rows: { label: string; value: number }[] }) {
  const t = useTranslations('Stats');
  const reduce = useReducedMotion();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return <motion.div {...rise(i, reduce)}>
    <Card className="h-full"><Card.Content className="flex flex-col gap-3">
      <p className="flex items-center gap-2 font-semibold"><I name={({ 'map-pin': 'map-pin', disc: 'disc', package: 'package' } as Record<string, string>)[icon]} size={16} className="text-accent"/>{title}</p>
      {!rows.length ? <p className="text-sm text-muted">{t('noServers')}</p> : <ul className="flex flex-col gap-2.5">{rows.map((r, j) => <li key={r.label} className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{r.label}</span><span className="tabular-nums text-muted">{r.value}</span></span>
        <span className="h-2 overflow-hidden rounded-full bg-default">
          <motion.span className="block h-full rounded-full bg-accent" initial={{ width: reduce ? `${(r.value / max) * 100}%` : 0 }} animate={{ width: `${(r.value / max) * 100}%` }}
            transition={{ delay: 0.3 + j * 0.07, duration: 0.7, ease: 'easeOut' }}/>
        </span>
      </li>)}</ul>}
    </Card.Content></Card>
  </motion.div>;
}

// Power states as one bar split into parts, each with its icon and name (never colour alone).
function PowerCard({ i, rows }: { i: number; rows: { state: string; servers: number }[] }) {
  const percent = usePercent();
  const t = useTranslations('Stats');
  const reduce = useReducedMotion();
  const total = rows.reduce((a, r) => a + r.servers, 0);
  const tone: Record<string, string> = { poweredOn: 'bg-success', poweredOff: 'bg-muted/50', suspended: 'bg-warning', unknown: 'bg-default-foreground/20' };
  return <motion.div {...rise(i, reduce)}>
    <Card className="h-full"><Card.Content className="flex flex-col gap-3">
      <p className="flex items-center gap-2 font-semibold"><I name="power" size={16} className="text-accent"/>{t('by.power')}</p>
      {!total ? <p className="text-sm text-muted">{t('noServers')}</p> : <>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
          {rows.map((r, j) => <motion.span key={r.state} className={`h-full first:rounded-l-full last:rounded-r-full ${tone[r.state] ?? tone.unknown}`}
            initial={{ flexGrow: reduce ? r.servers : 0 }} animate={{ flexGrow: r.servers }} transition={{ delay: 0.3 + j * 0.1, duration: 0.8, ease: 'easeOut' }} style={{ flexBasis: 0 }}/>)}
        </div>
        <ul className="flex flex-col gap-1.5 text-sm">{rows.map((r) => <li key={r.state} className="flex items-center gap-2">
          <span aria-hidden className={`size-2.5 rounded-full ${tone[r.state] ?? tone.unknown}`}/>
          <span className="flex-1">{t(`power.${(['poweredOn', 'poweredOff', 'suspended'].includes(r.state) ? r.state : 'unknown') as 'unknown'}`)}</span>
          <span className="tabular-nums text-muted">{r.servers} · {percent((r.servers / total) * 100)}</span>
        </li>)}</ul>
      </>}
    </Card.Content></Card>
  </motion.div>;
}

function TopCustomers({ i, rows }: { i: number; rows: Stats['top'] }) {
  const t = useTranslations('Stats');
  const format = useFormatter();
  const reduce = useReducedMotion();
  const max = Math.max(1, ...rows.map((r) => r.monthly));
  return <motion.div {...rise(i, reduce)}>
    <Card className="h-full"><Card.Header><Card.Title className="text-base font-semibold">{t('top.title')}</Card.Title><Card.Description className="text-sm text-muted">{t('top.help')}</Card.Description></Card.Header>
      <Card.Content>
        {!rows.length ? <Empty icon={<I name="users" size={24}/>} title={t('noServers')}/> : <ol className="flex flex-col gap-1">{rows.map((r, j) => <motion.li key={`${r.id}-${r.currency}`}
          initial={reduce ? false : { opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 + j * 0.06 }}>
          <NextLink href={`/admin/users?q=${encodeURIComponent(r.email)}`} className="relative flex items-center gap-3 overflow-hidden rounded-xl px-3 py-2 hover:bg-default focus-visible:outline-2 focus-visible:outline-accent">
            <motion.span aria-hidden className="absolute inset-y-1 left-0 rounded-xl bg-accent/8" initial={{ width: 0 }} animate={{ width: `${(r.monthly / max) * 100}%` }} transition={{ delay: 0.5 + j * 0.06, duration: 0.8 }}/>
            <span className={`relative grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${j < 3 ? 'bg-accent text-accent-foreground' : 'bg-default text-muted'}`}>{j + 1}</span>
            <span className="relative min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.name || r.email}</span>
              <span className="block truncate text-xs text-muted">{t('top.line', { servers: r.servers, vcpu: r.vcpu })}</span></span>
            <span className="relative shrink-0 text-sm font-semibold tabular-nums">{format.number(r.monthly, { style: 'currency', currency: r.currency, maximumFractionDigits: 0 })}</span>
          </NextLink>
        </motion.li>)}</ol>}
      </Card.Content>
    </Card>
  </motion.div>;
}

// Weekday × hour: darker is more operations. Cells fade in one after another; each says its count on hover.
function Heatmap({ i, cells }: { i: number; cells: Stats['heat'] }) {
  const t = useTranslations('Stats');
  const format = useFormatter();
  const reduce = useReducedMotion();
  const at = new Map(cells.map((c) => [`${c.day}-${c.hour}`, c.n]));
  const max = Math.max(1, ...cells.map((c) => c.n));
  const busiest = cells.reduce<Stats['heat'][number] | null>((b, c) => (!b || c.n > b.n ? c : b), null);
  // Monday 2024-01-01 is a fixed Monday, for the weekday names in the panel's language.
  const dayName = (d: number) => format.dateTime(new Date(Date.UTC(2024, 0, d)), { weekday: 'short', timeZone: 'UTC' });
  return <motion.div {...rise(i, reduce)}>
    <Card className="h-full"><Card.Header><Card.Title className="text-base font-semibold">{t('heat.title')}</Card.Title>
      <Card.Description className="text-sm text-muted">{busiest ? t('heat.busiest', { day: dayName(busiest.day), hour: String(busiest.hour).padStart(2, '0') }) : t('heat.empty')}</Card.Description></Card.Header>
      <Card.Content className="overflow-x-auto">
        <div className="grid min-w-[34rem] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-1 text-[10px] text-muted">
          <span/>{[...Array(24)].map((_, h) => <span key={h} className="text-center tabular-nums">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
          {[1, 2, 3, 4, 5, 6, 7].map((d) => <div key={d} className="contents">
            <span className="self-center pr-1 text-right">{dayName(d)}</span>
            {[...Array(24)].map((_, h) => {
              const n = at.get(`${d}-${h}`) ?? 0;
              return <motion.span key={h} title={t('heat.cell', { day: dayName(d), hour: String(h).padStart(2, '0'), n })} aria-label={t('heat.cell', { day: dayName(d), hour: String(h).padStart(2, '0'), n })}
                className="aspect-square rounded-[4px]" style={{ background: n ? `color-mix(in oklab, var(--accent) ${Math.round(18 + (n / max) * 82)}%, transparent)` : 'var(--default)' }}
                initial={reduce ? false : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4 + ((d - 1) * 24 + h) * 0.003, duration: 0.25 }}/>;
            })}
          </div>)}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted">{t('heat.less')}
          {[0, 25, 50, 75, 100].map((p) => <span key={p} className="size-3 rounded-[3px]" style={{ background: p ? `color-mix(in oklab, var(--accent) ${18 + p * 0.82}%, transparent)` : 'var(--default)' }}/>)}{t('heat.more')}</div>
      </Card.Content>
    </Card>
  </motion.div>;
}
