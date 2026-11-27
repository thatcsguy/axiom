// node tools/netsim.js [--lag 60] [--jitter 20] [--loss 1] [--port 8090] [--upstream http://127.0.0.1:8080]
//
// A bad network between a browser and an Axiom server, for testing how the game feels. It serves the client and relays the
// WebSocket, delaying every message: half the round trip (lag) each way, plus or minus jitter, and a lost message (loss %)
// waits for a retransmit (max(200 ms, lag)) and holds up everything behind it. That is what a WebSocket over TCP does: it
// never drops or reorders, it stalls. Works with any build of the client (no help from the page), so before / after
// comparisons are fair. Open http://localhost:<port>/?room=... in the browser instead of the server's own port.
//
// The client also has the same simulator built in (?lag=60&jitter=20&loss=1), for a quick try without a second process.
//   import { startNetsim } from './netsim.js'; const s = await startNetsim({ upstream, lag, jitter, loss, port: 0 })
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from '../packages/server/src/ws.js';

export function lineDelay(o) {
  const q = { last: 0 }, one = (o.lag || 0) / 2, j = o.jitter || 0, rto = Math.max(200, o.lag || 0);
  // the time at which the next message on this direction is delivered (ms, performance.now clock)
  return () => {
    const now = performance.now(); let at = now + Math.max(0, one + (Math.random() * 2 - 1) * j);
    if (o.loss && Math.random() * 100 < o.loss) at += rto;
    at = Math.max(at, q.last); q.last = at; return at - now;
  };
}

export function startNetsim(o = {}) {
  const up = new URL(o.upstream || 'http://127.0.0.1:8080'), line = { lag: o.lag || 0, jitter: o.jitter || 0, loss: o.loss || 0 };
  const server = http.createServer((req, res) => { // static files: passed through untouched
    const pr = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    pr.on('error', () => { res.writeHead(502); res.end('upstream down'); }); req.pipe(pr);
  });
  const socks = new Set();
  attachWebSocket(server, { path: '/ws', onConnection(sock, req) {
    const toUp = lineDelay(line), toDown = lineDelay(line), pend = [];
    const ws = new WebSocket('ws://' + up.host + req.url); socks.add(sock);
    ws.onopen = () => { for (const m of pend.splice(0)) ws.send(m); };
    ws.onmessage = (e) => { const d = e.data; setTimeout(() => { if (sock.open) sock.send(d); }, toDown()); };
    ws.onclose = () => sock.close(); ws.onerror = () => sock.close();
    sock.on('message', (d) => { const s = String(d); setTimeout(() => { if (ws.readyState === 1) ws.send(s); else if (ws.readyState === 0) pend.push(s); }, toUp()); });
    sock.on('close', () => { socks.delete(sock); try { ws.close(); } catch (e) { /* gone */ } });
  } });
  return new Promise((resolve) => server.listen(o.port === undefined ? 8090 : o.port, o.host || '127.0.0.1', () => resolve({
    port: server.address().port, line,
    close: () => new Promise((r) => { for (const k of socks) k.close(1001); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const s = await startNetsim({ upstream: arg('upstream', 'http://127.0.0.1:8080'), lag: +arg('lag', 60), jitter: +arg('jitter', 20), loss: +arg('loss', 1), port: +arg('port', 8090), host: arg('host', '127.0.0.1') });
  console.log(`netsim: http://localhost:${s.port}/  ->  ${arg('upstream', 'http://127.0.0.1:8080')}  (${s.line.lag} ms round trip, +-${s.line.jitter} ms, ${s.line.loss}% loss)`);
}
