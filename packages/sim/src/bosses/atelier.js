// PENTIMENTO, the Unfinished Canvas: the rules half. A blank canvas, and the floor keeps every drop of paint. You wear what
// you walk through, and what you are wearing decides whether his Critique breaks you. It never changes your damage.
//
// Carried over from Threshold's 38_boss_atelier.js (Normal and the Nightmare "Chiaroscuro"). Kept: every mechanic, the paint
// grid, the route check and repair, the ramp, the enrage and the varnish, the autopilot hint. Removed (view half, for the
// client): the studio, the lay figure, the floor canvas and its paint job, every material and shader, the finale's look
// (nmLook), the kill cinematic. What the view needs is in b.pub (update, below) and the 'atelier.lay' cue for each stroke.
//
// Several players (Axiom, plan step 3): each player wears their own paint (S.pw[id]); the strokes, splatters, drips, knife
// cuts and the roller aim at the players in turn (b.nextTarget()); a Blot chases the nearest; a Critique judges everyone: those
// who do not match take the blow, and he is knocked down only when every standing player matches. With one player all of it
// is exactly the single-player fight.
import { G, Co, rnd, pick, shuffle, vrand, livePlayers, nearestPlayer } from '../core.js';
import { V3, TAU, PI, clamp, lerp, smooth, dampAng } from '../math.js';
import { Hz } from '../combat.js';
import { FX, Sound, Music, Post, Cam, View } from '../view.js';
import { Bot } from '../bot.js';

