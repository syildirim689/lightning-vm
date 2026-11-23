"use client";
// Admin → System → Server state: the panel's own server, now. Processor, memory, load and the data disk are read by
// the API every five seconds (the charts show the last ten minutes); services, file systems, the busiest processes
// and the last log lines come from the host agent's snapshot, refreshed when this page opens and on demand.
import { Button, SearchField, toast } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { usePercent } from '../../../lib/percent';
import { useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { Notice, Section, SelectInput, StatusChip, type Tone } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { can } from '../../../lib/permissions';
import { useApiQuery } from '../../../lib/query';
import { fold } from '../../../lib/search';
import { useBytes } from '../../../lib/units';
import { kindTone, lineTone, ServiceDrawer, versionText, type ServiceRow } from './service-detail';
import WallLink from '../../../components/wall/wall-link';

type State = { checkedAt: string; services: ServiceRow[]; disks: { mount: string; device: string; total: number; used: number; free: number }[]; inodesPercent: number;
  processes: { pid: number; cpu: number; memory: number; rss: number; name: string }[]; failedUnits: { unit: string }[]; addresses: { interface: string; address: string }[];
  dockerDisk: { type: string; size: string; reclaimable: string }[]; docker: string; users: number };
type Live = { supported: boolean; cpu: { percent: number | null; iowait: number | null; cores: number; model: string; load: number[] };
  memory: { total: number; available: number; used: number; cached: number; swapTotal: number; swapUsed: number } | null; disk: { total: number; free: number } | null; uptime: number; kernel: string;
  history: { at: number; cpu: number; memory: number; load: number }[];
  panel: { apiMemory: number; apiUptime: number; node: string; databaseSize: number | null; connections: { open: number; max: number } | null; redisMemory: number | null };
  state: State | null; logs: string[]; agent: { installed: boolean; busy: boolean } };

const toneOf = (p: number): Tone => (p >= 90 ? 'danger' : p >= 75 ? 'warning' : 'success');
const text = { success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent', default: 'text-foreground' } as Record<Tone, string>;
const fill = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', accent: 'bg-accent', default: 'bg-accent' } as Record<Tone, string>;

// The last ten minutes as a small area chart; the label says what it shows for people who cannot see it.
// Motion, all of it skipped when the viewer asks for reduced motion: the chart is drawn in from the left the first
// time; each new sample (every five seconds) slides the line one step to the left instead of jumping; pointing at it
// shows the value and the time of the nearest sample. The animations run on the compositor (a transform and a
// clip-path through the Web Animations API): no layout is read or changed, and the chart is not mounted again per poll.
function Spark({ points, max, label, tone, show }: { points: { at: number; v: number }[]; max: number; label: string; tone: Tone; show: (v: number) => string }) {
  const format = useFormatter();
  const reduce = useReducedMotion();
  const svg = useRef<SVGSVGElement>(null), line = useRef<SVGGElement>(null), seen = useRef<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length, w = 240, h = 48, top = Math.max(max, ...points.map((p) => p.v), 1);
  const last = n ? points[n - 1].at : null;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * w : w);
  const y = (v: number) => h - 2 - (v / top) * (h - 6);
  // Before the browser paints the new line: the first time, a reveal from the left; afterwards a slide of one step.
  useLayoutEffect(() => {
    if (last === null || n < 2) return;
    const first = seen.current === null, moved = seen.current !== null && seen.current !== last;
    seen.current = last;
    if (reduce || typeof Element.prototype.animate !== 'function') return;
    if (first) svg.current?.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 900, easing: 'cubic-bezier(.2,.7,.2,1)' });
    else if (moved) line.current?.animate([{ transform: `translateX(${(w / (n - 1)).toFixed(2)}px)` }, { transform: 'translateX(0)' }], { duration: 600, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }, [last, n, reduce]);
  if (n < 2) return <div className="h-12 rounded-lg bg-default/40" aria-hidden/>;
  const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`);
  const at = hover === null ? null : points[Math.min(n - 1, hover)];
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.round(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * (n - 1)));
  };
  return <div className="relative">
    <svg ref={svg} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`group h-12 w-full touch-pan-y ${text[tone]}`} role="img" aria-label={label}
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}>
      <g ref={line}>
        <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="currentColor" className="opacity-[.14] transition-opacity duration-200 group-hover:opacity-25 motion-reduce:transition-none"/>
        <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
          className="transition-[stroke-width] duration-200 group-hover:[stroke-width:2.4] motion-reduce:transition-none"/>
      </g>
    </svg>
    {at && hover !== null && <>
      <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 w-px bg-current opacity-40" style={{ left: `${(x(hover) / w) * 100}%` }}/>
      <span aria-hidden className={`pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-background ${text[tone]}`}
        style={{ left: `${(x(hover) / w) * 100}%`, top: `${(y(at.v) / h) * 100}%` }}/>
      <span role="status" className={`pointer-events-none absolute top-full z-10 mt-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] whitespace-nowrap text-foreground tabular-nums shadow-sm ${x(hover) / w > 0.6 ? '-translate-x-full' : ''}`}
        style={{ left: `${(x(hover) / w) * 100}%` }}>{show(at.v)} · {format.dateTime(new Date(at.at), { timeStyle: 'medium' })}</span>
    </>}
  </div>;
}
function Bar({ percent, tone, label }: { percent: number; tone: Tone; label: string }) {
  return <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label} className="h-2 overflow-hidden rounded-full bg-default">
    <div className={`h-full origin-left rounded-full transition-[width] duration-500 motion-reduce:transition-none ${fill[tone]}`} style={{ width: `${Math.min(100, Math.max(1.5, percent))}%` }}/></div>;
}
function Tile({ icon, label, value, tone = 'default', children }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: Tone; children?: React.ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-xs font-medium text-muted">{label}</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${text[tone]}`}>{value}</p></div>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-default text-muted">{icon}</span>
    </div>
    {children}
  </div>;
}

