// The connection to the server, the snapshot buffer the view draws from, and the shared clock.
//
// Clock sync: every snapshot carries the server's tick. arrival time x tick rate - tick is the snapshot's delay plus a constant
// (the two clocks' offset); the smallest delay of the last few seconds is the freshest the server's picture can be, so
// serverNow() = now x hz + the best offset seen is "the newest tick that could have reached us by now". A faster path is
// believed at once; a slower one only by a slow slew, so one late packet never moves it.
//
// Jitter buffer: other players, the boss, hazards and bullets are drawn at renderTick, a little behind serverNow(). How far
// behind adapts to the measured spread of arrival times (the 90th percentile of the last few seconds, plus one snapshot
// interval), from 50 ms on a quiet line up to 300 ms on a bad one. renderTick runs on real time and is steered toward its
// target by speeding up or slowing down at most 8%, so the world never jumps when the estimate moves. Cues (hits, numbers,
// flashes) fire when renderTick reaches their tick, in step with what is drawn. Your own character is predicted instead
// (self.js): it runs ahead of the server, not behind.
//
// Network simulator (for testing feel without a bad line): ?lag=<ms round trip>&jitter=<ms each way>&loss=<percent>.
// It models a WebSocket over TCP: messages stay in order, and a lost one holds up everything behind it for a retransmit
// (max(200 ms, round trip)), which is what loss looks like to a browser game.
export const MIN_DELAY = 1.5, MAX_DELAY = 9; // render delay limits, in ticks (50 ms to 300 ms at 30 Hz)

