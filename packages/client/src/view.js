// The 3D view: draws one blended moment of the fight from snapshots, pub and cues. It never runs rules.
// Heroes are Threshold's own models (heroes.js, imported from Threshold). The arenas, Pentimento, the dummy, telegraphs
// and effects are a simple stand-in look for the prototype; Threshold's full Pentimento view (the studio, the paint shader,
// the Negative post-effect) is not ported yet.
import * as THREE from 'three';
import { buildHero, HeroClock } from './heroes.js';

const TAU = Math.PI * 2, PI = Math.PI;
const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerpAng = (a, b, t) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return a + d * t; };
export const PIG = [0xffffff, 0xe23a2e, 0xf2c218, 0xf08a1e, 0x2a5fe0, 0x8a3cd0, 0x2aa858, 0x5c4332];
export const PIG_NAME = ['clean', 'red', 'yellow', 'orange', 'blue', 'purple', 'green', 'mud'];
const css = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const R_PAINT = 20, CANVAS_N = 1024;

export class View {
  constructor(canvas, catalog) {
    this.catalog = catalog;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1)); r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0; r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
    this.cam = { yaw: 0, pitch: 0.36, dist: 14, tDist: 14, focus: new THREE.Vector3(), shake: 0, cine: null, cineW: 0, cPos: new THREE.Vector3(), cLook: new THREE.Vector3() };
    const hemi = this.hemi = new THREE.HemisphereLight(0xdfe6ff, 0x2a2420, 1.1); this.scene.add(hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xfff2e0, 2.2); sun.position.set(-12, 26, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); const sc = sun.shadow.camera; sc.left = sc.bottom = -24; sc.right = sc.top = 24; sc.near = 1; sc.far = 80; sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target);
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.heroes = new Map(); this.ents = new Map(); this.hz = new Map(); this.arenaId = null;
    this.fx = new Fx(this.scene); this.nums = []; this.labels = new Map();
    this.bulletMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 700); this.bulletMesh.count = 0; this.bulletMesh.frustumCulled = false; this.scene.add(this.bulletMesh);
    this.flashEl = document.getElementById('flash'); this.flashA = 0;
    this.resize(); addEventListener('resize', () => this.resize());
  }
  resize() { const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  // ---------------- arenas
  setArena(s) {
    const id = s.boss.id; if (this.arenaId === id && this.arenaR === s.arena.radius) return;
    this.arenaId = id; this.arenaR = s.arena.radius;
    for (const c of [...this.world.children]) this.world.remove(c);
    for (const [, e] of this.ents) this.scene.remove(e.g); this.ents.clear();
    for (const [, h] of this.hz) this.scene.remove(h.g); this.hz.clear();
    this.paint = null; const R = s.arena.radius;
    if (id === 'atelier') this.buildAtelier(R); else this.buildRing(R);
  }
  buildRing(R) { // the training ring: stone floor, a low wall, a few posts
    this.scene.background = new THREE.Color(0x1a1d24); this.scene.fog = new THREE.Fog(0x1a1d24, 40, 120);
    const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d');
    x.fillStyle = '#5a5650'; x.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i++) { x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.06})`; x.fillRect(Math.random() * 512, Math.random() * 512, 3 + Math.random() * 12, 3 + Math.random() * 12); }
    x.strokeStyle = 'rgba(30,28,26,0.55)'; x.lineWidth = 3; for (let i = 0; i <= 512; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.moveTo(0, i); x.lineTo(512, i); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(R / 4, R / 4); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 96), new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 })); floor.rotation.x = -PI / 2; floor.receiveShadow = true; this.world.add(floor);
    const outer = new THREE.Mesh(new THREE.RingGeometry(R, R + 30, 96), new THREE.MeshStandardMaterial({ color: 0x24262c, roughness: 1 })); outer.rotation.x = -PI / 2; outer.position.y = -0.02; this.world.add(outer);
    const wall = new THREE.Mesh(new THREE.TorusGeometry(R + 0.3, 0.35, 8, 96), new THREE.MeshStandardMaterial({ color: 0x7a6a58, roughness: 0.8 })); wall.rotation.x = PI / 2; wall.position.y = 0.3; wall.castShadow = true; this.world.add(wall);
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + 0.2, p = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 3.2, 10), new THREE.MeshStandardMaterial({ color: 0x6a5a48, roughness: 0.85 })); p.position.set(Math.sin(a) * (R + 1.4), 1.6, Math.cos(a) * (R + 1.4)); p.castShadow = true; this.world.add(p);
      const fl = new THREE.PointLight(0xffa860, 6, 14, 1.8); fl.position.set(p.position.x, 3.6, p.position.z); this.world.add(fl); const flame = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffc080 })); flame.position.copy(fl.position); this.world.add(flame); }
    this.hemi.intensity = 1.0; this.sun.intensity = 1.8;
  }
  buildAtelier(R) { // a pale canvas tondo in a dark studio; the floor keeps the paint (drawn from 'atelier.lay' cues)
    this.scene.background = new THREE.Color(0x15130f); this.scene.fog = new THREE.Fog(0x15130f, 45, 140);
    const c = document.createElement('canvas'); c.width = c.height = CANVAS_N;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    this.paint = { c, x: c.getContext('2d'), tex, strokes: [], dirty: true, neg: false, t: 0 };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * R_PAINT, 2 * R_PAINT), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
    floor.rotation.x = -PI / 2; floor.receiveShadow = true; this.world.add(floor);
    const frame = new THREE.Mesh(new THREE.TorusGeometry(R + 0.25, 0.3, 10, 120), new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.45, metalness: 0.5 })); frame.rotation.x = PI / 2; frame.position.y = 0.12; frame.castShadow = true; this.world.add(frame);
    const boards = new THREE.Mesh(new THREE.RingGeometry(R + 0.5, R + 40, 96), new THREE.MeshStandardMaterial({ color: 0x3a2c20, roughness: 0.9 })); boards.rotation.x = -PI / 2; boards.position.y = -0.03; this.world.add(boards);
    for (let i = 0; i < 6; i++) { // easels with blank canvases around the room
      const a = i / 6 * TAU + 0.5, g = new THREE.Group(), wood = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.8 });
      for (const [x, rz] of [[-0.7, 0.12], [0.7, -0.12]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5, 0.12), wood); leg.position.set(x, 2.4, 0); leg.rotation.z = rz; g.add(leg); }
      const cv = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.2, 0.08), new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.9 })); cv.position.set(0, 3.2, 0.1); g.add(cv);
      g.position.set(Math.sin(a) * (R + 5), 0, Math.cos(a) * (R + 5)); g.rotation.y = a + PI; g.traverse((o) => { o.castShadow = true; }); this.world.add(g);
    }
    // the dish (wash): clear water that scrubs the paint off you
    const dish = this.dish = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.12, 8, 48), new THREE.MeshStandardMaterial({ color: 0xc8d8e0, roughness: 0.2, metalness: 0.3 })); rim.rotation.x = PI / 2; rim.position.y = 0.1; dish.add(rim);
    const water = new THREE.Mesh(new THREE.CircleGeometry(2.45, 48), new THREE.MeshStandardMaterial({ color: 0x8fd0ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.8, emissive: 0x16384a })); water.rotation.x = -PI / 2; water.position.y = 0.06; dish.add(water);
    this.world.add(dish);
    // the finale's black half (Nightmare), a half disc that turns with the seam
    const half = this.half = new THREE.Mesh(new THREE.CircleGeometry(R, 64, -PI, PI), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.62, depthWrite: false })); half.rotation.x = -PI / 2; half.position.y = 0.03; half.visible = false;
    const hg = this.halfG = new THREE.Group(); hg.add(half); this.world.add(hg);
    // the roller
    const roller = this.roller = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 12, 20), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })); roller.visible = false; roller.castShadow = true; this.world.add(roller);
    this.hemi.intensity = 1.15; this.sun.intensity = 2.3;
  }
  lay(sh) { if (this.paint) { this.paint.strokes.push(sh); if (this.paint.strokes.length > 520) this.paint.strokes.shift(); this.paint.dirty = true; } }
  drawPaint(ft, neg) {
    const P = this.paint; if (!P) return;
    P.t -= 1; if (!P.dirty && P.t > 0 && P.neg === neg) return; P.dirty = false; P.t = 15; P.neg = neg; // repaint on new paint, and every 15 frames as paint dries
    const x = P.x, U = CANVAS_N / (2 * R_PAINT), N = CANVAS_N;
    x.fillStyle = neg ? '#1b1a20' : '#2b241c'; x.fillRect(0, 0, N, N);
    x.save(); x.beginPath(); x.arc(N / 2, N / 2, (R_PAINT - 0.25) * U, 0, TAU); x.clip();
    x.fillStyle = neg ? '#141419' : '#ebe4d4'; x.fillRect(0, 0, N, N);
    // canvas weave
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
    if (h && h.cls !== p.cls) { this.scene.remove(h.g); h = null; }
    if (!h) {
      const cls = this.catalog.classes.find((c) => c.id === p.cls) || { id: p.cls, look: { armor: 0x555566, cloth: 0x333344, glow: 0xffffff } };
      const m = buildHero(cls), g = new THREE.Group(); g.add(m.group);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.78, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); ring.rotation.x = -PI / 2; ring.position.y = 0.04; g.add(ring);
      h = { g, m, cls: p.cls, ring, x: p.x, z: p.z, y: p.y, f: p.facing }; this.heroes.set(p.id, h); this.scene.add(g);
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
    this.ents.set(e.id, o); this.scene.add(g); return o;
  }

  // ---------------- one frame
  // a, b, k: the blended snapshots; self: the same for your own character (less delay); you: your character's id (null: watching)
  draw(dt, a, b, k, self, you, input) {
    HeroClock.now += dt;
    const s = b; this.setArena(s);
    const pub = s.boss.pub || {};
    if (this.paint) this.drawPaint(s.t, !!pub.neg);
    if (s.boss.id === 'atelier') this.drawAtelierPub(pub, s);
    // players
    const seen = new Set();
    for (const pb of s.players) {
      const useSelf = pb.id === you && self, A = useSelf ? self.a : a, B = useSelf ? self.b : b, K = useSelf ? self.k : k;
      const pa = A.players.find((q) => q.id === pb.id) || pb, p2 = B.players.find((q) => q.id === pb.id) || pb;
      const h = this.heroFor(p2); seen.add(pb.id);
      h.x = lerp(pa.x, p2.x, K); h.y = lerp(pa.y, p2.y, K); h.z = lerp(pa.z, p2.z, K); h.f = lerpAng(pa.facing, p2.facing, K);
      h.g.position.set(h.x, h.y, h.z); h.m.group.rotation.y = h.f;
      const an = p2.anim || {}, stand = { moveSpeed: an.ms || 0, grounded: an.gr !== false, casting: p2.casting, parryT: an.parry ? 0.5 : 0, flashT: an.flash ? 0.1 : 0, rollT: an.roll || 0, aimT: an.aim ? 0.5 : 0, loadT: an.load ? 0.2 : 0, hasBuff: (id) => p2.buffs.some((q) => q.id === id), pose: null, dead: !p2.alive };
      try { h.m.update(dt, stand); } catch (e) { /* a model that wants more of the stand-in: keep drawing */ }
      h.m.group.rotation.x = p2.alive ? 0 : -PI / 2 * 0.92; h.m.group.position.y = p2.alive ? 0 : 0.25;
      // the paint you wear (Pentimento) shows as a ring at your feet; your own ring is brighter
      const w = pub.pw && pub.pw[pb.id] ? pub.pw[pb.id].wear : 0;
      h.ring.material.opacity = w ? 0.85 : pb.id === you ? 0.35 : 0; h.ring.material.color.setHex(w ? PIG[w] : 0xffffff);
    }
    for (const [id, h] of this.heroes) if (!seen.has(id)) { this.scene.remove(h.g); this.heroes.delete(id); }
    // hostile bodies
    const live = new Set();
    for (const eb of s.ents) {
      if (!eb.alive && !eb.boss) continue; live.add(eb.id);
      const ea = a.ents.find((q) => q.id === eb.id) || eb, o = this.entFor(eb, s.boss.id);
      o.g.position.set(lerp(ea.x, eb.x, k), lerp(ea.y, eb.y, k), lerp(ea.z, eb.z, k)); o.g.rotation.y = lerpAng(ea.facing, eb.facing, k);
      o.x = o.g.position.x; o.z = o.g.position.z; o.radius = eb.radius; o.aimY = eb.boss ? (s.boss.id === 'atelier' ? 3.6 : 1.8) : 0.8;
      if (o.update) o.update(dt, eb, pub, s);
      if (o.blob) o.blob.scale.set(1 + Math.sin(HeroClock.now * 7 + eb.id) * 0.06, 0.7 + Math.cos(HeroClock.now * 6 + eb.id) * 0.06, 1);
      const tgt = input && input.targetId === eb.id; if (o.sel) o.sel.visible = tgt;
      if (!o.sel) { const sel = o.sel = new THREE.Mesh(new THREE.RingGeometry(eb.radius + 0.35, eb.radius + 0.55, 48), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.8, depthWrite: false })); sel.rotation.x = -PI / 2; sel.position.y = 0.05; o.g.add(sel); sel.visible = tgt; }
    }
    for (const [id, o] of this.ents) if (!live.has(id)) { this.scene.remove(o.g); this.ents.delete(id); }
    this.drawHazards(s, pub);
    // bullets
    const bm = this.bulletMesh, M = new THREE.Matrix4(), col = new THREE.Color(); let n = 0;
    for (const q of s.bullets) { const qa = a.bullets.find((z) => z.id === q.id) || q; M.makeScale(q.r, q.r, q.r).setPosition(lerp(qa.x, q.x, k), q.y || 1.1, lerp(qa.z, q.z, k)); bm.setMatrixAt(n, M); bm.setColorAt(n, col.setHex(q.color || 0xff5a2a)); n++; if (n >= 700) break; }
    bm.count = n; bm.instanceMatrix.needsUpdate = true; if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    this.fx.update(dt);
    this.updateCamera(dt, you, input);
    this.renderer.render(this.scene, this.camera);
    this.drawNums(dt);
    this.flashA = Math.max(0, this.flashA - dt * this.flashFade); if (this.flashEl) this.flashEl.style.opacity = this.flashA.toFixed(3);
  }
  drawAtelierPub(pub, s) {
    if (this.dish && pub.wash) { this.dish.position.set(pub.wash.x, 0, pub.wash.z); this.dish.scale.setScalar(pub.wash.r / 2.5); }
    if (this.half) { this.half.visible = !!pub.split; if (pub.split) this.halfG.rotation.y = pub.lineA - PI / 2; } // the black half: x cos A - z sin A < 0
    const q = pub.roll; this.roller.visible = !!q && q.s > -22.5;
    if (q) { const fx = Math.sin(q.a), fz = Math.cos(q.a); this.roller.position.set(q.cx + fx * q.s, 0.7, q.cz + fz * q.s); this.roller.rotation.set(0, q.a, PI / 2); this.roller.material.color.setHex(PIG[q.m]); }
    this.scene.background.setHex(pub.neg ? 0x08080c : 0x15130f);
  }
  drawHazards(s, pub) {
    const live = new Set();
    for (const h of s.hazards) {
      live.add(h.id); let o = this.hz.get(h.id);
      if (!o) { o = makeHazard(h); if (!o) continue; this.hz.set(h.id, o); this.scene.add(o.g); }
      const sh = h.shape; o.g.position.set(sh.x, 0.05 + (h.id % 7) * 0.002, sh.z); if (sh.dir !== undefined && sh.type !== 'circle' && sh.type !== 'donut') o.g.rotation.y = sh.dir;
      const colr = pub.neg ? 0xf4f4ff : (h.color === 0x16161e ? 0x2a2a40 : h.color || 0xff5a2a);
      o.base.material.color.setHex(colr); o.fill.material.color.setHex(colr);
      if (h.state === 'tele') { const kk = clamp(h.t / Math.max(h.delay, 1e-3), 0, 1); o.base.material.opacity = h.dmg ? 0.16 + 0.12 * kk : 0.12; o.fill.visible = !!h.dmg; o.setFill(kk); o.fill.material.opacity = 0.35; o.edge.material.opacity = h.dmg ? 0.9 : 0.4; o.edge.material.color.setHex(colr); }
      else if (h.state === 'zone') { o.base.material.opacity = h.dmg ? 0.42 : 0.18; o.fill.visible = false; o.edge.material.opacity = 0.6; }
      else if (h.state === 'fired') { o.base.material.opacity = 0.5; o.base.material.color.setHex(0xffffff); o.fill.visible = false; o.edge.material.opacity = 0; }
    }
    for (const [id, o] of this.hz) if (!live.has(id)) { this.scene.remove(o.g); o.dispose(); this.hz.delete(id); }
  }

  // ---------------- camera: Threshold's orbit rig (left drag look, right drag steer, wheel zoom), and cinematic shots
  updateCamera(dt, you, input) {
    const C = this.cam, me = you && this.heroes.get(you);
    if (input && !C.cine) { C.yaw -= input.lookX; C.pitch = clamp(C.pitch + input.lookY, -0.32, 1.42); if (input.zoom) C.tDist = clamp(C.tDist * (1 + input.zoom * 0.12), 4, 26); input.lookX = input.lookY = input.zoom = 0; }
    C.dist = lerp(C.dist, C.tDist, 1 - Math.exp(-10 * dt));
    let fx = 0, fy = 1.5, fz = 12;
    if (me) { fx = me.x; fy = Math.max(me.y, -3) + 1.55; fz = me.z; }
    else { const b = [...this.ents.values()].find((o) => o.boss); if (b) { fx = b.x; fz = b.z + 4; } C.tDist = 22; }
    const d = 1 - Math.exp(-22 * dt); C.focus.x = lerp(C.focus.x, fx, d); C.focus.z = lerp(C.focus.z, fz, d); C.focus.y = lerp(C.focus.y, fy, 1 - Math.exp(-10 * dt));
    const cp = Math.cos(C.pitch), sp = Math.sin(C.pitch);
    let px = C.focus.x - Math.sin(C.yaw) * cp * C.dist, py = C.focus.y + sp * C.dist, pz = C.focus.z - Math.cos(C.yaw) * cp * C.dist;
    if (py < 0.35) py = 0.35;
    // cinematic
    if (C.cine) { const c = C.cine; c.t += dt; const kk = smoothstep(c.t / c.dur); C.cPos.set(lerp(c.p0[0], c.p1[0], kk), lerp(c.p0[1], c.p1[1], kk), lerp(c.p0[2], c.p1[2], kk)); C.cLook.set(lerp(c.l0[0], c.l1[0], kk), lerp(c.l0[1], c.l1[1], kk), lerp(c.l0[2], c.l1[2], kk)); if (c.t > c.dur + 1.5) C.cine = null; }
    C.cineW = C.cine ? Math.min(1, C.cineW + dt * 2.5) : Math.max(0, C.cineW - dt * 1.4);
    const w = smoothstep(C.cineW), cam = this.camera;
    cam.position.set(lerp(px, C.cPos.x, w), lerp(py, C.cPos.y, w), lerp(pz, C.cPos.z, w));
    if (C.shake > 0.001) { const q = C.shake * 0.3; cam.position.x += (Math.random() - 0.5) * q; cam.position.y += (Math.random() - 0.5) * q; cam.position.z += (Math.random() - 0.5) * q; C.shake *= Math.exp(-dt * 6); }
    cam.lookAt(lerp(C.focus.x, C.cLook.x, w), lerp(C.focus.y, C.cLook.y, w), lerp(C.focus.z, C.cLook.z, w));
    document.body.classList.toggle('cine', w > 0.5);
  }

  // ---------------- cues (one-shot effects)
  cue(name, args, s) {
    const v = (q) => Array.isArray(q) ? q : [0, 0, 0];
    switch (name) {
      case 'atelier.lay': return this.lay(args[0]);
      case 'hero.swing': { const h = this.heroes.get(args[0]); if (h) h.m.swing(args[1], args[2]); return; }
      case 'fx.num': return this.num(v(args[0]), String(args[1]), args[2] || '');
      case 'fx.burst': { const o = args[3] || {}; return this.fx.burst(args[0], args[1], args[2], o); }
      case 'fx.impact': return this.fx.burst(args[0], args[1], args[2], { n: 18, color: args[3], speed: [2, 9], life: [0.2, 0.5] });
      case 'fx.explode': return this.fx.burst(args[0], args[1], args[2], { n: 50, color: args[3], speed: [3, 12], life: [0.3, 0.9] });
      case 'fx.lightning': return this.fx.bolt(v(args[0]), v(args[1]), (args[2] || {}).color || 0x9fe6ff, true);
      case 'fx.beam': return this.fx.bolt(v(args[0]), v(args[1]), (args[2] || {}).color || 0xffffff, false);
      case 'fx.ring': { const o = args[2] || {}; return this.fx.ring(args[0], args[1], o.r0 === undefined ? 0.5 : o.r0, o.r1 || 3, o.color || 0xffffff, o.dur || 0.4); }
      case 'fx.dome': { const o = args[3] || {}; return this.fx.ring(args[0], args[2], 0.3, o.r || 2, o.color || 0xffffff, o.dur || 0.35); }
      case 'fx.slash': { const o = args[4] || {}; return this.fx.slash(args[0], args[1], args[2], args[3], o.r || 2.7, o.color || 0xffffff, o.dur || 0.22); }
      case 'fx.pillar': { const o = args[2] || {}; return this.fx.ring(args[0], args[1], 0.1, (o.r || 1) * 1.4, o.color || 0xffffff, o.dur || 0.6); }
      case 'fx.shake': this.cam.shake = Math.max(this.cam.shake, Math.min(0.9, args[0] || 0)); return;
      case 'fx.flash': this.flashA = Math.min(0.75, args[1] || 0.3); this.flashFade = (args[2] || 2); if (this.flashEl) this.flashEl.style.background = css(args[0] || 0xffffff); return;
      case 'cam.shot': this.cam.cine = { p0: args[0], l0: args[1], p1: args[2], l1: args[3], dur: args[4] || 3, t: 0 }; return;
      case 'cam.release': this.cam.cine = null; return;
    }
  }
  num(p, text, kind) {
    const el = document.createElement('div'); el.className = 'num ' + kind; el.textContent = text; document.getElementById('nums').appendChild(el);
    this.nums.push({ el, x: p[0] + (Math.random() - 0.5) * 0.4, y: p[1], z: p[2], t: 0, life: kind === 'crit' ? 1.2 : 0.9 });
    if (this.nums.length > 60) { const o = this.nums.shift(); o.el.remove(); }
  }
  drawNums(dt) {
    const v = new THREE.Vector3(), W = innerWidth, H = innerHeight;
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i]; n.t += dt; if (n.t > n.life) { n.el.remove(); this.nums.splice(i, 1); continue; }
      v.set(n.x, n.y + n.t * 1.4, n.z).project(this.camera);
      if (v.z > 1) { n.el.style.display = 'none'; continue; }
      n.el.style.display = ''; n.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * W}px, ${(-v.y * 0.5 + 0.5) * H}px) translate(-50%, -50%)`; n.el.style.opacity = String(1 - Math.max(0, n.t / n.life - 0.6) / 0.4);
    }
  }
  // screen position of a world point (for name plates and click targeting)
  project(x, y, z) { const v = new THREE.Vector3(x, y, z).project(this.camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, on: v.z < 1 }; }
}

