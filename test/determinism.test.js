// The determinism gate (docs/plan.md, roadmap step 1): a bot fight recorded as seed + input frames must replay to the same
// state hash on every tick, without the bot; two bot runs on one seed must be identical; attaching a cue sink (what a
// client does) must not change anything; and a different seed must give a different fight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, replay } from '@axiom/sim';
import '@axiom/sim/bosses';

const CLASSES = ['duskblade', 'stormcaller', 'ashwarden', 'hexslinger'];
const SEC = 150; // fight seconds per run: long enough to reach phase 2 (and the finale's first sitting on Nightmare)
// godMode (Threshold's Settings > Testing > God mode): every hit lands and shows, health never drops below 1, so runs last

for (const nm of [false, true]) {
  for (const cls of CLASSES) {
    test(`Pentimento ${nm ? 'Nightmare' : 'Normal'}, ${cls}: a bot fight replays from its input frames`, () => {
      const rec = record({ boss: 'atelier', cls, seed: 1234, nm, bot: 3, godMode: true }, SEC);
      assert.deepEqual(rec.end.errors, [], 'the fight raised script errors');
      assert.ok(rec.frames.length > SEC * 25, 'the fight ended too early to mean much: ' + rec.end.state + ' at ' + rec.end.ft.toFixed(1));
      const r = replay(rec);
      assert.ok(r.ok, `hash differs at tick ${r.firstBad} (fight ${r.ft && r.ft.toFixed(2)} s)`);
    });
  }
}

test('two bot runs on the same seed are identical, tick for tick', () => {
  const a = record({ boss: 'atelier', cls: 'stormcaller', seed: 99, nm: true, bot: 3 }, 120);
  const b = record({ boss: 'atelier', cls: 'stormcaller', seed: 99, nm: true, bot: 3 }, 120);
  assert.equal(a.hashes.length, b.hashes.length);
  const i = a.hashes.findIndex((h, k) => h !== b.hashes[k]);
  assert.equal(i, -1, 'first differing tick ' + i);
});

test('a cue sink (what a client attaches) never changes the fight', () => {
  const rec = record({ boss: 'atelier', cls: 'duskblade', seed: 5, nm: false, bot: 3 }, 120);
  let cues = 0;
  const r = replay(rec, { sink: () => { cues++; } });
  assert.ok(cues > 100, 'expected cues, got ' + cues);
  assert.ok(r.ok, 'hash differs at tick ' + r.firstBad + ' with cues on');
});

test('a different seed gives a different fight', () => {
  const a = record({ boss: 'atelier', cls: 'hexslinger', seed: 1, bot: 3 }, 30);
  const b = record({ boss: 'atelier', cls: 'hexslinger', seed: 2, bot: 3 }, 30);
  assert.notDeepEqual(a.hashes, b.hashes);
});

test('the replay notices a changed input', () => {
  const rec = record({ boss: 'atelier', cls: 'ashwarden', seed: 8, bot: 3, godMode: true }, 60);
  const k = rec.frames.findIndex((f, i) => i > rec.frames.length / 2 && f.mx);
  for (let i = k; i < k + 15; i++) rec.frames[i] = Object.assign({}, rec.frames[i], { mx: -(rec.frames[i].mx || 0.5), mz: -(rec.frames[i].mz || 0.5) });
  const r = replay(rec);
  assert.equal(r.ok, false); assert.ok(r.firstBad >= k && r.firstBad < k + 15, 'first bad tick ' + r.firstBad + ', changed from ' + k);
});
