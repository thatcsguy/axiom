# Axiom

Axiom is a server-authoritative multiplayer raid game. It grows out of **Threshold**, the single-player boss game in
[fun-stuff/threshold](https://github.com/thatcsguy/fun-stuff/tree/main/threshold): the same classes, the same boss rules
and the same engine, rebuilt so that a Node server runs the fight and every client is a view of it.

The first fight ported is **Pentimento** (boss id `atelier`), Normal and Nightmare.

The plan this repository follows is [docs/plan.md](docs/plan.md). Where the work stands is [docs/status.md](docs/status.md).
How to bring another Threshold boss over is [docs/porting.md](docs/porting.md).

## Architecture

```
packages/
  sim/       headless fight simulation: no Three.js, no DOM, no audio. Runs in Node, a Web Worker or the browser.
             core (clock, coroutines, seeded RNG), combat (hazards, bullets, entities, bosses), player, the four classes,
             the autopilot bot, the fight driver (fixed 30 Hz tick, one input frame per tick), a per-tick state hash,
             snapshots for viewers, record/replay. Bosses live in sim/src/bosses/.
  protocol/  the messages and input frame shared by client and server, and the server-side frame sanitizer.
  server/    a Node room that owns one fight, buffers client input frames by tick and steps the sim in real time.
             No sockets yet.
  client/    a debug viewer: the sim runs in a Web Worker, the page draws a top-down 2D picture of the snapshot.
             The real Three.js client (Threshold's look) is the next big piece of work.
tools/       command-line scripts: batch bot fights, record/replay, Threshold parity check, static server, client build.
test/        node --test suites: determinism (record a fight, replay it, every tick's hash must match) and sim basics.
```

The sim never draws. Everything Threshold did for looks (particles, sounds, music, screen effects, the paint on the
floor) leaves the sim as a named **cue** (`View.cue('fx.burst', ...)`), which a client may draw and a server ignores.
Cues can never change the fight: the determinism tests run every fight with and without a cue listener and compare.

A fight is a pure function of its setup (boss, class, seed, difficulty) and its input frames. A recording is just those,
plus the state hash after every tick, so any recording replays exactly and also serves as a bug report.

Plain JavaScript (ES modules), no dependencies, Node 20 or newer. The plan suggested TypeScript; it is deferred so the
ported code stays line-for-line comparable with Threshold while the port is checked.

## Running it

```sh
npm install                 # links the workspace packages; nothing is downloaded
npm test                    # determinism and sim tests (about 15 s)
npm run sim                 # bot fights against Pentimento, all classes: node tools/sim.js atelier all 4 [nm]
npm run replay              # record a bot fight and replay it without the bot: node tools/replay.js selftest
npm run server              # a demo room in the terminal: the bot plays, one status line per second
npm run dev                 # static server, then open http://localhost:8080/ for the debug viewer
npm run build               # copies the client and the packages it loads into dist/ (GitHub Pages ready)
```

Debug viewer controls: WASD to move (up is north), 1 2 3 Q E R F for the class's skills, Space to jump, Tab to change
target, B to switch the bot on or off. URL options: `?class=hexslinger`, `?nm=1`, `?seed=5`, `?bot=3`, `?skipintro`.

`tools/sim.js` reads `GOD=1` (no damage, pace only), `GODMODE=1` (hits land, health stays at 1 or more), `LEVEL=1..3`,
`SEED=n` and `HZ=n`.

## Roadmap

From [docs/plan.md](docs/plan.md):

1. **Headless core, solo.** Done for Pentimento (the plan named Molthar; Patrick picked Pentimento first).
2. **Client as a viewer.** The sim already runs in a Web Worker behind a debug viewer; the Three.js view half of
   Pentimento, drawing only from state, `pub` and cues, is next.
3. **Server and many players.** WebSocket rooms, a player list in place of `G.player`, target picks and scaling.
4. **Prediction and the shared clock.**
5. **Lobby and the rest**, then more fights one at a time.
