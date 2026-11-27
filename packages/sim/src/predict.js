// Client-side prediction of your own character, from the same Player code the server runs (docs/plan.md, step 4).
//
// The server sends each player their own character's whole state every tick (ownState). The client keeps a predictor: a
// small world in its own JavaScript realm with one real Player (your class, your skills) and stand-ins for the boss and adds
// (positions from snapshots; hitting them does nothing). Every client tick it applies that tick's input frame and steps the
// player, exactly as the server will, so movement, jumps, dashes, the cast bar, the global cooldown, cooldowns, charges,
// resources gained by your own skills, buffs and the hotbar's usable / not usable state all answer at once. When the
// server's state for tick T arrives, the predictor takes it (applyOwnState) and replays the frames after T that the server
// has not answered yet. With nothing from the world in between (a hit, a knockback, a cinematic), the replay lands exactly
// where the prediction was; test/predict.test.js checks that on every tick of a fight.
//
// What the predictor cannot know stays the server's: damage dealt and taken, the boss, hazards, other players, paint.
//
// The predictor shares the sim's module-level state (G), so it must be the only fight in its realm (the browser's main
// thread: the server and the debug viewer's worker run their sims elsewhere).
import { G, Co } from './core.js';
import { Hz, Bul } from './combat.js';
import { V3 } from './math.js';
import { Player } from './player.js';
import { View, Cam } from './view.js';
import { applyInput, nightmareDef } from './fight.js';

// fields that are not the character's state (the server keeps them: names, meters, the autopilot's scratch, references)
const SKIP = new Set(['cls', 'model', 'input', 'botS', 'botLevel', 'stats', 'aimP', 'name', 'id', 'deathSrc']);
const BIG = 1e308; // Infinity on the wire (JSON has none)
const isEnt = (v) => v && typeof v === 'object' && typeof v.id === 'number' && v.pos && typeof v.damage === 'function';

function enc(v, depth) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : v > 0 ? BIG : -BIG;
  if (t === 'boolean' || t === 'string') return v;
  if (t !== 'object' || depth > 4) return undefined;
  if (isEnt(v)) return { $e: v.id };
  if (v instanceof V3) return { $v: [v.x, v.y, v.z] };
  if (Array.isArray(v)) return v.map((q) => { const e = enc(q, depth + 1); return e === undefined ? null : e; });
  const o = {};
  for (const k of Object.keys(v)) { const q = v[k]; if (typeof q === 'function') continue; const e = enc(q, depth + 1); if (e !== undefined) o[k] = e; }
  return o;
}

// A player's whole state as plain JSON-safe data (numbers at full precision). Skill definitions stay behind: slots carry
// only cd, charges and uses. A dash's landing callback (Lunge's hit) cannot travel; the server's next state carries its result.
export function ownState(p) {
  const o = {};
  for (const k of Object.keys(p)) {
    if (SKIP.has(k) || k.startsWith('bot')) continue; const v = p[k];
    if (typeof v === 'function') continue;
    if (k === 'sk') { o.sk = v.map((st) => st ? [st.cd, st.charges, st.uses === Infinity ? BIG : st.uses] : null); continue; }
    const e = enc(v, 0); if (e !== undefined) o[k] = e;
  }
  return o;
}

function dec(v, ent) {
  if (v === null || typeof v !== 'object') return typeof v === 'number' && Math.abs(v) >= BIG ? (v > 0 ? Infinity : -Infinity) : v;
  if (Array.isArray(v)) return v.map((q) => dec(q, ent));
  if (v.$e !== undefined) return ent(v.$e);
  if (v.$v) return new V3(v.$v[0], v.$v[1], v.$v[2]);
  const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k], ent); return o;
}

// Lay a state from ownState over a Player of the same class. ent(id) turns entity ids back into bodies (or null).
export function applyOwnState(p, st, ent = () => null) {
  for (const k of Object.keys(st)) {
    if (k === 'sk') { st.sk.forEach((q, i) => { const s = p.sk[i]; if (!s || !q) return; s.cd = q[0]; s.charges = q[1]; s.uses = q[2] >= BIG ? Infinity : q[2]; }); continue; }
    const v = dec(st[k], ent);
    if (v instanceof V3 && p[k] instanceof V3) p[k].copy(v); else p[k] = v;
  }
  // anything the prediction added that the server's character does not have (a timer set by a mispredicted skill)
  for (const k of Object.keys(p)) if (!(k in st) && !SKIP.has(k) && !k.startsWith('bot') && k !== 'sk' && typeof p[k] !== 'function' && !(p[k] instanceof V3)) p[k] = undefined;
}

