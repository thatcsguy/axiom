# Threshold multiplayer: suggested approach

Written 2026-11-26 from a read of `threshold/src` at commit c33889f. Plan only, nothing built.

## The recommendation in one paragraph

Keep the simulation in JavaScript (moved to TypeScript), pull it out into a headless package with no Three.js and no browser globals, and run that same package in three places: a Node server (the authority), the browser client (to predict your own character), and the test tools (straight in Node, no browser). Fixed 30 Hz tick, WebSocket, one small server in US West, 2 to 4 players, room codes and no accounts. Solo play runs the same server code in a Web Worker in the page, so the game still works from a static site. Rebuild the engine once, then port fights one at a time, starting with Pentimento.

Do not rewrite in Rust, Go or C#. The valuable part of this codebase is 2 MB of boss scripts written as generator coroutines (`yield 1.5`, `yield* mechanic()`), plus the bots that play them. Those carry over to Node almost unchanged and to nothing else.

## 1. What the engine looks like today

**Better placed than most single-player games:**

- **Seeded sim randomness already exists.** `G.rng` is a mulberry32 stream; `rnd/pick/shuffle` use it; cosmetic randomness goes through a separate `vrand`. Only 3 boss files call `Math.random` directly (5 calls), which need checking.
- **The sim already runs without drawing.** `G.headless` is checked in about 300 places, `__game.fastForward` steps the whole game at a fixed 1/60 with no render, and every fight is rehearsed invisibly at 1/20 before it starts. So the sim is known to be stable at coarse fixed steps.
- **One sim entry point.** `G.step(dt)` runs `Co.update` and then the `Hooks.step` list (hazards, bullets, player, entities, boss). Boss files never read the real-time clock.
- **The bot is already a network client in disguise.** It drives the player only through `Input.bot = {moveX, moveZ}` and `p.press(slot)`. That is exactly the shape of an input message.
- **Coroutine timing is sound.** Waits carry their remainder (`c.wait += v`), so a script's timeline does not drift with step size.

**What is in the way:**

- **Variable time step.** A real frame steps the sim by the frame's own length (capped at 50 ms), so nothing is reproducible between machines. Easy fix: fixed tick.
- **Sim and picture share objects.** Positions are `THREE.Vector3`, every entity owns a `THREE.Group`, `Hz.add` attaches a decal, `p.hurt` calls `FX`, `Sound` and `UI` directly. Mechanical to separate in the engine files (about 130 KB of real engine: core, combat, player, classes, game).
- **Boss files are the real cost.** Each has 75 to 200 Three.js references, and one `b.state` object feeds both the rules and the custom animation in `update(b, dt)`. There is no automatic split. Each fight is a hand port into a rules half and a view half.
- **One player is assumed everywhere.** `G.player` appears 11 times in combat and 1 to 22 times in each boss file. Hazards, bullets, homing, targeting and "aim at the player" all read it.
- **Player reads the camera.** Movement is computed from `Input` and `Cam.yaw` inside `Player.update`. A few fights also turn `Cam.yaw` (turning floors).
- **Global slow motion.** `G.timeScale` is used for hit-stop on a parry and for a few boss moments. One player's parry cannot slow the world for four people.
- **Coroutines cannot be saved.** A running generator cannot be copied or serialised, so the server cannot rewind and the client cannot run boss scripts speculatively. This decides the netcode style (below).
- **Tests need a browser.** Nearly every tool is Playwright driving `window.__game`. Only the pure blocks (the gate solver behind `gatefuzz.js`) run in plain Node.

**Verdict:** the engine split is about two weeks of careful, mostly mechanical work. Each fight after that is two to five days depending on how tangled its visuals are and how much it needs rethinking for several players.

## 2. Architecture

**Layout (new repo, TypeScript, npm workspaces):**

- `sim/` : rules only. Math, RNG, `Co`, hazards, bullets, entities, boss runtime, player, classes, arena geometry, boss scripts, bots. No Three.js, no DOM.
- `client/` : Three.js renderer, FX, audio, camera, input, HUD, and each boss's view half.
- `server/` : Node, rooms, WebSocket, the tick loop.
- `tools/` : Node scripts that import `sim/` directly.

