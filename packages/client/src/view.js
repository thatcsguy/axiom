// The 3D view: draws one blended moment of the fight from snapshots, pub and cues. It never runs rules.
//
// The look is Threshold's own, imported unchanged into look.js (tools/import-look.js): the renderer, the post chain (NaN
// sanitize, bloom, colour grade, flash, chromatic pulse, grain, vignette), the FX library every cue lands in, the camera rig
// (orbit, zoom limits, shake, cinematic blend, keep-out-of-the-boss, occluder fade), the procedural world helpers, the
// telegraph decal and bullet shaders, the warm-up that compiles every shader before a fight, and the freeze log.
// Heroes are Threshold's models (heroes.js). What is Axiom's own: turning snapshots into hazards, bullets, heroes and
// bodies, routing cues (with the screen-only ones kept for the player they belong to), and the Training Dummy's ring.
// Pentimento's arena, paint and body are still simple stand-ins here (the next step ports Threshold's studio).
import {
  THREE, G, Input, Game, Hz as HzHook, Co, FX, Cam, W, Post, Warm, Hitch, scene, camera, renderer,
  HZ_VERT, HZ_FRAG, BUL_V, BUL_F, frame as lookFrame, hitstop as lookHitstop,
} from './look.js';
import { buildHero, HeroClock } from './heroes.js';

const TAU = Math.PI * 2, PI = Math.PI, V3 = THREE.Vector3;
const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a, b) => v < a ? a : v > b ? b : v, sat = (v) => clamp(v, 0, 1);
const smooth = (t) => { t = sat(t); return t * t * (3 - 2 * t); };
const lerpAng = (a, b, t) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return a + d * t; };
export const PIG = [0xffffff, 0xe23a2e, 0xf2c218, 0xf08a1e, 0x2a5fe0, 0x8a3cd0, 0x2aa858, 0x5c4332];
export const PIG_NAME = ['clean', 'red', 'yellow', 'orange', 'blue', 'purple', 'green', 'mud'];
const css = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const R_PAINT = 20, CANVAS_N = 1024;

// Per-encounter grade (Threshold's def.post) and camera. Pentimento's are Threshold's numbers (38_boss_atelier.js POST).
const ATELIER_POST = { bloom: 0.22, threshold: 0.97, radius: 0.6, exposure: 0.92, vig: 0.7, sat: 1.08, contrast: 1.04, tint: [1.0, 1.0, 1.0] };
const LOOKS = {
  dummy: { post: { bloom: 0.5, threshold: 0.86, radius: 0.55, exposure: 1.12, sat: 1.06, vig: 0.85, contrast: 1.05, tint: [1.02, 1.0, 0.97] }, aimY: 1.8 },
  atelier: { post: ATELIER_POST, nmPost: Object.assign({}, ATELIER_POST, { tint: [1.02, 1.0, 0.98], sat: 1.12 }), aimY: 3.6 },
};
// cues that only make sense on one player's screen: shown only when that player is you (or when no player raised them)
const OWN = { 'fx.shake': 1, 'fx.flash': 1, 'fx.kick': 1, 'fx.num': 3, hitstop: 2, 'ui.hurtFlash': 1, 'ui.slotFlash': 1 };

export class View {
  constructor(canvas, catalog) {
    this.catalog = catalog; this.canvas = canvas;
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.cam = Cam;
    this.world = null; this.heroes = new Map(); this.ents = new Map(); this.arenaId = null; this.spares = [];
    this.decals = new Decals(); this.hz = this.decals.live; this.bullets = new Bullets();
    HzHook.warm = () => this.decals.warm();
    // the target ring (Threshold's player.ring): your target, in your class colour, turning slowly
    this.tring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.tring.rotation.x = -PI / 2; this.tring.renderOrder = 11; this.tring.visible = false; scene.add(this.tring);
    this.me = { pos: new V3(), facing: 0, alive: true }; this.bossF = { pos: new V3(), radius: 1, alive: true, group: null, def: { aimY: 2.5 }, phase: 0 };
    this.shot = null; this.slowK = 1; this.slowT = 0; this.needWarm = false; this.warmMs = 0;
    this.onUi = null; // game.js: (name, args) for the HUD cues (hurt flash)
    // every shader compiled after the warm-up (the freeze log notices them): the warm-up's job is to keep this empty
    this.compiled = []; Hitch.tap = (m) => { if (/^COMPILED/.test(m) && this.compiled.length < 50) this.compiled.push(m.slice(9)); };
  }

