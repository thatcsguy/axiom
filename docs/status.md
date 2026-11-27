# Status

Last updated 2026-11-27. A playable multiplayer prototype: a Node server, a Three.js browser client, rooms with a lobby,
1 to 4 players, Duskblade and Stormcaller, the Training Dummy, Pentimento and Issen (solo for now). Plan steps 1 to 4 are done (step 4:
your own character is predicted, the world runs on a synced clock; see "Prediction and the shared clock").

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
| `22_boss_duelist.js` | `sim/src/bosses/duelist.js` | Issen's rules: Normal and Nightmare (the lake, Niten with Blade and Storm, the Moons, Twin Final Verse, The Last Petal), the Stillness Counter on any hit that lands on a still body (PR #87), the bot hints. Solo for now (`maxPlayers: 1`). The cuts, the Moons' arcs, swings and regrades leave as `duelist.*` cues. |

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
- **Issen** (`test/duelist.test.js`): replays on every class, Normal and Nightmare (and Nightmare from Niten), bot kills on
  both modes, the Counter on a hit that lands on a still Issen and on the still body in Niten while the other is targeted,
  and the bot's `stopCast` frames at the bell. Parity with Threshold (30 Hz): Normal Duskblade and Ashwarden identical to
  the kill, Stormcaller split at 158 s and Hexslinger at 178 s; Nightmare identical up to Niten's entry (its cinematic
  lock, see "The boundary"), except one Stormcaller run that split at 55 s on an exact tie in the bot's scoring. The same last-bit cause.
- **`stopCast`** is a new input-frame field (the bot stops a planted cast at Issen's bell through it, so it replays).

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
- **Protocol** (`protocol/src/index.js`): JSON. The browser sends one input frame per tick (move, facing, held buttons,
  presses, target), stamped with the tick it is for; the server sends a snapshot per tick (about 4.5 KB, about 130 KB/s
  per player on Pentimento) with that tick's cues, and each player's copy also carries their own character's whole state.
  Loopback round trip under 1 ms, snapshot spacing p99 37 ms.
- **Client**: your character is predicted (below); everything else is drawn a little in the past, blending the two
  snapshots around that moment, and cues fire when the drawing reaches their tick. Threshold's hero models and
  animation code are imported unchanged (`tools/import-heroes.js`).
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
- **Issen's look is Threshold's own** too, imported unchanged by `tools/import-duelist.js` into `client/src/duelist-look.js`
  (the lake and deck, the hero-rig costume and its animation, cut ribbons, ghost silhouettes, petal orbs, the calm-place
  streaks, the sunset/nightfall regrades, the reflection rising out of the lake, the Lighthouse Storm's eye, the Nightmare
  kill `nitenDeath`, about 7.5 s, so the def's `winHold` keeps the win on screen 9 s). `client/src/duelist.js` drives it from `pub` (ghosts, lanes, the two bodies' poses, the storm, the
  regrade levels) and the `duelist.*` cues. A watcher catches up from `pub` alone (the regrades jump to the phase now
  playing). The reflection's body shares Issen's health (`ow` in the snapshot), so the target frame shows his health.
- **Solo fights**: a def with `maxPlayers` takes that many members, the one who pressed start first; the rest watch with a
  note saying why. The lobby marks such a boss `solo`.
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

## Prediction and the shared clock (plan step 4)

Patrick's ask (2026-11-27): make it feel client-controlled. What the client does now:

- **Your character is predicted from the sim's own Player code** (`sim/src/predict.js`, `client/src/self.js`). The page
  runs a small world in its main thread: one real Player of your class and stand-ins for the boss and adds. Each 30 Hz
  tick samples your keys into a frame stamped with that tick, steps the predictor and sends the frame (with the two before
  it). Movement, jumps, Lunge, Blink, the cast bar, the global cooldown, cooldowns and charges, resources your own skills
  give, buffs, "out of range" and the hotbar's usable state all answer on the frame you press. The server applies each
  frame on its own tick (`runner.js`, an input buffer per player); a frame too late for its tick has its presses applied
  on the next one.
- **Reconciliation:** each snapshot carries your character's whole state at its tick (`ownState`, full precision, only in
  your copy). The predictor takes it and replays the frames the server has not answered. Where nothing in the world
  touched you the replay lands exactly on the prediction: `test/predict.test.js` checks every tick of a 40 s fight for all
  four classes on the dummy (exact), Pentimento (98% of windows exact; the rest are hits, paint and the boss turning), and
  `test/prediction-server.test.js` checks it over the real server and sockets. Where it does not, the drawn position keeps
  the difference as an offset that fades in about 0.1 s (more than 3 m is taken at once); a cast moved in time fades the same way.
- **Immediate feedback:** cues your own skills raise (swings, slashes, lightning, the heal number) play from the
  prediction. The server's copies (same cue, within 4 ticks) are dropped; everything else it raises for you (damage
  numbers, a parry, hits on you) plays in step with the world. Damage numbers wait for the server on purpose.
