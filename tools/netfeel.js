// node tools/netfeel.js [--repo <axiom checkout>] [--lag 60] [--jitter 20] [--loss 1] [--secs 40] [--boss atelier] [--out file.json]
//
// How the game feels on a bad line, measured: two real browser clients play the same fight through tools/netsim.js (a
// simulated network) against a real server, and every drawn frame of each page is sampled from what is on screen (the HUD's
// cast bars, the heroes' drawn positions). It needs no help from the page, so the same script measures any build:
// --repo points at another checkout (e.g. a worktree of main) to measure that build's server and client.
//
// Players: Ann (Stormcaller) walks, stops and casts Bolt; Ben (Duskblade) walks and slashes. Both follow a fixed script of
// key presses dispatched inside the page (so the press times are exact). God mode keeps them standing.
//
// What it reports, per page:
//   cast bar  (your own, and the boss's): frame-to-frame steps compared with the bar's own steady rate. "jump" is how far a
//             step is from where a smooth bar would be, in % of the bar; "stalls" are frames where the bar should move and did not
//   you       your own hero's drawn speed while walking a straight line (should be 7 m/s every frame), and any drawn movement
//             while standing still (corrections that show)
//   other     the other player's hero as drawn on this page: frame-to-frame change of speed (m/s), i.e. visible judder
//   latency   key down to the first frame your hero moves; key down to the first frame your cast bar shows
// Needs Playwright (NODE_PATH) and, offline, THREE_DIR (an unpacked three@0.170.0 npm package).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startNetsim } from './netsim.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const ROOT = path.resolve(arg('repo', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const LINE = { lag: +arg('lag', 60), jitter: +arg('jitter', 20), loss: +arg('loss', 1) }, SECS = +arg('secs', 40), BOSS = arg('boss', 'atelier');
const THREE_DIR = process.env.THREE_DIR, W = +(process.env.SHOT_W || 400), H = +(process.env.SHOT_H || 225);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the key script, seconds from its start: [t, 'down' | 'up', code]. One round, repeated.
const ROUND = {
  ann: [[0, 'down', 'KeyW'], [1.6, 'up', 'KeyW'], [1.9, 'down', 'Digit1'], [2.0, 'up', 'Digit1'], [3.9, 'down', 'KeyD'], [5.0, 'up', 'KeyD'], [5.3, 'down', 'Digit1'], [5.4, 'up', 'Digit1'], [7.3, 'down', 'KeyS'], [8.9, 'up', 'KeyS'], [9.2, 'down', 'KeyA'], [10.3, 'up', 'KeyA'], [10.6, 'down', 'Digit1'], [10.7, 'up', 'Digit1'], [12.6, 'down', 'KeyD'], [12.6, 'down', 'KeyW'], [13.8, 'up', 'KeyD'], [13.8, 'up', 'KeyW']],
  ben: [[0, 'down', 'KeyW'], [1.2, 'up', 'KeyW'], [1.5, 'down', 'Digit1'], [1.6, 'up', 'Digit1'], [2.6, 'down', 'Digit1'], [2.7, 'up', 'Digit1'], [3.4, 'down', 'KeyS'], [4.6, 'up', 'KeyS'], [5.0, 'down', 'KeyA'], [6.0, 'up', 'KeyA'], [6.4, 'down', 'KeyD'], [7.4, 'up', 'KeyD'], [7.8, 'down', 'Digit1'], [7.9, 'up', 'Digit1'], [9.0, 'down', 'KeyW'], [10.0, 'up', 'KeyW'], [10.4, 'down', 'KeyS'], [11.4, 'up', 'KeyS'], [12.0, 'down', 'Digit1'], [12.1, 'up', 'Digit1'], [13.5, 'down', 'KeyA'], [14.2, 'up', 'KeyA']],
};
const ROUND_LEN = 15;

