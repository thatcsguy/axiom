# Status

Last updated 2026-11-27. Plan step 1 (headless core, solo) is done for Pentimento; step 2 has a debug viewer.

## What is ported

From Threshold (`fun-stuff/threshold/src`, as of PR #87):

| Threshold file | Axiom | Notes |
| --- | --- | --- |
| `01_core.js` | `sim/src/core.js`, `math.js`, `rng.js` | `G`, `Co`, mulberry32 RNG (same numbers as Threshold), a minimal `Vec3` in place of `THREE.Vector3`. `G.tick` counts ticks. |
| `04_fx.js`, `05_audio.js`, UI, post | `sim/src/view.js` | Proxies that turn every call into a cue (`fx.burst`, `sound.sfx`, ...). `Cam` stays in the sim, because the cinematic lock is a rule; `Cam.shot` waits sim time. |
| `06_combat.js` | `sim/src/combat.js` | `Hz`, `Bul`, `Ent`, `Boss` with no meshes. Hazards, bullets and entities have ids. Bosses carry `pub` for viewers. |
| `07_player.js` | `sim/src/player.js` | Driven by `p.input` (world-space move, held bits, facing) instead of the keyboard. |
| `08_classes.js` | `sim/src/classes.js` | All four classes, generated from Threshold's file. Duskblade's parry hit-stop is a client-only `hitstop` cue now. |
| `90_bot.js` | `sim/src/bot.js` | Writes everything it does into the tick's input frame, so a bot fight replays from its frames alone. |
| `10_game.js` (stepping half) | `sim/src/fight.js` | `startFight(setup)`, `tick(frame)`, fixed 30 Hz (`tickHz` to change), intro played in sim time. Menus, records and the kill cinematic are client work. |
| `38_boss_atelier.js` | `sim/src/bosses/atelier.js` | Pentimento's rules: Normal and Nightmare "Chiaroscuro", every mechanic, the paint grid, the bot hints. Meshes, shaders and the paint texture are gone; strokes leave as `atelier.lay` cues. |

New in Axiom: `hash.js` (per-tick state hash), `snapshot.js` (plain-data picture for viewers), `replay.js`
(record and replay), `protocol` (frame sanitizer), `server/room.js` (one fight on a real-time loop with an input buffer).

## How it was checked

- **Determinism** (`npm test`): every class, Normal and Nightmare, a 150 s bot fight is recorded, then replayed from its
  frames without the bot; the state hash must match on every tick. The same fight with a cue listener attached must give
  the same hashes. Two same-seed bot runs must match; a different seed must not; changing a few input frames must be noticed.
- **Parity with Threshold** (`tools/parity.js`, not part of `npm test`): the same seeded bot fight in Threshold (in Chromium)
  and in Axiom (in Node, both at 60 Hz) compared every second on boss health and player position to 1e-6 m.
  Nightmare: all four classes identical for the whole fight. Normal: Duskblade and Ashwarden identical; Stormcaller split
  at 138 s and Hexslinger at 22 s. Both splits trace to one `Math.cos` result differing in its last bit between Chromium's
  and Node's V8, which tips a near-tie in the bot's choice of where to stand. The rules carried over unchanged.

## The boundary (what is not done)

- **One player.** `G.player` is still used throughout the sim, classes and boss. Plan step 3 replaces it with a list.
- **No network.** `server/room.js` takes frames through a method call. No WebSocket, no MessagePack yet.
- **No Three.js client.** `packages/client` is a 2D debug viewer, not Threshold's look. The view half of Pentimento
  (paint texture, roller mesh, Nightmare negative post-effect, intro shot framing) is not written.
- **One fight.** Molthar and the other 17 bosses are not ported. `docs/porting.md` says how.
- **Float determinism across engines is not guaranteed.** The same JavaScript engine gives the same fight every time,
  but Chromium and Node (or two V8 versions) can disagree in the last bit of `Math.sin` / `Math.cos`. A server-only
  authority does not care; client prediction (step 4) and replays across versions will. The fix, if needed, is a small
  deterministic trig module used by the sim in place of `Math`.
- **JavaScript, not TypeScript.** Deferred while the port is compared line by line with Threshold.

## Bot pace on Pentimento (Node, 60 Hz)

`GOD=1 node tools/sim.js atelier all 4 nm`: Hexslinger kills in about 3:45 to 4:10, Stormcaller 5:30 to 6:20,
Duskblade 5:15 to 6:10, Ashwarden mostly runs out of time. This matches what Threshold's own tools reported for the
Nightmare retune (PR #77).

## Next

1. The Three.js view half of Pentimento in the Worker client, drawing only from snapshot, `pub` and cues (plan step 2).
2. A player list in place of `G.player`, then WebSocket rooms with bots as fake clients (plan step 3).
3. Decide on deterministic trig before client prediction (plan step 4).
