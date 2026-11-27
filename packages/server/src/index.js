// The Axiom server, for now: one room, run in real time at the sim's tick rate, with the bot playing. It prints the fight
// once a second. No sockets yet (plan step 3 adds a WebSocket per client and the room code lobby).
//   node packages/server/src/index.js [boss] [class] [nm]      e.g.  npm run server -- atelier hexslinger nm
import { Room } from './room.js';

const [boss = 'atelier', cls = 'stormcaller', nm] = process.argv.slice(2);
const room = new Room({ boss, cls, nm: nm === 'nm' || nm === '1', bot: 3, seed: Date.now() & 0xffffff }).start();
console.log(`room up: ${boss} (${room.setup.nm ? 'nightmare' : 'normal'}), ${cls}, seed ${room.setup.seed}, ${room.hz} Hz`);
let lastPrint = 0;
room.listeners.add((r) => {
  if (r.tickNo - lastPrint < r.hz) return; lastPrint = r.tickNo;
  const s = r.snapshot(), b = s.ents.find((e) => e.boss);
  console.log(`t ${s.t.toFixed(0).padStart(4)}  ${s.state.padEnd(6)} boss ${(b.hp / b.maxHp * 100).toFixed(1).padStart(5)}%  phase ${s.boss.phase + 1}  you ${s.player.hp}/${s.player.maxHp}  hash ${r.hash().toString(16)}`);
});
room.run((r) => { const s = r.snapshot(); console.log(`fight over: ${s.state} at ${s.t.toFixed(1)} s`); process.exit(0); });
