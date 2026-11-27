// The player: movement, targeting, the GCD / cast / cooldown engine, damage intake. Carried over from Threshold's
// 07_player.js without the hero model, the target ring or the camera.
//
// Differences from Threshold, all on purpose:
// - Movement comes from p.input (a world-space move vector), never from the camera. The client turns camera-relative keys
//   into a world vector before it sends them (plan: "the camera stays client-side").
// - Target picking by screen position is gone: the client sends the target's entity id (see fight.js applyInput).
// - The model is a stand-in: swings become 'hero.swing' cues and hand() is an estimate (it only feeds cue positions).
// - Cues that belong to one player's screen (hurt flash and shake, slot flash, their own numbers) carry that player's id as
//   a last argument, so other people's clients can leave them out.
import { G, asActor } from './core.js';
import { V3, clamp, dampAng, angTo } from './math.js';
import { FX, Sound, UI, View } from './view.js';

let onDead = () => {};
export function bindPlayerDeath(fn) { onDead = fn; }

export class Player {
  constructor(cls, id = 1) {
    this.id = id;
    this.cls = cls; this.maxHp = this.hp = cls.hp || 1000; this.pos = new V3(); this.facing = 0; this.alive = true; this.radius = 0.4;
    this.vy = 0; this.grounded = true; this.falling = false; this.moveSpeed = 0; this.speed = 7; this.speedMul = 1; this.push = { x: 0, z: 0 };
    this.kb = null; this.dash = null; this.rooted = 0; this.lockT = 0; this.invuln = 0; this.parryT = 0; this.shield = 0; this.shieldT = 0; this.shieldMax = 1; this.dmgMul = 1; this.dmgTakenMul = 1; this.flashT = 0;
    this.res = 0; this.resMax = cls.resource.max; this.gcd = 0; this.gcdMax = 1; this.casting = null; this.queue = -1; this.queueT = 0; this.combo = 0;
    this.target = null; this.buffs = []; this.stats = { dmg: 0, taken: 0, heals: 0 };
    this.sk = cls.skills.map((s) => s ? { def: s, cd: 0, charges: s.charges || 1, uses: s.limited || Infinity } : null);
    this.dodgeT = 0; this.rollT = 0; this.aimT = 0; this.loadT = 0;
    // what the player is doing this tick: set by applyInput (fight.js) from a client message, a recording, or the bot
    this.input = { mx: 0, mz: 0, held: 0, face: undefined };
    const pid = this.id;
    this.model = { swing(kind = 0, dur = 0.28) { View.cue('hero.swing', pid, kind, dur); } };
    if (cls.init) cls.init(this);
    this.aimP = new V3(); this.hint = ''; this.hintT = 0; this.lastHurt = -10; this.attackFaceT = 0;
  }
  aim(out) { return (out || this.aimP).set(this.pos.x, this.pos.y + 1.2, this.pos.z); }
  // the weapon tip, roughly (cosmetic only: lightning and muzzle cues start here)
  hand(out) { return (out || new V3()).set(this.pos.x + Math.sin(this.facing) * 0.55, this.pos.y + 1.35, this.pos.z + Math.cos(this.facing) * 0.55); }
  addBuff(id, dur, icon) { let b = this.buffs.find((q) => q.id === id); if (!b) { b = { id, icon }; this.buffs.push(b); } b.t = dur; b.dur = dur; return b; }
  hasBuff(id) { return this.buffs.some((q) => q.id === id && q.t > 0); }
  dropBuff(id) { const i = this.buffs.findIndex((q) => q.id === id); if (i >= 0) this.buffs.splice(i, 1); }
  gain(n) { this.res = clamp(this.res + n, 0, this.resMax); }
  heal(n) { if (!this.alive) return; const h = Math.min(this.maxHp - this.hp, n); this.hp += h; this.stats.heals += h; FX.num(this.aim(), '+' + Math.round(n), 'heal', this.id); Sound.sfx('heal'); FX.burst(this.pos.x, 0.2, this.pos.z, { n: 30, color: 0x66ffa0, speed: [0.5, 2], up: 4, life: [0.5, 1.1], radius: 0.8 }); FX.pillar(this.pos.x, this.pos.z, { r: 1, h: 6, color: 0x40ff90, dur: 0.7 }); }
  say(text) { this.hint = text; this.hintT = 1.2; }
  inRange(s, t) { if (!s.range) return true; if (!t || !t.alive || !t.targetable) return false; return t.distTo(this.pos.x, this.pos.z) <= s.range + (s.melee ? 0 : 0); }
  // Why can't slot i be used right now? Returns '' when usable.
  block(i) {
    const st = this.sk[i]; if (!st) return 'none'; const s = st.def;
    if (!this.alive || this.falling) return 'dead';
    if (G.cineLock) return 'busy'; // a cinematic is playing: no skill can start (bots and queued presses included)
    if (this.dash || this.kb) return 'busy';
    if (this.lockT > 0 && s.moves) return 'no'; // a boss lock-in: no skill may carry you off your square
    if (st.uses <= 0) return 'spent';
    if (st.charges <= 0) return 'cd';
    if (s.gcd !== false && this.gcd > 0) return 'gcd';
    if (this.casting && (s.gcd !== false || s.cast)) return 'gcd';
    if (s.range && (!this.target || !this.target.alive)) return 'target';
    if (s.range && !this.inRange(s, this.target)) return 'range';
    if (s.usable) { const r = s.usable(this, this.target); if (r !== true) return r || 'no'; }
    return '';
  }
  press(i) {
    const st = this.sk[i]; if (!st) return; const why = this.block(i);
    if (why === '') return this.begin(i);
    if (why === 'gcd' && (this.casting ? this.casting.time - this.casting.t : this.gcd) < 0.6) { this.queue = i; this.queueT = 0.7; }
    else if (why === 'range') this.say('Out of range'); else if (why === 'target') this.say('No target'); else if (/^[A-Z]/.test(why)) this.say(why);
  }
  castTime(s) { return typeof s.cast === 'function' ? s.cast(this) : (s.cast || 0); }
  begin(i) {
    const st = this.sk[i], s = st.def, ct = this.castTime(s);
    this.queue = -1;
    if (s.range && this.target) { this.attackFaceT = 0.5; }
    if (s.gcd !== false) { this.gcdMax = this.gcd = this.cls.gcdOf ? this.cls.gcdOf(this, s) : this.cls.gcd; }
    if (ct > 0) { this.casting = { i, t: 0, time: ct, tgt: this.target, name: s.name }; Sound.sfx('cast', 0.7); if (s.start) s.start(this, this.target); return; }
    this.commit(i, this.target, false);
  }
  commit(i, tgt, wasCast) {
    const st = this.sk[i], s = st.def;
    if (s.limited) st.uses--;
    if (s.cd) { st.charges--; if (st.cd <= 0) st.cd = s.cd; }
    s.fire(this, tgt, wasCast);
    UI.slotFlash(i, this.id);
  }
  // After a cinematic, a floor that fell away under the frozen hero does not drop them the moment play resumes:
  // they are set on the nearest standing ground, with a short grace.
  cineLand() {
    const A = G.arena; if (!A || A.edge !== 'fall' || !this.alive || this.falling || A.contains(this.pos.x, this.pos.z)) return;
    for (let r = 0.5; r <= 16; r += 0.5) for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2, x = this.pos.x + Math.sin(a) * r, z = this.pos.z + Math.cos(a) * r;
      if (A.contains(x, z)) { this.pos.x = x; this.pos.z = z; this.offT = 0; this.invuln = Math.max(this.invuln, 0.6); return; } }
  }
  hurt(amt, o = {}) {
    if (!this.alive || (G.god && !o.pierce) || G.state !== 'fight') return 0;
    if (G.cineLock && !o.pierce) return 0; // nothing lands on a hero who cannot move; pierce: a nightmare 'out of time' blow
    if (this.invuln > 0 && o.src !== 'fall' && !o.pierce) return 0;
    if (o.blockable && this.dodgeT > 0) { if (this.cls.onDodge) this.cls.onDodge(this, o); return 0; } // roll i-frames never beat an unblockable
    if (o.blockable && this.parryT > 0) { this.parryT = 0; asActor(this, () => this.cls.onParry(this, o)); return 0; } // the riposte is this player's damage
    amt = Math.round(amt * this.dmgTakenMul);
    if (o.kb && o.kb.dist) { const d = 0.38; this.kb = { vx: Math.sin(o.kb.dir) * o.kb.dist / d, vz: Math.cos(o.kb.dir) * o.kb.dist / d, t: d }; this.casting = null; }
    if (o.blockable && this.shield > 0) { const a = Math.min(this.shield, amt); this.shield -= a; amt -= a; if (this.cls.onAbsorb) this.cls.onAbsorb(this, a); FX.num(this.aim(), 'ABSORB', 'note', this.id); Sound.sfx('shield', 0.8); if (amt <= 0) return 0; }
    this.hp -= amt; this.stats.taken += amt; this.lastHurt = G.now; this.flashT = 0.15;
    if (G.hitLog) G.hitLog.push(G.ft.toFixed(1) + ' ' + (o.src ? (o.src.name || (o.src.shape && o.src.shape.type) || (typeof o.src === 'string' ? o.src : 'bullet')) : '?') + ' ' + amt);
    if (!o.dot || amt > 40) { Sound.sfx('hurt', o.dot ? 0.5 : 1); FX.shake(Math.min(0.9, amt / 450), this.id); UI.hurtFlash(amt / this.maxHp, this.id); }
    FX.num(this.aim(), '-' + amt, 'hurt', this.id);
    if (this.hp < 1 && G.opts.godMode && !G.rehearsing) { this.hp = 1; G.testUsed = true; } // testing: take every hit, never die
    if (this.hp <= 0) { this.hp = 0; this.die(o.src); }
    return amt;
  }
  // god mode (testing): a fall puts the player back at the arena's spawn point instead of killing them
  godRescue() {
    const A = G.arena || {}, sp = A.spawn || { x: 0, z: 12 }; G.testUsed = true;
    this.pos.set(sp.x, A.floorY || 0, sp.z); this.vy = 0; this.falling = false; this.grounded = true; this.offT = 0; this.dash = null; this.kb = null; this.invuln = Math.max(this.invuln, 1);
    FX.num(this.aim(), 'RESCUED', 'note', this.id);
  }
  die(src) {
    if (!this.alive) return; this.alive = false; this.casting = null; this.deathT = 0; this.deathSrc = src;
    Sound.sfx('death'); FX.burst(this.pos.x, 1, this.pos.z, { n: 40, color: this.cls.color, speed: [1, 6], life: [0.6, 1.6], up: 2 });
    onDead(this);
  }
  cycleTarget(dir = 1) {
    const L = G.ents.filter((e) => e.alive && e.targetable); if (!L.length) { this.target = null; return; }
    L.sort((a, b) => a.distTo(this.pos.x, this.pos.z) - b.distTo(this.pos.x, this.pos.z));
    const i = L.indexOf(this.target); this.target = L[(i + dir + L.length) % L.length]; Sound.sfx('ui');
  }
  jump() { if (!G.cineLock && this.alive && this.grounded && !this.dash && !this.kb && this.rooted <= 0) { this.vy = 7.2; this.grounded = false; } }
  update(dt) {
    const A = G.arena, inp = this.input;
    this.flashT -= dt; if (this.hintT > 0) this.hintT -= dt;
    if (!this.alive) { this.deathT += dt; if (this.falling) { this.vy -= 30 * dt; this.pos.y += this.vy * dt; } return; }
    // Cinematics: the hero stands still and the player's side of the fight holds (Threshold PR #86).
    const lock = !!G.cineLock;
    if (lock && !this.cineOn) { this.cineOn = true; if (this.casting) { this.casting = null; this.gcd = Math.min(this.gcd, 0.25); } this.queue = -1; this.attackFaceT = 0; }
    else if (!lock && this.cineOn) { this.cineOn = false; this.cineLand(); }
    // timers
    if (lock) { /* frozen */ } else {
    if (this.gcd > 0) this.gcd -= dt; if (this.parryT > 0) this.parryT -= dt; if (this.dodgeT > 0) this.dodgeT -= dt; if (this.rollT > 0) this.rollT -= dt; if (this.aimT > 0) this.aimT -= dt; if (this.loadT > 0) this.loadT -= dt; if (this.invuln > 0) this.invuln -= dt; if (this.rooted > 0) this.rooted -= dt; if (this.lockT > 0) this.lockT -= dt;
    if (this.shieldT > 0) { this.shieldT -= dt; if (this.shieldT <= 0) this.shield = 0; } else this.shield = 0;
    for (const st of this.sk) { if (!st) continue; const s = st.def; if (st.cd > 0) { st.cd -= dt; if (st.cd <= 0) { st.charges = Math.min(s.charges || 1, st.charges + 1); st.cd = st.charges < (s.charges || 1) ? s.cd : 0; } } }
    for (let i = this.buffs.length - 1; i >= 0; i--) { const b = this.buffs[i]; b.t -= dt; if (b.t <= 0) { this.buffs.splice(i, 1); if (this.cls.onBuffEnd) this.cls.onBuffEnd(this, b.id); } }
    }
    // target upkeep
    if (!this.target || !this.target.alive || !this.target.targetable) { let best = null, bd = 1e9; for (const e of G.ents) { if (!e.alive || !e.targetable) continue; const d = e.distTo(this.pos.x, this.pos.z) - (e.isBoss ? 0 : 3); if (d < bd) { bd = d; best = e; } } this.target = best; }
    // movement intent (world space)
    let mx = inp.mx || 0, mz = inp.mz || 0;
    let ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; ml = 1; }
    if (this.rooted > 0 || lock) { mx = mz = ml = 0; }
    let vx = 0, vz = 0;
    if (this.kb) { vx = this.kb.vx; vz = this.kb.vz; this.kb.t -= dt; if (this.kb.t <= 0) this.kb = null; ml = 0; }
    else if (this.dash) { const d = this.dash, k = Math.min(1, d.t / dt); vx = d.vx * k; vz = d.vz * k; d.t -= dt; if (d.t <= 0) { this.dash = null; if (d.done) d.done(this); } ml = 0; }
    else { const sp = this.speed * this.speedMul; vx = mx * sp; vz = mz * sp; }
    this.intentX = mx; this.intentZ = mz; this.moving = ml > 0.15;
    const pux = this.push.x, puz = this.push.z; vx += pux; vz += puz; this.push.x = this.push.z = 0;
    const ox = this.pos.x, oz = this.pos.z;
    this.pos.x += vx * dt; this.pos.z += vz * dt;
    // facing: inp.face is the camera yaw while the player steers with the mouse (Threshold's right-button steer)
    if (inp.face !== undefined && G.state === 'fight' && !lock) this.facing = inp.face;
    else if (this.moving && !this.kb && !this.dash) this.facing = dampAng(this.facing, Math.atan2(mx, mz), 16, dt);
    else if ((this.casting || this.attackFaceT > 0) && this.target) this.facing = dampAng(this.facing, angTo(this.pos.x, this.pos.z, this.target.pos.x, this.target.pos.z), 18, dt);
    if (this.attackFaceT > 0) this.attackFaceT -= dt;
    // arena bounds
    if (A) {
      if (this.pos.y >= -0.01 && !this.falling) {
        if (A.edge === 'fall') { if (lock && !this.dash && !this.kb) this.offT = 0; else if (!this.dash && !A.contains(this.pos.x, this.pos.z)) { this.offT = (this.offT || 0) + dt; if (this.offT > 0.15) { if (this.grounded) { this.grounded = false; this.vy = 0; } this.falling = this.pos.y <= 0.02; } } else this.offT = 0; }
        else A.clamp(this.pos, ox, oz);
      }
      if (A.solid) A.solid(this.pos, ox, oz);
    }
    // vertical
    if (!this.grounded || this.falling) {
      this.vy -= 22 * dt; this.pos.y += this.vy * dt;
      const floor = A && A.floorY || 0;
      if (!this.falling && this.pos.y <= floor) { if (!A || A.edge !== 'fall' || A.contains(this.pos.x, this.pos.z)) { this.pos.y = floor; this.vy = 0; this.grounded = true; } else this.falling = true; }
      if (this.falling) { this.casting = null; if (this.pos.y < -7) { if (G.opts.godMode && !G.rehearsing) this.godRescue(); else { this.hp = 0; this.die('fall'); } } }
    }
    this.moveSpeed = Math.min(Math.hypot(vx - pux, vz - puz), Math.hypot(this.pos.x - ox, this.pos.z - oz) / Math.max(dt, 1e-4)); // own motion only
    // casting
    if (this.casting) {
      const c = this.casting, s = this.sk[c.i].def;
      const canMove = s.moveCast && s.moveCast(this);
      if ((this.moving || !this.grounded || this.dash || this.kb) && !canMove) { this.casting = null; this.gcd = Math.min(this.gcd, 0.25); }
      else if (s.range && (!c.tgt || !c.tgt.alive || !c.tgt.targetable)) { this.casting = null; this.gcd = Math.min(this.gcd, 0.25); }
      else { c.t += dt; if (c.t >= c.time) { this.casting = null; this.commit(c.i, c.tgt, true); } }
    }
    // queue + hold-to-repeat (inp.held: bit i set while slot i is held down)
    if (this.queue >= 0) { this.queueT -= dt; if (this.queueT <= 0) this.queue = -1; else if (this.block(this.queue) === '') this.begin(this.queue); }
    else if (inp.held && G.state === 'fight') { for (let i = 0; i < this.sk.length; i++) if ((inp.held >> i) & 1 && this.sk[i] && this.sk[i].def.gcd !== false && this.block(i) === '') { this.begin(i); break; } }
    if (this.cls.update && !lock) this.cls.update(this, dt);
  }
}
