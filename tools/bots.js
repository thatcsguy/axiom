// node tools/bots.js [count] [url]   (npm run bots)  connect fake players to a running server, through the real socket.
// Each one joins the room, takes a class in turn (Duskblade, Stormcaller) and plays from snapshots alone (tools/fake-client.js).
// They follow whoever starts an encounter in the browser. Ctrl+C to drop them.
//   node tools/bots.js 3 ws://localhost:8080/ws?room=main
//   AUTO=1 node tools/bots.js 2 ...   the server's autopilot plays them instead (better at Pentimento's paint)
import { fakeClient } from './fake-client.js';

const n = Math.max(1, Math.min(3, +(process.argv[2] || 1))), url = process.argv[3] || 'ws://localhost:8080/ws?room=main';
const CLS = ['stormcaller', 'duskblade'], auto = process.env.AUTO === '1';
for (let i = 0; i < n; i++) {
  const c = await fakeClient(url, { name: 'Fake ' + (i + 1), cls: CLS[i % 2], brain: !auto, auto });
  c.ws.addEventListener('close', () => { console.log('Fake ' + (i + 1) + ' disconnected'); });
}
console.log(`${n} fake player${n > 1 ? 's' : ''} in ${url}${auto ? ' (autopilot)' : ''}. Start an encounter from the browser.`);
