// node tools/replay.js record <out.json> [boss] [class] [seed] [nm]   bot plays a whole fight, writes seed + frames + hashes
// node tools/replay.js check <file.json>                             replays the frames without the bot, compares every tick
// node tools/replay.js selftest [boss] [class] [seed] [nm]           both in one go, nothing written
// Exit code 1 when a replay differs (prints the first tick that does).
import fs from 'node:fs';
import { record, replay } from '@axiom/sim';
import '@axiom/sim/bosses';

const [cmd = 'selftest', ...a] = process.argv.slice(2);
const setupOf = (b = 'atelier', cls = 'stormcaller', seed = '7', nm = '') => ({ boss: b, cls, seed: +seed, nm: nm === 'nm' || nm === '1', bot: 3, godMode: !!process.env.GODMODE });
const report = (rec, r) => {
  console.log(`${rec.setup.boss} ${rec.setup.nm ? 'nightmare' : 'normal'} ${rec.setup.cls} seed ${rec.setup.seed}: ${rec.end.state} at ${rec.end.ft.toFixed(1)} s, ${rec.frames.length} ticks`);
  console.log(r.ok ? `replay OK: all ${r.ticks} tick hashes match` : `REPLAY DIFFERS at tick ${r.firstBad} (fight ${r.ft.toFixed(2)} s): expected ${r.expected}, got ${r.got}`);
  if (!r.ok) process.exitCode = 1;
};
if (cmd === 'record') {
  const [out, ...rest] = a; if (!out) throw new Error('usage: record <out.json> [boss] [class] [seed] [nm]');
  const rec = record(setupOf(...rest)); fs.writeFileSync(out, JSON.stringify(rec));
  console.log(`wrote ${out}: ${rec.frames.length} ticks, ${rec.end.state} at ${rec.end.ft.toFixed(1)} s`);
} else if (cmd === 'check') {
  const rec = JSON.parse(fs.readFileSync(a[0], 'utf8')); report(rec, replay(rec));
} else if (cmd === 'selftest') {
  const rec = record(setupOf(...a)); report(rec, replay(rec));
} else { console.log('commands: record, check, selftest'); process.exitCode = 2; }
