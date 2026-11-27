// Pentimento in the Axiom client: drives Threshold's own view half (atelier-look.js, imported unchanged by
// tools/import-atelier.js) from what the server sends. It never runs a rule.
//
// Threshold's look reads the boss state S (paint, colour, the Negative, the roller, the finale's seam and call...) that its
// rules wrote in the same object. Here the rules are on the server, so each frame this fills S from the snapshot's pub
// (blended between the two snapshots around the drawn moment where it moves: the seam's angle, the roller, the swirl's
// height) and lays every 'atelier.lay' cue on the canvas, then calls Threshold's lookUpdate. What Axiom adds:
//   - several players: everyone's worn paint shows as Threshold's aura (ring and drop) at their feet, not only yours
//   - a catch-up: a player who arrives mid-fight gets every stroke already down and the grade of the phase, at once
//   - the kill: Threshold's default kill (Normal) and the Nightmare "painting" kill, played on the client when the
//     server says he fell (the cinematic lock is the server's: its state 'win' locks every player)
//   - the varnish shell only when your side protects him (Threshold's own line for that sits inside a comment)
import { THREE, G, FX, Post, Cam, Co, camera } from './look.js';
import * as AL from './atelier-look.js';

const V3 = THREE.Vector3, TAU = Math.PI * 2, PI = Math.PI;
const lerp = (a, b, t) => a + (b - a) * t, damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const lerpAng = (a, b, t) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return a + d * t; };
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const COLOUR_POST = { tint: [1.02, 1.0, 0.98], sat: 1.12 }; // phase 2 opens ('Colour'), and the nightmare's own grade
const FIN_POST = { bloom: 0.28, threshold: 0.92, contrast: 1.08, exposure: 0.95, tint: [1.0, 1.0, 1.0], sat: 1.1 };
const KILL_POST = { bloom: 0.24, threshold: 0.96, contrast: 1.04, exposure: 0.92, tint: [1.02, 1.0, 0.98], sat: 1.12 };
export const ATELIER_POST = AL.POST;
export const ATELIER_NM_POST = Object.assign({}, AL.POST, COLOUR_POST);

export class AtelierView {
  // world: the arena group (Threshold's G.world); nm: the Nightmare version (builds the finale's look up front)
  constructor(world, nm) {
    G.world = world; G.nightmare = !!nm; G.headless = false;
    const group = new THREE.Group(); group.name = 'pentimento'; world.add(group);
    this.b = { state: {}, pos: new V3(0, 0, -3), group, castState: null, alive: true, facing: 0, radius: 1.5, aimY: 3.6 };
    this.arena = AL.build(this.b);
    const S = this.S = this.b.state; S.vk = 0;
    this.auras = new Map(); this.first = true; this.dying = null; this.lastWash = null; this.lastRoll = null; this.dryT = 0;
    // one hidden Blot per pigment, so the warm-up compiles their material and shadow programs before the fight
    this.warmBlots = S.blotM.map((m) => { const o = new THREE.Mesh(S.blotG, m); o.castShadow = true; o.visible = false; o.position.set(0, -40, 0); world.add(o); return o; });
  }
  get group() { return this.b.group; }

  // ---------------- paint
  // a stroke from the server ('atelier.lay'): Threshold's lay(), minus the grid (rules) and with the server's seed and time
  lay(sh) {
    const S = this.S; if (!sh || !sh.t) return;
    S.strokes.push(sh); S.fresh.push(sh);
    if (S.strokes.length > 110) { S.baked.push(S.strokes.shift()); if (S.baked.length > 400) S.baked.shift(); S.full = true; }
  }
  // the catch-up for a newcomer: every stroke already down, in order, and the grade of the phase now playing
  catchUp(c, pub, nm) {
    const S = this.S;
    S.baked = (c.baked || []).slice(); S.strokes = (c.strokes || []).slice(); S.fresh.length = 0;
    S.full = S.reset = S.now = true; this.first = true;
    if (pub) Post.set(grade(pub, nm));
  }