const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// a telegraph: a faint base of the whole shape, a fill that grows as it charges, and an edge
function makeHazard(h) {
  const s = h.shape, g = new THREE.Group(), mat = (o) => new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide });
  let geo, edgeGeo, setFill;
  const flat = (m) => { m.rotation.x = -PI / 2; return m; };
  if (s.type === 'circle') { geo = new THREE.CircleGeometry(s.r, 48); edgeGeo = new THREE.RingGeometry(Math.max(0, s.r - 0.12), s.r, 48); }
  else if (s.type === 'donut') { geo = new THREE.RingGeometry(s.r0, s.r1, 64); edgeGeo = new THREE.RingGeometry(s.r1 - 0.12, s.r1, 64); }
  else if (s.type === 'cone') { const t0 = -PI / 2 - s.arc / 2; geo = s.r0 ? new THREE.RingGeometry(s.r0, s.r, 40, 1, t0, s.arc) : new THREE.CircleGeometry(s.r, 40, t0, s.arc); edgeGeo = new THREE.RingGeometry(s.r - 0.12, s.r, 40, 1, t0, s.arc); }
  else if (s.type === 'rect') { geo = new THREE.PlaneGeometry(s.w, s.len); geo.translate(0, -s.len / 2, 0); edgeGeo = new THREE.EdgesGeometry(geo); }
  else return null;
  const base = flat(new THREE.Mesh(geo, mat(0.15))), fill = flat(new THREE.Mesh(geo, mat(0.35)));
  const edge = s.type === 'rect' ? flat(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.9 }))) : flat(new THREE.Mesh(edgeGeo, mat(0.9)));
  if (s.type === 'rect') setFill = (k) => { fill.scale.set(1, Math.max(0.001, k), 1); };
  else if (s.type === 'donut') setFill = (k) => { const r = lerp(s.r1, s.r0, k) / s.r1; fill.scale.setScalar(1); fill.visible = k > 0.01; fill.material.opacity = 0.12 + 0.25 * k; void r; };
  else setFill = (k) => { fill.scale.setScalar(Math.max(0.001, k)); };
  // the rect geometry runs from the origin along local -y, which after laying flat is world +z: rotation.y = dir points it
  g.add(base, fill, edge);
  return { g, base, fill, edge, setFill, dispose() { geo.dispose(); edgeGeo.dispose(); base.material.dispose(); fill.material.dispose(); edge.material.dispose(); } };
}

