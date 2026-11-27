// ISSEN, the Last Petal: the rules half. One swordsman on a lake at dusk. Fast, precise, and he remembers every cut.
//
// Carried over from Threshold's 22_boss_duelist.js (as of fun-stuff PR #87): Normal (sunset, deepening, nightfall) and the
// Nightmare (sunset, nightfall, the lake, then Niten: two bodies, one health, "Blade and Storm" with the storm that never sleeps,
// standing cuts and the Waking Cut, the Moons, Twin Final Verse in beats, Twin Petal Storm, the ramp, The Last Petal).
// Stillness and its Counter: any player hit that lands on a still Issen (or the still body in Niten) counters, whoever was
// targeted (PR #87). Kept: every mechanic, every number, the autopilot hint. Removed (view half, for the client): the lake, the
// deck and its props, the costume on the hero rig and its animation, the cut ribbons, the ghost silhouettes, the petal orbs,
// the calm-place streaks, the sunset/nightfall regrades, the reflection rising out of the lake, the kill (nitenDeath), the
// music. What the view needs is in b.pub (update, below) and a handful of cues:
//   duelist.vTele (x, z, dir, len, t, col)   the brush stroke along a line telegraph
//   duelist.vCut  (x, z, dir, len, col)       a cut ribbon (and its ink smoke)
//   duelist.cutFx (x, z, dir, len, col)       a cut landing: ribbon, petals, sound, shake
//   duelist.vArcs (key, x, z, dir, blue)      the Moons' arcs
//   duelist.swing (who, kind, dur)            a sword swing on 'A' (Issen) or 'R' (his reflection)
//   duelist.deepen (dur) / duelist.night (dur) the phase regrades of the sky and lake, played on the client
//   duelist.lastPetal ()                      one petal falling past the camera before The Last Petal
//
// Solo only for now (maxPlayers 1): every Threshold `G.player` is the boss's focus player here (the one player). The Counter
// strikes the player whose hit it was.
import { G, Co, rnd, vrand, NM, livePlayers } from '../core.js';
import { V3, TAU, PI, clamp, lerp, smooth, dampAng, angTo } from '../math.js';
import { Hz, Bul, Ent } from '../combat.js';
import { FX, Sound, Music, Post, Cam, UI, View } from '../view.js';
import { Bot } from '../bot.js';

