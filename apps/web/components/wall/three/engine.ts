// Live wall, 3D engine. Loaded only on the wall's pages (a dynamic import of its own chunk), one renderer and one
// render loop per wall. It draws a scene module (system.ts, stats.ts, energy.ts) with physically based materials, an
// environment generated here (three's RoomEnvironment, no HDR file), soft or hard shadows, bloom on what glows,
// filmic tone mapping and, on the high tier only, a shallow depth of field. A frame-time governor steps the quality
// down (or back up) while it runs and asks for the 2D wall when even the lowest step is a slideshow. It stops
// drawing while the tab is hidden or the canvas is off screen, draws on demand when nothing moves, and frees every
// GPU resource on dispose (the WebGL context included).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createGovernor } from '../../../lib/wall-governor';
import { ladder, pixelRatio, settingsAt, type FlatReason, type Settings, type Tier } from '../../../lib/wall-quality';
import { disposeTree, palette, type Palette, type Theme } from './kit';

export type SceneKind = 'system' | 'stats' | 'energy';
export type SceneContext = { palette: Palette; theme: Theme; detail: number; reduced: boolean; text: Record<string, string>; anisotropy: number };
export interface SceneModule<S> {
  root: THREE.Object3D;
  home: { position: THREE.Vector3; target: THREE.Vector3 };
  focus: { position: THREE.Vector3; target: THREE.Vector3 }[];
  size: number;                                   // the scene's radius, for the shadow camera and the fit on narrow screens
  update(state: S): void;                         // new data from the API
  frame(t: number, dt: number, still: boolean): boolean; // true while something moves (another frame is needed)
  setDetail(d: number): void;
  dispose(): void;
}
export type EngineStatus = { tier: Exclude<Tier, 'flat'>; steps: number; maxSteps: number; fps: number; frameMs: number; pixelRatio: number; width: number; height: number;
  calls: number; triangles: number; geometries: number; textures: number; programs: number; frames: number; renderer: string; camera: [number, number, number] };
export type EngineOptions = {
  scene: SceneKind; tier: Exclude<Tier, 'flat'>; theme: Theme; reduced: boolean; tour: boolean; text: Record<string, string>;
  onFallback: (reason: FlatReason) => void; onLost: () => void; onRestored: () => void; onStatus: (s: EngineStatus) => void;
  // How much of the canvas's left side the figures cover (in CSS pixels, for a canvas of this width): the scene's
  // centre moves right by half of it, so nothing important sits under the panel.
  inset?: (width: number) => number;
  // false when the person chose the quality in the address: steps are still taken back, but the wall stays 3D.
  allowFallback?: boolean;
  // false: the quality stays as chosen (?hold=1), for measuring a tier or recording the wall.
  govern?: boolean;
};
export type Engine = {
  update(state: unknown): void; setTheme(t: Theme): void; setReduced(r: boolean): void; setTour(on: boolean): void;
  status(): EngineStatus; dispose(): void;
};

const builders: Record<SceneKind, () => Promise<{ build: (ctx: SceneContext) => SceneModule<unknown> }>> = {
  system: () => import('./system') as never,
  stats: () => import('./stats') as never,
  energy: () => import('./energy') as never,
};