- **Clock sync:** `serverNow()` = arrival time x 30 + the best (least delayed) offset of the last 4 s. A faster path is
  believed at once, a slower one only by a slow slew.
- **Adaptive jitter buffer:** the world is drawn at `renderTick`, behind `serverNow()` by one snapshot interval plus the
  90th percentile of arrival spread (50 to 300 ms; it grows quickly and shrinks slowly). The render clock runs on real time
  and is steered by at most 8% speed, never jumping. Boss and target cast bars are computed from that clock and the cast's
  start tick, so they run smoothly at any frame rate. The predicted clock runs ahead by a `lead` that follows the server's
  report of how early frames arrive (`me.ia`), steered by at most 6% speed.
- **Network overlay:** F3 (or backquote, or `?net=1`): ping, jitter, snapshots per second, kB/s, how far behind the world
  is drawn, how far ahead you are predicted, how early your inputs arrive (late frames, missed ticks), and the size of
  corrections (now, last, max over 5 s; cast corrections in ms).
- **A bad line on demand:** `?lag=120&jitter=20&loss=1` in the page (round trip ms, +- ms each way, % loss as a TCP
  stall), or `node tools/netsim.js --lag 60 --jitter 20 --loss 1 --upstream http://127.0.0.1:8080` as a proxy on :8090.
- **Measured** with `tools/netfeel.js` (two browsers, Ann casting Bolt and walking, Ben walking and slashing, Pentimento,
  god mode, through the proxy at 60 ms +- 20 ms and 1% loss; SwiftShader, so about 9 frames a second). Results are in the
  PR that brought this (#7). `--repo <checkout>` measures another build the same way.
- Not predicted: anything the world does to you (hits, knockback, paint slowing you, the cinematic lock starting), other
  players, the boss. Lag compensation is not used, on purpose (plan: hazards are announced in advance; coroutines cannot
  rewind). The Stormcaller's next glowing Static slot is drawn from the fight's RNG, so after a Discharge the prediction
  may show the wrong "next" pip for one round trip.

## The boundary (what is not done)

- **Prediction is your own character only.** Telegraphs and bullets are drawn in the past with the rest of the world;
  the plan's "announce hazards with their fire tick and draw them on the predicted clock" is not done.
- **Only Duskblade and Stormcaller** are offered in the lobby. Ashwarden and Hexslinger are still in the sim.
- **No sound or music.** Sound cues arrive and are dropped.
- **No quality setting in the menu.** `?quality=high|med|low` picks Threshold's quality table entry.
- **JSON snapshots, full every tick.** Deltas or a binary format would cut bandwidth about tenfold when it matters.
- **Two fights.** The other 17 bosses are not ported. Issen is solo: his co-op version comes later. `docs/porting.md` says how.
- **Issen's Niten entry differs from Threshold's headless tools**: Threshold played that cinematic only with a screen, so
  its headless bot fights skipped the lock; Axiom always plays it (it is a rule here). Parity with Threshold's tools holds
  to Niten and not past it.
- **No accounts, no records, no reconnect.** A dropped player rejoins as a newcomer (and watches a locked fight).
- **Float determinism across engines is not guaranteed.** The same JavaScript engine gives the same fight every time,
  but Chromium and Node (or two V8 versions) can disagree in the last bit of `Math.sin` / `Math.cos`. A server-only
  authority does not care; client prediction only sees it as a correction of a fraction of a millimetre, which the
  fading offset hides. Replays across versions would care. The fix, if needed, is a small deterministic trig module.
- **JavaScript, not TypeScript.** Deferred while the port is compared line by line with Threshold.

## Bot pace on Pentimento (Node, 60 Hz)

`GOD=1 node tools/sim.js atelier all 4 nm`: Hexslinger kills in about 3:45 to 4:10, Stormcaller 5:30 to 6:20,
Duskblade 5:15 to 6:10, Ashwarden mostly runs out of time. This matches what Threshold's own tools reported for the
Nightmare retune (PR #77).

## Bot pace on Issen (Node, 30 Hz)

`GODMODE=1 node tools/sim.js duelist all 2` (hits land, health stays above 0): Normal kills in 3:39 to 4:13, Nightmare
4:38 to 5:38 (Duskblade the slowest), as in Threshold. Without god mode the bot often dies on Normal (Moons and Draw
Cuts) and wins some Nightmare runs: he is a hard duel.

## Next

1. Play it with real people over the internet (Fly.io or Render) and collect what feels wrong: input delay, camera,
   readability of Pentimento's paint at a distance.
2. Feel it on a real line (Fly.io or Render) with the F3 overlay on; tune the render delay and lead limits from that.
3. Pentimento's sound from Threshold, then mechanic tweaks for parties.
