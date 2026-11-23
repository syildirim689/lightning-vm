// Live wall, 3D: what every scene shares. Textures are drawn here in code (no image, model or font file is loaded:
// the panel runs on private networks), labels are painted with the page's own font into one atlas per scene, and
// disposeTree() frees what a scene made so hours of running do not leak.
import * as THREE from 'three';

export type Theme = 'night' | 'day';
export type Tone = 'ok' | 'warn' | 'bad' | 'none';

// Colours in the scene. Emissive colours are pushed above 1 where bloom should catch them.
export function palette(theme: Theme) {
  const night = theme === 'night';
  return {
    night,
    background: new THREE.Color(night ? 0x05070b : 0xdfe4ea),
    fog: new THREE.Color(night ? 0x070a10 : 0xdfe4ea),
    floor: new THREE.Color(night ? 0x15181d : 0xb9c0c9),
    metal: new THREE.Color(night ? 0x1d2127 : 0x8a929c),
    chassis: new THREE.Color(night ? 0x24282f : 0x5d646d),
    tone: {
      ok: new THREE.Color(0.15, 1.0, 0.45), warn: new THREE.Color(1.0, 0.62, 0.08), bad: new THREE.Color(1.0, 0.12, 0.16),
      none: new THREE.Color(0.38, 0.42, 0.5),
    } as Record<Tone, THREE.Color>,
    accent: new THREE.Color(0.2, 0.62, 1.0),
    amber: new THREE.Color(1.0, 0.58, 0.12),
    dead: new THREE.Color(0.08, 0.09, 0.11),
    text: night ? '#e8eef7' : '#0d1420', muted: night ? '#93a4bb' : '#3d4b5e', plate: night ? 'rgba(8,11,17,0.92)' : 'rgba(240,243,247,0.94)',
    exposure: night ? 1.0 : 0.78, env: night ? 0.55 : 0.85, fogDensity: night ? 0.045 : 0.016,
    // Text painted on the dark fronts of the units: light in both looks.
    plateText: '#e8eef7',
  };
}
export type Palette = ReturnType<typeof palette>;

// A seeded random source: the same textures every time.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const canvas = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const texture = (c: HTMLCanvasElement, color = true, repeat?: [number, number]) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
};