// ---------------- Pentimento, the lay figure (a stand-in for Threshold's carved model)
function layFigure(g) {
  const wood = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.55, emissive: 0x000000 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.5, metalness: 0.2 });
  const body = new THREE.Group(); g.add(body);
  const seg = (r, l, x, y, z, rx = 0, rz = 0, m = wood) => { const q = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 6, 14), m); q.position.set(x, y, z); q.rotation.set(rx, 0, rz); body.add(q); return q; };
  const ball = (r, x, y, z) => { const q = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), joint); q.position.set(x, y, z); body.add(q); return q; };
  seg(0.34, 1.0, -0.38, 1.0, 0); seg(0.34, 1.0, 0.38, 1.0, 0); ball(0.3, -0.38, 1.85, 0); ball(0.3, 0.38, 1.85, 0);
  seg(0.62, 0.7, 0, 2.6, 0); seg(0.75, 0.6, 0, 3.6, 0); ball(0.3, 0, 4.3, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 16), wood); head.scale.set(0.85, 1.1, 0.9); head.position.set(0, 4.95, 0); body.add(head);
  ball(0.26, -0.95, 3.95, 0); ball(0.26, 0.95, 3.95, 0);
  const armL = seg(0.22, 1.1, -1.15, 3.2, 0, 0, 0.25), armR = seg(0.22, 1.1, 1.2, 3.3, 0.3, -0.6, -0.2);
  const brush = new THREE.Group(); brush.position.set(1.5, 2.9, 0.8); body.add(brush);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5.2, 8), new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 0.6 })); handle.rotation.x = 0.9; brush.add(handle);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 10), new THREE.MeshStandardMaterial({ color: 0xe23a2e, roughness: 0.4 })); tip.position.set(0, 1.55, 2.05); tip.rotation.x = 0.9 + PI; brush.add(tip);
  const swirl = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.09, 8, 40), new THREE.MeshStandardMaterial({ color: 0xe23a2e, emissive: 0xe23a2e, emissiveIntensity: 0.4 })); swirl.rotation.x = PI / 2; body.add(swirl);
  let t = 0;
  return {
    update(dt, e, pub) {
      t += dt; const need = pub.split && pub.call ? pub.call.col : pub.col; const c = PIG[need || 1] || 0xffffff;
      tip.material.color.setHex(c); swirl.material.color.setHex(c); swirl.material.emissive.setHex(c);
      const tone = pub.split && pub.call ? (pub.call.tone === 'w' ? 0xf4efe6 : 0x1c1c22) : pub.neg ? 0x3a3a44 : 0xe8dcc4;
      wood.color.setHex(tone); wood.emissive.setHex(pub.flood ? 0x404040 : 0x000000);
      swirl.position.y = 0.6 + ((t * 0.8) % 1) * ((pub.top !== undefined ? pub.top : 7.5) * 0.6);
      body.rotation.x = pub.down > 0 ? -0.55 : 0; body.position.y = pub.down > 0 ? -0.6 : Math.sin(t * 1.3) * 0.05;
      brush.rotation.z = (pub.swing || 0) * -1.6; armR.rotation.z = -0.2 - (pub.swing || 0) * 0.9;
      void armL;
    },
  };
}

