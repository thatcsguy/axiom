// Your own character, predicted: it moves, casts and spends the moment you press, from the same Player code the server runs
// (packages/sim/src/predict.js), while the server stays the authority.
//
// - Fixed step: the predictor runs the sim's own 30 Hz tick. Each tick samples your input into a frame stamped with that
//   tick, steps the predictor, and sends the frame (with the two before it, so a late message costs nothing). Drawing blends
//   the last two predicted ticks, so the hero moves smoothly at any frame rate.
// - Clock: the predicted tick runs ahead of the server by `lead` ticks, so frames arrive just before the server needs them.
//   The server reports how early they arrive (ia, the lower tenth of the last two seconds); the lead drifts toward one tick
//   of slack. Like the render clock, the predicted clock never jumps: it runs up to 6% fast or slow.
// - Reconciliation: each snapshot carries the server's state of your character at its tick T. The predictor takes it and
//   replays the frames after T. Where nothing in the world touched you, the replay lands exactly where the prediction was
//   (test/predict.test.js); where something did (a hit, a knockback, paint), the drawn position does not snap: the difference
//   is kept as an offset that fades out over about 0.1 s (more than 3 m is a teleport and is taken at once).
// - Cast bar: your cast's progress comes from the predicted ticks, blended; a correction to it fades out the same way.
// - Immediate feedback: the cues your own skills raise (swings, slashes, lightning, heal numbers) play when you press, from
//   the prediction. The server's copies of them (same cue, within a few ticks) are dropped when they arrive; anything else
//   it raises for you (damage numbers, a parry, a hit on you) plays as usual, in step with the world.
import { Predictor, playerSnap } from '../../sim/src/index.js';
import '../../sim/src/bosses/index.js';

const lerp = (a, b, t) => a + (b - a) * t, TAU = Math.PI * 2;
const lerpAng = (a, b, t) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return a + d * t; };
const SNAP_DIST = 3, FADE = 0.1, IA_WANT = 1.5, MAX_STEPS = 12;

