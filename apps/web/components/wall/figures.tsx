"use client";
// Live wall: the figures, in words and numbers, beside the 3D scene or the 2D wall (the same component in both, so
// both say exactly the same). Sized to be read from across a room on a 1080p screen, and as plain text for screen
// readers. A tone is always a word and an icon too, never only a colour.
import { useFormatter, useTranslations } from 'next-intl';
import { I } from '../icon';
import { usePercent } from '../../lib/percent';
import type { EnergyState, Power, Stats, StatsState, SystemState, Tone } from '../../lib/wall-state';
import { statRows } from '../../lib/wall-state';

export const toneText: Record<Tone, string> = { ok: 'text-[var(--w-ok)]', warn: 'text-[var(--w-warn)]', bad: 'text-[var(--w-bad)]', none: 'text-[var(--w-none)]' };
export const toneFill: Record<Tone, string> = { ok: 'bg-[var(--w-ok)]', warn: 'bg-[var(--w-warn)]', bad: 'bg-[var(--w-bad)]', none: 'bg-[var(--w-none)]' };
export const toneIcons: Record<Tone, string> = { ok: 'circle-check', warn: 'triangle-alert', bad: 'octagon-x', none: 'circle-dashed' };
// The same colours as the statistics scene's rows.
export const rowColour: Record<string, string> = { created: '#2ef280', deleted: '#ff6b8c', signups: '#409eff', ticketsOpened: '#ffa826', ticketsClosed: '#33e0d9', opsOk: '#9e7aff', opsFailed: '#ff3d33' };
export const rowName = { created: 'created', deleted: 'deleted', signups: 'signups', ticketsOpened: 'opened', ticketsClosed: 'closed', opsOk: 'opsOk', opsFailed: 'opsFailed' } as const;

export const big = 'text-[clamp(1.5rem,2.2vw,4.6rem)] font-semibold leading-none tabular-nums tracking-tight';
export const small = 'text-[clamp(0.8rem,0.9vw,1.75rem)]';
const label = `${small} font-medium text-[var(--w-muted)]`;

// tone: a judged value (ok, warning, danger, nothing known); without one the number is plain text.
function Figure({ id, name, value, tone, hint, level }: { id: string; name: string; value: string; tone?: Tone; hint?: React.ReactNode; level?: number | null }) {
  return <div data-testid={`wall-figure-${id}`} className="flex min-w-0 flex-col gap-[clamp(0.25rem,0.4vw,0.75rem)]">
    <p className={label}>{name}</p>
    <p className={`${big} ${tone ? toneText[tone] : ''}`} data-testid={`wall-value-${id}`}>{value}</p>
    {level !== undefined && <div className="h-[clamp(4px,0.35vw,10px)] overflow-hidden rounded-full bg-[var(--w-soft)]" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={level === null ? undefined : Math.round(level * 100)}>
      {level !== null && <div className={`h-full rounded-full ${toneFill[tone ?? 'none']} transition-[width] duration-700 motion-reduce:transition-none`} style={{ width: `${Math.max(1.5, level * 100)}%` }}/>}</div>}
    {hint && <p className={`${small} text-[var(--w-muted)]`}>{hint}</p>}
  </div>;
}
export function Verdict({ tone, text, id = 'wall-verdict' }: { tone: Tone; text: string; id?: string }) {
  return <p data-testid={id} data-tone={tone} className={`flex items-center gap-[0.4em] text-[clamp(1.25rem,1.7vw,3.4rem)] font-semibold leading-tight ${toneText[tone]}`}>
    <I name={toneIcons[tone]} size={28} className="size-[1.1em] shrink-0"/>{text}</p>;
}