(() => {
  // the Moons. New Moon hits the disc r < MOON.r round him, Full Moon everything from MOON.r out to the far wall: the two never
  // overlap, so standing near the line a small step answers either one, but no spot in the room is safe from both and the edge
  // never outranges a Full Moon. Full Moon's tell gets MOON.oTell s more (not shortened by haste), and from further out it is
  // long enough to walk in to him (walk time + MOON.oReact s), at most MOON.oMax s: running in costs you casting, never the hit.
  // The next Moon's tell starts only once the last one has landed (MOON.gap s later), on Normal and Nightmare.
  const MOON = { r: 5.5, far: 32, oTell: 0.35, oReact: 0.6, oMax: 2.4, gap: 0.2 };
  const moonTell = (b, base, k, x, z) => { const t = tele(b, base), p = b.focusPlayer(); if (k !== 'o') return t; const d = p ? Math.hypot(p.pos.x - x, p.pos.z - z) : 0, v = p ? p.speed * p.speedMul : 7;
    return Math.min(MOON.oMax, Math.max(t + MOON.oTell, Math.max(0, d - MOON.r + 0.8) / v + MOON.oReact)); };
  const R = 15, ROSE = 0xff4a6a, PALE = 0xffd8e0, BLUE = 0x8ab4ff, BLUE_T = 0x7aa8ff, ICE = 0xd8ecff; // BLUE: the reflection (nightmare only)
  const edgeLen = (x, z, a) => { let d = 0; while (d < 40) { const nx = x + Math.sin(a) * (d + 0.5), nz = z + Math.cos(a) * (d + 0.5); if (nx * nx + nz * nz > 14.2 * 14.2) break; d += 0.5; } return d; };

  // ---------------------------------------------------------------- the view's hooks (cues; nothing here changes the fight)
  const vCut = (b, x, z, dir, len, col) => View.cue('duelist.vCut', x, z, dir, len, col);
  const vTele = (b, x, z, dir, len, t, col = 0xff6a88) => View.cue('duelist.vTele', x, z, dir, len, t, col);
  const vArcs = (b, key, x, z, dir = 0, blue = false) => View.cue('duelist.vArcs', key, x, z, dir, blue);
  const cutFx = (b, x, z, dir, len, col = 0xffffff) => View.cue('duelist.cutFx', x, z, dir, len, col);
  const swing = (act, kind, dur) => View.cue('duelist.swing', act.name, kind, dur);
  function petals(x, z, n = 30, c = PALE) { FX.burst(x, 1.2, z, { n, color: c, color2: c === ICE ? BLUE : ROSE, speed: [1, 7], life: [0.5, 1.3], size: [0.1, 0.28], grav: 2, drag: 1.5 }); }
  // W.tween's timing (Threshold ran the sunset and nightfall regrades as coroutines; their length is part of the fight)
  function* tweenWait(dur) { let t = 0; while (t < dur) { t += G.dt; yield; } }

  // The rules half of Threshold's build(): the per-fight state, the ghost pool (6 on Normal, 10 on Nightmare: a cut with no
  // free ghost leaves none), the two bodies, the Counter hooks. The lake, the deck, the costume and every effect pool are the
  // view half (client).
  function build(b) {
    const S = b.state;
    S.fake = { parryT: 0 }; S.showA = true; S.sheath = false;
    S.ghosts = []; for (let i = 0; i < (G.nightmare ? 10 : 6); i++) S.ghosts.push({ cut: null, mark: null });
    S.lanes = []; S.eye = null; S.stormUntil = 0; S.laneSeq = 0;
    S.haste = 0; S.nitenT = 0; S.nitenStep = 0; S.stepAt = []; S.tellT = 1.2; S.still = false; S.warn = 0; S.graceT = 0; S.walk = false; S.kneel = 0; S.open = 0;
    S.deep = 0; S.nightK = 0; S.lake = false; S.lakeK = 0; S.seamP = 0;
    S.A = { name: 'A', ent: b, fake: S.fake, col: ROSE, ice: PALE, still: false, warn: 0, open: 0, graceT: 0, hold: false,
      get kneel() { return S.kneel; }, set kneel(v) { S.kneel = v; }, get shown() { return S.showA; }, set shown(v) { S.showA = v; } };
    if (G.nightmare) {
      // his reflection: same costume in moon-blue (client); for the fight a body that shares Issen's health and joins in phase IV
      const Rr = S.R = { name: 'R', fake: { parryT: 0 }, col: BLUE, ice: ICE, kneel: 0, still: false, warn: 0, open: 0, graceT: 0, hold: false, img: 0, shown: false, sheath: false, live: false,
        root: { x: 0, y: 0, z: -16, ry: 0, flip: 1, under: false, rot: 0, fade: 0 } };
      const e = Rr.ent = new Ent({ name: 'ISSEN, REFLECTED', hp: 1, radius: 0.9, aimY: 1.6 }); e.isAdd = true; e.def = { name: e.name, color: BLUE }; e.hpOwner = b; e.immune = true; e.targetable = false; e.onDeath = () => {}; e.pos.set(0, 0, -16);
      // a hit on the still body: no damage, a ripple instead of IMMUNE, and the Counter. Every player hit that lands on the still
      // one counters, whoever is selected when it lands (Patrick 2026-11-26: tabbing away at the bell must not save a cast already
      // aimed at him). One Counter at a time: hits inside COUNTER_CD of the last one are swallowed, a later hit counters again.
      const still = (act) => (info, ent) => { if (!S.niten || !act.still) return false; if (!G.headless) { FX.ring(ent.pos.x, ent.pos.z, { r0: 0.6, r1: 2.4, color: ICE, dur: 0.45, width: 0.12, mult: 1.2 }); }
        if (info.src === 'player' && G.now >= act.graceT && counterFree(S)) { S.countered = true; S.counterAt = G.now; S.cycleClean = false; Co.start(counterN(b, act, G.actor || b.focusPlayer()), 'phase'); } return true; };
      b.onImmuneHit = still(S.A); e.onImmuneHit = still(Rr);
    }
    b.onDamaged = (amt, info, ent, by) => { if (S.still && counterFree(S) && G.now >= S.graceT && info.src === 'player') { S.countered = true; S.counterAt = G.now; Co.start(counter(b, by || b.focusPlayer()), 'phase'); } };
    return { edge: 'wall', radius: R, spawn: { x: 0, z: 10 }, bossStart: { x: 0, z: -5, face: 0 }, contains: (x, z) => x * x + z * z <= R * R };
  }

  const tele = (b, t) => t * Math.pow(0.86, b.state.haste);
  function addGhost(b, cut) {
    const S = b.state, gh = S.ghosts.find((q) => !q.cut); if (!gh) return; gh.cut = cut;
    gh.mark = Hz.mark({ type: 'rect', x: cut.x, z: cut.z, dir: cut.dir, len: cut.len, w: 0.35 }, 60, { color: cut.blue ? BLUE : ROSE, alpha: 0.45 });
  }
  // phase III: the lake remembers the cut too. A pale blue ghost at the mirror image across the seam (x -> -x, angle -> -angle)
  function mirrorGhost(b, cut) { const mc = { x: -cut.x, z: cut.z, dir: -cut.dir, len: cut.len, blue: true, pair: cut }; cut.pair = mc; addGhost(b, mc); if (!G.headless) petals(mc.x, mc.z, 12, ICE); return mc; }
  function* drawCut(b, n) {
    const S = b.state; S.walk = false;
    for (let i = 0; i < n; i++) {
      const a = b.angToPlayer(); b.facing = a; const len = Math.max(6, edgeLen(b.pos.x, b.pos.z, a)), cut = { x: b.pos.x, z: b.pos.z, dir: a, len };
      S.fake.parryT = 1; const t = tele(b, i === 0 ? 0.95 : 0.72);
      Hz.rect(cut.x, cut.z, a, len, 2.3, t, 310, { name: 'Draw Cut', color: ROSE, quiet: true, silent: i > 0 }); vTele(b, cut.x, cut.z, a, len, t);
      yield t; S.fake.parryT = 0; swing(S.A, 1, 0.25); cutFx(b, cut.x, cut.z, a, len); addGhost(b, cut); if (S.lake && i < 2) mirrorGhost(b, cut);
      b.pos.x += Math.sin(a) * len; b.pos.z += Math.cos(a) * len; petals(b.pos.x, b.pos.z, 14); yield 0.3;
    }
    b.facing = b.angToPlayer(); yield 0.5;
  }
  // mode 0: one at a time. 1: in pairs. 2: all at once.
  function* echo(b, mode, caster = b) {
    const S = b.state, list = S.ghosts.filter((q) => q.cut && !q.cut.blue), blues = S.ghosts.filter((q) => q.cut && q.cut.blue); if (!list.length && !blues.length) return;
    yield* caster.cast({ name: 'Echo', time: 0.9 });
    const t = tele(b, mode === 2 ? 1.3 : 0.8), late = blues.length ? 0.45 : 0;
    const fire = (gh, tt, silent) => { const c = gh.cut; Hz.cancel(gh.mark); laneLeave(S, c, tt);
      if (c.blue) vTele(b, c.x, c.z, c.dir, c.len, tt, BLUE_T); else vTele(b, c.x, c.z, c.dir, c.len, tt);
      Hz.rect(c.x, c.z, c.dir, c.len, 2.3, tt, 270, { name: 'Echo', color: c.blue ? BLUE : ROSE, quiet: true, silent, onFire: () => { cutFx(b, c.x, c.z, c.dir, c.len, c.blue ? BLUE : PALE); gh.cut = null; } }); };
    for (let i = 0; i < list.length; i++) {
      const gh = list[i]; fire(gh, t, i > 0);
      const pr = gh.cut.pair && blues.find((q) => q.cut === gh.cut.pair); if (pr) { blues.splice(blues.indexOf(pr), 1); fire(pr, t + 0.45, true); }
      if (mode === 0 || (mode === 1 && i % 2 === 1)) yield tele(b, 0.55);
    }
    for (const gh of blues) fire(gh, t + 0.45, true);
    yield t + 0.5 + late;
  }
  function clearGhosts(S) { for (const gh of S.ghosts) { if (gh.mark) Hz.cancel(gh.mark); gh.cut = null; } }
  function* moon(b, kinds) {
    const S = b.state; S.walk = false;
    for (const k of kinds) {
      const x = b.pos.x, z = b.pos.z, t = moonTell(b, 0.95, k, x, z), a = b.angToPlayer(); b.facing = a; S.fake.parryT = 1;
      const fx = () => { swing(S.A, k === 'c' ? 1 : 0, 0.3); Sound.sfx('sword'); Sound.sfx('boom', 0.5); FX.shake(0.3); };
      if (k === 'c') Hz.cone(x, z, a, 3.5, 9.5, t, 320, { name: 'Crescent', color: ROSE, quiet: true, onFire: () => { fx(); vArcs(b, 'c', x, z, a); petals(x + Math.sin(a) * 4, z + Math.cos(a) * 4, 20); } });
      else if (k === 'o') (S.fullMoon = { x, z, at: G.now + t }, Hz.donut(x, z, MOON.r, MOON.far, t, 320, { name: 'Full Moon', color: ROSE, quiet: true, onFire: () => { fx(); vArcs(b, 'o', x, z, vrand() * TAU); petals(x, z, 40); } }));
      else Hz.circle(x, z, MOON.r, t, 320, { name: 'New Moon', color: ROSE, quiet: true, onFire: () => { fx(); FX.dome(x, 0.5, z, { r: MOON.r, color: ROSE, dur: 0.4, mult: 1.1 }); vArcs(b, 'n', x, z, vrand() * TAU); } });
      yield t + MOON.gap;
    }
    yield 0.3; S.fake.parryT = 0; yield 0.4;
  }
  // tell before Stillness: 1.2 s of blade glint, a closing pale ring and a rising chime, then a short grace when he kneels,
  // with no grace (STILL_GRACE 0, Patrick 2026-11-25): any hit that lands once he kneels counters, also a cast started before or
  // during the tell that finishes after it. The tell is the cue to stop casting.
  const STILL_TELL = 1.2, STILL_GRACE = 0;
  // a Counter is 0.22 s of windup and its strike; another hit after COUNTER_CD counters again (a multi-hit burst never chains)
  const COUNTER_CD = 0.8, counterFree = (S) => G.now >= (S.counterAt || -1e9) + COUNTER_CD;
  function* stillness(b, dur = 2.3) {
    const S = b.state; S.walk = false; b.facing = b.angToPlayer(); S.warn = 0.001; S.kneelAt = G.now + STILL_TELL;
    Sound.sfx('glint', 0.9); FX.flash(0xfff4e0, 0.16, 2.2);
    if (!G.headless) { FX.ring(b.pos.x, b.pos.z, { r0: 7.5, r1: 1.3, color: 0xfff4e0, dur: STILL_TELL, width: 0.24, mult: 1.7 }); FX.light(b.pos.x, 3, b.pos.z, 0xfff0d0, 45, STILL_TELL, 18); }
    yield STILL_TELL;
    S.warn = 0; S.still = true; S.graceT = G.now + STILL_GRACE; S.countered = false; S.kneel = 1; Sound.sfx('bell', 0.45, 3); b.facing = b.angToPlayer();
    yield* b.cast({ name: 'Stillness', time: dur });
    S.still = false; S.kneel = 0;
    if (!S.countered) { S.open = 3.2; b.dmgTaken = 1.6; petals(b.pos.x, b.pos.z, 24); yield 3.2; b.dmgTaken = 1; } else yield 1.0;
  }
  // p: the player whose hit set it off (Threshold's G.player)
  function* counter(b, p) {
    const S = b.state; FX.flash(0xffffff, 0.3, 4); Sound.sfx('parry', 0.8, 0.7); petals(b.pos.x, b.pos.z, 30);
    const a = p.facing + PI, ox = b.pos.x, oz = b.pos.z; let tx = p.pos.x + Math.sin(a) * 2.2, tz = p.pos.z + Math.cos(a) * 2.2; const d = Math.hypot(tx, tz); if (d > 14) { tx *= 14 / d; tz *= 14 / d; }
    yield 0.22; b.pos.x = tx; b.pos.z = tz; b.facing = b.angToPlayer(); swing(S.A, 1, 0.2);
    const cl = Math.hypot(tx - ox, tz - oz); if (cl > 0.5) vCut(b, ox, oz, Math.atan2(tx - ox, tz - oz), cl, 0xffffff); Sound.sfx('crit'); FX.slash(p.pos.x, 1.2, p.pos.z, b.facing, { r: 3.5, color: 0xffffff, dur: 0.3, mult: 1.6 });
    p.hurt(NM(520, 380), { blockable: true, src: { name: 'Counter' } });
  }
  // Haste is tied to the phase (no Focus cast to stop): Normal phases 1-3 give 0, 1, 2 stacks; Nightmare gives 1, 1, 2, 2, and
  // the third stack comes with Niten's last ramp step. Each stack shortens his telegraphs by 14% (see tele). Focus is where a new stack shows.
  const hasteFor = (b) => G.nightmare ? [1, 1, 2, 2][Math.max(0, Math.min(3, b.phase))] + (b.state.nitenStep >= 5 ? 1 : 0) : Math.min(3, Math.max(0, b.phase));
  function* focus(b) {
    const S = b.state, h = hasteFor(b);
    if (h > S.haste) { S.haste = h; FX.dome(b.pos.x, 1, b.pos.z, { r: 6, color: ROSE, dur: 0.6 }); Sound.sfx('roar', 0.6, 2.2); FX.flash(ROSE, 0.25, 3); petals(b.pos.x, b.pos.z, 30); }
    yield 0.3;
  }
  function* petalStorm(b, dur = 6.5, arms = 4) {
    const S = b.state; S.walk = false; petals(b.pos.x, b.pos.z, 20); b.pos.set(0, 0, 0); petals(0, 0, 40);
    yield* b.cast({ name: 'Petal Storm', time: 1.2 });
    let t = 0, a0 = rnd(TAU); const dirSign = rnd() < 0.5 ? 1 : -1;
    while (t < dur) { for (let k = 0; k < arms; k++) { const a = a0 + k / arms * TAU; Bul.fire({ x: Math.sin(a) * 1.2, z: Math.cos(a) * 1.2, dir: a, speed: 6.2, dmg: 85, color: 0xd8467a, r: 0.36, life: 3.6, petal: 1 }); Bul.fire({ x: Math.sin(a + 0.16) * 1.2, z: Math.cos(a + 0.16) * 1.2, dir: a + 0.16, speed: 6.2, dmg: 85, color: 0xd8467a, r: 0.36, life: 3.6, petal: 1 }); } a0 += dirSign * 0.105; b.facing += dirSign * 0.9; if (Math.floor(t / 0.36) !== Math.floor((t - 0.12) / 0.36)) swing(S.A, 1, 0.3); t += 0.12; yield 0.12; }
    b.facing = b.angToPlayer(); yield 0.7;
  }
  function* finalVerse(b, n = 9, mirror = false) {
    const S = b.state; S.walk = false; yield* b.cast({ name: 'Final Verse', time: 1.1 });
    petals(b.pos.x, b.pos.z, 40); b.targetable = false; S.showA = false; S.verse = true; Co.start(Post.lerpTo({ sat: 0.75, vig: 1.05 }, 0.4), 'fight');
    for (let i = 0; i < n; i++) {
      const qa = rnd(TAU), qr = i % 3 === 0 ? 0 : rnd(2, 10), p = b.focusPlayer(), qx = i % 3 === 0 ? p.pos.x : Math.sin(qa) * qr, qz = i % 3 === 0 ? p.pos.z : Math.cos(qa) * qr, dir = rnd(TAU), ox = qx - Math.sin(dir) * 20, oz = qz - Math.cos(dir) * 20;
      vTele(b, ox, oz, dir, 40, tele(b, 1.2)); Hz.rect(ox, oz, dir, 40, 2.1, tele(b, 1.2), 300, { name: 'Final Verse', color: ROSE, quiet: true, silent: true, onFire: () => cutFx(b, ox, oz, dir, 40, i % 2 ? PALE : 0xffffff) }); Sound.sfx('tick', 1, 1 + i * 0.08);
      if (mirror && i % 3 === 2) verseLine(b, -ox, oz, -dir, tele(b, 1.2) + 0.45, true);
      yield tele(b, 0.27);
    }
    yield tele(b, 1.2) + (mirror ? 0.45 : 0); S.verse = false; Co.start(Post.lerpTo({ sat: 1.08, vig: 0.9 }, 0.5), 'fight');
    const p = b.focusPlayer(), a = rnd(TAU); let tx = p.pos.x + Math.sin(a) * 4, tz = p.pos.z + Math.cos(a) * 4; const d = Math.hypot(tx, tz); if (d > 13) { tx *= 13 / d; tz *= 13 / d; }
    b.pos.set(tx, 0, tz); S.showA = true; b.targetable = true; petals(tx, tz, 40); b.facing = b.angToPlayer(); yield 0.4;
  }
  function verseLine(b, ox, oz, dir, t, blue) {
    vTele(b, ox, oz, dir, 40, t, blue ? BLUE_T : 0xff6a88); Hz.rect(ox, oz, dir, 40, 2.1, t, 300, { name: 'Final Verse', color: blue ? BLUE : ROSE, quiet: true, silent: true, onFire: () => cutFx(b, ox, oz, dir, 40, blue ? BLUE : 0xffffff) });
  }
  // phase 2 mood: the sun sinks lower and redder, more petals (the client plays the regrade from the cue; S.deep is for a newcomer)
  function* deepen(b) { b.state.deep = 1; View.cue('duelist.deepen', 3); yield* tweenWait(3); }
  // phase 3: night-dusk blue with a blood moon
  function* nightfall(b) { b.state.nightK = 1; View.cue('duelist.night', 4.5); yield* tweenWait(4.5); }

  // ---------------------------------------------------------------- phase bodies shared by Normal and Nightmare
  function* sunsetRun(b) {
    const S = b.state;
    while (true) {
      yield* focus(b); yield* drawCut(b, 4); yield* echo(b, 1); S.walk = true; yield 1.0;
      yield* petalStorm(b); yield* moon(b, ['c', 'n', 'o']); S.walk = true; yield 0.8;
      yield* stillness(b); yield* drawCut(b, 4); yield* moon(b, ['o', 'c']); yield* echo(b, 1); S.walk = true; yield 1.0;
    }
  }
  const NIGHT_POST = { bloom: 0.5, threshold: 1.0, tint: [0.96, 0.98, 1.06], exposure: 1.1, sat: 1.05, vig: 0.78, lift: [0.012, 0.012, 0.024] };
  function* nightEnter(b) { const S = b.state; clearGhosts(S); S.walk = false; b.pos.set(0, 0, 0); b.facing = 0; S.kneel = 1; Sound.sfx('bell', 0.9, 0.6); Co.start(Post.lerpTo(Object.assign({}, NIGHT_POST), 4), 'fight'); yield* nightfall(b); S.kneel = 0; Sound.sfx('sword'); petals(0, 0, 80, 0xff3050); yield 0.6; }
  function* nightRun(b) {
    const S = b.state;
    while (true) {
      yield* finalVerse(b, 9); yield* moon(b, ['c', 'o']); yield* drawCut(b, 5); yield* echo(b, 2); S.walk = true; yield 0.8;
      yield* focus(b); yield* stillness(b, 3.0); yield* petalStorm(b, 6, 5); yield* moon(b, ['n', 'o', 'c', 'n']); S.walk = true; yield 0.6;
    }
  }
  // ================================================================ NIGHTMARE ("Niten")
  // Co.stopTag('phase') skips a coroutine's cleanup, so every per-mechanic state a cut-off mechanic can leave behind (kneel,
  // stillness ring, hidden or untargetable body, verse grade, sheathed blade, slow time, a held mirror, a cinematic camera) is
  // reset here: in every nightmare phase's enter and in the last blow. Who is awake and who is still is not per-mechanic: it stays.
  const other = (S, act) => act === S.A ? S.R : S.A;
  function resetMech(b) {
    const S = b.state; S.walk = false; S.warn = 0; S.still = false; S.kneel = 0; S.open = 0; S.countered = false; b.dmgTaken = 1; S.fake.parryT = 0; S.tellT = STILL_TELL;
    S.showA = true; b.targetable = true; S.sheath = false; G.timeScale = 1;
    S.lanes = []; S.eye = null; S.calmHint = null; S.storm = null; S.stormHold = false; S.unison = false; S.echoing = false; S.moonK = null; S.stormUntil = 0; S.waking = null; S.cycleCuts = 0; S.cycleMirror = false;
    if (S.verse) { S.verse = false; Co.start(Post.lerpTo({ sat: 1.08, vig: 0.9 }, 0.4), 'fight'); }
    if (S.cine) { S.cine = false; Cam.release(); UI.hud(true); }
    const Rr = S.R; if (!Rr) return;
    for (const act of [S.A, Rr]) { act.warn = 0; act.hold = false; act.open = 0; act.ent.dmgTaken = 1; act.fake.parryT = 0; }
    Rr.kneel = 0; Rr.sheath = false; Rr.shown = !!S.niten; Rr.ent.targetable = !!S.niten; Rr.root.rot = 0; Rr.ent.castState = null;
  }
  // Out of time (the last blow, 24 s into the enrage, in whatever phase): the music stops dead, he sheathes the sword (in phase IV both do), one petal falls past
  // the camera in silence, the whole deck fills, and a single white cut crosses it (two crossing cuts in phase IV).
  // He can still be cut down while it winds up.
  function* lastPetal(b) {
    const S = b.state, twin = !!S.niten; resetMech(b); clearGhosts(S); b.facing = b.angToPlayer();
    Music.stop(0.08); G.timeScale = 0.6; swing(S.A, 0, 0.6); if (twin) swing(S.R, 0, 0.6); Sound.sfx('sword', 0.5, 0.45);
    yield 0.55; S.sheath = true; if (twin) S.R.sheath = true; Sound.sfx('parry', 0.5, 0.5); S.kneel = 0.25; if (twin) S.R.kneel = 0.25;
    View.cue('duelist.lastPetal');
    yield 0.75; G.timeScale = 1;
    const T = 5.5;
    Hz.circle(0, 0, R + 0.5, T, 0, { blockable: false, name: 'The Last Petal', color: PALE, quiet: true, onFire: () => {
      const p = b.focusPlayer(), a = p ? Math.atan2(p.pos.x, p.pos.z) + PI / 2 : 0;
      FX.flash(0xffffff, 0.7, 2.2); cutFx(b, -Math.sin(a) * R, -Math.cos(a) * R, a, R * 2, 0xffffff); if (twin) { const a2 = a + PI / 2; cutFx(b, -Math.sin(a2) * R, -Math.cos(a2) * R, a2, R * 2, BLUE); } FX.shake(0.6); Sound.sfx('crit');
      for (const q of livePlayers()) q.hurt(9999, { blockable: false, src: 'enrage', pierce: true });
    } });
    yield T + 0.4; S.kneel = 0; if (twin) S.R.kneel = 0;
    while (true) yield 1;
  }

  // ---------------------------------------------------------------- phase III, "the lake remembers": teaches the mirror before the second body exists
  function* lakeEnter(b) {
    const S = b.state; resetMech(b); clearGhosts(S); S.walk = false;
    petals(b.pos.x, b.pos.z, 30); b.pos.set(0, 0, -R + 1.3); b.facing = 0; petals(b.pos.x, b.pos.z, 30); Sound.sfx('sword', 0.8, 0.6); swing(S.A, 2, 0.4); S.kneel = 0.3;
    yield 0.5;
    // the blade tip drawn along the deck, north to south through the centre: the seam stays, and the lake goes glass-flat
    const z0 = b.pos.z, z1 = R - 1.3, T = 2.4; let t = 0; S.walk = false;
    while (t < T) { t += G.dt; const k = smooth(Math.min(1, t / T)); b.pos.z = lerp(z0, z1, k); b.facing = 0; S.seamP = Math.min(1, (b.pos.z + R) / (2 * R) + 0.02); S.lakeK = k;
      if (!G.headless && vrand() < 0.6) FX.burst(b.pos.x + 0.25, 0.05, b.pos.z + 1.4, { n: 1, color: ICE, color2: PALE, speed: [0.5, 2], up: 1.2, life: [0.3, 0.6], size: [0.06, 0.12] }); yield; }
    S.seamP = 1; S.lakeK = 1; S.lake = true; S.kneel = 0;
    petals(b.pos.x, b.pos.z, 40, ICE); Sound.sfx('bell', 0.6, 0.9); yield 0.6;
    b.facing = b.angToPlayer(); yield 0.3;
  }
  function lakeSkip(b) { const S = b.state; S.seamP = 1; S.lakeK = 1; S.lake = true; }
  function nightSkip(b) { b.state.nightK = 1; View.cue('post.set', Object.assign({}, NIGHT_POST)); }
  // the mirrored cut and the blue echo come first, so the mirror is seen at least twice before the reflection exists
  function* lakeRun(b) {
    const S = b.state; yield 0.4;
    while (true) {
      yield* focus(b); yield* drawCut(b, 5); yield* echo(b, 1); S.walk = true; yield 0.8;
      yield* finalVerse(b, 7, true); yield* moon(b, ['n', 'o']); S.walk = true; yield 0.6;
      yield* stillness(b, 3.0); S.walk = true; yield 0.8;
    }
  }
  // Nightmare's teaching phases are about 30 s each with one idea each, so the idea comes early in a short loop.
  // Sunset: Stillness and its Counter (what Niten is built on) inside the first 10 s.
  function* sunsetNM(b) {
    const S = b.state; yield 0.8;
    while (true) {
      yield* focus(b); yield* drawCut(b, 4); S.walk = true; yield 0.5;
      yield* stillness(b); yield* echo(b, 1); S.walk = true; yield 0.8;
      yield* moon(b, ['c', 'n', 'o']); yield* petalStorm(b); S.walk = true; yield 1.0;
    }
  }
  // Nightfall: Final Verse first
  function* nightNM(b) {
    const S = b.state;
    while (true) {
      yield* focus(b); yield* finalVerse(b, 9); yield* moon(b, ['c', 'o']); S.walk = true; yield 0.6;
      yield* stillness(b, 3.0); yield* drawCut(b, 5); yield* echo(b, 2); S.walk = true; yield 0.8;
    }
  }

  // ---------------------------------------------------------------- phase IV, Niten: two bodies, one health, exactly one can be hurt
  // "Blade and Storm", made relentless (issen-intensity-ideas.md, options A + B). The awake one is the blade: Draw Cuts and Moons,
  // move to move with no walking. The still one is the storm: he kneels where he gave the swap tell (blinking in to KNEEL_R from the
  // centre if he was further out) and channels the Lighthouse Storm for as long as he is still. The swap (Stillness) flips the roles.
  // Every Draw Cut's ghost stays on the deck; the swap's Waking Cut sets them all off, and surviving it earns the opening. Each body
  // owns its position; the blade never ends a walk or a dash within KEEP of the still one. Calm places: a fresh Draw Cut leaves a
  // petal-free lane for CALM.laneLife s, a Full Moon's safe hole is petal-free (the Eye of the Moon), and in Twin Petal Storm every
  // standing ghost line is petal-free.
  // Levers (Threshold's comments in 22_boss_duelist.js have the tuning history): the storm, then the calm places, then the cuts.
  const STORM = { arms: [1, 1, 2, 2, 3, 3], turn: [0.7, 0.8, 0.9, 0.9, 1.0, 1.1], flipFrom: 3, width: 3, spread: 0.12, row: 0.4, speed: 5.0, dmg: 85, life: 3.6, tell: 1.2, swapTell: 0.5 };
  const CALM = { laneLife: 4.0, laneW: 2.6, eyeR: 5.0, eyeAfter: 1.5 };
  // "Standing cuts and the Waking Cut" (option B): every Draw Cut's ghost stays on the deck; the swap's Waking Cut sets them all off.
  //   cuts: Draw Cuts per swap cycle by step, laid in chains of at most `chain` with `breath` s between chains (a Bolt fits).
  //   tell: the Waking Cut's tell, started with the swap tell. From step `twoWaves` every other cut is claimed by the still one (his
  //   colour) and fires `wave2` s later. From step `mirror` the lake adds one mirrored ghost per cycle (the still one's colour, wave 2).
  //   openBreath: the blade's first chain waits this long after a swap (the opening is the waker's own burn).
  //   laneAfter: a fired Waking Cut line stays petal-free this long (the opening's calm place: the cut cleans the air).
  //   dmg: a Waking Cut hit (once per swap); a hit also costs the opening unless missOpen. unisonCuts: share of cuts in a set-piece bracket.
  const WAKE = { cuts: [2, 3, 4, 4, 5, 6], chain: 3, breath: 1.8, openBreath: 2.6, tell: 1.3, wave2: 0.6, twoWaves: 2, mirror: 4, dmg: 300, missOpen: false, unisonCuts: 0.5, laneAfter: 3.2 };
  // The two set-piece changes, separate levers: standing ghost lines stay petal-free through Twin Petal Storm (stormGhostCalm), and
  // Final Verse comes in beats (verseBeats lines each, verseRest s still moment between, the blade shows and can be hit; null = one run).
  const SET = { stormGhostCalm: true, verseBeats: [3, 2, 2], verseRest: 1.6 };
  const KEEP = 3, KNEEL_R = 9, STILL_KNEEL = 0.6;
  const stillOf = (S) => other(S, S.lead);
  function wake(b, act, first) {
    const S = b.state, o = other(S, act); S.lead = act;
    act.still = false; act.ent.immune = false; o.still = true; o.ent.immune = true; act.kneel = 0;
    if (!first && !G.headless) { const e = act.ent; FX.ring(e.pos.x, e.pos.z, { r0: 0.8, r1: 5.5, color: act.col, dur: 0.6, width: 0.3, mult: 1.6 }); FX.light(e.pos.x, 2.5, e.pos.z, act.col, 40, 0.6, 14); petals(e.pos.x, e.pos.z, 26, act.ice); }
    if (!first) Sound.sfx('bell', 0.55, act === S.A ? 0.5 : 0.62);
  }
  // The swap. The storm keeps blowing through it (option A). The Waking Cut starts with the tell: every standing ghost telegraphs
  // at once (WAKE.tell; the still one's wave WAKE.wave2 later) and fires as he wakes. Survive it and the one who wakes is open
  // (3.2 s at 1.6x) from the moment the last wave lands; a hit costs WAKE.dmg and the opening. Then the board is clean.
  function* swap(b) {
    const S = b.state, A = S.lead, B = other(S, A), e = A.ent, p = b.focusPlayer(); S.walk = false;
    e.facing = angTo(e.pos.x, e.pos.z, p.pos.x, p.pos.z); A.warn = 0.001;
    Sound.sfx('glint', 0.9); FX.flash(0xfff4e0, 0.16, 2.2);
    const T = S.tellT || STILL_TELL; // 1.2 s, 0.9 s at Niten's last ramp step
    A.kneelAt = G.now + T;
    if (!G.headless) { FX.ring(e.pos.x, e.pos.z, { r0: 7.5, r1: 1.3, color: 0xfff4e0, dur: T, width: 0.24, mult: 1.7 }); FX.light(e.pos.x, 3, e.pos.z, 0xfff0d0, 45, T, 18); }
    const wk = S.waking = wakingCut(b, B);
    yield T;
    A.warn = 0; A.graceT = G.now + STILL_GRACE; A.kneel = 1;
    // he kneels where he gave the tell; from further out than KNEEL_R he petal-blinks in on the same bearing, so the storm has room
    { const d = Math.hypot(e.pos.x, e.pos.z); if (d > KNEEL_R) { petals(e.pos.x, e.pos.z, 18, A.ice); e.pos.x *= KNEEL_R / d; e.pos.z *= KNEEL_R / d; petals(e.pos.x, e.pos.z, 24, A.ice); } }
    wake(b, B); S.countered = false; const tk = G.now;
    while (G.now < wk.end) yield;
    // the opening is earned by the Waking Cut, not by the cycle (a Counter is its own punishment: 380, no lost opening)
    S.wakeLog = S.wakeLog || []; S.wakeLog.push({ n: wk.n, hit: wk.hit, t: G.ft });
    if (!wk.hit || WAKE.missOpen) { B.open = 3.2; B.ent.dmgTaken = 1.6; petals(B.ent.pos.x, B.ent.pos.z, 24); }
    S.waking = null; S.cycleCuts = 0; S.cycleMirror = false;
    yield Math.max(0, 1.0 - (G.now - tk)); if (A.still) A.kneel = STILL_KNEEL;
  }
  // the Waking Cut: every standing ghost (and the lake's mirror) telegraphs from now and fires; one hit at most per swap
  function wakingCut(b, W) {
    const S = b.state, res = { hit: false, end: G.now, n: 0, cuts: [] }, hs = [];
    for (const gh of S.ghosts) {
      const c = gh.cut; if (!c) continue; const tt = WAKE.tell + (c.wave === 2 ? WAKE.wave2 : 0); res.end = Math.max(res.end, G.now + tt); res.n++; res.cuts.push(c);
      if (gh.mark) Hz.cancel(gh.mark); gh.mark = null; laneLeave(S, c, tt);
      vTele(b, c.x, c.z, c.dir, c.len, tt, c.blue ? BLUE_T : 0xff6a88);
      hs.push(Hz.rect(c.x, c.z, c.dir, c.len, 2.3, tt, WAKE.dmg, { name: 'Waking Cut', color: c.blue ? BLUE : ROSE, quiet: true, silent: hs.length > 0,
        onFire: () => { cutFx(b, c.x, c.z, c.dir, c.len, c.blue ? BLUE : PALE); if (gh.cut === c) gh.cut = null; if (WAKE.laneAfter > 0) addLane(b, Object.assign({}, c), WAKE.laneAfter); },
        onHit: () => { res.hit = true; for (const h of hs) h.dmg = 0; } }));
    }
    if (res.n && !G.headless) { const e = W.ent; FX.ring(e.pos.x, e.pos.z, { r0: 0.6, r1: 3.2, color: W.col, dur: 0.5, width: 0.2, mult: 1.4 }); Sound.sfx('sword', 0.7, 0.6); }
    return res;
  }
  // p: the player whose hit set it off
  function* counterN(b, act, p) {
    const S = b.state, e = act.ent; act.hold = true; FX.flash(0xffffff, 0.3, 4); Sound.sfx('parry', 0.8, 0.7); petals(e.pos.x, e.pos.z, 30, act.ice);
    const a = p.facing + PI, ox = e.pos.x, oz = e.pos.z; let tx = p.pos.x + Math.sin(a) * 2.2, tz = p.pos.z + Math.cos(a) * 2.2; const d = Math.hypot(tx, tz); if (d > 14) { tx *= 14 / d; tz *= 14 / d; }
    yield 0.22; e.pos.x = tx; e.pos.z = tz; e.facing = angTo(tx, tz, p.pos.x, p.pos.z); swing(act, 1, 0.2);
    const cl = Math.hypot(tx - ox, tz - oz); if (cl > 0.5) vCut(b, ox, oz, Math.atan2(tx - ox, tz - oz), cl, act === S.R ? ICE : 0xffffff); Sound.sfx('crit'); FX.slash(p.pos.x, 1.2, p.pos.z, e.facing, { r: 3.5, color: 0xffffff, dur: 0.3, mult: 1.6 });
    p.hurt(380, { blockable: true, src: { name: 'Counter' } });
    yield 0.55; petals(e.pos.x, e.pos.z, 18, act.ice); act.hold = false;
  }
  // ---- calm places: petal-free lanes (Draw Cut) and the Eye of the Moon (Full Moon). Only this boss's petals are removed.
  function inLane(L, x, z) { const dx = x - L.x, dz = z - L.z, s = Math.sin(L.dir), c = Math.cos(L.dir), u = dx * s + dz * c, v = dx * c - dz * s; return u > -0.6 && u < L.len + 0.6 && Math.abs(v) < L.w / 2; }
  // (id, blue: for the view, which draws a pale streak of still air for each lane)
  function addLane(b, cut, life = CALM.laneLife) {
    const S = b.state, L = { id: ++S.laneSeq, x: cut.x, z: cut.z, dir: cut.dir, len: cut.len, w: CALM.laneW, t0: G.now, until: G.now + life, cut, leave: false, blue: !!cut.blue };
    S.lanes.push(L); S.calmV = (S.calmV || 0) + 1;
    return L;
  }
  // an Echo on a ghost turns its lane back into a blade: the lane stops being offered as calm and ends when the echo lands
  function laneLeave(S, cut, t) { if (S.lanes) for (const L of S.lanes) if (L.cut === cut) { L.leave = true; L.until = Math.min(L.until, G.now + t); S.calmV = (S.calmV || 0) + 1; } }
  // when (seconds from now) does a petal flying from (x, z) along dir at speed enter a live calm place? (it dies there; Infinity if never)
  function calmEntry(S, x, z, dir, speed) {
    let best = Infinity; const vx = Math.sin(dir) * speed, vz = Math.cos(dir) * speed;
    for (const L of S.lanes) { const s = Math.sin(L.dir), c = Math.cos(L.dir), dx = x - L.x, dz = z - L.z, u = dx * s + dz * c, v = dx * c - dz * s, du = vx * s + vz * c, dv = vx * c - vz * s;
      let t0 = 0, t1 = L.until - G.now; for (const [p0, d0, lo, hi] of [[u, du, -0.6, L.len + 0.6], [v, dv, -L.w / 2, L.w / 2]]) { if (Math.abs(d0) < 1e-6) { if (p0 <= lo || p0 >= hi) t1 = -1; } else { let a = (lo - p0) / d0, b2 = (hi - p0) / d0; if (a > b2) [a, b2] = [b2, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b2); } }
      if (t0 < t1 && t0 < best) best = t0; }
    const E = S.eye; if (E) { const dx = x - E.x, dz = z - E.z, bb = dx * vx + dz * vz, vv = vx * vx + vz * vz, cc = dx * dx + dz * dz - E.r * E.r, disc = bb * bb - vv * cc;
      if (disc >= 0 && vv > 1e-9) { const t = Math.max(0, (-bb - Math.sqrt(disc)) / vv); if ((-bb + Math.sqrt(disc)) / vv > 0 && t < E.until - G.now && t < best) best = t; } }
    return best;
  }
  function calmSim(b) {
    const S = b.state; if (S.lanes.length) { const n = S.lanes.length; S.lanes = S.lanes.filter((L) => G.now < L.until); if (S.lanes.length !== n) S.calmV = (S.calmV || 0) + 1; } if (S.eye && G.now >= S.eye.until) { S.eye = null; S.calmV = (S.calmV || 0) + 1; }
    // every petal knows where it will die (stopAt, its own clock): the autopilot's bullet forecast then sees a calm place as calm
    for (const q of Bul.list) if (q.petal && q.cv !== S.calmV) { q.cv = S.calmV; const t = calmEntry(S, q.x, q.z, q.dir, q.speed); if (t < Infinity) q.stopAt = q.t + t; else delete q.stopAt; }
    if (!S.lanes.length && !S.eye) return;
    let fx = 0;
    for (const q of Bul.list) { if (!q.petal || q.dead) continue; let kill = !!(S.eye && Math.hypot(q.x - S.eye.x, q.z - S.eye.z) < S.eye.r);
      if (!kill) for (const L of S.lanes) if (inLane(L, q.x, q.z)) { kill = true; break; }
      if (kill) { q.dead = true; if (!G.headless && fx++ < 6) FX.burst(q.x, q.y, q.z, { n: 4, color: 0xffffff, color2: q.petal === 2 ? ICE : PALE, speed: [0.5, 2.2], life: [0.25, 0.55], size: [0.08, 0.18], grav: 1.5, drag: 1.5 }); } }
  }
  // the calm spot the autopilot is told about (tests: a pocket-blind autopilot ignores it): next to the duelist inside the Eye, or
  // the nearest point of a live lane while the storm blows (ranged only; melee stays on the blade, who stands at the lane's end)
  function calmHintOf(b) {
    const S = b.state, p = b.focusPlayer(); if (!p) return null;
    if (S.eye) { const dx = p.pos.x - S.eye.x, dz = p.pos.z - S.eye.z, d = Math.hypot(dx, dz) || 1; return { x: S.eye.x + dx / d * 2.3, z: S.eye.z + dz / d * 2.3 }; }
    if ((S.storm !== 'on' && !S.unison) || p.cls.melee) return null;
    // a point on a live lane near the player, preferably 7 m or more from the blade (who stands at the lane's far end, Moons ready)
    let best = null, bs = S.unison ? 30 : 9; const e = S.lead.ent;
    for (const L of S.lanes) { if (L.leave || L.until - G.now < 0.8) continue; const s = Math.sin(L.dir), c = Math.cos(L.dir), lo = Math.min(1.5, L.len / 2);
      for (let u = lo; u <= L.len - lo + 1e-6; u += 1) { const x = L.x + s * u, z = L.z + c * u, de = Math.hypot(x - e.pos.x, z - e.pos.z), sc = Math.hypot(p.pos.x - x, p.pos.z - z) + Math.max(0, 7 - de) * 1.5; if (sc < bs) { bs = sc; best = { x, z }; } } }
    return best;
  }
  // is a storm petal about to pass the player within t seconds? (a Draw Cut tell waits for the arm to pass)
  function armSoon(p, t) { for (const q of Bul.list) { if (!q.storm) continue; const vx = Math.sin(q.dir) * q.speed, vz = Math.cos(q.dir) * q.speed, rx = p.pos.x - q.x, rz = p.pos.z - q.z, vv = vx * vx + vz * vz || 1e-6, k = clamp((rx * vx + rz * vz) / vv, 0, t); if (Math.hypot(rx - vx * k, rz - vz * k) < q.r + 1.1) return true; } return false; }
  // when will a storm arm next reach (x, z)? (autopilot only, through def.danger: a player reads the arm and plants just after it
  // has passed). Infinity in a calm place or with no storm; the pocket-blind autopilot does not know the calm places.
  function armAt(b, x, z) {
    const S = b.state; if (!S.niten || !S.storm || !S.lead) return Infinity;
    if (!Bot.pocketBlind) { if (S.eye && Math.hypot(x - S.eye.x, z - S.eye.z) < S.eye.r - 0.6) return Infinity; for (const L of S.lanes) if (!L.leave && inLane({ x: L.x, z: L.z, dir: L.dir, len: L.len - 0.8, w: L.w - 1.0 }, x, z)) return Infinity; }
    const F = stillOf(S), e = F.ent, dx = x - e.pos.x, dz = z - e.pos.z, d = Math.hypot(dx, dz), fly = Math.max(0, d - 1.1) / STORM.speed;
    // the arm points at stA when the breath starts (rem s from now during the tell) and turns stSg * STORM.turn; a petal reaches d after fly
    const cs = S.storm === 'tell' && e.castState, rem = cs ? Math.max(0, cs.time - cs.t) : 0;
    const n = STORM.arms[S.nitenStep], per = TAU / n, hw = (STORM.width - 1) / 2 * STORM.spread + 0.95 / Math.max(d, 1), w = STORM.turn[S.nitenStep];
    const rel = ((S.stSg * (Math.atan2(dx, dz) - S.stA)) % per + per) % per, x0 = cs ? 0 : -w * Math.min(fly, S.stT || 0);
    const m = Math.ceil((x0 - rel - hw) / per), v = Math.max(x0, rel + m * per - hw);
    return Math.max(0, rem + v / w + fly);
  }
  // ---- the Lighthouse Storm: the still one's channel, its own coroutine beside nitenRun, and it never sleeps (option A). A tell
  // (STORM.tell, STORM.swapTell right after a swap) each time it starts, then STORM.arms thick arms (STORM.width petals across)
  // turning from his kneel spot. Held only by the unison brackets (Final Verse, Twin Petal Storm) and his own Counter; at a swap
  // the old arms' petals fly out while the new still one gathers. From step flipFrom it turns back once per breath.
  const stormFree = (S) => S.niten && S.lead && !S.unison && G.now >= S.stormUntil && !stillOf(S).hold;
  function* stormLoop(b) {
    const S = b.state; let quick = false;
    while (true) {
      while (!stormFree(S)) { quick = false; yield 0.05; }
      const F = stillOf(S), e = F.ent, bl = F === S.R;
      // the tell: his cast bar and petals gathering; cancelled if a hold starts
      S.storm = 'tell'; petals(e.pos.x, e.pos.z, 20, F.ice); S.stA = rnd(TAU); S.stSg = rnd() < 0.5 ? 1 : -1; S.stT = 0; // the breath's start angle and turn are set at the tell
      const cs = e.castState = { name: 'Petal Storm', t: 0, time: quick ? STORM.swapTell : STORM.tell, int: false, result: null };
      while (cs.t < cs.time && stormFree(S) && stillOf(S) === F) { cs.t += G.dt; yield; }
      if (e.castState === cs) e.castState = null;
      if (cs.t < cs.time) { S.storm = null; quick = stormFree(S); continue; }
      S.storm = 'on'; let a0 = S.stA, sg = S.stSg, t = 0, rowT = 0, sw = 0; const flip = S.nitenStep >= STORM.flipFrom ? rnd(2.5, 5) : Infinity;
      while (stormFree(S) && stillOf(S) === F) {
        const dt = G.dt; t += dt; a0 += sg * STORM.turn[S.nitenStep] * dt; rowT -= dt; if (t > flip && t - dt <= flip) sg = -sg;
        S.stA = a0; S.stSg = sg; S.stT = t;
        if (rowT <= 0) { rowT += STORM.row; const n = STORM.arms[S.nitenStep], w = STORM.width, ex = e.pos.x, ez = e.pos.z;
          for (let k = 0; k < n; k++) for (let j = 0; j < w; j++) { const a = a0 + k / n * TAU + (j - (w - 1) / 2) * STORM.spread;
            Bul.fire({ x: ex + Math.sin(a) * 1.1, z: ez + Math.cos(a) * 1.1, dir: a, speed: STORM.speed, dmg: STORM.dmg, color: bl ? 0x4a7ae0 : 0xd8467a, r: 0.36, life: STORM.life, petal: bl ? 2 : 1, storm: 1 }); } }
        e.facing = a0; if ((sw -= dt) <= 0) { sw = 0.6; swing(F, 1, 0.3); }
        yield;
      }
      S.storm = null; quick = stormFree(S); // still free: the swap handed the storm to the other body
    }
  }
  // Niten Draw Cut: the blade alone (no mirror cut). Each cut leaves a petal-free lane for CALM.laneLife s and a ghost that STAYS
  // until the swap's Waking Cut. From WAKE.twoWaves every other cut of the cycle is claimed by the still one (his colour, wave 2);
  // from WAKE.mirror the cycle's first cut also leaves the lake's mirrored ghost. A tell never starts just before a storm arm
  // reaches the player; the dash stops short rather than end within KEEP of the still one.
  function* nitenCut(b, n) {
    const S = b.state, p = b.focusPlayer(); S.walk = false;
    for (let i = 0; i < n; i++) {
      { let w = 0; while (w < 1.5 && S.storm === 'on' && armSoon(p, 0.4)) { w += 0.05; yield 0.05; } }
      const L = S.lead, F = other(S, L), e = L.ent, a = angTo(e.pos.x, e.pos.z, p.pos.x, p.pos.z); e.facing = a;
      const full = Math.max(6, edgeLen(e.pos.x, e.pos.z, a)); let len = full;
      for (let q = full; q >= 3; q -= 0.5) { if (Math.hypot(e.pos.x + Math.sin(a) * q - F.ent.pos.x, e.pos.z + Math.cos(a) * q - F.ent.pos.z) >= KEEP) { len = q; break; } }
      const idx = S.cycleCuts = (S.cycleCuts || 0) + 1, w2 = S.nitenStep >= WAKE.twoWaves && idx % 2 === 0;
      const cut = { x: e.pos.x, z: e.pos.z, dir: a, len, blue: L === S.R, wave: 1 };
      L.fake.parryT = 1; const t = tele(b, i === 0 ? 0.95 : 0.72);
      Hz.rect(cut.x, cut.z, a, len, 2.3, t, 310, { name: 'Draw Cut', color: L.col, quiet: true, silent: i > 0 }); vTele(b, cut.x, cut.z, a, len, t, cut.blue ? BLUE_T : 0xff6a88);
      yield t; L.fake.parryT = 0; swing(L, 1, 0.25);
      cutFx(b, cut.x, cut.z, a, len, cut.blue ? BLUE : 0xffffff); addLane(b, cut);
      if (w2) { cut.wave = 2; cut.blue = F === S.R; } // the still one claims it: his colour, his (second) wave
      addGhost(b, cut);
      if (S.nitenStep >= WAKE.mirror && !S.cycleMirror) { S.cycleMirror = true; const mc = { x: -cut.x, z: cut.z, dir: -cut.dir, len: cut.len, blue: F === S.R, wave: 2 }; addGhost(b, mc); petals(mc.x, mc.z, 12, F.ice); }
      e.pos.x += Math.sin(a) * len; e.pos.z += Math.cos(a) * len; petals(e.pos.x, e.pos.z, 14, L.ice); yield 0.3;
    }
    const e = S.lead.ent; e.facing = angTo(e.pos.x, e.pos.z, p.pos.x, p.pos.z); yield 0.5;
  }
  // Twin Focus is Niten's ramp bell: it plays at the start of every ramp step (both bodies: dome, roar, flash, petals), the
  // wordless signal that something new is coming. A new haste stack (step 5) shows with it.
  function* twinFocus(b) {
    const S = b.state, L = S.lead, F = other(S, L); S.haste = Math.max(S.haste, hasteFor(b));
    for (const act of [L, F]) { FX.dome(act.ent.pos.x, 1, act.ent.pos.z, { r: 6, color: act.col, dur: 0.6 }); petals(act.ent.pos.x, act.ent.pos.z, 30, act.ice); }
    Sound.sfx('roar', 0.6, 2.2); FX.flash(ROSE, 0.25, 3); S.bells = (S.bells || 0) + 1;
    yield 0.6;
  }
  // Twin Final Verse (unison, storm held): both vanish; rose lines and their blue mirrors 0.45 s late. In beats (SET.verseBeats):
  // after each beat but the last the blade shows for SET.verseRest s near the player (a Bolt fits; he can be hit), then vanishes
  // again. They come back at their own spots: the blade near the player, the still one at least 6 m from him and within KNEEL_R.
  function showAct(S, act, on) { act.ent.targetable = on; act.shown = on; }
  function nearPlayer(b, r) { const p = b.focusPlayer(), a = rnd(TAU); let tx = p.pos.x + Math.sin(a) * r, tz = p.pos.z + Math.cos(a) * r; const d = Math.hypot(tx, tz); if (d > 13) { tx *= 13 / d; tz *= 13 / d; } return [tx, tz]; }
  function* twinFinalVerse(b, n = 7) {
    const S = b.state, Rr = S.R; S.walk = false; yield* S.lead.ent.cast({ name: 'Final Verse', time: 1.1 });
    for (const act of [S.A, Rr]) petals(act.ent.pos.x, act.ent.pos.z, 40, act.ice);
    showAct(S, S.A, false); showAct(S, Rr, false); S.verse = true; Co.start(Post.lerpTo({ sat: 0.75, vig: 1.05 }, 0.4), 'fight');
    const beats = SET.verseBeats || [n];
    for (let bi = 0; bi < beats.length; bi++) {
      for (let i = 0; i < beats[bi]; i++) {
        const qa = rnd(TAU), qr = i % 3 === 0 ? 0 : rnd(2, 10), p = b.focusPlayer(), qx = i % 3 === 0 ? p.pos.x : Math.sin(qa) * qr, qz = i % 3 === 0 ? p.pos.z : Math.cos(qa) * qr, dir = rnd(TAU), ox = qx - Math.sin(dir) * 20, oz = qz - Math.cos(dir) * 20;
        verseLine(b, ox, oz, dir, tele(b, 1.2), false); verseLine(b, -ox, oz, -dir, tele(b, 1.2) + 0.45, true); Sound.sfx('tick', 1, 1 + i * 0.08);
        yield tele(b, 0.27);
      }
      yield tele(b, 1.2) + 0.45;
      if (bi < beats.length - 1) { // the still moment: the blade stands near the player, then is gone again
        const L = S.lead, [tx, tz] = nearPlayer(b, 5), fp = b.focusPlayer(); L.ent.pos.set(tx, 0, tz); L.ent.facing = angTo(tx, tz, fp.pos.x, fp.pos.z); showAct(S, L, true); petals(tx, tz, 30, L.ice); Sound.sfx('sword', 0.6, 0.8);
        yield SET.verseRest; petals(L.ent.pos.x, L.ent.pos.z, 30, L.ice); showAct(S, L, false);
      }
    }
    S.verse = false; Co.start(Post.lerpTo({ sat: 1.08, vig: 0.9 }, 0.5), 'fight');
    const p = b.focusPlayer(), L = S.lead, F = other(S, L), [tx, tz] = nearPlayer(b, 4);
    L.ent.pos.set(tx, 0, tz);
    let fx = -tx, fz = -tz; for (let k = 0; k < 24; k++) { const fa = rnd(TAU), fr = rnd(3, KNEEL_R), x = Math.sin(fa) * fr, z = Math.cos(fa) * fr; if (Math.hypot(x - tx, z - tz) >= 6) { fx = x; fz = z; break; } }
    { const fd = Math.hypot(fx, fz); if (fd > KNEEL_R) { fx *= KNEEL_R / fd; fz *= KNEEL_R / fd; } } F.ent.pos.set(fx, 0, fz);
    showAct(S, S.A, true); showAct(S, Rr, true); for (const act of [S.A, Rr]) { petals(act.ent.pos.x, act.ent.pos.z, 40, act.ice); act.ent.facing = angTo(act.ent.pos.x, act.ent.pos.z, p.pos.x, p.pos.z); }
    yield 0.4;
  }
  function moonAt(b, act, k, t) {
    const e = act.ent, x = e.pos.x, z = e.pos.z, p = b.focusPlayer(), a = angTo(x, z, p.pos.x, p.pos.z), blue = act.col === BLUE; e.facing = a; act.fake.parryT = 1;
    const fx = () => { swing(act, k === 'c' ? 1 : 0, 0.3); Sound.sfx('sword'); Sound.sfx('boom', 0.5); FX.shake(0.3); act.fake.parryT = 0; };
    if (k === 'c') Hz.cone(x, z, a, 3.5, 9.5, t, 320, { name: 'Crescent', color: act.col, quiet: true, onFire: () => { fx(); vArcs(b, 'c', x, z, a, blue); petals(x + Math.sin(a) * 4, z + Math.cos(a) * 4, 20, act.ice); } });
    else if (k === 'o') (b.state.fullMoon = { x, z, at: G.now + t }, Hz.donut(x, z, MOON.r, MOON.far, t, 320, { name: 'Full Moon', color: act.col, quiet: true, onFire: () => { fx(); vArcs(b, 'o', x, z, vrand() * TAU, blue); petals(x, z, 40, act.ice); } }));
    else Hz.circle(x, z, MOON.r, t, 320, { name: 'New Moon', color: act.col, quiet: true, onFire: () => { fx(); FX.dome(x, 0.5, z, { r: MOON.r, color: act.col, dur: 0.4, mult: 1.1 }); vArcs(b, 'n', x, z, vrand() * TAU, blue); } });
  }
  // Moons from the blade, one at a time (step 2, Full Moon first so the Eye is taught) or in sets of two (step 3 on), 1.15 s tell
  // before haste (at 0.95 they caused most autopilot deaths in Niten). Full Moon: its safe hole is also petal-free, from the start of
  // the tell until CALM.eyeAfter s after it lands (the Eye of the Moon). New Moon pushes you out into the petals; Crescent is a sidestep.
  const MOON1 = ['o', 'n', 'c', 'o', 'c', 'n'], MOON2 = [['o', 'c'], ['n', 'o'], ['c', 'n'], ['o', 'n']];
  function* nitenMoons(b, kinds) {
    const S = b.state; S.walk = false;
    for (const k of kinds) {
      const L = S.lead, e = L.ent, t = moonTell(b, 1.15, k, e.pos.x, e.pos.z); S.moonK = k;
      if (k === 'o') { S.calmV = (S.calmV || 0) + 1; S.eye = { x: e.pos.x, z: e.pos.z, r: CALM.eyeR, t0: G.now, until: G.now + t + CALM.eyeAfter, blue: L === S.R }; }
      moonAt(b, L, k, t); yield t + 0.3; S.moonK = null;
    }
    yield 0.4;
  }
  // Twin Petal Storm (unison, the lighthouse held): both stand at (-4, 0) and (4, 0), two 3-arm spirals turning opposite ways for 5 s.
  // Afterwards the still one kneels where he is and the lighthouse comes back.
  function* twinStorm(b, dur = 5, arms = 3) {
    const S = b.state, L = S.lead, F = other(S, L), e = L.ent; S.walk = false; const sx = e.pos.x < 0 ? -1 : 1;
    for (const act of [L, F]) petals(act.ent.pos.x, act.ent.pos.z, 20, act.ice);
    e.pos.set(sx * 4, 0, 0); F.ent.pos.set(-sx * 4, 0, 0); for (const act of [L, F]) petals(act.ent.pos.x, act.ent.pos.z, 40, act.ice);
    // the board you built: every standing ghost line stays petal-free from the cast until the spirals have flown out
    if (SET.stormGhostCalm) for (const gh of S.ghosts) if (gh.cut) addLane(b, gh.cut, 1.2 + dur + 1.0);
    yield* e.cast({ name: 'Petal Storm', time: 1.2 });
    let t = 0, a0 = rnd(TAU); const dirSign = rnd() < 0.5 ? 1 : -1;
    while (t < dur) {
      for (const act of [S.A, S.R]) { const m = act === S.lead ? 1 : -1, x0 = act.ent.pos.x, z0 = act.ent.pos.z, bl = act === S.R;
        for (let k = 0; k < arms; k++) { const a = m * (a0 + k / arms * TAU); Bul.fire({ x: x0 + Math.sin(a) * 1.2, z: z0 + Math.cos(a) * 1.2, dir: a, speed: 6.2, dmg: 85, color: bl ? 0x4a7ae0 : 0xd8467a, r: 0.36, life: 3.6, petal: bl ? 2 : 1 }); }
        act.ent.facing += m * dirSign * 0.9; }
      a0 += dirSign * 0.105; if (Math.floor(t / 0.36) !== Math.floor((t - 0.12) / 0.36)) { swing(S.A, 1, 0.3); swing(S.R, 1, 0.3); } t += 0.12; yield 0.12;
    }
    const p = b.focusPlayer(); for (const act of [S.A, S.R]) act.ent.facing = angTo(act.ent.pos.x, act.ent.pos.z, p.pos.x, p.pos.z); yield 0.7;
  }
  // every frame: openings run out, the awake one walks and keeps KEEP from the still one, the calm places cull petals
  function nitenSim(b, dt) {
    const S = b.state, p = b.focusPlayer(), L = S.lead, F = other(S, L), e = L.ent;
    if (G.state === 'fight' && !b.transitioning) S.nitenT += dt;
    for (const act of [S.A, S.R]) if (act.open > 0) { act.open -= dt; if (act.open <= 0) act.ent.dmgTaken = 1; }
    if (S.walk && b.alive && G.state === 'fight' && !e.castState && p) { const d = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z); e.facing = dampAng(e.facing, angTo(e.pos.x, e.pos.z, p.pos.x, p.pos.z), 8, dt); if (d > 3.2) { const st = Math.min(d - 3.2, 4.6 * dt); e.pos.x += Math.sin(e.facing) * st; e.pos.z += Math.cos(e.facing) * st; } }
    // steer around the still one: never closer than KEEP (slides round him), never off the deck
    if (S.niten && !S.verse && b.alive && !L.hold && !F.hold) { const dx = e.pos.x - F.ent.pos.x, dz = e.pos.z - F.ent.pos.z, d = Math.hypot(dx, dz);
      if (d < KEEP) { const ux = d > 1e-3 ? dx / d : 1, uz = d > 1e-3 ? dz / d : 0; e.pos.x = F.ent.pos.x + ux * KEEP; e.pos.z = F.ent.pos.z + uz * KEEP; }
      const r = Math.hypot(e.pos.x, e.pos.z); if (r > R - 0.8) { e.pos.x *= (R - 0.8) / r; e.pos.z *= (R - 0.8) / r; } }
    calmSim(b); S.calmHint = calmHintOf(b);
  }
  // the shot of the fight: he kneels at the water, his image in the lake stands up without him and climbs out. The image's
  // pose (Rr.root, Rr.kneel, Rr.img) is view data the sim keeps step by step, so every viewer sees the same climb.
  function* nitenEnter(b) {
    const S = b.state, Rr = S.R, A = S.A, rt = Rr.root; resetMech(b); clearGhosts(S); S.walk = false; S.niten = false; Music.intensity(4); S.nitenT = 0; S.nitenStep = 0; S.stepAt = [];
    petals(b.pos.x, b.pos.z, 30); b.pos.set(0, 0, -12.6); b.facing = PI; petals(0, -12.6, 30); S.kneel = 1;
    // (Threshold plays this shot only with a picture; here the cinematic lock is a rule, so it always plays)
    S.cine = true; UI.hud(false); Co.start(Cam.shot([1.5, 0.78, -27.8], [0, 0.05, -13.8], [-0.6, 0.98, -25.6], [0, 0.3, -14.0], 5.4, 42), 'phase');
    // the image: upside down under the surface (drawn over the water, clipped at the water line), kneeling with him
    Rr.shown = true; Object.assign(rt, { x: 0, y: -0.3, z: -16.2, ry: PI, flip: -1, under: true }); Rr.kneel = 1; Rr.img = 0.5;
    yield 1.5;
    // he stays down; the image stands
    { let t = 0; while (t < 1.1) { t += G.dt; Rr.kneel = 1 - smooth(t / 1.1); yield; } Rr.kneel = 0; }
    yield 0.35;
    // the reflection rises through the surface at the deck edge
    S.rip = { x: 0, z: -16.2, t: G.ft }; Sound.sfx('boom', 0.35, 0.45);
    Rr.img = 0; Object.assign(rt, { flip: 1, under: false, y: -3.6, z: -16.2 });
    { let t = 0; while (t < 1.2) { t += G.dt; rt.y = lerp(-3.6, -0.12, smooth(t / 1.2)); yield; } }
    { let t = 0; while (t < 0.5) { t += G.dt; const k = smooth(t / 0.5); rt.y = lerp(-0.12, 0, k); rt.z = lerp(-16.2, -14.4, k); yield; } }
    // he draws left-handed. One bell.
    swing(Rr, 1, 0.45); Sound.sfx('bell', 0.9, 0.5); if (!G.headless) FX.ring(0, -14.4, { r0: 0.5, r1: 4, color: BLUE, dur: 0.6, width: 0.2, mult: 1.4 });
    yield 0.55;
    // both walk to their marks; the deck splits into two colours on the seam
    if (S.cine) { S.cine = false; Cam.release(); UI.hud(true); }
    S.kneel = 0; const ra = Rr.ent.pos; ra.set(rt.x, 0, rt.z); Rr.ent.facing = rt.ry; Rr.live = true;
    { const a0 = b.pos.clone(), r0 = ra.clone(), to = new V3(-4, 0, -6), tr = new V3(4, 0, -6); let t = 0; while (t < 1.3) { t += G.dt; const k = smooth(t / 1.3); b.pos.lerpVectors(a0, to, k); ra.lerpVectors(r0, tr, k); b.facing = dampAng(b.facing, angTo(b.pos.x, b.pos.z, -4, -6), 10, G.dt); Rr.ent.facing = dampAng(Rr.ent.facing, angTo(ra.x, ra.z, 4, -6), 10, G.dt); S.duoK = k; yield; } }
    b.facing = b.angToPlayer(); Rr.ent.facing = -b.facing;
    if (!G.ents.includes(Rr.ent)) G.ents.push(Rr.ent);
    Rr.ent.targetable = true; S.niten = true; wake(b, A, true); S.countered = false; Rr.kneel = STILL_KNEEL; S.cycleCuts = 0; S.cycleMirror = false; S.waking = null; S.wakeLog = [];
    S.low12 = false; S.lastStorm = false; S.moonN = S.moonN2 = 0; S.stormUntil = G.now + 1.5; Co.start(stormLoop(b), 'phase');
    yield 0.3;
  }
  // Niten ramps every RAMP seconds of live phase time (S.nitenT), six steps. A swap (with its Waking Cut) follows every bracket, about
  // every BRACKET s; the blade does not walk between moves any more. Every bracket lays the step's Draw Cuts (WAKE.cuts, in chains)
  // and adds what its list names (the A + B ramp in issen-intensity-ideas.md):
  //   0: 1 arm, 2 cuts                        1: 3 cuts, + one Moon every other bracket (Full Moon first: the Eye is taught)
  //   2: 2 arms, 4 cuts, a Moon every bracket, the Waking Cut in two waves; opens with [cuts, Twin Petal Storm] (the mid-fight one)
  //   3: 2 arms turning back once per breath; [cuts, two Moons] [Final Verse in beats, cuts]
  //   4: 3 arms, 5 cuts, the lake's mirrored ghost; + [cuts, Twin Petal Storm] every loop
  //   5: 3 arms faster, 6 cuts, swap tell 0.9 s, gaps 0.3 s, third haste stack
  // Set-piece brackets lay WAKE.unisonCuts of the cuts. The cuts come before Twin Petal Storm (their ghosts are its calm lines) and
  // after Final Verse. A step never starts mid-bracket: after the swap that follows the step's time, a fresh loop opens with the Focus
  // flare and the new mechanic's bracket, so a new layer first appears right after a swap.
  // The double storm at the end is guaranteed: the first time health drops below 12% the next bracket has Twin Petal Storm, and
  // from the soft enrage on every other bracket has it until The Last Petal.
  const RAMP = 35, BRACKET = 9;
  const nitenStepOf = (S) => Math.min(5, Math.floor(S.nitenT / RAMP));
  const NITEN_LOOP = [
    [[]],
    [['m1'], []],
    [['m1']],
    [['m2'], ['verse']],
    [['m2'], ['verse'], ['storm']],
    [['m2'], ['verse'], ['storm']],
  ];
  const NITEN_OPEN = [null, null, ['storm'], null, null, null]; // a one-off bracket that opens the step
  const NITEN_NEW = [0, 0, 0, 1, 2, 0]; // the bracket that holds each step's new mechanic
  // n cuts as chains of at most WAKE.chain, at least two chains from 2 cuts (6 -> 3 3, 5 -> 3 2, 4 -> 2 2, 3 -> 2 1, 2 -> 1 1)
  function chainsOf(n) { if (n <= 1) return n ? [1] : []; const k = Math.max(2, Math.ceil(n / WAKE.chain)), out = []; for (let i = 0; i < k; i++) out.push(Math.floor(n / k) + (i < n % k ? 1 : 0)); return out; }
  function* nitenMech(b, k) {
    const S = b.state;
    if (k === 'm1') { S.moonN = (S.moonN || 0) + 1; yield* nitenMoons(b, [MOON1[(S.moonN - 1) % MOON1.length]]); }
    else if (k === 'm2') { S.moonN2 = (S.moonN2 || 0) + 1; yield* nitenMoons(b, MOON2[(S.moonN2 - 1) % MOON2.length]); }
    else if (k === 'verse' || k === 'storm') { S.unison = true; S.storm = null; if (k === 'verse') yield* twinFinalVerse(b); else yield* twinStorm(b); S.unison = false; S.stormUntil = Math.max(S.stormUntil, G.now + 1.0); }
  }
  function* bracket(b, list, gap) {
    const S = b.state, t0 = G.ft, st = S.nitenStep, set = list.find((k) => k === 'verse' || k === 'storm'), moons = list.filter((k) => k !== set);
    S.lastStorm = set === 'storm';
    const chains = chainsOf(set ? Math.ceil(WAKE.cuts[st] * WAKE.unisonCuts) : WAKE.cuts[st]);
    // a breath (WAKE.breath, a Bolt fits) after the swap and between blocks: the opening is the waker's own, and no two blocks of
    // telegraphs run back to back
    const breath = function* (t = WAKE.breath) { S.walk = true; yield t; S.walk = false; };
    if (set === 'verse') { yield* nitenMech(b, set); yield gap; } else yield* breath(WAKE.openBreath);
    for (let i = 0; i < chains.length; i++) {
      yield* nitenCut(b, chains[i]);
      if (i === 0 && moons.length) { for (const k of moons) yield* nitenMech(b, k); }
      if (i < chains.length - 1 || (i === 0 && moons.length)) yield* breath();
    }
    if (set === 'storm') { yield gap; yield* nitenMech(b, set); }
    // keep the swap cadence: the blade closes in until the bracket has run BRACKET s less the swap itself
    while (G.ft - t0 < BRACKET - (S.tellT || STILL_TELL) - 1.0) { S.walk = true; yield 0.1; }
    S.walk = false; yield gap;
    yield* swap(b);
  }
  // a forced Twin Petal Storm: once when health first drops below 12%, then every other bracket from the soft enrage on
  function forcedStorm(b) {
    const S = b.state;
    if (b.enraged) return !S.lastStorm;
    if (!S.low12 && b.hp < b.maxHp * 0.12) { S.low12 = true; return !S.lastStorm; }
    return false;
  }
  function* nitenRun(b) {
    const S = b.state; yield 0.6;
    while (true) {
      const st = nitenStepOf(S); let order = NITEN_LOOP[st].map((_, i) => i), fresh = false;
      if (st > S.nitenStep || (st === 0 && !S.stepAt.length)) {
        S.nitenStep = st; S.stepAt[st] = Math.round(G.ft * 10) / 10; fresh = true;
        if (st >= 5) S.tellT = 0.9;
        if (st > 0) { yield* twinFocus(b); const f = NITEN_NEW[st]; order = [f, ...order.filter((i) => i !== f)]; }
      }
      const gap = st >= 5 ? 0.3 : 0.6;
      if (fresh && NITEN_OPEN[st]) { yield* bracket(b, NITEN_OPEN[st], gap); if (forcedStorm(b)) yield* bracket(b, ['storm'], gap); }
      for (const i of order) {
        yield* bracket(b, NITEN_LOOP[st][i], gap);
        if (forcedStorm(b)) yield* bracket(b, ['storm'], gap);
        if (nitenStepOf(S) > st) break; // a new step starts right after this swap, as a fresh loop
      }
    }
  }
  // Nightmare health (the tuning lever; class numbers and the ramp stay). Threshold's tools/nmpace.js at 28,000 and enrage 355 s:
  // stormcaller medians 4:36-4:57, hexslinger 4:22-4:31, ashwarden 5:40, duskblade 6:09 (inside the soft enrage).
  const NM_HP = 28000;

  // what the view half reads (channel 2): who shows, who kneels, the ghosts, the calm places, the regrades, the reflection's climb
  function publish(b) {
    const S = b.state, P = b.pub, Rr = S.R;
    P.haste = S.haste; P.kneel = S.kneel; P.parry = S.fake.parryT > 0; P.warn = S.warn > 0; P.still = !!S.still; P.open = S.open > 0 || S.A.open > 0; P.showA = S.showA; P.sheath = S.sheath;
    P.verse = !!S.verse; P.niten = !!S.niten; P.deep = S.deep; P.night = S.nightK; P.lake = S.lake; P.lakeK = S.lakeK; P.seamP = S.seamP; P.tellT = S.tellT;
    P.ghosts = S.ghosts.map((g) => g.cut ? { x: g.cut.x, z: g.cut.z, dir: g.cut.dir, len: g.cut.len, blue: !!g.cut.blue } : null);
    if (S.R) {
      P.lanes = S.lanes.map((L) => ({ id: L.id, x: L.x, z: L.z, dir: L.dir, len: L.len, w: L.w, t0: L.t0, until: L.until, leave: L.leave, blue: L.blue }));
      P.eye = S.eye ? { x: S.eye.x, z: S.eye.z, r: S.eye.r, t0: S.eye.t0, until: S.eye.until, blue: S.eye.blue } : null;
      P.now = G.now; // the sim clock the lanes' and the Eye's times are on
      P.lead = S.lead ? S.lead.name : 'A'; P.storm = S.storm || null; P.duoK = S.niten ? 1 : (S.duoK || 0); P.rip = S.rip || null;
      P.A = { still: !!S.A.still, warn: S.A.warn > 0, open: S.A.open > 0, parry: S.A.fake.parryT > 0 };
      P.R = { still: !!Rr.still, warn: Rr.warn > 0, open: Rr.open > 0, parry: Rr.fake.parryT > 0, kneel: Rr.kneel, img: Rr.img, shown: Rr.shown, sheath: Rr.sheath, live: Rr.live, root: Rr.root, x: Rr.ent.pos.x, z: Rr.ent.pos.z, f: Rr.ent.facing };
    }
  }

  G.bosses.push({
    id: 'duelist', name: 'ISSEN', title: 'The Last Petal', hint: 'A duel', color: '#ff7a9a', telegraph: ROSE,
    hp: 23000, radius: 0.9, aimY: 1.6, enrage: 420,
    maxPlayers: 1, // solo for now: party scaling and co-op mechanics come later
    build,
    *intro(b) { yield* Cam.shot([9, 1.2, 4], [0, 1.8, -5], [2.5, 1.7, -1], [0, 1.9, -5], 3.2, 40); swing(b.state.A, 1, 0.4); Sound.sfx('sword'); petals(0, -5, 40); yield 1.0; },
    phases: [
      { at: 1, *run(b) {
        const S = b.state; yield 0.8;
        while (true) {
          yield* drawCut(b, 3); yield* echo(b, 0); S.walk = true; yield 1.2;
          yield* moon(b, ['n', 'o']); S.walk = true; yield 1.0;
          yield* stillness(b); S.walk = true; yield 0.6;
          yield* moon(b, ['c']); yield* drawCut(b, 3); yield* moon(b, ['o', 'n']); yield* echo(b, 0); S.walk = true; yield 1.2;
        }
      } },
      { at: 0.66, *enter(b) { const S = b.state; clearGhosts(S); S.walk = false; petals(b.pos.x, b.pos.z, 60); b.pos.set(0, 0, 0); Sound.sfx('sword', 1, 0.5); FX.dome(0, 1, 0, { r: 9, color: ROSE, dur: 0.8 }); Co.start(Post.lerpTo({ bloom: 0.46, sat: 1.14 }, 2), 'fight'); Co.start(deepen(b), 'fight'); yield 1.6; },
        // started directly at a later phase: this phase's sunset deepening and grade at once
        skipTo(b) { b.state.deep = 1; View.cue('post.set', { bloom: 0.46, sat: 1.14 }); },
        run: sunsetRun },
      { at: 0.33, enter: nightEnter, run: nightRun },
    ],
    // ---- Nightmare ("Niten"). Short teaching phases, then Niten is two thirds of the fight and ramps every 35 s. One creeping
    // enrage (40 + 4 per second over, every 2 s) and The Last Petal 24 s into it. The look starts at sunset (deepened).
    // Threshold's kill (nitenDeath: the reflection falls back into the lake, he kneels, the last petal) is view-only: the client's.
    nightmare: {
      hp: NM_HP, enrage: 355, enrageBase: 40, enrageGrow: 4,
      winHold: 9, // the server shows the end this long (s) before the lobby: nitenDeath takes about 7.5 s of real time
      lastBlow: lastPetal,
      phases: [
        { at: 1, music: 1, run: sunsetNM },
        { at: 0.88, music: 2, *enter(b) { resetMech(b); yield* nightEnter(b); }, skipTo: nightSkip, run: nightNM },
        { at: 0.78, music: 3, enter: lakeEnter, skipTo: lakeSkip, run: lakeRun },
        { at: 0.66, music: 5, enter: nitenEnter, run: nitenRun },
      ],
      nmTest: { RAMP, stepOf: nitenStepOf, STORM, CALM, WAKE, SET, BRACKET },
      // the autopilot reads the Lighthouse Storm's arms like a telegraph (see armAt). Nightmare only: Normal's autopilot is untouched.
      danger(b, x, z) { return b.state.niten ? armAt(b, x, z) : Infinity; },
    },
    update(b, dt) {
      const S = b.state;
      if (S.niten) nitenSim(b, dt);
      else if (S.walk && b.alive && G.state === 'fight' && !b.castState) { const d = b.distToPlayer(); b.facing = dampAng(b.facing, b.angToPlayer(), 8, dt); if (d > 3.2) { const s = Math.min(d - 3.2, 4.6 * dt); b.pos.x += Math.sin(b.facing) * s; b.pos.z += Math.cos(b.facing) * s; } }
      if (S.open > 0) S.open -= dt;
      publish(b);
    },
    // The autopilot hint, as Threshold's, with one change so a bot fight replays without the bot: stopping a cast is asked for
    // (out.stopCast, which Bot turns into an input: the same as a player moving out of a planted cast) instead of done here.
    bot(b, p) {
      const S = b.state, out = {};
      // the tell before he kneels: a player stops a cast that would land after it (it would counter; there is no grace)
      // and a Full Moon from out of reach: stop the cast if finishing it leaves too little time to walk in
      { const m = S.fullMoon, c = p && p.casting; if (m && c && G.now < m.at) { const d = Math.hypot(p.pos.x - m.x, p.pos.z - m.z), walk = Math.max(0, d - MOON.r + 0.8) / (p.speed * p.speedMul);
        if (walk > 0 && G.now + (c.time - c.t) + walk > m.at - 0.15) out.stopCast = true; } }
      const stopCast = (at) => { const c = p && p.casting; if (c && at && G.now + (c.time - c.t) >= at - 0.05) out.stopCast = true; };
      // Niten: attack the awake one, never the still one; hold during the tell and the grace; stand in the calm place when there is
      // one (a cut lane while the storm blows, the Eye of the Moon). Bot.pocketBlind (tests only) ignores the calm places.
      // Bot.swapBlind (tests only) ignores swaps and always attacks Issen: that autopilot must fail phase IV.
      if (S.niten && S.lead) { if (Bot.swapBlind) return Object.assign(out, { target: b }); const L = S.lead, Fo = other(S, L), h = Object.assign(out, { target: L.ent, holdFire: L.warn > 0 || G.now < Fo.graceT || !L.ent.targetable }); if (S.calmHint && !Bot.pocketBlind) Object.assign(h, S.calmHint);
        // a planted cast is only started when it will finish before the next storm arm arrives
        if (S.storm && p) { const t = armAt(b, p.pos.x, p.pos.z); if (t < 3) h.noCast = t - 0.25; }
        if (L.warn > 0) stopCast(L.kneelAt); return h; }
      if (S.warn > 0) stopCast(S.kneelAt);
      return Object.assign(out, { holdFire: S.still || S.warn > 0 });
    },
  });
})();
