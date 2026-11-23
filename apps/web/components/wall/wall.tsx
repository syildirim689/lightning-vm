"use client";
// A live wall: a full-screen view of one page's live data, for a TV or a second screen, as usable on a laptop or a
// phone. The page's own API answers only (lib/wall-state.ts turns them into what is drawn), one poller, a 3D scene
// when the device draws it well and a designed 2D wall when it does not. Keys: F full screen, Esc back to the page,
// ← → the other walls this person may open, T the camera tour, I details.
import { useReducedMotionConfig } from 'motion/react';
import NextLink from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { I } from '../icon';
import { browserTimeZone } from '../time-zone-picker';
import { apiFetch } from '../../lib/api';
import { loginFrom } from '../../lib/back-to';
import { chooseTier, forcedTier, isSoftware, type FlatReason, type Probe, type Tier } from '../../lib/wall-quality';
import type { Snapshot, Source } from '../../lib/wall-poller';
import type { WallScene } from '../../lib/wall-scenes';
import { energyState, freshness, statsState, systemState, type Live, type Power, type Stats, type Worker } from '../../lib/wall-state';
import type { EngineStatus } from './three/engine';
import { EnergyFigures, small, StatsFigures, SystemFigures } from './figures';
import { FlatEnergy, FlatStats, FlatSystem } from './flat';
import { useFullscreen, usePref, useWakeLock, useWallData } from './hooks';

// The 3D stage and with it three.js: fetched only when this device is to draw 3D.
const Stage = dynamic(() => import('./stage'), { ssr: false });

// The button shows what it switches to.
const looks = { night: { icon: 'sun' }, day: { icon: 'moon' } } as const;
const every: Record<WallScene, number> = { system: 5_000, stats: 60_000, energy: 60_000 };
function sourcesFor(scene: WallScene, days: number, tz: string): Source[] {
  // The same reads, at the same pace, as the page the wall belongs to (Admin → System, Statistics, Energy).
  if (scene === 'system') return [{ key: 'live', path: '/admin/host/live', every: 5_000 }, { key: 'ready', path: '/ready', every: 15_000 }, { key: 'system', path: '/admin/system', every: 15_000 }];
  if (scene === 'stats') return [{ key: 'stats', path: `/admin/stats?days=${days}&tz=${encodeURIComponent(tz)}`, every: 60_000 }];
  return [{ key: 'power', path: '/admin/power?range=1d', every: 60_000 }];
}

// What this device can draw: WebGL 2, its renderer, texture size, memory and cores. A context that the browser would
// only give with a "major performance caveat" is a software renderer.
function probe(): Probe {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const base = { maxTexture: 0, renderer: '', memory: nav.deviceMemory ?? null, cores: nav.hardwareConcurrency || null,
    mobile: window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900,
    pixels: window.innerWidth * window.innerHeight * (window.devicePixelRatio || 1) ** 2 };
  const get = (caveat: boolean) => { try { return document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: caveat }) as WebGL2RenderingContext | null; } catch { return null; } };
  const gl = get(true) ?? get(false);
  if (!gl) return { ...base, webgl2: false };
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  const out = { ...base, webgl2: true, renderer, maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0 };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
}

type Mode = { kind: 'probing' } | { kind: '3d'; tier: Exclude<Tier, 'flat'>; renderer: string } | { kind: '2d'; reason: FlatReason; renderer: string };