// installed in each page: plays the key script and samples every drawn frame (after the game's own frame callback)
function pageScript([script, roundLen, secs]) {
  const A = window.__axiom, out = window.__feel = { frames: [], keys: [] }, t0 = performance.now() + 300;
  const fire = (type, code) => window.dispatchEvent(new KeyboardEvent(type === 'down' ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  const evs = []; for (let r = 0; r * roundLen < secs; r++) for (const e of script) if (r * roundLen + e[0] < secs) evs.push([t0 + (r * roundLen + e[0]) * 1000, e[1], e[2]]);
  const scale = (el) => { const m = el && el.style.transform.match(/scale[XY]?\(([-\d.e]+)\)/); return m ? +m[1] : 0; };
  const tick = (now) => { // now: the frame's own timestamp (the one the game's frame used), not when this callback ran
    while (evs.length && evs[0][0] <= performance.now()) { const e = evs.shift(); fire(e[1], e[2]); out.keys.push([performance.now(), e[1], e[2]]); }
    const v = A.S.view, me = v && v.heroes.get(A.S.you), pc = document.querySelector('#pcast'), bc = document.querySelector('#bcast');
    const others = []; if (v) for (const [id, h] of v.heroes) if (id !== A.S.you) others.push([id, h.x, h.z]);
    out.frames.push({ t: now, x: me ? me.x : null, z: me ? me.z : null, cast: pc && pc.style.opacity === '1' ? scale(pc.firstElementChild) : null, boss: bc && bc.classList.contains('on') ? scale(bc.firstElementChild) : null, bossName: bc && bc.classList.contains('on') ? bc.lastElementChild.textContent : null, others });
    if (performance.now() < t0 + secs * 1000 + 500) requestAnimationFrame(tick); else out.done = true;
  };
  requestAnimationFrame(tick);
}

// ---------------- analysis
const pct = (L, q) => { if (!L.length) return null; const s = L.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const r1 = (v) => v === null ? null : Math.round(v * 10) / 10;
function castBars(frames, key, nameKey) { // segments of one cast each; the steady rate is the segment's median step rate
  const segs = []; let cur = null;
  for (const f of frames) {
    const v = f[key], name = nameKey ? f[nameKey] : '';
    if (v === null) { cur = null; continue; }
    if (!cur || v < cur.last - 0.3 || name !== cur.name) { cur = { pts: [], name, last: v }; segs.push(cur); }
    cur.pts.push([f.t, v]); cur.last = v;
  }
  const jumps = [], back = []; let stalls = 0, steps = 0, casts = 0;
  for (const s of segs) {
    const P = s.pts.filter((p) => p[1] > 0.02 && p[1] < 0.98); if (P.length < 6) continue; casts++;
    const rates = []; for (let i = 1; i < P.length; i++) { const dt = (P[i][0] - P[i - 1][0]) / 1000; if (dt > 0) rates.push((P[i][1] - P[i - 1][1]) / dt); }
    const rate = pct(rates, 0.5);
    for (let i = 1; i < P.length; i++) {
      const dt = (P[i][0] - P[i - 1][0]) / 1000, d = P[i][1] - P[i - 1][1], want = rate * dt; steps++;
      jumps.push(Math.abs(d - want) * 100); if (d < -0.002) back.push(-d * 100); if (Math.abs(d) < 1e-4 && want > 0.005) stalls++;
    }
  }
  return { casts, frames: steps, jumpP50: r1(pct(jumps, 0.5)), jumpP95: r1(pct(jumps, 0.95)), jumpMax: r1(jumps.length ? Math.max(...jumps) : null), backSteps: back.length, stallPct: steps ? r1(stalls / steps * 100) : null };
}
function heldMove(keys, t) { let n = 0; for (const k of keys) { if (k[0] > t) break; if (/^Key[WASD]$/.test(k[2])) n += k[1] === 'down' ? 1 : -1; } return n > 0; }
function lastKeyChange(keys, t) { let last = -1e9; for (const k of keys) { if (k[0] > t) break; if (/^Key[WASD]$/.test(k[2])) last = k[0]; } return last; }
function you(frames, keys) {
  const err = [], still = [];
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i], g = frames[i - 1]; if (f.x === null || g.x === null) continue;
    const dt = (f.t - g.t) / 1000, d = Math.hypot(f.x - g.x, f.z - g.z); if (dt <= 0) continue;
    const since = f.t - lastKeyChange(keys, f.t);
    if (heldMove(keys, g.t) && heldMove(keys, f.t) && since > 400) err.push(Math.abs(d / dt - 7)); // walking a straight line: 7 m/s
    else if (!heldMove(keys, g.t) && !heldMove(keys, f.t) && since > 600) still.push(d * 100); // standing: nothing should move it (but a knockback)
  }
  return { walkFrames: err.length, speedErrP50: r1(pct(err, 0.5)), speedErrP95: r1(pct(err, 0.95)), speedErrMax: r1(err.length ? Math.max(...err) : null), stillFrames: still.length, stillMoveP95cm: r1(pct(still, 0.95)), stillMoveMaxCm: r1(still.length ? Math.max(...still) : null) };
}
// the other player while they walk (drawn speed above 3 m/s on two frames running): how much the drawn speed changes from
// one frame to the next. A smooth walk is about 0; starts and stops are left out.
function others(frames) {
  const acc = []; const last = new Map();
  for (const f of frames) for (const [id, x, z] of f.others) {
    const L = last.get(id), v = L ? Math.hypot(x - L.x, z - L.z) / Math.max(1e-3, (f.t - L.t) / 1000) : null; last.set(id, { t: f.t, x, z, v });
    if (L && L.v !== null && v > 3 && L.v > 3) acc.push(Math.abs(v - L.v));
  }
  return { walkFrames: acc.length, speedChangeP50: r1(pct(acc, 0.5)), speedChangeP95: r1(pct(acc, 0.95)), speedChangeMax: r1(acc.length ? Math.max(...acc) : null) };
}
function latency(frames, keys) {
  const move = [], cast = [];
  for (const k of keys) {
    if (k[1] !== 'down') continue; const i0 = frames.findIndex((f) => f.t >= k[0]); if (i0 < 1) continue;
    if (/^Key[WASD]$/.test(k[2]) && !heldMove(keys, k[0] - 1)) { const p = frames[i0 - 1]; const j = frames.findIndex((f, i) => i >= i0 && f.x !== null && p.x !== null && Math.hypot(f.x - p.x, f.z - p.z) > 0.01); if (j > 0 && frames[j].t - k[0] < 1500) move.push(frames[j].t - k[0]); }
    if (k[2] === 'Digit1' && frames[i0 - 1].cast === null) { const j = frames.findIndex((f, i) => i >= i0 && f.cast !== null); if (j > 0 && frames[j].t - k[0] < 1500) cast.push(frames[j].t - k[0]); }
  }
  const avg = (L) => L.length ? Math.round(L.reduce((x, y) => x + y, 0) / L.length) : null;
  return { moveMs: avg(move), moveN: move.length, castMs: avg(cast), castN: cast.length };
}
function fps(frames) { const dts = []; for (let i = 1; i < frames.length; i++) dts.push(frames[i].t - frames[i - 1].t); return r1(1000 / pct(dts, 0.5)); }

// ---------------- run
async function main() {
  const { startServer } = await import(pathToFileURL(path.join(ROOT, 'packages/server/src/server.js')).href);
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, test: true });
  const sim = await startNetsim({ upstream: `http://127.0.0.1:${srv.port}`, port: 0, ...LINE });
  const url = `http://127.0.0.1:${sim.port}`;
  const br = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = async (name, cls) => {
    const ctx = await br.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    if (THREE_DIR) await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/, (r) => { const m = r.request().url().match(/three@[^/]+\/([^?#]*)/), f = path.join(THREE_DIR, m[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: 'nf' }); r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) }); });
    const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('  [pageerror ' + name + ']', e.message));
    await p.goto(`${url}/?room=feel&name=${name}&quality=low`); await p.waitForFunction(() => window.__axiom && window.__axiom.S.lobby, null, { timeout: 60000 });
    await p.evaluate((c) => window.__axiom.net.send({ t: 'class', cls: c }), cls); return p;
  };
  const ann = await page('Ann', 'stormcaller'), ben = await page('Ben', 'duskblade'); await sleep(500);
  await ann.evaluate((b) => window.__axiom.net.send({ t: 'start', boss: b, skipIntro: true, god: true }), BOSS);
  for (const p of [ann, ben]) await p.waitForFunction(() => window.__axiom.S.phase === 'fight' && window.__axiom.net.latest && window.__axiom.S.you, null, { timeout: 180000 });
  await sleep(6000); // the warm-up compiles every shader; let both pages settle
  await Promise.all([ann.evaluate(pageScript, [ROUND.ann, ROUND_LEN, SECS]), ben.evaluate(pageScript, [ROUND.ben, ROUND_LEN, SECS])]);
  for (const p of [ann, ben]) await p.waitForFunction(() => window.__feel && window.__feel.done, null, { timeout: (SECS + 120) * 1000, polling: 500 });
  const res = { repo: ROOT, line: LINE, boss: BOSS, secs: SECS, pages: {} };
  for (const [name, p] of [['ann', ann], ['ben', ben]]) {
    const d = await p.evaluate(() => ({ frames: window.__feel.frames, keys: window.__feel.keys, stats: window.__axiom.netStats ? window.__axiom.netStats() : null }));
    res.pages[name] = { fps: fps(d.frames), ownCast: castBars(d.frames, 'cast'), bossCast: castBars(d.frames, 'boss', 'bossName'), you: you(d.frames, d.keys), other: others(d.frames), latency: latency(d.frames, d.keys), netStats: d.stats };
  }
  console.log(JSON.stringify(res, null, 1));
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(res, null, 1));
  await br.close(); await sim.close(); await srv.close(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
