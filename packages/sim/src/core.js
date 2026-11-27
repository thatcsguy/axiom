// Core sim state: the G namespace, seeded randomness, coroutines and the step. Carried over from Threshold's 01_core.js
// with the renderer, post chain, settings storage and main loop removed. The sim only moves when step(dt) is called,
// and the fight driver (fight.js) only ever calls it with a fixed tick.
import { createRng } from './rng.js';
import { View, bindDt } from './view.js';

export const G = {
  now: 0,          // sim clock (seconds since the fight was created)
  ft: 0,           // fight clock (seconds since the pull)
  dt: 0,           // the current step's length
  tick: 0,         // steps taken since the fight was created
  state: 'idle',   // idle | intro | fight | dead | win
  timeScale: 1,    // boss-driven slow motion: the fight driver multiplies the tick by it (hit-stop is client-only)
  bosses: [],      // registered boss definitions
  classes: [],     // registered class definitions
  players: [],     // everyone in the fight, in join order (1 to 4; the training dummy takes more)
  player: null,    // players[0]: kept for solo-era tools and the debug viewer. Rules never read it (they take a player, or loop over players).
  actor: null,     // the player whose input, skill or update is running right now: damage dealt is credited to them
  boss: null, arena: null,
  ents: [],        // hostile entities (boss + adds)
  errors: [],
  nightmare: false,
  rehearsing: false, // Threshold's invisible pre-fight rehearsal; never true in the sim, kept so carried-over checks read the same
  cineLock: false,
  god: false,      // never take damage (Threshold's ?god)
  opts: { godMode: false, superDmg: false }, // Threshold's Settings > Testing toggles
  testUsed: false,
  rng: createRng(1),
  // Threshold's code skips purely cosmetic work when headless. Here that means: no one is listening for cues.
  get headless() { return !View.listening; },
};
bindDt(() => G.dt);

export const rnd = (a = 1, b) => b === undefined ? G.rng() * a : a + G.rng() * (b - a);
export const rndi = (a, b) => Math.floor(rnd(a, b + 1));
export const pick = (arr) => arr[Math.floor(G.rng() * arr.length)];
export const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(G.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const vrand = Math.random; // cosmetic-only randomness (never affects the sim; only feeds cue arguments)
export const NM = (normal, nightmare) => G.nightmare ? nightmare : normal; // pick a number by difficulty

// players still standing, in join order
export const livePlayers = () => G.players.filter((p) => p.alive);
// the nearest standing player to (x, z), or players[0] when nobody stands (callers only aim; nothing is hurt through it)
export function nearestPlayer(x, z) {
  let best = null, bd = Infinity;
  for (const p of G.players) { if (!p.alive) continue; const d = Math.hypot(p.pos.x - x, p.pos.z - z); if (d < bd) { bd = d; best = p; } }
  return best || G.players[0] || null;
}
// run fn with p as the acting player (damage it deals is credited to p)
export function asActor(p, fn) { const prev = G.actor; G.actor = p; try { return fn(); } finally { G.actor = prev; } }

export function reportError(e) {
  const msg = (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e);
  if (G.errors.length < 30) G.errors.push(msg);
}

// ---------- coroutines ----------
// Boss scripts are generator functions. `yield 1.5` waits 1.5 sim seconds, `yield () => cond` waits until cond() is true,
// a bare `yield` waits one step, and `yield* other(...)` calls another script inline. Waits carry their remainder, so a
// script's timeline does not drift with the step size.
export const Co = {
  list: [],
  start(gen, tag = 'fight') { if (typeof gen === 'function') gen = gen(); const c = { gen, tag, wait: 0, cond: null, dead: false }; this.list.push(c); return c; },
  stop(c) { if (c && !c.dead) { c.dead = true; try { c.gen.return(); } catch (e) { /* ignore */ } } },
  stopTag(tag) { for (const c of this.list) if (c.tag === tag) this.stop(c); },
  clear() { for (const c of this.list) this.stop(c); this.list.length = 0; },
  update(dt) {
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      const c = L[i]; if (c.dead) continue;
      if (c.cond) { let ok = false; try { ok = c.cond(); } catch (e) { reportError(e); ok = true; } if (!ok) continue; c.cond = null; c.wait = 0; }
      else if (c.wait > 0) { c.wait -= dt; if (c.wait > 0) continue; }
      let guard = 0;
      while (!c.dead && guard++ < 50) {
        let r; try { r = c.gen.next(); } catch (e) { reportError(e); c.dead = true; break; }
        if (r.done) { c.dead = true; break; }
        const v = r.value;
        if (typeof v === 'number') { c.wait += v; if (c.wait > 0) break; }
        else if (typeof v === 'function') { c.cond = v; break; }
        else { c.wait = 0; break; }
      }
    }
    for (let i = L.length - 1; i >= 0; i--) if (L[i].dead) L.splice(i, 1);
  },
};

// ---------- step ----------
// Modules push their per-step update here, in Threshold's file order: hazards, bullets, then the fight (player, entities, boss).
export const Hooks = { step: [] };
export function step(dt) {
  G.dt = dt; G.now += dt; G.tick++;
  if (G.state === 'fight') G.ft += dt;
  Co.update(dt);
  for (const f of Hooks.step) f(dt);
}
