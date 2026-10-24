"use client";
// Animated topology: a tree drawn left to right (Internet -> ... -> servers). Packets run along the links,
// inbound (toward the servers) and outbound in two colours; how many and how fast follows the traffic of
// everything below a link. Nodes are focusable; hovering or focusing one highlights its path to the root.
import { motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { I } from './icon';

export type Tone = 'default' | 'success' | 'warning' | 'danger' | 'accent' | 'muted';
export type TopoNode = {
  id: string; kind: 'internet' | 'location' | 'connection' | 'compute' | 'host' | 'server' | 'more'; label: string; sub?: string; tone?: Tone;
  rx?: number | null; tx?: number | null; // KB/s at this node (leaves); parents sum their subtree
  bars?: { label: string; value: number }[]; // 0..1, e.g. CPU and memory
  badges?: string[]; // shown on the link into this node (firewalls)
  details?: [string, string][];
  children?: TopoNode[];
};
type Placed = TopoNode & { x: number; y: number; depth: number; parent?: Placed; rxSum: number; txSum: number };

const colW = 220, rowH = 64, nodeW = 176, nodeH = 48, pad = 24;
const toneClass: Record<Tone, string> = {
  default: 'border-border', muted: 'border-border opacity-70', accent: 'border-accent', success: 'border-success', warning: 'border-warning', danger: 'border-danger',
};

function layout(root: TopoNode) {
  const placed: Placed[] = [];
  let row = 0;
  const walk = (n: TopoNode, depth: number, parent?: Placed): Placed => {
    const p: Placed = { ...n, depth, parent, x: pad + depth * colW, y: 0, rxSum: 0, txSum: 0 };
    placed.push(p);
    const kids = (n.children ?? []).map((c) => walk(c, depth + 1, p));
    if (kids.length) {
      p.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      p.rxSum = kids.reduce((a, k) => a + k.rxSum, 0);
      p.txSum = kids.reduce((a, k) => a + k.txSum, 0);
    } else {
      p.y = pad + row++ * rowH;
      p.rxSum = n.rx ?? 0; p.txSum = n.tx ?? 0;
    }
    return p;
  };
  walk(root, 0);
  const depth = Math.max(...placed.map((p) => p.depth));
  return { placed, width: pad * 2 + depth * colW + nodeW, height: pad * 2 + Math.max(row, 1) * rowH - (rowH - nodeH) };
}

// Bytes per second -> how many packets (0-4) and how long one takes to cross (s).
function flow(kbps: number) {
  if (kbps <= 0.5) return { count: 0, dur: 0 };
  const level = Math.min(4, Math.max(1, Math.ceil(Math.log10(kbps + 1))));
  return { count: level, dur: Math.max(0.9, 4.2 - level * 0.8) };
}

export const rate = (kbps: number | null | undefined) => kbps === null || kbps === undefined ? '–'
  : kbps >= 1024 * 1024 ? `${(kbps / 1024 / 1024).toFixed(1)} GB/s` : kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${Math.round(kbps)} KB/s`;

export function Topology({ root, label }: { root: TopoNode; label: string }) {
  const t = useTranslations('Topology');
  const still = useReducedMotion();
  const { placed, width, height } = useMemo(() => layout(root), [root]);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<Placed | null>(null);
  const path = useMemo(() => { const s = new Set<string>(); let p = placed.find((n) => n.id === hover); while (p) { s.add(p.id); p = p.parent; } return s; }, [hover, placed]);
  const curve = (a: Placed, b: Placed) => { const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2, mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };

  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted" aria-hidden>
      <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-accent"/>{t('inbound')}</span>
      <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-success"/>{t('outbound')}</span>
      {still && <span>{t('motionOff')}</span>}
    </div>
    <div className="relative overflow-auto rounded-2xl border border-border bg-surface/60" style={{ maxHeight: '70vh' }}>
      <svg role="group" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block min-w-full">
        <defs>
          <pattern id="topo-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="currentColor" strokeOpacity="0.05"/></pattern>
        </defs>
        <rect width={width} height={height} fill="url(#topo-grid)" className="text-foreground"/>
        {placed.filter((n) => n.parent).map((n) => {
          const d = curve(n.parent!, n);
          const lit = path.has(n.id);
          const inbound = flow(n.rxSum), outbound = flow(n.txSum);
          return <g key={`e-${n.id}`}>
            <path id={`e-${n.id}`} d={d} fill="none" stroke="currentColor" className={lit ? 'text-accent' : 'text-border'} strokeWidth={lit ? 2.5 : 1.5}
              strokeDasharray={n.tone === 'muted' ? '4 4' : undefined}/>
            {!still && [...Array(inbound.count)].map((_, i) => <circle key={`r${i}`} r={3} className="fill-accent">
              <animateMotion dur={`${inbound.dur}s`} begin={`${(i * inbound.dur) / inbound.count}s`} repeatCount="indefinite" rotate="auto"><mpath href={`#e-${n.id}`}/></animateMotion>
            </circle>)}
            {!still && [...Array(outbound.count)].map((_, i) => <circle key={`t${i}`} r={2.5} className="fill-success">
              <animateMotion dur={`${outbound.dur}s`} begin={`${(i * outbound.dur) / outbound.count + 0.3}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
                <mpath href={`#e-${n.id}`}/></animateMotion>
            </circle>)}
            {n.badges?.length ? <foreignObject x={n.x - 34} y={n.y + nodeH / 2 - 11} width={30} height={22}>
              <div title={n.badges.join(', ')} className="grid h-[22px] w-[30px] place-items-center rounded-md bg-warning-soft text-warning"><I name="brick-wall-fire" size={13}/></div>
            </foreignObject> : null}
          </g>;
        })}
        {placed.map((n, i) => <foreignObject key={n.id} x={n.x} y={n.y} width={nodeW} height={nodeH}>
          <motion.button type="button" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: Math.min(i * 0.015, 0.6) }}
            onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)} onClick={() => setSelected(n)}
            aria-label={`${t(`kinds.${n.kind}` as 'kinds.server')}: ${n.label}${n.sub ? `, ${n.sub}` : ''}`}
            className={`flex h-full w-full items-center gap-2 rounded-xl border-2 bg-surface px-2 text-left shadow-sm outline-none transition-colors hover:bg-default focus-visible:ring-2 focus-visible:ring-accent ${toneClass[n.tone ?? 'default']} ${path.has(n.id) ? 'bg-accent-soft' : ''}`}>
            <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-default text-accent"><I name={{ internet: 'globe', location: 'map-pin', connection: 'cable', compute: 'boxes', host: 'server-cog', server: 'server', more: 'ellipsis' }[n.kind]} size={15}/></span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-xs font-semibold">{n.label}</span>
              {n.bars?.length ? <span className="mt-1 flex flex-col gap-0.5">{n.bars.map((b) => <span key={b.label} className="flex items-center gap-1 text-[9px] text-muted">
                <span className="w-6">{b.label}</span>
                <span className="h-1 flex-1 overflow-hidden rounded bg-default"><span className={`block h-full ${b.value > 0.85 ? 'bg-danger' : b.value > 0.6 ? 'bg-warning' : 'bg-success'}`} style={{ width: `${Math.round(b.value * 100)}%` }}/></span>
              </span>)}</span>
                : <span className="truncate text-[10px] text-muted">{n.sub ?? (n.rxSum + n.txSum > 0 ? `↓${rate(n.rxSum)} ↑${rate(n.txSum)}` : '')}</span>}
            </span>
          </motion.button>
        </foreignObject>)}
      </svg>
    </div>
    {selected && <div role="region" aria-label={selected.label} className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold"><I name={{ internet: 'globe', location: 'map-pin', connection: 'cable', compute: 'boxes', host: 'server-cog', server: 'server', more: 'ellipsis' }[selected.kind]} size={16}/>{selected.label}<span className="text-xs font-normal text-muted">{t(`kinds.${selected.kind}` as 'kinds.server')}</span></p>
        <button type="button" onClick={() => setSelected(null)} className="text-sm text-muted hover:text-foreground">{t('close')}</button>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2"><dt className="text-muted">{t('inbound')}</dt><dd className="tabular-nums">{rate(selected.rxSum)}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted">{t('outbound')}</dt><dd className="tabular-nums">{rate(selected.txSum)}</dd></div>
        {selected.details?.map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="truncate">{v}</dd></div>)}
      </dl>
    </div>}
  </div>;
}
