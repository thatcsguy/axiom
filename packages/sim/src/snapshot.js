// Plain-data picture of the fight for a viewer: channel 1 (entity state) and channel 2 (each boss's `pub`) of docs/plan.md,
// plus the hazard and bullet lists. The network protocol will send hazards and bullets once as events (plan: "Dodge timing");
// until then the snapshot carries them whole, which is what the worker viewer uses.
import { G } from './core.js';
import { Hz, Bul } from './combat.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

function playerSnap(p) {
  return {
      id: p.id, name: p.name || '', cls: p.cls.id, x: r3(p.pos.x), y: r3(p.pos.y), z: r3(p.pos.z), facing: r3(p.facing), hp: Math.round(p.hp), maxHp: p.maxHp, alive: p.alive,
      res: p.res, resMax: p.resMax, gcd: r3(p.gcd), gcdMax: p.gcdMax, shield: Math.round(p.shield), target: p.target ? p.target.id : null,
      casting: p.casting ? { slot: p.casting.i, t: r3(p.casting.t), time: p.casting.time, name: p.casting.name } : null,
      buffs: p.buffs.map((q) => ({ id: q.id, t: r3(q.t), dur: q.dur })),
      slots: p.sk.map((st) => st ? { id: st.def.id, name: st.def.name, cd: r3(st.cd), maxCd: st.def.cd || 0, charges: st.charges, uses: st.uses === Infinity ? null : st.uses, why: p.block(p.sk.indexOf(st)) } : null),
      dmg: Math.round(p.stats.dmg), taken: Math.round(p.stats.taken), bot: p.botLevel || 0,
      // what the hero model animates from (Threshold's hero update reads these)
      anim: { ms: r3(p.moveSpeed), gr: p.grounded, parry: p.parryT > 0, roll: r3(p.rollT), aim: p.aimT > 0, load: p.loadT > 0, flash: p.flashT > 0, dash: !!p.dash },
      cyl: p.cyl ? p.cyl.join('') : undefined, sc: p.sc ? { glow: p.sc.glow, next: p.sc.next, charged: p.sc.charged } : undefined,
      hint: p.hintT > 0 ? p.hint : '',
  };
}

export function snapshot() {
  const b = G.boss, ps = G.players.map(playerSnap);
  return {
    tick: G.tick, t: r3(G.ft), state: G.state, cine: G.cineLock, nm: G.nightmare,
    boss: b ? { id: b.def.id, name: b.def.name, title: b.def.title || '', phase: b.phase, enraged: b.enraged, focus: b.focusId, pub: b.pub } : null,
    arena: G.arena ? { radius: G.arena.radius || 20, edge: G.arena.edge, spawn: G.arena.spawn } : null,
    player: ps[0] || null, // the first player (the debug viewer's)
    players: ps,
    ents: G.ents.map((e) => ({ id: e.id, name: e.name, boss: e.isBoss, x: r3(e.pos.x), y: r3(e.pos.y), z: r3(e.pos.z), facing: r3(e.facing), hp: Math.round(e.hp), maxHp: e.maxHp, radius: e.radius, alive: e.alive, immune: e.immune, color: e.def && e.def.color,
      cast: e.castState ? { name: e.castState.name, t: r3(e.castState.t), time: e.castState.time } : null })),
    hazards: Hz.list.filter((h) => h.state !== 'done').map((h) => ({ id: h.id, name: h.name, shape: h.shape, state: h.state, t: r3(h.t), delay: h.delay, dur: h.dur, zt: h.zt, color: h.color, style: h.style, dmg: h.dmg })),
    bullets: Bul.list.map((q) => ({ id: q.id, x: r3(q.x), z: r3(q.z), y: q.y, r: q.r, color: q.color })),
  };
}
