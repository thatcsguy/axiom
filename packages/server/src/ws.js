// A small WebSocket server (RFC 6455), so the server needs no packages: the HTTP upgrade handshake, text and binary frames
// (masked from the client, as the spec requires), fragmented messages, ping / pong and close. No extensions (no
// permessage-deflate). Enough for a game for friends; swap in the `ws` package if this ever needs more.
//
//   attachWebSocket(httpServer, { path: '/ws', onConnection(sock, req) { sock.on('message', (text) => ...); sock.send('...') } })
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20; // 1 MB: input messages are tiny; anything bigger is a broken or hostile client

export class Sock extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket; this.open = true; this.buf = Buffer.alloc(0); this.parts = null; this.partOp = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  get buffered() { return this.socket.writableLength; }
  send(data) {
    if (!this.open) return false;
    const payload = typeof data === 'string' ? Buffer.from(data) : data;
    this.socket.write(frame(typeof data === 'string' ? 1 : 2, payload));
    return true;
  }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason), p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this.socket.write(frame(8, p)); this.socket.end(); } catch (e) { /* already gone */ }
    this.closed();
  }
  closed() { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch (e) { /* ignore */ } this.emit('close'); }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2); len = b.readUInt32BE(6); if (hi) return this.close(1009, 'too big'); off = 10; }
      if (len > MAX_MESSAGE) return this.close(1009, 'too big');
      if (!masked) return this.close(1002, 'unmasked client frame');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) { this.close(); return; }
      if (op === 9) { this.socket.write(frame(10, data)); continue; } // ping -> pong
      if (op === 10) continue;
      if (op === 0) { if (!this.parts) return this.close(1002, 'stray continuation'); this.parts.push(data); }
      else if (op === 1 || op === 2) { if (this.parts) return this.close(1002, 'interleaved message'); this.parts = [data]; this.partOp = op; }
      else return this.close(1002, 'bad opcode');
      if (fin) {
        const msg = Buffer.concat(this.parts); this.parts = null;
        if (msg.length > MAX_MESSAGE) return this.close(1009, 'too big');
        this.emit('message', this.partOp === 1 ? msg.toString('utf8') : msg);
      }
    }
  }
}

function frame(op, payload) {
  const n = payload.length; let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

export function attachWebSocket(server, { path = '/ws', onConnection }) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + accept, '', ''].join('\r\n'));
    onConnection(new Sock(socket), req, url);
  });
}
