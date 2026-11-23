"use client";
// Live wall in 2D: what a screen without WebGL 2, with a software renderer, or too slow for 3D shows instead. The same
// data and the same figures as the 3D scene, drawn with HTML and SVG: the rack of services with their lights, the
// gauges and the last ten minutes; the statistics as rows of bars; the hosts' power flowing to the facility.
import { useFormatter, useTranslations } from 'next-intl';
import type { EnergyState, StatsState, SystemState } from '../../lib/wall-state';
import { statRows } from '../../lib/wall-state';
import { rowColour, rowName, small, toneFill, toneText } from './figures';

const stale = (fresh: string) => (fresh === 'live' ? '' : 'opacity-45 grayscale');

function Lines({ series, colours, label }: { series: number[][]; colours: string[]; label: string }) {
  const w = 600, h = 140;
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label} className="h-[clamp(5rem,12vh,14rem)] w-full">
    {[0.25, 0.5, 0.75].map((y) => <line key={y} x1={0} x2={w} y1={h - y * h} y2={h - y * h} stroke="var(--w-line)" strokeWidth={1} vectorEffect="non-scaling-stroke"/>)}
    {series.map((s, j) => s.length > 1 && <polyline key={j} fill="none" stroke={colours[j]} strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke"
      points={s.map((v, i) => `${((i / (s.length - 1)) * w).toFixed(1)},${(h - 2 - v * (h - 6)).toFixed(1)}`).join(' ')}/>)}
  </svg>;
}

