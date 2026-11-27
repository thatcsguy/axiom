// node tools/atelier-compare.js <fun-stuff/threshold/src> [outDir] [only]
// Pentimento side by side: the same moments of the fight in Threshold and in Axiom, seen from the same fixed camera, saved as
// pairs (<name>-threshold.png, <name>-axiom.png) and as one image with both (<name>.png, Threshold left, Axiom right).
// Both run the seeded autopilot in god mode with the intro skipped, so the paint differs in detail (two different fights)
// but every look is reached: the opening, Colour, the Negative, the roller, the Nightmare's Chiaroscuro, the kills.
// `only` keeps the moments whose name contains it.
//
// GPU: as tools/shots.js. On a machine with a graphics card (Patrick's PC):
//   TH_GPU=1 THREE_DIR=<unpacked three@0.170.0> node tools/atelier-compare.js ../fun-stuff/threshold/src compare-gpu
// Default is SwiftShader (software rendering), slow: about a minute of real time per moment.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TH = process.argv[2] && path.resolve(process.argv[2]);
if (!TH || !fs.existsSync(path.join(TH, '38_boss_atelier.js'))) { console.error('usage: node tools/atelier-compare.js <fun-stuff/threshold/src> [outDir] [only]'); process.exit(1); }
const TH_ROOT = path.resolve(TH, '../..'), OUT = path.resolve(process.argv[3] || 'compare'), ONLY = process.argv[4] || '';
const GPU = !!process.env.TH_GPU, THREE_DIR = process.env.THREE_DIR, W = +(process.env.SHOT_W || 1280), H = +(process.env.SHOT_H || 720);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// the moments: phase to start at, Nightmare, fight seconds to wait, the camera ('top': the whole canvas; 'fig': close on him),
// and what to do first (kill: he falls, then wait `after` seconds)
const MOMENTS = [
  { name: 'open', phase: 0, t: 14, cam: 'top' },
  { name: 'open-figure', phase: 0, t: 18, cam: 'fig' },
  { name: 'colour', phase: 1, t: 16, cam: 'top' },
  { name: 'negative', phase: 2, t: 16, cam: 'top' },
  { name: 'negative-figure', phase: 2, t: 20, cam: 'fig' },
  { name: 'nm-colour', nm: true, phase: 0, t: 14, cam: 'top' },
  { name: 'nm-chiaroscuro', nm: true, phase: 2, t: 16, cam: 'top' },
  { name: 'nm-chiaroscuro-figure', nm: true, phase: 2, t: 22, cam: 'fig' },
  { name: 'kill', phase: 0, t: 12, cam: null, kill: true, after: 1.2 },
  { name: 'nm-kill', nm: true, phase: 2, t: 16, cam: null, kill: true, after: 4.5 },
];
// a fixed camera (Threshold's Cam.cine, which both games share): the canvas from high on the window side, or close on him
const camFor = (kind, bx, bz) => kind === 'top' ? { pos: [0, 27, 27], look: [0, 0, 1], fov: 50 } : { pos: [bx + 5, 4.8, bz + 8], look: [bx, 3.3, bz], fov: 46 };

