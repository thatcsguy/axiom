// The fight driver: creates a fight, applies one input frame per tick, and steps the sim at a fixed rate.
// Replaces Threshold's 10_game.js (menus, loading, rehearsal, records, screens and the death/kill cinematics are client work)
// and the stepping half of its main loop and __game.fastForward.
//
// One fight per JavaScript realm: the sim state is module-level, as it was in Threshold, so starting a fight ends the last
// one. The server runs each room in its own worker thread (plan step 3); tests run fights one after another.
import { G, Co, Hooks, step as simStep, asActor } from './core.js';
import { createRng } from './rng.js';
import { clamp, angTo } from './math.js';
import { Hz, Bul, Boss, resetIds } from './combat.js';
import { Player, bindPlayerDeath } from './player.js';
import { Bot, emptyFrame } from './bot.js';
import { Cam, Music, Sound, FX, View } from './view.js';

export const TICK_HZ = 30;

let fight = null; // { def, opts, tick, dt }

function clearWorld() {
  Co.clear(); Hz.list.length = 0; Bul.clear(); Cam.reset(); G.timeScale = 1;
  G.player = null; G.players = []; G.actor = null; G.boss = null; G.arena = null; G.ents.length = 0; G.cineLock = false;
}

// A door's nightmare version is its def with the `nightmare` block laid over it (prototype chain, so anything not
// overridden reads through to the normal def). Built once per def and cached.
export function nightmareDef(base) { return base._nmDef || (base._nmDef = Object.assign(Object.create(base), base.nightmare, { base, nm: true })); }

function* runIntro(def, opts) {
  const b = G.boss, p = G.players[0];
  G.state = 'intro';
  if (opts.intro) {
    yield 0.3;
    if (def.intro) yield* def.intro(b);
    else { const a = angTo(b.pos.x, b.pos.z, p.pos.x, p.pos.z), r = b.radius * 2 + 9, h = b.aimY; yield* Cam.shot([b.pos.x + Math.sin(a + 0.9) * r, h + 2, b.pos.z + Math.cos(a + 0.9) * r], [b.pos.x, h, b.pos.z], [b.pos.x + Math.sin(a - 0.3) * r * 1.2, h + 4, b.pos.z + Math.cos(a - 0.3) * r * 1.2], [b.pos.x, h * 0.8, b.pos.z], 4.2); }
    Cam.release(); yield 0.7;
  } else Cam.release();
  G.state = 'fight'; G.ft = 0; G.testUsed = !!(G.opts.godMode || G.opts.superDmg);
  const start = clamp(opts.phase || 0, 0, def.phases.length - 1);
  if (start > 0) { b.hp = Math.min(b.maxHp, b.maxHp * def.phases[start].at - 1); for (let i = 0; i < start; i++) if (def.phases[i + 1] && def.phases[i + 1].skipTo) def.phases[i + 1].skipTo(b); }
  b.goPhase(start);
}

const srcName = (p) => p.deathSrc && (typeof p.deathSrc === 'string' ? p.deathSrc : p.deathSrc.name || 'hit');
// One player down is a cue; everyone down is a wipe. (No raises yet: docs/plan.md suggests them, Patrick has not decided.)
function onPlayerDead(p) {
  if (G.state !== 'fight') return;
  View.cue('fight.down', p.id, srcName(p));
  if (G.players.some((q) => q.alive)) return;
  G.state = 'dead'; G.boss.logPhase();
  View.cue('fight.dead', srcName(p));
}
bindPlayerDeath((p) => onPlayerDead(p));

function onBossDead() {
  if (G.state !== 'fight') return; G.state = 'win'; const b = G.boss;
  Co.stopTag('phase'); for (const e of G.ents) if (e.isAdd && e.alive) e.die(); Co.stopTag('fight'); Hz.clear(); Bul.clear(); for (const p of G.players) p.invuln = 999;
  b.logPhase(); Music.stop(3); Sound.sfx('kill'); FX.flash(0xffffff, 0.5, 1.2);
  View.cue('fight.win', G.ft); // the kill cinematic (def.death in Threshold) is the client's
}

