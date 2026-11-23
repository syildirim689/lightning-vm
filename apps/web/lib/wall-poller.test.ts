import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller, delayAfter, type PollerDeps } from './wall-poller.ts';

// A pretend clock and timer, a page that can be hidden, and an API whose answers the test settles by hand.
function rig() {
  let t = 0, hidden = false, timer: { at: number; fn: () => void } | null = null, listener: (() => void) | null = null;
  const calls: { path: string; settle: (ok: boolean, v?: unknown) => void; signal: AbortSignal }[] = [];
  const deps: PollerDeps = {
    fetch: (path, signal) => new Promise((res, rej) => calls.push({ path, signal, settle: (ok, v) => (ok ? res(v) : rej(v)) })),
    now: () => t,
    setTimer: (fn, ms) => (timer = { at: t + ms, fn }),
    clearTimer: (h) => { if (timer === h) timer = null; },
    hidden: () => hidden,
    onVisibility: (fn) => { listener = fn; return () => { listener = null; }; },
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    deps, calls,
    // Moves the clock on, firing the timer when it is due.
    async advance(ms: number) { const end = t + ms; while (timer && timer.at <= end) { t = timer.at; const f = timer.fn; timer = null; f(); await flush(); } t = end; },
    hide(v: boolean) { hidden = v; listener?.(); },
    pending: () => calls.filter((c) => !c.signal.aborted),
    timerAt: () => timer?.at ?? null,
    flush,
  };
}

test('poller: each source at its own pace, one timer, never two requests for one source', async () => {
  const r = rig();
  const seen: string[] = [];
  const p = createPoller([{ key: 'live', path: '/live', every: 5_000 }, { key: 'system', path: '/system', every: 15_000 }], r.deps, () => undefined);
  p.start();
  assert.deepEqual(r.calls.map((c) => c.path), ['/live', '/system']);
  // A slow answer: 20 seconds pass, still one request for /live.
  await r.advance(20_000);
  assert.equal(r.calls.length, 2);
  r.calls[0].settle(true, { a: 1 }); await r.flush();
  r.calls[1].settle(true, { b: 1 }); await r.flush();
  assert.deepEqual(p.snapshot().live.data, { a: 1 });
  assert.equal(p.snapshot().live.okAt, 20_000);
  for (let i = 0; i < 6; i++) { await r.advance(5_000); for (const c of r.calls) if (!c.signal.aborted && !seen.includes(String(r.calls.indexOf(c)))) { seen.push(String(r.calls.indexOf(c))); c.settle(true, {}); } await r.flush(); }
  const paths = r.calls.slice(2).map((c) => c.path);
  assert.equal(paths.filter((x) => x === '/live').length, 6);
  assert.equal(paths.filter((x) => x === '/system').length, 2);
  p.stop();
});

test('poller: nothing while hidden; what is due is asked for when shown', async () => {
  const r = rig();
  const p = createPoller([{ key: 'live', path: '/live', every: 5_000 }], r.deps, () => undefined);
  p.start();
  r.calls[0].settle(true, 1); await r.flush();
  r.hide(true);
  assert.equal(r.timerAt(), null);
  await r.advance(600_000);
  assert.equal(r.calls.length, 1);
  r.hide(false);
  assert.equal(r.calls.length, 2);
  p.stop();
});

test('poller: failures back off two, four and eight rounds; an answer resets it', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((f) => delayAfter(5_000, f)), [5_000, 10_000, 20_000, 40_000, 40_000, 40_000]);
  assert.equal(delayAfter(60_000, 5), 300_000);
  const r = rig();
  const p = createPoller([{ key: 'live', path: '/live', every: 5_000 }], r.deps, () => undefined);
  p.start();
  r.calls[0].settle(false, { code: 'NETWORK' }); await r.flush();
  assert.equal(p.snapshot().live.failures, 1);
  assert.equal(r.timerAt(), 10_000);
  await r.advance(10_000);
  r.calls[1].settle(false, { code: 'NETWORK' }); await r.flush();
  assert.equal(r.timerAt(), 30_000);
  await r.advance(20_000);
  r.calls[2].settle(true, 'ok'); await r.flush();
  assert.deepEqual([p.snapshot().live.failures, p.snapshot().live.error, r.timerAt()], [0, null, 35_000]);
  p.stop();
});

test('poller: a refusal stops the source until asked by hand; stop aborts and silences', async () => {
  const r = rig();
  let changes = 0;
  const p = createPoller([{ key: 'live', path: '/live', every: 5_000 }], r.deps, () => { changes++; });
  p.start();
  r.calls[0].settle(false, { code: 'FORBIDDEN' }); await r.flush();
  assert.equal(p.snapshot().live.stopped, true);
  await r.advance(600_000);
  assert.equal(r.calls.length, 1);
  p.refresh('live');
  assert.equal(r.calls.length, 2);
  p.stop();
  assert.ok(r.calls[1].signal.aborted);
  const before = changes;
  r.calls[1].settle(true, 'late'); await r.flush();
  assert.equal(changes, before);
  assert.equal(p.inFlight(), 0);
  assert.equal(r.timerAt(), null);
});
