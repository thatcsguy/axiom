// A room: one fight on the server's fixed tick. For now one player (the sim is still single-player) driven by queued
// input frames, or by the bot when nobody is sending any. The socket side and the player list come in plan step 3.
//
// The sim keeps its state at module level (one fight per JavaScript realm), so a process can host one Room at a time.
// Several rooms will each get their own worker thread (worker_threads), which also keeps one slow fight from stalling the rest.
import { startFight, tick, over, snapshot, stateHash, currentFight, G } from '@axiom/sim';
import '@axiom/sim/bosses';
import { sanitizeFrame } from '@axiom/protocol';

export class Room {
  // setup: startFight options (boss, cls, seed, nm, phase, intro, god, godMode, superDmg, tickHz, bot)
  constructor(setup) { this.setup = Object.assign({ boss: 'atelier', cls: 'stormcaller', seed: Date.now() & 0xffffff, bot: 3 }, setup); this.inputs = new Map(); this.last = null; this.listeners = new Set(); }
  start() { startFight(this.setup); this.hz = currentFight().hz; this.tickNo = 0; return this; }
  get state() { return G.state; }
  get over() { return over(); }
  // A client stamps each frame with the tick it was made for. Frames for ticks already simulated are late and dropped
  // (the client predicts ahead of the server by half a round trip, so this is rare once plan step 4 is in).
  pushInput(forTick, frame) { if (forTick >= this.tickNo) this.inputs.set(forTick, sanitizeFrame(frame)); }
  step() {
    let f = this.inputs.get(this.tickNo); this.inputs.delete(this.tickNo);
    if (!f && this.last && !this.setup.bot) f = { mx: this.last.mx, mz: this.last.mz, held: this.last.held, face: this.last.face, press: [] }; // no frame: keep moving the way you were
    const applied = f ? tick(f) : tick(); // no frame and the bot on: the bot plays
    if (f) this.last = f;
    this.tickNo++;
    for (const fn of this.listeners) fn(this);
    return applied;
  }
  snapshot() { return snapshot(); }
  hash() { return stateHash(); }
  // run on a real-time clock at the room's tick rate; returns a stop function
  run(onEnd) {
    const ms = 1000 / this.hz; let next = performance.now(), stopped = false, timer = null;
    const loop = () => { if (stopped) return; const now = performance.now(); let guard = 5; while (now >= next && guard-- > 0) { this.step(); next += ms; if (this.over) { stopped = true; if (onEnd) onEnd(this); return; } } timer = setTimeout(loop, Math.max(0, next - performance.now())); };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  }
}