// One lock for every cinematic: the intro, the kill, and any shot a boss plays mid-fight (Threshold PR #86).
function cineLock() { return G.state === 'intro' || G.state === 'win' || (G.state === 'fight' && !!Cam.cine); }
Hooks.step.push(() => {
  const b = G.boss; if (!G.players.length || !b) { G.cineLock = false; return; }
  G.cineLock = cineLock();
  if (G.state === 'fight' || G.state === 'intro' || G.state === 'dead' || G.state === 'win') {
    for (const p of G.players) { G.actor = p; p.update(G.dt); } G.actor = null;
    for (let i = G.ents.length - 1; i >= 0; i--) { const e = G.ents[i]; if (e.alive || e.isBoss) e.update(G.dt); else G.ents.splice(i, 1); }
    if (G.arena.update) G.arena.update(G.dt, G.now);
    if (b.def.update) b.def.update(b, G.dt);
    if (G.state === 'fight' && !b.alive) onBossDead();
  }
});

// Boss health for a party (docs/plan.md, "Scaling": roughly 0.9 x base x players). A def can opt out (the training dummy).
export const hpScale = (n) => n <= 1 ? 1 : 0.9 * n;
export const MAX_PLAYERS = 4;
const findCls = (id) => G.classes.find((c) => c.id === id) || G.classes[0];

// Where the k-th player stands at the pull: the arena's spawn, then a line either side of it, facing the boss.
function spawnAt(A, k) {
  const sp = A.spawn || { x: 0, z: 12 }; if (!k) return { x: sp.x, z: sp.z };
  const side = k % 2 ? -1 : 1, step = Math.ceil(k / 2) * 1.8, a = Math.atan2(sp.x, sp.z) + Math.PI / 2;
  return { x: sp.x + Math.sin(a) * step * side, z: sp.z + Math.cos(a) * step * side };
}
function makePlayer(entry, k) {
  const A = G.arena, b = G.boss, p = new Player(findCls(entry.cls), nextPid++), at = entry.at || spawnAt(A, k), sp = A.spawn || {};
  p.pos.set(at.x, A.floorY, at.z); p.facing = entry.facing !== undefined ? entry.facing : k === 0 && sp.face !== undefined ? sp.face : angTo(at.x, at.z, b.pos.x, b.pos.z); p.target = b;
  p.botLevel = entry.bot !== undefined ? entry.bot : Bot.level; p.botS = { timer: 0, goal: null, pressT: 0 }; p.name = entry.name || '';
  return p;
}
let nextPid = 1;

// opts: { boss: id, seed, nm, phase, intro, bot: 0..3, god, godMode, superDmg, tickHz,
//         players: [{ cls, bot, name }, ...] (1 to 4; the training dummy takes up to 8)  or, for one player, cls: id }
export function startFight(opts = {}) {
  const base = G.bosses.find((d) => d.id === opts.boss) || G.bosses[0];
  if (!base) throw new Error('no boss registered (import @axiom/sim/bosses)');
  const nm = !!opts.nm && !!base.nightmare, def = nm ? nightmareDef(base) : base;
  const party = (opts.players && opts.players.length ? opts.players : [{ cls: opts.cls }]).slice(0, def.maxPlayers || MAX_PLAYERS);
  clearWorld(); resetIds(); nextPid = 1;
  G.rng = createRng(opts.seed === undefined ? 1 : opts.seed);
  G.now = 0; G.ft = 0; G.tick = 0; G.dt = 0; G.errors = []; G.nightmare = nm; G.testUsed = false;
  G.god = !!opts.god; G.opts = { godMode: !!opts.godMode, superDmg: !!opts.superDmg };
  Bot.level = opts.bot || 0;
  G.state = 'loading';
  const b = G.boss = new Boss(def); G.ents.push(b);
  if (!def.noScale) b.maxHp = b.hp = Math.round(b.maxHp * hpScale(party.length));
  const A = G.arena = def.build(b) || {};
  A.floorY = A.floorY || 0; A.edge = A.edge || 'wall';
  if (!A.contains) A.contains = (x, z) => Math.hypot(x, z) <= (A.radius || 20);
  if (!A.clamp) A.clamp = (p) => { const r = (A.radius || 20) - 0.4, d = Math.hypot(p.x, p.z); if (d > r) { p.x *= r / d; p.z *= r / d; } };
  const bs = A.bossStart || { x: 0, z: 0, face: 0 }; b.pos.set(bs.x, bs.y || 0, bs.z); b.facing = bs.face || 0;
  party.forEach((e, k) => G.players.push(makePlayer(e, k)));
  G.player = b.P = G.players[0];
  const hz = opts.tickHz || TICK_HZ;
  fight = { def, opts, dt: 1 / hz, hz };
  Co.start(runIntro(def, opts), 'sys');
  return fight;
}

