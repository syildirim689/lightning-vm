import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTier, forcedTier, isSoftware, ladder, MAX_PIXELS, pixelRatio, settingsAt, tierSettings, type Probe } from './wall-quality.ts';

const desk: Probe = { webgl2: true, maxTexture: 16384, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', memory: 8, cores: 12, mobile: false, pixels: 1920 * 1080 };

test('tier: a desktop GPU draws everything; phones and small machines less', () => {
  assert.deepEqual(chooseTier(desk), { tier: 'high', reason: null });
  assert.equal(chooseTier({ ...desk, mobile: true, renderer: 'Adreno (TM) 650' }).tier, 'medium');
  assert.equal(chooseTier({ ...desk, cores: 4 }).tier, 'medium');
  assert.equal(chooseTier({ ...desk, memory: 4 }).tier, 'medium');
  assert.equal(chooseTier({ ...desk, memory: 2 }).tier, 'low');
  assert.equal(chooseTier({ ...desk, cores: 2 }).tier, 'low');
  assert.equal(chooseTier({ ...desk, maxTexture: 2048 }).tier, 'low');
  // A browser that does not say its memory or cores is not held against.
  assert.equal(chooseTier({ ...desk, memory: null, cores: null }).tier, 'high');
});

test('tier: no WebGL 2 or a software renderer is the 2D wall, with the reason', () => {
  assert.deepEqual(chooseTier({ ...desk, webgl2: false }), { tier: 'flat', reason: 'no-webgl' });
  for (const r of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)',
    'Microsoft Basic Render Driver', 'Mesa OffScreen']) {
    assert.ok(isSoftware(r), r);
    assert.deepEqual(chooseTier({ ...desk, renderer: r }), { tier: 'flat', reason: 'software' });
  }
  for (const r of ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple M2', 'Mali-G78', 'ANGLE (VMware, Inc., VMware SVGA 3D Direct3D11 vs_5_0 ps_5_0, D3D11)']) assert.ok(!isSoftware(r), r);
});

test('settings: each ladder step takes something away and never adds', () => {
  for (const tier of ['high', 'medium', 'low'] as const) {
    let prev = tierSettings[tier];
    for (let i = 1; i <= ladder.length; i++) {
      const s = settingsAt(tier, i);
      assert.ok(s.scale <= prev.scale && s.detail <= prev.detail && s.msaa <= prev.msaa, `${tier} step ${i}`);
      assert.ok(!(s.bloom && !prev.bloom) && !(s.dof && !prev.dof), `${tier} step ${i}`);
      assert.ok(['soft', 'hard', 'off'].indexOf(s.shadows) >= ['soft', 'hard', 'off'].indexOf(prev.shadows), `${tier} step ${i}`);
      prev = s;
    }
  }
  const floor = settingsAt('high', ladder.length);
  assert.deepEqual([floor.bloom, floor.dof, floor.shadows, floor.msaa, floor.detail], [false, false, 'off', 0, 0]);
  assert.deepEqual(settingsAt('high', 99), floor);
  assert.deepEqual(settingsAt('medium', 0), tierSettings.medium);
});

test('pixel ratio: capped by the tier, scaled by the governor, never past a 4K frame', () => {
  assert.equal(pixelRatio(tierSettings.high, 1, 1920, 1080), 1);
  assert.equal(pixelRatio(tierSettings.high, 3, 390, 844), 2);
  assert.equal(pixelRatio(tierSettings.medium, 3, 390, 844), 1.5);
  assert.equal(pixelRatio(tierSettings.low, 2, 1280, 800), 1);
  assert.equal(pixelRatio({ ...tierSettings.high, scale: 0.7 }, 2, 1280, 800), 1.4);
  // A 4K TV reporting DPR 2 at 1920 × 1080 CSS pixels: 4K worth of pixels, not 8K.
  const r = pixelRatio(tierSettings.high, 2, 1920, 1080);
  assert.ok(1920 * 1080 * r * r <= MAX_PIXELS * 1.01, String(r));
  assert.equal(pixelRatio(tierSettings.high, 1, 7680, 4320), 0.5);
});

test('quality asked for in the address', () => {
  assert.equal(forcedTier('2d'), 'flat');
  assert.equal(forcedTier('low'), 'low');
  assert.equal(forcedTier('ultra'), null);
  assert.equal(forcedTier(null), null);
});
