// Live wall, System: a row of racks in a dark hall. Each unit is one service of the panel's stack (the host agent's
// snapshot): its light steady and flickering with the service's own processor use while it runs, slow-blinking amber
// while it is unhealthy or starting, fast-blinking red when it failed, dim when a one-shot job finished. A faulty unit
// also stands out of the rack with a striped plate and a FAULT badge, so it is told without its colour. In front,
// four glass gauges (processor, memory, disk, load) and the last ten minutes as light ribbons. Old data is drawn
// grey and still; missing data is not drawn.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SystemState, Tone } from '../../../lib/wall-state';
import type { SceneContext, SceneModule } from './engine';
import { approach, Atlas, bezel, brushed, contactShadow, disposeTree, dust, floorTextures, labelMesh, stripes } from './kit';

const PER_RACK = 10, U = 0.205, RACK_W = 0.8, DEPTH = 1.0, FRONT = 0.475, ROW_X = 0.62;
const HISTORY = 120;
const slotY = (slot: number) => 2.05 - slot * U;

export function build(ctx: SceneContext): SceneModule<SystemState> {
  const p = ctx.palette, root = new THREE.Group();
  const nf = new Intl.NumberFormat(ctx.text._locale || undefined, { maximumFractionDigits: 1 });

  // ---- The hall: floor, back wall, light bars ----------------------------------------------------------------------
  const ft = floorTextures(512, ctx.theme, 50);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0xffffff, map: ft.map, roughnessMap: ft.roughnessMap, roughness: 1, metalness: 0.15, envMapIntensity: 0.6 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 9), new THREE.MeshStandardMaterial({ color: p.metal, roughness: 0.8, metalness: 0.3 }));
  wall.position.set(0, 4.5, -3.2); wall.receiveShadow = true;
  const bars = new THREE.Mesh(mergeGeometries([-3, 0, 3].map((x) => new THREE.BoxGeometry(2.6, 0.035, 0.12).translate(x, 3.7, 0.2))), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.3, 2.5), toneMapped: false }));
  root.add(floor, wall, bars);

  // ---- Racks (built for the units there are; rebuilt only when that count changes) -----------------------------------
  const metal = new THREE.MeshStandardMaterial({ color: p.metal, metalness: 0.85, roughness: 0.4, roughnessMap: brushed(256) });
  const chassisMat = new THREE.MeshStandardMaterial({ color: p.chassis, metalness: 0.7, roughness: 0.45 });
  const bezelMat = new THREE.MeshStandardMaterial({ map: bezel(ctx.theme), metalness: 0.55, roughness: 0.5 });
  const stripeTex = stripes();
  const stripeMat = new THREE.MeshStandardMaterial({ map: stripeTex, emissiveMap: stripeTex, emissive: new THREE.Color(0.5, 0.42, 0.1), roughness: 0.6 });
  const ledMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const blankMat = new THREE.MeshStandardMaterial({ color: p.night ? 0x111317 : 0x4b525b, metalness: 0.6, roughness: 0.55 });
  const statusMat = new THREE.MeshBasicMaterial({ color: p.tone.none.clone(), toneMapped: false });
  let rackGroup = new THREE.Group();
  root.add(rackGroup);
  let count = -1, racks = 1;
  let chassis: THREE.InstancedMesh, front: THREE.InstancedMesh, plate: THREE.InstancedMesh, leds: THREE.InstancedMesh, labels: THREE.Mesh | null = null;
  let atlas: Atlas | null = null;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1), s0 = new THREE.Vector3(0, 0, 0);
  const rackX = (r: number) => ROW_X + (r - (racks - 1) / 2) * (RACK_W + 0.06);
  const unitPos = (k: number, out = 0) => v.set(rackX(Math.floor(k / PER_RACK)), slotY(k % PER_RACK), out);
  const out = new Float32Array(64); // how far each unit stands out (eased), up to 64 units

  function buildRacks(n: number) {
    root.remove(rackGroup); disposeTree(rackGroup); atlas?.dispose(); atlas = null; labels = null;
    rackGroup = new THREE.Group();
    count = n; racks = Math.max(1, Math.min(6, Math.ceil(n / PER_RACK)));
    const frame: THREE.BufferGeometry[] = [];
    for (let r = 0; r < racks; r++) {
      const x = rackX(r);
      for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) frame.push(new THREE.BoxGeometry(0.05, 2.25, 0.05).translate(x + px * (RACK_W / 2 - 0.025), 1.125, pz * (DEPTH / 2 - 0.025)));
      frame.push(new THREE.BoxGeometry(RACK_W, 0.05, DEPTH).translate(x, 2.25, 0), new THREE.BoxGeometry(RACK_W, 0.1, DEPTH).translate(x, 0.05, 0));
      frame.push(new THREE.BoxGeometry(0.015, 2.15, DEPTH - 0.1).translate(x - RACK_W / 2 + 0.008, 1.15, 0), new THREE.BoxGeometry(0.015, 2.15, DEPTH - 0.1).translate(x + RACK_W / 2 - 0.008, 1.15, 0));
      frame.push(new THREE.BoxGeometry(RACK_W - 0.04, 2.15, 0.015).translate(x, 1.15, -DEPTH / 2 + 0.01));
    }
    const rackMesh = new THREE.Mesh(mergeGeometries(frame), metal);
    rackMesh.castShadow = rackMesh.receiveShadow = true;
    frame.forEach((g) => g.dispose());
    // A light line on top of each rack, in the colour of the overall verdict.
    const status = new THREE.Mesh(mergeGeometries(Array.from({ length: racks }, (_, r) => new THREE.BoxGeometry(RACK_W - 0.06, 0.018, 0.018).translate(rackX(r), 2.29, FRONT + 0.01))), statusMat);
    const shadow = contactShadow(racks * (RACK_W + 0.06) + 0.8, DEPTH + 0.9, p.night ? 0.8 : 0.5);
    shadow.position.x = ROW_X;
    rackGroup.add(rackMesh, status, shadow);

    const slots = racks * PER_RACK, shown = Math.min(n, slots);
    chassis = new THREE.InstancedMesh(new THREE.BoxGeometry(0.72, 0.17, 0.95), chassisMat, Math.max(1, shown));
    front = new THREE.InstancedMesh(new THREE.BoxGeometry(0.74, 0.175, 0.02), bezelMat, Math.max(1, shown));
    plate = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.15, 0.15), stripeMat, Math.max(1, shown));
    leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.024, 0.024, 0.012), ledMat, Math.max(1, shown * 2));
    leds.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, shown * 2) * 3), 3);
    leds.instanceColor.setUsage(THREE.DynamicDrawUsage);
    chassis.count = front.count = plate.count = shown; leds.count = shown * 2;
    chassis.castShadow = chassis.receiveShadow = true; front.receiveShadow = true;
    const blanks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.74, 0.175, 0.02), blankMat, Math.max(1, slots - shown));
    blanks.count = slots - shown;
    for (let k = shown; k < slots; k++) { unitPos(k, FRONT); m4.compose(v, q.identity(), s1); blanks.setMatrixAt(k - shown, m4); }
    rackGroup.add(chassis, front, plate, leds, blanks);
    out.fill(0);
    place(new Array(shown).fill(false));
    // Name plates: one atlas row per unit.
    if (shown) {
      atlas = new Atlas(shown, Math.min(128, Math.floor(4096 / shown)), Math.min(128, Math.floor(4096 / shown)) * 4);
      labels = labelMesh(atlas, Array.from({ length: shown }, (_, k) => ({ row: k, width: 0.4, matrix: new THREE.Matrix4().makeTranslation(unitPos(k).x - 0.02, unitPos(k).y, FRONT + 0.024) })));
      rackGroup.add(labels);
    }
    root.add(rackGroup);
  }
  // Positions of the units and their plates; faulty ones stand out of the rack by `out[k]`.
  function place(faults: boolean[]) {
    for (let k = 0; k < chassis.count; k++) {
      const z = out[k];
      unitPos(k, z); m4.compose(v, q.identity(), s1); chassis.setMatrixAt(k, m4);
      unitPos(k, FRONT + 0.01 + z); m4.compose(v, q.identity(), s1); front.setMatrixAt(k, m4);
      unitPos(k, FRONT + 0.021 + z); v.x -= 0.27; m4.compose(v, q.identity(), faults[k] ? s1 : s0); plate.setMatrixAt(k, m4);
      for (let j = 0; j < 2; j++) { unitPos(k, FRONT + 0.026 + z); v.x += 0.31; v.y += j ? -0.04 : 0.04; m4.compose(v, q.identity(), s1); leds.setMatrixAt(k * 2 + j, m4); }
      if (labels) {
        // The label quads move with their unit: four corners per quad, shifted on z.
        const pos = labels.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let c = 0; c < 4; c++) pos.setZ(k * 4 + c, FRONT + 0.024 + z);
        pos.needsUpdate = true;
      }
    }
    chassis.instanceMatrix.needsUpdate = front.instanceMatrix.needsUpdate = plate.instanceMatrix.needsUpdate = leds.instanceMatrix.needsUpdate = true;
  }

  // ---- Gauges ----------------------------------------------------------------------------------------------------------
  // Thin, slightly tinted glass: it catches the room's light at its edges and lets the fill be seen.
  const glass = new THREE.MeshPhysicalMaterial({ color: p.night ? 0x5d7389 : 0x9db0c4, metalness: 0, roughness: 0.08, transparent: true, opacity: p.night ? 0.1 : 0.16, depthWrite: false,
    side: THREE.FrontSide, envMapIntensity: p.night ? 0.45 : 0.7, specularIntensity: 0.6 });
  const gaugeGroup = new THREE.Group();
  const tubeGeo = new THREE.CylinderGeometry(0.11, 0.11, 1.5, 40, 1, true).translate(0, 0.87, 0);
  const fillGeo = new THREE.CylinderGeometry(0.084, 0.084, 1, 28).translate(0, 0.5, 0);
  const baseGeo = mergeGeometries([new THREE.CylinderGeometry(0.15, 0.17, 0.12, 40).translate(0, 0.06, 0), new THREE.CylinderGeometry(0.125, 0.125, 0.04, 40).translate(0, 1.64, 0)]);
  const tickGeo = new THREE.TorusGeometry(0.118, 0.005, 8, 40).rotateX(Math.PI / 2);
  const gauges = (['cpu', 'memory', 'disk', 'load'] as const).map((key, i) => {
    const x = -2.0 + i * 0.4, z = 1.45;
    const fillMat = new THREE.MeshStandardMaterial({ color: p.tone.none, emissive: p.tone.none, emissiveIntensity: 1, roughness: 0.3, metalness: 0 });
    const fill = new THREE.Mesh(fillGeo, fillMat); fill.position.set(x, 0.12, z); fill.scale.y = 0.0001;
    const tube = new THREE.Mesh(tubeGeo, glass); tube.position.set(x, 0, z); tube.renderOrder = 2;
    const base = new THREE.Mesh(baseGeo, metal); base.position.set(x, 0, z); base.castShadow = true;
    // Marks where the gauge turns to a warning and to a danger (75 % and 90 %; for load, the cores and 1.5× them).
    const marks = (key === 'load' ? [0.5, 0.75] : [0.75, 0.9]).map((lv, j) => {
      const m = new THREE.Mesh(tickGeo, new THREE.MeshBasicMaterial({ color: j ? p.tone.bad : p.tone.warn, toneMapped: false }));
      m.position.set(x, 0.12 + lv * 1.5, z); return m;
    });
    gaugeGroup.add(fill, tube, base, ...marks);
    return { key, fill, fillMat, level: 0, goal: 0, shown: false };
  });
  const gaugeShadow = contactShadow(2.2, 0.9, 0.6); gaugeShadow.position.set(-1.4, 0.002, 1.45);
  gaugeGroup.add(gaugeShadow);
  const gaugeAtlas = new Atlas(7, 128, 512);
  const gaugeLabels = labelMesh(gaugeAtlas, [
    ...gauges.map((g, i) => ({ row: i, width: 0.4, matrix: new THREE.Matrix4().compose(new THREE.Vector3(-2.0 + i * 0.4, 0.02, 1.75), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2.6, 0, 0)), new THREE.Vector3(1, 1, 1)) })),
    // The ribbons' legend, stacked at their right end (the newest sample).
    ...[0, 1, 2].map((j) => ({ row: 4 + j, width: 0.46, matrix: new THREE.Matrix4().makeTranslation(3.15, 0.36 + (2 - j) * 0.12, 1.62 + j * 0.15) })),
  ]);
  gaugeGroup.add(gaugeLabels);
  root.add(gaugeGroup);

  // ---- History ribbons (the last ten minutes) -------------------------------------------------------------------------
  const ribbonColors = [p.accent, new THREE.Color(0.75, 0.4, 1.0), p.amber];
  const ribbons = ribbonColors.map((c, j) => {
    const z = 1.62 + j * 0.15, x0 = 0.75, x1 = 2.85;
    const area = new THREE.BufferGeometry(), edge = new THREE.BufferGeometry();
    const ap = new Float32Array(HISTORY * 2 * 3), ep = new Float32Array(HISTORY * 2 * 3), idx: number[] = [];
    for (let i = 0; i < HISTORY; i++) { const x = x0 + ((x1 - x0) * i) / (HISTORY - 1); ap.set([x, 0.12, z, x, 0.12, z], i * 6); ep.set([x, 0.12, z, x, 0.12, z], i * 6); }
    for (let i = 0; i < HISTORY - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    area.setAttribute('position', new THREE.BufferAttribute(ap, 3).setUsage(THREE.DynamicDrawUsage)); area.setIndex(idx);
    edge.setAttribute('position', new THREE.BufferAttribute(ep, 3).setUsage(THREE.DynamicDrawUsage)); edge.setIndex(idx);
    const areaMat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: p.night ? 0.22 : 0.3, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const edgeMat = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(p.night ? 1.8 : 1), side: THREE.DoubleSide, toneMapped: false });
    const a = new THREE.Mesh(area, areaMat), e = new THREE.Mesh(edge, edgeMat);
    a.renderOrder = e.renderOrder = 2;
    root.add(a, e);
    return { area, edge, areaMat, edgeMat, x0, x1, base: c.clone() };
  });
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.1, 0.6), metal); plinth.position.set(1.8, 0.05, 1.77); plinth.castShadow = plinth.receiveShadow = true;
  root.add(plinth);

  const motes = dust(900, new THREE.Vector3(9, 3.6, 6), ctx.theme);
  motes.setDetail(ctx.detail);
  root.add(motes.points);

  // ---- Data -------------------------------------------------------------------------------------------------------------
  let st: SystemState | null = null;
  const unitColor: THREE.Color[] = [];
  const faults: boolean[] = [];
  const toneColor = (t: Tone) => p.tone[t];
  const grey = p.tone.none;
  buildRacks(0);

  const update = (s: SystemState) => {
    st = s;
    const n = Math.min(s.units.length, 60);
    if (n !== count) buildRacks(n);
    const live = s.freshness === 'live';
    // Gauges: the fill follows the value; grey and dim when the data is old, empty when there is none.
    s.gauges.forEach((g, i) => {
      const x = gauges[i];
      x.goal = g.level ?? 0; x.shown = g.level !== null;
      const c = live ? toneColor(g.tone) : grey;
      // A dark body lit from inside: the colour stays saturated under filmic tone mapping instead of washing out.
      x.fillMat.color.copy(c).multiplyScalar(0.25); x.fillMat.emissive.copy(c); x.fillMat.emissiveIntensity = live ? 0.6 : 0.12;
      const unit = g.key === 'load' ? '' : ' %';
      gaugeAtlas.draw(i, { text: ctx.text[g.key], sub: g.value === null ? ctx.text.noData : `${nf.format(g.value)}${unit}`, align: 'center', color: p.text }, p);
    });
    ['cpu', 'memory', 'load'].forEach((k, j) => gaugeAtlas.draw(4 + j, { text: ctx.text[`history.${k}`], color: `#${ribbons[j].base.getHexString()}` }, p));
    // Ribbons: one point per sample, oldest at the left.
    const series = [s.history.cpu, s.history.memory, s.history.load];
    ribbons.forEach((r, j) => {
      const h = series[j], len = Math.min(h.length, HISTORY);
      const ap = r.area.getAttribute('position') as THREE.BufferAttribute, ep = r.edge.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < HISTORY; i++) {
        const src = len ? h[Math.max(0, h.length - len + Math.round((i * (len - 1)) / (HISTORY - 1)))] : 0;
        const y = 0.12 + src * 0.8;
        ap.setY(i * 2 + 1, y);
        ep.setY(i * 2, y - 0.006); ep.setY(i * 2 + 1, y + 0.006);
      }
      ap.needsUpdate = ep.needsUpdate = true;
      r.area.setDrawRange(0, len > 1 ? (HISTORY - 1) * 6 : 0); r.edge.setDrawRange(0, len > 1 ? (HISTORY - 1) * 6 : 0);
      r.areaMat.color.copy(live ? r.base : grey); r.edgeMat.color.copy(live ? r.base : grey).multiplyScalar(live && p.night ? 1.8 : 0.8);
    });
    // Units: plates and name labels.
    faults.length = count;
    for (let k = 0; k < count; k++) {
      const u = s.units[k];
      faults[k] = u.fault;
      unitColor[k] = (unitColor[k] ?? new THREE.Color()).copy(toneColor(u.tone));
      atlas?.draw(k, { text: u.name, sub: u.version || undefined, badge: u.fault ? ctx.text.fault : undefined, color: u.fault ? (u.tone === 'bad' ? '#ff6b76' : '#ffb54a') : p.plateText, subColor: '#a3b2c6' }, p);
    }
    place(faults);
    statusMat.color.copy(s.verdict === 'none' || !live ? grey : toneColor(s.verdict)).multiplyScalar(live ? 1.6 : 0.5);
  };

  const hash = (x: number) => { const s = Math.sin(x * 127.1) * 43758.5453; return s - Math.floor(s); };
  const frame = (t: number, dt: number, still: boolean) => {
    let moving = false;
    for (const g of gauges) {
      const next = still ? g.goal : approach(g.level, g.goal, dt, 2.5);
      if (Math.abs(next - g.goal) > 0.0005) moving = true;
      g.level = next;
      g.fill.visible = g.shown;
      g.fill.scale.y = Math.max(0.0001, g.level * 1.5);
    }
    if (!st || !count) return moving;
    const unitsLive = st.unitsFreshness === 'live';
    const colors = leds.instanceColor!;
    for (let k = 0; k < count; k++) {
      const u = st.units[k];
      // A faulty unit slides out of the rack (and back in when it recovers).
      const goal = u.fault ? 0.09 : 0;
      const z = still ? goal : approach(out[k], goal, dt, 3);
      if (Math.abs(z - out[k]) > 0.0002) moving = true;
      out[k] = z;
      let a = 1, b = 0;
      switch (u.led) {
        case 'fast': a = still ? 1 : (t * 2.2) % 1 < 0.5 ? 1 : 0.06; break;
        case 'slow': a = still ? 1 : (t * 0.6) % 1 < 0.5 ? 1 : 0.1; break;
        case 'dim': a = 0.22; break;
        case 'off': a = 0.03; break;
        default: a = 1;
      }
      // The activity light: flickers at a rate that follows the service's processor use (none at 0 %).
      const load = Math.min(1, u.cpu / 50);
      if (u.led === 'activity' && u.cpu > 0) b = still ? 0.25 + 0.75 * load : hash(Math.floor(t * (3 + load * 14)) + k * 1.7) > 0.5 - load * 0.3 ? 0.35 + 0.65 * load : 0.04;
      if (!unitsLive) { a *= 0.25; b = 0; }
      const c = unitColor[k] ?? grey;
      colors.setXYZ(k * 2, c.r * a * 2.2, c.g * a * 2.2, c.b * a * 2.2);
      colors.setXYZ(k * 2 + 1, 0.3 * b * 2.2, 0.75 * b * 2.2, 1.0 * b * 2.2);
    }
    colors.needsUpdate = true;
    if (moving) place(faults);
    if (!still) motes.points.rotation.y = t * 0.004;
    return moving || !still;
  };

  return {
    root,
    home: { position: new THREE.Vector3(0.9, 2.8, 7.0), target: new THREE.Vector3(0.35, 1.0, 0.7) },
    focus: [
      { position: new THREE.Vector3(0.9, 2.8, 7.0), target: new THREE.Vector3(0.35, 1.0, 0.7) },
      { position: new THREE.Vector3(0.9, 1.7, 3.4), target: new THREE.Vector3(0.62, 1.25, 0) },
      { position: new THREE.Vector3(-1.4, 1.5, 3.7), target: new THREE.Vector3(-1.4, 0.85, 1.45) },
      { position: new THREE.Vector3(2.0, 1.3, 3.9), target: new THREE.Vector3(1.7, 0.45, 1.75) },
    ],
    size: 5,
    update,
    frame,
    setDetail(d) { motes.setDetail(d); },
    dispose() { atlas?.dispose(); gaugeAtlas.dispose(); disposeTree(root); tubeGeo.dispose(); fillGeo.dispose(); baseGeo.dispose(); tickGeo.dispose(); },
  };
}