// Raised data-centre floor: square tiles with seams and a faint grain (colour) and a roughness map to match.
export function floorTextures(size: number, theme: Theme, repeat: number) {
  const night = theme === 'night', r = rng(7);
  const c = canvas(size, size), g = c.getContext('2d')!;
  const rough = canvas(size, size), q = rough.getContext('2d')!;
  g.fillStyle = night ? '#1a1d22' : '#a3abb5'; g.fillRect(0, 0, size, size);
  q.fillStyle = '#9a9a9a'; q.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 6; i++) {
    const x = r() * size, y = r() * size, a = r() * 0.05;
    g.fillStyle = `rgba(${night ? '255,255,255' : '0,0,0'},${a})`; g.fillRect(x, y, 1 + r() * 2, 1 + r() * 2);
    q.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${a * 2})`; q.fillRect(x, y, 2, 2);
  }
  const seam = Math.max(2, size / 128);
  g.fillStyle = night ? '#0b0d10' : '#8d949d'; q.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, seam); g.fillRect(0, 0, seam, size); q.fillRect(0, 0, size, seam); q.fillRect(0, 0, seam, size);
  // A perforated tile in one corner of four, as cold-aisle floors have.
  g.fillStyle = night ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.18)';
  for (let y = size * 0.58; y < size * 0.94; y += size / 40) for (let x = size * 0.58; x < size * 0.94; x += size / 40) { g.beginPath(); g.arc(x, y, size / 180, 0, Math.PI * 2); g.fill(); }
  return { map: texture(c, true, [repeat, repeat]), roughnessMap: texture(rough, false, [repeat, repeat]) };
}

// Brushed metal: fine horizontal streaks, as a roughness map.
export function brushed(size: number) {
  const r = rng(11), c = canvas(size, size), g = c.getContext('2d')!;
  g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 3; i++) { const v = Math.floor(90 + r() * 90); g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.fillRect(r() * size, r() * size, 10 + r() * size * 0.4, 1); }
  return texture(c, false, [1, 1]);
}

// The front of a server: a perforated bezel (colour) with a darker handle strip at each end.
export function bezel(theme: Theme) {
  const w = 256, h = 32, c = canvas(w, h), g = c.getContext('2d')!;
  g.fillStyle = theme === 'night' ? '#2a2f37' : '#3e444c'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  for (let y = 5; y < h - 3; y += 5) for (let x = 26 + ((y / 5) % 2) * 2.5; x < w - 26; x += 5) { g.beginPath(); g.arc(x, y, 1.3, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, 18, h); g.fillRect(w - 18, 0, 18, h);
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, 0, w, 1);
  return texture(c);
}

// Hazard stripes for a faulty unit's plate: a pattern, so a fault is not told by colour alone.
export function stripes() {
  const s = 64, c = canvas(s, s), g = c.getContext('2d')!;
  g.fillStyle = '#16181c'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#f2c230';
  for (let i = -s; i < s * 2; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 8, 0); g.lineTo(i + 8 - s, s); g.lineTo(i - s, s); g.closePath(); g.fill(); }
  const t = texture(c, true, [4, 1]);
  return t;
}

// A soft dark blot under objects: the contact shadow that is there even when shadow maps are off.
export function blot() {
  const s = 128, c = canvas(s, s), g = c.getContext('2d')!;
  // Grey levels (an alpha map reads one channel): white where the shadow is darkest, black where there is none.
  g.fillStyle = '#000'; g.fillRect(0, 0, s, s);
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, '#d9d9d9'); grad.addColorStop(0.55, '#595959'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  return texture(c, false);
}
export function contactShadow(width: number, depth: number, opacity = 0.75) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ alphaMap: blot(), transparent: true, opacity, depthWrite: false, toneMapped: false, color: 0x000000 }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.002; m.renderOrder = 1;
  return m;
}

// Labels: rows of text in one canvas, one texture per scene. Each label is a quad in one merged mesh, so all labels
// of a scene are one draw call. The font is the page's own (no font file is loaded for the scene).
export type Label = { text: string; sub?: string; color?: string; subColor?: string; badge?: string; align?: 'left' | 'center' };
export class Atlas {
  readonly canvas: HTMLCanvasElement; readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D; private font: string; private keys: string[] = [];
  constructor(readonly rows: number, readonly rowPx = 64, readonly widthPx = 1024) {
    this.canvas = canvas(widthPx, THREE.MathUtils.ceilPowerOfTwo(Math.max(1, rows) * rowPx));
    // Kept in main memory: the atlas is read back for every upload to WebGL, which a GPU canvas would stall on.
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.texture = texture(this.canvas);
    this.texture.generateMipmaps = true; this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.font = typeof document !== 'undefined' ? getComputedStyle(document.body).fontFamily || 'sans-serif' : 'sans-serif';
  }
  // Draws label i (only when it changed: an upload of the atlas per poll would be wasted); returns its UV box.
  draw(i: number, l: Label, p: Palette) {
    const id = `${l.text}|${l.sub ?? ''}|${l.badge ?? ''}|${l.color ?? ''}|${l.subColor ?? ''}|${l.align ?? ''}|${p.text}`;
    if (this.keys[i] === id) return this.uv(i);
    this.keys[i] = id;
    const g = this.g, y = i * this.rowPx, h = this.rowPx, W = this.widthPx;
    g.clearRect(0, y, W, h);
    g.textBaseline = 'middle';
    let x = l.align === 'center' ? W / 2 : 8;
    g.textAlign = l.align === 'center' ? 'center' : 'left';
    if (l.badge) {
      g.font = `700 ${Math.round(h * 0.42)}px ${this.font}`;
      const bw = g.measureText(l.badge).width + h * 0.5;
      g.fillStyle = '#f2c230'; g.fillRect(x, y + h * 0.18, bw, h * 0.64);
      g.fillStyle = '#16181c'; g.textAlign = 'left'; g.fillText(l.badge, x + h * 0.25, y + h * 0.52);
      x += bw + h * 0.25;
    }
    g.fillStyle = l.color ?? p.text;
    g.font = `600 ${Math.round(h * (l.sub ? 0.5 : 0.62))}px ${this.font}`;
    g.fillText(l.text, x, y + h * (l.sub ? 0.36 : 0.52), W - x - 8);
    if (l.sub) { g.fillStyle = l.subColor ?? p.muted; g.font = `500 ${Math.round(h * 0.32)}px ${this.font}`; g.fillText(l.sub, x, y + h * 0.76, W - x - 8); }
    this.texture.needsUpdate = true;
    return this.uv(i);
  }
  uv(i: number): [number, number, number, number] {
    const H = this.canvas.height;
    return [0, 1 - ((i + 1) * this.rowPx) / H, 1, 1 - (i * this.rowPx) / H];
  }
  dispose() { this.texture.dispose(); this.canvas.width = this.canvas.height = 0; }
}

// Quads for labels in one geometry: each placed by a matrix, with its row of the atlas.
export function labelMesh(atlas: Atlas, quads: { matrix: THREE.Matrix4; row: number; width: number }[]) {
  const pos = new Float32Array(quads.length * 12), uv = new Float32Array(quads.length * 8), index: number[] = [];
  const v = new THREE.Vector3();
  const aspect = atlas.rowPx / atlas.widthPx;
  quads.forEach((q, k) => {
    const w = q.width, h = q.width * aspect, [u0, v0, u1, v1] = atlas.uv(q.row);
    const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    corners.forEach(([x, y], c) => { v.set(x, y, 0).applyMatrix4(q.matrix); pos.set([v.x, v.y, v.z], k * 12 + c * 3); });
    uv.set([u0, v0, u1, v0, u1, v1, u0, v1], k * 8);
    index.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mat = new THREE.MeshBasicMaterial({ map: atlas.texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

// Dust in the light: slow motes whose count follows the quality's detail. Decoration only, and it reads as such.
export function dust(count: number, box: THREE.Vector3, theme: Theme) {
  const r = rng(3), pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) pos.set([(r() - 0.5) * box.x, r() * box.y, (r() - 0.5) * box.z], i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size: 0.012, color: theme === 'night' ? 0x9fb4d0 : 0x4a5563, transparent: true, opacity: theme === 'night' ? 0.18 : 0.12, depthWrite: false, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  return { points, max: count, setDetail(d: number) { geo.setDrawRange(0, Math.floor(count * Math.max(0, Math.min(1, d)))); } };
}

// Frees every geometry, material and texture under an object.
export function disposeTree(root: THREE.Object3D) {
  const seen = new Set<unknown>();
  const free = (x: { dispose?: () => void } | null | undefined) => { if (x && !seen.has(x)) { seen.add(x); x.dispose?.(); } };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) free(m.geometry);
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) free(v);
      free(mat);
    }
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
  });
}

// Eases a value towards its goal: frame-rate independent (the same path at 30 and at 144 fps).
export const approach = (from: number, to: number, dt: number, rate = 3) => to + (from - to) * Math.exp(-dt * rate);