export default function Wall({ scene, scenes, back, timeZone }: { scene: WallScene; scenes: WallScene[]; back: string; timeZone: string | null }) {
  const t = useTranslations('Wall'), th = useTranslations('HostState'), ts = useTranslations('Stats');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const search = useSearchParams();
  // The device's (or the accessibility settings') wish for less motion, applied once the page runs in the browser: the
  // server cannot know it, and an attribute that differs at hydration would keep the server's value.
  const wantsStill = !!useReducedMotionConfig();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reducedMotion = mounted && wantsStill;
  const forced = forcedTier(search.get('quality'));
  const days = [7, 30, 90, 365].includes(Number(search.get('days'))) ? Number(search.get('days')) : 30;
  const [tz, setTz] = useState(timeZone ?? 'UTC');
  useEffect(() => { if (!timeZone) setTz(browserTimeZone()); }, [timeZone]);

  const [look, setLook] = usePref<'night' | 'day'>('lvm-wall-look', 'night');
  const [tour, setTour] = usePref<boolean>('lvm-wall-tour', false);
  const [awake, setAwake] = usePref<boolean>('lvm-wall-awake', true);
  const [details, setDetails] = useState(false);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const fs = useFullscreen();
  const held = useWakeLock(awake);

  // ---- Data --------------------------------------------------------------------------------------------------------------
  const sources = useMemo(() => sourcesFor(scene, days, tz), [scene, days, tz]);
  const { snap, now, refresh } = useWallData(sources);
  const view = useMemo(() => viewOf(scene, snap, now), [scene, snap, now]);
  const main = snap[sources[0].key];
  const ended = Object.values(snap).some((e) => (e.error as { code?: string } | null)?.code === 'UNAUTHENTICATED');
  // Admin → System takes a fresh snapshot of the services when it opens and the last is older than two minutes; the
  // wall does the same, once.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (scene !== 'system' || asked) return;
    const d = snap.live?.data as (Live & { agent?: { installed: boolean; busy: boolean } }) | null | undefined;
    if (!d) return;
    setAsked(true);
    if (d.agent?.installed && !d.agent.busy && (!d.state || Date.now() - Date.parse(d.state.checkedAt) > 120_000)) {
      void apiFetch('/admin/host/state', { method: 'POST' }).then(() => window.setTimeout(() => refresh('live'), 12_000), () => undefined);
    }
  }, [scene, snap, asked, refresh]);

  // ---- 3D or 2D ------------------------------------------------------------------------------------------------------------
  const [mode, setMode] = useState<Mode>({ kind: 'probing' });
  useEffect(() => {
    if (forced === 'flat') { setMode({ kind: '2d', reason: 'chosen', renderer: '' }); return; }
    const p = probe();
    if (forced && p.webgl2) { setMode({ kind: '3d', tier: forced, renderer: p.renderer }); return; }
    const c = chooseTier(p);
    setMode(c.tier === 'flat' ? { kind: '2d', reason: c.reason ?? 'no-webgl', renderer: p.renderer } : { kind: '3d', tier: c.tier, renderer: p.renderer });
  }, [forced]);
  const fallback = useCallback((reason: FlatReason) => setMode((m) => ({ kind: '2d', reason, renderer: m.kind === 'probing' ? '' : m.renderer })), []);
  const try3d = () => setMode((m) => ({ kind: '3d', tier: 'low', renderer: m.kind === 'probing' ? '' : m.renderer }));

  // ---- Leaving, keys and the other walls -------------------------------------------------------------------------------
  // Leaving stops the scene first: on a slow (software) renderer each frame holds the page's thread for a while, and the
  // next page should not wait behind it. Its WebGL context is given back at the same moment.
  const [leaving, setLeaving] = useState(false);
  const leave = useCallback(() => { setLeaving(true); window.setTimeout(() => router.push(back), 0); }, [router, back]);
  const at = scenes.indexOf(scene);
  const go = useCallback((step: number) => {
    if (scenes.length < 2) return;
    const next = scenes[(at + step + scenes.length) % scenes.length];
    const q = search.toString();
    router.replace(`/wall/${next}${q ? `?${q}` : ''}`);
  }, [at, scenes, search, router]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); fs.toggle(); }
      else if (e.key === 'Escape' && !document.fullscreenElement) { e.preventDefault(); leave(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (k === 't' && !reducedMotion) setTour(!tour);
      else if (k === 'i') setDetails((d) => !d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fs, leave, go, tour, setTour, reducedMotion]);

  // ---- Text drawn inside the scene ------------------------------------------------------------------------------------
  const text = useMemo(() => {
    const raw = (k: 'stats.max' | 'stats.total' | 'energy.facilityW' | 'energy.itW' | 'energy.others') => String(t.raw(k));
    const base: Record<string, string> = { _locale: locale };
    if (scene === 'system') return { ...base, cpu: th('cpu'), memory: th('memory'), disk: th('disk'), load: th('load'), fault: t('fault'), noData: t('noDataShort'),
      'history.cpu': t('history.cpu'), 'history.memory': t('history.memory'), 'history.load': t('history.load') };
    if (scene === 'stats') return { ...base, max: raw('stats.max'), total: raw('stats.total'),
      ...Object.fromEntries((['created', 'deleted', 'signups', 'ticketsOpened', 'ticketsClosed', 'opsOk', 'opsFailed'] as const).map((k) => [`row.${k}`, ts(`csv.${({ ticketsOpened: 'opened', ticketsClosed: 'closed' } as Record<string, string>)[k] ?? k}` as 'csv.created')])) };
    return { ...base, measured: t('energy.measured'), estimated: t('energy.estimated'), facility: raw('energy.facilityW'), it: raw('energy.itW'), noFlow: t('energy.noFlowShort'), others: raw('energy.others') };
  }, [scene, locale, t, th, ts]);

  const title = t(`title.${scene}`);
  const updated = main?.okAt ?? null;
  const fresh = freshness(updated, now, every[scene]);
  const time = (x: number) => format.dateTime(new Date(x), { timeStyle: 'medium' });
  const button = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-[var(--w-line)] px-3 font-medium transition-colors hover:border-[var(--w-accent)] focus-visible:outline-2 focus-visible:outline-[var(--w-accent)] aria-pressed:border-[var(--w-accent)] aria-pressed:text-[var(--w-accent)] motion-reduce:transition-none';
  const visual = leaving ? null : mode.kind === '3d' ? <Stage scene={scene} tier={mode.tier} forced={!!forced} hold={!!forced && search.get('hold') === '1'} theme={look} reduced={reducedMotion} tour={tour && !reducedMotion} state={view.state} text={text} label={t(`sceneLabel.${scene}`)}
    lostText={t('lost')} onFallback={fallback} onStatus={setEngine}/>
    : mode.kind === '2d' ? <div className="absolute inset-0 overflow-auto p-[clamp(0.75rem,1.5vw,2.5rem)] lg:pl-[calc(min(34rem,34vw)+2.5rem)] lg:pt-[clamp(5rem,9vh,9rem)]">
      {view.scene === 'system' ? <FlatSystem s={view.state}/> : view.scene === 'stats' ? <FlatStats s={view.state}/> : <FlatEnergy s={view.state}/>}</div> : null;

  return <div className="wall relative flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden" data-look={look} data-motion={reducedMotion ? 'still' : 'drift'}
    data-wall-renderer={mode.kind === '3d' ? 'webgl' : mode.kind === '2d' ? '2d' : 'probing'} data-wall-tier={mode.kind === '3d' ? mode.tier : mode.kind === '2d' ? 'flat' : ''}
    data-wall-reason={mode.kind === '2d' ? mode.reason : ''} data-wall-fresh={fresh}>
    {/* The bar: back to the page, the wall's name, freshness and clock, and the controls. */}
    <header className="relative z-20 flex flex-wrap items-center gap-x-4 gap-y-2 px-[clamp(0.75rem,1.5vw,2.5rem)] py-[clamp(0.5rem,1vw,1.5rem)] lg:absolute lg:inset-x-0 lg:top-0">
      <NextLink href={back} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); leave(); } }} className={`${button} wall-panel`} aria-label={t(`back.${scene}`)} title={t(`back.${scene}`)} aria-keyshortcuts="Escape"><I name="arrow-left" size={18}/><span className="hidden sm:inline">{t('backShort')}</span></NextLink>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[clamp(1.25rem,1.6vw,3.2rem)] font-semibold leading-tight">{title}</h1>
        <p className={`${small} flex flex-wrap items-center gap-x-2 ${fresh === 'stale' ? 'text-[var(--w-warn)]' : 'text-[var(--w-muted)]'}`} data-testid="wall-updated" role="status">
          {fresh === 'stale' && <I name="triangle-alert" size={16} className="size-[1em]"/>}
          {ended ? t('ended') : updated === null ? (main?.error ? t('failed') : t('waiting')) : t(fresh === 'stale' ? 'stale' : 'updated', { time: time(updated) })}
          {main?.error != null && !ended && <button type="button" className="underline underline-offset-2" onClick={() => refresh()}>{t('retry')}</button>}
          {ended && <NextLink className="underline underline-offset-2" href={loginFrom(`/wall/${scene}`)}>{t('signIn')}</NextLink>}
        </p>
      </div>
      <Clock/>
      <nav aria-label={t('controls')} className="flex flex-wrap items-center gap-2">
        {scenes.length > 1 && <>
          <button type="button" className={`${button} wall-panel`} onClick={() => go(-1)} aria-label={t('previous', { name: t(`scene.${scenes[(at - 1 + scenes.length) % scenes.length]}`) })} aria-keyshortcuts="ArrowLeft"><I name="chevron-left" size={18}/></button>
          <button type="button" className={`${button} wall-panel`} onClick={() => go(1)} aria-label={t('next', { name: t(`scene.${scenes[(at + 1) % scenes.length]}`) })} aria-keyshortcuts="ArrowRight"><I name="chevron-right" size={18}/></button>
        </>}
        {mode.kind === '3d' && <button type="button" className={`${button} wall-panel`} aria-pressed={tour && !reducedMotion} disabled={reducedMotion} onClick={() => setTour(!tour)} aria-label={t('tour')}
          title={reducedMotion ? t('tourReduced') : t('tourHelp')} aria-keyshortcuts="T"><I name="orbit" size={18}/><span className="hidden xl:inline">{t('tour')}</span></button>}
        <button type="button" className={`${button} wall-panel`} onClick={() => setLook(look === 'night' ? 'day' : 'night')} aria-label={t(look === 'night' ? 'toDay' : 'toNight')} title={t(look === 'night' ? 'toDay' : 'toNight')}>
          <I name={looks[look].icon} size={18}/></button>
        <button type="button" className={`${button} wall-panel`} aria-pressed={awake} onClick={() => setAwake(!awake)} aria-label={t('awake')} title={awake && !held ? t('awakeUnsupported') : t('awakeHelp')}>
          <I name="coffee" size={18}/><span className="hidden xl:inline">{t('awake')}</span></button>
        <button type="button" className={`${button} wall-panel`} aria-pressed={details} onClick={() => setDetails(!details)} aria-keyshortcuts="I" aria-label={t('details')}><I name="info" size={18}/><span className="hidden xl:inline">{t('details')}</span></button>
        {fs.can && <button type="button" className={`${button} wall-panel`} onClick={fs.toggle} aria-label={t(fs.on ? 'exitFullscreen' : 'fullscreen')} aria-keyshortcuts="F"><I name={fs.on ? 'minimize' : 'maximize'} size={18}/></button>}
      </nav>
    </header>

    {/* The scene: on top on phones and tablets, the whole screen on wide ones (the figures and the bar float over it). */}
    <div className="relative h-[clamp(16rem,52vh,40rem)] shrink-0 lg:absolute lg:inset-0 lg:h-auto">{visual}
      {mode.kind === '2d' && mode.reason !== 'chosen' && <p className={`wall-panel absolute bottom-2 right-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-xl px-3 py-2 ${small} lg:bottom-4 lg:right-4`} data-testid="wall-flat-reason">
        <I name="info" size={16} className="shrink-0"/><span>{t(`flat.${mode.reason}`)}</span>
        {mode.reason !== 'no-webgl' && <button type="button" className="shrink-0 underline underline-offset-2" onClick={try3d}>{t('try3d')}</button>}</p>}
    </div>

    {/* The figures: below the scene on narrow screens, a panel over its left side on wide ones. */}
    <section aria-label={t('figures')} className="relative z-10 px-[clamp(0.75rem,1.5vw,2.5rem)] pb-6 pt-4 lg:absolute lg:bottom-[clamp(1rem,2vh,2.5rem)] lg:left-[clamp(0.75rem,1.5vw,2.5rem)] lg:top-[clamp(5.5rem,10vh,10rem)] lg:w-[min(34rem,34vw)] lg:overflow-auto lg:p-0">
      <div className="wall-panel rounded-2xl p-[clamp(1rem,1.4vw,2.4rem)]">
        {view.scene === 'system' ? <SystemFigures s={view.state}/> : view.scene === 'stats' ? <StatsFigures raw={view.raw} s={view.state}/> : <EnergyFigures raw={view.raw} s={view.state}/>}
      </div>
      {details && <Details mode={mode} engine={engine} held={held} awake={awake}/>}
      <p className={`${small} mt-3 hidden text-[var(--w-muted)] lg:block`}>{t('keys')}</p>
    </section>
  </div>;
}

