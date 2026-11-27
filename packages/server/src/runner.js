// One encounter on the server's fixed tick, for several players. The lobby (lobby.js) owns the sockets; this owns the sim.
// It runs inside a worker thread (fight-worker.js), one per running encounter, because the sim keeps its state at module
// level (one fight per JavaScript realm). Tests can also use it directly.
//
// Players are named by a key (the lobby's member id). Input arrives whenever the socket delivers it; the runner keeps the
// latest move / held / facing per player and collects one-shot actions (presses, jump, target changes) until the next tick,
// so nothing a client pressed between two ticks is lost.
import { startFight, tickAll, over, snapshot, stateHash, currentFight, addPlayer, removePlayer, swapClass, playerById, G, View } from '@axiom/sim';
import '@axiom/sim/bosses';
import { sanitizeFrame } from '@axiom/protocol';

// Cues the client does something with. Sound and music are left out until the client plays audio.
const SEND_CUE = (name) => !name.startsWith('sound.') && !name.startsWith('music.') && name !== 'ui.slotFlash';
const STALE = 0.6; // seconds without input before a player's character stops walking (a dropped or frozen client)

export class FightRunner {
  // setup: { boss, nm, seed, intro, players: [{ key, cls, name, bot }] }
  constructor(setup) {
    this.setup = Object.assign({ seed: (Math.random() * 0xffffff) | 0, intro: true }, setup);
    this.inp = new Map(); this.ids = new Map(); this.cues = []; this.ended = false; this.endT = 0;
  }
  start() {
    View.setSink((name, args) => { if (SEND_CUE(name)) this.cues.push([name, args]); });
    const s = this.setup;
    startFight({ boss: s.boss, nm: s.nm, seed: s.seed, intro: s.intro, players: s.players.map((e) => ({ cls: e.cls, bot: e.bot ? 3 : 0, name: e.name })) });
    G.players.forEach((p, i) => this.bind(s.players[i].key, p));
    this.hz = currentFight().hz; this.def = G.boss.def;
    return this;
  }
  bind(key, p) { this.ids.set(key, p.id); this.inp.set(key, { mx: 0, mz: 0, held: 0, face: undefined, press: [], jump: 0, cycle: 0, target: undefined, cancelQueue: 0, at: G.now }); }
  player(key) { const id = this.ids.get(key); return id ? playerById(id) : null; }
  simId(key) { return this.ids.get(key) || null; }
  input(key, raw) {
    const q = this.inp.get(key); if (!q) return;
    const f = sanitizeFrame(raw);
    q.mx = f.mx; q.mz = f.mz; q.held = f.held; q.face = f.face; q.at = G.now;
    for (const i of f.press) if (q.press.length < 8) q.press.push(i);
    if (f.jump) q.jump = 1; if (f.cycle) q.cycle = f.cycle; if (f.target !== undefined) q.target = f.target; if (f.cancelQueue) q.cancelQueue = 1;
  }
  auto(key, on) { const p = this.player(key); if (p) { p.botLevel = on ? 3 : 0; if (!on) p.input.mx = p.input.mz = 0; } }
  // the training dummy only (the lobby checks): walk in, walk out, change class where you stand
  join(entry) { const p = addPlayer({ cls: entry.cls, name: entry.name, bot: entry.bot ? 3 : 0 }); this.bind(entry.key, p); return p.id; }
  leave(key) { const id = this.ids.get(key); if (id) removePlayer(id); this.ids.delete(key); this.inp.delete(key); }
  swap(key, cls) { const id = this.ids.get(key); const p = id && swapClass(id, cls); return p ? p.id : null; }
  step() {
    const frames = G.players.map((p) => {
      if (p.botLevel) return undefined; // the autopilot plays this one
      let key = null; for (const [k, id] of this.ids) if (id === p.id) { key = k; break; }
      const q = key && this.inp.get(key); if (!q) return { mx: 0, mz: 0, held: 0, press: [] };
      const fresh = G.now - q.at < STALE;
      const f = { mx: fresh ? q.mx : 0, mz: fresh ? q.mz : 0, held: fresh ? q.held : 0, press: q.press, face: fresh ? q.face : undefined };
      if (f.face === undefined) delete f.face;
      if (q.jump) f.jump = 1; if (q.cycle) f.cycle = q.cycle; if (q.target !== undefined) f.target = q.target; if (q.cancelQueue) f.cancelQueue = 1;
      q.press = []; q.jump = 0; q.cycle = 0; q.target = undefined; q.cancelQueue = 0;
      return f;
    });
    tickAll(frames);
    if (over() && !this.ended) { this.ended = true; this.endT = G.now; }
  }
  // the end of a fight is shown for a moment (the kill, the wipe) before the room goes back to the lobby
  get finished() { return this.ended && G.now - this.endT > (G.state === 'win' ? 6 : 4); }
  get result() { return G.state === 'win' ? 'win' : G.state === 'dead' ? 'dead' : 'ended'; }
  // one tick's message for every client: the snapshot and the cues it raised
  message() { const c = this.cues; this.cues = []; return JSON.stringify({ t: 'snap', s: snapshot(), c }); }
  stats() {
    return G.players.map((p) => ({ id: p.id, name: p.name, cls: p.cls.id, dmg: Math.round(p.stats.dmg), dps: Math.round(p.stats.dmg / Math.max(1, G.ft)), taken: Math.round(p.stats.taken), alive: p.alive }));
  }
  hash() { return stateHash(); }
  stop() { View.setSink(null); }
}
