// The sim, running in a Web Worker: plan step 2's "solo play runs the same code in a worker". It steps the fight at the
// sim's fixed tick on its own clock and posts a snapshot each tick. The page sends input; with the bot on, the bot plays.
import { startFight, tick, snapshot, currentFight, G, Bot } from '../../sim/src/index.js';
import '../../sim/src/bosses/index.js';

let input = { mx: 0, mz: 0, held: 0, press: [] }, presses = [], timer = null, gridT = 0, setup = null;

function grid() { // the paint for the debug view: pigment bits, +8 while wet (Pentimento only)
  const S = G.boss && G.boss.state; if (!S || !S.pig) return null;
  const out = new Uint8Array(S.pig.length); for (let k = 0; k < out.length; k++) out[k] = S.pig[k] | (S.dryAt[k] > G.ft ? 8 : 0); return out;
}
function start(s) {
  setup = s; startFight(s); const hz = currentFight().hz; clearInterval(timer); presses = [];
  timer = setInterval(() => {
    const f = Bot.level ? undefined : Object.assign({}, input, { press: presses.splice(0) });
    if (f && f.target === undefined) delete f.target;
    tick(f);
    const msg = { t: 'snap', s: snapshot() };
    if (--gridT <= 0) { gridT = 6; const g = grid(); if (g) msg.grid = g; }
    postMessage(msg, msg.grid ? [msg.grid.buffer] : []);
  }, 1000 / hz);
}
onmessage = (e) => {
  const m = e.data;
  if (m.t === 'start') start(m.setup);
  else if (m.t === 'input') { input = m.f; if (m.f.press) presses.push(...m.f.press); }
  else if (m.t === 'bot') { Bot.level = m.level; Bot.reset(); }
  else if (m.t === 'restart' && setup) start(setup);
};