  // ---------------- arenas
  setArena(s) {
    const id = s.boss.id; if (this.arenaId === id && this.arenaR === s.arena.radius && this.arenaNm === !!s.nm) return;
    this.arenaId = id; this.arenaR = s.arena.radius; this.arenaNm = !!s.nm;
    FX.clear(); Co.stopTag('look'); Cam.cine = null; Cam.cineW = 0; this.shot = null;
    if (this.world) { scene.remove(this.world); disposeWorld(this.world); }
    for (const [, e] of this.ents) scene.remove(e.g); this.ents.clear();
    this.decals.clear(); this.bullets.clear();
    this.world = new THREE.Group(); this.world.name = 'arena'; scene.add(this.world);
    scene.fog = null; scene.environment = null; scene.background = new THREE.Color(0x05060a);
    this.paint = null; this.dish = this.half = this.roller = null; const R = s.arena.radius;
    if (id === 'atelier') this.buildAtelier(R); else this.buildRing(R);
    const L = LOOKS[id] || LOOKS.dummy; Post.set((s.nm && L.nmPost) || L.post || {}); Cam.minDist = 4; Cam.maxDist = 26;
    this.lookDef = L; Game.def = { id };
    // one hidden model of every class stays in the scene: the warm-up compiles its shaders and lights, and it keeps them
    // alive, so a player who joins or changes class mid-fight never compiles a shader
    if (!this.spares.length) for (const c of this.catalog.classes) { const m = buildHero(c); m.group.visible = false; m.group.position.set(0, -50, 0); scene.add(m.group); this.spares.push(m); }
    this.needWarm = true;
  }
  // The Training Dummy's ring: a stone yard at dusk, braziers, embers on the wind. Built from Threshold's world helpers.
  buildRing(R) {
    const g = this.world;
    const sky = W.sky({ top: 0x14203e, horizon: 0x8a5a58, bottom: 0x07080c, sunDir: [-0.9, 0.07, -0.42], sunColor: 0xffa060, sunSize: 0.05, sunGlow: 1.3, clouds: 0.5, cloudColor: 0xb48478, cloudDark: 0x221a2a, cloudScale: 1.3, stars: 0.5, exp: 0.55 });
    g.add(sky); W.env(sky, 0.55);
    scene.fog = new THREE.FogExp2(0x2a2230, 0.012);
    W.hemi(g, 0x9aa8d0, 0x4a3828, 1.45);
    W.sun(g, { color: 0xffd2a8, intensity: 3.0, dir: [-0.55, 0.8, 0.3], size: R + 6 });
    const slabs = W.surface('stone', { size: 512, seed: 7, n: 5, dark: 0x5e574c, light: 0xbcb2a2, repeat: Math.max(2, Math.round(R / 4)), strength: 3 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 0.8, 96), W.mat(Object.assign({ roughness: 1, metalness: 0 }, slabs))); floor.rotation.x = -PI / 2; floor.receiveShadow = true; g.add(floor);
    const rock = W.surface('rock', { size: 256, seed: 3, dark: 0x1c1a1c, light: 0x4a4440, repeat: 10, strength: 2.4 });
    const outer = new THREE.Mesh(new THREE.RingGeometry(R + 0.8, R + 70, 96, 2), W.mat(Object.assign({ roughness: 1 }, rock))); outer.rotation.x = -PI / 2; outer.position.y = -0.03; outer.receiveShadow = true; g.add(outer);
    // a chalk ring around the dummy and a worn path of darker slabs
    const chalk = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.75, 96), new THREE.MeshBasicMaterial({ color: 0xd8cfc0, transparent: true, opacity: 0.16, depthWrite: false })); chalk.rotation.x = -PI / 2; chalk.position.y = 0.02; g.add(chalk);
    // the low wall: dressed stone blocks with a little irregularity
    const stone = W.surface('stone', { size: 256, seed: 11, n: 5, dark: 0x4a4440, light: 0x9c9284, repeat: 1, strength: 2.6 });
    const bm = W.mat(Object.assign({ roughness: 0.95 }, stone)), blocks = 64;
    const bg = new THREE.BoxGeometry(1, 1, 1), wall = new THREE.InstancedMesh(bg, bm, blocks), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
    for (let i = 0; i < blocks; i++) { const a = (i + 0.5) / blocks * TAU, h = 0.55 + W.hash2(i, 3, 9) * 0.25, r = R + 1.3; P.set(Math.sin(a) * r, h / 2, Math.cos(a) * r); Q.setFromAxisAngle(new V3(0, 1, 0), a + (W.hash2(i, 5, 9) - 0.5) * 0.06); S.set(TAU * r / blocks * 0.96, h, 0.8); M.compose(P, Q, S); wall.setMatrixAt(i, M); }
    wall.castShadow = wall.receiveShadow = true; g.add(wall);
    // braziers on stone pillars: fire, a warm light, embers
    const pil = W.mat(Object.assign({ roughness: 0.9 }, W.surface('stone', { size: 128, seed: 21, n: 3, dark: 0x3a3430, light: 0x8a8070, repeat: 1 })));
    const iron = W.mat({ color: 0x2a2624, roughness: 0.5, metalness: 0.8 }), fire = W.glow(0xffa040, 3.2), core = W.glow(0xfff0c0, 4);
    const N = 6;
    for (let i = 0; i < N; i++) {
      const a = (i + 0.5) / N * TAU, x = Math.sin(a) * (R + 3.2), z = Math.cos(a) * (R + 3.2);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 3.4, 14), pil); p.position.set(x, 1.7, z); p.castShadow = p.receiveShadow = true; p.userData.fadeOcclude = true; p.userData.fadeCol = { r: 0.7, y0: -1.7, y1: 1.7 }; g.add(p);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 0.35, 14), pil); cap.position.set(x, 3.55, z); cap.castShadow = true; g.add(cap);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.3, 0.45, 16, 1, true), iron); bowl.position.set(x, 3.95, z); g.add(bowl);
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.1, 10, 1, true), fire); fl.position.set(x, 4.55, z); g.add(fl);
      const fc = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), core); fc.position.set(x, 4.25, z); g.add(fc);
      const L = new THREE.PointLight(0xff9a48, 34, 18, 1.6); L.position.set(x, 4.8, z); g.add(L);
      fl.onBeforeRender = () => { const t = G.now * 7 + i * 1.7; fl.scale.set(1 + Math.sin(t) * 0.08, 1 + Math.sin(t * 1.7) * 0.18, 1 + Math.cos(t * 1.3) * 0.08); L.intensity = 30 + Math.sin(t * 2.3) * 4 + Math.sin(t * 5.1) * 2; };
    }
    g.add(W.motes({ n: 260, box: [2 * R + 16, 12, 2 * R + 16], color: 0xff8a3a, size: 0.07, vel: [0.4, 0.7, 0.1], sway: 0.8, center: [0, 6, 0], mult: 2.2 }));
    g.add(W.motes({ n: 200, box: [2 * R + 30, 10, 2 * R + 30], color: 0xc8b8a8, size: 0.05, vel: [0.2, 0.05, 0.1], sway: 1.2, center: [0, 5, 0], alpha: 0.5 }));
  }
  buildAtelier(R) { // a pale canvas tondo in a dark studio; the floor keeps the paint (drawn from 'atelier.lay' cues). A stand-in.
    const g = this.world;
    scene.background = new THREE.Color(0x15130f); scene.fog = new THREE.Fog(0x15130f, 45, 140);
    W.hemi(g, 0xdfe6ff, 0x2a2420, 1.15);
    W.sun(g, { color: 0xfff2e0, intensity: 2.3, dir: [-0.45, 0.85, 0.35], size: R + 6 });
    const c = document.createElement('canvas'); c.width = c.height = CANVAS_N;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    this.paint = { c, x: c.getContext('2d'), tex, strokes: [], dirty: true, neg: false, t: 0 };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * R_PAINT, 2 * R_PAINT), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
    floor.rotation.x = -PI / 2; floor.receiveShadow = true; g.add(floor);
    const frame = new THREE.Mesh(new THREE.TorusGeometry(R + 0.25, 0.3, 10, 120), new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.45, metalness: 0.5 })); frame.rotation.x = PI / 2; frame.position.y = 0.12; frame.castShadow = true; g.add(frame);
    const boards = new THREE.Mesh(new THREE.RingGeometry(R + 0.5, R + 40, 96), new THREE.MeshStandardMaterial({ color: 0x3a2c20, roughness: 0.9 })); boards.rotation.x = -PI / 2; boards.position.y = -0.03; g.add(boards);
    for (let i = 0; i < 6; i++) { // easels with blank canvases around the room
      const a = i / 6 * TAU + 0.5, e = new THREE.Group(), wood = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.8 });
      for (const [x, rz] of [[-0.7, 0.12], [0.7, -0.12]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5, 0.12), wood); leg.position.set(x, 2.4, 0); leg.rotation.z = rz; e.add(leg); }
      const cv = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.2, 0.08), new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.9 })); cv.position.set(0, 3.2, 0.1); e.add(cv);
      e.position.set(Math.sin(a) * (R + 5), 0, Math.cos(a) * (R + 5)); e.rotation.y = a + PI; e.traverse((o) => { o.castShadow = true; }); g.add(e);
    }
    const dish = this.dish = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.12, 8, 48), new THREE.MeshStandardMaterial({ color: 0xc8d8e0, roughness: 0.2, metalness: 0.3 })); rim.rotation.x = PI / 2; rim.position.y = 0.1; dish.add(rim);
    const water = new THREE.Mesh(new THREE.CircleGeometry(2.45, 48), new THREE.MeshStandardMaterial({ color: 0x8fd0ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.8, emissive: 0x16384a })); water.rotation.x = -PI / 2; water.position.y = 0.06; dish.add(water);
    g.add(dish);
    const half = this.half = new THREE.Mesh(new THREE.CircleGeometry(R, 64, -PI, PI), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.62, depthWrite: false })); half.rotation.x = -PI / 2; half.position.y = 0.03; half.visible = false;
    const hg = this.halfG = new THREE.Group(); hg.add(half); g.add(hg);
    const roller = this.roller = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 12, 20), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })); roller.visible = false; roller.castShadow = true; g.add(roller);
  }
  lay(sh) { if (this.paint) { this.paint.strokes.push(sh); if (this.paint.strokes.length > 520) this.paint.strokes.shift(); this.paint.dirty = true; } }
  drawPaint(ft, neg) {
    const P = this.paint; if (!P) return;
    P.t -= 1; if (!P.dirty && P.t > 0 && P.neg === neg) return; P.dirty = false; P.t = 15; P.neg = neg; // repaint on new paint, and every 15 frames as paint dries
    const x = P.x, U = CANVAS_N / (2 * R_PAINT), N = CANVAS_N;
    x.fillStyle = neg ? '#1b1a20' : '#2b241c'; x.fillRect(0, 0, N, N);
    x.save(); x.beginPath(); x.arc(N / 2, N / 2, (R_PAINT - 0.25) * U, 0, TAU); x.clip();
    x.fillStyle = neg ? '#141419' : '#ebe4d4'; x.fillRect(0, 0, N, N);
    x.globalAlpha = neg ? 0.05 : 0.08; x.strokeStyle = neg ? '#fff' : '#6a5e4c'; x.lineWidth = 1; x.beginPath(); for (let i = 0; i < N; i += 6) { x.moveTo(i, 0); x.lineTo(i, N); x.moveTo(0, i); x.lineTo(N, i); } x.stroke(); x.globalAlpha = 1;
    for (const sh of P.strokes) {
      const wet = sh.m && ft - sh.t0 < 20, col = sh.m ? PIG[sh.m] : (neg ? 0x141419 : 0xebe4d4);
      x.fillStyle = css(col); x.globalAlpha = sh.m ? (wet ? 0.95 : 0.42) : 1;
      if (sh.t === 'c') { x.beginPath(); x.arc((sh.x + R_PAINT) * U, (sh.z + R_PAINT) * U, sh.r * U, 0, TAU); x.fill(); }
      else { x.save(); x.translate((sh.x + R_PAINT) * U, (sh.z + R_PAINT) * U); x.rotate(Math.atan2(Math.cos(sh.dir), Math.sin(sh.dir))); x.fillRect(0, -sh.w / 2 * U, sh.len * U, sh.w * U); x.restore(); }
      if (wet) { x.globalAlpha = 0.25; x.strokeStyle = '#ffffff'; x.lineWidth = 2; if (sh.t === 'c') { x.beginPath(); x.arc((sh.x + R_PAINT) * U - sh.r * U * 0.3, (sh.z + R_PAINT) * U - sh.r * U * 0.3, sh.r * U * 0.45, PI, PI * 1.5); x.stroke(); } }
    }
    x.restore(); x.globalAlpha = 1; P.tex.needsUpdate = true;
  }

  // ---------------- bodies
  heroFor(p) {
    let h = this.heroes.get(p.id);
    if (h && h.cls !== p.cls) { scene.remove(h.g); disposeWorld(h.g); h = null; }
    if (!h) {
      const cls = this.catalog.classes.find((c) => c.id === p.cls) || { id: p.cls, look: { armor: 0x555566, cloth: 0x333344, glow: 0xffffff } };
      const m = buildHero(cls), g = new THREE.Group(); g.add(m.group);
      // the paint you wear (Pentimento) shows as a ring at your feet
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.78, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); ring.rotation.x = -PI / 2; ring.position.y = 0.04; ring.visible = false; g.add(ring);
      h = { g, m, cls: p.cls, color: cls.color, ring, x: p.x, z: p.z, y: p.y, f: p.facing, deathT: 0 }; this.heroes.set(p.id, h); scene.add(g);
    }
    return h;
  }
  entFor(e, bossId) {
    let o = this.ents.get(e.id); if (o) return o;
    const g = new THREE.Group(); o = { g, boss: e.boss };
    if (e.boss && bossId === 'atelier') Object.assign(o, layFigure(g));
    else if (e.boss && bossId === 'dummy') Object.assign(o, dummyModel(g));
    else if (e.boss) { const m = new THREE.Mesh(new THREE.CapsuleGeometry(e.radius * 0.7, e.radius * 2, 6, 12), new THREE.MeshStandardMaterial({ color: 0xbbbbbb })); m.position.y = e.radius * 1.7; g.add(m); }
    else { // an add (Pentimento's Blots): a glossy drop of paint
      const col = typeof e.color === 'number' ? e.color : 0xcc3344, m = new THREE.Mesh(new THREE.SphereGeometry(e.radius, 20, 14), new THREE.MeshStandardMaterial({ color: col, roughness: 0.15, metalness: 0.05, emissive: col, emissiveIntensity: 0.15 }));
      m.scale.y = 0.7; m.position.y = e.radius * 0.65; m.castShadow = true; g.add(m); o.blob = m;
    }
    g.traverse((q) => { if (q.isMesh) q.castShadow = true; });
    this.ents.set(e.id, o); scene.add(g); return o;
  }

  // ---------------- one frame
  // a, b, k: the blended snapshots; self: the same for your own character (less delay); you: your character's id (null: watching)
  draw(dt, a, b, k, self, you, input) {
    if (this.slowT > 0) { this.slowT -= dt; if (this.slowT <= 0) this.slowK = 1; }
    const dts = dt * this.slowK; HeroClock.now += dts;
    const s = b; this.setArena(s);
    const pub = s.boss.pub || {};
    G.state = s.state === 'intro' || s.state === 'fight' || s.state === 'win' || s.state === 'dead' ? s.state : 'fight'; G.ft = s.t; G.nightmare = !!s.nm;
    if (this.paint) this.drawPaint(s.t, !!pub.neg);
    if (s.boss.id === 'atelier') this.drawAtelierPub(pub, s);
    // players
    const seen = new Set(); let mine = null;
    for (const pb of s.players) {
      const useSelf = pb.id === you && self, A = useSelf ? self.a : a, B = useSelf ? self.b : b, K = useSelf ? self.k : k;
      const pa = A.players.find((q) => q.id === pb.id) || pb, p2 = B.players.find((q) => q.id === pb.id) || pb;
      const h = this.heroFor(p2); seen.add(pb.id); if (pb.id === you) mine = { h, p: p2 };
      h.x = lerp(pa.x, p2.x, K); h.y = lerp(pa.y, p2.y, K); h.z = lerp(pa.z, p2.z, K); h.f = lerpAng(pa.facing, p2.facing, K);
      h.g.position.set(h.x, h.y, h.z); h.m.group.rotation.y = h.f; h.g.updateMatrixWorld(true); // the weapon trail samples world positions this frame
      if (p2.alive) {
        if (h.deathT > 0) { h.deathT = 0; h.m.body.rotation.x = 0; h.m.body.position.y = 0; }
        const an = p2.anim || {}, stand = { moveSpeed: an.ms || 0, grounded: an.gr !== false, casting: p2.casting, parryT: an.parry ? 0.5 : 0, flashT: an.flash ? 0.1 : 0, rollT: an.roll || 0, aimT: an.aim ? 0.5 : 0, loadT: an.load ? 0.2 : 0, dash: an.dash ? {} : null,
          res: p2.res, resMax: p2.resMax, shield: p2.shield || 0, shieldMax: p2.shieldMax || 1, hasBuff: (id) => p2.buffs.some((q) => q.id === id && q.t > 0), pose: null, dead: false };
        try { h.m.update(dts, stand); } catch (e) { /* a model that wants more of the stand-in: keep drawing */ }
      } else { h.deathT += dts; const kk = Math.min(1, h.deathT / 0.7); h.m.body.rotation.x = -kk * 1.45; h.m.body.position.y = -kk * 0.1; } // Threshold's fall
      const w = pub.pw && pub.pw[pb.id] ? pub.pw[pb.id].wear : 0;
      h.ring.visible = !!w; if (w) { h.ring.material.opacity = 0.85; h.ring.material.color.setHex(PIG[w]); }
    }
    for (const [id, h] of this.heroes) if (!seen.has(id)) { scene.remove(h.g); disposeWorld(h.g); this.heroes.delete(id); }
    // hostile bodies
    const live = new Set(); let bossO = null;
    for (const eb of s.ents) {
      if (!eb.alive && !eb.boss) continue; live.add(eb.id);
      const ea = a.ents.find((q) => q.id === eb.id) || eb, o = this.entFor(eb, s.boss.id);
      o.g.position.set(lerp(ea.x, eb.x, k), lerp(ea.y, eb.y, k), lerp(ea.z, eb.z, k)); o.g.rotation.y = lerpAng(ea.facing, eb.facing, k);
      o.x = o.g.position.x; o.z = o.g.position.z; o.radius = eb.radius; o.aimY = eb.boss ? (this.lookDef.aimY || 1.8) : 0.8;
      if (eb.boss) bossO = o;
      if (o.update) o.update(dts, eb, pub, s);
      if (o.blob) o.blob.scale.set(1 + Math.sin(HeroClock.now * 7 + eb.id) * 0.06, 0.7 + Math.cos(HeroClock.now * 6 + eb.id) * 0.06, 1);
    }
    for (const [id, o] of this.ents) if (!live.has(id)) { scene.remove(o.g); disposeWorld(o.g); this.ents.delete(id); }
    // your target: Threshold's turning ring in your class colour
    const tgt = input && input.targetId !== null && input.targetId !== undefined ? this.ents.get(input.targetId) : null;
    this.tring.visible = !!(tgt && mine && mine.p.alive);
    if (this.tring.visible) { this.tring.material.color.set(mine.h.color || '#ffffff').multiplyScalar(1.1); this.tring.scale.setScalar((tgt.radius || 1) + 0.25); this.tring.position.set(tgt.x, 0.07, tgt.z); this.tring.rotation.z += dt * 0.6; }
    this.decals.sync(a, b, k, pub);
    this.bullets.sync(a, b, k);
    // what the camera follows (Threshold's Cam reads G.player, G.boss, G.arena)
    let focus = mine ? mine.h : null;
    if (!focus) { for (const [id, h] of this.heroes) { const p = s.players.find((q) => q.id === id); if (p && p.alive) { focus = h; break; } } }
    if (focus) { this.me.pos.set(focus.x, focus.y, focus.z); this.me.facing = focus.f; this.me.alive = true; G.player = this.me; }
    else G.player = null;
    if (bossO) { const F = this.bossF; F.pos.copy(bossO.g.position); F.radius = bossO.radius || 1; F.group = bossO.g; F.def.aimY = this.lookDef.aimY || 2.5; F.phase = s.boss.phase; G.boss = F; } else G.boss = null;
    G.arena = { floorY: 0 };
    if (input && !Cam.cine) { Input.lookX = -input.lookX; Input.lookY = input.lookY; Input.zoom = input.zoom; }
    if (input) input.lookX = input.lookY = input.zoom = 0;
    if (!focus && !mine) { Cam.tDist = 22; }
    // the cinematic shot (the sim's Cam.shot): flown here, blended in and out by Threshold's camera
    if (this.shot) {
      const c = this.shot; c.t += dt; const kk = smooth(c.t / c.dur);
      c.cine.pos.set(lerp(c.p0[0], c.p1[0], kk), lerp(c.p0[1], c.p1[1], kk), lerp(c.p0[2], c.p1[2], kk)); c.cine.look.set(lerp(c.l0[0], c.l1[0], kk), lerp(c.l0[1], c.l1[1], kk), lerp(c.l0[2], c.l1[2], kk));
      if (c.t > c.dur + 0.5 && !s.cine) { this.shot = null; Cam.cine = null; } // the release cue went missing: let go once the sim has
    }
    if (this.needWarm) { this.needWarm = false; const t0 = performance.now(); Warm.run(null); Hitch.reset(); this.warmMs = Math.round(performance.now() - t0); this.compiled = []; }
    lookFrame(dt);
    document.body.classList.toggle('cine', Cam.cineW > 0.5);
  }
  drawAtelierPub(pub, s) {
    if (this.dish && pub.wash) { this.dish.position.set(pub.wash.x, 0, pub.wash.z); this.dish.scale.setScalar(pub.wash.r / 2.5); }
    if (this.half) { this.half.visible = !!pub.split; if (pub.split) this.halfG.rotation.y = pub.lineA - PI / 2; } // the black half: x cos A - z sin A < 0
    const q = pub.roll; this.roller.visible = !!q && q.s > -22.5;
    if (q) { const fx = Math.sin(q.a), fz = Math.cos(q.a); this.roller.position.set(q.cx + fx * q.s, 0.7, q.cz + fz * q.s); this.roller.rotation.set(0, q.a, PI / 2); this.roller.material.color.setHex(PIG[q.m]); }
    scene.background.setHex(pub.neg ? 0x08080c : 0x15130f);
  }
  // camera control for tools: yaw relative to your hero's facing, pitch, distance
  setCam(o) { if (o.yaw !== undefined) Cam.yaw = this.me.facing + o.yaw; if (o.pitch !== undefined) Cam.pitch = o.pitch; if (o.dist !== undefined) Cam.tDist = Cam.dist = o.dist; }
  info() { return { programs: renderer.info.programs.length, warmMs: this.warmMs, compiledInFight: this.compiled.slice(), late: Hitch.count.late, errors: G.errors.slice(0, 3) }; }

  // ---------------- cues (one-shot effects)
  // actor: the player whose action raised it (null: the boss, the world). you: your character's id (null: watching).
  cue(name, args, actor, you) {
    const ow = OWN[name];
    if (ow !== undefined) { const who = args[ow] !== undefined && args[ow] !== null ? args[ow] : actor; if (who !== null && who !== undefined && who !== you) return; }
    if (name.startsWith('fx.')) return fxCue(name.slice(3), args);
    switch (name) {
      case 'atelier.lay': return this.lay(args[0]);
      case 'hero.swing': { const h = this.heroes.get(args[0]); if (h) h.m.swing(args[1], args[2]); return; }
      case 'hitstop': { const kk = args[0] === undefined ? 0.25 : args[0], d = args[1] === undefined ? 0.1 : args[1]; this.slowK = kk; this.slowT = d; lookHitstop(kk, d); return; }
      case 'post.lerpTo': Co.start(Post.lerpTo(args[0] || {}, args[1] === undefined ? 2 : args[1]), 'look'); return;
      case 'post.set': Object.assign(Post.cur, args[0] || {}); Post.apply(); return; // a phase skipped to: its grade at once
      case 'cam.shot': { const [p0, l0, p1, l1, dur = 3, fov = 48] = args; if (!p0 || !l0 || !p1 || !l1) return; this.shot = { p0, l0, p1, l1, dur, t: 0, cine: { pos: new V3(...p0), look: new V3(...l0), fov } }; Cam.cine = this.shot.cine; return; }
      case 'cam.release': this.shot = null; Cam.cine = null; return;
      case 'ui.hurtFlash': case 'ui.slotFlash': if (this.onUi) this.onUi(name, args); return;
    }
  }
  // screen position of a world point (for name plates and click targeting)
  project(x, y, z) { const v = new V3(x, y, z).project(camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, on: v.z < 1 }; }
}

