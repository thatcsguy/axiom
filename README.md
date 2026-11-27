# Axiom

Axiom is a server-authoritative multiplayer raid game. It grows out of **Threshold**, the single-player boss game in
[fun-stuff/threshold](https://github.com/thatcsguy/fun-stuff/tree/main/threshold): the same classes, the same boss rules
and the same engine, rebuilt so that a Node server runs the fight and every client is a view of it.

The playable prototype: open the page, pick **Duskblade** or **Stormcaller**, and either walk up to the **Training
Dummy** (anyone can join, change class, see a damage meter) or start **Pentimento** (boss id `atelier`, Normal or
Nightmare), which loads everyone in the room into the fight and locks the room until it ends.

The plan this repository follows is [docs/plan.md](docs/plan.md). Where the work stands is [docs/status.md](docs/status.md).
How to bring another Threshold boss over is [docs/porting.md](docs/porting.md).

## Play it locally

```sh
npm install        # links the workspace packages; nothing is downloaded
npm start          # the game server: open http://localhost:8080/ (share http://<your-ip>:8080/ on your network)
```

Everyone who opens the same address lands in the same room. `?room=name` picks another room (one fight per room,
several rooms at once), `?name=Ann` sets your name. No friends handy: `npm run bots -- 2` connects two fake players
(they play from snapshots, through the real socket), or press **Add a bot** in the lobby for a server-side autopilot.

Controls (Threshold's): WASD moves relative to the camera, hold the left mouse button to look, hold the right to look
and steer, wheel to zoom. 1 2 3 Q E R F are the class's skills, Space jumps, Tab or a click picks a target, Esc opens
the menu (change class on the dummy, let the autopilot play you, end the encounter).

## Host it

The server is one Node process with no dependencies that serves the client pages and the WebSocket (`/ws`) on the
same port. It reads `PORT` (default 8080) and `HOST`.

- **Fly.io**: `fly launch` in this folder picks up the `Dockerfile`; answer no to databases, then `fly deploy`.
  Keep one machine (`fly scale count 1`): rooms live in memory, so two machines would be two separate worlds.
- **Render**: a new *Web Service* from this repository, runtime Node, build `npm install`, start `npm start`.
  The free tier sleeps when idle and takes about a minute to wake.
- **Any VPS**: `npm install && PORT=80 npm start`, or the Dockerfile.

The client can also be served as static files (`npm run build` writes `dist/`, GitHub Pages ready) and pointed at a
server elsewhere with `?server=wss://your-server.example/ws`.

The page loads Three.js 0.170 from cdn.jsdelivr.net, so players need internet access even on a local server.

## Architecture

```
packages/
  sim/       headless fight simulation: no Three.js, no DOM, no audio. Runs in Node, a Web Worker or the browser.
             core (clock, coroutines, seeded RNG), combat (hazards, bullets, entities, bosses), player, the four classes,
             the autopilot bot, the fight driver (fixed 30 Hz tick, one input frame per player per tick, 1 to 4 players),
             a per-tick state hash, snapshots for viewers, record/replay. Bosses live in sim/src/bosses/
             (atelier = Pentimento, dummy = the Training Dummy).
  protocol/  the messages and input frame shared by client and server (docs at the top of its index.js), the sanitizer.
  server/    the game server: HTTP for the client files, a small WebSocket server (ws.js), rooms and their lobby
             (lobby.js), and one worker thread per running fight (fight-worker.js, runner.js) stepping the sim in real time.
  client/    the game page (index.html): lobby, Three.js view, HUD, controls. Threshold's hero models are imported
             unchanged by tools/import-heroes.js into src/heroes.js, and Threshold's look (post chain, FX, camera,
             world helpers, warm-up, freeze log, HUD styles) by tools/import-look.js into src/look.js and src/hud.css.
             debug.html is the older top-down debug viewer (the sim in a Web Worker, solo, no server).
tools/       command-line scripts: batch bot fights, record/replay, fake players, Threshold parity check, client build,
             the Threshold importers and browser screenshots.
test/        node --test suites: determinism, sim basics, several players, and the server end to end over real sockets.
```

The sim never draws. Everything Threshold did for looks (particles, sounds, music, screen effects, the paint on the
floor) leaves the sim as a named **cue** (`View.cue('fx.burst', ...)`). The server sends cues with each snapshot and the
client plays them when its drawing reaches that tick. Cues can never change the fight: the determinism tests run every
fight with and without a cue listener and compare.

A fight is a pure function of its setup (boss, classes, seed, difficulty) and its input frames. A recording is just
those, plus the state hash after every tick, so any recording replays exactly and also serves as a bug report.

Plain JavaScript (ES modules), no dependencies, Node 20 or newer.

## Other commands

```sh
npm test                    # determinism, sim, multiplayer and server tests (about 20 s)
npm run sim                 # bot fights: node tools/sim.js atelier all 4 [nm], or party:duskblade,stormcaller
npm run replay              # record a bot fight and replay it without the bot: node tools/replay.js selftest
npm run build               # static client in dist/
npm run heroes -- ../fun-stuff/threshold/src   # re-import the hero models after changing them in Threshold
npm run look -- ../fun-stuff/threshold/src     # re-import Threshold's look (post chain, FX, camera, world, warm-up, HUD css)
npm run shots -- shots [dummy|atelier]         # screenshots of the real client against a real server (Playwright)
TH_GPU=1 npm run shots -- shots-gpu            # the same with your installed Chrome on the graphics card
```

`tools/sim.js` reads `GOD=1` (no damage, pace only), `GODMODE=1` (hits land, health stays at 1 or more), `LEVEL=1..3`,
`SEED=n` and `HZ=n`. The debug viewer is at `/packages/client/debug.html` (`?class=`, `?nm=1`, `?seed=`, `?bot=3`).

## Roadmap

From [docs/plan.md](docs/plan.md):

1. **Headless core, solo.** Done for Pentimento.
2. **Client as a viewer.** Done: the Three.js client draws snapshots, `pub` and cues.
3. **Server and many players.** Done: WebSocket rooms, 1 to 4 players, target picks and scaling.
4. **Prediction and the shared clock.** Next: today your own character moves when the server says so.
5. **Lobby and the rest**, then more fights one at a time.