// ---- System -------------------------------------------------------------------------------------------------------------
export function SystemFigures({ s }: { s: SystemState }) {
  const t = useTranslations('Wall'), th = useTranslations('HostState');
  const format = useFormatter(), percent = usePercent();
  const time = (at: number | null) => (at === null ? '–' : format.dateTime(new Date(at), { timeStyle: 'short' }));
  const value = (g: SystemState['gauges'][number]) => g.value === null ? '–' : g.key === 'load' ? format.number(g.value, { maximumFractionDigits: 2 }) : percent(g.value, g.key === 'cpu' ? 1 : 0);
  const faults = s.units.filter((u) => u.fault);
  const verdict = s.verdict === 'none' ? t('noData') : s.problems ? th('attention', { n: s.problems }) : th('healthy');
  const cores = s.cores ? th('cores', { n: s.cores }) : undefined;
  return <div className="flex flex-col gap-[clamp(0.9rem,1.4vw,2.6rem)]">
    <div className="flex flex-col gap-2">
      <Verdict tone={s.verdict} text={verdict}/>
      <p className={`${small} text-[var(--w-muted)]`} data-testid="wall-services-line">
        <span className={s.api === 'down' ? toneText.bad : ''}>{t(`system.api.${s.api}`)}</span> · <span className={s.worker === 'stale' || s.worker === 'none' ? toneText.warn : ''}>{t(`system.worker.${s.worker}`, { time: time(s.workerSeen) })}</span></p>
    </div>
    <div className="grid grid-cols-2 gap-[clamp(0.9rem,1.3vw,2.4rem)]">
      {s.gauges.map((g) => <Figure key={g.key} id={g.key} name={th(g.key)} value={value(g)} tone={g.tone} level={g.level}
        hint={g.key === 'load' && g.value !== null ? cores : undefined}/>)}
    </div>
    <div className="flex flex-col gap-2">
      <p className={`${small} font-semibold`}>{s.unitsFreshness === 'missing' ? t(s.agent === 'off' ? 'system.agentOff' : 'system.noSnapshot') : t('system.services', { n: s.units.length, faults: faults.length })}</p>
      {faults.length > 0 && <ul className="flex flex-col gap-1.5" data-testid="wall-faults">
        {faults.slice(0, 8).map((u) => <li key={u.name} className={`flex items-center gap-2 ${small} ${toneText[u.tone]}`}>
          <span aria-hidden className={`size-[0.7em] shrink-0 rounded-full ${toneFill[u.tone]} ${u.led === 'fast' ? 'wall-blink-fast' : u.led === 'slow' ? 'wall-blink-slow' : ''}`}/>
          <span className="truncate font-semibold">{u.name}</span><span className="truncate">{th(`kind.${u.kind}`)}{u.restarts > 0 && ` · ${th('restarts', { n: u.restarts })}`}</span></li>)}
      </ul>}
      {s.unitsAt !== null && <p className={`${small} ${s.unitsFreshness === 'stale' ? toneText.warn : 'text-[var(--w-muted)]'}`}>{t(s.unitsFreshness === 'stale' ? 'system.snapshotOld' : 'system.snapshot', { time: time(s.unitsAt) })}</p>}
    </div>
  </div>;
}

// ---- Statistics ---------------------------------------------------------------------------------------------------------
export function StatsFigures({ raw, s }: { raw: Stats | null; s: StatsState }) {
  const t = useTranslations('Wall'), ts = useTranslations('Stats');
  const format = useFormatter(), percent = usePercent();
  if (!raw || s.freshness === 'missing') return <p className={`${small} text-[var(--w-muted)]`}>{t('noData')}</p>;
  const k = raw.kpis;
  const change = (c: number | null, invert = false) => c === null ? t('stats.new') : c === 0 ? t('stats.same')
    : <span className={(c > 0) !== invert ? toneText.ok : toneText.warn}><I name={c > 0 ? 'trending-up' : 'trending-down'} size={16} className="mr-1 inline size-[1em] align-[-0.12em]"/>{percent(c, 1, true)}</span>;
  return <div className="flex flex-col gap-[clamp(0.9rem,1.4vw,2.6rem)]">
    <p className={`${small} text-[var(--w-muted)]`}>{t('stats.period', { days: raw.days })}</p>
    <div className="grid grid-cols-2 gap-[clamp(0.9rem,1.3vw,2.4rem)]">
      <Figure id="servers" name={ts('kpi.servers')} value={format.number(k.servers.value)} hint={change(k.servers.change)}/>
      <Figure id="monthly" name={ts('kpi.monthly')} value={k.monthly ? format.number(k.monthly.value, { style: 'currency', currency: k.monthly.currency, maximumFractionDigits: 0 }) : '–'} hint={k.monthly ? change(k.monthly.change) : undefined}/>
      <Figure id="signups" name={ts('kpi.signups')} value={format.number(k.signups.value)} hint={change(k.signups.change)}/>
      <Figure id="tickets" name={ts('kpi.tickets')} value={format.number(k.tickets.value)} hint={change(k.tickets.change, true)}/>
      <Figure id="success" name={ts('kpi.success')} value={k.successRate.value === null ? '–' : percent(k.successRate.value, 1)}
        tone={k.successRate.value === null ? 'none' : k.successRate.value < 95 ? 'bad' : 'ok'} hint={k.successRate.value === null ? undefined : change(k.successRate.change)}/>
    </div>
    <ul className="grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-2" data-testid="wall-rows">
      {statRows.map((key) => { const row = s.rows.find((r) => r.key === key);
        return <li key={key} className={`flex items-center gap-2 ${small}`}><span aria-hidden className="size-[0.75em] shrink-0 rounded-sm" style={{ background: rowColour[key] }}/>
          <span className="min-w-0 flex-1 truncate">{ts(`csv.${rowName[key]}`)}</span><span className="font-semibold tabular-nums">{row ? format.number(row.total) : '–'}</span></li>; })}
    </ul>
  </div>;
}

