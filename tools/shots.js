// node tools/shots.js [outDir] [only]   screenshots of the real client in a real browser, against a real server
//
// Starts the game server on a free port (or uses AXIOM_URL), opens Chromium, joins a room, picks a class, starts an
// encounter with the autopilot playing, and saves screenshots at set moments: the Training Dummy with Duskblade and with
// Stormcaller, two players on the dummy (the second one is drawn as a remote, interpolated player), Pentimento, and Issen (duelist).
// `only` keeps the shots whose name contains it (e.g. `dummy`, `atelier`; several with commas).
//
// GPU: by default the browser renders with SwiftShader (software), which is what a cloud sandbox has. It is slow and does
// not show what a real graphics card shows (bloom, NaN pixels, driver quirks). On a machine with a graphics card run
//   TH_GPU=1 node tools/shots.js shots-gpu
// which launches the installed Chrome (TH_CHANNEL=msedge for Edge) with hardware ANGLE (d3d11 on Windows; TH_ANGLE to
// override), TH_HEADED=1 shows the window. Without internet the page cannot load Three.js from jsDelivr: set THREE_DIR to an
// unpacked three@0.170.0 npm package (`npm pack three@0.170.0 && tar xzf three-0.170.0.tgz`, then THREE_DIR=.../package).
// Needs Playwright (`npm i -g playwright` or NODE_PATH pointing at a copy). SHOT_Q=low (or med) picks a lighter quality, which keeps
// up better in software rendering.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || 'shots'), ONLY = (process.argv[3] || '').split(',').filter(Boolean), only = (n) => !ONLY.length || ONLY.some((q) => n.includes(q));
const GPU = !!process.env.TH_GPU, THREE_DIR = process.env.THREE_DIR;
const W = +(process.env.SHOT_W || 1280), H = +(process.env.SHOT_H || 720);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function server() {
  if (process.env.AXIOM_URL) return { url: process.env.AXIOM_URL.replace(/\/$/, ''), close() { } };
  const { startServer } = await import(path.join(ROOT, 'packages/server/src/server.js'));
  const s = await startServer({ port: 0, host: '127.0.0.1', quiet: true, test: true }); // test: the start-at-phase and kill hooks
  return { url: `http://127.0.0.1:${s.port}`, close: () => s.close && s.close() };
}

