// The real server over real WebSockets: the lobby, the training dummy, a locked boss fight, and fake players that play
// from snapshots. The sim runs 20 times faster than real time here (startServer speed), so a fight takes seconds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../packages/server/src/server.js';
import { fakeClient } from '../tools/fake-client.js';

let srv, base;
before(async () => { srv = await startServer({ port: 0, countdown: 0, speed: 20, host: '127.0.0.1', seed: 1 }); base = `ws://127.0.0.1:${srv.port}/ws`; });
after(async () => { await srv.close(); });

const lobbyOf = (c) => [...c.msgs].reverse().find((m) => m.t === 'lobby');
const closeAll = (...cs) => { for (const c of cs) c.close(); };

test('the client page and the health check are served', async () => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`); assert.equal(r.status, 200);
  const p = await fetch(`http://127.0.0.1:${srv.port}/packages/client/`); assert.equal(p.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/package.json`)).status, 404, 'only the browser packages are served');
});

test('the lobby: names, classes, bots, and only the open classes', async () => {
  const url = base + '?room=lobby1', a = await fakeClient(url, { name: 'Ann' }), b = await fakeClient(url, { name: 'Bob', cls: 'stormcaller' });
  await a.until((c) => { const l = lobbyOf(c); return l && l.members.length === 2; });
  const w = a.msgs.find((m) => m.t === 'welcome');
  assert.deepEqual(w.classes.map((c) => c.id), ['duskblade', 'stormcaller']);
  assert.deepEqual(w.bosses.map((q) => q.id), ['dummy', 'atelier', 'duelist']);
  a.send({ t: 'class', cls: 'hexslinger' }); a.send({ t: 'class', cls: 'stormcaller' }); a.send({ t: 'addBot', cls: 'duskblade' });
  const l = await a.until((c) => { const q = lobbyOf(c); return q && q.members.length === 3 && q.members[0].cls === 'stormcaller' && q; });
  assert.deepEqual(l.members.map((m) => [m.name, m.cls, m.bot]), [['Ann', 'stormcaller', false], ['Bob', 'stormcaller', false], ['Bot 1', 'duskblade', true]]);
  assert.ok(a.msgs.some((m) => m.t === 'note' && /not open/.test(m.text)), 'a closed class is refused');
  closeAll(a, b);
});