// A player joins a fight already running (the training dummy lets people walk in). Returns the new player.
export function addPlayer(entry = {}) {
  if (!fight) throw new Error('no fight started');
  const p = makePlayer(entry, G.players.length); G.players.push(p); if (!G.player) G.player = G.boss.P = p;
  return p;
}
// A player leaves a fight (the training dummy; in a boss fight the server hands a dropped player to the bot instead).
export function removePlayer(id) {
  const i = G.players.findIndex((p) => p.id === id); if (i < 0) return false;
  G.players.splice(i, 1); G.player = G.boss.P = G.players[0] || null; return true;
}
// Swap a player's class where they stand (the training dummy: try every class). A fresh character: full health, cooldowns reset.
export function swapClass(id, cls) {
  const i = G.players.findIndex((p) => p.id === id); if (i < 0) return null;
  const o = G.players[i], p = new Player(findCls(cls), o.id);
  p.pos.copy(o.pos); p.facing = o.facing; p.target = o.target; p.botLevel = o.botLevel; p.botS = { timer: 0, goal: null, pressT: 0 }; p.name = o.name;
  G.players[i] = p; if (i === 0) G.player = G.boss.P = p;
  if (G.boss.def.onSwap) G.boss.def.onSwap(G.boss, p);
  return p;
}
export const playerById = (id) => G.players.find((p) => p.id === id) || null;

// Apply one input frame to a player. Order matters and is the same for a client, a recording and the bot:
// move, jump, target, queue cancel, then presses in order.
// frame: { mx, mz (world-space move, length <= 1), held (bit i = slot i held), face (yaw while steering), jump, target (entity id),
//          cycle (+1 / -1: next / previous target), cancelQueue, press: [slot, ...] }
export function applyInput(frame, p = G.players[0]) {
  if (!p || !frame) return;
  G.actor = p; try { applyTo(p, frame); } finally { G.actor = null; }
}
function applyTo(p, frame) {
  p.input.mx = frame.mx || 0; p.input.mz = frame.mz || 0; p.input.held = frame.held || 0; p.input.face = frame.face;
  // No gate here on purpose: the player itself refuses what it cannot do (dead, a cinematic lock, a dash), exactly as it
  // did for Threshold's bot, so a bot fight and the replay of its frames apply the same things in the same order.
  if (frame.jump) p.jump();
  if (frame.target !== undefined) { const e = G.ents.find((q) => q.id === frame.target); if (e) p.target = e; }
  if (frame.cycle) p.cycleTarget(frame.cycle);
  if (frame.cancelQueue) p.queue = -1;
  if (frame.press) for (const i of frame.press) p.press(i);
}

// Advance one tick. frames[i] drives G.players[i]; a missing frame means that player's bot plays (if it has one, else an
// empty frame), and the frame it built is returned, so the caller can record it. Returns the frames applied, in player order.
export function tickAll(frames) {
  if (!fight) throw new Error('no fight started');
  const dt = fight.dt * G.timeScale, L = G.players.slice(), out = new Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const p = L[i], f = frames && frames[i];
    if (f) { applyInput(f, p); out[i] = f; }
    else {
      const a = out[i] = emptyFrame();
      if (p.botLevel) asActor(p, () => Bot.update(dt, a, p)); else applyInput(a, p);
    }
  }
  simStep(dt);
  return out;
}
// The one-player form: a frame for the first player (or none, for its bot). Returns the frame applied to the first player.
export function tick(frame) { return tickAll(frame ? [frame] : undefined)[0]; }

export function currentFight() { return fight; }
export const over = () => G.state === 'dead' || G.state === 'win';