  // ---------------- one frame
  // s, sa: the snapshots around the drawn moment and k the blend; boss: the boss's drawn body ({x, z, facing}); focus: the player
  // the camera follows ({pos, alive}) or null; you: your id; heroes: the drawn heroes (id -> {x, y, z, g}); dt: drawn seconds
  update(dt, s, sa, k, boss, focus, you, heroes) {
    const S = this.S, b = this.b, pub = s.boss.pub || {}, pa = (sa.boss && sa.boss.pub) || pub, nm = !!s.nm, D = this.dying;
    const eb = s.ents.find((e) => e.boss);
    if (boss) { b.pos.set(boss.x, 0, boss.z); b.facing = boss.facing; }
    b.castState = eb && eb.cast ? eb.cast : null; b.alive = !eb || eb.alive;
    // the world's state
    const neg = D ? false : !!pub.neg, split = D ? 0 : (pub.split || 0);
    if (neg !== S.neg || split !== S.split) { S.full = S.reset = true; }
    S.neg = neg; S.split = split; S.fin = split ? 1 : 0;
    S.col = pub.col || 1; S.lvl = pub.lvl || 0; S.lookT = D ? 1 : (pub.look || 0);
    if (this.first) S.look = S.lookT; // a newcomer sees the phase's look at once, not the slow turn into it
    S.down = pub.down || 0; S.crit = pub.crit || 0; S.flood = pub.flood || 0; S.swing = Math.max(S.swing || 0, lerp(pa.swing || 0, pub.swing || 0, k));
    if (pub.wash) { const w = pub.wash, l = this.lastWash; if (!l || l.x !== w.x || l.z !== w.z) { if (l) S.washK = 0; this.lastWash = w; } S.wash = w; }
    const q = pub.roll, qa = pa.roll;
    if (q) { if (this.lastRoll !== q.m || !S.roll) S.rollM.color.setHex(AL.HEX[q.m]); this.lastRoll = q.m; S.roll = { a: q.a, fx: Math.sin(q.a), fz: Math.cos(q.a), cx: q.cx, cz: q.cz, s: qa && qa.a === q.a ? lerp(qa.s, q.s, k) : q.s, v: 11, m: q.m }; }
    else { S.roll = null; this.lastRoll = null; }
    if (nm) {
      S.lineA = pa.lineA !== undefined ? lerpAng(pa.lineA, pub.lineA || 0, k) : (pub.lineA || 0);
      S.call = D ? null : pub.call || null; S.seamOn = D ? D.seamOn : !!pub.seamOn; S.seamP = pub.seamP === undefined ? 1 : pub.seamP; S.seamW = D ? D.seamW : (pub.seamW === undefined ? 1 : pub.seamW);
      S.varnR = pub.varnR === undefined ? 99 : pub.varnR; S.top = lerp(pa.top === undefined ? 7.5 : pa.top, pub.top === undefined ? 7.5 : pub.top, k); S.sig = pub.sig || 0;
    }
    // what you wear (Threshold's aura follows the one player it has: here the one the camera follows)
    const fw = focus && pub.pw && pub.pw[focus.id];
    S.wear = fw ? fw.wear : 0; S.wearK = fw ? Math.max(S.wearK || 0, fw.wearK) : 0;
    // paint dries (the rules do the same on the server; this is the picture's copy)
    this.dryT -= dt; if (this.dryT <= 0) { this.dryT = 0.5; for (const L of [S.strokes, S.baked]) for (const sh of L) if (!sh.dry && sh.m && G.ft - sh.t0 > AL.WET) { sh.dry = true; S.full = true; } }
    G.player = focus ? { pos: focus.pos, alive: focus.alive !== false } : null;
    AL.lookUpdate(b, dt);
    this.first = false;
    // the varnish shell: only while you stand in the half that protects him (nightmare finale)
    const shell = !D && !!(fw && fw.shell) && S.down <= 0;
    S.vk = damp(S.vk, shell ? 1 : 0, 6, dt); S.varn.visible = S.vk > 0.02; S.varnU.uA.value = S.vk; S.varn.rotation.y += dt * 0.3;
    this.partyAuras(s, pub, focus, heroes);
  }
  // everyone else's paint: a copy of Threshold's aura (same material kind, so no new shader) at their feet
  partyAuras(s, pub, focus, heroes) {
    const S = this.S, seen = new Set(), t = G.now;
    for (const p of s.players) {
      if (focus && p.id === focus.id) continue; const w = pub.pw && pub.pw[p.id], h = heroes.get(p.id); if (!h || !w || !w.wear || !p.alive) continue;
      seen.add(p.id); let a = this.auras.get(p.id);
      if (!a) { const m = S.auraM.clone(); const g = S.aura.clone(true); g.traverse((o) => { if (o.isMesh) o.material = m; }); g.visible = true; G.world.add(g); a = { g, m, drop: g.children[1] }; this.auras.set(p.id, a); }
      a.g.visible = true; a.g.position.set(h.x, 0, h.z); a.drop.position.y = h.y + 2.75 + Math.sin(t * 3 + p.id) * 0.08;
      a.m.color.setHex(AL.HEX[w.wear]).multiplyScalar(S.neg ? 1.5 : 1 + (w.wearK || 0) * 0.6); a.g.scale.setScalar(1 + (w.wearK || 0) * 0.5);
    }
    for (const [id, a] of this.auras) if (!seen.has(id)) a.g.visible = false;
  }
  // a Blot: Threshold's glossy dark drop with its pigment glowing through, squashing as it rolls
  blot(g, e) {
    const S = this.S, i = [AL.RED, AL.YEL, AL.BLU].findIndex((m) => AL.HEX[m] === e.color), mesh = new THREE.Mesh(S.blotG, S.blotM[Math.max(0, i)]);
    mesh.position.y = 0.7; mesh.castShadow = true; g.add(mesh);
    return { update() { mesh.scale.set(1 + Math.sin(G.now * 7) * 0.12, 0.8 - Math.sin(G.now * 7) * 0.1, 1 + Math.cos(G.now * 6) * 0.12); } };
  }

