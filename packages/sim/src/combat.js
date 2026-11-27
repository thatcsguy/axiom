// Combat rules: telegraphed hazards, bullets, entities, casts, and the boss runtime with phases.
// Carried over from Threshold's 06_combat.js with every mesh, shader and instanced draw removed. What the picture needs
// comes from snapshots (hazard and bullet lists, entity state) and from cues (view.js).
//
// Still single-player: hazards, bullets, homing and the enrage read G.player. Plan step 3 replaces that with a player list.
import { G, Co, Hooks, vrand } from './core.js';
import { V3, TAU, clamp, smooth, angDiff, dampAng, angTo } from './math.js';
import { FX, Sound, Music, Hitch } from './view.js';

// Ids for things the client needs to follow from snapshot to snapshot. Reset at the start of every fight.
const ids = { ent: 0, hz: 0, bul: 0, add: 0 };
export function resetIds() { ids.ent = ids.hz = ids.bul = ids.add = 0; }

// ---------- hazards ----------
export const Hz = (() => {
  const list = [];
  function inShape(s, x, z) {
    const dx = x - s.x, dz = z - s.z;
    switch (s.type) {
      case 'circle': return dx * dx + dz * dz <= s.r * s.r;
      case 'donut': { const d = dx * dx + dz * dz; return d <= s.r1 * s.r1 && d >= s.r0 * s.r0; }
      case 'cone': { const d = Math.hypot(dx, dz); if (d > s.r || d < (s.r0 || 0)) return false; return Math.abs(angDiff(s.dir, Math.atan2(dx, dz))) <= s.arc / 2; }
      case 'rect': { const fx = Math.sin(s.dir), fz = Math.cos(s.dir), along = dx * fx + dz * fz, side = dx * fz - dz * fx; return along >= 0 && along <= s.len && Math.abs(side) <= s.w / 2; }
    }
    return false;
  }
  function add(shape, delay, dmg, o = {}) {
    const h = Object.assign({ id: ++ids.hz, shape, delay, t: 0, dmg, blockable: true, color: (G.boss && G.boss.def.telegraph) || 0xff5a2a, tag: 'phase', state: 'tele', fireT: 0, dur: 0, style: 0, alpha: 1 }, o);
    list.push(h); if (!h.silent && delay > 0.25) Sound.sfx('warn', 0.6);
    return h;
  }
  function release(h) { h.state = 'done'; }
  function fire(h) {
    const p = G.player, s = h.shape;
    h.state = 'fired'; h.fireT = 0.28;
    if (h.onFire) h.onFire(h);
    else if (!h.quiet) {
      if (s.type === 'circle') { FX.burst(s.x, 0.3, s.z, { n: 10 + s.r * 4, color: h.color, speed: [2, 7 + s.r], life: [0.3, 0.8], size: [0.2, 0.5], radius: s.r * 0.7, up: 3 }); FX.light(s.x, 2, s.z, h.color, 30 + s.r * 8, 0.35, 10 + s.r * 3); }
      Sound.sfx(h.sfx || 'boom', Math.min(1, 0.35 + (h.dmg || 100) / 600)); FX.shake(Math.min(0.5, (h.dmg || 100) / 900));
    }
    if (p && p.alive && h.dmg !== 0 && inShape(s, p.pos.x, p.pos.z) !== !!h.invert) {
      let kb = null;
      if (h.kb) { const a = h.kb.dir !== undefined ? h.kb.dir : angTo(h.kb.x === undefined ? s.x : h.kb.x, h.kb.z === undefined ? s.z : h.kb.z, p.pos.x, p.pos.z); kb = { dir: a, dist: h.kb.dist }; }
      const taken = p.hurt(h.dmg, { blockable: h.blockable, kb, src: h });
      if (h.onHit) h.onHit(h, taken);
    } else if (h.onMiss) h.onMiss(h);
  }
  function update(dt) {
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (h.state === 'done') { list.splice(i, 1); continue; }
      h.t += dt;
      if (h.state === 'tele') {
        if (h.track && h.delay - h.t > (h.lock === undefined ? 0.5 : h.lock)) h.track(h.shape, h);
        if (h.t >= h.delay) { if (h.dur > 0) { h.state = 'zone'; h.zt = 0; h.tickT = 0; if (h.onFire) h.onFire(h); } else fire(h); }
      } else if (h.state === 'fired') {
        h.fireT -= dt; if (h.track && h.trackFired) h.track(h.shape, h); // trackFired: the flash keeps following a moving floor
        if (h.fireT <= 0) { release(h); list.splice(i, 1); }
      } else if (h.state === 'zone') {
        h.zt += dt; h.tickT -= dt;
        if (h.track) h.track(h.shape, h);
        const p = G.player;
        if (h.tickT <= 0 && p && p.alive && h.dmg && inShape(h.shape, p.pos.x, p.pos.z)) { h.tickT = h.every || 0.5; p.hurt(h.dmg, { blockable: false, src: h, dot: true }); if (h.onHit) h.onHit(h); }
        if (h.zt >= h.dur) { release(h); list.splice(i, 1); }
      }
    }
  }
  const api = {
    list, inShape,
    circle: (x, z, r, delay, dmg, o) => add({ type: 'circle', x, z, r }, delay, dmg, o),
    donut: (x, z, r0, r1, delay, dmg, o) => add({ type: 'donut', x, z, r0, r1 }, delay, dmg, o),
    cone: (x, z, dir, arc, r, delay, dmg, o) => add({ type: 'cone', x, z, dir, arc, r, r0: (o && o.r0) || 0 }, delay, dmg, o),
    rect: (x, z, dir, len, w, delay, dmg, o) => add({ type: 'rect', x, z, dir, len, w }, delay, dmg, o),
    // persistent damaging area: zone(shape, dur, dmgPerTick, {every, delay (arming time), color})
    zone: (shape, dur, dmg, o = {}) => add(shape, o.delay || 0.6, dmg, Object.assign({ dur, every: 0.5, quiet: true, silent: true }, o)),
    // purely visual marker (safe spots, soak markers): mark(shape, dur, {color, style: 1})
    mark: (shape, dur, o = {}) => add(shape, 0.01, 0, Object.assign({ dur, style: 1, zoneStyle: 1, quiet: true, silent: true }, o)),
    cancel(h) { if (h && h.state !== 'done') release(h); },
    clear(tag) { for (const h of list) if (!tag || h.tag === tag) release(h); },
    // Autopilot query: how soon will (x,z) be hit? Returns seconds until the earliest hit there, or Infinity.
    threat(x, z) { let best = Infinity; for (const h of list) { if (h.state === 'done' || h.state === 'fired' || !h.dmg) continue; if (inShape(h.shape, x, z) === !!h.invert) continue; const t = h.state === 'zone' ? 0 : h.delay - h.t; if (t < best) best = t; } return best; },
    // true when (x,z) sits in a lingering damage zone, armed or still arming
    persist(x, z) { for (const h of list) if (h.dmg && h.dur > 0 && (h.state === 'zone' || h.state === 'tele') && inShape(h.shape, x, z)) return true; return false; },
    update,
  };
  Hooks.step.push(update);
  return api;
})();

