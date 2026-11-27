// Issen in the Axiom client: drives Threshold's own view half (duelist-look.js, imported unchanged by tools/import-duelist.js)
// from what the server sends. It never runs a rule.
//
// Threshold's look reads the boss state S (kneel, the tell, Stillness, the opening, haste, the ghosts, the calm places, the
// reflection and who is awake...) that its rules wrote in the same object. Here the rules are on the server, so each frame this
// fills S from the snapshot's pub (blended between the two snapshots around the drawn moment where it moves: the kneel, the
// reflection's climb and walk, the seam), turns the duelist.* cues into the calls the rules used to make (the brush strokes
// along a telegraph, the cut ribbons, the Moons' arcs, the swings, the sunset and nightfall regrades), and calls Threshold's
// lookUpdate. What Axiom adds:
//   - a catch-up: a player who arrives mid-fight sees the phase's sky, lake and seam at once (from pub), not the slow turn
//   - the kill: Threshold's default kill (Normal) and the Nightmare's nitenDeath, played on the client when the server says he
//     fell (the cinematic lock is the server's: its state 'win' locks every player)
import { THREE, G, FX, Post, Cam, Co, W, camera } from './look.js';
import * as DL from './duelist-look.js';

const V3 = THREE.Vector3, TAU = Math.PI * 2, PI = Math.PI;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAng = (a, b, t) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return a + d * t; };
// the grades the rules lerp to (22_boss_duelist.js): phase 2's deepening, the nightfall, Final Verse's drained look
const DEEP_POST = { bloom: 0.46, sat: 1.14 };
const NIGHT_POST = { bloom: 0.5, threshold: 1.0, tint: [0.96, 0.98, 1.06], exposure: 1.1, sat: 1.05, vig: 0.78, lift: [0.012, 0.012, 0.024] };
export const DUELIST_POST = DL.POST;
export const DUELIST_NM_POST = Object.assign({}, DL.POST, DEEP_POST); // Threshold's nightmare.post: the fight opens at sunset

