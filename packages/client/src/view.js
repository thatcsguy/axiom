// The 3D view: draws one blended moment of the fight from snapshots, pub and cues. It never runs rules.
//
// The look is Threshold's own, imported unchanged into look.js (tools/import-look.js): the renderer, the post chain (NaN
// sanitize, bloom, colour grade, flash, chromatic pulse, grain, vignette), the FX library every cue lands in, the camera rig
// (orbit, zoom limits, shake, cinematic blend, keep-out-of-the-boss, occluder fade), the procedural world helpers, the
// telegraph decal and bullet shaders, the warm-up that compiles every shader before a fight, and the freeze log.
// Heroes are Threshold's models (heroes.js). Pentimento's studio, paint canvas, lay figure, roller, seam and kill are
// Threshold's too (atelier-look.js, driven by atelier.js), and so are Issen's lake, costume, cuts, ghosts, petals and
// reflection (duelist-look.js, driven by duelist.js). What is Axiom's own: turning snapshots into hazards, bullets,
// heroes and bodies, routing cues (with the screen-only ones kept for the player they belong to), and the Training Dummy's ring.
import {
  THREE, G, Input, Game, Hz as HzHook, Co, FX, Cam, W, Post, Warm, Hitch, scene, camera, renderer,
  HZ_VERT, HZ_FRAG, BUL_V, BUL_F, frame as lookFrame, hitstop as lookHitstop,
} from './look.js';
import { buildHero, HeroClock } from './heroes.js';
import { AtelierView, ATELIER_POST, ATELIER_NM_POST } from './atelier.js';
import { DuelistView, DUELIST_POST, DUELIST_NM_POST } from './duelist.js';

const TAU = Math.PI * 2, PI = Math.PI, V3 = THREE.Vector3;
const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a, b) => v < a ? a : v > b ? b : v, sat = (v) => clamp(v, 0, 1);
const smooth = (t) => { t = sat(t); return t * t * (3 - 2 * t); };
const lerpAng = (a, b, t) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return a + d * t; };
export const PIG = [0xffffff, 0xe23a2e, 0xf2c218, 0xf08a1e, 0x2a5fe0, 0x8a3cd0, 0x2aa858, 0x5c4332];
export const PIG_NAME = ['clean', 'red', 'yellow', 'orange', 'blue', 'purple', 'green', 'mud'];

