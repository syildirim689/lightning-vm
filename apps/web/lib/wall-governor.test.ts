import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernor, type Decision } from './wall-governor.ts';

// Feeds a recorded series of frame times; returns every decision with the frame it came on.
function run(series: number[], o: Parameters<typeof createGovernor>[0]) {
  const g = createGovernor(o);
  const out: [number, Decision][] = [];
  series.forEach((dt, i) => { const d = g.push(dt); if (d) out.push([i, d]); });
  return { g, out };
}
const frames = (n: number, ms: number | ((i: number) => number)) => Array.from({ length: n }, (_, i) => (typeof ms === 'function' ? ms(i) : ms));
// A 60 Hz display: vsync makes every frame 16.6-16.8 ms with a few late ones.
const vsync = (i: number) => (i % 37 === 0 ? 18.4 : 16.6 + (i % 3) * 0.1);
const opts = { targetMs: 1000 / 60, maxSteps: 8, windowSize: 60, warmup: 45 };

test('governor: a GPU that holds 60 fps is left alone', () => {
  assert.deepEqual(run(frames(6000, vsync), opts).out, []);
});

test('governor: the warm-up and a hidden tab say nothing', () => {
  // Shaders compile in the first frames (150 ms each), then a two-minute gap while the tab was hidden.
  const series = [...frames(10, 150), ...frames(300, vsync), 120_000, ...frames(300, vsync)];
  assert.deepEqual(run(series, opts).out, []);
});

test('governor: 40 fps on a 60 fps tier steps down after two bad windows, one step at a time, until it holds', () => {
  // 25 ms a frame while the steps are 0-2, 16.7 ms from step 3 on (bloom and resolution gone).
  const g = createGovernor(opts);
  const out: Decision[] = [];
  let deepest = 0;
  for (let i = 0; i < 6000; i++) { const d = g.push(g.steps < 3 ? 25 : vsync(i)); if (d) out.push(d); deepest = Math.max(deepest, g.steps); }
  assert.deepEqual(out.slice(0, 3), ['down', 'down', 'down']);
  assert.equal(deepest, 3);
  // Later it tries one step up now and then and comes back: less often each time (6, 12, 24… good windows).
  assert.deepEqual(out.slice(3), ['up', 'down', 'up', 'down', 'up', 'down']);
});

test('governor: eight frames a second drops a step every window and then falls back to 2D', () => {
  const { g, out } = run(frames(400, 120), opts);
  assert.deepEqual(out.map(([, d]) => d), [...Array(8).fill('down'), 'fallback']);
  assert.equal(g.steps, 8);
  // Judged by time on a slow device: the warm-up ends after 2 s (frame 17), a verdict every 1.5 s (13 frames).
  assert.equal(out[0][0], 16 + 12);
  assert.equal(out[1][0], 16 + 25);
});

test('governor: one frame a second goes straight to the last step, then to 2D, in seconds', () => {
  const { g, out } = run(frames(20, 1000), opts);
  assert.deepEqual(out.map(([, d]) => d), ['down', 'fallback']);
  assert.equal(g.steps, 8);
  // The warm-up is over with the second frame (2 s); then two windows of three frames: 2D after the seventh frame.
  assert.equal(out[1][0], 6);
});

test('governor: 30 fps on a weak device (30 fps tier) is fine; 45 ms frames are not', () => {
  const low = { ...opts, targetMs: 1000 / 30 };
  assert.deepEqual(run(frames(3000, (i) => 33 + (i % 2)), low).out, []);
  assert.equal(run(frames(45 + 60 * 2, 45), low).out[0]?.[1], 'down');
});

test('governor: at the last step, slow but not a slideshow (25 fps) stays 3D', () => {
  const g = createGovernor(opts);
  g.steps = 8;
  let fell = false;
  for (let i = 0; i < 3000; i++) if (g.push(40) === 'fallback') fell = true;
  assert.equal(fell, false);
});

test('governor: steps back up after a long good stretch, and waits longer after a bounce', () => {
  const g = createGovernor(opts);
  g.steps = 2;
  const out: [number, Decision][] = [];
  let i = 0;
  const feed = (n: number, ms: (i: number) => number) => { for (let k = 0; k < n; k++, i++) { const d = g.push(ms(i)); if (d) out.push([i, d]); } };
  feed(45 + 60 * 6, vsync);              // six good windows: one step up
  assert.deepEqual(out.map(([, d]) => d), ['up']);
  feed(100, () => 30);                   // straight back to slow (two windows of 1.5 s): down again
  assert.deepEqual(out.map(([, d]) => d), ['up', 'down']);
  feed(60 * 6, vsync);                   // six good windows are no longer enough
  assert.equal(out.length, 2);
  feed(60 * 6, vsync);                   // twelve are
  assert.deepEqual(out.map(([, d]) => d), ['up', 'down', 'up']);
});