async function browser() {
  return chromium.launch(GPU
    ? { channel: process.env.TH_CHANNEL || 'chrome', headless: !process.env.TH_HEADED, args: ['--use-angle=' + (process.env.TH_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'default')), '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }
    : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

const open = []; // this scene's pages: closed when the scene ends, so earlier fights do not keep rendering in the background
async function page(br, url) {
  const ctx = await br.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  if (THREE_DIR) await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/, (route) => {
    const m = route.request().url().match(/three@[^/]+\/([^?#]*)/), f = path.join(THREE_DIR, m[1]);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
  });
  open.push(ctx); const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && !/GPU stall|swiftshader|Automatic fallback|X3595/i.test(m.text()))) console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)); });
  p.on('pageerror', (e) => console.log('  [pageerror]', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  await p.goto(url + (process.env.SHOT_Q ? (url.includes('?') ? '&' : '?') + 'quality=' + process.env.SHOT_Q : '')); // SHOT_Q=low: faster in software rendering
  await p.waitForFunction(() => window.__axiom && window.__axiom.S.lobby, null, { timeout: 90000 });
  return p;
}
const pickClass = (p, cls) => p.evaluate((c) => window.__axiom.net.send({ t: 'class', cls: c }), cls);
const auto = (p, on) => p.evaluate((v) => window.__axiom.net.send({ t: 'auto', on: v }), on);
const start = (p, boss, nm, o = {}) => p.evaluate(([b, n, o]) => window.__axiom.net.send(Object.assign({ t: 'start', boss: b, nm: n }, o)), [boss, !!nm, o]);
// the server's test hooks (tools only): { hp: fraction, fk: finale sitting, ft: fight clock, kill: true }
const hook = (p, o) => p.evaluate((q) => window.__axiom.net.send({ t: 'test', o: q }), o);
// wait for the drawing's own clock (the kill and other client-side timelines run on it)
const drawn = async (p, sec) => { const r0 = await p.evaluate(() => window.__axiom.G.rt); await p.waitForFunction((q) => window.__axiom.G.rt >= q, r0 + sec, { timeout: 300000, polling: 50 }); };
const won = (p, ms = 60000) => p.waitForFunction(() => { const b = document.querySelector('#banner'); return b && !b.hidden; }, null, { timeout: ms, polling: 50 });
// a Pentimento fight with the autopilot: you (Stormcaller) and a bot (Duskblade), god mode, from a phase, the intro skipped
async function atelier(br, url, room, o = {}) {
  const p = await page(br, url + '/?room=' + room + '&name=Pat'); await pickClass(p, 'stormcaller'); await auto(p, true);
  if (o.party !== false) { await p.evaluate(() => window.__axiom.net.send({ t: 'addBot', cls: 'duskblade' })); await sleep(300); }
  await start(p, 'atelier', o.nm, { phase: o.phase || 0, skipIntro: o.intro !== true, god: true }); await inFight(p); return p;
}
// an Issen fight (solo) with the autopilot: you (Stormcaller), god mode, from a phase, the intro skipped unless o.intro
async function duelist(br, url, room, o = {}) {
  const p = await page(br, url + '/?room=' + room + '&name=Pat'); await pickClass(p, o.cls || 'stormcaller'); await auto(p, true);
  await start(p, 'duelist', o.nm, { phase: o.phase || 0, skipIntro: o.intro !== true, god: true }); await inFight(p); return p;
}
// the kill hook does nothing while he is immune (a still body, a transition): ask again until it lands
async function killNow(p) { for (let i = 0; i < 30; i++) { await hook(p, { kill: true, hold: true }); if (await won(p, 1500).then(() => true, () => false)) return; } throw new Error('the kill never landed'); }
const inFight = (p) => p.waitForFunction(() => window.__axiom.S.phase === 'fight' && window.__axiom.net.latest, null, { timeout: 180000 }); // a second page warming up in software rendering takes a while
// wait until the fight clock reaches t seconds (the server runs in real time)
const fightAt = (p, t) => p.waitForFunction((q) => { const s = window.__axiom.net.latest; return s && s.t >= q; }, t, { timeout: 600000, polling: 250 });
// camera: yaw relative to the hero's facing, pitch, distance (null keeps what the client chose)
const cam = (p, o) => p.evaluate((q) => { const v = window.__axiom.S.view; if (v && v.setCam) v.setCam(q); }, o);
async function shot(p, name) {
  if (!only(name)) return;
  await sleep(400); const f = path.join(OUT, name + '.png'); await p.screenshot({ path: f, timeout: 180000 });
  const info = await p.evaluate(() => (window.__axiom.S.view && window.__axiom.S.view.info) ? window.__axiom.S.view.info() : {});
  console.log('  ' + name + '.png', JSON.stringify(info));
}

const SCENES = [
  { name: 'dummy-duskblade', async run(br, url) {
    const p = await page(br, url + '/?room=shot-db&name=Dana'); await pickClass(p, 'duskblade'); await auto(p, true); await start(p, 'dummy'); await inFight(p);
    await fightAt(p, 7); await shot(p, 'dummy-duskblade-1'); await fightAt(p, 12); await cam(p, { yaw: 2.2, pitch: 0.3, dist: 9 }); await sleep(800); await shot(p, 'dummy-duskblade-2');
  } },
  { name: 'dummy-stormcaller', async run(br, url) {
    const p = await page(br, url + '/?room=shot-sc&name=Sam'); await pickClass(p, 'stormcaller'); await auto(p, true); await start(p, 'dummy'); await inFight(p);
    await fightAt(p, 8); await shot(p, 'dummy-stormcaller-1'); await fightAt(p, 14); await cam(p, { yaw: 2.4, pitch: 0.25, dist: 10 }); await sleep(800); await shot(p, 'dummy-stormcaller-2');
  } },
  { name: 'dummy-party', async run(br, url) { // two people on the dummy: the shot is from the first, the second is a remote, interpolated player
    const a = await page(br, url + '/?room=shot-pty&name=Ann'); await pickClass(a, 'duskblade'); await auto(a, true);
    const b = await page(br, url + '/?room=shot-pty&name=Ben'); await pickClass(b, 'stormcaller'); await auto(b, true);
    await start(a, 'dummy'); await inFight(a); await inFight(b); await fightAt(a, 9); await cam(a, { yaw: 2.8, pitch: 0.42, dist: 13 }); await sleep(800); await shot(a, 'dummy-party');
  } },
  { name: 'atelier', async run(br, url) {
    const p = await page(br, url + '/?room=shot-at&name=Pat'); await pickClass(p, 'stormcaller'); await auto(p, true);
    await p.evaluate(() => window.__axiom.net.send({ t: 'addBot' })); await sleep(300);
    await start(p, 'atelier'); await inFight(p);
    await p.waitForFunction(() => { const s = window.__axiom.net.latest; return s && s.state === 'intro'; }, null, { timeout: 60000 }).catch(() => {}); await sleep(2500); await shot(p, 'atelier-intro'); // the intro's cinematic shot
    await fightAt(p, 16); await shot(p, 'atelier-1'); await fightAt(p, 30); await shot(p, 'atelier-2');
  } },
  // Pentimento's looks, one scene each (start-at-phase hooks; the shots print compiledInFight, which must stay [])
  { name: 'atelier-colour', async run(br, url) { const p = await atelier(br, url, 'shot-ac', { phase: 1 }); await fightAt(p, 14); await shot(p, 'atelier-colour'); } },
  { name: 'atelier-negative', async run(br, url) { const p = await atelier(br, url, 'shot-an', { phase: 2 }); await fightAt(p, 9); await shot(p, 'atelier-negative-1'); await fightAt(p, 20); await cam(p, { yaw: 2.6, pitch: 0.3, dist: 12 }); await sleep(800); await shot(p, 'atelier-negative-2'); } },
  { name: 'atelier-kill', async run(br, url) { const p = await atelier(br, url, 'shot-ak'); await fightAt(p, 10); await hook(p, { kill: true, hold: true }); await won(p); await drawn(p, 1.0); await shot(p, 'atelier-kill-1'); await drawn(p, 2.0); await shot(p, 'atelier-kill-2'); } },
  { name: 'atelier-nm-colour', async run(br, url) { const p = await atelier(br, url, 'shot-nc', { nm: true }); await fightAt(p, 12); await shot(p, 'atelier-nm-colour'); } },
  { name: 'atelier-nm-chiaroscuro', async run(br, url) { // the turn into the finale (its cinematic), then a sitting, then the last ramp step
    const p = await atelier(br, url, 'shot-nf', { nm: true, phase: 2 }); await fightAt(p, 3.2); await shot(p, 'atelier-nm-chiaroscuro-cut'); await fightAt(p, 16); await shot(p, 'atelier-nm-chiaroscuro-1');
    await fightAt(p, 26); await cam(p, { yaw: 2.4, pitch: 0.28, dist: 11 }); await sleep(800); await shot(p, 'atelier-nm-chiaroscuro-2');
    await hook(p, { fk: 8 }); await fightAt(p, 48); await shot(p, 'atelier-nm-chiaroscuro-step4');
  } },
  { name: 'atelier-nm-lastblow', async run(br, url) { const p = await atelier(br, url, 'shot-nl', { nm: true, phase: 2 }); await fightAt(p, 12); await hook(p, { ft: 383.4 }); await fightAt(p, 387); await shot(p, 'atelier-nm-lastblow'); } },
  { name: 'atelier-nm-kill', async run(br, url) { const p = await atelier(br, url, 'shot-nk', { nm: true, phase: 2 }); await fightAt(p, 14); await hook(p, { kill: true, hold: true }); await won(p); await drawn(p, 2.0); await shot(p, 'atelier-nm-kill-1'); await drawn(p, 3.0); await shot(p, 'atelier-nm-kill-2'); } },
  { name: 'atelier-watcher', async run(br, url) { // someone arrives 30 s in: the catch-up shows the paint already down
    const p = await atelier(br, url, 'shot-aw'); await fightAt(p, 30);
    const w = await page(br, url + '/?room=shot-aw&name=Wes'); await inFight(w); await fightAt(w, 33); await shot(p, 'atelier-watcher-player'); await shot(w, 'atelier-watcher');
  } },
  // Issen (solo): a full normal entry with the intro first, then each look from its phase
  { name: 'duelist-intro', async run(br, url) { // a first fight warms the shaders (software rendering takes longer than the intro), then a full entry with the intro
    const p = await duelist(br, url, 'shot-du'); await fightAt(p, 2); await p.evaluate(() => window.__axiom.net.send({ t: 'end' }));
    await p.waitForFunction(() => window.__axiom.S.phase === 'lobby', null, { timeout: 60000 });
    await start(p, 'duelist', false, { god: true }); await inFight(p);
    await p.waitForFunction(() => { const s = window.__axiom.net.latest; return s && s.state === 'intro'; }, null, { timeout: 60000 }); await drawn(p, 1.2); await shot(p, 'duelist-intro-1'); await drawn(p, 1.6); await shot(p, 'duelist-intro-2');
    await fightAt(p, 12); await shot(p, 'duelist-intro-fight-1'); await fightAt(p, 26); await cam(p, { yaw: 2.4, pitch: 0.3, dist: 11 }); await sleep(800); await shot(p, 'duelist-intro-fight-2');
  } },
  { name: 'duelist-deepen', async run(br, url) { const p = await duelist(br, url, 'shot-dd', { phase: 1 }); await fightAt(p, 10); await shot(p, 'duelist-deepen'); } },
  { name: 'duelist-night', async run(br, url) { const p = await duelist(br, url, 'shot-dn', { phase: 2 }); await fightAt(p, 10); await shot(p, 'duelist-night-1'); await fightAt(p, 22); await cam(p, { yaw: 2.6, pitch: 0.3, dist: 12 }); await sleep(800); await shot(p, 'duelist-night-2'); } },
  { name: 'duelist-kill', async run(br, url) { const p = await duelist(br, url, 'shot-dk', { phase: 2 }); await fightAt(p, 8); await hook(p, { kill: true, hold: true }); await won(p); await drawn(p, 0.6); await shot(p, 'duelist-kill-1'); await drawn(p, 1.6); await shot(p, 'duelist-kill-2'); } },
  { name: 'duelist-nm-lake', async run(br, url) { const p = await duelist(br, url, 'shot-nlk', { nm: true, phase: 2 }); await fightAt(p, 10); await shot(p, 'duelist-nm-lake-1'); await fightAt(p, 22); await cam(p, { yaw: 2.4, pitch: 0.3, dist: 12 }); await sleep(800); await shot(p, 'duelist-nm-lake-2'); } },
  { name: 'duelist-nm-rise', async run(br, url) { // Niten's entry mid-fight: the lake phase, then health to the threshold, then its cinematic
    const p = await duelist(br, url, 'shot-nr', { nm: true, phase: 2 }); await fightAt(p, 6); await hook(p, { hp: 0.655 });
    await p.waitForFunction(() => { const s = window.__axiom.net.latest; return s && s.cine && s.boss.phase === 3; }, null, { timeout: 60000 });
    await drawn(p, 1.5); await shot(p, 'duelist-nm-rise-1'); await drawn(p, 1.5); await shot(p, 'duelist-nm-rise-2'); await drawn(p, 1.5); await shot(p, 'duelist-nm-rise-3');
  } },
  { name: 'duelist-nm-niten', async run(br, url) { // Blade and Storm, then the ramp
    const p = await duelist(br, url, 'shot-nn', { nm: true, phase: 3 }); await fightAt(p, 14); await shot(p, 'duelist-nm-niten-1');
    await fightAt(p, 30); await cam(p, { yaw: 2.4, pitch: 0.32, dist: 13 }); await sleep(800); await shot(p, 'duelist-nm-niten-2');
    await hook(p, { ft: 300 }); await fightAt(p, 310); await shot(p, 'duelist-nm-niten-ramp');
  } },
  { name: 'duelist-nm-lastpetal', async run(br, url) { const p = await duelist(br, url, 'shot-np', { nm: true, phase: 3 }); await fightAt(p, 10); await hook(p, { ft: 377 });
    await p.waitForFunction(() => { const s = window.__axiom.net.latest; return s && s.t >= 378.9 && s.boss.pub.sheath; }, null, { timeout: 60000, polling: 30 }); await drawn(p, 0.3); await shot(p, 'duelist-nm-lastpetal-1'); await drawn(p, 3.5); await shot(p, 'duelist-nm-lastpetal-2'); } },
  { name: 'duelist-nm-kill', async run(br, url) { const p = await duelist(br, url, 'shot-nk2', { nm: true, phase: 3 }); await fightAt(p, 14); await killNow(p); await drawn(p, 1.5); await shot(p, 'duelist-nm-kill-1'); await drawn(p, 3.5); await shot(p, 'duelist-nm-kill-2'); } },
  { name: 'duelist-watcher', async run(br, url) { // someone arrives during the Nightmare's lake: the night sky, the lake and the ghosts are already there
    const p = await duelist(br, url, 'shot-dw', { nm: true, phase: 2 }); await fightAt(p, 20);
    const w = page(br, url + '/?room=shot-dw&name=Wes').then(async (q) => { await inFight(q); return q; }); let wp = null; w.then((q) => { wp = q; });
    while (!wp) { await hook(p, { hp: 0.72 }); await sleep(3000); } // he stays in the lake phase while the newcomer's page warms up
    await sleep(3000); await shot(p, 'duelist-watcher-player'); await shot(wp, 'duelist-watcher');
  } },
];

const srv = await server(), br = await browser();
console.log((GPU ? 'GPU (' + (process.env.TH_CHANNEL || 'chrome') + ')' : 'SwiftShader (software rendering)') + ' -> ' + OUT);
try {
  for (const sc of SCENES) { if (!only(sc.name)) continue; console.log(sc.name); try { await sc.run(br, srv.url); } catch (e) { console.log('  FAILED', e.message.split('\n')[0]); }
    while (open.length) await open.pop().close().catch(() => {}); }
} finally { await br.close(); srv.close(); }