  // ---------------- the kill (Threshold: 10_game.js onBossDead, and the nightmare's paintingDeath)
  // slow(k, dur): the client's world slow-down (Threshold sets G.timeScale = 0.3 for the kill)
  kill(nm, slow) {
    if (this.dying) return; const b = this.b, S = this.S; this.dying = { seamOn: !!S.seamOn, seamW: 1 };
    FX.flash(0xffffff, 0.5, 1.2);
    if (nm) {
      const D = this.dying; slow(0.3, 0.35 / 0.3 * 1.05);
      Co.start(function* () {
        let t = 0; while (t < 0.35) { t += G.dt; D.seamW = 1 - smooth(Math.min(1, t / 0.35)); yield; }
        D.seamOn = false; FX.flash(0xffe0b0, 0.4, 1.5); yield* Post.lerpTo(KILL_POST, 1.5);
      }(), 'look');
      Co.start(function* () {
        yield 0.36; const c = camera.position; yield* Cam.shot([c.x, c.y, c.z], [b.pos.x, 2, b.pos.z], [0, 46, 4], [0, 0, 0.4], 2.8, 52);
        const hold = { pos: new V3(0, 46, 4), look: new V3(0, 0, 0.4), fov: 52 }; Cam.cine = hold; // and stays on it as a painting
      }(), 'look');
      return;
    }
    slow(0.3, 9 * 0.11 + 0.5);
    Co.start(function* () {
      const a = Cam.yaw + 0.6, r = b.radius * 2 + 10, tv = new V3(); Cam.cine = { pos: new V3(b.pos.x - Math.sin(a) * r, b.aimY + 3, b.pos.z - Math.cos(a) * r), look: new V3(b.pos.x, b.aimY, b.pos.z), fov: 44 };
      for (let i = 0; i < 9; i++) { tv.set(b.pos.x, b.aimY, b.pos.z); FX.explode(tv.x + (Math.random() - 0.5) * b.radius * 2, tv.y + (Math.random() - 0.5) * b.aimY, tv.z + (Math.random() - 0.5) * b.radius * 2, AL.INK, 4 + i * 0.6, 0xffffff); yield 0.11; }
      b.group.visible = false; FX.explode(b.pos.x, b.aimY, b.pos.z, 0xffffff, 14, AL.INK); FX.flash(0xffffff, 0.6, 1); yield 0.5;
    }(), 'look');
  }
}

// the grade the phase now playing has reached (for a newcomer, who missed the regrades as they happened)
function grade(pub, nm) {
  const g = Object.assign({}, nm ? ATELIER_NM_POST : AL.POST);
  if (!nm && pub.lvl >= 1) Object.assign(g, COLOUR_POST);
  if (pub.neg) Object.assign(g, AL.NEG_POST);
  if (nm && pub.split) Object.assign(g, FIN_POST);
  return g;
}
