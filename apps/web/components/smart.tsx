"use client";
// Smart cards: a server's health score with its reasons and right-sizing advice, and the customer's
// spending this month with a month-end forecast. Numbers come from /servers/:id/health and /usage/summary.
import { ProgressBar } from '@heroui/react';
import { useFormatter, useTranslations } from 'next-intl';
import { useApiQuery } from '../lib/query';
import { I } from './icon';
import { Section } from './ui';

type Health = { score: number; grade: 'good' | 'fair' | 'poor'; factors: { code: string; impact: number }[]; advice: 'idle' | 'down' | 'up' | null;
  suggestedVcpu: number; vcpu: number; cpu: { avg: number; p95: number; samples: number; days: number } | null };
type Usage = { costs: { currency: string; monthly: number; accrued: number; forecast: number; daysLeft: number }[]; usage: { servers: number; vcpu: number; memoryMb: number; diskGb: number } };

const gradeTone = { good: 'text-success', fair: 'text-warning', poor: 'text-danger' };

// Score ring: the arc and the number say the same; the grade is also written out (not colour alone).
function Ring({ score, grade, label }: { score: number; grade: Health['grade']; label: string }) {
  const c = 2 * Math.PI * 42;
  return <svg viewBox="0 0 100 100" className={`size-24 shrink-0 ${gradeTone[grade]}`} role="img" aria-label={label}>
    <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" strokeWidth="9"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" transform="rotate(-90 50 50)"
      strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"/>
    <text x="50" y="57" textAnchor="middle" className="fill-foreground text-[22px] font-semibold tabular-nums">{score}</text>
  </svg>;
}

export function ServerHealth({ id }: { id: string }) {
  const t = useTranslations('Smart');
  const h = useApiQuery<Health>(['servers', id, 'health'], `/servers/${id}/health`, { refetchInterval: 60_000 }).data;
  if (!h) return <Section title={t('health')}><div className="h-28 animate-pulse rounded-lg bg-default" aria-busy/></Section>;
  const adviceIcon = h.advice === 'up' ? <I name="trending-up" size={16}/> : h.advice === 'down' ? <I name="trending-down" size={16}/> : h.advice === 'idle' ? <I name="moon" size={16}/> : <I name="circle-check" size={16}/>;
  return <Section title={t('health')} description={t('healthHelp')}>
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="flex items-center gap-3">
        <Ring score={h.score} grade={h.grade} label={t('score', { score: h.score })}/>
        <p className={`text-sm font-semibold sm:hidden ${gradeTone[h.grade]}`}>{t(`grade.${h.grade}`)}</p>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className={`hidden text-sm font-semibold sm:block ${gradeTone[h.grade]}`}>{t(`grade.${h.grade}`)}</p>
        {h.factors.length ? <ul className="flex flex-col gap-1.5 text-sm">
          {h.factors.map((f) => <li key={f.code} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2"><I name="circle-minus" size={14} className="shrink-0 text-danger"/>{t(`factor.${f.code as 'IDLE'}`)}</span>
            <span className="shrink-0 tabular-nums text-muted">{f.impact}</span>
          </li>)}
        </ul> : <p className="flex items-center gap-2 text-sm text-muted"><I name="circle-check" size={14} className="text-success"/>{t('noIssues')}</p>}
        {h.cpu && h.cpu.samples >= 24 ? <div className="grid gap-3 sm:grid-cols-2">
          {([['cpuAvg', h.cpu.avg], ['cpuP95', h.cpu.p95]] as const).map(([k, v]) => <div key={k} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs"><span className="text-muted">{t(k)}</span><span className="tabular-nums">{v}%</span></div>
            <ProgressBar aria-label={t(k)} value={Math.min(100, v)} size="sm" color={v > 85 ? 'danger' : v > 60 ? 'warning' : 'success'}><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
          </div>)}
          <p className="text-xs text-muted sm:col-span-2">{t('samples', { n: h.cpu.samples, days: h.cpu.days })}</p>
        </div> : null}
        <p className="flex items-start gap-2 rounded-lg bg-default/60 px-3 py-2 text-sm">
          <span className="mt-0.5 shrink-0 text-accent">{adviceIcon}</span>
          <span>{h.advice ? t(`advice.${h.advice}`, { suggested: h.suggestedVcpu, vcpu: h.vcpu }) : h.cpu && h.cpu.days >= 3 ? t('advice.none') : t('noData')}</span>
        </p>
      </div>
    </div>
  </Section>;
}

export function CostForecast() {
  const t = useTranslations('Smart');
  const format = useFormatter();
  const d = useApiQuery<Usage>(['usage', 'summary'], '/usage/summary', { refetchInterval: 300_000 }).data;
  if (!d) return null;
  const money = (n: number, currency: string) => format.number(n, { style: 'currency', currency });
  const u = d.usage;
  return <Section title={t('cost')} description={t('costHelp')}>
    <div className="flex flex-col gap-4">
      {d.costs.length === 0 ? <p className="text-sm text-muted">{t('noCost')}</p> : d.costs.map((c) => <div key={c.currency} className="flex flex-col gap-2">
        <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
          <div><dt className="text-xs text-muted">{t('accrued')}</dt><dd className="text-xl font-semibold tabular-nums">{money(c.accrued, c.currency)}</dd></div>
          <div><dt className="text-xs text-muted">{t('forecast')}</dt><dd className="text-xl font-semibold tabular-nums text-accent">{money(c.forecast, c.currency)}</dd></div>
          <div><dt className="text-xs text-muted">{t('monthly')}</dt><dd className="text-xl font-semibold tabular-nums">{money(c.monthly, c.currency)}</dd></div>
        </dl>
        <ProgressBar aria-label={t('accrued')} value={c.forecast > 0 ? Math.round((c.accrued / c.forecast) * 100) : 0} size="sm"><ProgressBar.Track><ProgressBar.Fill/></ProgressBar.Track></ProgressBar>
        <p className="text-xs text-muted">{t('daysLeft', { n: c.daysLeft })}</p>
      </div>)}
      <p className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm"><I name="layers" size={14} className="text-muted"/>
        <span className="text-muted">{t('resources')}:</span>
        <span>{t('resourcesValue', { servers: u.servers, vcpu: u.vcpu, memory: Math.round(u.memoryMb / 1024), disk: u.diskGb })}</span></p>
    </div>
  </Section>;
}
