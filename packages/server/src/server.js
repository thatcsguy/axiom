// The Axiom server: one Node process that serves the browser client as static files and runs the game over a WebSocket
// at /ws. One command for a local game (npm start), and the same process is what a host like Fly.io or Render runs.
//   startServer({ port, host, speed, intro, root }) -> Promise<{ port, server, rooms, close() }>
//   speed: sim seconds per real second (tests run fights fast); intro: play boss intros (default true); seed: fix every fight's seed (tests)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.js';
import { onConnection } from './lobby.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
// only the browser's half of the repository is served
const SERVED = ['/packages/client/', '/packages/sim/', '/packages/protocol/'];

export function startServer(o = {}) {
  const root = o.root || ROOT, state = { rooms: new Map(), socks: new Set(), speed: o.speed || 1, intro: o.intro !== false, seed: o.seed };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'); let p = decodeURIComponent(url.pathname);
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok ' + state.rooms.size + ' rooms\n'); }
    if (p === '/' || p === '/index.html') { res.writeHead(302, { Location: '/packages/client/' + url.search }); return res.end(); }
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!SERVED.some((s) => p.startsWith(s)) || !f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  attachWebSocket(server, { path: '/ws', onConnection: (sock, req, url) => onConnection(state, sock, url) });
  return new Promise((resolve) => server.listen(o.port === undefined ? 8080 : o.port, o.host, () => {
    resolve({ port: server.address().port, server, rooms: state.rooms, close: () => new Promise((r) => { for (const room of state.rooms.values()) room.stopFight(); for (const k of state.socks) k.close(1001, 'server stopping'); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) });
  }));
}