test('the training dummy: input frames move and fight, people walk in and change class, anyone can end it', async () => {
  const url = base + '?room=dummy1', a = await fakeClient(url, { name: 'Ann' }), b = await fakeClient(url, { name: 'Bob', cls: 'stormcaller' });
  await a.until((c) => lobbyOf(c) && lobbyOf(c).members.length === 2);
  a.send({ t: 'start', boss: 'dummy' });
  await a.until((c) => c.you && c.snap && c.snap.s.boss.id === 'dummy');
  await b.until((c) => c.you);
  // Ann walks to the dummy and slashes it with plain input frames
  const t0 = Date.now(); let me;
  while (Date.now() - t0 < 5000) {
    me = a.snap.s.players.find((p) => p.id === a.you); const d = a.snap.s.ents.find((e) => e.boss);
    const dx = d.x - me.x, dz = d.z - me.z, l = Math.hypot(dx, dz);
    a.send({ t: 'input', f: l > 2.5 ? { mx: dx / l, mz: dz / l, held: 0, press: [] } : { mx: 0, mz: 0, held: 1, press: [0] } });
    if (me.dmg > 300) break;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(me.dmg > 300, 'Ann dealt ' + me.dmg);
  assert.ok(a.snap.s.boss.pub.meter[a.you].total > 0, 'the meter counts her');
  // Cat walks in while it runs; Bob changes class on the spot
  const c = await fakeClient(url, { name: 'Cat' });
  await c.until((q) => q.you && q.snap && q.snap.s.players.some((p) => p.id === q.you));
  b.send({ t: 'class', cls: 'duskblade' });
  await b.until((q) => q.snap && q.snap.s.players.find((p) => p.id === q.you && p.cls === 'duskblade'));
  assert.equal(a.snap.s.players.length, 3);
  c.close();
  await a.until((q) => q.snap.s.players.length === 2);
  b.send({ t: 'end' });
  await a.until((q) => q.msgs.some((m) => m.t === 'end') && lobbyOf(q).phase === 'lobby');
  closeAll(a, b);
});

test('a boss locks the room; four fake players (autopilot) kill Pentimento through the socket', async () => {
  const url = base + '?room=boss1', names = ['Ann', 'Bob', 'Cat', 'Dan'], cls = ['duskblade', 'stormcaller', 'duskblade', 'stormcaller'];
  const cs = []; for (let i = 0; i < 4; i++) cs.push(await fakeClient(url, { name: names[i], cls: cls[i], auto: true }));
  await cs[0].until((c) => lobbyOf(c) && lobbyOf(c).members.length === 4);
  cs[0].send({ t: 'start', boss: 'atelier' });
  await cs[0].until((c) => c.snap && c.snap.s.boss.id === 'atelier');
  // someone arriving now watches
  const late = await fakeClient(url, { name: 'Eve' });
  await late.until((c) => c.msgs.some((m) => m.t === 'start') && c.snap);
  assert.equal(late.msgs.find((m) => m.t === 'start').you, null);
  assert.ok(late.msgs.some((m) => m.t === 'note' && /watching/.test(m.text)));
  assert.equal(late.snap.s.players.length, 4, 'the late arrival is not in the fight');
  const end = await cs[0].until((c) => c.msgs.find((m) => m.t === 'end'), 60000);
  assert.equal(end.result, 'win', `ended ${end.result} at ${end.ft}`);
  assert.equal(end.stats.length, 4); for (const s of end.stats) assert.ok(s.dmg > 0, s.name + ' dealt damage');
  await late.until((c) => c.msgs.some((m) => m.t === 'end') && lobbyOf(c).phase === 'lobby' && lobbyOf(c).members.length === 5);
  closeAll(late, ...cs);
});

test('Issen is solo for now: whoever starts him fights, the rest of the room watches', async () => {
  const url = base + '?room=duel1', a = await fakeClient(url, { name: 'Ann', auto: true }), b = await fakeClient(url, { name: 'Bob', cls: 'stormcaller', auto: true });
  await a.until((c) => lobbyOf(c) && lobbyOf(c).members.length === 2);
  assert.equal(a.msgs.find((m) => m.t === 'welcome').bosses.find((q) => q.id === 'duelist').solo, true);
  b.send({ t: 'start', boss: 'duelist' });
  await b.until((c) => c.snap && c.snap.s.boss.id === 'duelist' && c.you);
  await a.until((c) => c.snap && c.snap.s.boss.id === 'duelist');
  assert.equal(a.msgs.find((m) => m.t === 'start').you, null, 'Ann is not in the fight');
  assert.ok(a.msgs.some((m) => m.t === 'note' && /solo/.test(m.text)), 'Ann is told why');
  assert.deepEqual(b.snap.s.players.map((p) => p.id), [b.you]);
  b.send({ t: 'end' }); await a.until((q) => q.msgs.some((m) => m.t === 'end') && lobbyOf(q).phase === 'lobby');
  closeAll(a, b);
});

test('a newcomer to Pentimento gets the paint already down (the catch-up); test hooks are off on a real server', async () => {
  const url = base + '?room=boss3', a = await fakeClient(url, { name: 'Ann', cls: 'stormcaller', auto: true });
  await a.until((q) => lobbyOf(q) && lobbyOf(q).members.length === 1);
  a.send({ t: 'start', boss: 'atelier', phase: 2, god: true, skipIntro: true }); // phase and skipIntro ignored: this server was not started with test (god is the lobby's God mode now)
  await a.until((q) => q.snap && q.snap.s.state === 'fight' && q.snap.s.boss.pub.strokes >= 12, 30000);
  assert.equal(a.snap.s.boss.phase, 0, 'a real server ignores the start-at-phase hook');
  a.send({ t: 'test', o: { kill: true } }); // ignored too
  const late = await fakeClient(url, { name: 'Eve' });
  const c = await late.until((q) => q.msgs.find((m) => m.t === 'catchup'), 10000);
  const all = c.baked.concat(c.strokes), n = all.length;
  assert.equal(c.boss, 'atelier'); assert.ok(n >= 12, 'strokes in the catch-up: ' + n);
  for (const sh of all) assert.ok((sh.t === 'c' || sh.t === 'r') && Number.isFinite(sh.x) && Number.isFinite(sh.z) && Number.isFinite(sh.seed) && Number.isFinite(sh.t0), 'a whole stroke');
  // it matches the server's count at its tick
  const at = await late.until((q) => q.snap && q.snap.s.tick >= c.tick && q.snap, 10000);
  assert.ok(at.s.boss.pub.strokes >= n, `pub ${at.s.boss.pub.strokes} >= ${n}`);
  assert.ok(a.snap.s.ents.find((e) => e.boss).alive, 'the kill hook was ignored');
  a.send({ t: 'end' }); await a.until((q) => q.msgs.some((m) => m.t === 'end'));
  closeAll(a, late);
});

test('fake players that play from snapshots alone drive their characters through input frames', async () => {
  const url = base + '?room=boss2';
  const a = await fakeClient(url, { name: 'Ann', cls: 'duskblade', brain: true }), b = await fakeClient(url, { name: 'Bob', cls: 'stormcaller', brain: true });
  const c = await fakeClient(url, { name: 'Cat', cls: 'duskblade', auto: true });
  await a.until((q) => lobbyOf(q) && lobbyOf(q).members.length === 3);
  b.send({ t: 'start', boss: 'atelier' });
  await a.until((q) => q.snap && q.snap.s.state === 'fight' && q.snap.s.t > 40, 30000);
  const ps = a.snap.s.players, pa = ps.find((p) => p.id === a.you), pb = ps.find((p) => p.id === b.you);
  assert.ok(pa.dmg > 0 && pb.dmg > 0, `damage from input frames: ${pa.dmg}, ${pb.dmg}`);
  assert.ok(Math.hypot(pa.x, pa.z - 12) > 3, 'Ann moved');
  a.send({ t: 'end' });
  await a.until((q) => q.msgs.some((m) => m.t === 'end'));
  closeAll(a, b, c);
});

test('the ready gate: a boss holds at its first tick until every player has loaded it, then runs (no timeout)', async () => {
  const url = base + '?room=gate1', a = await fakeClient(url, { name: 'Ann', auto: true }), b = await fakeClient(url, { name: 'Bob', auto: true, noReady: true });
  await a.until((c) => lobbyOf(c) && lobbyOf(c).members.length === 2);
  a.send({ t: 'start', boss: 'atelier' });
  await a.until((c) => c.msgs.some((m) => m.t === 'start' && m.loading) && c.msgs.some((m) => m.t === 'preview'));
  const pv = a.msgs.find((m) => m.t === 'preview');
  assert.equal(pv.s.boss.id, 'atelier', 'the first moment comes to build the arena from');
  const l = await a.until((c) => { const q = lobbyOf(c); return q && q.members.find((m) => m.name === 'Bob' && m.loading) && q; });
  assert.ok(!l.members.find((m) => m.name === 'Ann').loading, 'Ann is loaded; Bob is still loading');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(a.snaps, 0, 'nothing runs while Bob loads');
  assert.ok(!a.msgs.some((m) => m.t === 'go'));
  b.send({ t: 'ready' });
  const go = await a.until((c) => c.msgs.find((m) => m.t === 'go'));
  assert.equal(go.in, 0, 'the countdown (0 on this test server)');
  await a.until((c) => c.snap && c.snap.s.state === 'fight' && c.snap.s.tick > 5);
  await b.until((c) => c.snap && c.snap.s.tick > 5);
  a.send({ t: 'end' }); await a.until((c) => c.msgs.some((m) => m.t === 'end'));
  closeAll(a, b);
});