// An fx.* cue arrives with Threshold's own arguments; positions come as [x, y, z] (the sim's Vec3 made plain). FX
// functions that take vectors get THREE.Vector3s back.
const VEC_ARGS = { lightning: [0, 1], beam: [0, 1], num: [0], missile: [0, 1] };
function fxCue(fn, args) {
  const f = FX[fn]; if (typeof f !== 'function') return;
  const va = VEC_ARGS[fn];
  if (va) { for (const i of va) { const q = args[i]; if (!Array.isArray(q) || q.length < 3 || !q.every(Number.isFinite)) return; } args = args.map((q, i) => va.includes(i) ? new V3(q[0], q[1], q[2]) : q); }
  if (fn === 'missile') return; // a missile carries a callback into the rules; none of the ported fights send one
  if (fn === 'beam' && args[2]) args[2] = Object.assign({}, args[2], { hold: Math.min(args[2].hold || 0, 2) });
  try { f(...args); } catch (e) { /* a malformed cue: skip it */ }
}

function disposeWorld(root) {
  root.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) { if (m.userData && m.userData.shared) continue; for (const key in m) { const v = m[key]; if (v && v.isTexture && !v.userData.shared) v.dispose(); } if (m.uniforms) for (const key in m.uniforms) { const v = m.uniforms[key].value; if (v && v.isTexture && !v.userData.shared) v.dispose(); } m.dispose(); }
  });
}

