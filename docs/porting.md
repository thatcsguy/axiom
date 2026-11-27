# Porting a Threshold boss

How Pentimento (`sim/src/bosses/atelier.js`) was brought over, written as rules for the next one.

## Split the file

A Threshold boss file mixes rules and looks. The sim gets the rules half only:

- **Keep**: phases, mechanics coroutines, hazards, bullets, adds, `state`, `update`, `danger`, `bot`, nightmare block.
- **Drop**: meshes, materials, shaders, textures, lights, music choice, the death cinematic, `def.icon`.
- **Turn into cues**: anything a player should see or hear that does not change the fight.
  `FX.*`, `Sound.*`, `Music.*`, `UI.*` and `Post.*` already emit cues through `view.js`, so most calls can stay as they are.
  For a boss-specific picture, emit your own: `View.cue('atelier.lay', shape)`.
- **Keep in the sim**: `Cam.shot` (it drives the cinematic lock). It waits sim time and emits a cue for the client camera.

`build(b)` returns the arena: `radius`, `edge` (`'wall'` or `'fall'`), `spawn`, `bossStart`, `contains`, `clamp`, plus
whatever rule state the boss needs. No scene objects.

## Rules that keep a fight deterministic

1. **Only `G.rng` (via `rnd`, `rndi`, `pick`, `shuffle`) for anything that changes the fight.** `vrand` (plain
   `Math.random`) is for cue payloads only.
2. **Never branch rules on `G.headless` or on whether a viewer is attached.** The determinism test runs each fight with and
   without a cue sink and fails if anything differs.
3. **Bot hints must not change hashed state.** Threshold's hints sometimes kept memory on the boss or called `p.jump()`.
   Put hint memory in `b.botMem` (not hashed, not replayed) and ask for a jump with `out.jump = true`.
4. **Time comes from `G.dt` / `G.now` / `G.ft` and coroutine waits.** No `performance.now()`, no `Date`.
5. **State that matters lives where the hash can see it**: on the boss's `state` object (walked deeply, typed arrays
   included), on entities, hazards and bullets. Anything under `pub`, `botMem`, `def`, `P` or `gen` is skipped.
6. **Viewer data goes in `b.pub`**: plain data the client reads to draw (phase step, which half is dark, paint level).
   Derive it from state each tick; never read it back in rules.
7. **Per-mechanic state resets in phase enter.** `Co.stopTag('phase')` skips a coroutine's cleanup, as in Threshold.

## Check it

1. `node tools/sim.js <id> all 4` and `... nm`: the bot should kill at about Threshold's pace.
2. Add the boss to the loop in `test/determinism.test.js`, then `npm test`.
3. `node tools/parity.js <id> all [nm]` against a fun-stuff checkout (see the header of `tools/parity.js` for setup).
   Matching to the end, or a split explained by a last-bit trig difference, means the rules came over unchanged.
4. Open the debug viewer with `?boss=<id>` and watch a bot fight.

## Bring its look over

Pentimento shows the way (`tools/import-atelier.js`, `client/src/atelier.js`):

1. **Import the view half unchanged.** Cut the boss file at markers (build and its helpers, the look half of `update` after
   `if (G.headless) return;`, the finale's look) into a generated module. Never hand-edit it; re-run the tool.
2. **Drive it from the server.** Each frame, fill the boss state the look reads from `pub` (blend anything that moves
   between the two snapshots), turn the boss's own cues into what its rules used to do to the picture (`atelier.lay` ->
   the stroke list), and call the imported update. Threshold's `G.player` there is the player the camera follows.
3. **Viewer-only sequences** (the kill cinematic, `def.death`) play on the client from the `fight.win` cue; the server's
   `win` state already locks everyone.
4. **Catch-up**: if the picture keeps history (paint, scorch, ice), give the def a read-only `catchup(b)`; the server sends
   it once to anyone who arrives mid-fight.
5. **Warm-up**: build every mesh up front, hidden; a material only created mid-fight (adds) gets a hidden copy at build so
   `Warm.run` compiles it. Check `view.info().compiledInFight` stays `[]` (tools/shots.js prints it).
6. Compare with Threshold from one fixed camera (`tools/atelier-compare.js` is the pattern).
