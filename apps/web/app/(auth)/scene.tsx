"use client";
// The sign-in panel's living picture: a small datacenter (panel, hosts, VMs) with packets flowing along its
// links. Decorative only (aria-hidden); with "reduce motion" it is a still picture.
import { motion, useReducedMotion } from 'motion/react';

const nodes = [
  { id: 'panel', x: 200, y: 60, r: 22, label: 'panel' },
  { id: 'h1', x: 90, y: 170, r: 16 }, { id: 'h2', x: 200, y: 190, r: 16 }, { id: 'h3', x: 310, y: 170, r: 16 },
  { id: 'v1', x: 40, y: 260, r: 9 }, { id: 'v2', x: 110, y: 280, r: 9 }, { id: 'v3', x: 170, y: 290, r: 9 },
  { id: 'v4', x: 230, y: 290, r: 9 }, { id: 'v5', x: 290, y: 280, r: 9 }, { id: 'v6', x: 360, y: 260, r: 9 },
] as const;
const links: [string, string][] = [['panel', 'h1'], ['panel', 'h2'], ['panel', 'h3'], ['h1', 'h2'], ['h2', 'h3'],
  ['h1', 'v1'], ['h1', 'v2'], ['h2', 'v3'], ['h2', 'v4'], ['h3', 'v5'], ['h3', 'v6']];
const at = (id: string) => nodes.find((n) => n.id === id)!;

export function AuthScene() {
  const still = useReducedMotion();
  return <svg aria-hidden viewBox="0 0 400 320" className="h-auto w-full max-w-md text-accent">
    <defs>
      <radialGradient id="auth-node" cx="50%" cy="40%" r="60%"><stop offset="0%" stopColor="currentColor" stopOpacity="0.9"/><stop offset="100%" stopColor="currentColor" stopOpacity="0.35"/></radialGradient>
    </defs>
    {links.map(([a, b], i) => {
      const p = at(a), q = at(b);
      return <g key={`${a}-${b}`}>
        <motion.line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5}
          initial={{ pathLength: still ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, delay: 0.2 + i * 0.06 }}/>
        {/* Packets: one down (provisioning), one up (metrics) on each link, staggered. */}
        {!still && [0, 1].map((dir) => <motion.circle key={dir} r={2.6} fill="currentColor"
          initial={{ cx: dir ? q.x : p.x, cy: dir ? q.y : p.y, opacity: 0 }}
          animate={{ cx: dir ? [q.x, p.x] : [p.x, q.x], cy: dir ? [q.y, p.y] : [p.y, q.y], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.8 + (i % 3) * 0.4, repeat: Infinity, delay: 1 + i * 0.37 + dir * 0.9, ease: 'easeInOut', repeatDelay: 0.6 + (i % 4) * 0.5 }}/>)}
      </g>;
    })}
    {nodes.map((n, i) => <g key={n.id}>
      {!still && n.r > 10 && <motion.circle cx={n.x} cy={n.y} r={n.r} fill="none" stroke="currentColor" strokeOpacity={0.4}
        animate={{ r: [n.r, n.r + 14], opacity: [0.5, 0] }} transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.5 }}/>}
      <motion.circle cx={n.x} cy={n.y} r={n.r} fill="url(#auth-node)" initial={{ scale: still ? 1 : 0 }} animate={{ scale: 1 }}
        style={{ transformOrigin: `${n.x}px ${n.y}px` }} transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.1 + i * 0.07 }}/>
      {n.r > 10 && <rect x={n.x - n.r * 0.45} y={n.y - n.r * 0.3} width={n.r * 0.9} height={n.r * 0.6} rx={2} fill="var(--background, #0b0d14)" opacity={0.55}/>}
      {!still && n.r < 10 && <motion.circle cx={n.x + 6} cy={n.y - 6} r={2.2} fill="var(--success, #22c55e)"
        animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.3 }}/>}
    </g>)}
  </svg>;
}
