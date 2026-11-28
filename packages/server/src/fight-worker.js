// A worker thread that runs one encounter in real time (one per running room: the sim is one fight per JavaScript realm).
// The lobby on the main thread sends it input and roster changes, and relays the snapshot message it posts every tick to
// the room's sockets as is (it is already a JSON string).
//
// In:  start { setup, speed } | go | input { key, f } | frames { key, k, fs } | auto { key, on } | join { entry } | leave { key } | swap { key, cls } | catchup { key } | test { ... } | stop
// Out: started { ids: [[key, simId]], hz, preview } | snap { data, own: [[key, json]] } | joined { key, you } | catchup { key, data } | end { result, ft, stats } | error { msg }
import { parentPort } from 'node:worker_threads';
import { FightRunner } from './runner.js';
import { G } from '@axiom/sim';

let run = null, timer = null, speed = 1;

function loop() {
  const ms = 1000 / (run.hz * speed); let next = performance.now();
  const wake = () => {
    if (!run) return;
    let n = 0; const now = performance.now();
    while (now >= next && n < 5 * speed) { run.step(); next += ms; n++; if (run.finished) break; }
    if (n) parentPort.postMessage({ t: 'snap', data: run.message(), own: run.own() }); // at speed > 1 (tests), one snapshot per wake
    if (run.finished) { const r = run; parentPort.postMessage({ t: 'end', result: r.result, ft: G.ft, stats: r.stats(), errors: G.errors.slice(0, 5) }); r.stop(); run = null; return; }
    if (now - next > 1000) next = now; // fell far behind (a paused process): skip ahead rather than racing
    timer = setTimeout(wake, Math.max(0, next - performance.now()));
  };
  wake();
}

parentPort.on('message', (m) => {
  try {
    if (m.t === 'start') {
      speed = m.speed || 1; run = new FightRunner(m.seed !== undefined ? Object.assign({ seed: m.seed }, m.setup) : m.setup).start();
      // the fight is set up but holds at its first tick until the lobby says go (every player's client has loaded it);
      // preview is that first moment, for the clients to build the arena from
      parentPort.postMessage({ t: 'started', ids: [...run.ids], hz: run.hz, seed: run.setup.seed, preview: run.preview() });
    } else if (!run) return;
    else if (m.t === 'go') { if (!timer) loop(); }
    else if (m.t === 'input') run.input(m.key, m.f);
    else if (m.t === 'frames') run.frames(m.key, m.k, m.fs);
    else if (m.t === 'auto') run.auto(m.key, m.on);
    else if (m.t === 'join') parentPort.postMessage({ t: 'joined', key: m.entry.key, you: run.join(m.entry) });
    else if (m.t === 'leave') run.leave(m.key);
    else if (m.t === 'test') run.test(m.o);
    else if (m.t === 'catchup') { const data = run.catchup(); if (data) parentPort.postMessage({ t: 'catchup', key: m.key, data }); }
    else if (m.t === 'swap') parentPort.postMessage({ t: 'joined', key: m.key, you: run.swap(m.key, m.cls) });
    else if (m.t === 'stop') { clearTimeout(timer); run.stop(); run = null; parentPort.close(); }
  } catch (e) { parentPort.postMessage({ t: 'error', msg: String(e && e.stack || e) }); }
});