// ---------------- telegraphs: Threshold's decal shader (06_combat.js Hz), fed from snapshot hazards
class Decals {
  constructor() {
    this.live = new Map(); this.free = [];
    this.geo = new THREE.PlaneGeometry(2, 2); this.geo.rotateX(-PI / 2); this.geo.userData.shared = true;
  }
  getMesh() {
    let m = this.free.pop();
    if (!m) {
      m = new THREE.Mesh(this.geo, new THREE.ShaderMaterial({
        uniforms: { uType: { value: 0 }, uR1: { value: 1 }, uR0: { value: 0 }, uArc: { value: 1 }, uLen: { value: 1 }, uW: { value: 1 }, uProg: { value: 0 }, uFire: { value: 0 }, uStyle: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 }, uBound: { value: 1 }, uCol: { value: new THREE.Color() } },
        vertexShader: HZ_VERT, fragmentShader: HZ_FRAG, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      m.renderOrder = 10; m.material.userData.shared = true; FX.root.add(m);
    }
    m.visible = true; return m;
  }
  warm() { if (!this.free.length && !this.live.size) { const m = this.getMesh(); m.visible = false; this.free.push(m); } }
  release(id) { const m = this.live.get(id); if (m) { m.visible = false; this.free.push(m); this.live.delete(id); } }
  clear() { for (const id of [...this.live.keys()]) this.release(id); }
  sync(a, b, k, pub) {
    const seen = new Set(), TYPE = { circle: 0, donut: 1, cone: 2, rect: 3 };
    for (const h of b.hazards) {
      const s = h.shape; if (!(s.type in TYPE)) continue; seen.add(h.id);
      let m = this.live.get(h.id); if (!m) { m = this.getMesh(); this.live.set(h.id, m); }
      const ha = a.hazards.find((q) => q.id === h.id), sa = ha ? ha.shape : s, u = m.material.uniforms;
      u.uType.value = TYPE[s.type]; let bound = 1;
      if (s.type === 'circle') { u.uR1.value = s.r; bound = s.r + 0.3; }
      else if (s.type === 'donut') { u.uR1.value = s.r1; u.uR0.value = s.r0; bound = s.r1 + 0.3; }
      else if (s.type === 'cone') { u.uR1.value = s.r; u.uR0.value = s.r0 || 0; u.uArc.value = s.arc; bound = s.r + 0.3; }
      else { u.uLen.value = s.len; u.uW.value = s.w; bound = Math.max(s.len, s.w) + 0.3; }
      u.uBound.value = bound; m.scale.setScalar(bound);
      m.position.set(lerp(sa.x, s.x, k), 0.05 + (h.lift || 0), lerp(sa.z, s.z, k)); m.rotation.y = lerpAng(sa.dir || 0, s.dir || 0, k);
      u.uCol.value.setHex(pub.neg ? 0xf4f4ff : h.color); u.uTime.value = G.now;
      const alpha = h.alpha === undefined ? 1 : h.alpha;
      if (h.state === 'tele') { const t = ha && ha.state === 'tele' ? lerp(ha.t, h.t, k) : h.t; u.uStyle.value = h.style || 0; u.uProg.value = sat(t / Math.max(h.delay, 1e-3)); u.uFire.value = 0; u.uAlpha.value = alpha; }
      else if (h.state === 'zone') { const zt = ha && ha.state === 'zone' ? lerp(ha.zt || 0, h.zt || 0, k) : (h.zt || 0); u.uStyle.value = h.zoneStyle || 2; u.uProg.value = 1; u.uFire.value = 0; u.uAlpha.value = Math.min(1, (h.dur - zt) * 2) * alpha; }
      else if (h.state === 'fired') { const ft = lerp(ha && ha.state === 'fired' ? ha.fireT : 0.28, h.fireT === undefined ? 0 : h.fireT, k); u.uProg.value = 1; u.uFire.value = sat(ft / 0.28); u.uAlpha.value = sat(ft / 0.2) * alpha; }
    }
    for (const id of [...this.live.keys()]) if (!seen.has(id)) this.release(id);
  }
}

// ---------------- bullets: Threshold's hot-core spheres, ground discs and streaks (06_combat.js Bul), fed from snapshots
class Bullets {
  constructor() {
    const MAX = this.MAX = 700, g = new THREE.SphereGeometry(1, 12, 9);
    this.mesh = new THREE.InstancedMesh(g, new THREE.ShaderMaterial({ vertexShader: BUL_V, fragmentShader: BUL_F }), MAX);
    this.tail = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }), MAX);
    const dg = new THREE.CircleGeometry(1, 16); dg.rotateX(-PI / 2);
    this.disc = new THREE.InstancedMesh(dg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }), MAX);
    for (const q of [this.mesh, this.disc, this.tail]) { q.frustumCulled = false; q.count = 0; q.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3); FX.root.add(q); }
    this.disc.renderOrder = 9; this.tail.renderOrder = 12;
    this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.TP = new V3(); this.TS = new V3(); this.col = new THREE.Color(); this.Y = new V3(0, 1, 0);
  }
  clear() { this.mesh.count = this.disc.count = this.tail.count = 0; }
  sync(a, b, k) {
    const { mesh, disc, tail, M, Q, TP, TS, col } = this, prev = new Map(); for (const q of a.bullets) prev.set(q.id, q);
    let n = 0;
    for (const q of b.bullets) {
      if (n >= this.MAX) break; const qa = prev.get(q.id) || q;
      const x = lerp(qa.x, q.x, k), z = lerp(qa.z, q.z, k), y = q.y === undefined ? 1.1 : q.y, t = lerp(qa.t || 0, q.t || 0, k), dir = lerpAng(qa.dir || 0, q.dir || 0, k), sp = q.speed || 0;
      const s = q.r * (t < 0.15 ? t / 0.15 : 1);
      M.makeScale(s, s, s); M.setPosition(x, y, z); mesh.setMatrixAt(n, M);
      M.makeScale(s * 1.5, 1, s * 1.5); M.setPosition(x, 0.06, z); disc.setMatrixAt(n, M);
      const tl = Math.min(4, 0.4 + sp * 0.09); Q.setFromAxisAngle(this.Y, dir); TS.set(s * 0.75, s * 0.75, s * 0.75 + s * tl);
      TP.set(x - Math.sin(dir) * s * tl * 0.85, y, z - Math.cos(dir) * s * tl * 0.85); M.compose(TP, Q, TS); tail.setMatrixAt(n, M);
      col.set(q.color === undefined ? 0xff5a2a : q.color); disc.setColorAt(n, col); tail.setColorAt(n, col); mesh.setColorAt(n, col);
      n++;
    }
    mesh.count = disc.count = tail.count = n;
    if (n) { mesh.instanceMatrix.needsUpdate = disc.instanceMatrix.needsUpdate = tail.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = disc.instanceColor.needsUpdate = tail.instanceColor.needsUpdate = true; }
  }
}