async function browser() {
  return chromium.launch(GPU
    ? { channel: process.env.TH_CHANNEL || 'chrome', headless: !process.env.TH_HEADED, args: ['--use-angle=' + (process.env.TH_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'default')), '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }
    : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}
async function context(br) {
  const ctx = await br.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  if (THREE_DIR) await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/, (route) => {
    const m = route.request().url().match(/three@[^/]+\/([^?#]*)/), f = path.join(THREE_DIR, m[1]);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
  });
  await ctx.route(/^http:\/\/threshold\.local\/(.*)$/, (route) => { // Threshold's page, served from the checkout
    let p = decodeURIComponent(new URL(route.request().url()).pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(TH_ROOT, p); if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'text/plain', body: fs.readFileSync(f) });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  return { ctx, p };
}

async function threshold(br, m) {
  const { ctx, p } = await context(br);
  try {
    await p.goto(`http://threshold.local/threshold/?mute=1&quality=high&seed=5&class=stormcaller&bot=3&god&skipintro&boss=atelier&phase=${m.phase}${m.nm ? '&nm=1' : ''}`);
    await p.waitForFunction(() => window.__game && window.__game.G.state === 'fight', null, { timeout: 120000 });
    await p.evaluate(() => { const f = document.getElementById('fade'); if (f) f.style.transition = 'none'; });
    await p.waitForFunction((t) => window.__game.G.ft >= t, m.t, { timeout: 900000, polling: 250 });
    if (m.kill) { const r0 = await p.evaluate(() => { window.__game.kill(); return window.__game.G.rt; }); await p.waitForFunction((q) => window.__game.G.rt >= q, r0 + m.after, { timeout: 300000, polling: 50 }); }
    else await setCam(p, m, 'th');
    const f = path.join(OUT, m.name + '-threshold.png'); await p.screenshot({ path: f }); return f;
  } finally { await ctx.close(); }
}
async function axiom(br, url, m) {
  const { ctx, p } = await context(br);
  try {
    await p.goto(url + '/?room=cmp-' + m.name + '&name=Pat');
    await p.waitForFunction(() => window.__axiom && window.__axiom.S.lobby, null, { timeout: 30000 });
    await p.evaluate(() => { window.__axiom.net.send({ t: 'class', cls: 'stormcaller' }); window.__axiom.net.send({ t: 'auto', on: true }); });
    await p.evaluate((m) => window.__axiom.net.send({ t: 'start', boss: 'atelier', nm: !!m.nm, phase: m.phase, skipIntro: true, god: true }), m);
    await p.waitForFunction(() => window.__axiom.S.phase === 'fight' && window.__axiom.net.latest, null, { timeout: 30000 });
    await p.waitForFunction((t) => { const s = window.__axiom.net.latest; return s && s.t >= t; }, m.t, { timeout: 900000, polling: 250 });
    if (m.kill) { // the kill plays when the drawing reaches it (a tenth of a second behind the server): wait on the drawing's own clock
      await p.evaluate(() => window.__axiom.net.send({ t: 'test', o: { kill: true, hold: true } }));
      await p.waitForFunction(() => document.querySelector('#banner') && !document.querySelector('#banner').hidden, null, { timeout: 60000, polling: 50 });
      const r0 = await p.evaluate(() => window.__axiom.G.rt); await p.waitForFunction((q) => window.__axiom.G.rt >= q, r0 + m.after, { timeout: 300000, polling: 50 }); }
    else { await p.addStyleTag({ content: 'body.cine::before, body.cine::after { display: none; }' }); await setCam(p, m, 'ax'); } // Axiom's cinematic letterbox off, as Threshold has none
    const f = path.join(OUT, m.name + '-axiom.png'); await p.screenshot({ path: f });
    console.log('  axiom', JSON.stringify(await p.evaluate(() => window.__axiom.S.view.info())));
    return f;
  } finally { await ctx.close(); }
}
// fly the shared cinematic camera to the moment's view, hold it while the blend settles
async function setCam(p, m, which) {
  await p.evaluate(([m, which, src]) => {
    const camFor = new Function('return ' + src)();
    const Cam = which === 'th' ? window.__game.Cam : window.__axiom.S.view.cam, THREE = which === 'th' ? window.__game.THREE || null : null;
    const b = which === 'th' ? window.__game.G.boss.pos : window.__axiom.S.view.bossF.pos, c = camFor(m.cam, b.x, b.z);
    const V = Cam.cPos.constructor; Cam.cine = { pos: new V(...c.pos), look: new V(...c.look), fov: c.fov }; Cam.cineW = 1; void THREE;
  }, [m, which, camFor.toString()]);
  await sleep(1500);
}
// both pictures in one: a page with the two side by side, captioned
async function pair(br, m, a, b) {
  const ctx = await br.newContext({ viewport: { width: W * 2 + 12, height: H + 36 }, deviceScaleFactor: 1 }), p = await ctx.newPage();
  const img = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  await p.setContent(`<body style="margin:0;background:#111;color:#ddd;font:15px sans-serif"><div style="display:flex;gap:12px"><figure style="margin:0"><img src="${img(a)}" width="${W}"><figcaption style="padding:6px">Threshold: ${m.name}</figcaption></figure><figure style="margin:0"><img src="${img(b)}" width="${W}"><figcaption style="padding:6px">Axiom: ${m.name}</figcaption></figure></div></body>`);
  await p.screenshot({ path: path.join(OUT, m.name + '.png') }); await ctx.close();
}

const { startServer } = await import(path.join(ROOT, 'packages/server/src/server.js'));
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, test: true }), url = `http://127.0.0.1:${srv.port}`;
const br = await browser();
console.log((GPU ? 'GPU' : 'SwiftShader') + ' -> ' + OUT);
try {
  for (const m of MOMENTS) {
    if (ONLY && !m.name.includes(ONLY)) continue; console.log(m.name);
    try { const [a, b] = [await threshold(br, m), await axiom(br, url, m)]; await pair(br, m, a, b); } catch (e) { console.log('  FAILED', e.message.split('\n')[0]); }
  }
} finally { await br.close(); await Promise.race([srv.close(), sleep(3000)]); }
process.exit(0);
