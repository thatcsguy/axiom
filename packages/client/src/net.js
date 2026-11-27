// The connection to the server, and the snapshot buffer the view draws from.
//
// The server sends one snapshot per sim tick. The view draws the world a little in the past (INTERP seconds), blending the
// two snapshots around that moment, so movement is smooth however the packets arrive. Your own character is drawn with less
// delay (SELF_INTERP), since you are steering it. Cues (hits, numbers, flashes) fire when the drawn moment reaches their tick,
// so they line up with what is on screen. No client prediction yet (docs/plan.md, step 4).
export const INTERP = 0.1, SELF_INTERP = 0.05;

export class Net {
  constructor(url, hello) {
    this.url = url; this.hello = hello; this.handlers = {}; this.snaps = []; this.cueQ = []; this.hz = 30;
    this.clock = null; // estimated server tick, as a float, advanced with real time and nudged by each snapshot
    this.rtt = 0; this.open = false; this.bytes = 0; this.closedByUs = false;
    this.connect();
  }
  on(t, fn) { (this.handlers[t] || (this.handlers[t] = [])).push(fn); return this; }
  emit(t, m) { for (const fn of this.handlers[t] || []) fn(m); }
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.onopen = () => { this.open = true; this.send(Object.assign({ t: 'hello', v: 2 }, this.hello)); this.emit('open'); this.pinger = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000); };
    ws.onclose = () => { this.open = false; clearInterval(this.pinger); this.emit('close'); };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      this.bytes += e.data.length; let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'snap') return this.onSnap(m);
      if (m.t === 'pong') { const r = (performance.now() - m.c) / 1000; this.rtt = this.rtt ? this.rtt * 0.7 + r * 0.3 : r; return; }
      if (m.t === 'start') { this.snaps = []; this.cueQ = []; this.clock = null; if (m.tickHz) this.hz = m.tickHz; }
      this.emit(m.t, m);
    };
  }
  close() { this.closedByUs = true; if (this.ws) this.ws.close(); }
  onSnap(m) {
    const s = m.s, now = performance.now() / 1000;
    if (this.snaps.length && s.tick <= this.snaps[this.snaps.length - 1].s.tick) { if (s.tick < this.snaps[0].s.tick - 5) { this.snaps = []; this.cueQ = []; this.clock = null; } else return; } // a new fight restarted the ticks
    this.snaps.push({ s, at: now }); if (this.snaps.length > 40) this.snaps.shift();
    for (const c of m.c) this.cueQ.push({ tick: s.tick, name: c[0], args: c[1], actor: c[2] === undefined ? null : c[2] });
    // the clock: aim at the newest tick, never jump backwards, close the gap gently
    if (this.clock === null || Math.abs(this.clock - s.tick) > this.hz) this.clock = s.tick;
    else this.clock += (s.tick - this.clock) * 0.1;
    this.lastAt = now;
    this.emit('snap', s);
  }
  advance(dt) { if (this.clock !== null) this.clock += dt * this.hz; }
  get latest() { return this.snaps.length ? this.snaps[this.snaps.length - 1].s : null; }
  // the two snapshots around tick t, and the blend between them
  at(t) {
    const L = this.snaps; if (!L.length) return null;
    if (t <= L[0].s.tick) return { a: L[0].s, b: L[0].s, k: 0 };
    for (let i = L.length - 1; i > 0; i--) if (L[i - 1].s.tick <= t) { const a = L[i - 1].s, b = L[i].s; if (t >= b.tick) return { a: b, b, k: 0 }; return { a, b, k: (t - a.tick) / Math.max(1, b.tick - a.tick) }; }
    return { a: L[L.length - 1].s, b: L[L.length - 1].s, k: 0 };
  }
  // cues whose tick the drawn moment has reached
  dueCues(t) { const out = []; while (this.cueQ.length && this.cueQ[0].tick <= t) out.push(this.cueQ.shift()); if (this.cueQ.length > 2000) this.cueQ.splice(0, this.cueQ.length - 2000); return out; }
}

// the server address: ?server=wss://host/ws, else this page's own host
export function serverUrl(qs) {
  const room = (qs.get('room') || 'main').toLowerCase();
  let base = qs.get('server');
  if (!base) base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  return base + (base.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(room);
}