// ---------- bullets ----------
export const Bul = (() => {
  const MAX = 700, list = [];
  // fire({x,z,dir,speed,r,dmg,color,life,y,accel,turn (rad/s homing),curve (rad/s), onUpdate(b,dt)})
  function fire(o) { if (list.length >= MAX) return null; const b = Object.assign({ id: ++ids.bul, y: 1.1, r: 0.38, dmg: 90, color: (G.boss && G.boss.def.telegraph) || 0xff5a2a, life: 8, speed: 8, dir: 0, t: 0, accel: 0, turn: 0, curve: 0, tag: 'phase' }, o); list.push(b); return b; }
  function ringOf(x, z, n, speed, o = {}, offset = 0, gapAt, gapArc) { for (let i = 0; i < n; i++) { const a = offset + i / n * TAU; if (gapAt !== undefined && Math.abs(angDiff(a, gapAt)) < gapArc / 2) continue; fire(Object.assign({ x, z, dir: a, speed }, o)); } }
  function update(dt) {
    const p = G.player;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i]; b.t += dt;
      if (b.turn && p) b.dir = b.dir + clamp(angDiff(b.dir, angTo(b.x, b.z, p.pos.x, p.pos.z)), -b.turn * dt, b.turn * dt);
      if (b.curve) b.dir += b.curve * dt;
      if (b.accel) b.speed = Math.max(0, b.speed + b.accel * dt);
      if (b.onUpdate) b.onUpdate(b, dt);
      b.x += Math.sin(b.dir) * b.speed * dt; b.z += Math.cos(b.dir) * b.speed * dt;
      let dead = b.t >= b.life || b.dead;
      if (!dead && p && p.alive && b.t > 0.08) { const d = Math.hypot(p.pos.x - b.x, p.pos.z - b.z); if (d < b.r + 0.4 && p.pos.y < b.y + 1.2) { p.hurt(b.dmg, { blockable: true, src: b }); FX.impact(b.x, b.y, b.z, b.color, 0.6); dead = true; } }
      if (!dead && G.arena && G.arena.bulletBounds && !G.arena.bulletBounds(b.x, b.z)) dead = true;
      if (dead) { list[i] = list[list.length - 1]; list.pop(); }
    }
  }
  function clear(tag) { if (!tag) list.length = 0; else for (let i = list.length - 1; i >= 0; i--) if (list[i].tag === tag) list.splice(i, 1); }
  function clearNear(x, z, r) { let n = 0; for (let i = list.length - 1; i >= 0; i--) { const b = list[i]; if (Math.hypot(b.x - x, b.z - z) < r) { FX.burst(b.x, b.y, b.z, { n: 5, color: b.color, speed: [1, 4], life: [0.2, 0.5] }); list.splice(i, 1); n++; } } return n; }
  // Autopilot query: is a bullet about to pass within `pad` of (x,z) in the next `t` seconds?
  // a bullet that knows it will be removed (b.stopAt, in its own time b.t) is only a threat along the path before that
  function threat(x, z, t = 0.6, pad = 0.9) { for (const b of list) { const t1 = b.stopAt !== undefined ? Math.max(0, Math.min(t, b.stopAt - b.t)) : t, vx = Math.sin(b.dir) * b.speed, vz = Math.cos(b.dir) * b.speed, rx = x - b.x, rz = z - b.z, vv = vx * vx + vz * vz || 1e-6, k = clamp((rx * vx + rz * vz) / vv, 0, t1); if (Math.hypot(rx - vx * k, rz - vz * k) < b.r + pad) return true; } return false; }
  Hooks.step.push(update);
  return { list, fire, ring: ringOf, clear, clearNear, threat };
})();

