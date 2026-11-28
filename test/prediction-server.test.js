// Prediction over the real server (real time, real WebSockets): a client sends tick-stamped frames a few ticks ahead, keeps
// a predictor in this process (the server's sims run in worker threads, so this realm is free), and checks that every state
// the server sends back for its character is exactly what it had predicted for that tick. Also: only the owner gets `me`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../packages/server/src/server.js';
import { fakeClient } from '../tools/fake-client.js';
import { Predictor } from './_sim.js';

let srv, base;
before(async () => { srv = await startServer({ port: 0, countdown: 0, host: '127.0.0.1', seed: 2 }); base = `ws://127.0.0.1:${srv.port}/ws`; });
after(async () => { await srv.close(); });

test('tick-stamped frames: the server steps exactly the predicted character, and only its owner gets its state', async () => {
  const url = base + '?room=pred1', a = await fakeClient(url, { name: 'Ann', cls: 'stormcaller' }), b = await fakeClient(url, { name: 'Bob' });
  await a.until((c) => c.msgs.some((m) => m.t === 'lobby' && m.members.length === 2));
  a.send({ t: 'start', boss: 'dummy' });
  await a.until((c) => c.you && c.snap && c.snap.me);
  const LEAD = 4, frames = new Map(), predicted = new Map(); let pr = null, sent = 0, checked = 0, exact = 0, bobSawMe = false;
  // the script: walk east for a second, stop and cast Bolt, walk north, Blink, keep walking
  const frameFor = (t) => { const k = t - sent0; return k < 30 ? { mx: 1, mz: 0, held: 0, press: [] } : k === 34 ? { mx: 0, mz: 0, held: 0, press: [0] } : k < 85 ? { mx: 0, mz: 0, held: 0, press: [] } : k === 90 ? { mx: 0, mz: 1, held: 0, press: [3] } : { mx: 0, mz: 1, held: 0, press: [] }; };
  let sent0 = null;
  const onSnap = (m) => {
    if (m.t !== 'snap' || !m.me) return;
    const me = m.me;
    if (!pr) { pr = new Predictor({ boss: 'dummy', cls: me.cls, id: me.id }); sent = me.k; sent0 = me.k; }
    // compare with what was predicted for this tick
    if (predicted.has(me.k)) { checked++; if (JSON.stringify(predicted.get(me.k)) === JSON.stringify(me.st)) exact++; predicted.delete(me.k); }
    // send frames up to LEAD ticks ahead of the server, then predict them from the server's state
    while (sent < me.k + LEAD) { sent++; frames.set(sent, frameFor(sent)); a.send({ t: 'frames', k: sent, fs: [frames.get(sent)] }); }
    pr.world(m.s.ents); pr.scene(m.s.state, m.s.cine, m.s.t); pr.load(me.st);
    for (let t = me.k + 1; t <= sent; t++) { pr.step(frames.get(t), null); if (!predicted.has(t)) predicted.set(t, JSON.parse(JSON.stringify(pr.save()))); }
  };
  const on = a.ws.onmessage; a.ws.onmessage = (e) => { on(e); onSnap(JSON.parse(e.data)); };
  const onb = b.ws.onmessage; b.ws.onmessage = (e) => { onb(e); if (JSON.parse(e.data).me && JSON.parse(e.data).me.id === a.you) bobSawMe = true; };
  await a.until(() => sent0 !== null && sent > sent0 + 130, 15000);
  const me = a.snap.me, p = a.snap.s.players.find((q) => q.id === a.you);
  assert.ok(me && me.ia !== null && me.ia >= 1, 'frames arrive ahead of their tick: ia ' + (me && me.ia));
  assert.ok(Math.abs(p.x - me.st.pos.$v[0]) < 1e-3, 'me matches the shared snapshot');
  assert.ok(p.dmg > 0, 'the Bolt landed');
  assert.ok(checked > 80, 'states compared: ' + checked);
  assert.equal(exact, checked, `${checked - exact} of ${checked} server states differ from the prediction`);
  assert.ok(!bobSawMe, 'another player never gets your state');
  assert.ok(!b.snap.me || b.snap.me.id !== a.you);
  a.close(); b.close();
});
