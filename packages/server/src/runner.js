// One encounter on the server's fixed tick, for several players. The lobby (lobby.js) owns the sockets; this owns the sim.
// It runs inside a worker thread (fight-worker.js), one per running encounter, because the sim keeps its state at module
// level (one fight per JavaScript realm). Tests can also use it directly.
//
// Players are named by a key (the lobby's member id). Two kinds of input:
// - Tick-stamped frames (the browser client, which predicts its own character): { k, fs } carries the frames for ticks
//   k - fs.length + 1 .. k (the newest few again each time, so one late or lost message costs nothing). Each tick the runner
//   applies exactly the frame stamped for it, so the server steps the character through the same frames the client
//   predicted with. A frame that arrives after its tick has its presses applied on the next tick; a tick with no frame
//   repeats the last movement. How early frames arrive is measured and sent back (own().ia), and the client keeps its clock
//   just far enough ahead that they are on time.
// - Plain frames ({ f }: fake clients, tools): the latest move / held / facing is kept and one-shot actions (presses, jump,
//   target changes) are collected until the next tick, so nothing pressed between two ticks is lost.
import { startFight, tickAll, over, snapshot, stateHash, currentFight, addPlayer, removePlayer, swapClass, playerById, ownState, G, View } from '@axiom/sim';
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
    // a cue raised while a player acts (their skill, their update) carries that player's id third, so each client can keep
    // the screen-only ones (flash, shake, numbers, hit-stop) for the player they belong to
    View.setSink((name, args) => { if (!SEND_CUE(name)) return; const a = G.actor; this.cues.push(a ? [name, args, a.id] : [name, args]); });
    const s = this.setup;
    startFight({ boss: s.boss, nm: s.nm, seed: s.seed, intro: s.intro, phase: s.phase || 0, godMode: !!s.godMode, players: s.players.map((e) => ({ cls: e.cls, bot: e.bot ? 3 : 0, name: e.name })) });
    G.players.forEach((p, i) => this.bind(s.players[i].key, p));
    this.hz = currentFight().hz; this.def = G.boss.def;
    return this;
  }
  bind(key, p) { this.ids.set(key, p.id); this.inp.set(key, { mx: 0, mz: 0, held: 0, face: undefined, press: [], jump: 0, cycle: 0, target: undefined, cancelQueue: 0, stopCast: 0, at: G.now, buf: new Map(), recv: -1, stamped: false, margins: [], ia: null, late: 0, miss: 0 }); }
  player(key) { const id = this.ids.get(key); return id ? playerById(id) : null; }
  simId(key) { return this.ids.get(key) || null; }
  input(key, raw) {
    const q = this.inp.get(key); if (!q) return;
    const f = sanitizeFrame(raw);
    q.mx = f.mx; q.mz = f.mz; q.held = f.held; q.face = f.face; q.at = G.now;
    this.oneShots(q, f);
  }
  oneShots(q, f) {
    for (const i of f.press) if (q.press.length < 8) q.press.push(i);
    if (f.jump) q.jump = 1; if (f.cycle) q.cycle = f.cycle; if (f.target !== undefined) q.target = f.target; if (f.cancelQueue) q.cancelQueue = 1; if (f.stopCast) q.stopCast = 1;
  }
  // tick-stamped frames: fs[i] is the frame for tick k - fs.length + 1 + i
  frames(key, k, fs) {
    const q = this.inp.get(key); if (!q || !Number.isInteger(k) || !Array.isArray(fs)) return;
    q.stamped = true; q.at = G.now;
    const first = k - Math.min(fs.length, 8) + 1;
    if (k > q.recv) { q.margins.push(k - G.tick); if (q.margins.length > 60) q.margins.shift(); } // how many ticks early the newest frame is
    for (let t = Math.max(first, q.recv + 1); t <= k; t++) {
      const f = sanitizeFrame(fs[t - first]);
      if (t > G.tick) { if (t <= G.tick + 90) q.buf.set(t, f); } // in time: kept for its tick (a clock far ahead is ignored)
      else { this.oneShots(q, f); q.late++; q.mx = f.mx; q.mz = f.mz; q.held = f.held; q.face = f.face; } // too late for its tick: its presses go on the next
    }
    if (k > q.recv) q.recv = k;
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
      if (q.stamped) { // the frame stamped for this tick, after anything that came too late for its own
        const t = G.tick + 1, f = q.buf.get(t); for (const k of q.buf.keys()) if (k <= t) q.buf.delete(k);
        if (f) { q.mx = f.mx; q.mz = f.mz; q.held = f.held; q.face = f.face; this.oneShots(q, f); } else q.miss++;
      }
      const fresh = G.now - q.at < STALE;
      const f = { mx: fresh ? q.mx : 0, mz: fresh ? q.mz : 0, held: fresh ? q.held : 0, press: q.press, face: fresh ? q.face : undefined };
      if (f.face === undefined) delete f.face;
      if (q.jump) f.jump = 1; if (q.cycle) f.cycle = q.cycle; if (q.target !== undefined) f.target = q.target; if (q.cancelQueue) f.cancelQueue = 1; if (q.stopCast) f.stopCast = 1;
      q.press = []; q.jump = 0; q.cycle = 0; q.target = undefined; q.cancelQueue = 0; q.stopCast = 0;
      return f;
    });
    tickAll(frames);
    if (over() && !this.ended) { this.ended = true; this.endT = G.now; }
  }
  // the end of a fight is shown for a moment (the kill, the wipe) before the room goes back to the lobby
  // def.winHold: seconds to show a win (a boss with a long kill)
  get finished() { return this.ended && !this.hold && G.now - this.endT > (G.state === 'win' ? (G.boss && G.boss.def.winHold) || 6 : 4); }
  get result() { return G.state === 'win' ? 'win' : G.state === 'dead' ? 'dead' : 'ended'; }
  // one tick's message for every client: the snapshot and the cues it raised
  message() { const c = this.cues; this.cues = []; return JSON.stringify({ t: 'snap', s: snapshot(), c }); }
  // what only one client gets, next to the snapshot: their own character's whole state at this tick (for prediction), and
  // how early their input frames arrive (ia: ticks, the lower tenth of the last two seconds; late / miss: counts)
  own() {
    const out = [];
    for (const [key, id] of this.ids) {
      const p = playerById(id), q = this.inp.get(key); if (!p || !q) continue;
      let ia = null; if (q.margins.length) { const m = q.margins.slice().sort((a, b) => a - b); ia = m[Math.floor(m.length * 0.1)]; }
      out.push([key, JSON.stringify({ k: G.tick, id, cls: p.cls.id, bot: p.botLevel || 0, st: ownState(p), ia, late: q.late, miss: q.miss })]);
    }
    return out;
  }
  stats() {
    return G.players.map((p) => ({ id: p.id, name: p.name, cls: p.cls.id, dmg: Math.round(p.stats.dmg), dps: Math.round(p.stats.dmg / Math.max(1, G.ft)), taken: Math.round(p.stats.taken), alive: p.alive }));
  }
  hash() { return stateHash(); }
  // test hooks (tools/shots.js; only a server started with test: true passes them on): set the boss's health (a fraction),
  // push Pentimento's finale to a later sitting (fk), move the fight clock (ft, for the enrage), kill him, or hold the end
  test(o) {
    const b = G.boss; if (!b || !o) return;
    if (typeof o.hp === 'number') b.hp = Math.max(1, Math.min(b.maxHp, b.maxHp * o.hp));
    if (typeof o.fk === 'number' && b.state) b.state.fk = Math.max(b.state.fk || 0, o.fk);
    if (typeof o.ft === 'number') G.ft = Math.max(G.ft, o.ft);
    if (o.kill && b.alive) b.damage(b.hp + 1, { src: 'player' });
    if (o.hold) this.hold = true; // keep the end of the fight on screen (the kill cinematic is slow in software rendering)
  }
  // what a newcomer has missed of the picture (Pentimento: the paint already down), or null
  catchup() { const b = G.boss, d = b && b.def.catchup && b.def.catchup(b); return d ? JSON.stringify(Object.assign({ t: 'catchup', tick: G.tick, boss: b.def.id, nm: !!G.nightmare }, d)) : null; }
  stop() { View.setSink(null); }
}
