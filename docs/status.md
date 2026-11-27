# Status

Last updated 2026-11-27. A playable multiplayer prototype: a Node server, a Three.js browser client, rooms with a lobby,
1 to 4 players, Duskblade and Stormcaller, the Training Dummy and Pentimento. Plan steps 1 to 3 are done; step 4
(prediction) is not started.

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
(record and replay), `protocol` (messages and frame sanitizer), `bosses/dummy.js` (the Training Dummy), the server and the
client described below.

## How it was checked

- **Determinism** (`npm test`): every class, Normal and Nightmare, a 150 s bot fight is recorded, then replayed from its
  frames without the bot; the state hash must match on every tick. The same fight with a cue listener attached must give
  the same hashes. Two same-seed bot runs must match; a different seed must not; changing a few input frames must be noticed.
- **Parity with Threshold** (`tools/parity.js`, not part of `npm test`): the same seeded bot fight in Threshold (in Chromium)
  and in Axiom (in Node, both at 60 Hz) compared every second on boss health and player position to 1e-6 m.
  Nightmare: all four classes identical for the whole fight. Normal: Duskblade and Ashwarden identical; Stormcaller split
  at 138 s and Hexslinger at 22 s. Both splits trace to one `Math.cos` result differing in its last bit between Chromium's
  and Node's V8, which tips a near-tie in the bot's choice of where to stand. The rules carried over unchanged.

## Several players

- The sim keeps `G.players` (1 to 4; `G.player` is still `players[0]` for old tools). Damage is credited to `G.actor`.
  Bosses pick targets with `focusPlayer()` (the one he is facing) and `nextTarget()` (round robin, no RNG, so a solo fight
  is bit-identical to before: checked on per-second traces for all four classes, Normal and Nightmare, 240 s).
- Boss health scales `0.9 x players` from two players up (`hpScale` in `fight.js`); the dummy does not scale.
- A player at 0 health is down and the fight goes on; it is a wipe only when everyone is down.
- **Pentimento for a party:** each player wears their own paint (`pub.pw[id]`); strokes, splats and drips aim at
  players in turn; a Critique knocks him down only if every living player matches, and everyone who does not match takes
  the hit; the repair route is checked per player. Bot parties kill him: 2 players in about 3:20 to 4:00, 4 in 3:50 to 5:10.
- **Training Dummy** (`bosses/dummy.js`): a million health that refills, never attacks, keeps a per-player damage meter
  (DPS over the current burst, which ends 6 s after your last hit). Players can walk in and out and change class mid-fight.

## The server and client

- `npm start` runs one Node process: static files, `/healthz`, and a dependency-free WebSocket at `/ws`.
- **Rooms** (`?room=`, default `main`): a lobby of members (people, plus server bots from *Add a bot*). Starting
  Pentimento loads every member into the fight and locks the room; newcomers watch until it ends. The dummy stays open:
  newcomers walk in. A player who leaves a boss fight is taken over by the autopilot. Each running fight has its own
  worker thread.
- **Protocol** (`protocol/src/index.js`): JSON. Clients send input frames at 30 Hz (move, facing, held buttons, presses,
  target); the server sends a snapshot per tick (about 4.5 KB, about 130 KB/s per player on Pentimento) with that
  tick's cues. Loopback round trip under 1 ms, snapshot spacing p99 37 ms.
- **Client**: draws 100 ms in the past (your own character 50 ms), blending the two snapshots around that moment, and
  fires cues when the drawing reaches their tick. Threshold's hero models and animation code are imported unchanged
  (`tools/import-heroes.js`).