export class Net {
  constructor(url, hello, sim) {
    this.url = url; this.hello = hello; this.handlers = {}; this.snaps = []; this.cueQ = []; this.hz = 30;
    this.sim = sim && (sim.lag || sim.jitter || sim.loss) ? sim : null; this.qIn = 0; this.qOut = 0;
    this.renderTick = null; this.off = null; this.samples = []; this.delay = 3; this.jitter = 0;
    this.rtt = 0; this.rttMin = 0; this.open = false; this.bytes = 0; this.closedByUs = false; this.cueFilter = null; this.arrivals = [];
    this.connect();
  }
  on(t, fn) { (this.handlers[t] || (this.handlers[t] = [])).push(fn); return this; }
  emit(t, m) { for (const fn of this.handlers[t] || []) fn(m); }
  // the simulated line: one direction's next delivery time (in order; a loss stalls the queue for a retransmit)
  delayed(dir, fn) {
    const s = this.sim, now = performance.now(), one = (s.lag || 0) / 2, j = s.jitter || 0;
    let at = now + Math.max(0, one + (Math.random() * 2 - 1) * j);
    if (s.loss && Math.random() * 100 < s.loss) at += Math.max(200, s.lag || 0);
    const k = dir === 'in' ? 'qIn' : 'qOut'; at = Math.max(at, this[k]); this[k] = at;
    setTimeout(fn, at - now);
  }
  send(m) {
    if (!this.ws || this.ws.readyState !== 1) return; const d = JSON.stringify(m);
    if (this.sim) this.delayed('out', () => { if (this.ws.readyState === 1) this.ws.send(d); }); else this.ws.send(d);
  }
  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.onopen = () => { this.open = true; this.send(Object.assign({ t: 'hello', v: 2 }, this.hello)); this.emit('open'); this.ping(); this.pinger = setInterval(() => this.ping(), 1000); };
    ws.onclose = () => { this.open = false; clearInterval(this.pinger); this.emit('close'); };
    ws.onerror = () => {};
    ws.onmessage = (e) => { if (this.sim) this.delayed('in', () => this.receive(e.data)); else this.receive(e.data); };
  }
  ping() { this.send({ t: 'ping', c: performance.now() }); }
  receive(data) {
    this.bytes += data.length; let m; try { m = JSON.parse(data); } catch (err) { return; }
    if (m.t === 'snap') return this.onSnap(m);
    if (m.t === 'pong') { const r = (performance.now() - m.c) / 1000; this.rtt = this.rtt ? this.rtt * 0.7 + r * 0.3 : r; this.rttMin = this.rttMin ? Math.min(this.rttMin * 1.002, r) : r; return; }
    if (m.t === 'start') { this.snaps = []; this.cueQ = []; this.renderTick = null; this.off = null; this.samples = []; if (m.tickHz) this.hz = m.tickHz; }
    if (m.t === 'catchup') this.cueQ = this.cueQ.filter((c) => !(c.name === 'atelier.lay' && c.tick <= m.tick)); // already in the catch-up
    this.emit(m.t, m);
  }
  close() { this.closedByUs = true; if (this.ws) this.ws.close(); }
  onSnap(m) {
    const s = m.s, now = performance.now() / 1000;
    if (this.snaps.length && s.tick <= this.snaps[this.snaps.length - 1].s.tick) { if (s.tick < this.snaps[0].s.tick - 5) { this.snaps = []; this.cueQ = []; this.renderTick = null; this.off = null; this.samples = []; } else return; } // a new fight restarted the ticks
    this.snaps.push({ s, at: now }); if (this.snaps.length > 60) this.snaps.shift();
    this.arrivals.push(now); while (this.arrivals.length && this.arrivals[0] < now - 1) this.arrivals.shift();
    this.sample(s.tick, now);
    if (m.me) this.emit('own', { me: m.me, s }); // your own character's state, for prediction (before its cues are sorted)
    for (const c of m.c) { const q = { tick: s.tick, name: c[0], args: c[1], actor: c[2] === undefined ? null : c[2] }; if (!this.cueFilter || this.cueFilter(q)) this.cueQ.push(q); }
    if (this.renderTick === null) this.renderTick = this.serverNow() - this.delay;
    this.emit('snap', s);
  }
  // clock sync: o = tick - arrival x hz, kept for 4 s; the best (largest) is the least-delayed path
  sample(tick, now) {
    const o = tick - now * this.hz, L = this.samples; L.push({ o, at: now }); while (L.length && L[0].at < now - 4) L.shift();
    let best = -Infinity; for (const q of L) if (q.o > best) best = q.o;
    // a faster path is taken at once (nothing arrives sooner than the truth allows); a slower one (the fast sample left the
    // window) only by a slow slew, at most 0.02 ticks per snapshot, unless it is far off (a new fight's clock)
    if (this.off === null || best > this.off || this.off - best > this.hz * 2) this.off = best;
    else this.off += Math.max(-0.02, best - this.off);
    // the spread of delays: 90th percentile, in ticks; the render delay covers it plus one snapshot interval
    if (L.length >= 10) { const d = L.map((q) => best - q.o).sort((a, b) => a - b); this.jitter = d[Math.floor(d.length * 0.9)]; }
    const want = Math.max(MIN_DELAY, Math.min(MAX_DELAY, 1 + this.jitter + 0.4));
    this.delay += (want - this.delay) * (want > this.delay ? 0.2 : 0.01); // quick to grow, slow to shrink
  }
  // the newest server tick that could have reached us by now (a float)
  serverNow() { return this.off === null ? null : performance.now() / 1000 * this.hz + this.off; }
  // the moment other things are drawn: real time, steered toward serverNow() - delay by at most 8% speed
  advance(dt) {
    if (this.off === null) return;
    const target = this.serverNow() - this.delay;
    if (this.renderTick === null || Math.abs(target - this.renderTick) > 10) { this.renderTick = target; return; }
    const err = target - this.renderTick, rate = 1 + Math.max(-0.08, Math.min(0.08, err * 0.25));
    this.renderTick += dt * this.hz * rate;
  }
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
  // for the debug overlay and tools: times in ms
  stats() {
    const ms = 1000 / this.hz;
    return { rtt: this.rtt * 1000, jitter: this.jitter * ms, delay: this.delay * ms, snapHz: this.arrivals.length, behind: this.off === null || this.renderTick === null ? 0 : (this.serverNow() - this.renderTick) * ms, sim: this.sim };
  }
}

// the server address: ?server=wss://host/ws, else this page's own host
export function serverUrl(qs) {
  const room = (qs.get('room') || 'main').toLowerCase();
  let base = qs.get('server');
  if (!base) base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  return base + (base.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(room);
}
// the simulated line from the page's address (?lag=60&jitter=20&loss=1), or null
export function lineFromQuery(qs) {
  const n = (k) => Math.max(0, +(qs.get(k) || 0) || 0), o = { lag: n('lag'), jitter: n('jitter'), loss: Math.min(50, n('loss')) };
  return o.lag || o.jitter || o.loss ? o : null;
}
