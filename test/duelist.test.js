// Issen (duelist), solo for now: replays on every class and both modes, bot kills, the Counter on any hit that lands on a still
// Issen (or the still body in Niten, whoever was targeted), and the stopCast input the bot uses at the bell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G, record, replay, startFight, tick, over } from './_sim.js';
import { asActor } from '../packages/sim/src/core.js';

const CLASSES = ['duskblade', 'stormcaller', 'ashwarden', 'hexslinger'];
const idle = { mx: 0, mz: 0, held: 0, press: [] };

for (const nm of [false, true]) {
  for (const cls of CLASSES) {
    test(`Issen ${nm ? 'Nightmare' : 'Normal'}, ${cls}: a bot fight replays from its input frames`, () => {
      // Nightmare from phase 3 too, so Niten (two bodies, the storm, the swap) is in the recording on every class
      for (const phase of nm ? [0, 3] : [0]) {
        const rec = record({ boss: 'duelist', cls, seed: 1234, nm, phase, bot: 3, godMode: true }, phase ? 90 : 150);
        assert.deepEqual(rec.end.errors, [], 'the fight raised script errors');
        assert.ok(rec.frames.length > (phase ? 85 : 145) * 30 || rec.end.state === 'win', 'the fight ended too early: ' + rec.end.state + ' at ' + rec.end.ft.toFixed(1));
        const r = replay(rec);
        assert.ok(r.ok, `phase ${phase}: hash differs at tick ${r.firstBad} (fight ${r.ft && r.ft.toFixed(2)} s)`);
      }
    });
  }
}

test('Issen: the bot stops casting at the bell through its input frames, and a cue sink changes nothing', () => {
  const rec = record({ boss: 'duelist', cls: 'stormcaller', seed: 7, bot: 3, godMode: true }, 120);
  assert.ok(rec.frames.some((f) => f.stopCast), 'no stopCast frame in two minutes of Stillness');
  let cues = 0; const r = replay(rec, { sink: (name) => { if (name.startsWith('duelist.')) cues++; } });
  assert.ok(cues > 20, 'duelist cues: ' + cues);
  assert.ok(r.ok, 'hash differs at tick ' + r.firstBad + ' with cues on');
});

for (const nm of [false, true]) {
  test(`Issen ${nm ? 'Nightmare' : 'Normal'}: the bot kills him (god mode: hits land, health stays above 0)`, () => {
    startFight({ boss: 'duelist', cls: 'hexslinger', seed: 1, nm, bot: 3, godMode: true });
    for (let n = 30 * 600; n > 0 && !over(); n--) tick();
    assert.equal(G.state, 'win', `ended ${G.state} at ${G.ft.toFixed(0)} s, boss at ${(G.boss.hp / G.boss.maxHp * 100).toFixed(1)}%, phase ${G.boss.phase + 1}`);
    assert.deepEqual(G.errors, []);
    assert.ok(G.ft > (nm ? 240 : 180) && G.ft < (nm ? 400 : 330), 'kill time ' + G.ft.toFixed(0) + ' s (Threshold: about 4 min Normal, 5 min Nightmare)');
  });
}

test('Issen: a hit that lands on him while he is still counters the hitter', () => {
  startFight({ boss: 'duelist', cls: 'stormcaller', seed: 4, godMode: true }); // an idle player would die before he kneels
  const S = () => G.boss.state, p = G.players[0];
  for (let n = 0; n < 30 * 120 && !S().still; n++) tick(idle);
  assert.ok(S().still, 'he never went still');
  const taken = p.stats.taken; asActor(p, () => G.boss.damage(50, { src: 'player' }));
  assert.ok(S().countered, 'the hit did not set off the Counter');
  for (let i = 0; i < 15; i++) tick(idle);
  assert.ok(p.stats.taken - taken >= 380, 'the Counter did not land: ' + (p.stats.taken - taken));
});

test('Issen Nightmare, Niten: a hit on the still body counters, even with the other one targeted, and deals no damage', () => {
  startFight({ boss: 'duelist', cls: 'stormcaller', seed: 4, nm: true, phase: 3 });
  const S = () => G.boss.state, p = G.players[0];
  for (let n = 0; n < 30 * 60 && !(S().niten && S().R.live && (S().A.still || S().R.still)); n++) tick(idle);
  const still = S().A.still ? S().A : S().R, awake = still === S().A ? S().R : S().A;
  assert.ok(S().niten && still.still, 'Niten never began');
  for (let i = 0; i < 10; i++) tick(idle);
  p.target = awake.ent; const bossHp = G.boss.hp, hp0 = p.hp;
  const dealt = asActor(p, () => still.ent.damage(100, { src: 'player' }));
  assert.equal(dealt, 0); assert.equal(G.boss.hp, bossHp, 'the still body took damage');
  assert.ok(S().countered, 'the hit did not set off the Counter');
  for (let i = 0; i < 15; i++) tick(idle);
  assert.ok(p.hp < hp0, 'the Counter did not land');
});
