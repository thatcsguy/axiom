// A per-tick state hash: FNV-1a over the exact bits of every number that decides the fight. Two runs that agree on every
// tick agree on everything the rules can see. Used by tools/replay.js and test/determinism.test.js.
//
// It walks the player, every entity, every hazard and bullet, the coroutine waits, the RNG state and each boss's whole
// `state` object (deeply: numbers, booleans, strings, typed arrays). It skips functions, `pub` (view data derived from state)
// and `botMem` (the autopilot's scratch memory, which a replay without the bot does not have).
import { G, Co } from './core.js';
import { Hz, Bul } from './combat.js';

const buf = new DataView(new ArrayBuffer(8));
let h = 0x811c9dc5;
// FNV-1a style mixing, one 32-bit word at a time (a byte at a time cost more than the sim itself)
function word(w) { h ^= w; h = Math.imul(h, 0x01000193) >>> 0; }
const byte = word;
function num(v) { buf.setFloat64(0, typeof v === 'number' ? v : v ? 1 : 0); word(buf.getUint32(0)); word(buf.getUint32(4)); }
function str(s) { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); byte(c & 255); byte(c >> 8); } byte(0); }
const SKIP = new Set(['pub', 'botMem', 'def', 'P', 'gen']);
function deep(v, depth, seen) {
  if (v === null || v === undefined) { byte(1); return; }
  const t = typeof v;
  if (t === 'number' || t === 'boolean') { num(v); return; }
  if (t === 'string') { str(v); return; }
  if (t !== 'object' || depth > 6) return;
  if (seen.has(v)) { byte(2); if (typeof v.id === 'number') num(v.id); return; }
  seen.add(v);
  if (ArrayBuffer.isView(v)) {
    const n4 = v.byteOffset % 4 === 0 ? v.byteLength >> 2 : 0, u = new Uint32Array(v.buffer, v.byteOffset, n4);
    for (let i = 0; i < n4; i++) word(u[i]);
    const tail = new Uint8Array(v.buffer, v.byteOffset + n4 * 4, v.byteLength - n4 * 4); for (let i = 0; i < tail.length; i++) word(tail[i]);
    return;
  }
  if (Array.isArray(v)) { num(v.length); for (const q of v) deep(q, depth + 1, seen); return; }
  for (const k of Object.keys(v)) { if (SKIP.has(k)) continue; const q = v[k]; if (typeof q === 'function') continue; str(k); deep(q, depth + 1, seen); }
}

function player(p) {
  num(p.id); str(p.cls.id); num(p.pos.x); num(p.pos.y); num(p.pos.z); num(p.facing); num(p.hp); num(p.res); num(p.gcd); num(p.vy); num(p.alive); num(p.grounded);
  num(p.queue); num(p.combo); num(p.shield); num(p.parryT); num(p.dodgeT); num(p.invuln); num(p.speedMul); num(p.stats.dmg); num(p.stats.taken);
  num(p.target ? p.target.id : -1); num(p.casting ? p.casting.i * 1000 + p.casting.t : -1);
  for (const st of p.sk) if (st) { num(st.cd); num(st.charges); num(st.uses === Infinity ? -1 : st.uses); }
  for (const b of p.buffs) { str(b.id); num(b.t); }
  if (p.cyl) str(p.cyl.join('')); if (p.sc) { num(p.sc.glow); num(p.sc.next); num(p.sc.charged); }
}

export function stateHash() {
  h = 0x811c9dc5;
  num(G.tick); num(G.now); num(G.ft); str(G.state); num(G.rng.state); num(G.timeScale); num(G.cineLock);
  num(G.players.length); for (const p of G.players) player(p);
  for (const e of G.ents) {
    num(e.id); num(e.pos.x); num(e.pos.z); num(e.facing); num(e.hp); num(e.alive); num(e.immune); num(e.dmgTaken); num(e.exposed);
    num(e.castState ? e.castState.t : -1);
    if (e.isBoss) { num(e.focusId); num(e.rr); num(e.phase); num(e.transitioning); num(e.liveT || 0); num(e.enraged); deep(e.state, 0, new Set()); }
  }
  for (const z of Hz.list) { num(z.id); str(z.state); num(z.t); const s = z.shape; num(s.x); num(s.z); num(s.dir || 0); num(s.r || s.len || s.r1 || 0); }
  for (const b of Bul.list) { num(b.id); num(b.x); num(b.z); num(b.dir); num(b.speed); num(b.t); }
  for (const c of Co.list) { str(c.tag); num(c.wait); }
  return h >>> 0;
}