export class SelfSim {
  // o: { net, you, boss, nm, cls, sample: () => frame, cue: (name, args) => void }
  constructor(o) {
    this.net = o.net; this.you = o.you; this.sample = o.sample; this.cue = o.cue; this.hz = o.net.hz;
    this.pred = new Predictor({ boss: o.boss, nm: o.nm, cls: o.cls, id: o.you, hz: this.hz });
    this.tick = null; this.clock = 0; this.lead = 3; this.frames = new Map(); this.last = null; this.prev = null; this.cur = null;
    this.off = { x: 0, y: 0, z: 0 }; this.castOff = 0; this.pending = []; this.world = null; this.ready = false; this.bot = false;
    this.corr = []; this.lastCorr = 0; this.castCorr = 0; this.ia = null; this.late = 0; this.miss = 0; this.mispredicts = 0;
  }
  // a snapshot with your state in it (me: { k, cls, bot, st, ia, late, miss }; s: the shared snapshot of the same tick)
  own(me, s) {
    this.world = s; this.ia = me.ia; this.late = me.late; this.miss = me.miss; this.bot = !!me.bot;
    if (me.cls !== this.pred.cls) { this.pred.setClass(me.cls, this.you); this.tick = null; }
    if (this.bot) { this.ready = false; this.tick = null; return; } // the autopilot plays you: the server's picture is the truth
    // the lead: how early our frames reach the server, steered toward IA_WANT ticks of slack
    if (me.ia !== null && me.ia !== undefined && this.tick !== null) this.lead = Math.max(1, Math.min(30, this.lead + Math.max(-2, Math.min(3, IA_WANT - me.ia)) * 0.03));
    const now = this.net.serverNow();
    if (this.tick === null || me.k > this.tick || me.k < this.tick - 90) { // first state, or the prediction fell behind the server
      this.lead = Math.max(this.lead, (this.net.rtt || 0.05) * this.hz + 2);
      this.setWorld(s); this.pred.load(me.st); this.tick = me.k; this.clock = Math.max(me.k, now + this.lead);
      this.prev = this.cur = this.snap(); this.frames.clear(); this.ready = true; this.off.x = this.off.y = this.off.z = 0; return;
    }
    this.reconcile(me, s);
  }
  setWorld(s) { this.pred.world(s.ents); this.pred.scene(s.state, s.cine, s.t); }
  snap() { const p = this.pred.p, q = playerSnap(p); q.cast = p.casting ? { i: p.casting.i, t: p.casting.t, time: p.casting.time, name: p.casting.name } : null; return q; }
  // the drawn position of a prev / cur pair at blend a
  static pose(A, B, a) { return { x: lerp(A.x, B.x, a), y: lerp(A.y, B.y, a), z: lerp(A.z, B.z, a) }; }
  reconcile(me, s) {
    const a = this.alpha(), bc = this.cur && this.cur.cast, before = SelfSim.pose(this.prev || this.cur, this.cur, a);
    this.setWorld(s); this.pred.load(me.st);
    let prev = this.prev;
    for (let t = me.k + 1; t <= this.tick; t++) { if (t === this.tick) prev = this.snap(); this.pred.step(this.frames.get(t) || this.last || { mx: 0, mz: 0, held: 0, press: [] }, null); }
    for (const k of this.frames.keys()) if (k <= me.k) this.frames.delete(k);
    const cur = this.snap(), after = SelfSim.pose(prev || cur, cur, a);
    const dx = before.x - after.x, dy = before.y - after.y, dz = before.z - after.z, d = Math.hypot(dx, dy, dz);
    if (d > 1e-4) {
      this.mispredicts++; this.lastCorr = d; this.corr.push({ at: performance.now(), d }); if (this.onCorr) this.onCorr(d);
      if (d > SNAP_DIST) { this.off.x = this.off.y = this.off.z = 0; } else { this.off.x += dx; this.off.y += dy; this.off.z += dz; }
    }
    // the cast bar: the same cast moved in time -> keep the bar where it was and let the difference fade
    const cc = cur.cast;
    if (bc && cc && bc.i === cc.i && Math.abs(bc.t - cc.t) > 1e-6) { this.castOff += bc.t - cc.t; this.castCorr = Math.abs(bc.t - cc.t); }
    else if (!cc || !bc || bc.i !== cc.i) this.castOff = 0;
    this.prev = prev; this.cur = cur;
  }
  // per drawn frame: advance the predicted clock, run the ticks it passed
  update(dt) {
    if (!this.ready) return;
    const now = this.net.serverNow(); if (now === null) return;
    const target = now + this.lead, err = target - this.clock;
    if (Math.abs(err) > 12) this.clock = target; else this.clock += dt * this.hz * (1 + Math.max(-0.06, Math.min(0.06, err * 0.2)));
    let n = 0;
    while (this.tick < this.clock && n++ < MAX_STEPS) this.stepOnce();
    if (this.tick < this.clock - 1) this.clock = this.tick; // a long stall (a hidden tab): do not race to catch up
    const k = Math.exp(-dt / FADE); this.off.x *= k; this.off.y *= k; this.off.z *= k; this.castOff *= k;
    while (this.corr.length && this.corr[0].at < performance.now() - 5000) this.corr.shift();
    while (this.pending.length && this.pending[0].tick < this.tick - 60) this.pending.shift();
  }
  stepOnce() {
    const t = this.tick + 1, f = this.sample(); this.frames.set(t, f); this.last = f;
    const fs = []; for (let i = t - 2; i <= t; i++) if (this.frames.has(i)) fs.push(this.frames.get(i)); else if (fs.length) fs.push(f);
    this.net.send({ t: 'frames', k: t, fs });
    if (this.world) this.setWorld(this.world);
    this.prev = this.cur;
    this.pred.step(f, (name, args) => { this.pending.push({ name, tick: t }); this.cue(name, args); });
    this.cur = this.snap(); this.tick = t;
  }
  // a cue from the server: false when it is the server's copy of one the prediction already played
  keep(c) {
    if (!this.ready || c.actor !== this.you) return true;
    for (const q of this.pending) if (!q.used && q.name === c.name && Math.abs(q.tick - c.tick) <= 4) { q.used = true; return false; }
    return true;
  }
  // what is drawn: the last two predicted ticks blended at the clock, plus the fading correction
  alpha() { return Math.max(0, Math.min(1, this.clock - (this.tick - 1))); }
  view() {
    if (!this.ready || !this.cur) return null;
    const a = this.alpha(), A = this.prev || this.cur, B = this.cur;
    return { a: { players: [A] }, b: { players: [B] }, k: a, off: this.off };
  }
  // your HUD's state: the newest prediction, its timers blended between the two ticks
  hud() {
    if (!this.ready || !this.cur) return null;
    const a = this.alpha(), A = this.prev || this.cur, B = this.cur, o = Object.assign({}, B);
    o.gcd = lerp(A.gcd, B.gcd, a);
    o.slots = B.slots.map((q, i) => { const qa = A.slots[i]; return q && qa && qa.id === q.id && q.cd <= qa.cd ? Object.assign({}, q, { cd: lerp(qa.cd, q.cd, a) }) : q; });
    if (B.cast) {
      const ac = A.cast && A.cast.i === B.cast.i ? A.cast.t : B.cast.t - 1 / this.hz;
      const t = Math.max(0, lerp(ac, B.cast.t, a) + this.castOff);
      o.casting = { slot: B.cast.i, t: Math.min(t, B.cast.time), time: B.cast.time, name: B.cast.name };
    } else o.casting = null;
    o.buffs = B.buffs.map((q) => { const qa = A.buffs.find((r) => r.id === q.id); return qa && q.t <= qa.t ? Object.assign({}, q, { t: lerp(qa.t, q.t, a) }) : q; });
    return o;
  }
  stats() {
    const ms = 1000 / this.hz; let mx = 0; for (const q of this.corr) mx = Math.max(mx, q.d);
    return { on: this.ready, lead: this.lead * ms, ia: this.ia === null ? null : this.ia * ms, late: this.late, miss: this.miss, corrLast: this.lastCorr, corrMax5s: mx, corrNow: Math.hypot(this.off.x, this.off.y, this.off.z), castCorr: this.castCorr * 1000, mispredicts: this.mispredicts, ahead: this.tick === null ? 0 : (this.clock - this.net.serverNow()) * ms };
  }
}