// ---------- entities ----------
export class Ent {
  constructor(o = {}) {
    this.id = ++ids.ent;
    this.name = o.name || 'Enemy'; this.maxHp = this.hp = o.hp || 1000; this.radius = o.radius || 1; this.aimY = o.aimY === undefined ? 1.5 : o.aimY;
    this.pos = new V3(o.x || 0, o.y || 0, o.z || 0); this.facing = o.facing || 0; this.alive = true; this.targetable = o.targetable !== false; this.immune = false;
    this.dmgTaken = 1; this.exposed = 0; this.castState = null; this.stagger = 0; this.isBoss = false; this.autoFace = false; this.turnRate = 6;
    this.onDamaged = o.onDamaged || null; this.onDeath = o.onDeath || null; this.updateFn = o.update || null; this.meleeY = o.meleeY || 0;
  }
  aim(out) { return out.set(this.pos.x, this.pos.y + this.aimY, this.pos.z); }
  distTo(x, z) { return Math.max(0, Math.hypot(x - this.pos.x, z - this.pos.z) - this.radius); }
  // hpOwner: a second body that shares another entity's health (hits land on the owner; dmgTaken, exposed and onDamaged stay
  // with the body that was hit). onImmuneHit(info, ent): called when an immune body is hit; returning true hides "IMMUNE".
  damage(amt, info = {}) {
    const tgt = this.hpOwner || this;
    if (!this.alive || !tgt.alive) return 0;
    if (this.immune) { if (this.onImmuneHit && this.onImmuneHit(info, this)) return 0; if (!G.headless && info.show !== false) FX.num(this.aim(_tv), 'IMMUNE', 'note'); return 0; }
    amt *= this.dmgTaken * (this.exposed > 0 ? 1.12 : 1) * (G.player ? G.player.dmgMul : 1);
    amt = Math.round(amt); tgt.hp -= amt;
    if (G.player) G.player.stats.dmg += amt;
    if (this.onDamaged) this.onDamaged(amt, info, this);
    if (!G.headless) { this.aim(_tv); _tv.x += (vrand() - 0.5) * this.radius; _tv.y += vrand() * 0.8; FX.num(_tv, String(amt), info.crit ? 'crit' : ''); }
    if (amt > 0 && tgt.isBoss && info.src === 'player' && G.opts.superDmg) tgt.superPush();
    if (tgt.hp <= 0) { tgt.hp = 0; tgt.die(); }
    return amt;
  }
  die() { if (!this.alive) return; this.alive = false; this.castState = null; if (this.onDeath) this.onDeath(this); }
  // Cast bar. `yield* ent.cast({name, time, interruptible})` returns 'done' | 'interrupted' | 'dead'.
  *cast(o) {
    const cs = this.castState = { name: o.name || '', t: 0, time: o.time, int: !!o.interruptible, result: null };
    Hitch.mark('cast ' + cs.name);
    if (cs.int) Sound.sfx('charge', 0.6);
    while (cs.t < cs.time && !cs.result) { if (!this.alive) return 'dead'; cs.t += G.dt; if (o.onTick) o.onTick(cs.t / cs.time, cs); yield; }
    if (this.castState === cs) this.castState = null;
    return cs.result || 'done';
  }
  interrupt() {
    const cs = this.castState; if (!cs || !cs.int || cs.result) return false;
    cs.result = 'interrupted'; this.castState = null; this.stagger = 1.2; Sound.sfx('interrupt');
    this.aim(_tv); FX.burst(_tv.x, _tv.y, _tv.z, { n: 30, color: 0xc88bff, speed: [3, 12], life: [0.3, 0.8] }); FX.num(_tv, 'INTERRUPTED', 'note'); return true;
  }
  update(dt) {
    if (this.exposed > 0) this.exposed -= dt; if (this.stagger > 0) this.stagger -= dt;
    const p = G.player;
    if (this.autoFace && p && this.stagger <= 0) this.facing = dampAng(this.facing, angTo(this.pos.x, this.pos.z, p.pos.x, p.pos.z), this.turnRate, dt);
    if (this.updateFn) this.updateFn(this, dt);
  }
}
const _tv = new V3();