// ---------------- Pentimento, the lay figure (a stand-in for Threshold's carved model)
function layFigure(g) {
  const wood = new THREE.MeshStandardMaterial({ color: 0xb89068, roughness: 0.55, emissive: 0x000000 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.5, metalness: 0.2 });
  const body = new THREE.Group(); g.add(body);
  const seg = (r, l, x, y, z, rx = 0, rz = 0, m = wood) => { const q = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 6, 14), m); q.position.set(x, y, z); q.rotation.set(rx, 0, rz); body.add(q); return q; };
  const ball = (r, x, y, z) => { const q = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), joint); q.position.set(x, y, z); body.add(q); return q; };
  seg(0.34, 1.0, -0.38, 1.0, 0); seg(0.34, 1.0, 0.38, 1.0, 0); ball(0.3, -0.38, 1.85, 0); ball(0.3, 0.38, 1.85, 0);
  seg(0.62, 0.7, 0, 2.6, 0); seg(0.75, 0.6, 0, 3.6, 0); ball(0.3, 0, 4.3, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 16), wood); head.scale.set(0.85, 1.1, 0.9); head.position.set(0, 4.95, 0); body.add(head);
  ball(0.26, -0.95, 3.95, 0); ball(0.26, 0.95, 3.95, 0);
  seg(0.22, 1.1, -1.15, 3.2, 0, 0, 0.25); const armR = seg(0.22, 1.1, 1.2, 3.3, 0.3, -0.6, -0.2);
  const brush = new THREE.Group(); brush.position.set(1.5, 2.9, 0.8); body.add(brush);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5.2, 8), new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 0.6 })); handle.rotation.x = 0.9; brush.add(handle);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 10), new THREE.MeshStandardMaterial({ color: 0xe23a2e, roughness: 0.4 })); tip.position.set(0, 1.55, 2.05); tip.rotation.x = 0.9 + PI; brush.add(tip);
  const swirl = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.09, 8, 40), new THREE.MeshStandardMaterial({ color: 0xe23a2e, emissive: 0xe23a2e, emissiveIntensity: 0.4 })); swirl.rotation.x = PI / 2; body.add(swirl);
  let t = 0;
  return {
    update(dt, e, pub) {
      t += dt; const need = pub.split && pub.call ? pub.call.col : pub.col; const c = PIG[need || 1] || 0xffffff;
      tip.material.color.setHex(c); swirl.material.color.setHex(c); swirl.material.emissive.setHex(c);
      const tone = pub.split && pub.call ? (pub.call.tone === 'w' ? 0xf4efe6 : 0x1c1c22) : pub.neg ? 0x3a3a44 : 0xb89068;
      wood.color.setHex(tone); wood.emissive.setHex(pub.flood ? 0x404040 : 0x000000);
      swirl.position.y = 0.6 + ((t * 0.8) % 1) * ((pub.top !== undefined ? pub.top : 7.5) * 0.6);
      body.rotation.x = pub.down > 0 ? -0.55 : 0; body.position.y = pub.down > 0 ? -0.6 : Math.sin(t * 1.3) * 0.05;
      brush.rotation.z = (pub.swing || 0) * -1.6; armR.rotation.z = -0.2 - (pub.swing || 0) * 0.9;
    },
  };
}