**How sim talks to the picture.** Three channels, and nothing else:

1. Entity state: position, facing, hp, cast bar, flags.
2. A small plain-data `pub` object per boss (phase, ramp step, which tiles are down, who is kneeling). The view half reads it. It is sent only when it changes.
3. One-shot cues: `cue('slam', {x, z})`. FX, sound, camera shake and damage numbers hang off cues.

Today's `if (!G.headless)` lines mark almost exactly where the cue calls go.

**Tick and clock.** Fixed 30 Hz sim on the server. The client renders at display rate and blends between ticks. If fast bullets tunnel at 30 Hz, go to 60; the replay test makes that a one-line experiment.

**Inputs.** Each tick the client sends: tick number, move vector in world space (the camera stays client-side), facing, held-slot bits, and any presses (slot, jump, target id). The server keeps a two-tick input buffer per player.

**What the client predicts.** Your own character only: movement, jump, dash, cast bar, global cooldown, cooldowns. The client runs the same `Player` step as the server, and on each server update rewinds to the server's state and replays the inputs the server has not seen yet. Damage numbers, boss health and gauge gains wait for the server.

**Other players and the boss** are drawn about 100 ms in the past, blended between updates.

**Dodge timing (the part that matters most).** Because coroutines cannot rewind, do not use lag compensation. Instead use the fact that every damage source in this game is announced in advance:

- A hazard is sent once, as "this shape, created at tick T, fires at tick T + delay". A bullet is sent once, as its spawn parameters.
- The client runs its clock slightly ahead of the server (by half the round trip), which is the standard trick that makes your inputs arrive just in time for the tick they were made for.
- So the telegraph fills and fires on your screen at the same tick the server judges it, against the position you actually had. Lag costs you a few tens of milliseconds of warning at the start of a telegraph, never a hit you visibly dodged.
- Parry, roll and shield windows are judged the same way, plus a 100 ms grace in the player's favour.
- Exceptions that fall back to plain updates: homing bullets aimed at someone else, and bullets with a custom `onUpdate`.

**Network.** WebSocket with MessagePack. WebRTC is not worth the setup for a telegraph-based co-op game; if stalls on bad Wi-Fi ever matter, WebTransport is the upgrade. Entities go as a full state every tick (a boss, four players and a few adds is tiny); hazards, bullets, cues and `pub` changes go as events.

**Latency target.** Feels right up to 120 ms round trip, playable to 200.

**Cheating.** This is a game for friends, so the server's job is agreement, not policing. Positions come from server-run movement and cooldowns are server-side anyway, which covers the obvious cheats for free. No further effort.

**Hosting.** One Node process on Fly.io or a small VPS in US West, one fight per room, all rooms in one process until that hurts. Client stays a static site.

## 3. What multiplayer changes in the design

These are my recommendations; all of them are yours to overrule.

- **Party size 1 to 4.** Solo stays a first-class mode on the same code.
- **No tank or healer roles.** Keep four self-sufficient classes with their own heals. A trinity would mean redesigning every class and fight.
- **No aggro table.** The boss picks targets by script: nearest, farthest, random, each player in turn, whoever was hit last. Add `b.pick...()` helpers to the framework so `G.player` never appears in a boss file.
- **Scaling.** Boss health roughly 0.9 x base x players, tuned by bot. Mechanics scale in count, not damage: one marker per player, one bait per pair.
- **Hits.** Every hazard and bullet checks every player. "Per-player" rules stay per-player: under Issen's Stillness, the one who swings eats the counter.
- **Death.** A downed player can be raised by a teammate standing on them for 3 s, three raises per fight on Normal, none on Nightmare. Everyone down is a wipe.
- **Cinematics.** The lock applies to everyone at once. Intro skip is the host's.
- **Slow motion.** Hit-stop becomes a client-only effect. Boss-driven slow motion stays, as a sim rate the server announces.
- **Turning floors and teleports** are the hard cases for prediction, because the server moves your character.