export class DuelistView {
  // world: the arena group (Threshold's G.world); nm: the Nightmare version (builds the reflection and the calm places up front)
  constructor(world, nm) {
    G.world = world; G.nightmare = !!nm; G.headless = false;
    const group = new THREE.Group(); group.name = 'issen'; world.add(group);
    this.b = { state: {}, pos: new V3(0, 0, -5), group, castState: null, alive: true, facing: 0, radius: 0.9, aimY: 1.6, phase: 0, targetable: true,
      distToPlayer() { const p = G.player; return p ? Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z) : 99; },
      angToPlayer() { const p = G.player; return p ? Math.atan2(p.pos.x - this.pos.x, p.pos.z - this.pos.z) : this.facing; } };
    this.arena = DL.build(this.b);
    const S = this.S = this.b.state;
    this.nm = !!nm; this.first = true; this.dying = false; this.lanes = new Map(); this.eyeT0 = null; this.rip = null; this.w0 = null; this.under = false; this.ox = 0; this.oz = -5;
    this.rProxy = new THREE.Group(); // what view.js moves for the reflection's fight body (the drawn body is S.R.root, placed here)
  }
  get group() { return this.b.group; }
  // the bodies view.js keeps per entity: Issen's own group (built with the lake), the reflection's stand-in
  entFor(e) { return e.boss ? { g: this.b.group, boss: true, own: true } : e.ow ? { g: this.rProxy, own: true } : null; }

  // ---------------- one frame
  // s, sa: the snapshots around the drawn moment and k the blend; boss: the boss's drawn body ({x, z, facing}); focus: the player
  // the camera follows ({pos, alive}) or null; dt: drawn seconds
  update(dt, s, sa, k, boss, focus) {
    const S = this.S, b = this.b, pub = s.boss.pub || {}, pa = (sa.boss && sa.boss.pub) || pub, Rr = S.R;
    const eb = s.ents.find((e) => e.boss);
    this.ox = b.pos.x; this.oz = b.pos.z;
    if (boss) { b.pos.set(boss.x, 0, boss.z); b.facing = boss.facing; }
    b.castState = eb && eb.cast ? eb.cast : null; b.alive = !eb || eb.alive; b.phase = s.boss.phase;
    // the fight's state
    if (!this.dying) {
      b.group.visible = pub.showA !== false; if (S.weapon) S.weapon.visible = !pub.sheath;
      S.kneel = lerp(pa.kneel || 0, pub.kneel || 0, k); S.fake.parryT = pub.parry ? 1 : 0;
      S.warn = pub.warn ? Math.max(S.warn || 0, 0.001) : 0; S.still = !!pub.still; S.open = pub.open ? 1 : 0;
      S.haste = pub.haste || 0; S.niten = !!pub.niten; S.verse = !!pub.verse; S.tellT = pub.tellT || DL.STILL_TELL; S.lake = !!pub.lake;
    }
    this.ghosts(pub);
    this.moods(pub, pa, k, s);
    if (Rr && !this.dying) this.twins(pub, pa, k, s);
    // the petals: Threshold draws its blossom orbs over the shared bullet cores, from the same list
    const L = DL.Bul.list; L.length = 0; const prev = new Map(); for (const q of sa.bullets) if (q.p) prev.set(q.id, q);
    for (const q of s.bullets) { if (!q.p) continue; const qa = prev.get(q.id) || q; L.push({ petal: q.p, r: q.r, t: lerp(qa.t, q.t, k), x: lerp(qa.x, q.x, k), y: q.y === undefined ? 1.1 : q.y, z: lerp(qa.z, q.z, k) }); }
    G.player = focus ? { pos: focus.pos, alive: focus.alive !== false } : null;
    if (this.dying && G.timeScale && G.timeScale !== 1 && this.slow) this.slow(G.timeScale, 0.2); // nitenDeath's slow time
    DL.lookUpdate(b, dt, this.ox, this.oz);
    this.first = false;
  }
  // the ghosts: one slot each (6, or 10 on Nightmare), shown where the server keeps a standing cut
  ghosts(pub) {
    const S = this.S, list = pub.ghosts || [];
    S.ghosts.forEach((gh, i) => {
      const c = list[i] || null, was = gh.cut;
      if (!c) { if (was) { gh.cut = null; gh.g.visible = false; } return; }
      if (!was || was.x !== c.x || was.z !== c.z || was.dir !== c.dir || was.blue !== c.blue) { // Threshold's addGhost, minus the mark (a hazard, drawn by view.js)
        gh.cut = c; gh.g.visible = true; gh.g.position.set(c.x, 0, c.z); gh.g.rotation.y = c.dir; gh.g.userData.mat.uniforms.uC.value.set(c.blue ? DL.BLUE : DL.ROSE).multiplyScalar(1.1);
      }
    });
  }
  // the sky and the lake: the sunset deepening and the nightfall come as cues (their tweens play here); a newcomer gets the
  // phase's look at once. The lake's seam and the glass-flat water follow the server's own numbers.
  moods(pub, pa, k, s) {
    const S = this.S, b = this.b;
    if (this.first) {
      if (pub.deep && !this.nm) DL.deepenFn(b)(1);
      if (pub.night) DL.nightfallFn(b)(1);
      if (pub.lake) DL.lakeSkip(b);
      Post.set(grade(pub, this.nm));
    }
    if (this.dying) return;
    if (this.nm && (pub.lakeK > 0 || pub.lake)) {
      if (this.w0 === null) this.w0 = S.windU.value;
      S.seam.visible = true; S.seamP.value = pub.lake ? 1 : lerp(pa.seamP || 0, pub.seamP || 0, k); S.EU.uCalm.value = pub.lake ? 1 : pub.lakeK; S.windU.value = lerp(this.w0, 0.08, pub.lake ? 1 : pub.lakeK);
    }
  }
  // Niten: who is awake and who is still, the reflection's body (its climb out of the lake, then wherever the server has it),
  // the two-coloured deck, the ripple, the calm places
  twins(pub, pa, k, s) {
    const S = this.S, Rr = S.R, P = pub.R, Pa = (pa && pa.R) || P; if (!P) return;
    S.lead = pub.lead === 'R' ? Rr : S.A;
    const A = pub.A || {};
    S.A.still = !!A.still; S.A.warn = A.warn ? Math.max(S.A.warn || 0, 0.001) : 0; S.A.open = A.open ? 1 : 0; S.A.fake.parryT = A.parry ? 1 : 0;
    Rr.still = !!P.still; Rr.warn = P.warn ? Math.max(Rr.warn || 0, 0.001) : 0; Rr.open = P.open ? 1 : 0; Rr.fake.parryT = P.parry ? 1 : 0;
    Rr.kneel = lerp(Pa.kneel || 0, P.kneel || 0, k); Rr.img = P.img || 0; Rr.root.visible = !!P.shown; Rr.D.weapon.visible = !P.sheath;
    Rr.ent.targetable = !!P.shown;
    // the image under the water: drawn over the lake, clipped at the water line (Threshold's nitenEnter)
    const rt = Rr.root, root = P.root || {}, ra = Pa.root || root;
    if (!!root.under !== this.under) {
      this.under = !!root.under;
      if (this.under) { Rr.clipU.value.set(-0.3, 1); for (const m of Rr.mats) m.depthTest = false; rt.traverse((o) => { if (o.isMesh) o.renderOrder = 2; }); }
      else { Rr.clipU.value.set(0, 0); for (const m of Rr.mats) m.depthTest = true; rt.traverse((o) => { if (o.isMesh) o.renderOrder = 0; }); Rr.aura.renderOrder = 0; Rr.veil.renderOrder = 12; }
    }
    // the fight body (and its walk to the mark) is the server's Rr.ent; before that, the image's own pose
    Rr.live = !!P.live;
    if (Rr.live) { Rr.ent.pos.set(lerp(Pa.x, P.x, k), 0, lerp(Pa.z, P.z, k)); Rr.ent.facing = lerpAng(Pa.f, P.f, k); this.rProxy.position.copy(Rr.ent.pos); }
    else if (P.shown) { rt.position.set(root.x || 0, lerp(ra.y || 0, root.y || 0, k), lerp(ra.z || 0, root.z || 0, k)); rt.rotation.set(0, root.ry || 0, 0); rt.scale.set(1, root.flip || 1, 1); }
    if (S.duoL) { const d = pub.duoK || 0; S.duoL[0].intensity = 46 * d; S.duoL[1].intensity = 70 * d; }
    // the ripple where the reflection broke the surface
    if (pub.rip && (!this.rip || this.rip.t !== pub.rip.t)) { this.rip = pub.rip; S.EU.uRip.value.set(pub.rip.x, pub.rip.z, G.now - (s.t - pub.rip.t)); }
    this.calm(pub);
  }
  // the calm places: Threshold's addLane picture for each lane the server keeps (times moved onto this clock), and the Eye
  calm(pub) {
    const S = this.S, now = pub.now === undefined ? 0 : pub.now, seen = new Set();
    for (const q of pub.lanes || []) {
      seen.add(q.id); let L = this.lanes.get(q.id);
      if (!L) {
        L = { id: q.id, x: q.x, z: q.z, dir: q.dir, len: q.len, w: q.w, leave: q.leave, t0: G.now - (now - q.t0), until: G.now + (q.until - now) }; this.lanes.set(q.id, L);
        const m = S.laneM[S.laneI = (S.laneI + 1) % S.laneM.length]; m.userData.L = L; m.position.set(L.x + Math.sin(L.dir) * L.len / 2, 0.022, L.z + Math.cos(L.dir) * L.len / 2); m.rotation.y = L.dir; m.scale.set(L.w, 1, L.len + 1.2); m.material.uniforms.uLen.value = L.len; m.material.uniforms.uC.value.set(q.blue ? 0xb8ccff : 0xffe0ea);
      }
      L.leave = q.leave; L.until = G.now + (q.until - now);
    }
    for (const id of [...this.lanes.keys()]) if (!seen.has(id)) this.lanes.delete(id);
    S.lanes = [...this.lanes.values()];
    const E = pub.eye;
    if (E) {
      if (this.eyeT0 !== E.t0) { this.eyeT0 = E.t0; S.eyeM.position.set(E.x, 0.024, E.z); S.eyeM.material.uniforms.uC.value.set(E.blue ? 0xb8ccff : 0xffe0ea); }
      S.eye = { x: E.x, z: E.z, r: E.r, t0: G.now - (now - E.t0), until: G.now + (E.until - now), blue: E.blue };
    } else { S.eye = null; this.eyeT0 = null; }
  }

  // ---------------- cues: what the rules used to draw themselves
  cue(name, a) {
    const b = this.b, S = this.S;
    switch (name) {
      case 'duelist.vTele': DL.vTele(b, a[0], a[1], a[2], a[3], a[4], a[5]); return;
      case 'duelist.vCut': DL.vCut(b, a[0], a[1], a[2], a[3], a[4]); return;
      case 'duelist.cutFx': DL.cutFx(b, a[0], a[1], a[2], a[3], a[4]); return;
      case 'duelist.vArcs': DL.vArcs(b, a[0], a[1], a[2], a[3], a[4]); return;
      case 'duelist.swing': { const m = a[0] === 'R' ? S.R && S.R.model : S.model; if (m) m.swing(a[1], a[2]); return; }
      case 'duelist.deepen': Co.start(W.tween(a[0] || 0, DL.deepenFn(b)), 'look'); return;
      case 'duelist.night': Co.start(W.tween(a[0] || 0, DL.nightfallFn(b)), 'look'); return;
      case 'duelist.lastPetal': { const c = camera.position, f = camera.getWorldDirection(new V3()); FX.burst(c.x + f.x * 2.4, c.y + 0.9, c.z + f.z * 2.4, { n: 1, color: DL.PALE, color2: DL.ROSE, speed: [0.05, 0.2], life: [3.2, 3.4], size: [0.16, 0.18], grav: 0.35, drag: 2.5 }); return; }
    }
  }

  // ---------------- the kill (Threshold: 10_game.js onBossDead, and the Nightmare's nitenDeath)
  // slow(k, dur): the client's world slow-down (Threshold sets G.timeScale = 0.3 for the kill; nitenDeath takes it to 0.5)
  kill(nm, slow) {
    if (this.dying) return; const b = this.b; this.dying = true; this.slow = slow;
    FX.flash(0xffffff, 0.5, 1.2);
    if (nm) {
      G.timeScale = 0.3; slow(0.3, 0.2);
      Co.start(function* () { yield* DL.nitenDeath(b); G.timeScale = 1; slow(1, 0.01); }(), 'look');
      return;
    }
    slow(0.3, (9 * 0.11 + 0.5) / 0.3); // Threshold's 0.3 time scale holds until the last blast (real seconds here)
    Co.start(function* () {
      const a = Cam.yaw + 0.6, r = b.radius * 2 + 10; Cam.cine = { pos: new V3(b.pos.x - Math.sin(a) * r, b.aimY + 3, b.pos.z - Math.cos(a) * r), look: new V3(b.pos.x, b.aimY, b.pos.z), fov: 44 };
      for (let i = 0; i < 9; i++) { FX.explode(b.pos.x + (Math.random() - 0.5) * b.radius * 2, b.aimY + (Math.random() - 0.5) * b.aimY, b.pos.z + (Math.random() - 0.5) * b.radius * 2, DL.ROSE, 4 + i * 0.6, 0xffffff); yield 0.11; }
      b.group.visible = false; FX.explode(b.pos.x, b.aimY, b.pos.z, 0xffffff, 14, DL.ROSE); FX.flash(0xffffff, 0.6, 1); yield 0.5;
    }(), 'look');
  }
}

// the grade the phase now playing has reached (for a newcomer, who missed the regrades as they happened)
function grade(pub, nm) {
  const g = Object.assign({}, nm ? DUELIST_NM_POST : DL.POST);
  if (pub.deep) Object.assign(g, DEEP_POST);
  if (pub.night) Object.assign(g, NIGHT_POST);
  if (pub.verse) Object.assign(g, { sat: 0.75, vig: 1.05 });
  return g;
}