export default function HostState() {
  const t = useTranslations('HostState');
  const format = useFormatter();
  const percent = usePercent();
  const now = useNow({ updateInterval: 30_000 });
  const bytes = useBytes();
  const { error } = useErrorText();
  const me = useMe();
  const client = useQueryClient();
  const q = useApiQuery<Live>(['admin', 'host-live'], '/admin/host/live', { refetchInterval: 5_000 });
  const d = q.data;
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // again: a quiet request the agent refused (it was busy with another quiet request of this page) is asked once more.
  const refresh = async (quiet = false, again = true) => {
    setAsking(true);
    try { await apiFetch('/admin/host/state', { method: 'POST' }); if (!quiet) toast.success(t('asked')); }
    catch (e) { if (!quiet) toast.danger(error(e)); else if (again) setTimeout(() => void refresh(true, false), 15_000); }
    finally { setTimeout(() => { setAsking(false); void client.invalidateQueries({ queryKey: ['admin', 'host-logs'] }); }, 12_000); }
  };
  // Opening the page takes a fresh snapshot when the last one is older than two minutes (quietly; another task may be running).
  const opened = useRef(false);
  useEffect(() => {
    if (!d || opened.current) return;
    opened.current = true;
    if (d.agent.installed && !d.agent.busy && (!d.state || Date.now() - Date.parse(d.state.checkedAt) > 120_000)) void refresh(true);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <Section title={t('title')}><p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p></Section>;
  const s = d.state;
  const ago = (iso: string) => format.relativeTime(new Date(Math.min(Date.parse(iso), now.getTime())), now);
  const span = (sec: number) => { const days = Math.floor(sec / 86400), hours = Math.floor((sec % 86400) / 3600), mins = Math.floor((sec % 3600) / 60); return days ? t('days', { days, hours }) : t('hours', { hours, mins }); };
  const cpu = d.cpu.percent ?? 0, mem = d.memory && d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0;
  const disk = d.disk && d.disk.total ? ((d.disk.total - d.disk.free) / d.disk.total) * 100 : 0;
  const load = d.cpu.load[0] ?? 0, loadPct = d.cpu.cores ? (load / d.cpu.cores) * 100 : 0;
  const swap = d.memory && d.memory.swapTotal ? (d.memory.swapUsed / d.memory.swapTotal) * 100 : 0;
  // A one-shot job that finished (migrate, exit code 0) is not a fault: the API says which states are (host-services.ts).
  const down = (s?.services ?? []).filter((x) => x.fault && x.kind !== 'unhealthy');
  const unhealthy = (s?.services ?? []).filter((x) => x.kind === 'unhealthy');
  const fullDisks = (s?.disks ?? []).filter((x) => x.total && x.used / x.total >= 0.9);
  const problems = [
    cpu >= 90 && t('warn.cpu', { n: Math.round(cpu) }), mem >= 90 && t('warn.memory', { n: Math.round(mem) }), loadPct >= 150 && t('warn.load', { load, cores: d.cpu.cores }),
    swap >= 50 && t('warn.swap', { n: Math.round(swap) }), ...fullDisks.map((x) => t('warn.disk', { mount: x.mount, n: Math.round((x.used / x.total) * 100) })),
    (s?.inodesPercent ?? 0) >= 90 && t('warn.inodes', { n: s!.inodesPercent }), ...down.map((x) => t('warn.down', { service: x.service })), ...unhealthy.map((x) => t('warn.unhealthy', { service: x.service })),
    ...(s?.failedUnits ?? []).map((x) => t('warn.unit', { unit: x.unit })),
  ].filter(Boolean) as string[];

  return <Section title={t('title')} description={t('intro')}
    actions={<div className="flex flex-wrap items-center gap-2">
      {/* The live wall of this state, right before its verdict. */}
      <WallLink scene="system"/>
      <StatusChip tone={problems.length ? (down.length || cpu >= 90 || mem >= 90 || fullDisks.length ? 'danger' : 'warning') : 'success'}>{problems.length ? t('attention', { n: problems.length }) : t('healthy')}</StatusChip>
      {d.agent.installed && <Button size="sm" variant="secondary" isPending={asking} isDisabled={d.agent.busy} onPress={() => void refresh()}><I name="refresh-cw" size={14}/>{t('refresh')}</Button>}
    </div>}>
    <div className="flex flex-col gap-6">
      {!d.supported && <Notice tone="default">{t('unsupported')}</Notice>}
      {problems.length > 0 && <Notice tone={down.length || fullDisks.length ? 'danger' : 'warning'} title={t('attentionTitle')}>
        <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Notice>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={<I name="cpu" size={18}/>} label={t('cpu')} value={d.cpu.percent === null ? '–' : percent(cpu, 1)} tone={d.cpu.percent === null ? 'default' : toneOf(cpu)}>
          <Spark points={d.history.map((h) => ({ at: h.at, v: h.cpu }))} max={100} tone={toneOf(cpu)} label={t('chart', { what: t('cpu') })} show={(v) => percent(v, 1)}/>
          <p className="text-xs text-muted">{t('cores', { n: d.cpu.cores })}{d.cpu.iowait !== null && d.cpu.iowait >= 1 && <> · {t('iowait', { n: format.number(d.cpu.iowait, { maximumFractionDigits: 1 }) })}</>}</p>
          {d.cpu.model && <p className="truncate text-xs text-muted" title={d.cpu.model}>{d.cpu.model}</p>}
        </Tile>
        <Tile icon={<I name="memory-stick" size={18}/>} label={t('memory')} value={d.memory ? percent(mem) : '–'} tone={d.memory ? toneOf(mem) : 'default'}>
          <Spark points={d.history.map((h) => ({ at: h.at, v: h.memory }))} max={100} tone={toneOf(mem)} label={t('chart', { what: t('memory') })} show={(v) => percent(v)}/>
          {d.memory && <><p className="text-xs text-muted">{t('usedOf', { used: bytes(d.memory.used), total: bytes(d.memory.total) })}</p>
            <p className="text-xs text-muted">{t('cached', { n: bytes(d.memory.cached) })}{d.memory.swapTotal > 0 && <> · {t('swap', { used: bytes(d.memory.swapUsed), total: bytes(d.memory.swapTotal) })}</>}</p></>}
        </Tile>
        <Tile icon={<I name="gauge" size={18}/>} label={t('load')} value={format.number(load, { maximumFractionDigits: 2 })} tone={loadPct >= 150 ? 'danger' : loadPct >= 100 ? 'warning' : 'success'}>
          <Spark points={d.history.map((h) => ({ at: h.at, v: h.load }))} max={d.cpu.cores} tone={loadPct >= 150 ? 'danger' : loadPct >= 100 ? 'warning' : 'success'} label={t('chart', { what: t('load') })}
            show={(v) => format.number(v, { maximumFractionDigits: 2 })}/>
          <p className="text-xs text-muted">{t('loadAvg', { a: d.cpu.load[0] ?? 0, b: d.cpu.load[1] ?? 0, c: d.cpu.load[2] ?? 0 })}</p>
          <p className="text-xs text-muted">{t('loadHelp', { n: d.cpu.cores })}</p>
        </Tile>
        <Tile icon={<I name="hard-drive" size={18}/>} label={t('disk')} value={d.disk ? percent(disk) : '–'} tone={d.disk ? toneOf(disk) : 'default'}>
          <div className="flex h-12 items-center">{d.disk && <div className="w-full"><Bar percent={disk} tone={toneOf(disk)} label={t('disk')}/></div>}</div>
          {d.disk && <p className="text-xs text-muted">{t('freeOf', { free: bytes(d.disk.free), total: bytes(d.disk.total) })}</p>}
          <p className="text-xs text-muted">{t('diskHelp')}</p>
        </Tile>
      </div>

      <dl className="grid gap-x-6 gap-y-3 rounded-2xl border border-border p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        {([['uptime', span(d.uptime)], ['kernel', d.kernel], ['docker', s?.docker || '–'], ['users', s ? String(s.users) : '–'],
          ['api', `${bytes(d.panel.apiMemory)} · ${span(d.panel.apiUptime)}`], ['database', d.panel.databaseSize === null ? '–' : bytes(d.panel.databaseSize)],
          ['connections', d.panel.connections ? `${d.panel.connections.open} / ${d.panel.connections.max}` : '–'], ['redis', d.panel.redisMemory === null ? '–' : bytes(d.panel.redisMemory)]] as const).map(([k, v]) =>
          <div key={k} className="min-w-0"><dt className="text-xs text-muted">{t(`fact.${k}`)}</dt><dd className="mt-0.5 truncate font-medium tabular-nums" title={v}>{v}</dd></div>)}
      </dl>

      {!d.agent.installed ? <Notice tone="warning" title={t('agentMissingTitle')}>{t('agentMissing')}</Notice>
        : !s ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><I name="loader" size={14} className="animate-spin motion-reduce:animate-none"/>{t('firstSnapshot')}</p> : <>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{t('services', { n: s.services.length })}</h3><p className="text-xs text-muted">{t('snapshot', { when: ago(s.checkedAt) })}</p></div>
          {/* Each service opens its detail: what its state means, what to do, restart, version, ports and its log. */}
          <ul className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3" data-testid="services">
            {s.services.map((x) => { const ok = x.state === 'running', bad = x.fault, tone = kindTone[x.kind];
              const done = x.kind === 'completed' && x.finishedAt && !x.finishedAt.startsWith('0001-') ? ago(x.finishedAt) : '';
              return <li key={x.service}>
                <button type="button" onClick={() => setOpen(x.service)} aria-label={t('svc.open', { service: x.service, state: t(`kind.${x.kind}`) })}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none ${bad ? 'border-danger/50 bg-danger/5' : 'border-border'}`}>
                  <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${bad ? 'bg-danger' : tone === 'success' ? 'bg-success' : tone === 'accent' ? 'bg-accent' : 'bg-default-foreground/30'}`}/>
                  <span className="min-w-0 flex-1"><span className="flex min-w-0 items-baseline gap-2"><span className="truncate text-sm font-medium">{x.service}</span>
                    <span aria-hidden className="truncate text-[11px] text-muted" title={versionText(x.version)}>{versionText(x.version)}</span></span>
                    {/* The button is named "<service>: <state>. Open the details"; what else it shows is for the eye (and the detail), so the name contains all that is read out (WCAG 2.5.3). */}
                    <span aria-hidden className={`block truncate text-xs ${bad ? 'text-danger' : 'text-muted'}`} title={x.status}>
                      {x.kind === 'completed' ? t('svc.completedAgo', { when: done || '–' }) : t(`kind.${x.kind}`)}{x.kind === 'failed' && x.exitCode !== null && ` (${x.exitCode})`}{x.restarts > 0 && ` · ${t('restarts', { n: x.restarts })}`}</span></span>
                  {ok && <span aria-hidden className="shrink-0 text-right text-xs tabular-nums"><span className={`block ${x.cpu >= 80 ? 'text-warning' : ''}`}>{percent(x.cpu, 1)} CPU</span><span className="block text-muted">{x.memory || '–'}</span></span>}
                  <I name="chevron-right" size={14} className="shrink-0 text-muted"/>
                </button>
              </li>; })}
          </ul>
          <ServiceDrawer name={open} onClose={() => setOpen(null)}/>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{t('disks')}</h3>
            <ul className="flex flex-col gap-3 rounded-2xl border border-border p-4">
              {s.disks.map((x) => { const p = x.total ? (x.used / x.total) * 100 : 0;
                return <li key={x.mount} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm"><span className="min-w-0 truncate font-mono text-xs" title={x.device}>{x.mount}</span>
                    <span className={`shrink-0 tabular-nums ${text[toneOf(p)]}`}>{percent(p)}</span></div>
                  <Bar percent={p} tone={toneOf(p)} label={x.mount}/>
                  <p className="text-xs text-muted">{t('freeOf', { free: bytes(x.free), total: bytes(x.total) })}</p>
                </li>; })}
              {s.dockerDisk.length > 0 && <li className="border-t border-separator pt-3 text-xs text-muted"><span className="font-medium text-foreground">Docker</span>
                {s.dockerDisk.map((x) => <span key={x.type}> · {x.type}: {x.size}{x.reclaimable && x.reclaimable !== '0B' ? ` (${t('reclaimable', { n: x.reclaimable })})` : ''}</span>)}</li>}
            </ul>
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{t('processes')}</h3>
            <div className="overflow-x-auto rounded-2xl border border-border">
              <table className="w-full min-w-[22rem] text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="px-4 py-2 font-medium">{t('proc.name')}</th><th className="px-2 py-2 text-right font-medium">PID</th><th className="px-2 py-2 text-right font-medium">CPU</th><th className="px-4 py-2 text-right font-medium">{t('memory')}</th></tr></thead>
                <tbody className="divide-y divide-separator">
                  {s.processes.map((p) => <tr key={p.pid}><td className="max-w-40 truncate px-4 py-2 font-mono text-xs">{p.name}</td><td className="px-2 py-2 text-right tabular-nums text-muted">{p.pid}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${p.cpu >= 80 ? 'text-warning' : ''}`}>{percent(p.cpu, 1)}</td><td className="px-4 py-2 text-right tabular-nums">{bytes(p.rss)}</td></tr>)}
                </tbody>
              </table>
            </div>
            {s.addresses.length > 0 && <p className="text-xs text-muted">{t('addresses')}: {s.addresses.map((a) => `${a.address} (${a.interface})`).join(', ')}</p>}
          </div>
        </div>

        {can(me?.permissions, 'system.update') && d.logs.length > 0 && <Logs sources={d.logs} snapshotAt={s.checkedAt}/>}
      </>}
    </div>
  </Section>;
}

// The last lines of a service (or of the system journal), with search, "problems only", copy and download.
function Logs({ sources, snapshotAt }: { sources: string[]; snapshotAt: string }) {
  const t = useTranslations('HostState');
  const [source, setSource] = useState(sources.includes('api') ? 'api' : sources[0]);
  const [find, setFind] = useState('');
  const [only, setOnly] = useState(false);
  const [wrap, setWrap] = useState(false);
  // gcTime 0: log lines (masked by the API, but still logs) are not kept in the browser beyond this view.
  const q = useQuery<{ lines: string[] }>({ queryKey: ['admin', 'host-logs', source, snapshotAt], queryFn: ({ signal }) => apiFetch<{ lines: string[] }>(`/admin/host/logs?source=${encodeURIComponent(source)}&lines=300`, { signal }), gcTime: 0 });
  const box = useRef<HTMLPreElement>(null);
  const lines = q.data?.lines ?? [];
  const needle = fold(find.trim());
  const shown = useMemo(() => lines.filter((l) => (!only || lineTone(l)) && (!needle || fold(l).includes(needle))), [lines, only, needle]);
  // A newly loaded log starts at its end, where the newest lines are.
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [q.data, source]);
  const problems = lines.filter((l) => lineTone(l)).length;
  const save = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([shown.join('\n')], { type: 'text/plain' })); a.download = `${source}.log`; a.click(); URL.revokeObjectURL(a.href); };
  const chip = (on: boolean) => `flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent ${on ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`;
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{t('logs')}</h3><p className="text-xs text-muted">{t('logsHelp')}</p></div>
    <div className="flex flex-wrap items-end gap-2">
      <SelectInput className="w-44" label={t('logSource')} value={source} onChange={setSource} options={sources.map((x) => ({ id: x, label: x === 'system' ? t('logSystem') : x }))}/>
      <SearchField aria-label={t('logFind')} value={find} onChange={setFind} className="min-w-48 flex-1">
        <SearchField.Group><SearchField.SearchIcon/><SearchField.Input placeholder={t('logFind')}/><SearchField.ClearButton/></SearchField.Group></SearchField>
      <button type="button" aria-pressed={only} onClick={() => setOnly(!only)} className={chip(only)}><I name="triangle-alert" size={13}/>{t('logProblems', { n: problems })}</button>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={chip(wrap)}><I name="wrap-text" size={13}/>{t('logWrap')}</button>
      <Button size="sm" variant="ghost" isDisabled={!shown.length} onPress={() => void navigator.clipboard?.writeText(shown.join('\n')).then(() => toast.success(t('logCopied')), () => undefined)}><I name="copy" size={14}/>{t('logCopy')}</Button>
      <Button size="sm" variant="ghost" isDisabled={!shown.length} onPress={save}><I name="download" size={14}/>{t('logSave')}</Button>
    </div>
    <pre ref={box} tabIndex={0} aria-label={t('logsOf', { source })} className={`max-h-96 min-h-32 overflow-auto rounded-2xl border border-border bg-default/40 p-3 font-mono text-[11.5px] leading-relaxed ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
      {q.isPending ? t('loading') : !shown.length ? <span className="text-muted">{lines.length ? t('logNoMatch') : t('logEmpty')}</span>
        : shown.map((l, i) => <span key={i} className={`block ${lineTone(l)}`}>{l}</span>)}
    </pre>
    <p className="text-xs text-muted">{t('logCount', { shown: shown.length, total: lines.length })}</p>
  </div>;
}