type View = { scene: 'system'; state: ReturnType<typeof systemState> } | { scene: 'stats'; state: ReturnType<typeof statsState>; raw: Stats | null } | { scene: 'energy'; state: ReturnType<typeof energyState>; raw: Power | null };
function viewOf(scene: WallScene, snap: Snapshot, now: number): View {
  if (scene === 'system') {
    const live = snap.live, ready = snap.ready, system = snap.system;
    return { scene, state: systemState({
      live: (live?.data as Live | null) ?? null, liveAt: live?.okAt ?? null,
      ready: !ready ? null : ready.error ? false : ready.okAt ? true : null, readyAt: ready?.error ? now : ready?.okAt ?? null,
      workers: (system?.data as { worker?: Worker[] } | null)?.worker ?? null, now }) };
  }
  if (scene === 'stats') { const e = snap.stats; return { scene, raw: (e?.data as Stats | null) ?? null, state: statsState((e?.data as Stats | null) ?? null, e?.okAt ?? null, now) }; }
  const e = snap.power;
  return { scene, raw: (e?.data as Power | null) ?? null, state: energyState((e?.data as Power | null) ?? null, e?.okAt ?? null, now) };
}

// The time now, large enough to read across the room; its own component, so the second hand redraws nothing else.
function Clock() {
  const now = useNow({ updateInterval: 1_000 });
  const format = useFormatter();
  return <time dateTime={now.toISOString()} className="hidden text-[clamp(1.25rem,1.6vw,3.2rem)] font-semibold tabular-nums md:block" suppressHydrationWarning>{format.dateTime(now, { timeStyle: 'short' })}</time>;
}