// ---------------- the training dummy: a post, a straw sack and a crossbar
function dummyModel(g) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.85 }), sack = new THREE.MeshStandardMaterial({ color: 0xc8a878, roughness: 1 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 3.6, 10), wood); post.position.y = 1.8; g.add(post);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.25, 16), wood); base.position.y = 0.12; g.add(base);
  const body = new THREE.Group(); body.position.y = 1.6; g.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.9, 6, 14), sack); torso.position.y = 0.4; body.add(torso);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 0.16), wood); bar.position.y = 0.85; body.add(bar);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), sack); head.position.y = 1.55; body.add(head);
  for (const y of [0.1, 0.65]) { const rope = new THREE.Mesh(new THREE.TorusGeometry(0.57, 0.04, 6, 24), new THREE.MeshStandardMaterial({ color: 0x5a4430 })); rope.rotation.x = PI / 2; rope.position.y = y; body.add(rope); }
  let wob = 0, lastHp = null;
  return {
    update(dt, e) {
      if (lastHp !== null && e.hp < lastHp) wob = Math.min(1, wob + 0.35); lastHp = e.hp;
      wob *= Math.exp(-dt * 5); body.rotation.x = Math.sin(HeroClock.now * 22) * 0.12 * wob; body.rotation.z = Math.cos(HeroClock.now * 17) * 0.08 * wob;
    },
  };
}

