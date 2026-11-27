// Record and replay a fight. A recording is the seed and setup plus one input frame per tick, with the state hash after
// every tick. Replaying feeds the frames back without the bot; any tick whose hash differs means the sim lost determinism
// (or the frame shape lost information). A recording from a real session is also a bug report anyone can re-run.
import { G } from './core.js';
import { View } from './view.js';
import { startFight, tickAll, over, currentFight } from './fight.js';
import { stateHash } from './hash.js';

// keep only what differs from an empty frame (JSON keeps doubles exact, so mx / mz replay bit for bit)
function pack(f) {
  const o = {};
  if (f.mx) o.mx = f.mx; if (f.mz) o.mz = f.mz; if (f.held) o.held = f.held; if (f.face !== undefined) o.face = f.face;
  if (f.jump) o.jump = 1; if (f.target !== undefined) o.target = f.target; if (f.cycle) o.cycle = f.cycle; if (f.cancelQueue) o.cancelQueue = 1; if (f.stopCast) o.stopCast = 1;
  if (f.press && f.press.length) o.press = f.press.slice();
  return o;
}

// setup: startFight options (boss, cls or players, seed, nm, phase, intro, god, godMode, superDmg, tickHz) plus bot (1..3).
// One player: each recorded frame is that player's frame. Several: each recorded frame is an array, one per player.
// maxSec: fight-clock limit. Stops a little after the fight ends, so the end screen state is in the recording too.
export function record(setup, maxSec = 600) {
  startFight(setup);
  const hz = currentFight().hz, frames = [], hashes = [];
  let tail = 10;
  for (let n = Math.round(maxSec * hz) + hz * 5; n > 0; n--) {
    const f = tickAll(); frames.push(f.length === 1 ? pack(f[0]) : f.map(pack));
    hashes.push(stateHash());
    if (over() && tail-- <= 0) break;
  }
  const players = setup.players && setup.players.map((e) => Object.assign({}, e, { bot: 0 })); // the replay drives every player from the frames
  return { v: 1, setup: Object.assign({}, setup, { bot: 0, tickHz: hz }, players ? { players } : {}), bot: setup.bot || 0, frames, hashes, end: { state: G.state, ft: G.ft, bossHp: G.boss.hp, errors: G.errors.slice() } };
}

// Feed a recording's frames back. Returns { ok, ticks, firstBad (tick index or -1), expected, got }.
// o.sink: attach a cue sink while replaying (checks that cues never change state).
export function replay(rec, o = {}) {
  if (o.sink) View.setSink(o.sink);
  try {
    startFight(Object.assign({}, rec.setup, { bot: 0 }));
    for (let i = 0; i < rec.frames.length; i++) {
      const fr = rec.frames[i], full = (q) => Object.assign({ mx: 0, mz: 0, held: 0, press: [] }, q);
      tickAll(Array.isArray(fr) ? fr.map(full) : [full(fr)]);
      const h = stateHash();
      if (h !== rec.hashes[i]) return { ok: false, ticks: i + 1, firstBad: i, expected: rec.hashes[i], got: h, state: G.state, ft: G.ft };
    }
    return { ok: true, ticks: rec.frames.length, firstBad: -1, state: G.state, ft: G.ft };
  } finally { if (o.sink) View.setSink(null); }
}