export function FlatSystem({ s }: { s: SystemState }) {
  const t = useTranslations('Wall'), th = useTranslations('HostState');
  return <div className={`flex h-full min-h-0 flex-col gap-[clamp(0.75rem,1.2vw,2rem)] ${stale(s.freshness)}`} data-testid="wall-flat-system">
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-[clamp(0.75rem,1.2vw,2rem)] md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      {/* The rack: one unit per service. A fault: a striped plate, a blinking light and its state in words. */}
      <ul className="flex min-h-0 flex-col gap-1 overflow-auto rounded-xl border border-[var(--w-line)] bg-[var(--w-soft)] p-2" aria-label={t('system.rack')}>
        {s.units.length === 0 && <li className={`${small} p-2 text-[var(--w-muted)]`}>{t(s.agent === 'off' ? 'system.agentOff' : 'system.noSnapshot')}</li>}
        {s.units.map((u) => <li key={u.name} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${small} ${u.fault ? 'border-[var(--w-bad)] bg-[repeating-linear-gradient(135deg,rgb(242_194_48/0.22)_0_8px,transparent_8px_16px)]' : 'border-[var(--w-line)]'} ${s.unitsFreshness === 'stale' ? 'opacity-60' : ''}`}>
          <span aria-hidden className={`size-[0.7em] shrink-0 rounded-full ${toneFill[u.tone]} ${u.led === 'fast' ? 'wall-blink-fast' : u.led === 'slow' ? 'wall-blink-slow' : u.led === 'dim' ? 'opacity-40' : ''}`}/>
          <span className="min-w-0 flex-1 truncate font-semibold">{u.name}</span>
          <span className="hidden truncate text-[var(--w-muted)] sm:inline">{u.version}</span>
          <span className={`truncate ${u.fault ? `font-semibold ${toneText[u.tone]}` : 'text-[var(--w-muted)]'}`}>{u.fault && <span className="mr-1 rounded bg-[#f2c230] px-1 text-[#16181c]">{t('fault')}</span>}{th(`kind.${u.kind}`)}</span>
        </li>)}
      </ul>
      {/* Gauges: a column each, filled to the value, marked where it turns to a warning and to a danger. */}
      <div className="grid grid-cols-4 items-end gap-[clamp(0.5rem,1vw,1.5rem)] rounded-xl border border-[var(--w-line)] p-3">
        {s.gauges.map((g) => <div key={g.key} className="flex h-full min-h-32 flex-col items-center gap-2">
          <div className="relative w-full max-w-16 flex-1 overflow-hidden rounded-lg border border-[var(--w-line)] bg-[var(--w-soft)]">
            {(g.key === 'load' ? [0.5, 0.75] : [0.75, 0.9]).map((m, j) => <span key={m} aria-hidden className={`absolute inset-x-0 h-px ${j ? 'bg-[var(--w-bad)]' : 'bg-[var(--w-warn)]'}`} style={{ bottom: `${m * 100}%` }}/>)}
            {g.level !== null && <div className={`absolute inset-x-1 bottom-1 rounded ${toneFill[g.tone]} transition-[height] duration-700 motion-reduce:transition-none`} style={{ height: `calc(${g.level * 100}% - 0.5rem)` }}/>}
          </div>
          <span className={`${small} text-[var(--w-muted)]`}>{th(g.key)}</span>
        </div>)}
      </div>
    </div>
    <div className="rounded-xl border border-[var(--w-line)] p-3">
      <p className={`${small} mb-1 flex flex-wrap gap-x-4 text-[var(--w-muted)]`}><span style={{ color: 'var(--w-accent)' }}>■ {t('history.cpu')}</span><span style={{ color: '#c08cff' }}>■ {t('history.memory')}</span><span style={{ color: 'var(--w-amber)' }}>■ {t('history.load')}</span></p>
      <Lines series={[s.history.cpu, s.history.memory, s.history.load]} colours={['var(--w-accent)', '#c08cff', 'var(--w-amber)']} label={t('system.historyLabel')}/>
    </div>
  </div>;
}

export function FlatStats({ s }: { s: StatsState }) {
  const t = useTranslations('Wall'), ts = useTranslations('Stats');
  const format = useFormatter();
  const day = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return format.dateTime(new Date(y, m - 1, d), { day: 'numeric', month: 'short' }); };
  return <div className={`flex h-full flex-col gap-2 ${stale(s.freshness)}`} data-testid="wall-flat-stats">
    {statRows.map((key) => { const row = s.rows.find((r) => r.key === key); const n = row?.values.length ?? 0;
      return <div key={key} className="grid grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)_auto] items-end gap-3">
        <span className={`${small} truncate`} style={{ color: rowColour[key] }}>{ts(`csv.${rowName[key]}`)}</span>
        <svg viewBox={`0 0 ${Math.max(n, 1) * 10} 40`} preserveAspectRatio="none" className="h-[clamp(1.6rem,4.5vh,5rem)] w-full" role="img" aria-label={`${ts(`csv.${rowName[key]}`)}: ${row ? format.number(row.total) : '–'}`}>
          {row?.levels.map((lv, i) => <rect key={i} x={i * 10 + 1.5} width={7} y={40 - Math.max(1, lv * 38)} height={Math.max(1, lv * 38)} fill={rowColour[key]} opacity={lv ? 0.9 : 0.25}/>)}
        </svg>
        <span className={`${small} tabular-nums text-[var(--w-muted)]`}>{t('stats.maxShort', { n: row ? format.number(row.max) : '–' })}</span>
      </div>; })}
    {s.at.length > 0 && <div className={`grid grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)_auto] gap-3 ${small} text-[var(--w-muted)]`}><span/><span className="flex justify-between"><span>{day(s.at[0])}</span><span>{day(s.at[s.at.length - 1])}</span></span><span/></div>}
  </div>;
}

export function FlatEnergy({ s }: { s: EnergyState }) {
  const t = useTranslations('Wall');
  const format = useFormatter();
  const live = s.flowing && s.freshness === 'live';
  return <div className={`flex h-full min-h-0 flex-col gap-3 ${live ? '' : 'opacity-60 grayscale'}`} data-testid="wall-flat-energy">
    <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto">
      {s.feeds.map((f) => <li key={f.key} className={`grid grid-cols-[minmax(5rem,10rem)_minmax(0,1fr)_auto] items-center gap-3 ${small}`}>
        <span className="truncate font-semibold">{f.name}</span>
        {/* The line flows faster with more watts; an estimated host's is broken into dashes; no sample, no flow. */}
        <span className="relative h-[clamp(6px,0.6vw,14px)] overflow-hidden rounded-full bg-[var(--w-soft)]">
          {f.live && live && <span className="wall-flow absolute inset-y-0 left-0 rounded-full" data-source={f.source}
            style={{ width: `${Math.max(4, f.level * 100)}%`, color: f.source === 'estimated' ? 'var(--w-amber)' : 'var(--w-accent)', animationDuration: `${(2.6 - f.level * 2).toFixed(2)}s` }}/>}
        </span>
        <span className="tabular-nums">{f.live ? `${format.number(Math.round(f.watts))} W` : '–'}</span>
      </li>)}
      {!s.feeds.length && <li className={`${small} text-[var(--w-muted)]`}>{t('noData')}</li>}
    </ul>
    {s.hours.length > 0 && <div>
      <p className={`${small} mb-1 text-[var(--w-muted)]`}>{t('energy.day')}</p>
      <svg viewBox={`0 0 ${s.hours.length * 10} 40`} preserveAspectRatio="none" className="h-[clamp(3rem,9vh,9rem)] w-full" role="img" aria-label={t('energy.day')}>
        {s.hours.map((h, i) => <rect key={h.t} x={i * 10 + 1.5} width={7} y={40 - Math.max(1, h.level * 38)} height={Math.max(1, h.level * 38)} fill="var(--w-accent)" opacity={i === s.hours.length - 1 ? 1 : 0.55}/>)}
      </svg>
    </div>}
  </div>;
}
