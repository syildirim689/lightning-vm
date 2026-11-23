// Live wall, Statistics: the period of Admin → Statistics as an architectural model on a table. One row of towers per
// measure (servers created and deleted, sign-ups, tickets opened and closed, operations that succeeded and failed),
// one tower per day (per week for a year), oldest at the left. Each row is scaled to its own highest value, which is
// written at its end; a day with nothing is a flat tile, not a gap. Old data is drawn grey.
import * as THREE from 'three';
import { statRows, type StatsState } from '../../../lib/wall-state';
import type { SceneContext, SceneModule } from './engine';
import { approach, Atlas, contactShadow, disposeTree, floorTextures, labelMesh } from './kit';

const WIDTH = 8.2, PITCH = 0.86, MAX_H = 2.3, MAX_COLS = 92;
const rowZ = (r: number) => (r - (statRows.length - 1) / 2) * PITCH;
const colours: Record<string, [number, number, number]> = {
  created: [0.18, 0.95, 0.5], deleted: [1.0, 0.42, 0.55], signups: [0.25, 0.62, 1.0], ticketsOpened: [1.0, 0.66, 0.15],
  ticketsClosed: [0.2, 0.88, 0.85], opsOk: [0.62, 0.48, 1.0], opsFailed: [1.0, 0.2, 0.18],
};