export async function startEngine(canvas: HTMLCanvasElement, o: EngineOptions): Promise<Engine> {
  const { build } = await builders[o.scene]();
  let settings: Settings = settingsAt(o.tier, 0);
  let theme = o.theme, reduced = o.reduced, tour = o.tour;
  let pal = palette(theme);

  // The low tier draws straight to the screen: the screen's own multisampling. The others smooth in the composer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: o.tier === 'low', alpha: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  // Draw calls and triangles counted per frame (the composer's passes included), not per render call.
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = pal.exposure;

  const scene = new THREE.Scene();
  scene.background = pal.background.clone();
  scene.fog = new THREE.FogExp2(pal.fog.getHex(), pal.fogDensity);
  // Image-based lighting from a room generated here, filtered once into a small environment map.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04);
  room.dispose(); pmrem.dispose();
  scene.environment = env.texture;
  scene.environmentIntensity = pal.env;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
  const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x101318, 0.35);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-6, 9, 7);
  scene.add(hemi, key, key.target);

  let ctx: SceneContext = { palette: pal, theme, detail: settings.detail, reduced, text: o.text, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) };
  let mod = build(ctx);
  scene.add(mod.root);
  let lastState: unknown = null;

  // ---- Quality ------------------------------------------------------------------------------------------------------
  let composer: EffectComposer | null = null, bloom: UnrealBloomPass | null = null, bokeh: BokehPass | null = null;
  let width = 1, height = 1, ratio = 1;
  const applyShadows = () => {
    const on = settings.shadows !== 'off';
    // three r18x has one filtered shadow type; "soft" is a wider filter radius and more samples on it.
    const type = THREE.PCFShadowMap;
    if (renderer.shadowMap.enabled !== on || renderer.shadowMap.type !== type) {
      renderer.shadowMap.enabled = on; renderer.shadowMap.type = type;
      // Materials compiled for the old shadow setting are compiled again.
      scene.traverse((x) => { const m = (x as THREE.Mesh).material; if (m) (Array.isArray(m) ? m : [m]).forEach((y) => { y.needsUpdate = true; }); });
    }
    key.castShadow = on;
    if (key.shadow.mapSize.x !== settings.shadowMap) { key.shadow.mapSize.set(settings.shadowMap, settings.shadowMap); key.shadow.map?.dispose(); key.shadow.map = null; }
    const s = mod.size;
    Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 });
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = settings.shadows === 'soft' ? 5 : 1.5;
    key.shadow.blurSamples = settings.shadows === 'soft' ? 12 : 4;
  };
  const buildComposer = () => {
    composer?.dispose(); bloom?.dispose(); bokeh?.dispose();
    composer = null; bloom = null; bokeh = null;
    if (!settings.bloom && !settings.dof) return;
    const target = new THREE.WebGLRenderTarget(width * ratio, height * ratio, { type: THREE.HalfFloatType, samples: settings.msaa });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    if (settings.bloom) { bloom = new UnrealBloomPass(new THREE.Vector2(width, height), pal.night ? 0.5 : 0.28, 0.5, 0.85); composer.addPass(bloom); }
    // A shallow depth of field, focused on what the camera looks at (set each frame): the background softens a little.
    if (settings.dof) { bokeh = new BokehPass(scene, camera, { focus: 8, aperture: 0.00022, maxblur: 0.0035 }); composer.addPass(bokeh); }
    composer.addPass(new OutputPass());
    composer.setPixelRatio(ratio); composer.setSize(width, height);
  };
  const resize = () => {
    const box = canvas.parentElement?.getBoundingClientRect();
    width = Math.max(1, Math.round(box?.width ?? canvas.clientWidth)); height = Math.max(1, Math.round(box?.height ?? canvas.clientHeight));
    ratio = pixelRatio(settings, window.devicePixelRatio || 1, width, height);
    renderer.setPixelRatio(ratio); renderer.setSize(width, height, false);
    composer?.setPixelRatio(ratio); composer?.setSize(width, height);
    const inset = Math.max(0, Math.round(o.inset?.(width) ?? 0));
    camera.aspect = (width + inset) / height;
    if (inset) camera.setViewOffset(width + inset, height, 0, 0, width, height); else camera.clearViewOffset();
    // Narrow (portrait) screens see the whole scene from further away instead of cutting its sides.
    camera.fov = camera.aspect < 1 ? 36 + (1 - camera.aspect) * 22 : 36;
    camera.updateProjectionMatrix();
    dirty = true; wake();
  };
  const applySettings = (rebuild: boolean) => {
    applyShadows();
    mod.setDetail(settings.detail);
    resize();
    if (rebuild) buildComposer();
  };

  // ---- Camera: a slow drift around the scene's home view (no drift with reduced motion), and an optional tour ---
  const pos = new THREE.Vector3(), look = new THREE.Vector3(), goalPos = new THREE.Vector3(), goalLook = new THREE.Vector3();
  let stop = 0, stopAt = 0;
  const place = (t: number, dt: number, snap: boolean) => {
    const base = tour && !reduced && mod.focus.length ? mod.focus[stop] : mod.home;
    goalPos.copy(base.position); goalLook.copy(base.target);
    if (camera.aspect < 1) goalPos.sub(goalLook).multiplyScalar(1 + (1 - camera.aspect) * 0.5).add(goalLook);
    if (!reduced) goalPos.x += Math.sin(t * 0.045) * 0.7, goalPos.y += Math.sin(t * 0.031) * 0.25, goalPos.z += Math.cos(t * 0.038) * 0.45, goalLook.x += Math.sin(t * 0.027) * 0.2;
    if (snap) { pos.copy(goalPos); look.copy(goalLook); } else { const k = 1 - Math.exp(-dt * 0.7); pos.lerp(goalPos, k); look.lerp(goalLook, k); }
    camera.position.copy(pos); camera.lookAt(look);
    if (tour && !reduced && t - stopAt > 18) { stopAt = t; stop = (stop + 1) % Math.max(1, mod.focus.length); }
  };

  // ---- The loop -----------------------------------------------------------------------------------------------------
  const governor = createGovernor({ targetMs: settings.targetMs, maxSteps: ladder.length });
  let raf = 0, running = false, dirty = true, visible = !document.hidden, onScreen = true, lost = false, disposed = false;
  let last = 0, t0 = performance.now(), frames = 0, rendered = false;
  const fpsWindow = new Float32Array(60); let fpsN = 0;
  const draw = () => {
    renderer.info.reset();
    if (bokeh) (bokeh.uniforms as unknown as { focus: { value: number } }).focus.value = camera.position.distanceTo(look);
    if (composer) composer.render(); else renderer.render(scene, camera);
  };
  const loop = (now: number) => {
    raf = 0;
    if (!running) return;
    const dt = last ? (now - last) / 1000 : 0;
    const t = (now - t0) / 1000;
    const moving = mod.frame(t, Math.min(dt, 0.1), reduced);
    // Drift and the tour are motion of their own: with reduced motion only a change of data draws a frame.
    const needed = dirty || moving || !reduced;
    if (needed) {
      place(t, Math.min(dt, 0.1), !rendered);
      draw();
      dirty = false; frames++;
      // Only frames that follow a drawn frame time the GPU (a frame after a pause says nothing).
      if (rendered && last) {
        const ms = now - last;
        fpsWindow[fpsN++ % 60] = ms;
        const d = o.govern === false ? null : governor.push(ms);
        if (d === 'fallback' && o.allowFallback !== false) { o.onFallback('slow'); return; }
        // A new step resizes the drawing buffer, which clears it: drawn again at once, so no black frame is shown.
        if (d === 'down' || d === 'up') { settings = settingsAt(o.tier, governor.steps); applySettings(true); draw(); }
      }
      rendered = true; last = now;
      raf = requestAnimationFrame(loop);
    } else {
      // Nothing to draw: the loop sleeps until data, a resize or a setting wakes it.
      rendered = false; last = 0;
    }
  };
  function wake() {
    running = visible && onScreen && !lost && !disposed;
    if (running && !raf) { last = 0; rendered = false; raf = requestAnimationFrame(loop); }
    if (!running && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  const onVisibility = () => { visible = !document.hidden; wake(); };
  document.addEventListener('visibilitychange', onVisibility);
  const io = new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); wake(); });
  io.observe(canvas);
  const ro = new ResizeObserver(() => resize());
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  const onLost = (e: Event) => { e.preventDefault(); lost = true; wake(); o.onLost(); };
  // A restored context is answered by the page building a new engine (every buffer and texture again).
  const onRestored = () => { o.onRestored(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const status = (): EngineStatus => {
    const n = Math.min(fpsN, 60); let sum = 0;
    for (let i = 0; i < n; i++) sum += fpsWindow[i];
    const ms = n ? sum / n : 0;
    return { tier: o.tier, steps: governor.steps, maxSteps: ladder.length, fps: ms ? Math.round(10000 / ms) / 10 : 0, frameMs: Math.round(ms * 10) / 10, pixelRatio: ratio, width, height,
      calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0, frames, renderer: rendererName, camera: [Math.round(camera.position.x * 1000) / 1000, Math.round(camera.position.y * 1000) / 1000, Math.round(camera.position.z * 1000) / 1000] };
  };
  const statusTimer = window.setInterval(() => o.onStatus(status()), 2000);

  applySettings(true);
  place(0, 0, true);
  wake();

  const rebuildScene = () => {
    scene.remove(mod.root);
    mod.dispose(); disposeTree(mod.root);
    ctx = { ...ctx, palette: pal, theme, reduced, detail: settings.detail };
    mod = build(ctx);
    scene.add(mod.root);
    if (lastState) mod.update(lastState);
    applySettings(true);
    place((performance.now() - t0) / 1000, 0, true);
  };

  return {
    update(state) { lastState = state; mod.update(state); dirty = true; wake(); },
    setTheme(next) {
      if (next === theme) return;
      theme = next; pal = palette(theme);
      (scene.background as THREE.Color).copy(pal.background);
      (scene.fog as THREE.FogExp2).color.copy(pal.fog);
      (scene.fog as THREE.FogExp2).density = pal.fogDensity;
      scene.environmentIntensity = pal.env;
      renderer.toneMappingExposure = pal.exposure;
      rebuildScene();
      dirty = true; wake();
    },
    setReduced(r) { if (r === reduced) return; reduced = r; ctx = { ...ctx, reduced }; dirty = true; wake(); },
    setTour(on) { tour = on; stopAt = (performance.now() - t0) / 1000; dirty = true; wake(); },
    status,
    dispose() {
      if (disposed) return;
      disposed = true; running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.clearInterval(statusTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      io.disconnect(); ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      mod.dispose(); disposeTree(scene);
      composer?.dispose(); bloom?.dispose(); bokeh?.dispose();
      key.shadow.map?.dispose();
      env.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      // Gives the context back now instead of when the canvas is collected: a wall opened and left many times in a
      // day must not run out of contexts (browsers keep about sixteen).
      renderer.forceContextLoss();
    },
  };
}
