// Several players in one fight (docs/plan.md, roadmap step 3), and the training dummy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G, Hz, startFight, tick, tickAll, over, snapshot, record, replay, addPlayer, removePlayer, swapClass, hpScale } from './_sim.js';

const party = (...cls) => cls.map((c) => ({ cls: c, bot: 3 }));

test('a party fight records and replays from one frame per player per tick', () => {
  const rec = record({ boss: 'atelier', seed: 21, bot: 3, godMode: true, players: party('duskblade', 'stormcaller', 'hexslinger') }, 90);
  assert.deepEqual(rec.end.errors, []);
  assert.ok(Array.isArray(rec.frames[0]) && rec.frames[0].length === 3);
  const r = replay(rec);
  assert.ok(r.ok, `hash differs at tick ${r.firstBad}`);
});

test('boss health scales with the party, and every player is in the snapshot', () => {
  startFight({ boss: 'atelier', seed: 1, players: party('duskblade', 'stormcaller') });
  assert.equal(G.boss.maxHp, Math.round(31000 * hpScale(2)));
  const s = snapshot();
  assert.equal(s.players.length, 2); assert.notEqual(s.players[0].id, s.players[1].id);
  assert.ok(Math.hypot(s.players[0].x - s.players[1].x, s.players[0].z - s.players[1].z) > 1, 'players spawn apart');
});

test('one player down is not a wipe; everyone down is', () => {
  startFight({ boss: 'atelier', seed: 2, players: party('duskblade', 'stormcaller') });
  tick();
  G.players[0].hurt(99999, { blockable: false, src: 'test' });
  assert.equal(G.players[0].alive, false); assert.equal(G.state, 'fight');
  G.players[1].hurt(99999, { blockable: false, src: 'test' });
  assert.equal(G.state, 'dead');
});

test('a hazard hits every player inside it and no one outside', () => {
  startFight({ boss: 'dummy', seed: 3, players: [{ cls: 'duskblade' }, { cls: 'stormcaller' }, { cls: 'hexslinger' }] });
  tick();
  const [a, b, c] = G.players; a.pos.set(0, 0, 10); b.pos.set(1, 0, 10); c.pos.set(8, 0, 10);
  Hz.circle(0, 10, 3, 0.1, 100);
  for (let i = 0; i < 6; i++) tick();
  assert.deepEqual(G.players.map((p) => p.maxHp - p.hp), [100, 100, 0]);
});

test('the bots of a four-player party kill Pentimento on Normal', () => {
  startFight({ boss: 'atelier', seed: 1, players: party('duskblade', 'stormcaller', 'duskblade', 'stormcaller') });
  for (let n = 30 * 600; n > 0 && !over(); n--) tick();
  assert.equal(G.state, 'win', `ended ${G.state} at ${G.ft.toFixed(0)} s, boss at ${(G.boss.hp / G.boss.maxHp * 100).toFixed(1)}%`);
  for (const p of G.players) assert.ok(p.stats.dmg > 0, 'every player dealt damage');
  assert.deepEqual(G.errors, []);
});

test('the training dummy never dies, meters each player, and lets people join, leave and change class', () => {
  startFight({ boss: 'dummy', seed: 1, players: party('duskblade') });
  for (let i = 0; i < 30 * 10; i++) tick();
  let m = snapshot().boss.pub.meter[G.players[0].id];
  assert.ok(m && m.total > 0 && m.dps > 40, 'meter: ' + JSON.stringify(m));
  G.boss.damage(G.boss.hp - 10, { src: 'test' }); tick();
  assert.equal(G.boss.alive, true); assert.ok(G.boss.hp > G.boss.maxHp * 0.5); assert.equal(G.state, 'fight');
  const p2 = addPlayer({ cls: 'stormcaller', bot: 3 });
  for (let i = 0; i < 30 * 5; i++) tick();
  assert.ok(snapshot().boss.pub.meter[p2.id].total > 0, 'the new player is metered');
  const id = G.players[0].id; swapClass(id, 'stormcaller');
  assert.equal(G.players[0].cls.id, 'stormcaller'); assert.equal(G.players[0].id, id);
  assert.equal(G.boss.state.meter[id], undefined, 'a class change starts a new meter');
  removePlayer(p2.id); tick();
  assert.equal(G.players.length, 1); assert.deepEqual(G.errors, []);
});
