// The live wall's frame-time governor. It is fed the time between two drawn frames and answers, once per window of
// frames, whether to draw less ('down': the next step of wall-quality.ts's ladder), more again ('up'), or to give up
// on 3D ('fallback': the 2D wall). Pure and allocation-free per frame, so a recorded frame-time series tests it.
//
// A window closes after 60 frames or, on a slow device, after 1.5 seconds with at least three frames, so a device
// drawing one frame a second is judged in seconds, not minutes. The first frames (shaders compile, textures upload)
// are not judged: the first 45 frames or the first 2 seconds, whichever ends first.
export type Decision = 'down' | 'up' | 'fallback' | null;
export type GovernorOptions = {
  targetMs: number;    // the frame time the tier aims for
  maxSteps: number;    // the ladder's length
  windowSize?: number; // frames per verdict at most
  windowMs?: number;   // time per verdict at most (with three frames or more)
  warmup?: number;     // frames not judged at start…
  warmupMs?: number;   // …or this long, whichever ends first
};

export function createGovernor(o: GovernorOptions) {
  const size = o.windowSize ?? 60, windowMs = o.windowMs ?? 1500, warmup = o.warmup ?? 45, warmupMs = o.warmupMs ?? 2000;
  const buf = new Float32Array(size);
  let n = 0, winT = 0, seen = 0, warmT = 0, steps = 0, bad = 0, good = 0, upNeed = 6, sinceUp = Infinity, floorBad = 0, gaveUp = false;
  return {
    get steps() { return steps; },
    // A step taken from outside (a context restored at a lower step, a person's choice).
    set steps(v: number) { steps = Math.max(0, Math.min(o.maxSteps, v)); bad = good = 0; },
    push(dt: number): Decision {
      // Longer than five seconds: the loop was paused (a hidden tab); it says nothing about drawing.
      if (gaveUp || !(dt > 0) || dt > 5000) return null;
      if (++seen <= warmup && (warmT += dt) < warmupMs) return null;
      buf[n++] = dt; winT += dt;
      if (n < size && !(n >= 3 && winT >= windowMs)) return null;
      const count = n;
      n = 0; winT = 0;
      const w = buf.subarray(0, count);
      w.sort();
      const p50 = w[count >> 1], p90 = w[Math.min(count - 1, Math.floor(count * 0.9))];
      sinceUp++;
      if (p50 > o.targetMs * 1.3) {
        good = 0;
        if (steps >= o.maxSteps) {
          // Everything already off. Under 20 frames a second is a slideshow: the 2D wall says the same, smoothly.
          if (p50 > 50 && (++floorBad >= 2 || p50 > o.targetMs * 3)) { gaveUp = true; return 'fallback'; }
          return null;
        }
        // Under four frames a second no single step will do: straight to the last one (and to 2D if that is not enough).
        if (p50 > 250) { bad = 0; steps = o.maxSteps; return 'down'; }
        // Far too slow (a third of the aim or worse): no second window to be sure.
        if (++bad >= 2 || p50 > o.targetMs * 3) {
          bad = 0;
          // Stepped up and straight back down: wait twice as long before trying again.
          if (sinceUp <= 3) upNeed = Math.min(upNeed * 2, 96);
          steps++;
          return 'down';
        }
        return null;
      }
      bad = 0; floorBad = 0;
      if (p90 < o.targetMs * 1.1 && steps > 0) {
        if (++good >= upNeed) { good = 0; steps--; sinceUp = 0; return 'up'; }
      } else good = 0;
      return null;
    },
  };
}
export type Governor = ReturnType<typeof createGovernor>;
