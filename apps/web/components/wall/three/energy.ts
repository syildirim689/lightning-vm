// Live wall, Energy: the hosts of the energy report around a facility core. Each host is a cabinet as tall as its share
// of the power drawn now, joined to the core by a conduit whose light flows faster and brighter with the host's watts
// and whose thickness is its share of the total. A measured host's light is solid; an estimated host's (no power
// counter, a profile from its processor use) is broken into dashes. A host without a sample in the last fifteen
// minutes carries no light. Around the core, the last 24 hours as a ring of bars. With no sample at all in fifteen
// minutes, or when the report is old, everything is grey and nothing flows.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnergyState, Feed } from '../../../lib/wall-state';
import type { SceneContext, SceneModule } from './engine';
import { approach, Atlas, contactShadow, disposeTree, dust, floorTextures, labelMesh } from './kit';

const R = 4.5, SEGMENTS = 64, RADIAL = 10;
const conduitVertex = /* glsl */`
  attribute float aSpeed; attribute float aGlow; attribute float aDash; attribute float aLive;
  varying vec2 vUv; varying float vSpeed; varying float vGlow; varying float vDash; varying float vLive;
  void main() {
    vUv = uv; vSpeed = aSpeed; vGlow = aGlow; vDash = aDash; vLive = aLive;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const conduitFragment = /* glsl */`
  uniform float uTime; uniform float uStill; uniform vec3 uMeasured; uniform vec3 uEstimated; uniform vec3 uDead;
  varying vec2 vUv; varying float vSpeed; varying float vGlow; varying float vDash; varying float vLive;
  void main() {
    vec3 base = mix(uMeasured, uEstimated, vDash);
    // Pulses travel from the host (u = 0) to the core (u = 1), at the host's own speed.
    float s = fract(vUv.x * 5.0 - uTime * vSpeed);
    float pulse = smoothstep(0.0, 0.07, s) * (1.0 - smoothstep(0.07, 0.42, s));
    pulse = mix(pulse, 0.5, uStill);
    // Estimated: the light is broken into dashes along the conduit.
    float gap = vDash > 0.5 ? step(0.45, fract(vUv.x * 36.0)) : 1.0;
    vec3 col = base * (0.1 + vGlow * (0.3 + pulse * 2.8)) * gap;
    col = mix(uDead, col, vLive);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

export function build(ctx: SceneContext): SceneModule<EnergyState> {
  const p = ctx.palette, root = new THREE.Group();
  const nf = new Intl.NumberFormat(ctx.text._locale || undefined, { maximumFractionDigits: 1 });
  const watts = (w: number) => (w >= 1000 ? `${nf.format(w / 1000)} kW` : `${nf.format(Math.round(w))} W`);

  const ft = floorTextures(512, ctx.theme, 50);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ map: ft.map, roughnessMap: ft.roughnessMap, roughness: 1, metalness: 0.15 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  root.add(floor);

  // ---- The core ------------------------------------------------------------------------------------------------------
  const metal = new THREE.MeshStandardMaterial({ color: p.metal, metalness: 0.88, roughness: 0.35 });
  const coreGlowMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: p.accent.clone(), emissiveIntensity: 0.2, roughness: 0.4 });
  const ringMat = new THREE.MeshBasicMaterial({ color: p.accent.clone(), toneMapped: false });
  const sleeve = new THREE.MeshPhysicalMaterial({ color: p.night ? 0x5d7389 : 0x9db0c4, roughness: 0.08, metalness: 0, transparent: true, opacity: p.night ? 0.12 : 0.18, depthWrite: false, envMapIntensity: p.night ? 0.45 : 0.7 });
  const coreBase = new THREE.Mesh(mergeGeometries([new THREE.CylinderGeometry(0.95, 1.05, 0.3, 64).translate(0, 0.15, 0), new THREE.CylinderGeometry(0.75, 0.75, 0.12, 64).translate(0, 2.0, 0)]), metal);
  coreBase.castShadow = coreBase.receiveShadow = true;
  const coreGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.7, 40).translate(0, 1.15, 0), coreGlowMat);
  const coreSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.7, 64, 1, true).translate(0, 1.15, 0), sleeve);
  coreSleeve.renderOrder = 2;
  const rings = new THREE.Mesh(mergeGeometries([0.45, 1.15, 1.85].map((y) => new THREE.TorusGeometry(0.72, 0.018, 10, 64).rotateX(Math.PI / 2).translate(0, y, 0))), ringMat);
  root.add(coreBase, coreGlow, coreSleeve, rings, contactShadow(3, 3, 0.8));

  // ---- The last 24 hours, a ring of bars around the core --------------------------------------------------------------
  const hourMat = new THREE.MeshStandardMaterial({ color: p.accent.clone().multiplyScalar(0.25), emissive: p.accent.clone(), emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.2 });
  const hours = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), hourMat, 24);
  hours.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(24 * 3), 3);
  hours.castShadow = true; hours.count = 0;
  root.add(hours);
  const hourLevel = new Float32Array(24), hourGoal = new Float32Array(24);

  // ---- Hosts and conduits (rebuilt when the set of hosts changes) -----------------------------------------------------
  const cabinetMat = new THREE.MeshStandardMaterial({ color: p.chassis, metalness: 0.75, roughness: 0.42 });
  const bandMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const conduitMat = new THREE.ShaderMaterial({
    vertexShader: conduitVertex, fragmentShader: conduitFragment, toneMapped: false, fog: false,
    uniforms: { uTime: { value: 0 }, uStill: { value: 0 }, uMeasured: { value: p.accent.clone() }, uEstimated: { value: p.amber.clone() }, uDead: { value: p.dead.clone() } },
  });
  const sheathMat = new THREE.MeshPhysicalMaterial({ color: p.night ? 0x5d7389 : 0x9db0c4, roughness: 0.1, transparent: true, opacity: p.night ? 0.1 : 0.16, depthWrite: false, envMapIntensity: p.night ? 0.4 : 0.6 });
  let hostGroup = new THREE.Group();
  root.add(hostGroup);
  let keys = '', feeds: Feed[] = [];
  let cabinets: THREE.InstancedMesh | null = null, bands: THREE.InstancedMesh | null = null, conduits: THREE.Mesh | null = null, sheaths: THREE.Mesh | null = null;
  let labels: THREE.Mesh | null = null, atlas: Atlas | null = null;
  const heights = new Float32Array(64), heightGoal = new Float32Array(64);
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), c = new THREE.Color();
  const angleOf = (i: number, n: number) => {
    const span = n <= 1 ? 0 : Math.min(Math.PI * 0.62, 0.4 * (n - 1));
    return -Math.PI / 2 - span / 2 + (n <= 1 ? 0 : (span * i) / (n - 1));
  };
  let vertsPer = 0;

  function buildHosts(list: Feed[], others: boolean) {
    root.remove(hostGroup); disposeTree(hostGroup); atlas?.dispose(); atlas = null;
    hostGroup = new THREE.Group();
    const n = list.length;
    cabinets = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 1, 0.5).translate(0, 0.5, 0), cabinetMat, Math.max(1, n));
    bands = new THREE.InstancedMesh(new THREE.BoxGeometry(0.47, 0.03, 0.51), bandMat, Math.max(1, n));
    bands.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
    cabinets.count = bands.count = n;
    cabinets.castShadow = cabinets.receiveShadow = true;
    const tubes: THREE.BufferGeometry[] = [], shells: THREE.BufferGeometry[] = [];
    const facing: THREE.Quaternion[] = [];
    for (let i = 0; i < n; i++) {
      const a = angleOf(i, n), dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const at = (r: number, y: number) => dir.clone().multiplyScalar(r).setY(y);
      const curve = new THREE.CatmullRomCurve3([at(R - 0.3, 0.1), at(R * 0.62, 0.08), at(1.6, 0.25), at(0.98, 0.42), at(0.7, 0.62)]);
      const share = list[i].share;
      tubes.push(new THREE.TubeGeometry(curve, SEGMENTS, 0.028 + share * 0.07, RADIAL, false));
      shells.push(new THREE.TubeGeometry(curve, SEGMENTS / 2, 0.05 + share * 0.08, RADIAL, false));
      facing.push(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(at(R, 0), new THREE.Vector3(0, 0, 14), new THREE.Vector3(0, 1, 0))).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)));
      heights[i] = heightGoal[i] = 0.4;
    }
    vertsPer = tubes[0]?.getAttribute('position').count ?? 0;
    if (n) {
      const g = mergeGeometries(tubes), count = g.getAttribute('position').count;
      for (const name of ['aSpeed', 'aGlow', 'aDash', 'aLive']) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
      conduits = new THREE.Mesh(g, conduitMat);
      sheaths = new THREE.Mesh(mergeGeometries(shells), sheathMat);
      sheaths.renderOrder = 2; sheaths.visible = detail >= 0.5;
      hostGroup.add(conduits, sheaths);
    } else { conduits = sheaths = null; }
    tubes.forEach((t) => t.dispose()); shells.forEach((t) => t.dispose());
    // Labels: a name and watts over each host, the core's figure, and the hosts not drawn.
    atlas = new Atlas(n + 2, 96, 512);
    labels = labelMesh(atlas, [
      ...facing.map((f, i) => { const a = angleOf(i, n); return { row: i, width: 1.5, matrix: new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * R, 2.0, Math.sin(a) * R), f, new THREE.Vector3(1, 1, 1)) }; }),
      { row: n, width: 2.2, matrix: new THREE.Matrix4().makeTranslation(0, 2.6, 0) },
      ...(others ? [{ row: n + 1, width: 1.6, matrix: new THREE.Matrix4().makeTranslation(R * 0.95, 0.6, 0.6) }] : []),
    ]);
    hostGroup.add(cabinets, bands, labels);
    root.add(hostGroup);
  }

  let detail = ctx.detail;
  const motes = dust(700, new THREE.Vector3(12, 3.5, 10), ctx.theme);
  motes.setDetail(ctx.detail);
  root.add(motes.points);

  let st: EnergyState | null = null, coreGoal = 0, core = 0;
  const update = (s: EnergyState) => {
    st = s;
    feeds = s.feeds;
    const k = feeds.map((f) => f.key).join(',') + (s.others.hosts ? '+' : '');
    if (k !== keys) { keys = k; buildHosts(feeds, s.others.hosts > 0); }
    const live = s.freshness === 'live' && s.flowing;
    // Conduits: per-vertex values for each host's stretch of the merged geometry.
    if (conduits) {
      const g = conduits.geometry;
      const speed = g.getAttribute('aSpeed') as THREE.BufferAttribute, glow = g.getAttribute('aGlow') as THREE.BufferAttribute;
      const dash = g.getAttribute('aDash') as THREE.BufferAttribute, alive = g.getAttribute('aLive') as THREE.BufferAttribute;
      feeds.forEach((f, i) => {
        const on = live && f.live && f.watts > 0;
        for (let j = i * vertsPer; j < (i + 1) * vertsPer; j++) {
          speed.setX(j, 0.12 + f.level * 0.9); glow.setX(j, 0.25 + f.level * 0.75); dash.setX(j, f.source === 'estimated' ? 1 : 0); alive.setX(j, on ? 1 : 0);
        }
      });
      speed.needsUpdate = glow.needsUpdate = dash.needsUpdate = alive.needsUpdate = true;
    }
    feeds.forEach((f, i) => {
      heightGoal[i] = 0.35 + (f.live ? f.level : 0) * 1.2;
      c.copy(!live || !f.live ? p.tone.none : f.source === 'estimated' ? p.amber : p.accent).multiplyScalar(live && f.live ? 2 : 0.4);
      bands!.setColorAt(i, c);
      atlas?.draw(i, { text: f.name, sub: `${f.live ? watts(f.watts) : '–'} · ${ctx.text[f.source]}`, align: 'center', color: live && f.live ? p.text : p.muted }, p);
    });
    if (bands?.instanceColor) bands.instanceColor.needsUpdate = true;
    atlas?.draw(feeds.length, { text: s.facilityWatts === null ? ctx.text.noFlow : ctx.text.facility.replace('{w}', watts(s.facilityWatts)), sub: s.watts === null ? undefined : ctx.text.it.replace('{w}', watts(s.watts)), align: 'center' }, p);
    if (s.others.hosts) atlas?.draw(feeds.length + 1, { text: ctx.text.others.replace('{n}', String(s.others.hosts)), sub: watts(s.others.watts), align: 'center', color: p.muted }, p);
    // The core glows with the power drawn now against the day's peak.
    const peak = Math.max(s.watts ?? 0, ...s.hours.map((h) => h.watts));
    coreGoal = live && s.watts !== null && peak > 0 ? s.watts / peak : 0;
    ringMat.color.copy(live ? p.accent : p.tone.none).multiplyScalar(live ? 1.2 + coreGoal * 1.4 : 0.35);
    coreGlowMat.emissive.copy(live ? p.accent : p.tone.none);
    // Hours.
    hours.count = s.hours.length;
    s.hours.forEach((h, i) => {
      hourGoal[i] = h.level;
      const last = i === s.hours.length - 1;
      c.copy(live ? p.accent : p.tone.none).multiplyScalar(last ? 1.6 : 0.7);
      hours.setColorAt(i, c);
    });
    if (hours.instanceColor) hours.instanceColor.needsUpdate = true;
  };

  const frame = (t: number, dt: number, still: boolean) => {
    let moving = false;
    const ease = (from: number, to: number) => { const n = still ? to : approach(from, to, dt, 2); if (Math.abs(n - to) > 0.0005) moving = true; return n; };
    core = ease(core, coreGoal);
    coreGlowMat.emissiveIntensity = 0.15 + core * 2.2;
    for (let i = 0; i < feeds.length && cabinets; i++) {
      heights[i] = ease(heights[i], heightGoal[i]);
      const a = angleOf(i, feeds.length);
      v.set(Math.cos(a) * R, 0, Math.sin(a) * R); q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -a + Math.PI / 2); sc.set(1, heights[i], 1);
      m4.compose(v, q, sc); cabinets.setMatrixAt(i, m4);
      v.y = heights[i] + 0.02; sc.set(1, 1, 1); m4.compose(v, q, sc); bands!.setMatrixAt(i, m4);
    }
    if (cabinets) { cabinets.instanceMatrix.needsUpdate = true; bands!.instanceMatrix.needsUpdate = true; }
    const n = st?.hours.length ?? 0;
    for (let i = 0; i < n; i++) {
      hourLevel[i] = ease(hourLevel[i], hourGoal[i]);
      const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
      // A low ring outside the core's base: each bar the hour's average watts against the day's peak.
      v.set(Math.cos(a) * 2.25, 0, Math.sin(a) * 2.25); q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -a); sc.set(0.07, 0.03 + hourLevel[i] * 0.5, 0.15);
      m4.compose(v, q, sc); hours.setMatrixAt(i, m4);
    }
    hours.instanceMatrix.needsUpdate = true;
    conduitMat.uniforms.uTime.value = t;
    const flowing = !!st && st.flowing && st.freshness === 'live';
    conduitMat.uniforms.uStill.value = flowing && !still ? 0 : 1;
    if (!still) motes.points.rotation.y = t * 0.003;
    return moving || (!still && flowing);
  };

  return {
    root,
    home: { position: new THREE.Vector3(0, 5.4, 10.2), target: new THREE.Vector3(0, 0.9, -1.4) },
    focus: [
      { position: new THREE.Vector3(0, 5.4, 10.2), target: new THREE.Vector3(0, 0.9, -1.4) },
      { position: new THREE.Vector3(2.6, 2.2, 3.6), target: new THREE.Vector3(0, 1.1, 0) },
      { position: new THREE.Vector3(-5.5, 2.8, 2.5), target: new THREE.Vector3(-1.8, 0.6, -3.0) },
      { position: new THREE.Vector3(5.8, 3.4, 2.2), target: new THREE.Vector3(1.6, 0.6, -3.0) },
    ],
    size: 8,
    update,
    frame,
    setDetail(d) { detail = d; motes.setDetail(d); if (sheaths) sheaths.visible = d >= 0.5; },
    dispose() { atlas?.dispose(); disposeTree(root); },
  };
}