// ---- Energy -------------------------------------------------------------------------------------------------------------
export function EnergyFigures({ raw, s }: { raw: Power | null; s: EnergyState }) {
  const t = useTranslations('Wall'), te = useTranslations('Energy');
  const format = useFormatter();
  if (!raw || s.freshness === 'missing') return <p className={`${small} text-[var(--w-muted)]`}>{t('noData')}</p>;
  const kw = (w: number | null) => (w === null ? '–' : `${format.number(w / 1000, { maximumFractionDigits: 2 })} kW`);
  const money = (x: string) => format.number(Number(x), { style: 'currency', currency: raw.settings.currency });
  const kwh = (x: number) => `${format.number(x, { maximumFractionDigits: 1 })} kWh`;
  return <div className="flex flex-col gap-[clamp(0.9rem,1.4vw,2.6rem)]">
    {!s.flowing && <Verdict id="wall-noflow" tone="warn" text={t('energy.noFlow')}/>}
    <div className="grid grid-cols-2 gap-[clamp(0.9rem,1.3vw,2.4rem)]">
      <Figure id="power" name={te('now')} value={kw(s.watts)} tone={s.flowing ? 'ok' : 'none'} hint={s.facilityWatts === null ? undefined : te('facility', { kw: format.number(s.facilityWatts / 1000, { maximumFractionDigits: 2 }), pue: raw.settings.pue })}/>
      <Figure id="today" name={te('today')} value={kwh(raw.energy.todayKwh)} hint={money(raw.energy.costToday)}/>
      <Figure id="month" name={te('month')} value={kwh(raw.energy.monthKwh)} hint={money(raw.energy.costMonth)}/>
      <Figure id="co2" name={te('co2Month')} value={`${format.number(raw.energy.co2MonthKg, { maximumFractionDigits: 1 })} kg`}/>
    </div>
    <div className="flex flex-col gap-2">
      <p className={`${small} text-[var(--w-muted)]`}>{te('measuredOf', { measured: raw.now.measured, hosts: raw.now.hosts })}</p>
      <ul className="flex flex-col gap-1.5" data-testid="wall-feeds">
        {s.feeds.slice(0, 8).map((f) => <li key={f.key} className={`flex items-center gap-2 ${small}`}>
          <span aria-hidden className={`h-[0.3em] w-[1.6em] shrink-0 ${f.source === 'estimated' ? 'bg-[repeating-linear-gradient(90deg,var(--w-amber)_0_4px,transparent_4px_8px)]' : 'bg-[var(--w-accent)]'} ${f.live ? '' : 'opacity-30'}`}/>
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="text-[var(--w-muted)]">{t(`energy.${f.source}`)}</span>
          <span className="font-semibold tabular-nums">{f.live ? `${format.number(Math.round(f.watts))} W` : '–'}</span></li>)}
        {s.others.hosts > 0 && <li className={`${small} text-[var(--w-muted)]`}>{t('energy.othersLine', { n: s.others.hosts, w: format.number(Math.round(s.others.watts)) })}</li>}
      </ul>
    </div>
  </div>;
}