// A stand-in for a hostile body: where it is, how big, whether it can be targeted. Hitting it does nothing.
class Shadow {
  constructor(id) { this.id = id; this.pos = new V3(); this.radius = 1; this.alive = true; this.targetable = true; this.immune = false; this.isBoss = false; this.aimY = 1.5; this.meleeY = 0; this.facing = 0; this.exposed = 0; this.hp = 1; this.maxHp = 1; }
  aim(out) { return out.set(this.pos.x, this.pos.y + this.aimY, this.pos.z); }
  distTo(x, z) { return Math.max(0, Math.hypot(x - this.pos.x, z - this.pos.z) - this.radius); }
  damage() { return 0; }
  interrupt() { return false; }
  update() { }
}

export class Predictor {
  // o: { boss: id, nm, cls: class id, hz }
  constructor(o) {
    this.hz = o.hz || 30; this.dt = 1 / this.hz; this.shadows = new Map();
    const base = G.bosses.find((d) => d.id === o.boss) || G.bosses[0], def = o.nm && base.nightmare ? nightmareDef(base) : base;
    Co.clear(); Hz.list.length = 0; Bul.clear(); Cam.reset();
    G.players = []; G.ents.length = 0; G.nightmare = !!(o.nm && base.nightmare); G.opts = { godMode: false, superDmg: false }; G.god = false; G.now = 0; G.ft = 0; G.tick = 0; G.dt = this.dt; G.state = 'fight';
    // the arena's rules half (bounds, a fall edge, solid things), from the fight's own build(); the boss it was built for is a
    // throwaway (its state is the server's)
    const fake = { state: {}, pub: {}, def, pos: new V3(), facing: 0, maxHp: 1, hp: 1 };
    let A = {}; try { A = def.build(fake) || {}; } catch (e) { A = {}; }
    A.floorY = A.floorY || 0; A.edge = A.edge || 'wall';
    if (!A.contains) A.contains = (x, z) => Math.hypot(x, z) <= (A.radius || 20);
    if (!A.clamp) A.clamp = (q) => { const r = (A.radius || 20) - 0.4, d = Math.hypot(q.x, q.z); if (d > r) { q.x *= r / d; q.z *= r / d; } };
    G.arena = A; G.boss = null;
    this.cls = o.cls; this.p = null; this.setClass(o.cls, o.id || 1);
  }
  setClass(cls, id) {
    const c = G.classes.find((q) => q.id === cls) || G.classes[0];
    this.cls = c.id; this.p = new Player(c, id); G.players = [this.p]; G.player = this.p;
  }
  // the hostile bodies from a snapshot's ents ({ id, x, y, z, radius, alive, boss, immune, tg, ay, my })
  world(ents) {
    const seen = new Set();
    for (const e of ents) {
      let s = this.shadows.get(e.id); if (!s) { s = new Shadow(e.id); this.shadows.set(e.id, s); }
      s.pos.set(e.x, e.y, e.z); s.radius = e.radius; s.alive = !!e.alive; s.isBoss = !!e.boss; s.immune = !!e.immune; s.targetable = e.tg !== false; s.facing = e.facing || 0;
      if (e.ay !== undefined) s.aimY = e.ay; if (e.my !== undefined) s.meleeY = e.my; s.hp = e.hp; s.maxHp = e.maxHp; seen.add(e.id);
    }
    for (const id of [...this.shadows.keys()]) if (!seen.has(id)) this.shadows.delete(id);
    G.ents.length = 0; for (const s of this.shadows.values()) G.ents.push(s);
    G.boss = G.ents.find((q) => q.isBoss) || null;
  }
  ent(id) { return this.shadows.get(id) || null; }
  // the fight's state the rules read (from the newest snapshot): 'intro' | 'fight' | ..., the cinematic lock, the fight clock
  scene(state, cine, ft) { G.state = state; G.cineLock = !!cine; Cam.cine = cine ? (Cam.cine || {}) : null; if (ft !== undefined) G.ft = ft; }
  load(st) { applyOwnState(this.p, st, (id) => this.ent(id)); }
  save() { return ownState(this.p); }
  // one tick: the frame, then the player's step (what fight.js tickAll + the step hook do for this player). sink: receives the
  // cues this tick raises (immediate feedback the first time a tick is simulated), or null during a replay.
  step(frame, sink) {
    const p = this.p; View.setSink(sink || null);
    try {
      G.dt = this.dt; G.now += this.dt; G.tick++; if (G.state === 'fight') G.ft += this.dt;
      applyInput(frame, p);
      G.actor = p; try { p.update(this.dt); } finally { G.actor = null; }
    } finally { View.setSink(null); Bul.clear(); Hz.list.length = 0; Co.clear(); }
  }
}