// Per-encounter grade (Threshold's def.post) and camera. Pentimento's are Threshold's own (38_boss_atelier.js POST).
const LOOKS = {
  dummy: { post: { bloom: 0.5, threshold: 0.86, radius: 0.55, exposure: 1.12, sat: 1.06, vig: 0.85, contrast: 1.05, tint: [1.02, 1.0, 0.97] }, aimY: 1.8 },
  atelier: { post: ATELIER_POST, nmPost: ATELIER_NM_POST, aimY: 3.6, camDist: 17, camPitch: 0.55 },
  duelist: { post: DUELIST_POST, nmPost: DUELIST_NM_POST, aimY: 1.6 },
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
    this.atl = null; this.duel = null; const R = s.arena.radius;
    if (id === 'atelier') this.atl = new AtelierView(this.world, !!s.nm);
    else if (id === 'duelist') this.duel = new DuelistView(this.world, !!s.nm);
    else this.buildRing(R);
    const L = LOOKS[id] || LOOKS.dummy; Post.set((s.nm && L.nmPost) || L.post || {}); Cam.minDist = 4; Cam.maxDist = 26;
    this.lookDef = L; Game.def = { id };
    if (this.atl && this.pendingCatch) { this.atl.catchUp(this.pendingCatch, s.boss.pub, !!s.nm); this.pendingCatch = null; } // after the encounter's base grade
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
  // ---------------- bodies
  heroFor(p) {
    let h = this.heroes.get(p.id);
    if (h && h.cls !== p.cls) { scene.remove(h.g); disposeWorld(h.g); h = null; }
    if (!h) {
      const cls = this.catalog.classes.find((c) => c.id === p.cls) || { id: p.cls, look: { armor: 0x555566, cloth: 0x333344, glow: 0xffffff } };
      const m = buildHero(cls), g = new THREE.Group(); g.add(m.group);
      h = { g, m, cls: p.cls, color: cls.color, x: p.x, z: p.z, y: p.y, f: p.facing, deathT: 0 }; this.heroes.set(p.id, h); scene.add(g);
    }
    return h;
  }
  entFor(e, bossId) {
    let o = this.ents.get(e.id); if (o) return o;
    if (e.boss && this.atl) { o = { g: this.atl.group, boss: true, own: true }; this.ents.set(e.id, o); return o; } // Threshold's lay figure, built with the studio
    if (this.duel && (o = this.duel.entFor(e))) { this.ents.set(e.id, o); return o; } // Issen and his reflection, built with the lake
    const g = new THREE.Group(); o = { g, boss: e.boss };
    if (e.boss && bossId === 'dummy') Object.assign(o, dummyModel(g));
    else if (e.boss) { const m = new THREE.Mesh(new THREE.CapsuleGeometry(e.radius * 0.7, e.radius * 2, 6, 12), new THREE.MeshStandardMaterial({ color: 0xbbbbbb })); m.position.y = e.radius * 1.7; g.add(m); }
    else if (this.atl) Object.assign(o, this.atl.blot(g, e)); // Pentimento's Blots
    else { // an add: a glossy drop
      const col = typeof e.color === 'number' ? e.color : 0xcc3344, m = new THREE.Mesh(new THREE.SphereGeometry(e.radius, 20, 14), new THREE.MeshStandardMaterial({ color: col, roughness: 0.15, metalness: 0.05, emissive: col, emissiveIntensity: 0.15 }));
      m.scale.y = 0.7; m.position.y = e.radius * 0.65; m.castShadow = true; g.add(m); o.blob = m;
    }
    g.traverse((q) => { if (q.isMesh) q.castShadow = true; });
    this.ents.set(e.id, o); scene.add(g); return o;
  }

  // ---------------- one frame
  // a, b, k: the blended snapshots; self: the same for your own character (your prediction, with off: its fading correction;
  // or, unpredicted, snapshots with less delay); you: your character's id (null: watching)
  draw(dt, a, b, k, self, you, input) {
    if (this.slowT > 0) { this.slowT -= dt; if (this.slowT <= 0) this.slowK = 1; }
    const dts = dt * this.slowK; HeroClock.now += dts;
    const s = b; this.setArena(s);
    const pub = s.boss.pub || {};
    G.state = s.state === 'intro' || s.state === 'fight' || s.state === 'win' || s.state === 'dead' ? s.state : 'fight'; G.ft = s.t; G.nightmare = !!s.nm;
    // players
    const seen = new Set(); let mine = null;
    for (const pb of s.players) {
      const useSelf = pb.id === you && self, A = useSelf ? self.a : a, B = useSelf ? self.b : b, K = useSelf ? self.k : k;
      const pa = A.players.find((q) => q.id === pb.id) || pb, p2 = B.players.find((q) => q.id === pb.id) || pb;
      const h = this.heroFor(p2); seen.add(pb.id); if (pb.id === you) mine = { h, p: p2 };
      h.x = lerp(pa.x, p2.x, K); h.y = lerp(pa.y, p2.y, K); h.z = lerp(pa.z, p2.z, K); h.f = lerpAng(pa.facing, p2.facing, K);
      if (useSelf && self.off) { h.x += self.off.x; h.y += self.off.y; h.z += self.off.z; } // a prediction's correction, fading out
      h.g.position.set(h.x, h.y, h.z); h.m.group.rotation.y = h.f; h.g.updateMatrixWorld(true); // the weapon trail samples world positions this frame
      if (p2.alive) {
        if (h.deathT > 0) { h.deathT = 0; h.m.body.rotation.x = 0; h.m.body.position.y = 0; }
        const an = p2.anim || {}, stand = { moveSpeed: an.ms || 0, grounded: an.gr !== false, casting: p2.casting, parryT: an.parry ? 0.5 : 0, flashT: an.flash ? 0.1 : 0, rollT: an.roll || 0, aimT: an.aim ? 0.5 : 0, loadT: an.load ? 0.2 : 0, dash: an.dash ? {} : null,
          res: p2.res, resMax: p2.resMax, shield: p2.shield || 0, shieldMax: p2.shieldMax || 1, hasBuff: (id) => p2.buffs.some((q) => q.id === id && q.t > 0), pose: null, dead: false };
        try { h.m.update(dts, stand); } catch (e) { /* a model that wants more of the stand-in: keep drawing */ }
      } else { h.deathT += dts; const kk = Math.min(1, h.deathT / 0.7); h.m.body.rotation.x = -kk * 1.45; h.m.body.position.y = -kk * 0.1; } // Threshold's fall
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
    for (const [id, o] of this.ents) if (!live.has(id)) { if (!o.own) { scene.remove(o.g); disposeWorld(o.g); } this.ents.delete(id); }
    // your target: Threshold's turning ring in your class colour
    const tgt = input && input.targetId !== null && input.targetId !== undefined ? this.ents.get(input.targetId) : null;
    this.tring.visible = !!(tgt && mine && mine.p.alive);
    if (this.tring.visible) { this.tring.material.color.set(mine.h.color || '#ffffff').multiplyScalar(1.1); this.tring.scale.setScalar((tgt.radius || 1) + 0.25); this.tring.position.set(tgt.x, 0.07, tgt.z); this.tring.rotation.z += dt * 0.6; }
    // what the camera follows (Threshold's Cam reads G.player, G.boss, G.arena)
    let focus = mine ? mine.h : null, focusId = mine ? you : null;
    if (!focus) { for (const [id, h] of this.heroes) { const p = s.players.find((q) => q.id === id); if (p && p.alive) { focus = h; focusId = id; break; } } }
    if (this.atl) { const fp = focus ? s.players.find((q) => q.id === focusId) : null; this.atl.update(dts, s, a, k, bossO ? { x: bossO.x, z: bossO.z, facing: bossO.g.rotation.y } : null, focus ? { id: focusId, pos: new V3(focus.x, focus.y, focus.z), alive: !fp || fp.alive } : null, you, this.heroes); }
    if (this.duel) { this.duel.update(dts, s, a, k, bossO ? { x: bossO.x, z: bossO.z, facing: bossO.g.rotation.y } : null, focus ? { id: focusId, pos: new V3(focus.x, focus.y, focus.z), alive: true } : null); }
    this.decals.sync(a, b, k, pub);
    this.bullets.sync(a, b, k);
    if (focus) { this.me.pos.set(focus.x, focus.y, focus.z); this.me.facing = focus.f; this.me.alive = true; G.player = this.me; }
    else G.player = null;
    if (bossO) { const F = this.bossF; F.pos.copy(bossO.g.position); F.radius = bossO.radius || 1; F.group = bossO.g; F.def.aimY = this.lookDef.aimY || 2.5; F.phase = s.boss.phase; G.boss = F; } else G.boss = null;
    G.arena = { floorY: 0, camLimit: this.duel && this.duel.arena.camLimit };
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
  // a new fight: everything is built again (a second Pentimento must not keep the first one's paint)
  reset() { this.arenaId = null; this.pendingCatch = null; }
  // the catch-up for a newcomer (the server sends it after 'start'): applied once the arena is built
  catchUp(m, pub) { if (m.boss !== 'atelier') return; if (this.atl && this.arenaId === 'atelier') this.atl.catchUp(m, pub, !!m.nm); else this.pendingCatch = m; }
  // the camera an encounter opens with (Threshold's arena camDist / camPitch)
  camFor(id) { const L = LOOKS[id] || {}; return { dist: L.camDist || (id === 'dummy' ? 11 : 14), pitch: L.camPitch === undefined ? 0.36 : L.camPitch }; }
  // camera control for tools: yaw relative to your hero's facing, pitch, distance
  setCam(o) { if (o.yaw !== undefined) Cam.yaw = this.me.facing + o.yaw; if (o.pitch !== undefined) Cam.pitch = o.pitch; if (o.dist !== undefined) Cam.tDist = Cam.dist = o.dist; }
  info() { return { programs: renderer.info.programs.length, warmMs: this.warmMs, compiledInFight: this.compiled.slice(), late: Hitch.count.late, errors: G.errors.slice(0, 3) }; }

  // ---------------- cues (one-shot effects)
  // actor: the player whose action raised it (null: the boss, the world). you: your character's id (null: watching).
  cue(name, args, actor, you) {
    const ow = OWN[name];
    if (ow !== undefined) { const who = args[ow] !== undefined && args[ow] !== null ? args[ow] : actor; if (who !== null && who !== undefined && who !== you) return; }
    if (name.startsWith('fx.')) return fxCue(name.slice(3), args);
    if (name.startsWith('duelist.')) { if (this.duel) this.duel.cue(name, args); return; }
    switch (name) {
      case 'atelier.lay': if (this.atl) this.atl.lay(args[0]); return;
      case 'fight.win': { const slow = (kk, d) => { this.slowK = kk; this.slowT = d; lookHitstop(kk, d); }; if (this.atl) this.atl.kill(!!G.nightmare, slow); if (this.duel) this.duel.kill(!!G.nightmare, slow); return; }
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
      u.uCol.value.setHex(h.color); u.uTime.value = G.now;
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