(() => {
  const R = 20, GN = 80, CELL = 0.5, N = 1024, U = N / (2 * R), WET = 20, RED = 1, YEL = 2, BLU = 4;
  const HEX = [0xffffff, 0xe23a2e, 0xf2c218, 0xf08a1e, 0x2a5fe0, 0x8a3cd0, 0x2aa858, 0x5c4332];
  const INK = 0x16161e, _a = new V3();
  const bitsOf = (m) => [RED, YEL, BLU].filter((q) => m & q);
  // nightmare finale ("Chiaroscuro"): a seam through the centre turns once in 40 s and splits the canvas into a white half
  // (s > 0) and a black half. He calls a half and a colour: white + red = be red in the white half; black + red = be the
  // complement (green) in the black half. Every call names a real colour (no clean or mud calls). Standing on the seam counts as neither half.
  const SEAM = 0.6, FIN_LOOK = 1.35, VARN = 0xd8a050, NMTEL = 0x8f93b0, WALK = 5.6, DETOUR = 1.25;
  const wantWear = (c) => c.tone === 'w' ? c.col : 7 ^ c.col, wantSide = (c) => c.tone === 'w' ? 1 : -1;
  const sideAt = (A, x, z) => { const s = x * Math.cos(A) - z * Math.sin(A); return s > SEAM ? 1 : s < -SEAM ? -1 : 0; };
  const sideOf = (S, x, z) => sideAt(S.lineA, x, z);
  // what one player is wearing (pigment bits), created on first use
  const pw = (S, p) => S.pw[p.id] || (S.pw[p.id] = { wear: 0, wearK: 0, match: 0, mul: 1 });
  const need = (S) => S.split && S.call ? wantWear(S.call) : S.neg ? 7 ^ S.col : S.col; // in the negative the rule inverts with the world
  // the rule, at a point: the right paint (and, in the finale, the called half)
  const matched = (S, p) => pw(S, p).wear === need(S) && (!S.split || !S.call || sideOf(S, p.pos.x, p.pos.z) === wantSide(S.call));
  // damage never depends on paint (paint only decides a Critique): a flat DMG_BASE, and in the nightmare finale WRONG_SIDE while you
  // stand outside the called half (the seam strip counts as outside)
  const DMG_BASE = 1.0, WRONG_SIDE = 0.1;
  const offSide = (S, x, z) => !!(S.split && S.call) && sideOf(S, x, z) !== wantSide(S.call);
  const tel = (S) => S.split ? NMTEL : S.neg ? 0xf4f4ff : INK;
  const inWash = (S, p) => !!p && Math.hypot(p.pos.x - S.wash.x, p.pos.z - S.wash.z) < S.wash.r;
  const CLIP = R - 0.25; // paint stops just inside the drawn edge of the tondo

  // ---- the floor: a grid of wet pigment for the rules (the canvas of strokes for the eye is client-side) ----
  function cells(S, sh, fn) {
    let x0, x1, z0, z1;
    if (sh.t === 'c') { x0 = sh.x - sh.r; x1 = sh.x + sh.r; z0 = sh.z - sh.r; z1 = sh.z + sh.r; }
    else { const ex = sh.x + Math.sin(sh.dir) * sh.len, ez = sh.z + Math.cos(sh.dir) * sh.len, h = sh.w / 2; x0 = Math.min(sh.x, ex) - h; x1 = Math.max(sh.x, ex) + h; z0 = Math.min(sh.z, ez) - h; z1 = Math.max(sh.z, ez) + h; }
    const i0 = clamp(Math.floor((x0 + R) / CELL), 0, GN - 1), i1 = clamp(Math.floor((x1 + R) / CELL), 0, GN - 1), j0 = clamp(Math.floor((z0 + R) / CELL), 0, GN - 1), j1 = clamp(Math.floor((z1 + R) / CELL), 0, GN - 1), fx = Math.sin(sh.dir || 0), fz = Math.cos(sh.dir || 0);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * CELL - R, z = (j + 0.5) * CELL - R, dx = x - sh.x, dz = z - sh.z; if (x * x + z * z > R * R) continue;
      if (sh.t === 'c') { if (dx * dx + dz * dz > sh.r * sh.r) continue; } else { const al = dx * fx + dz * fz, sd = dx * fz - dz * fx; if (al < 0 || al > sh.len || Math.abs(sd) > sh.w / 2) continue; }
      fn(j * GN + i);
    }
  }
  function lay(S, sh) { // sh.m = pigment, or 0 to scrape the floor clean
    sh.t0 = G.ft; sh.dry = false; sh.seed = (S.seed = (S.seed + 7919) % 100003);
    cells(S, sh, (k) => { S.pig[k] = sh.m; S.dryAt[k] = sh.m ? G.ft + WET : 0; });
    // the stroke list is what the picture is drawn from (Threshold kept a paint job here; that is client work now)
    S.strokes.push(sh); View.cue('atelier.lay', sh); if (S.strokes.length > 110) { S.baked.push(S.strokes.shift()); if (S.baked.length > 400) S.baked.shift(); }
  }
  const wetAt = (S, x, z) => { const i = Math.floor((x + R) / CELL), j = Math.floor((z + R) / CELL); if (i < 0 || j < 0 || i >= GN || j >= GN) return 0; const k = j * GN + i; return S.dryAt[k] > G.ft ? S.pig[k] : 0; };
  // The rules half of Threshold's build(): the paint grid, the dish, the per-fight state. The studio, the lay figure, the
  // floor canvas, the roller and the varnish shell are all the view half (client).
  function build(b) {
    const S = b.state;
    Object.assign(S, { pig: new Uint8Array(GN * GN), dryAt: new Float32Array(GN * GN), strokes: [], baked: [], seed: 11, neg: false, col: RED, pw: {}, lvl: 0, wash: { x: 0, z: 16.2, r: 2.5 }, roll: null, down: 0, swing: 0, look: 0, lookT: 0, bag: [], dryT: 0, flood: 0, blots: 0, blotList: [] });
    if (G.nightmare) nmBuild(b, S);
    return {
      edge: 'wall', radius: R, spawn: { x: 0, z: 12 }, bossStart: { x: 0, z: -3, face: 0 }, camDist: 17, camPitch: 0.55,
      contains: (x, z) => Math.hypot(x, z) <= R - 0.5, bulletBounds: (x, z) => Math.hypot(x, z) < R + 1,
    };
  }
  // the finale's state (Threshold also built every finale mesh here, hidden)
  function nmBuild(b, S) {
    Object.assign(S, { nm: true, cov: true, split: 0, lineA: 0, lineW: TAU / 40, call: null, fin: 0, finK: 0, toneK: 0, top: 7.5, varnR: 99, seamOn: false, seamP: 1, seamW: 1, pulse: 0,
      tones: [], cbag: [], fk: 0, stepAt: [], finStep: 0, sigDone: false, sig: 0, holdWash: 0, faceSide: false, routeFail: 0, critLog: [], look: 1, lookT: 1 }); // the fight opens in colour
  }

  const nextPig = (S) => { if (!S.bag.length) S.bag = shuffle([RED, YEL, BLU]); return S.bag.pop(); };
  // (finale: nothing tints you while you stand in the dish)
  function tint(S, p, m, loud) { const w = pw(S, p); if ((w.wear | m) === w.wear || (S.split && inWash(S, p))) return; w.wear |= m; w.wearK = 1; if (loud !== false) Sound.sfx('wave', 0.5, 1.5); }
  function* recolor(b, c) {
    const S = b.state; S.flood = 1;
    yield* b.cast({ name: 'Fresh Coat', time: 1.3 }); S.col = c; S.flood = 0; Sound.sfx('wave', 0.9, 0.7); FX.flash(HEX[c], 0.16, 3);
    if (!G.headless) FX.ring(b.pos.x, b.pos.z, { r0: 1, r1: 9, color: HEX[c], dur: 0.5 }); yield 0.5;
  }
  function stripe(b, m, x, z, a, w, delay, dmg, name) {
    const S = b.state, x0 = x - Math.sin(a) * 22, z0 = z - Math.cos(a) * 22;
    Hz.rect(x0, z0, a, 44, w, delay, dmg, { name, color: tel(S), onFire() { lay(S, { t: 'r', x: x0, z: z0, dir: a, len: 44, w, m }); S.swing = 1; if (!G.headless && m) FX.burst(x, 0.4, z, { n: 24, color: HEX[m], speed: [2, 9], life: [0.3, 0.8] }); }, onHit(h, t, p) { if (m && S.lvl >= 1) tint(S, p, m); } });
  }
  function* strokes(b, pigs) {
    const S = b.state; let a = rnd(0, PI);
    for (const m of pigs) { yield* b.cast({ name: 'Stroke', time: 0.45 }); const p = b.nextTarget(); stripe(b, m, p.pos.x + rnd(-1.5, 1.5), p.pos.z + rnd(-1.5, 1.5), a, 3, 1.0, 280, 'Stroke'); a += PI / 3 + rnd(-0.3, 0.3); yield 0.75; }
    yield 0.7;
  }
  function* splatter(b, n) {
    const S = b.state; yield* b.cast({ name: 'Splatter', time: 0.7 });
    for (let i = 0; i < n; i++) { const p = b.nextTarget(), m = nextPig(S), a = rnd(0, TAU), d = i === 0 ? 0 : rnd(3, 8), x = clamp(p.pos.x + Math.sin(a) * d, -17, 17), z = clamp(p.pos.z + Math.cos(a) * d, -17, 17);
      Hz.circle(x, z, 2.6, 1.25, 220, { name: 'Splatter', color: tel(S), onFire() { lay(S, { t: 'c', x, z, r: 2.6, m }); }, onHit(h, t, q) { if (S.lvl >= 1) tint(S, q, m); } }); yield 0.28; }
    yield 1.1;
  }
  function* drips(b, n) {
    const S = b.state;
    for (let i = 0; i < n; i++) { const p = b.nextTarget(), m = nextPig(S), a = rnd(0, TAU), d = rnd(1, 9), x = p.pos.x + Math.sin(a) * d, z = p.pos.z + Math.cos(a) * d; if (Math.hypot(x, z) > R - 1) continue;
      Hz.circle(x, z, 1.7, 2.0, 160, { name: 'Drip', color: tel(S), quiet: true, onFire() { lay(S, { t: 'c', x, z, r: 1.7, m }); }, onHit(h, t, q) { if (S.lvl >= 1) tint(S, q, m); } }); yield 0.4; }
  }
  function* roller(b) {
    const S = b.state, p = b.nextTarget(), m = nextPig(S), a = rnd(0, TAU), fx = Math.sin(a), fz = Math.cos(a), off = clamp(p.pos.x * fz - p.pos.z * fx, -9, 9), cx = fz * off, cz = -fx * off;
    yield* b.cast({ name: 'Roller', time: 0.8 }); Hz.rect(cx - fx * 22, cz - fz * 22, a, 44, 12, 1.3, 0, { name: 'Roller', color: tel(S), quiet: true });
    S.roll = { a, fx, fz, cx, cz, s: -24, v: 11, m, hit: {}, laid: -22 }; yield 1.3; Sound.sfx('wave', 0.8, 0.5);
    const q = S.roll; while (q.s < 22) { q.s += q.v * G.dt;
      for (const p of G.players) if (p.alive && !q.hit[p.id] && p.pos.y < 0.5) { const dx = p.pos.x - q.cx, dz = p.pos.z - q.cz, al = dx * fx + dz * fz, sd = dx * fz - dz * fx; if (Math.abs(al - q.s) < 1.0 && Math.abs(sd) < 6) { q.hit[p.id] = 1; p.hurt(300, { blockable: true, kb: { dir: a, dist: 4 }, src: { name: 'Roller' } }); if (S.lvl >= 1) tint(S, p, m); } }
      if (q.s - q.laid >= 5.5 || q.s >= 22) { const e = Math.min(q.s - 1, 22); if (e > q.laid) { lay(S, { t: 'r', x: q.cx + fx * q.laid, z: q.cz + fz * q.laid, dir: a, len: e - q.laid, w: 12, m }); q.laid = e; } }
      yield; }
    S.roll = null; yield 0.5;
  }
  function* knife(b) {
    const S = b.state; let a = rnd(0, PI);
    yield* b.cast({ name: 'Palette Knife', time: 0.7 });
    for (let i = 0; i < 3; i++) { const p = b.nextTarget(); stripe(b, 0, p.pos.x + rnd(-2, 2), p.pos.z + rnd(-2, 2), a, 2.4, 0.95, 260, 'Palette Knife'); a += PI / 3; yield 0.5; }
    yield 1.0;
  }
  function blot(b, m) {
    const S = b.state; if (S.blots >= 2) return; S.blots++; const a = rnd(0, TAU), x = Math.sin(a) * 15, z = Math.cos(a) * 15;
    let lt = 0, cd = 0;
    const ent = b.spawnAdd({ name: 'Blot', hp: 280, x, z, radius: 0.85, aimY: 0.8, color: HEX[m], pig: m, onDeath(e) { S.blots--; S.blotList = S.blotList.filter((q) => q !== e); lay(S, { t: 'c', x: e.pos.x, z: e.pos.z, r: 2.2, m }); },
      update(e, dt) { const p = nearestPlayer(e.pos.x, e.pos.z), d = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z); if (d > 0.9) { e.pos.x += (p.pos.x - e.pos.x) / d * 3.1 * dt; e.pos.z += (p.pos.z - e.pos.z) / d * 3.1 * dt; }
        lt -= dt; if (lt <= 0) { lt = 0.55; lay(S, { t: 'c', x: e.pos.x, z: e.pos.z, r: 1.05, m }); } if (d < 1.35 && cd <= 0 && p.alive && e.alive) { cd = 9; p.hurt(140, { blockable: true, src: { name: 'Blot' } }); tint(S, p, m); e.damage(e.hp + 1, { src: 'self' }); } } });
    S.blotList.push(ent); Sound.sfx('cast', 0.5, 0.6);
  }
  // o (nightmare signature only): stagger false = a matched verdict deals its blow without knocking him down; quick = no pause after
  function* critique(b, T, o) {
    const S = b.state, stag = !o || o.stagger !== false; S.crit = T;
    yield* b.cast({ name: 'Critique', time: T, onTick(k, cs) { S.crit = T - cs.t; } }); S.crit = 0;
    // every standing player is judged; he goes down only when all of them match
    const L = livePlayers(), all = L.length > 0 && L.every((q) => matched(S, q)), p = b.focusPlayer(), pc = HEX[pw(S, p).wear] || 0xffffff;
    if (S.split && S.critLog.length) Object.assign(S.critLog[S.critLog.length - 1], { ok: matched(S, p), vw: pw(S, p).wear, vs: sideOf(S, p.pos.x, p.pos.z) }); // the verdict, for tools/critfuzz.js
    if (!stag && all) { Sound.sfx('shatter', 0.8, 1.1); FX.flash(0xffffff, 0.14, 4); b.damage(Math.round(b.maxHp * 0.03), { src: 'player', crit: true }); if (!G.headless) FX.burst(b.pos.x, 3, b.pos.z, { n: 30, color: pc, color2: 0xffffff, speed: [4, 10], life: [0.3, 0.8], size: [0.2, 0.5], drag: 2.2 }); }
    else if (all) { S.down = 5; b.exposed = 5; Sound.sfx('shatter', 0.9, 0.9); Sound.sfx('parry', 0.9, 0.6); FX.flash(0xffffff, 0.2, 3); FX.shake(0.5); b.damage(Math.round(b.maxHp * 0.03), { src: 'player', crit: true }); if (!G.headless) { const c = pc; FX.burst(b.pos.x, 3, b.pos.z, { n: 46, color: c, color2: 0xffffff, speed: [4, 11], life: [0.4, 1.0], size: [0.25, 0.7], drag: 2.2 }); FX.burst(b.pos.x, 2.5, b.pos.z, { n: 10, smoke: true, color: 0xe8e0d0, color2: 0xc8beb0, speed: [1, 3], life: [0.8, 1.6], size: [1, 2.2], up: 1.5, alpha: 0.28, drag: 1.5 }); FX.ring(b.pos.x, b.pos.z, { r0: 0.3, r1: 6, color: c, dur: 0.5, width: 0.16 }); FX.light(b.pos.x, 4, b.pos.z, c, 60, 0.4, 15); } yield 5; S.down = 0; }
    else {
      for (const q of L) if (!matched(S, q)) { q.hurt(350, { blockable: false, src: { name: 'Critique' } }); if (!G.headless) FX.beam(new V3(b.pos.x, 4, b.pos.z), new V3(q.pos.x, 1, q.pos.z), { color: S.neg || (S.split && sideOf(S, q.pos.x, q.pos.z) < 0) ? 0xffffff : 0x202028, width: 0.9, dur: 0.35 }); }
      Sound.sfx('bigboom', 0.7); FX.flash(tel(S), 0.25, 2); FX.shake(0.6); if (stag) yield 1.0;
    }
  }
  function* wander(b) { const a = rnd(0, TAU), d = rnd(0, 6); yield* b.moveTo(Math.sin(a) * d, Math.cos(a) * d, 5); }
  // one colour's worth of fight: he floods with it, lays down what you need and what you must not touch, then judges you
  function* block(b, c, k) {
    const S = b.state, lvl = S.lvl; yield* recolor(b, c);
    const nb = bitsOf(need(S)), others = [RED, YEL, BLU].filter((m) => nb.indexOf(m) < 0);
    yield* strokes(b, shuffle(nb.concat(others).slice(0, 3)));
    if (lvl >= 1 && k % 2 === 0) blot(b, pick(others.length ? others : nb));
    if (k % 3 === 0) yield* splatter(b, lvl >= 1 ? 4 : 3); else if (k % 3 === 1 && lvl >= 1) yield* roller(b); else yield* drips(b, 5);
    Co.start(function* () { yield 1.2; if (lvl >= 2) yield* drips(b, 4); else if (lvl === 1) yield* drips(b, 2); }, 'phase');
    yield* critique(b, lvl >= 2 ? 4.5 : 5);
    yield* wander(b);
    if (lvl >= 1 && k % 2 === 1) yield* knife(b); else yield* splatter(b, 3);
    if (lvl >= 2) { yield* strokes(b, shuffle(nb.concat(others)).slice(0, 2)); yield* critique(b, 4.5); }
    else yield* strokes(b, [nextPig(S), nextPig(S)]);
  }
  function setLvl(b, n) { const S = b.state; S.lvl = n; S.lookT = n; S.down = 0; S.roll = null; S.crit = 0; S.flood = 0; if ((n >= 2) !== S.neg) S.neg = n >= 2; }
  function moveWash(S) { const a = rnd(0, TAU); S.wash = { x: Math.sin(a) * 16.2, z: Math.cos(a) * 16.2, r: 2.5 }; S.washK = 0; }

  // ---- phases two and three of the normal fight, shared with the nightmare (which opens in colour and goes to the Negative)
  const NEG_POST = { bloom: 0.32, threshold: 0.9, exposure: 1.0, tint: [1.0, 1.0, 1.04], contrast: 1.1 };
  function* colourRun(b) {
    const S = b.state; setLvl(b, 1); let k = 0, last = S.col;
    while (true) { const c = pick([1, 2, 4, 3, 5, 6].filter((q) => q !== last)); last = c; yield* block(b, c, k); k++; }
  }
  function* negEnter(b) {
    const S = b.state; setLvl(b, 1); S.lookT = 2;
    yield* b.cast({ name: 'Negative', time: 3.2, onTick: (k) => { FX.shake(k * 0.45); } });
    setLvl(b, 2); Sound.sfx('shatter', 1, 0.4); Sound.sfx('bigboom', 0.9); FX.flash(0x000000, 0.5, 1.2); Co.start(Post.lerpTo(Object.assign({}, NEG_POST), 1.5), 'fight'); yield 1.4;
  }
  function* negRun(b) {
    const S = b.state; setLvl(b, 2); let k = 0, last = S.col;
    while (true) { const c = pick([1, 2, 4, 3, 5, 6].filter((q) => q !== last)); last = c; yield* block(b, c, k); k++; }
  }

  // ================================================================ NIGHTMARE ("Chiaroscuro")
  // Nightmare health (the tuning lever; class numbers and the ramp stay). Tuned with tools/nmpace.js (god-mode level-3 autopilot,
  // whole fights from phase 1, eight runs per class). Paint luck spreads kill times a lot. At 34,000 and enrage 360 s:
  //   stormcaller 7/8 kills, median 5:10 (best 4:23, worst 5:47)
  //   hexslinger  8/8 kills, median 3:45 (best 3:34, worst 4:48): fastest; its best runs reach step 3 or 4
  //   ashwarden   3/8 kills, median 5:50 (best 5:22, worst 6:08)
  // At 32,000 and 340 s: duskblade 7/8 (median 5:02). Colour and the Negative go much faster than planned (180-250 dps matched),
  // so Chiaroscuro is 63-84% of the time rather than 60-70%; the thresholds were left as planned.
  const NM_HP = 30000;
  // Co.stopTag('phase') skips a coroutine's cleanup, so every per-mechanic state a cut-off mechanic can leave behind (roller, blots,
  // stagger, a Critique cast, the flood, a half-drawn swirl, the brush pointing at a half, the varnish ring, a cinematic camera, slow
  // time) is reset here, in every nightmare phase's enter. The look of the world (colour, Negative, the split) is not per-mechanic.
  function resetMech(b) {
    const S = b.state; S.down = 0; S.roll = null; S.crit = 0; S.flood = 0; S.faceSide = false; S.top = 7.5; S.sig = 0; S.varnR = 99; S.holdWash = 0; S.lineW = SEAM_W[0];
    for (const e of S.blotList.slice()) if (e.alive) e.die(); S.blotList = []; S.blots = 0;
    if (S.cine) { S.cine = false; Cam.release(); } G.timeScale = 1;
  }
  // the order of calls: white + a primary (only the half is new), black + a secondary, white + a secondary (a mix), then a shuffled bag of the
  // rest, never the same tone three times running and never a call you already answer where you stand
  const CALLS = []; for (const tone of ['w', 'b']) for (let col = 1; col <= 6; col++) CALLS.push({ tone, col });
  function nextCall(b) {
    const S = b.state, k = S.fk;
    let c;
    if (k === 0) c = { tone: 'w', col: pick([RED, YEL, BLU]) };
    else if (k === 1) c = { tone: 'b', col: pick([3, 5, 6]) };
    else if (k === 2) c = { tone: 'w', col: pick([3, 5, 6]) };
    else {
      const h = S.tones.slice(-2), fine = (q) => !(h.length === 2 && h[0] === q.tone && h[1] === q.tone) && !answers(S, q);
      if (!S.cbag.length) S.cbag = shuffle(CALLS.filter((q) => !S.used || !S.used.some((u) => u.tone === q.tone && u.col === q.col)));
      let i = S.cbag.findIndex(fine); if (i < 0) { S.cbag = shuffle(CALLS.slice()); i = S.cbag.findIndex(fine); if (i < 0) i = 0; }
      c = S.cbag.splice(i, 1)[0]; S.used = null;
    }
    if (k < 3) (S.used || (S.used = [])).push(c);
    return c;
  }
  // does some standing player already answer this call where they stand? (then it would be a free verdict)
  const answers = (S, q) => livePlayers().some((p) => pw(S, p).wear === wantWear(q) && sideOf(S, p.pos.x, p.pos.z) === wantSide(q));
  // Fresh Coat: the old swirl drains down off him into the floor, the tone turns (white or black), the new colour winds up from his
  // feet to his head, and a few drops fling off the top. He points the brush at the half he calls.
  function* freshCoat(b, call, quick) {
    const S = b.state, D = quick ? 0.15 : 0.4, U = quick ? 0.35 : 0.9; S.faceSide = true; S.flood = 0;
    if (!quick) Sound.sfx('wave', 0.5, 1.4);
    const step = (tt) => {
      if (tt < D) S.top = lerp(7.5, -0.4, tt / D);
      else { if (S.call !== call) { S.call = call; S.tones.push(call.tone); Sound.sfx('charge', quick ? 0.4 : 0.6, call.tone === 'w' ? 1.3 : 0.8); } S.top = lerp(-0.4, 7.5, smooth(Math.min(1, (tt - D) / U))); }
    };
    if (quick) { let t = 0; while (t < D + U) { t += G.dt; step(t); yield; } }
    else yield* b.cast({ name: 'Fresh Coat', time: 1.3, onTick(k, cs) { step(cs.t); } });
    step(D + 0.01); S.top = 7.5;
    if (!quick) { Sound.sfx('wave', 0.9, 0.7); FX.flash(call.col ? HEX[call.col] : call.tone === 'w' ? 0xffffff : 0x000000, 0.14, 3); }
    if (!G.headless && call.col) { _a.set(b.pos.x, b.pos.y + 7.1, b.pos.z); FX.burst(_a.x, _a.y + 0.5, _a.z, { n: quick ? 6 : 14, color: HEX[call.col], color2: 0xffffff, speed: [3, 7], up: 3, life: [0.4, 0.9], size: [0.12, 0.26], grav: 14 }); }
    if (!quick) yield 0.4;
  }
  // ---- every Critique has an answer: the route check
  // Seconds a careful walker needs, from (px, pz) wearing `wear`, to answer `call` when the verdict lands at tLand: to the dish if
  // the paint holds a pigment the answer does not (a clean call: the part of the dish deepest in the wanted half), then the nearest
  // wet cell of a pigment the answer still lacks (pure: nothing outside the answer, still wet half a second after arrival, not in
  // the dish), then 1.2 m inside the wanted half as it will be at tLand. The paint legs are walked at mud speed (5.6 m/s) with
  // straight lines x 1.25 for detours and hops; the last leg over the seam at walking speed (mud speed in mud) x 1.1. Infinity if
  // no wet paint can supply a missing pigment. o.dab: a drop he could lay ({x, z, r, m}), counted as wet paint. `o` collects the legs.
  function route(S, px, pz, wear, call, tLand, o = {}) {
    const nd = wantWear(call), sg = wantSide(call), A = S.lineA + S.lineW * Math.max(0, tLand - G.ft), ca = Math.cos(A), sa = Math.sin(A), Wh = S.wash, D = o.dab;
    const deep = (x, z) => sg * (x * ca - z * sa); // how far inside the wanted half
    let x = px, z = pz, d = 0, w = wear;
    if (w & ~nd) {
      const dw = Math.hypot(x - Wh.x, z - Wh.z), ri = Wh.r - 0.4; let qx, qz;
      if (dw <= ri) { qx = x; qz = z; } else { qx = Wh.x + (x - Wh.x) / dw * ri; qz = Wh.z + (z - Wh.z) / dw * ri; }
      if (nd === 0 && deep(qx, qz) < 1.2) { let bd = Infinity; for (let i = 0; i < 24; i++) { for (const rr of [0, ri * 0.5, ri]) { const ax = Wh.x + Math.sin(i / 24 * TAU) * rr, az = Wh.z + Math.cos(i / 24 * TAU) * rr; if (deep(ax, az) < 1.2) continue; const dd = Math.hypot(ax - x, az - z); if (dd < bd) { bd = dd; qx = ax; qz = az; } } } }
      d += Math.hypot(qx - x, qz - z); x = qx; z = qz; w = 0; o.wash = d;
    }
    o.px = x; o.pz = z;
    for (let guard = 0; (nd & ~w) && guard < 3; guard++) {
      const miss = nd & ~w; let best = null, bd = Infinity;
      for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
        const k = j * GN + i, m = S.pig[k]; if (!m || (m & ~nd) || !(m & miss)) continue;
        const cx = (i + 0.5) * CELL - R, cz = (j + 0.5) * CELL - R, dd = Math.hypot(cx - x, cz - z); if (dd >= bd) continue;
        if (S.dryAt[k] < G.ft + (d + dd) * DETOUR / WALK + 0.5 || Math.hypot(cx - Wh.x, cz - Wh.z) < Wh.r) continue;
        bd = dd; best = [cx, cz, m];
      }
      if (D && !(D.m & ~nd) && (D.m & miss)) { const dc = Math.hypot(D.x - x, D.z - z), dd = Math.max(0, dc - (D.r - 0.4)); if (dd < bd) { bd = dd; const k = dc > 1e-3 ? dd / dc : 0; best = [x + (D.x - x) * k, z + (D.z - z) * k, D.m]; } }
      if (!best) { o.miss = miss; return Infinity; }
      d += bd; x = best[0]; z = best[1]; w |= best[2];
    }
    let h = 0; const gap = 1.2 - deep(x, z);
    if (gap > 0) { let qx = x + sg * ca * gap, qz = z - sg * sa * gap; const r = Math.hypot(qx, qz); if (r > R - 1) { qx *= (R - 1) / r; qz *= (R - 1) / r; } h = Math.hypot(qx - x, qz - z); }
    return d * DETOUR / WALK + h * 1.1 / (w === 7 ? WALK : 7);
  }
  const dabAt = (S, bx, bz, sg, ca, sa, dist, m) => {
    let x = bx + sg * ca * dist, z = bz - sg * sa * dist; const rr = Math.hypot(x, z); if (rr > R - 2.2) { x *= (R - 2.2) / rr; z *= (R - 2.2) / rr; }
    const W = S.wash, dx = x - W.x, dz = z - W.z, dl = Math.hypot(dx, dz); if (dl < W.r + 1.8) { const k = (W.r + 1.8) / (dl || 1); x = W.x + (dl ? dx : 1) * k; z = W.z + dz * k; } // never in the dish
    return { x, z, r: 1.6, m };
  };
  // Before each finale Critique: if the walk takes longer than the cast allows (less 0.75 s), he helps, free for the player: the dish
  // moves toward you (for a clean call, into the wanted half; the rim point nearest you, nearer in if need be) and/or a fat drop of
  // exactly the missing paint falls next to where you will be, toward the half. The first fix that fits wins, in that order of
  // preference (no move, nearest dish). If none fits (the far rim of the wrong half on a mud call, or a signature call after you
  // lost the paint), the cast is stretched by the shortfall (S.stretch); S.routeFail counts a call with no answer at all (never).
  function repair(b, call, T, p) {
    const S = b.state, wr = pw(S, p).wear, lim = T - 0.75, tLand = G.ft + T, nd = wantWear(call), sg = wantSide(call);
    const A = S.lineA + S.lineW * T, ca = Math.cos(A), sa = Math.sin(A), px = p.pos.x, pz = p.pos.z;
    const r0 = route(S, px, pz, wr, call, tLand); let r = r0;
    const fixes = [];
    if (r0 > lim) {
      const save = S.wash, washes = [null]; let best = null;
      if (wr & ~nd) { const ap = Math.atan2(px, pz); for (const rad of [16.2, 13, 10, 7]) for (let i = 0; i <= 18; i++) for (const sgn of i ? [1, -1] : [1]) { const a = ap + sgn * i * 0.17, wx = Math.sin(a) * rad, wz = Math.cos(a) * rad; if (nd === 0 && sg * (wx * ca - wz * sa) < 2.2) continue; washes.push({ x: wx, z: wz, r: 2.5 }); } }
      for (const W of washes) {
        if (W) S.wash = W;
        const o = {}; let rw = W ? route(S, px, pz, wr, call, tLand, o) : (route(S, px, pz, wr, call, tLand, o), r0), dab = null;
        const m = nd & ~((wr & ~nd) ? 0 : wr);
        if (rw > lim && m) for (const dist of [2.6, 1.2, 4]) { const Dd = dabAt(S, o.px, o.pz, sg, ca, sa, dist, m), r2 = route(S, px, pz, wr, call, tLand, { dab: Dd }); if (r2 < rw) { rw = r2; dab = Dd; } if (rw <= lim) break; }
        S.wash = save;
        if (!best || rw < best.r) best = { W, dab, r: rw };
        if (rw <= lim) break;
      }
      if (best.W) { S.wash = best.W; S.washK = 0; S.washT = 0; fixes.push('wash'); if (!G.headless) FX.ring(S.wash.x, S.wash.z, { r0: 0.5, r1: 3.5, color: 0x9fd8f0, dur: 0.5 }); Sound.sfx('heal', 0.4, 0.8); }
      if (best.dab) { const q = best.dab; lay(S, { t: 'c', x: q.x, z: q.z, r: q.r, m: q.m }); fixes.push('paint'); Sound.sfx('wave', 0.6, 1.6);
        if (!G.headless) { FX.burst(q.x, 4, q.z, { n: 26, color: HEX[q.m], color2: 0xffffff, speed: [1, 4], life: [0.3, 0.7], size: [0.15, 0.35], grav: 20 }); FX.ring(q.x, q.z, { r0: 0.4, r1: 2.4, color: HEX[q.m], dur: 0.45 }); } }
      r = best.dab || best.W ? route(S, px, pz, wr, call, tLand) : r0;
    }
    let ext = 0; if (r > lim) { if (r === Infinity) { ext = 2; S.routeFail++; } else { ext = r - lim; S.stretch = (S.stretch || 0) + 1; } fixes.push('time'); }
    S.critLog.push({ call: call.tone + call.col, wear: wr, sig: S.sig, r0: r0 === Infinity ? 99 : +r0.toFixed(2), r: r === Infinity ? 99 : +r.toFixed(2), T, fix: fixes.join('+'), stretch: +ext.toFixed(2), fail: r === Infinity });
    return ext;
  }
  function* judge(b, call, T, o) {
    const S = b.state; let ext = 0; // every standing player gets the route check; the cast stretches for the slowest
    for (const p of livePlayers()) ext = Math.max(ext, repair(b, call, T, p));
    S.holdWash = G.ft + T + ext + 0.5;
    S.faceSide = true; yield* critique(b, T + ext, o); S.faceSide = false;
  }
  // Chiaroscuro ramps by sitting count, two sittings per step (a sitting is about 20 s with its stagger, so a step is about 40 s):
  //   0: Splatter only            1: one Blot and Drips          2: a Blot, and the Roller (odd sittings) or the Knife (even)
  //   3: as 2, the seam turns faster (one turn in 40 s -> 28 s)  4: as 3, Critiques in pairs (same half, new colour)
  // Past step 4 nothing more is added; the enrage is the remaining pressure.
  const SEAM_W = [TAU / 40, TAU / 28], SIT_PER_STEP = 2;
  const finStepOf = (S) => Math.min(4, Math.floor(S.fk / SIT_PER_STEP));
  // the second call of a pair: the same tone (same half), another colour, never one you already answer where you stand
  function pairCall(b, call) {
    const S = b.state, list = shuffle([1, 2, 3, 4, 5, 6].filter((c) => c !== call.col)).map((col) => ({ tone: call.tone, col }));
    return list.find((q) => !answers(S, q)) || list[0];
  }
  // one sitting: Fresh Coat with the call, three strokes (what the answer needs first), the step's pressure, the route check, Critique
  function* sitting(b, call, T, k) {
    const S = b.state, nd = wantWear(call), nb = bitsOf(nd), others = [RED, YEL, BLU].filter((m) => nb.indexOf(m) < 0), st = S.nm ? finStepOf(S) : 0;
    if (S.nm && S.stepAt[st] === undefined) S.stepAt[st] = Math.round(G.ft * 10) / 10;
    S.finStep = st;
    // step 3 on: the seam speeds up, eased over 1.5 s during the Fresh Coat, so it is steady again before the route check projects it
    const wT = SEAM_W[st >= 3 ? 1 : 0];
    if (S.lineW !== wT) { const w0 = S.lineW; Co.start(function* () { let t = 0; while (t < 1.5) { t += G.dt; S.lineW = lerp(w0, wT, smooth(Math.min(1, t / 1.5))); yield; } S.lineW = wT; }, 'phase'); }
    yield* freshCoat(b, call); S.faceSide = false;
    yield* strokes(b, shuffle(nb.concat(others).slice(0, 3)));
    const bl = () => blot(b, pick(others.length ? others : nb));
    if (st === 0) yield* splatter(b, 3);
    else if (st === 1) { bl(); yield* drips(b, 4); }
    else { bl(); if (k % 2 === 1) yield* roller(b); else yield* knife(b); }
    if (st < 4) { yield* judge(b, call, T); return; }
    // step 4: a pair. The first verdict does not knock him down; a quick coat, two strokes, and the second Critique at 4.0 s.
    yield* judge(b, call, T, { stagger: false });
    const c2 = pairCall(b, call), n2 = bitsOf(wantWear(c2)), o2 = [RED, YEL, BLU].filter((m) => n2.indexOf(m) < 0);
    yield 0.4; yield* freshCoat(b, c2, true); S.faceSide = false;
    yield* strokes(b, shuffle(n2.concat(o2)).slice(0, 2));
    yield* judge(b, c2, 4.0);
  }
  // the signature, once, under 10%: three fast Critiques with the same answer paint (the one you wear, if it is a colour), the half
  // flipping each time. What he shows changes completely (white + red, black + green, white + red); what you do is keep your red and step.
  function* signature(b) {
    const S = b.state, p = b.focusPlayer(), wr = pw(S, p).wear, N = wr >= 1 && wr <= 6 ? wr : pick([1, 2, 4, 3, 5, 6]);
    const w0 = !p || sideOf(S, p.pos.x, p.pos.z) >= 0, cw = { tone: 'w', col: N }, cb = { tone: 'b', col: 7 ^ N }, seq = w0 ? [cw, cb, cw] : [cb, cw, cb];
    yield* freshCoat(b, seq[0]); S.faceSide = false;
    const nb = bitsOf(N); yield* strokes(b, shuffle(nb.concat([RED, YEL, BLU].filter((m) => nb.indexOf(m) < 0)).slice(0, 3)));
    yield 3; S.sig = 1;
    for (let i = 0; i < 3; i++) {
      if (i) yield* freshCoat(b, seq[i], true);
      yield* judge(b, seq[i], 2.6, { stagger: i === 2 }); S.sig = i + 2;
      if (i < 2) yield 0.5;
    }
    S.sig = 0;
  }
  function* finRun(b) {
    const S = b.state;
    while (true) {
      if (!S.sigDone && b.hp <= b.maxHp * 0.1) { S.sigDone = true; yield* signature(b); continue; }
      const call = nextCall(b); yield* sitting(b, call, S.fk === 0 ? 6.0 : 4.5, S.fk); S.fk++;
    }
  }
  // Chiaroscuro: he walks to the centre, the camera rises over the rim, and he drags the palette knife once across the whole canvas.
  // White flash: the world tears along the cut, one half snaps back to white, the other stays black, and the line starts to turn.
  function* finEnter(b) {
    const S = b.state; resetMech(b); Object.assign(S, { call: null, fk: 0, tones: [], cbag: [], used: null, sigDone: false, stepAt: [], finStep: 0, lineW: SEAM_W[0] }); Music.intensity(0);
    yield* b.moveTo(0, 0, 7);
    const p = b.focusPlayer(), a = (p ? Math.atan2(p.pos.x, p.pos.z) : 0) + PI / 2, fx = Math.sin(a), fz = Math.cos(a);
    S.cine = true; Co.start(Cam.shot([-fx * 25, 15, -fz * 25], [fx * 6, 0, fz * 6], [-fx * 22 + fz * 4, 20, -fz * 22 - fx * 4], [fx * 2, 0, fz * 2], 3.6, 50), 'phase');
    b.facing = a; S.lineA = a;
    yield* b.cast({ name: 'Chiaroscuro', time: 2.2, onTick: (k) => { FX.shake(k * 0.15); } });
    S.swing = 1; Sound.sfx('sword', 0.9, 0.5); Sound.sfx('wave', 0.8, 0.6); S.seamOn = true; S.seamW = 1;
    lay(S, { t: 'r', x: -fx * 22, z: -fz * 22, dir: a, len: 44, w: 2.4, m: 0 });
    let t = 0; while (t < 0.7) { t += G.dt; S.seamP = smooth(Math.min(1, t / 0.7)); if (!G.headless && vrand() < 0.7) { const q = -R + 2 * R * S.seamP; FX.burst(fx * q, 0.1, fz * q, { n: 2, color: 0xffffff, color2: 0xd9d2c2, speed: [1, 4], up: 1.5, life: [0.2, 0.5], size: [0.1, 0.2] }); } yield; }
    S.seamP = 1;
    FX.flash(0xffffff, 0.75, 1.4); Sound.sfx('shatter', 1, 0.5); Sound.sfx('bigboom', 0.8); FX.shake(0.5);
    S.neg = false; S.split = 1; S.look = S.lookT = FIN_LOOK; S.fin = 1; moveWash(S); S.washT = 0;
    Co.start(Post.lerpTo({ bloom: 0.28, threshold: 0.92, contrast: 1.08, exposure: 0.95, tint: [1.0, 1.0, 1.0], sat: 1.1 }, 1.0), 'fight');
    yield 0.5; Sound.sfx('bell', 0.7, 0.5); yield 0.6; S.cine = false; Cam.release();
  }
  // Out of time (the last blow, 24 s into the enrage, in whatever phase): the music stops, and he varnishes the unfinished work: amber varnish floods the canvas from
  // the rim inward as a closing ring, sealing the paint (and you) under it. He can still be killed while it closes.
  function* varnishOver(b) {
    const S = b.state; resetMech(b); Music.stop(0.1); Sound.sfx('wave', 0.9, 0.35); FX.flash(VARN, 0.25, 1.5);
    const T = 6;
    Hz.circle(0, 0, 80, T, 0, { blockable: false, name: 'Varnish', color: VARN, quiet: true, alpha: 0.35, onFire: () => {
      FX.flash(VARN, 0.6, 2); Sound.sfx('bigboom', 0.8); for (const p of livePlayers()) p.hurt(9999, { blockable: false, src: 'enrage', pierce: true });
    } });
    let t = 0; while (t < T) { t += G.dt; S.varnR = (R + 0.6) * (1 - smooth(Math.min(1, t / T))); yield; }
    S.varnR = 0; yield 0.5; while (true) yield 1;
  }
  G.bosses.push({
    id: 'atelier', name: 'PENTIMENTO', title: 'The Unfinished Canvas', hint: 'Wet paint', color: '#f0e8d8', telegraph: INK,
    hp: 31000, radius: 1.5, aimY: 3.6, enrage: 450,
    build,
    // the nightmare finale's wrong-half cut is per player: each player's hits use their own side (set in update, one tick old as before)
    takenMul: (b, by) => { const w = by && b.state.pw && b.state.pw[by.id]; return w ? w.mul : 1; },
    *intro(b) { Sound.sfx('wave', 0.7, 0.5); yield* Cam.shot([-14, 22, 26], [0, 2, 0], [4, 4.5, 8], [0, 3.8, -3], 5.2, 46); },
    phases: [
      { at: 1, *run(b) {
        const S = b.state; setLvl(b, 0); yield 1.0; let k = 0; const seq = shuffle([RED, YEL, BLU]).concat(shuffle([3, 5, 6]));
        while (true) { yield* block(b, seq[k % seq.length], k); k++; }
      } },
      { at: 0.66, skipTo(b) { b.state.look = 1; }, *enter(b) {
        const S = b.state; setLvl(b, 0); S.lookT = 1;
        yield* b.cast({ name: 'Colour', time: 3.0, onTick: (k) => { FX.shake(k * 0.2); } });
        Sound.sfx('wave', 1, 0.4); Sound.sfx('roar', 0.4, 1.5); FX.flash(0xffb060, 0.3, 1.5); Co.start(Post.lerpTo({ tint: [1.02, 1.0, 0.98], sat: 1.12 }, 3), 'fight'); yield 1.0;
      }, run: colourRun },
      { at: 0.33, skipTo(b) { b.state.look = 2; }, enter: negEnter, run: negRun },
    ],
    // ---- Nightmare ("Chiaroscuro"). Opens in colour (the normal phase 2), then the Negative, then the split canvas, which is two
    // thirds of the fight and ramps every two sittings. One creeping enrage (40 + 4 per second over) and the varnish 24 s into it.
    // Threshold's kill cinematic (paintingDeath) is view-only and stays with the client.
    nightmare: {
      hp: NM_HP, enrage: 360, enrageBase: 40, enrageGrow: 4,
      lastBlow: varnishOver,
      phases: [
        { at: 1, music: 1, *run(b) { resetMech(b); yield 0.6; yield* colourRun(b); } },
        { at: 0.85, music: 2, skipTo(b) { b.state.look = 2; View.cue('post.set', NEG_POST); }, *enter(b) { resetMech(b); yield* negEnter(b); }, run: negRun },
        { at: 0.68, music: 3, skipTo(b) { setLvl(b, 2); b.state.look = 2; }, enter: finEnter, run: finRun },
      ],
    },
    nmTest: { wantWear, wantSide, sideAt, route: (S, ...a) => route(S, ...a), SEAM_W, SIT_PER_STEP, stepOf: finStepOf },
    update(b, dt) {
      const S = b.state, fight = G.state === 'fight';
      if (S.down > 0) S.down -= dt; S.washT = (S.washT || 0) + dt; if (S.washT > 18 && !(S.split && S.holdWash > G.ft)) { S.washT = 0; moveWash(S); } // finale: the dish holds still while a Critique it answers is cast
      if (fight) for (const p of G.players) {
        if (!p.alive) continue; const w = pw(S, p);
        const inWash = Math.hypot(p.pos.x - S.wash.x, p.pos.z - S.wash.z) < S.wash.r;
        if (inWash) { if (w.wear) { w.wear = 0; w.wearK = 1; Sound.sfx('heal', 0.5, 1.6); } }
        else if (p.grounded && p.pos.y < 0.15) { const m = wetAt(S, p.pos.x, p.pos.z); if (m) tint(S, p, m); }
        p.speedMul = w.wear === 7 ? 0.8 : 1; if (matched(S, p)) w.match += dt; b.dmgTaken = DMG_BASE; w.mul = offSide(S, p.pos.x, p.pos.z) ? WRONG_SIDE : 1; // read by takenMul for this player's hits
      }
      if (S.split) { // the finale: the seam turns; he holds the pivot, facing the half he calls while he paints or judges, else you
        if (G.state === 'fight') S.lineA += S.lineW * dt;
        if (b.alive && G.players.length) { const c = S.call, sg = c ? wantSide(c) : 1; b.facing = dampAng(b.facing, S.faceSide && c ? Math.atan2(sg * Math.cos(S.lineA), -sg * Math.sin(S.lineA)) : b.angToPlayer(), 6, dt); }
      }
      S.dryT -= dt; if (S.dryT <= 0) { S.dryT = 0.5; for (const L of [S.strokes, S.baked]) for (const sh of L) if (!sh.dry && sh.m && G.ft - sh.t0 > WET) sh.dry = true; }
      // animation timers the view reads (no rule reads them)
      S.swing = Math.max(0, S.swing - dt * 2.4); for (const k in S.pw) S.pw[k].wearK = Math.max(0, S.pw[k].wearK - dt * 2);
      // channel 2: what the view half needs, as plain data
      const P = b.pub, q = S.roll;
      const p0 = G.players[0], w0 = p0 ? pw(S, p0) : { wear: 0, wearK: 0 };
      P.pw = {}; for (const p of G.players) { const w = pw(S, p); P.pw[p.id] = { wear: w.wear, wearK: w.wearK, shell: !!S.nm && offSide(S, p.pos.x, p.pos.z) && S.down <= 0 }; }
      P.need = need(S); P.lvl = S.lvl; P.neg = S.neg; P.col = S.col; P.wear = w0.wear; P.wearK = w0.wearK; P.wash = S.wash; P.down = S.down; P.crit = S.crit; P.flood = S.flood; P.swing = S.swing; P.look = S.lookT;
      P.roll = q ? { a: q.a, cx: q.cx, cz: q.cz, s: q.s, m: q.m } : null; P.strokes = S.strokes.length + S.baked.length;
      if (S.nm) { P.split = S.split; P.lineA = S.lineA; P.call = S.call; P.seamOn = S.seamOn; P.seamP = S.seamP; P.seamW = S.seamW; P.varnR = S.varnR; P.top = S.top; P.sig = S.sig; P.step = S.finStep; P.shell = !!p0 && offSide(S, p0.pos.x, p0.pos.z) && S.down <= 0; }
    },
    danger(b, x, z) {
      const S = b.state, q = S.roll; if (!q) return Infinity; const dx = x - q.cx, dz = z - q.cz, al = dx * q.fx + dz * q.fz, sd = dx * q.fz - dz * q.fx;
      if (Math.abs(sd) > 6.4 || al < q.s - 1) return Infinity; return Math.max(0.05, (al - q.s - 1) / q.v + (q.s < -22 ? 0.4 : 0));
    },
    // The autopilot hint. Two changes from Threshold so a bot fight replays without the bot: it asks for a jump (out.jump, which
    // Bot turns into an input) instead of calling p.jump(), and its scan memory lives in b.botMem instead of the boss state.
    bot(b, p) {
      const S = b.state, M = p.botMem || (p.botMem = { scanT: 0, goal: null }), wr = pw(S, p).wear, out = {}, nd = need(S), miss = nd & ~wr, extra = wr & ~nd, q = S.roll;
      if (q) { const dx = p.pos.x - q.cx, dz = p.pos.z - q.cz, al = dx * q.fx + dz * q.fz, sd = dx * q.fz - dz * q.fx, tt = (al - q.s - 1) / q.v; if (Math.abs(sd) < 6.3 && tt > 0 && tt < 0.2) out.jump = true; }
      const bad = (x, z) => { const m = wetAt(S, x, z); return !!m && (m & ~nd) !== 0 && !(Math.hypot(x - S.wash.x, z - S.wash.z) < S.wash.r); };
      // hop over paint you must not touch
      if (p.grounded && p.moving && !bad(p.pos.x, p.pos.z)) { const l = Math.hypot(p.intentX, p.intentZ) || 1; if (bad(p.pos.x + p.intentX / l * 1.1, p.pos.z + p.intentZ / l * 1.1)) out.jump = true; }
      out.avoid = bad; if (S.blotList.length) out.target = S.blotList.reduce((a, e) => Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) ? e : a);
      if (S.split && Bot.lazy) return out; // test switch (Threshold's tools/critfuzz.js): never washes or fetches paint
      // finale: with the right paint, hold a spot inside the called half at fighting range, aimed where the seam will be in a second
      if (S.split && S.call && !extra && !miss && !Bot.sideBlind) { const sg = wantSide(S.call), A = S.lineA + S.lineW, rr = p.cls.melee ? b.radius + 2.4 : 8; out.x = sg * Math.cos(A) * rr; out.z = -sg * Math.sin(A) * rr; out.w = 4; M.goal = null; return out; }
      if (extra) { out.x = S.wash.x * 0.97; out.z = S.wash.z * 0.97; out.w = 4; return out; }
      if (miss) {
        M.scanT -= G.dt; if (M.scanT <= 0 || !M.goal) { M.scanT = 0.3; let best = null, bd = Infinity; for (let j = 0; j < GN; j += 1) for (let i = 0; i < GN; i += 1) { const k = j * GN + i, m = S.dryAt[k] > G.ft + 0.5 ? S.pig[k] : 0; if (!m || (m & ~nd) || !(m & miss)) continue; const x = (i + 0.5) * CELL - R, z = (j + 0.5) * CELL - R, d = Math.hypot(x - p.pos.x, z - p.pos.z) + (S.split && S.call && sideOf(S, x, z) !== wantSide(S.call) ? 8 : 0); if (Math.hypot(x - S.wash.x, z - S.wash.z) < S.wash.r + 0.4) continue; if (d < bd) { bd = d; best = { x, z }; } } M.goal = best; }
        if (M.goal) { out.x = M.goal.x; out.z = M.goal.z; out.w = 4; }
      } else M.goal = null;
      return out;
    },
  });
})();
