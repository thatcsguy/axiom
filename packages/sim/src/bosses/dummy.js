// THE TRAINING DUMMY: not a fight. A post in a quiet ring where new players try the classes. It never attacks, never dies
// (its health refills when it runs out) and keeps a damage meter for each player: damage since the first hit of the current
// burst, and damage per second over that burst. A burst ends after DUMMY.IDLE seconds without hitting it.
//
// Players may walk in and out (fight.js addPlayer / removePlayer) and change class where they stand (swapClass); the server
// allows all three only here (def.training). It takes up to eight players and its health does not scale with the party.
import { G } from '../core.js';

export const DUMMY = { HP: 1000000, IDLE: 6 };

(() => {
  G.bosses.push({
    id: 'dummy', name: 'TRAINING DUMMY', title: 'It does not mind', hint: 'Try the classes', color: '#c8a878', telegraph: 0xff5a2a,
    hp: DUMMY.HP, radius: 1.1, aimY: 1.8, training: true, noScale: true, maxPlayers: 8,
    build(b) {
      Object.assign(b.state, { meter: {} });
      b.onDamaged = (amt, info, e, by) => {
        if (b.hp < DUMMY.HP * 0.5) b.hp = DUMMY.HP; // it never runs out (refilled before the death check)
        if (!by || info.src !== 'player') return;
        const S = b.state, m = S.meter[by.id];
        if (!m || G.ft - m.last > DUMMY.IDLE) S.meter[by.id] = { first: G.ft, last: G.ft, total: amt, hits: 1, big: amt };
        else { m.last = G.ft; m.total += amt; m.hits++; if (amt > m.big) m.big = amt; }
      };
      return { edge: 'wall', radius: 16, spawn: { x: 0, z: 7 }, bossStart: { x: 0, z: -2, face: 0 }, camDist: 12, camPitch: 0.5 };
    },
    phases: [{ at: 1, *run() { while (true) yield 1; } }],
    update(b) {
      const S = b.state, P = b.pub; P.meter = {};
      for (const p of G.players) {
        const m = S.meter[p.id]; if (!m) continue;
        const live = G.ft - m.last <= DUMMY.IDLE, dur = Math.max(1, m.last - m.first + (live ? G.ft - m.last : 0));
        P.meter[p.id] = { total: m.total, dps: Math.round(m.total / dur), dur: Math.round(dur * 10) / 10, hits: m.hits, big: m.big, live };
      }
    },
    onSwap(b, p) { delete b.state.meter[p.id]; }, // a new class starts a new meter
    // the autopilot just hits it
    bot() { return {}; },
  });
})();
