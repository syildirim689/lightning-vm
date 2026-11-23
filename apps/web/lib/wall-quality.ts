// Live walls (/wall/*): which quality a screen starts with, and what each quality draws. Pure, so it is tested.
// A quick look at the device at start (WebGL 2, texture size, memory, cores, the renderer's name) picks a tier; the
// frame-time governor (wall-governor.ts) then steps down or back up from there while the wall runs. "flat" is the
// designed 2D wall: no WebGL 2, a software renderer (a slideshow at best), or a device the governor gave up on.
export type Tier = 'high' | 'medium' | 'low' | 'flat';
export type FlatReason = 'no-webgl' | 'software' | 'slow' | 'lost' | 'chosen';
export type Probe = {
  webgl2: boolean; maxTexture: number; renderer: string; memory: number | null; cores: number | null;
  mobile: boolean; pixels: number; // the screen's size in device pixels (width × height × DPR²)
};
export type Settings = {
  dprCap: number;      // the most device pixels per CSS pixel drawn
  scale: number;       // the share of that resolution drawn (the governor's first lever on a big screen)
  shadows: 'soft' | 'hard' | 'off'; shadowMap: number;
  bloom: boolean; dof: boolean; msaa: number;
  detail: number;      // 0..1: how much of the optional geometry (particles, cables, floor tiles) is drawn
  targetMs: number;    // the frame time the governor holds the wall to (60 fps, or a steady 30 on weak devices)
};

// Software rasterisers (CI, remote desktops, VMs without a GPU driver) answer WebGL but draw a frame in seconds.
const software = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|google angle \(.*subzero|warp/i;
export const isSoftware = (renderer: string) => software.test(renderer);

export function chooseTier(p: Probe): { tier: Tier; reason: FlatReason | null } {
  // three.js draws with WebGL 2 only (WebGL 1 was dropped in r163).
  if (!p.webgl2) return { tier: 'flat', reason: 'no-webgl' };
  if (isSoftware(p.renderer)) return { tier: 'flat', reason: 'software' };
  if ((p.memory !== null && p.memory <= 2) || (p.cores !== null && p.cores <= 2) || p.maxTexture < 4096) return { tier: 'low', reason: null };
  if (p.mobile || (p.memory !== null && p.memory <= 4) || (p.cores !== null && p.cores <= 4)) return { tier: 'medium', reason: null };
  return { tier: 'high', reason: null };
}

export const tierSettings: Record<Exclude<Tier, 'flat'>, Settings> = {
  high: { dprCap: 2, scale: 1, shadows: 'soft', shadowMap: 2048, bloom: true, dof: true, msaa: 4, detail: 1, targetMs: 1000 / 60 },
  medium: { dprCap: 1.5, scale: 1, shadows: 'hard', shadowMap: 1024, bloom: true, dof: false, msaa: 2, detail: 0.6, targetMs: 1000 / 60 },
  low: { dprCap: 1, scale: 1, shadows: 'off', shadowMap: 512, bloom: false, dof: false, msaa: 0, detail: 0.3, targetMs: 1000 / 30 },
};

// The steps the governor takes down, the cheapest loss of looks first. Each one applies on top of the ones before.
export const ladder: ((s: Settings) => Settings)[] = [
  (s) => ({ ...s, dof: false }),
  (s) => ({ ...s, msaa: 0 }),
  (s) => ({ ...s, scale: Math.min(s.scale, 0.85) }),
  (s) => ({ ...s, bloom: false }),
  (s) => (s.shadows === 'soft' ? { ...s, shadows: 'hard', shadowMap: Math.min(s.shadowMap, 1024) } : s),
  (s) => ({ ...s, shadows: 'off', detail: Math.min(s.detail, 0.5) }),
  (s) => ({ ...s, scale: Math.min(s.scale, 0.7), detail: Math.min(s.detail, 0.3) }),
  (s) => ({ ...s, scale: Math.min(s.scale, 0.55), detail: 0 }),
];
export const settingsAt = (tier: Exclude<Tier, 'flat'>, steps: number) =>
  ladder.slice(0, Math.max(0, Math.min(steps, ladder.length))).reduce((s, f) => f(s), tierSettings[tier]);

// The pixel ratio drawn: the device's, capped by the tier, scaled by the governor, and never more than a 4K frame's
// worth of pixels (a 4K TV at DPR 2 would otherwise draw 33 million pixels a frame).
export const MAX_PIXELS = 3840 * 2160;
export function pixelRatio(s: Settings, dpr: number, width: number, height: number) {
  const ratio = Math.min(dpr || 1, s.dprCap) * s.scale;
  const area = Math.max(1, width * height);
  const fit = Math.sqrt(MAX_PIXELS / area);
  return Math.max(0.5, Math.round(Math.min(ratio, fit) * 100) / 100);
}

// What the address asks for (?quality=high|medium|low|2d), for a person who knows better than the probe, and for tests.
export function forcedTier(value: string | null | undefined): Tier | null {
  if (value === '2d' || value === 'flat') return 'flat';
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}