export function build(ctx: SceneContext): SceneModule<StatsState> {
  const p = ctx.palette, root = new THREE.Group();
  const nf = new Intl.NumberFormat(ctx.text._locale || undefined, { maximumFractionDigits: 0 });
  const df = new Intl.DateTimeFormat(ctx.text._locale || undefined, { day: 'numeric', month: 'short' });
  const day = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };

  const ft = floorTextures(512, ctx.theme, 40);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: ft.map, roughnessMap: ft.roughnessMap, roughness: 1, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  // The model's table: dark lacquer that mirrors the towers a little.
  const depth = statRows.length * PITCH + 1.0;
  const table = new THREE.Mesh(new THREE.BoxGeometry(WIDTH + 2.4, 0.5, depth), new THREE.MeshPhysicalMaterial({ color: p.night ? 0x0e1116 : 0x9aa3ad, roughness: 0.38, metalness: 0.2, clearcoat: 0.5, clearcoatRoughness: 0.3 }));
  table.position.set(0.45, 0.25, 0); table.receiveShadow = table.castShadow = true;
  const shadow = contactShadow(WIDTH + 5, depth + 1.6, 0.7);
  root.add(floor, shadow, table);

  const towerMat = new THREE.MeshPhysicalMaterial({ roughness: 0.42, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.5 });
  const capMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const towers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), towerMat, statRows.length * MAX_COLS);
  const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.02, 1), capMat, statRows.length * MAX_COLS);
  towers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(statRows.length * MAX_COLS * 3), 3);
  caps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(statRows.length * MAX_COLS * 3), 3);
  towers.castShadow = towers.receiveShadow = true;
  towers.count = caps.count = 0;
  root.add(towers, caps);

  // Labels: a name and a maximum per row, and dates along the front.
  const atlas = new Atlas(statRows.length + 5, 96, 512);
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2.4, 0, 0)), one = new THREE.Vector3(1, 1, 1);
  const quads = [
    ...statRows.map((_, r) => ({ row: r, width: 1.45, matrix: new THREE.Matrix4().compose(new THREE.Vector3(WIDTH / 2 + 0.85, 0.52, rowZ(r)), tilt, one) })),
    ...[0, 1, 2, 3, 4].map((j) => ({ row: statRows.length + j, width: 1.2, matrix: new THREE.Matrix4().compose(new THREE.Vector3(-WIDTH / 2 + (WIDTH * j) / 4, 0.52, depth / 2 - 0.3), tilt, one) })),
  ];
  const labels = labelMesh(atlas, quads);
  root.add(labels);

  let st: StatsState | null = null;
  let cols = 0, needLayout = true;
  const level = new Float32Array(statRows.length * MAX_COLS), goal = new Float32Array(statRows.length * MAX_COLS);
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Color();

  const update = (x: StatsState) => {
    st = x;
    const n = Math.min(x.at.length, MAX_COLS);
    if (n !== cols) { cols = n; level.fill(0); }
    towers.count = caps.count = statRows.length * cols;
    const live = x.freshness === 'live';
    statRows.forEach((key, r) => {
      const row = x.rows.find((y) => y.key === key);
      for (let i = 0; i < cols; i++) goal[r * MAX_COLS + i] = row?.levels[x.at.length - cols + i] ?? 0;
      const [cr, cg, cb] = colours[key];
      atlas.draw(r, { text: ctx.text[`row.${key}`], sub: row ? `${ctx.text.max.replace('{n}', nf.format(row.max))} · ${ctx.text.total.replace('{n}', nf.format(row.total))}` : undefined,
        color: live ? `rgb(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)})` : p.muted }, p);
    });
    for (let j = 0; j < 5; j++) {
      const i = Math.round(((cols - 1) * j) / 4);
      atlas.draw(statRows.length + j, { text: cols ? df.format(day(x.at[x.at.length - cols + i])) : '', align: 'center', color: p.muted }, p);
    }
    paint();
    needLayout = true;
  };
  // Colours: each row its own, grey when the data is old; a tower with nothing is a dim tile.
  const paint = () => {
    if (!st) return;
    const live = st.freshness === 'live';
    statRows.forEach((key, r) => {
      const [cr, cg, cb] = colours[key];
      for (let i = 0; i < cols; i++) {
        const k = r * cols + i, empty = goal[r * MAX_COLS + i] === 0;
        c.setRGB(cr, cg, cb);
        if (!live) c.setRGB(0.32, 0.35, 0.4);
        towers.setColorAt(k, c.clone().multiplyScalar(empty ? 0.18 : 0.4));
        caps.setColorAt(k, c.multiplyScalar(empty ? 0.2 : live ? 1.25 : 0.5));
      }
    });
    towers.instanceColor!.needsUpdate = caps.instanceColor!.needsUpdate = true;
  };
  const layout = () => {
    const pitch = WIDTH / Math.max(cols, 1), w = Math.min(0.32, pitch * 0.72);
    statRows.forEach((_, r) => {
      for (let i = 0; i < cols; i++) {
        const h = 0.015 + level[r * MAX_COLS + i] * MAX_H, k = r * cols + i;
        v.set(-WIDTH / 2 + pitch * (i + 0.5), 0.5, rowZ(r)); s.set(w, h, 0.48);
        m4.compose(v, q, s); towers.setMatrixAt(k, m4);
        v.y = 0.5 + h + 0.01; s.set(w * 1.02, 1, 0.49);
        m4.compose(v, q, s); caps.setMatrixAt(k, m4);
      }
    });
    towers.instanceMatrix.needsUpdate = caps.instanceMatrix.needsUpdate = true;
    towers.computeBoundingSphere(); caps.computeBoundingSphere();
  };

  const frame = (_t: number, dt: number, still: boolean) => {
    if (!cols) return false;
    let moving = false;
    for (let r = 0; r < statRows.length; r++) for (let i = 0; i < cols; i++) {
      const k = r * MAX_COLS + i, to = goal[k];
      const next = still ? to : approach(level[k], to, dt, 2.2 + i * 0.01);
      if (Math.abs(next - to) > 0.0005) moving = true;
      level[k] = next;
    }
    // The towers are placed again only while they grow or shrink.
    if (moving || needLayout) layout();
    needLayout = moving;
    return moving;
  };

  return {
    root,
    home: { position: new THREE.Vector3(0, 8.0, 12.6), target: new THREE.Vector3(0, 0.7, 0.4) },
    focus: [
      { position: new THREE.Vector3(0, 8.0, 12.6), target: new THREE.Vector3(0, 0.7, 0.4) },
      { position: new THREE.Vector3(-6.5, 3.4, 5.5), target: new THREE.Vector3(-1.5, 0.8, 0) },
      { position: new THREE.Vector3(6.8, 3.6, 5.2), target: new THREE.Vector3(1.8, 0.8, -0.4) },
      { position: new THREE.Vector3(0.5, 9.5, 4.2), target: new THREE.Vector3(0, 0.5, -0.2) },
    ],
    size: 8,
    update,
    frame,
    setDetail() { /* every tower is a measurement: nothing here is dropped for speed */ },
    dispose() { atlas.dispose(); disposeTree(root); },
  };
}