- **Pentimento's look is Threshold's own**, imported unchanged by `tools/import-atelier.js` into `client/src/atelier-look.js`
  (the view half of `38_boss_atelier.js`: the studio, the floor canvas with its stroke stamping and budgeted repaint job,
  every material and shader, the carved lay figure and its animation, the dish, aura, roller, Blots, varnish shell, contact
  shadows, the Nightmare finale's seam, split floor and wall, body tone and swirl). `client/src/atelier.js` drives it: each
  frame it fills Threshold's boss state from `pub` (blending the seam's angle, the roller and the swirl between snapshots),
  lays each `atelier.lay` cue, dries paint on the fight clock, and calls Threshold's `lookUpdate`. Axiom's additions:
  everyone's worn paint shows as Threshold's aura at their feet; the kill (Threshold's default kill on Normal, the
  "painting" kill on Nightmare) plays on the client from the `fight.win` cue (the server's `win` state is the lock); the
  varnish shell shows only while your side protects him (in Threshold that line sits inside a comment, so the shell shows
  all fight long: a Threshold bug, not carried over).
- **Catch-up**: a player who arrives mid-fight (a watcher) gets one `catchup` message with every stroke still on the canvas
  (`def.catchup(b)` in the sim, read only); the client lays them in one go and sets the grade of the phase now playing.
  Every new fight rebuilds the arena (a second Pentimento starts on a clean canvas).
- **Threshold's look** is imported unchanged by `tools/import-look.js` into `client/src/look.js` (and its HUD styles into
  `hud.css`): the shader math guard, the renderer and quality table, the post chain (NaN sanitize, bloom, colour grade,
  vignette, grain, flash, pulse, `Post.lerpTo` regrades), the whole FX library (GPU particles, rings, pillars, beams,
  lightning, slashes, domes, pooled lights, damage numbers, shake), the camera rig (orbit, 4 to 26 m zoom, cinematic
  blend, shake, keep-out-of-the-boss, occluder fade), the world helpers (procedural surfaces, sky, environment light,
  motes), the warm-up and the freeze log. A short prelude gives that code the globals it reads; `Look.frame` runs one frame
  as Threshold's main loop does. `view.js` feeds it: hero and boss stand-ins for the camera, cues into `FX` / `Post` /
  `Cam`, hazards drawn with Threshold's telegraph decal shader and bullets with its three instanced bullet shaders, from
  snapshots.
- **No shader compiles mid-fight**: on entering an arena the client builds everything (including one hidden hero per class,
  so a class change or a newcomer adds no program) and runs `Warm.run`; `view.info().compiledInFight` lists any program
  compiled after that (empty on the dummy solo and in a party, and on Pentimento through 30 s).
- **Screen-only cues are per player**: the server tags each cue with the acting player (`[name, args, actorId]`), and shake,
  flash, kick, hit-stop, the hurt vignette, slot flashes and your own damage numbers play only for their owner.
- **HUD** is Threshold's: boss frame with phase ticks and cast bar, enrage clock, target frame, player frame (health,
  shield, class pips, cast bar), the hotbar with its icons, cooldown sweeps, charges, ready and active marks, buffs, the hurt
  vignette. Party frames and the dummy meter are Axiom's own.
- **Screenshots**: `tools/shots.js` drives the real client against a real server (dummy solo for each class, a dummy party
  seen from one player, Pentimento: intro, Colour, the Negative, the kill, the Nightmare's colour, Chiaroscuro and its
  last ramp step, the varnish last blow, the Nightmare kill, and a watcher arriving 30 s in). `tools/atelier-compare.js`
  captures the same Pentimento moments in Threshold and Axiom from one fixed camera and writes them side by side.
  Both start fights through test hooks that only a server started with `test: true` accepts (start at a phase, god mode,
  skip the intro, and the `test` message: boss health, finale sitting, fight clock, kill). In the cloud it renders with SwiftShader; `TH_GPU=1` uses the installed
  Chrome on the graphics card. The GPU run has not been done yet.
- **Tests**: `test/server.test.js` runs the real server and real sockets: lobby, the dummy flow, four autopilots killing
  Pentimento with a spectator joining late, and "brain" fake clients that play from snapshots only. The client was
  checked in Chromium (Playwright, two players, dummy then Pentimento).

## The boundary (what is not done)

- **No client prediction.** Your own character moves when the server says so: fine on a LAN, sluggish over 100 ms+.
  Prediction needs the same trig on client and server (see below) and is plan step 4.
- **Only Duskblade and Stormcaller** are offered in the lobby. Ashwarden and Hexslinger are still in the sim.
- **No sound or music.** Sound cues arrive and are dropped.
- **No quality setting in the menu.** `?quality=high|med|low` picks Threshold's quality table entry.
- **JSON snapshots, full every tick.** Deltas or a binary format would cut bandwidth about tenfold when it matters.
- **One fight.** The other 18 bosses are not ported. `docs/porting.md` says how.
- **No accounts, no records, no reconnect.** A dropped player rejoins as a newcomer (and watches a locked fight).
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

1. Play it with real people over the internet (Fly.io or Render) and collect what feels wrong: input delay, camera,
   readability of Pentimento's paint at a distance.
2. Client prediction for your own movement and instant skills (plan step 4), with deterministic trig first.
3. Pentimento's sound from Threshold, then mechanic tweaks for parties.
