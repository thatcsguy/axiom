// The fight driver: creates a fight, applies one input frame per tick, and steps the sim at a fixed rate.
// Replaces Threshold's 10_game.js (menus, loading, rehearsal, records, screens and the death/kill cinematics are client work)
// and the stepping half of its main loop and __game.fastForward.
//
// One fight per JavaScript realm: the sim state is module-level, as it was in Threshold, so starting a fight ends the last
// one. The server runs each room in its own worker thread (plan step 3); tests run fights one after another.
import { G, Co, Hooks, step as simStep } from './core.js';
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
  G.player = null; G.boss = null; G.arena = null; G.ents.length = 0; G.cineLock = false;
}

// A door's nightmare version is its def with the `nightmare` block laid over it (prototype chain, so anything not
// overridden reads through to the normal def). Built once per def and cached.
export function nightmareDef(base) { return base._nmDef || (base._nmDef = Object.assign(Object.create(base), base.nightmare, { base, nm: true })); }

function* runIntro(def, opts) {
  const b = G.boss, p = G.player;
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

function onPlayerDead() {
  if (G.state !== 'fight') return; G.state = 'dead'; G.boss.logPhase();
  View.cue('fight.dead', G.player.deathSrc && (typeof G.player.deathSrc === 'string' ? G.player.deathSrc : G.player.deathSrc.name || 'hit'));
}
bindPlayerDeath(() => onPlayerDead());

function onBossDead() {
  if (G.state !== 'fight') return; G.state = 'win'; const b = G.boss, p = G.player;
  Co.stopTag('phase'); for (const e of G.ents) if (e.isAdd && e.alive) e.die(); Co.stopTag('fight'); Hz.clear(); Bul.clear(); p.invuln = 999;
  b.logPhase(); Music.stop(3); Sound.sfx('kill'); FX.flash(0xffffff, 0.5, 1.2);
  View.cue('fight.win', G.ft); // the kill cinematic (def.death in Threshold) is the client's
}

// One lock for every cinematic: the intro, the kill, and any shot a boss plays mid-fight (Threshold PR #86).
function cineLock() { return G.state === 'intro' || G.state === 'win' || (G.state === 'fight' && !!Cam.cine); }
Hooks.step.push(() => {
  const p = G.player, b = G.boss; if (!p || !b) { G.cineLock = false; return; }
  G.cineLock = cineLock();
  if (G.state === 'fight' || G.state === 'intro' || G.state === 'dead' || G.state === 'win') {
    p.update(G.dt);
    for (let i = G.ents.length - 1; i >= 0; i--) { const e = G.ents[i]; if (e.alive || e.isBoss) e.update(G.dt); else G.ents.splice(i, 1); }
    if (G.arena.update) G.arena.update(G.dt, G.now);
    if (b.def.update) b.def.update(b, G.dt);
    if (G.state === 'fight' && !b.alive) onBossDead();
  }
});

// opts: { boss: id, cls: id, seed, nm, phase, intro, bot: 0..3, god, godMode, superDmg, tickHz }
export function startFight(opts = {}) {
  const base = G.bosses.find((d) => d.id === opts.boss) || G.bosses[0];
  if (!base) throw new Error('no boss registered (import @axiom/sim/bosses)');
  const nm = !!opts.nm && !!base.nightmare, def = nm ? nightmareDef(base) : base;
  const cls = G.classes.find((c) => c.id === opts.cls) || G.classes[0];
  clearWorld(); resetIds();
  G.rng = createRng(opts.seed === undefined ? 1 : opts.seed);
  G.now = 0; G.ft = 0; G.tick = 0; G.dt = 0; G.errors = []; G.nightmare = nm; G.testUsed = false;
  G.god = !!opts.god; G.opts = { godMode: !!opts.godMode, superDmg: !!opts.superDmg };
  Bot.reset(); Bot.level = opts.bot || 0;
  G.state = 'loading';
  const b = G.boss = new Boss(def); G.ents.push(b);
  const A = G.arena = def.build(b) || {};
  A.floorY = A.floorY || 0; A.edge = A.edge || 'wall';
  if (!A.contains) A.contains = (x, z) => Math.hypot(x, z) <= (A.radius || 20);
  if (!A.clamp) A.clamp = (p) => { const r = (A.radius || 20) - 0.4, d = Math.hypot(p.x, p.z); if (d > r) { p.x *= r / d; p.z *= r / d; } };
  const bs = A.bossStart || { x: 0, z: 0, face: 0 }; b.pos.set(bs.x, bs.y || 0, bs.z); b.facing = bs.face || 0;
  const p = G.player = new Player(cls, 1); const sp = A.spawn || { x: 0, z: 12 };
  p.pos.set(sp.x, A.floorY, sp.z); p.facing = sp.face !== undefined ? sp.face : angTo(sp.x, sp.z, b.pos.x, b.pos.z); p.target = b; b.P = p;
  const hz = opts.tickHz || TICK_HZ;
  fight = { def, opts, dt: 1 / hz, hz };
  Co.start(runIntro(def, opts), 'sys');
  return fight;
}

// Apply one input frame to the player. Order matters and is the same for a client, a recording and the bot:
// move, jump, target, queue cancel, then presses in order.
// frame: { mx, mz (world-space move, length <= 1), held (bit i = slot i held), face (yaw while steering), jump, target (entity id),
//          cycle (+1 / -1: next / previous target), cancelQueue, press: [slot, ...] }
export function applyInput(frame) {
  const p = G.player; if (!p || !frame) return;
  p.input.mx = frame.mx || 0; p.input.mz = frame.mz || 0; p.input.held = frame.held || 0; p.input.face = frame.face;
  // No gate here on purpose: the player itself refuses what it cannot do (dead, a cinematic lock, a dash), exactly as it
  // did for Threshold's bot, so a bot fight and the replay of its frames apply the same things in the same order.
  if (frame.jump) p.jump();
  if (frame.target !== undefined) { const e = G.ents.find((q) => q.id === frame.target); if (e) p.target = e; }
  if (frame.cycle) p.cycleTarget(frame.cycle);
  if (frame.cancelQueue) p.queue = -1;
  if (frame.press) for (const i of frame.press) p.press(i);
}

// Advance one tick. With a frame, the frame drives the player; without one, the bot does (if on) and the frame it built is
// returned, so the caller can record it. Returns the frame that was applied.
export function tick(frame) {
  if (!fight) throw new Error('no fight started');
  const dt = fight.dt * G.timeScale;
  let applied;
  if (frame) { applyInput(frame); applied = frame; }
  else {
    applied = emptyFrame();
    if (Bot.level) Bot.update(dt, applied); else applyInput(applied);
  }
  simStep(dt);
  return applied;
}

export function currentFight() { return fight; }
export const over = () => G.state === 'dead' || G.state === 'win';
