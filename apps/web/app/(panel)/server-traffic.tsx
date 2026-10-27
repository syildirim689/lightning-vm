"use client";
// A server's network traffic: this month against its allowance, and the last 31 days (in and out per day).
// Counted every few minutes from VMware's counters, so the figures lag a little behind.
import { ProgressBar } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Notice, Section } from '../../components/ui';
import { useApiQuery } from '../../lib/query';

type Traffic = { days: { day: string; rx: number; tx: number }[]; month: { rx: number; tx: number }; allowanceGb: number | null; countedAt: string | null };
const tooltip = { background: 'var(--overlay)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--overlay-foreground)', fontSize: 12 };

export function useBytes() {
  const format = useFormatter();
  return (b: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return `${format.number(b, { maximumFractionDigits: i >= 3 ? 2 : 0 })} ${units[i]}`;
  };
}

export function ServerTraffic({ id, throttled }: { id: string; throttled?: boolean }) {
  const t = useTranslations('Traffic');
  const format = useFormatter();
  const bytes = useBytes();
  const q = useApiQuery<Traffic>(['traffic', id], `/servers/${id}/traffic`, { refetchInterval: 300_000 });
  if (!q.data) return null;
  const { month, allowanceGb, days } = q.data;
  const used = month.rx + month.tx;
  const pct = allowanceGb ? Math.min(100, (used / (allowanceGb * 1024 ** 3)) * 100) : null;
  const data = days.map((d) => ({ ...d, label: format.dateTime(new Date(`${d.day}T12:00:00`), { day: 'numeric', month: 'short' }) }));
  return <Section title={t('title')} description={t('help')}>
    <div className="flex flex-col gap-4">
      {throttled && <Notice tone="warning" title={t('throttled')}>{t('throttledHelp')}</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border p-3"><p className="text-xs uppercase tracking-wider text-muted">{t('month')}</p>
          <p className="text-xl font-semibold tabular-nums">{bytes(used)}</p>
          <p className="text-xs text-muted">{allowanceGb ? t('of', { gb: allowanceGb }) : t('unlimited')}</p></div>
        <div className="rounded-xl border border-border p-3"><p className="text-xs uppercase tracking-wider text-muted">{t('in')}</p>
          <p className="text-xl font-semibold tabular-nums">{bytes(month.rx)}</p></div>
        <div className="rounded-xl border border-border p-3"><p className="text-xs uppercase tracking-wider text-muted">{t('out')}</p>
          <p className="text-xl font-semibold tabular-nums">{bytes(month.tx)}</p></div>
      </div>
      {pct !== null && <ProgressBar aria-label={t('month')} value={pct} color={pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'accent'} size="sm">
        <ProgressBar.Output/><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>}
      <div className="h-40" role="img" aria-label={t('chart', { total: bytes(days.reduce((a, d) => a + d.rx + d.tx, 0)) })}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, left: 0, right: 0, bottom: 0 }} barGap={2}>
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted)' }} interval="preserveStartEnd" tickLine={false} axisLine={false} minTickGap={24}/>
            <YAxis hide/>
            <Tooltip contentStyle={tooltip} formatter={(v, n) => [bytes(Number(v)), n === 'rx' ? t('in') : t('out')]} cursor={{ fill: 'var(--default)' }}/>
            <Bar dataKey="rx" stackId="t" fill="var(--accent)" maxBarSize={18} isAnimationActive={false}/>
            <Bar dataKey="tx" stackId="t" fill="var(--warning)" maxBarSize={18} radius={[4, 4, 0, 0]} isAnimationActive={false}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-accent" aria-hidden/>{t('in')}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-warning" aria-hidden/>{t('out')}</span>
        <span>{q.data.countedAt ? t('counted', { at: format.dateTime(new Date(q.data.countedAt), { dateStyle: 'short', timeStyle: 'short' }) }) : t('notYet')}</span>
      </div>
    </div>
  </Section>;
}