**Cost to carry over** (engine signals, not a design review):

| Cost | Fights | Why |
|---|---|---|
| Cheap | Molthar, Ossia, Thalassor, Anzu | Arena-wide patterns, baits, few player-specific hooks. Bait and hide mechanics get better with friends. |
| Medium | Parallax, Euryale, Oriko, Vesper, Zugzwang, Nian, Pentimento | Shared floor state to send, or rules about one player's facing or side that need a multi-player answer. Parallax's two colours are a natural co-op puzzle. |
| Expensive | Issen, Impresario, Janus, Garyo, Lady Fortuna, Ironjaw, Huntsman, Horologist | A duel or single-doll premise, teleports, floors that carry you, or one player tracing a figure. Each needs a real redesign, and Issen, Janus and Garyo are also the three largest files. |

Suggested first three: Pentimento (engine proof), Parallax (first real co-op puzzle), then one you love enough to redesign.

## 4. Roadmap

1. **Headless core, solo.** Extract `sim/` with Pentimento only, fixed tick, player driven by an input record. Milestone: a Node script plays the fight with the bot, and two runs with the same seed give the same state hash every tick.
2. **Client as a viewer.** The browser game runs `sim/` in a Web Worker and draws only from state, `pub` and cues. Milestone: Pentimento plays solo exactly as today. This is the proof that the split is clean, before any network exists.
3. **Server and many players.** Move the worker's code to Node behind a WebSocket; replace `G.player` with a player list; add target picks and scaling. Milestone: four bots as fake clients kill Pentimento on the server; two browsers can join by room code. No prediction yet.
4. **Prediction and the shared clock.** Milestone: with 150 ms of artificial lag, movement feels local and a recorded session shows no hit the client saw as a dodge.
5. **Lobby and the rest.** Room codes, class pick, ready check, raise, wipe and retry. Then fights, one at a time.

**Risks:**

- Boss ports take longer than hoped because rules and visuals are deeply interleaved. Step 2 measures this on one fight before you commit.
- Prediction against things that move the player (knockback, carry, teleport) produces rubber-banding. Avoid those fights early.
- Fights tuned for one player feel empty or chaotic with four. Expect a design pass per fight, not just a port.
- Hand-tuned Nightmare numbers will not survive scaling. Re-tune with the bots.

**First three concrete steps:**

1. Create the new repo with the workspace layout and bring over `01_core` (math, RNG, `Co`), `06_combat`, `07_player`, `08_classes` and `90_bot` with every Three.js, FX, Sound and UI call replaced by a cue.
2. Port Pentimento's rules half and write `tools/replay.js`: bot plays in Node, hashes state every tick, fails if two same-seed runs differ.
3. Build the Web Worker viewer for Pentimento and play it yourself.

## 5. Tooling to keep

All of it becomes faster, because it stops needing a browser.

- **Bots (`90_bot.js`, class `bot()`, boss `bot()` hints):** move into `sim/`. They are the fake clients for server tests and the load test, and the way to tune scaling for 1 to 4 players. Add a bot that plays with 150 ms of delay to check fairness under lag.
- **`sim.js`, `matrix.js`, `nmpace.js`:** become Node scripts. A fight that takes minutes in Playwright should run in seconds, so the class-by-fight-by-party-size matrix becomes affordable.
- **Fuzzers (`gatefuzz`, `moonfuzz`, `gardenfuzz`, `chessfuzz` and the rest):** keep them with the fights they belong to. The "must fail" blind bots (SWAPBLIND, SIDEBLIND, GARDENBLIND) are the best regression tests the game has.
- **`superdmg.js`, `nmphase.js`, `cinelock.js`, `stillcounter.js`:** rule checks, straight to Node.
- **New: the replay test.** Record seed plus every input, replay on the server build, compare hashes. It catches lost determinism, and a recorded session from a real game becomes a bug report you can re-run.
- **Stays in the browser:** screenshots, `nanscan`, `hitchscan`, the freeze log and warm-up. They test the renderer and move to `client/`.