// ---------------- particles, bolts, rings
class Fx {
  constructor(scene) {
    const N = this.N = 3000; this.n = 0; this.p = new Float32Array(N * 3); this.v = new Float32Array(N * 3); this.life = new Float32Array(N); this.age = new Float32Array(N);
    const geo = this.geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3)); this.col = new Float32Array(N * 3); geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.points.frustumCulled = false; scene.add(this.points); this.scene = scene; this.lines = [];
  }
  burst(x, y, z, o = {}) {
    if (!Number.isFinite(x)) return;
    const n = Math.min(60, Math.round(o.n || 10)), c = new THREE.Color(o.color === undefined ? 0xffffff : o.color), c2 = new THREE.Color(o.color2 === undefined ? (o.color === undefined ? 0xffffff : o.color) : o.color2), sp = o.speed || [2, 6], lf = o.life || [0.3, 0.7];
    for (let i = 0; i < n; i++) {
      const k = this.n % this.N; this.n++;
      const a = Math.random() * TAU, u = Math.random() * 2 - 1, s = lerp(sp[0], sp[1], Math.random()), r = Math.sqrt(1 - u * u), rad = o.radius ? Math.random() * o.radius : 0;
      this.p[k * 3] = x + Math.cos(a) * rad; this.p[k * 3 + 1] = y; this.p[k * 3 + 2] = z + Math.sin(a) * rad;
      let vx = Math.cos(a) * r * s, vy = u * s + (o.up || 0), vz = Math.sin(a) * r * s;
      if (o.dir) { const sp2 = o.spread === undefined ? 0.5 : o.spread; vx = (o.dir[0] + (Math.random() - 0.5) * sp2) * s; vy = (o.dir[1] + (Math.random() - 0.5) * sp2) * s; vz = (o.dir[2] + (Math.random() - 0.5) * sp2) * s; }
      this.v[k * 3] = vx; this.v[k * 3 + 1] = vy; this.v[k * 3 + 2] = vz;
      const cc = Math.random() < 0.5 ? c : c2; this.col[k * 3] = cc.r; this.col[k * 3 + 1] = cc.g; this.col[k * 3 + 2] = cc.b;
      this.life[k] = lerp(lf[0], lf[1], Math.random()); this.age[k] = 0;
    }
  }
  bolt(a, b, color, jag) {
    const pts = []; const n = jag ? 9 : 2;
    for (let i = 0; i < n; i++) { const t = i / (n - 1), j = jag && i > 0 && i < n - 1 ? 0.5 : 0; pts.push(new THREE.Vector3(lerp(a[0], b[0], t) + (Math.random() - 0.5) * j, lerp(a[1], b[1], t) + (Math.random() - 0.5) * j, lerp(a[2], b[2], t) + (Math.random() - 0.5) * j)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending }));
    this.scene.add(line); this.lines.push({ o: line, t: 0, life: 0.18 });
  }
  ring(x, z, r0, r1, color, dur) {
    if (!Number.isFinite(x)) return;
    const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -PI / 2; m.position.set(x, 0.08, z); this.scene.add(m); this.lines.push({ o: m, t: 0, life: dur, r0, r1 });
  }
  slash(x, y, z, dir, r, color, dur) {
    if (!Number.isFinite(x)) return;
    const m = new THREE.Mesh(new THREE.RingGeometry(r * 0.75, r, 32, 1, -PI / 2 - 1.1, 2.2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const g = new THREE.Group(); m.rotation.x = -PI / 2; g.add(m); g.position.set(x, y, z); g.rotation.y = dir; this.scene.add(g); this.lines.push({ o: g, mat: m.material, t: 0, life: dur });
  }
  update(dt) {
    const N = Math.min(this.n, this.N);
    for (let k = 0; k < N; k++) {
      if (this.age[k] >= this.life[k]) { this.p[k * 3 + 1] = -100; continue; }
      this.age[k] += dt; this.v[k * 3 + 1] -= 6 * dt; this.v[k * 3] *= 0.98; this.v[k * 3 + 2] *= 0.98;
      this.p[k * 3] += this.v[k * 3] * dt; this.p[k * 3 + 1] = Math.max(0.03, this.p[k * 3 + 1] + this.v[k * 3 + 1] * dt); this.p[k * 3 + 2] += this.v[k * 3 + 2] * dt;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.color.needsUpdate = true; this.geo.setDrawRange(0, N);
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const L = this.lines[i]; L.t += dt; const k = L.t / L.life, mat = L.mat || L.o.material;
      if (k >= 1) { this.scene.remove(L.o); L.o.traverse((q) => { if (q.geometry) q.geometry.dispose(); }); mat.dispose(); this.lines.splice(i, 1); continue; }
      mat.opacity = 1 - k; if (L.r1 !== undefined) L.o.scale.setScalar(lerp(L.r0, L.r1, k) + 0.01);
    }
  }
}
