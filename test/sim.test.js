// Small checks on the carried-over engine pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G, Co, Hz, createRng, startFight, tick, snapshot, View, sanitize } from './_sim.js';

test('the seeded RNG is the mulberry32 stream Threshold used, and its state can be saved and restored', () => {
  // Threshold's 01_core.js, verbatim
  function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const r = createRng(7), ref = mulberry(7);
  for (let i = 0; i < 1000; i++) assert.equal(r(), ref());
  const st = r.state, a = r(); r.state = st; assert.equal(r(), a);
});

test('coroutine waits carry their remainder, so a timeline does not drift with the step size', () => {
  for (const dt of [1 / 20, 1 / 30, 1 / 60, 1 / 144]) {
    Co.clear(); let fired = -1, t = 0;
    Co.start(function* () { yield 1.0; yield 1.0; yield 1.0; fired = t; });
    while (fired < 0 && t < 5) { t += dt; Co.update(dt); }
    assert.ok(fired >= 3 && fired <= 3 + 2 * dt + 1e-9, `dt ${dt}: fired at ${fired}`); // the first update is at t = dt, so up to two steps late, never drifting further
  }
  Co.clear();
});

test('hazard shapes', () => {
  assert.equal(Hz.inShape({ type: 'circle', x: 0, z: 0, r: 2 }, 1.9, 0), true);
  assert.equal(Hz.inShape({ type: 'circle', x: 0, z: 0, r: 2 }, 2.1, 0), false);
  assert.equal(Hz.inShape({ type: 'donut', x: 0, z: 0, r0: 2, r1: 4 }, 3, 0), true);
  assert.equal(Hz.inShape({ type: 'donut', x: 0, z: 0, r0: 2, r1: 4 }, 1, 0), false);
  assert.equal(Hz.inShape({ type: 'cone', x: 0, z: 0, dir: 0, arc: 1, r: 10 }, 0, 5), true); // angle 0 points along +Z
  assert.equal(Hz.inShape({ type: 'cone', x: 0, z: 0, dir: 0, arc: 1, r: 10 }, 5, 0), false);
  assert.equal(Hz.inShape({ type: 'rect', x: 0, z: 0, dir: Math.PI / 2, len: 10, w: 2 }, 5, 0.5), true);
  assert.equal(Hz.inShape({ type: 'rect', x: 0, z: 0, dir: Math.PI / 2, len: 10, w: 2 }, -1, 0), false);
});

test('a fight starts, the intro (skipped) hands over to phase 1, and the snapshot is plain data', () => {
  startFight({ boss: 'atelier', cls: 'duskblade', seed: 3 });
  assert.equal(G.state, 'loading');
  tick({ mx: 0, mz: 0, held: 0, press: [] });
  assert.equal(G.state, 'fight'); assert.equal(G.boss.phase, 0);
  for (let i = 0; i < 60; i++) tick({ mx: 0, mz: -1, held: 0, press: [0] });
  const s = snapshot();
  assert.ok(s.player.z < 12, 'the player walked toward the boss');
  assert.doesNotThrow(() => JSON.stringify(s));
});

test('the intro plays in sim time when asked, and locks the player like a cinematic', () => {
  startFight({ boss: 'atelier', cls: 'hexslinger', seed: 3, intro: true });
  tick({ mx: 1, mz: 0, held: 0, press: [0] }); let n = 1;
  while (G.state === 'intro' && n < 30 * 10) { tick({ mx: 1, mz: 0, held: 0, press: [0] }); n++; }
  assert.ok(n > 30 * 5, 'the intro took ' + (n / 30).toFixed(1) + ' s'); // 0.3 + 5.2 shot + 0.7
  assert.equal(G.state, 'fight');
  // the tick that ends the intro is already a fight tick, so the hero may take one step (7 m/s for 1/30 s), no more
  assert.ok(G.player.pos.x <= 7 / 30 + 1e-9, 'the player moved during the intro: ' + G.player.pos.x);
});

test('the protocol keeps only sane input', () => {
  const f = sanitize({ mx: 3, mz: 4, press: [0, 9, -1, 2, 'x'], held: 1 << 9 | 1, target: 'boss', face: NaN });
  assert.ok(Math.abs(Math.hypot(f.mx, f.mz) - 1) < 1e-12); assert.deepEqual(f.press, [0, 2]); assert.equal(f.held, 1);
  assert.equal(f.target, undefined); assert.equal(f.face, undefined);
  assert.deepEqual(sanitize(null), { mx: 0, mz: 0, held: 0, press: [] });
  void View;
});