// ---------------- the training dummy: a post, a stuffed sack in leather straps, a crossbar, a painted target
function dummyModel(g) {
  const woodT = W.surface('wood', { size: 256, seed: 5, n: 3, dark: 0x3a2616, light: 0x8a6440, repeat: 1, strength: 2 });
  const wood = W.mat(Object.assign({ roughness: 0.85 }, woodT)), sackT = W.surface('stone', { size: 128, seed: 9, n: 9, dark: 0x8a7050, light: 0xd8c098, repeat: 2, strength: 1.2 });
  const sack = W.mat(Object.assign({ roughness: 1 }, sackT)), strap = W.mat({ color: 0x4a2e1c, roughness: 0.6, metalness: 0.1 }), brass = W.mat({ color: 0xc8a050, roughness: 0.35, metalness: 0.9 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 3.6, 12), wood); post.position.y = 1.8; g.add(post);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.3, 18), wood); base.position.y = 0.15; g.add(base);
  for (let i = 0; i < 4; i++) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 1.5), wood); const a = i / 4 * TAU + 0.4; leg.position.set(Math.sin(a) * 0.75, 0.14, Math.cos(a) * 0.75); leg.rotation.y = a; g.add(leg); }
  const body = new THREE.Group(); body.position.y = 1.6; g.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.9, 8, 16), sack); torso.position.y = 0.4; body.add(torso);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 0.16), wood); bar.position.y = 0.85; body.add(bar);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 18, 14), sack); head.position.y = 1.55; body.add(head);
  for (const y of [0.05, 0.62]) { const rope = new THREE.Mesh(new THREE.TorusGeometry(0.575, 0.045, 8, 28), strap); rope.rotation.x = PI / 2; rope.position.y = y; body.add(rope); }
  const target = new THREE.Mesh(new THREE.CircleGeometry(0.26, 24), W.mat({ color: 0xb02a1e, roughness: 0.8 })); target.position.set(0, 0.45, 0.56); body.add(target);
  const tin = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.17, 24), W.mat({ color: 0xe8d8b0, roughness: 0.8 })); tin.position.set(0, 0.45, 0.565); body.add(tin);
  const stud = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), brass); stud.position.set(0, 1.12, 0); body.add(stud);
  g.traverse((q) => { if (q.isMesh) { q.castShadow = true; q.receiveShadow = true; } });
  let wob = 0, lastHp = null;
  return {
    update(dt, e) {
      if (lastHp !== null && e.hp < lastHp) wob = Math.min(1, wob + 0.35); lastHp = e.hp;
      wob *= Math.exp(-dt * 5); body.rotation.x = Math.sin(HeroClock.now * 22) * 0.12 * wob; body.rotation.z = Math.cos(HeroClock.now * 17) * 0.08 * wob;
    },
  };
}