export class Boss extends Ent {
  constructor(def) {
    super({ name: def.name, hp: def.hp, radius: def.radius || 2, aimY: def.aimY || 2.5 });
    this.def = def; this.isBoss = true; this.phase = -1; this.nextPhase = 0; this.transitioning = false; this.enraged = false; this.state = {};
    this.pub = {}; // plain data the view half reads (channel 2 of docs/plan.md): fill it from the boss's rules, never read it back
    this.P = null; // the player, set at fight start
  }
  face(x, z) { this.facing = angTo(this.pos.x, this.pos.z, x, z); }
  angToPlayer() { const p = G.player; return angTo(this.pos.x, this.pos.z, p.pos.x, p.pos.z); }
  distToPlayer() { const p = G.player; return Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z); }
  *turnTo(a, dur = 0.4) { const a0 = this.facing, d = angDiff(a0, a); let t = 0; while (t < dur) { t += G.dt; this.facing = a0 + d * smooth(t / dur); yield; } }
  *moveTo(x, z, speed = 8, o = {}) {
    while (this.alive) { const dx = x - this.pos.x, dz = z - this.pos.z, d = Math.hypot(dx, dz); if (d < 0.05) break; const s = Math.min(d, speed * G.dt); this.pos.x += dx / d * s; this.pos.z += dz / d * s; if (o.face !== false) this.facing = dampAng(this.facing, Math.atan2(dx, dz), 12, G.dt); yield; }
  }
  spawnAdd(o) {
    const a = new Ent(o); a.isAdd = true; a.def = o;
    G.ents.push(a);
    const userDeath = a.onDeath;
    a.onDeath = (e) => { e.aim(_tv); FX.explode(_tv.x, _tv.y, _tv.z, o.color || this.def.telegraph || 0xffffff, 3); Co.stopTag(e.tag); if (userDeath) userDeath(e); e.removeT = 0.01; };
    a.tag = 'add' + (++ids.add);
    if (o.run) Co.start(o.run(a, this), a.tag);
    return a;
  }
  goPhase(i) {
    const b = this, ph = this.def.phases[i];
    this.logPhase();
    Hitch.mark('phase ' + (i + 1));
    this.phaseT = 0; this.liveT = 0; this.phaseDmg0 = G.player ? G.player.stats.dmg : 0;
    Co.stopTag('phase'); Hz.clear('phase'); Bul.clear('phase'); this.castState = null; this.phase = i; this.nextPhase = i + 1; this.transitioning = true;
    Co.start(function* () {
      if (ph.enter) { b.immune = true; yield* ph.enter(b); b.immune = false; }
      b.transitioning = false; if (ph.music !== undefined) Music.intensity(ph.music); else Music.intensity(i);
      yield* ph.run(b);
    }, 'phase');
  }
  // Super damage (testing setting): a landed player hit drops health to just under the next phase threshold, and the
  // normal threshold check in update() then runs goPhase, so enter hooks and transitions behave as usual.
  superPush() {
    const d = this.def, n = this.nextPhase;
    if (G.rehearsing || G.state !== 'fight' || this.phase < 0 || this.transitioning || (this.liveT || 0) < 0.75) return;
    G.testUsed = true;
    if (n >= d.phases.length) { this.hp = 0; return; }
    const lim = this.maxHp * d.phases[n].at;
    if (this.hp > lim - 1) this.hp = Math.max(1, Math.floor(lim - 1));
    this.liveT = 0;
  }
  // ---- the nightmare split log: how long each phase was live and the damage dealt in it
  logPhase() {
    if (!this.def.nm || this.phase < 0) return; const L = this.phaseLog || (this.phaseLog = []); if (L[this.phase]) return;
    L[this.phase] = { time: Math.round((this.phaseT || 0) * 10) / 10, dmg: Math.round((G.player ? G.player.stats.dmg : 0) - (this.phaseDmg0 || 0)) };
  }
  // the last blow (def.lastBlow, a coroutine): lastBlowAt seconds after the enrage, the phase stops and the blow plays out.
  startLastBlow() {
    this.lastBlowing = true; this.transitioning = false; this.immune = false; Co.stopTag('phase'); Hz.clear('phase'); Bul.clear('phase'); this.castState = null;
    Co.start(this.def.lastBlow(this), 'phase');
  }
  update(dt) {
    super.update(dt);
    if (!this.alive || G.state !== 'fight') return;
    const d = this.def;
    if (!this.transitioning) this.liveT = (this.liveT || 0) + dt;
    if (!this.transitioning && !this.lastBlowing && this.nextPhase < d.phases.length && this.hp / this.maxHp <= d.phases[this.nextPhase].at) this.goPhase(this.nextPhase);
    if (d.nm && !this.transitioning && !G.rehearsing) this.phaseT += dt;
    // the enrage: from d.enrage on, an unblockable pulse every 2 s of enrageBase + enrageGrow per second over.
    if (d.enrage && G.ft > d.enrage && !G.rehearsing) {
      if (!this.enraged) { this.enraged = true; this.enrageT = 0; FX.flash(0xff2010, 0.5, 1.5); Sound.sfx('roar'); }
      const base = d.enrageBase !== undefined ? d.enrageBase : 120, grow = d.enrageGrow !== undefined ? d.enrageGrow : 14;
      this.enrageT -= dt; if (this.enrageT <= 0) { this.enrageT = 2; const p = G.player; if (p && p.alive) { p.hurt(base + (G.ft - d.enrage) * grow, { blockable: false, src: 'enrage' }); FX.flash(0xff2010, 0.3, 3); FX.ring(this.pos.x, this.pos.z, { r1: 40, color: 0xff3010, dur: 0.8 }); } }
      if (d.lastBlow && !this.lastBlowing && G.ft >= d.enrage + (d.lastBlowAt !== undefined ? d.lastBlowAt : 24)) this.startLastBlow();
    }
  }
}
