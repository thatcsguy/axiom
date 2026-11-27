// The autopilot, carried over from Threshold's 90_bot.js. It plays one player through the same input frame a client
// sends (see fight.js applyInput): a world-space move vector, skill presses, a target pick, a queue cancel. Each thing it
// decides is applied at once and also written into `frame`, so a recorded bot fight replays exactly from its frames
// without the bot (tools/replay.js, test/determinism.test.js). The bot itself never touches G.rng.
import { G } from './core.js';
import { TAU, lerp } from './math.js';
import { Hz, Bul } from './combat.js';
import { MELEE } from './classes.js';
import { Player } from './player.js';

export function emptyFrame() { return { mx: 0, mz: 0, held: 0, press: [] }; }

// Each player has its own autopilot memory (p.botS: timer, goal, pressT) and level (p.botLevel; 0 = off). Bot.level is the
// solo default that startFight hands to players who do not name their own.
export const Bot = {
  level: 0, passive: false, swapBlind: false, pocketBlind: false, lazy: false, sideBlind: false, // test switches that boss hints read
  reset() { for (const p of G.players) p.botS = { timer: 0, goal: null, pressT: 0 }; },
  // dt: the scaled step length. frame: the input frame being built for this tick (mutated). p: the player it plays.
  update(dt, frame, p = G.players[0]) {
    const b = G.boss, me = p && (p.botS || (p.botS = { timer: 0, goal: null, pressT: 0 })), level = p ? p.botLevel : 0;
    if (!level || !p || !b || G.state !== 'fight' || !p.alive) { frame.mx = 0; frame.mz = 0; p && (p.input.mx = p.input.mz = 0); return; }
    const A = G.arena, def = b.def, melee = !!p.cls.melee, t = p.target || b;
    const hint = def.bot ? def.bot(b, p) || {} : {};
    if (hint.jump) { p.jump(); frame.jump = 1; } // a boss hint asks for a hop (Threshold's hints called p.jump() themselves)
    if (hint.stopCast) { p.stopCast(); frame.stopCast = 1; } // ... or to stop a planted cast (Threshold's hints cleared p.casting themselves)
    const danger = (x, z) => { let th = Hz.threat(x, z); if (def.danger) th = Math.min(th, def.danger(b, x, z)); return th; };
    me.timer -= dt;
    const period = [0, 0.4, 0.18, 0.05][level];
    if (me.timer <= 0 || !me.goal) {
      me.timer = period;
      // anchor: where we would like to stand if nothing were dangerous
      let ax = p.pos.x, az = p.pos.z; const dT = Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z) || 1;
      if (hint.x !== undefined) { ax = hint.x; az = hint.z; }
      else if (melee) { const r = t.radius + 2.0; ax = t.pos.x + (p.pos.x - t.pos.x) / dT * r; az = t.pos.z + (p.pos.z - t.pos.z) / dT * r; }
      else if (dT - t.radius > 28) { const r = t.radius + 22; ax = t.pos.x + (p.pos.x - t.pos.x) / dT * r; az = t.pos.z + (p.pos.z - t.pos.z) / dT * r; }
      const C = [[p.pos.x, p.pos.z, melee ? -0.3 : -1.2], [ax, az, 0]];
      for (const r of [1.5, 3, 5, 8, 12]) for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + r; C.push([p.pos.x + Math.sin(a) * r, p.pos.z + Math.cos(a) * r, 0]); }
      for (const r of [2, 4.5]) for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; C.push([ax + Math.sin(a) * r, az + Math.cos(a) * r, 0]); }
      let best = null, bs = 1e9;
      for (const c of C) {
        const x = c[0], z = c[1]; if (!A.contains(x, z)) continue;
        if (Math.hypot(x - b.pos.x, z - b.pos.z) < b.radius + 0.3) continue;
        if (A.edge === 'fall') { const d = Math.hypot(x - p.pos.x, z - p.pos.z) || 1; if (!A.contains(x + (x - p.pos.x) / d * 1.2, z + (z - p.pos.z) / d * 1.2)) continue; let ok = true; for (let k = 1; k < 5 && ok; k++) ok = A.contains(lerp(p.pos.x, x, k / 5), lerp(p.pos.z, z, k / 5)); if (!ok) continue; }
        const tt = Math.hypot(x - p.pos.x, z - p.pos.z) / (p.speed * p.speedMul), th = danger(x, z);
        let s = c[2] + Math.hypot(x - ax, z - az) * (hint.w || 1) + tt * 3;
        if (th !== Infinity) { if (th > tt - 0.12) s += th < tt + 1.2 ? 400 - th * 20 : th < 1.5 ? 20 / th : 0; }
        const mx = (x + p.pos.x) / 2, mz = (z + p.pos.z) / 2, tm = danger(mx, mz); if (tm !== Infinity && Math.abs(tm - tt / 2) < 0.3) s += 200;
        if (Bul.threat(x, z, 0.7)) s += 80;
        if (Hz.persist(x, z)) s += 450;
        if (hint.avoid) { const av = hint.avoid(x, z); if (av) s += typeof av === 'number' ? av : 500; } // a number: that penalty instead (e.g. a walk over a hole)
        const dt2 = Math.hypot(x - t.pos.x, z - t.pos.z) - t.radius; if (!melee && dt2 > 32) s += 50; if (melee && dt2 > MELEE - 0.3 && hint.x === undefined) s += 25 + dt2;
        if (s < bs) { bs = s; best = c; }
      }
      me.goal = best || [p.pos.x, p.pos.z];
    }
    const gx = me.goal[0] - p.pos.x, gz = me.goal[1] - p.pos.z, gd = Math.hypot(gx, gz);
    let mvx = gd > 0.25 ? gx / gd : 0, mvz = gd > 0.25 ? gz / gd : 0;
    // finish a cast in progress when nothing will land before it completes
    if (p.casting && level >= 2) { const left = p.casting.time - p.casting.t; if (danger(p.pos.x, p.pos.z) > left + 0.3 && !Hz.persist(p.pos.x, p.pos.z) && !Bul.threat(p.pos.x, p.pos.z, left + 0.3)) mvx = mvz = 0; }
    frame.mx = mvx; frame.mz = mvz; p.input.mx = mvx; p.input.mz = mvz;
    // rotation (passive: a test switch that never attacks)
    if (Bot.passive) return;
    me.pressT -= dt; if (me.pressT > 0) return; me.pressT = [0, 0.25, 0.12, 0.05][level];
    const here = danger(p.pos.x, p.pos.z), cs = t.castState;
    const ctx = { hp: p.hp / p.maxHp, danger: here < 0.3 && level >= 2, calm: here, wantInterrupt: !!(cs && cs.int && cs.t > (level >= 3 ? 0.3 : 0.8)), chase: gd < 1.5, holdFire: !!hint.holdFire, saveInterrupt: !!def.botSaveInterrupt || !!hint.saveInterrupt || level < 3,
      zone: !!Hz.persist(p.pos.x, p.pos.z),
      threat: (x, z) => (Hz.persist(x, z) || (hint.avoid && hint.avoid(x, z))) ? 0 : danger(x, z) };
    if (hint.target && p.target !== hint.target) { p.target = hint.target; frame.target = hint.target.id; }
    if (ctx.holdFire) { p.queue = -1; frame.cancelQueue = 1; } // a player told to stop does not let a buffered press go through
    // presses go through the real Player.press and are recorded in order
    const real = (i) => { frame.press.push(i); return Player.prototype.press.call(p, i); };
    // hint.noCast (seconds): a boss says the next hit arrives in that time, so the class does not start a planted cast it cannot finish
    if (hint.noCast !== undefined) p.press = (i) => { const st = p.sk[i]; if (st && p.castTime(st.def) > hint.noCast) return; return real(i); };
    else p.press = real;
    try { p.cls.bot(p, ctx); } finally { delete p.press; }
  },
};
