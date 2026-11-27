// A fake player: a WebSocket client that plays from snapshots alone, the way a browser does, with no access to the sim.
// It keeps the right distance from the boss, steps out of telegraphs, and presses its class's buttons in a plain rotation.
// Not a good player (it ignores paint); its job is to drive the server through the real input path.
// Used by test/server.test.js and tools/bots.js.
//
//   const c = await fakeClient(url, { name, cls, brain: true | false, auto: false })
//   c.msgs (non-snapshot messages), c.snap (latest snapshot message), c.send(msg), c.until(pred, ms), c.close()
import { Hz } from '@axiom/sim';

export function fakeClient(url, o = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), c = { ws, msgs: [], snap: null, snaps: 0, you: null, cls: o.cls || 'duskblade', bytes: 0 };
    c.send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    c.close = () => ws.close();
    c.until = (pred, ms = 10000) => new Promise((res, rej) => {
      const t0 = Date.now(), iv = setInterval(() => { let v; try { v = pred(c); } catch (e) { v = null; } if (v) { clearInterval(iv); res(v); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timed out waiting (' + (o.name || '') + ')')); } }, 20);
    });
    ws.onerror = (e) => reject(e.error || new Error('socket error'));
    ws.onopen = () => { c.send({ t: 'hello', v: 2, name: o.name || 'Fake', cls: c.cls }); if (o.auto) c.send({ t: 'auto', on: true }); resolve(c); };
    ws.onmessage = (e) => {
      c.bytes += e.data.length; const m = JSON.parse(e.data);
      if (m.t === 'snap') {
        c.snap = m; c.snaps++;
        if (o.brain && c.you && m.s.state === 'fight') c.send({ t: 'input', f: brain(m.s, c.you, c) });
        return;
      }
      c.msgs.push(m);
      if (m.t === 'start') c.you = m.you;
      if (m.t === 'end') c.you = null;
    };
  });
}

// one input frame from one snapshot
export function brain(s, you, c) {
  const me = s.players.find((p) => p.id === you), boss = s.ents.find((e) => e.boss && e.alive);
  const f = { mx: 0, mz: 0, held: 0, press: [] };
  if (!me || !me.alive || !boss) return f;
  const melee = me.cls === 'duskblade' || me.cls === 'ashwarden';
  const dx = boss.x - me.x, dz = boss.z - me.z, d = Math.hypot(dx, dz) || 1, want = melee ? boss.radius + 2.2 : 14;
  let mx = 0, mz = 0;
  if (Math.abs(d - want) > 1) { const k = d > want ? 1 : -1; mx = dx / d * k; mz = dz / d * k; }
  // standing in a telegraph that is about to land (or a burning zone): step out, away from its centre
  for (const h of s.hazards) {
    if (!h.dmg || h.state === 'fired') continue;
    const soon = h.state === 'zone' || h.delay - h.t < 1.6;
    if (soon && Hz.inShape(h.shape, me.x, me.z)) {
      const sh = h.shape;
      if (sh.type === 'rect') { const px = Math.cos(sh.dir), pz = -Math.sin(sh.dir), side = (me.x - sh.x) * px + (me.z - sh.z) * pz >= 0 ? 1 : -1; mx = px * side; mz = pz * side; }
      else { const ax = me.x - sh.x, az = me.z - sh.z, l = Math.hypot(ax, az) || 1; mx = ax / l; mz = az / l; }
      break;
    }
  }
  // keep off the wall
  const r = Math.hypot(me.x + mx, me.z + mz); if (s.arena && r > s.arena.radius - 2) { mx -= me.x / r * 0.8; mz -= me.z / r * 0.8; }
  const l = Math.hypot(mx, mz); if (l > 0.01) { f.mx = mx / Math.max(1, l); f.mz = mz / Math.max(1, l); }
  const moving = l > 0.01, ready = (i) => me.slots[i] && me.slots[i].why === '';
  if (me.hp < me.maxHp * 0.45 && ready(6)) f.press.push(6);
  else if (me.cls === 'duskblade') { if (ready(2)) f.press.push(2); f.press.push(me.res >= 5 ? 1 : 0); }
  else if (me.cls === 'stormcaller') { if (ready(2)) f.press.push(2); if (me.res >= 4 || (moving && me.res >= 1)) f.press.push(1); else if (!moving) f.press.push(0); }
  else f.press.push(0);
  if (c) c.lastFrame = f;
  return f;
}
