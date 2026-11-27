// Client prediction (packages/sim/src/predict.js): the predictor, given the server's state of your character at tick T
// and the input frames after T, must land exactly where the server does, whenever nothing from the world touches the
// character in between. On the training dummy (it never attacks) that is every tick of the fight, for every class.
// On Pentimento it must hold for most windows (the misses are hits, paint, the dish: what the server corrects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFight, tickAll, G, ownState, applyOwnState, Predictor, Player } from './_sim.js';

const N = 6; // ticks replayed after each server state (a client about 200 ms ahead of the server)
// what the predictor may not know: the next glowing Static slot is drawn from the fight's RNG when Discharge lands
const RNG_DRAWN = (k) => k === 'sc';

function record(o) {
  startFight(Object.assign({ seed: 7, intro: false }, o));
  const ticks = [];
  const ents = () => G.ents.map((e) => ({ id: e.id, x: e.pos.x, y: e.pos.y, z: e.pos.z, radius: e.radius, alive: e.alive, boss: e.isBoss, immune: e.immune, tg: e.targetable, ay: e.aimY, my: e.meleeY, facing: e.facing, hp: e.hp, maxHp: e.maxHp }));
  ticks.push({ st: ownState(G.players[0]), ents: ents(), state: G.state, cine: G.cineLock, ft: G.ft, frame: null });
  for (let i = 0; i < o.ticks; i++) {
    const f = tickAll()[0];
    ticks.push({ st: ownState(G.players[0]), ents: ents(), state: G.state, cine: G.cineLock, ft: G.ft, frame: JSON.parse(JSON.stringify(f)), hp: G.players[0].hp });
  }
  return ticks;
}
function diff(a, b, path = '') {
  if (typeof a !== typeof b) return path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
  if (a === null || typeof a !== 'object') return Object.is(a, b) ? null : path + ': ' + a + ' vs ' + b;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (!path && RNG_DRAWN(k)) continue; const d = diff(a[k], b[k], path + '.' + k); if (d) return d; }
  return null;
}
function check(ticks, o) {
  let windows = 0, misses = 0, first = null;
  for (let t = 1; t + N < ticks.length; t++) {
    const T = ticks[t]; if (T.state !== 'fight') continue;
    const pr = new Predictor({ boss: o.boss, nm: o.nm, cls: o.cls, hz: 30 });
    pr.world(T.ents); pr.scene(T.state, T.cine, T.ft); pr.load(T.st);
    for (let n = 1; n <= N; n++) pr.step(ticks[t + n].frame, null);
    windows++;
    const d = diff(pr.save(), ticks[t + N].st);
    if (d) { misses++; if (!first) first = `tick ${t}: ${d}`; }
  }
  return { windows, misses, first };
}

for (const cls of ['duskblade', 'stormcaller', 'hexslinger', 'ashwarden']) {
  test(`prediction matches the server on every tick: ${cls} on the training dummy`, () => {
    const o = { boss: 'dummy', cls, bot: 3, ticks: 30 * 40 };
    const r = check(record(o), o);
    assert.ok(r.windows > 1000, 'windows checked: ' + r.windows);
    assert.equal(r.misses, 0, `${r.misses} of ${r.windows} windows differ; first: ${r.first}`);
  });
}

test('prediction on Pentimento: most windows exact, the rest are the world touching the character', () => {
  const o = { boss: 'atelier', cls: 'stormcaller', bot: 3, ticks: 30 * 60 };
  const r = check(record(o), o);
  assert.ok(r.windows > 1500);
  console.log(`  Pentimento: ${r.misses} of ${r.windows} windows differ (${(r.misses / r.windows * 100).toFixed(1)}%); first: ${r.first}`);
  assert.ok(r.misses / r.windows < 0.1, `${r.misses} of ${r.windows} windows differ; first: ${r.first}`);
});

test('ownState survives JSON and lays over a fresh player exactly', () => {
  startFight({ boss: 'dummy', cls: 'duskblade', bot: 3, seed: 3, intro: false });
  for (let i = 0; i < 400; i++) tickAll();
  const p = G.players[0], st = JSON.parse(JSON.stringify(ownState(p)));
  const q = new Player(p.cls, 99); applyOwnState(q, st, (id) => G.ents.find((e) => e.id === id) || null);
  assert.equal(diff(ownState(q), ownState(p)), null);
  assert.equal(q.target, p.target);
});
