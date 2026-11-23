// The live wall's one poller: every source the wall reads, each at its own pace, on one timer. Never two requests
// for the same source at once; nothing at all while the tab is hidden (what is due is asked for as soon as it is
// shown again); after a failure the next try waits twice as long, then four and eight times (never more than 5 minutes); a refusal
// (signed out, no permission) stops that source until it is asked for by hand. Its clock, timer, fetch and
// visibility come from outside, so a test drives it.
export type Source = { key: string; path: string; every: number };
export type Entry = { data: unknown; okAt: number | null; error: unknown; failures: number; stopped: boolean };
export type Snapshot = Record<string, Entry>;
export type PollerDeps = {
  fetch: (path: string, signal: AbortSignal) => Promise<unknown>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  hidden: () => boolean;
  onVisibility: (fn: () => void) => () => void;
};
// Errors that more tries will not fix.
const final = (e: unknown) => { const c = (e as { code?: string })?.code; return c === 'UNAUTHENTICATED' || c === 'FORBIDDEN' || c === 'NOT_FOUND'; };
export const MAX_BACKOFF = 300_000;
export const delayAfter = (every: number, failures: number) => (failures ? Math.min(every * 2 ** Math.min(failures, 3), Math.max(every, MAX_BACKOFF)) : every);

export function createPoller(sources: Source[], deps: PollerDeps, onChange: (s: Snapshot) => void) {
  const state: Snapshot = Object.fromEntries(sources.map((s) => [s.key, { data: null, okAt: null, error: null, failures: 0, stopped: false }]));
  const due = new Map(sources.map((s) => [s.key, 0]));
  const flying = new Map<string, AbortController>();
  let timer: unknown = null, running = false, off: (() => void) | null = null;

  const schedule = () => {
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    if (!running || deps.hidden()) return;
    const now = deps.now();
    let next = Infinity;
    for (const s of sources) if (!state[s.key].stopped && !flying.has(s.key)) next = Math.min(next, due.get(s.key)!);
    if (next === Infinity) return;
    timer = deps.setTimer(tick, Math.max(0, next - now));
  };
  const ask = (s: Source) => {
    const control = new AbortController();
    flying.set(s.key, control);
    deps.fetch(s.path, control.signal).then((data) => {
      if (control.signal.aborted) return;
      state[s.key] = { data, okAt: deps.now(), error: null, failures: 0, stopped: false };
    }, (error) => {
      if (control.signal.aborted) return;
      const e = state[s.key];
      state[s.key] = { ...e, error, failures: e.failures + 1, stopped: final(error) };
    }).finally(() => {
      if (control.signal.aborted) return;
      flying.delete(s.key);
      due.set(s.key, deps.now() + delayAfter(s.every, state[s.key].failures));
      onChange({ ...state });
      schedule();
    });
  };
  function tick() {
    timer = null;
    if (!running || deps.hidden()) return;
    const now = deps.now();
    for (const s of sources) if (!state[s.key].stopped && !flying.has(s.key) && due.get(s.key)! <= now) ask(s);
    schedule();
  }
  return {
    start() {
      if (running) return;
      running = true;
      off = deps.onVisibility(() => { if (!deps.hidden()) tick(); else schedule(); });
      tick();
    },
    stop() {
      running = false;
      off?.(); off = null;
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
      for (const c of flying.values()) c.abort();
      flying.clear();
    },
    // Asked for by hand ("Try again"): now, and a stopped source starts again.
    refresh(key?: string) {
      for (const s of sources) if (!key || s.key === key) { state[s.key] = { ...state[s.key], stopped: false }; due.set(s.key, 0); }
      tick();
    },
    snapshot: () => ({ ...state }),
    inFlight: () => flying.size,
  };
}
export type Poller = ReturnType<typeof createPoller>;
