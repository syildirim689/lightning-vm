"use client";
// Live wall: its data (one poller per wall, lib/wall-poller.ts), the viewer's choices kept in this browser, full
// screen and keeping the screen on.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { createPoller, type Poller, type Snapshot, type Source } from '../../lib/wall-poller';

// A choice of this viewer on this browser (night or day, the tour, keeping the screen on). Storage can be missing or
// refuse (a private window): the default is used and nothing breaks.
export function usePref<T extends string | boolean>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try { const raw = localStorage.getItem(key); if (raw !== null) setValue(JSON.parse(raw) as T); } catch { /* the default */ }
  }, [key]);
  const set = useCallback((v: T) => { setValue(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* kept for this visit only */ } }, [key]);
  return [value, set];
}

const deps = {
  fetch: (path: string, signal: AbortSignal) => apiFetch(path, { signal }),
  now: () => Date.now(),
  setTimer: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimer: (h: unknown) => window.clearTimeout(h as number),
  hidden: () => document.hidden,
  onVisibility: (fn: () => void) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); },
};

// The wall's sources, polled together; `now` moves with every answer and every five seconds, so "since …" and
// stale data are noticed even when no answer comes.
export function useWallData(sources: Source[]) {
  const key = sources.map((s) => `${s.key}:${s.path}:${s.every}`).join('|');
  const stable = useMemo(() => sources, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [snap, setSnap] = useState<Snapshot>({});
  const [now, setNow] = useState(() => Date.now());
  const poller = useRef<Poller | null>(null);
  useEffect(() => {
    const p = createPoller(stable, deps, (s) => { setSnap(s); setNow(Date.now()); });
    poller.current = p;
    setSnap(p.snapshot());
    p.start();
    return () => { p.stop(); poller.current = null; };
  }, [stable]);
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 5_000);
    return () => window.clearInterval(id);
  }, []);
  const refresh = useCallback((k?: string) => poller.current?.refresh(k), []);
  return { snap, now, refresh };
}

// Full screen of the whole wall (the Fullscreen API; not offered where the browser has none, as on iPhones).
export function useFullscreen() {
  const [on, setOn] = useState(false);
  const [can, setCan] = useState(false);
  useEffect(() => {
    setCan(!!document.fullscreenEnabled);
    const change = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);
  return { on, can, toggle };
}

// Keeps the screen from sleeping while the wall is shown (the Screen Wake Lock API). The browser drops the lock when
// the tab is hidden; it is asked for again when the tab comes back. Where there is no such API, nothing happens.
export function useWakeLock(wanted: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!wanted || !('wakeLock' in navigator)) { setHeld(false); return; }
    let lock: WakeLockSentinel | null = null, gone = false;
    const ask = async () => {
      if (document.hidden || gone) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        setHeld(true);
        lock.addEventListener('release', () => setHeld(false));
      } catch { setHeld(false); }
    };
    const back = () => { if (!document.hidden && (!lock || lock.released)) void ask(); };
    // Leaving the page (a reload, another address, closing the tab): the lock is given back first.
    const away = () => { gone = true; void lock?.release().catch(() => undefined); };
    void ask();
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pagehide', away);
    return () => { away(); document.removeEventListener('visibilitychange', back); window.removeEventListener('pagehide', away); };
  }, [wanted]);
  return held;
}