// "Details": what is drawing and how well (tier, governor steps, frames, pixel ratio, draw calls, GPU memory objects).
function Details({ mode, engine, held, awake }: { mode: Mode; engine: EngineStatus | null; held: boolean; awake: boolean }) {
  const t = useTranslations('Wall');
  const rows: [string, string][] = [
    [t('info.renderer'), mode.kind === '3d' ? `3D · ${t(`quality.${mode.tier}`)}` : mode.kind === '2d' ? `2D · ${t(`flat.${mode.reason}`)}` : '…'],
    [t('info.gpu'), (mode.kind === 'probing' ? '' : mode.renderer) || '–'],
    ...(mode.kind === '3d' && engine ? [
      [t('info.fps'), `${engine.fps} (${engine.frameMs} ms)`], [t('info.steps'), `${engine.steps} / ${engine.maxSteps}`],
      [t('info.pixels'), `${engine.width} × ${engine.height} @ ${engine.pixelRatio}`], [t('info.calls'), `${engine.calls} · ${engine.triangles}`],
      [t('info.memory'), `${engine.geometries} · ${engine.textures} · ${engine.programs}`],
    ] as [string, string][] : []),
    [t('info.awake'), !awake ? t('info.off') : held ? t('info.on') : t('awakeUnsupported')],
  ];
  return <dl className={`wall-panel mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-2xl p-4 ${small}`} data-testid="wall-info">
    {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-[var(--w-muted)]">{k}</dt><dd className="truncate tabular-nums" title={v}>{v}</dd></div>)}
    {mode.kind !== 'probing' && isSoftware(mode.renderer) && <p className="col-span-2 text-[var(--w-warn)]">{t('info.software')}</p>}
  </dl>;
}
