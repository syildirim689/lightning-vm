"use client";
// Live wall: the canvas of the 3D scene. three.js and the scenes are imported here, on demand, so they are a chunk of
// their own that no other page loads. A lost WebGL context (a driver reset, the GPU taken by something else) is
// answered with a new canvas and engine; twice within a minute, the wall stays in 2D.
import { useEffect, useRef, useState } from 'react';
import type { Engine, EngineStatus, SceneKind } from './three/engine';
import type { FlatReason, Tier } from '../../lib/wall-quality';
import type { Theme } from './three/kit';

export type StageProps = {
  scene: SceneKind; tier: Exclude<Tier, 'flat'>; forced: boolean; hold: boolean; theme: Theme; reduced: boolean; tour: boolean; state: unknown; text: Record<string, string>; label: string;
  lostText: string; onFallback: (r: FlatReason) => void; onStatus: (s: EngineStatus) => void;
};

export default function Stage(p: StageProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const [generation, setGeneration] = useState(0);
  const [lost, setLost] = useState(false);
  const losses = useRef<number[]>([]);

  useEffect(() => {
    let alive = true, e: Engine | null = null, retry = 0;
    const el = canvas.current;
    if (!el) return;
    import('./three/engine').then(({ startEngine }) => startEngine(el, {
      scene: p.scene, tier: p.tier, allowFallback: !p.forced, govern: !p.hold, theme: latest.current.theme, reduced: latest.current.reduced, tour: latest.current.tour, text: latest.current.text,
      // On wide screens the figures panel covers min(34rem, 34vw) plus its margin at the left (wall.tsx).
      inset: (w) => (window.innerWidth >= 1024 ? Math.min(544, w * 0.34) + Math.min(40, Math.max(12, w * 0.015)) : 0),
      onFallback: (r) => latest.current.onFallback(r),
      onStatus: (s) => latest.current.onStatus(s),
      onLost: () => {
        const now = Date.now();
        losses.current = [...losses.current.filter((x) => now - x < 60_000), now];
        if (losses.current.length >= 2) { latest.current.onFallback('lost'); return; }
        setLost(true);
        // No "restored" within five seconds: a new canvas asks for a new context anyway.
        retry = window.setTimeout(() => { setLost(false); setGeneration((g) => g + 1); }, 5_000);
      },
      onRestored: () => { window.clearTimeout(retry); setLost(false); setGeneration((g) => g + 1); },
    })).then((made) => {
      if (!alive) { made.dispose(); return; }
      e = made; engine.current = made;
      // For tests and the details panel: the engine's own figures, read on demand (nothing is written per frame).
      Object.defineProperty(el, 'wallStatus', { value: () => made.status(), configurable: true });
      made.update(latest.current.state);
    }).catch(() => { if (alive) latest.current.onFallback('no-webgl'); });
    // A full page change (reload, another address, closing the tab) does not unmount React: the scene and its WebGL
    // context are let go here, before the page is.
    const away = () => { alive = false; engine.current = null; e?.dispose(); e = null; };
    // Back from the browser's page cache: the scene is built again.
    const shown = (ev: PageTransitionEvent) => { if (ev.persisted) setGeneration((g) => g + 1); };
    window.addEventListener('pagehide', away);
    window.addEventListener('pageshow', shown);
    return () => { window.removeEventListener('pagehide', away); window.removeEventListener('pageshow', shown); alive = false; window.clearTimeout(retry); engine.current = null; e?.dispose(); };
  }, [p.scene, p.tier, generation]);

  useEffect(() => { engine.current?.update(p.state); }, [p.state]);
  useEffect(() => { engine.current?.setTheme(p.theme); }, [p.theme]);
  useEffect(() => { engine.current?.setReduced(p.reduced); }, [p.reduced]);
  useEffect(() => { engine.current?.setTour(p.tour); }, [p.tour]);

  return <div className="absolute inset-0" role="img" aria-label={p.label}>
    {/* A new canvas for every engine: a canvas whose context was given back (forceContextLoss) cannot draw again. */}
    <canvas key={`${p.scene}-${p.tier}-${generation}`} ref={canvas} className="block h-full w-full" data-testid="wall-canvas"/>
    {lost && <p role="status" className="wall-panel absolute inset-x-4 top-1/2 mx-auto max-w-md -translate-y-1/2 rounded-xl p-4 text-center">{p.lostText}</p>}
  </div>;
}
