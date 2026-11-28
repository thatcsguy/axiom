// node tools/soundcheck.js   the client's sound and settings, in a real browser against a real server
//
// Every Sound.sfx / Music call the page makes is recorded (window.__axiom.sound), and these are checked:
//   - the Training Dummy: a skill pressed on the keyboard plays its sound once (the prediction's copy, not the server's
//     too); a skill rebound in Settings (slot 1 to Z) fires from the new key; the volumes reach the synthesiser
//   - two players on the dummy: the other player's skill sounds play softer on your page, their hurt never does
//   - Pentimento with the autopilot: the music starts at level 0 and follows the phases; the boss's own sounds play
// Needs Playwright (NODE_PATH) and THREE_DIR (an unpacked three@0.170.0 npm package; the sandbox cannot reach jsDelivr).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), THREE_DIR = process.env.THREE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) fails++; };

const { startServer } = await import(path.join(ROOT, 'packages/server/src/server.js'));
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, test: true });
const URL0 = `http://127.0.0.1:${srv.port}/packages/client/?quality=low`;
const br = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
async function page(q) {
  const ctx = await br.newContext({ viewport: { width: 960, height: 600 } });
  if (THREE_DIR) await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/, (route) => {
    const m = route.request().url().match(/three@[^/]+\/([^?#]*)/), f = path.join(THREE_DIR, m[1]);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('  [pageerror]', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); fails++; });
  await p.goto(URL0 + q);
  await p.waitForFunction(() => window.__axiom && window.__axiom.S.lobby, null, { timeout: 90000 });
  await p.evaluate(() => { // record what the synthesiser is asked to play
    const A = window.__axiom.sound, log = window.__snd = { sfx: [], music: [] };
    const sfx = A.Sound.sfx.bind(A.Sound); A.Sound.sfx = (n, v = 1, p = 1) => { log.sfx.push([n, +v.toFixed(3), performance.now()]); return sfx(n, v, p); };
    const play = A.Music.play.bind(A.Music); A.Music.play = (s, l) => { log.music.push(['play', s.bpm, l]); return play(s, l); };
    const it = A.Music.intensity.bind(A.Music); A.Music.intensity = (n) => { log.music.push(['level', n]); return it(n); };
  });
  await p.mouse.click(5, 5); // a gesture: the audio context starts
  return p;
}
const log = (p) => p.evaluate(() => window.__snd);
const clear = (p) => p.evaluate(() => { window.__snd.sfx.length = 0; window.__snd.music.length = 0; });
const send = (p, m) => p.evaluate((m) => window.__axiom.net.send(m), m);
const inFight = (p) => p.waitForFunction(() => window.__axiom.S.phase === 'fight' && window.__axiom.self && window.__axiom.self.ready, null, { timeout: 60000 });
const count = (L, n) => L.sfx.filter((q) => q[0] === n);

console.log('Training Dummy, Stormcaller, solo');
const a = await page('&room=snd1&name=A');
await send(a, { t: 'class', cls: 'stormcaller' }); await sleep(300);
await send(a, { t: 'start', boss: 'dummy' }); await inFight(a); await sleep(5000); // software rendering: let the clocks settle
check(await a.evaluate(() => { const S = window.__axiom.sound.Sound; return !!S.ctx && S.ctx.state === 'running'; }), 'the audio context runs');
await clear(a); await a.keyboard.press('Digit1'); await sleep(1500);
let L = await log(a);
check(count(L, 'cast').length === 1, `one press of 1 plays one cast sound, not the server's copy too (got ${count(L, 'cast').length}: ${L.sfx.map((q) => q[0]).join(' ')})`);
// rebind slot 1 to Z in Settings, through the screen
await a.keyboard.press('Escape'); await sleep(200);
await a.click('#mset'); await sleep(300);
check(await a.isVisible('#settings'), 'Settings opens from the Esc menu');
await a.click('#binds .bk[data-id="s0"][data-i="0"]'); await sleep(100);
await a.keyboard.press('KeyZ'); await sleep(200);
check(await a.evaluate(() => window.__axiom.Binds.get('kbm', 's0')[0] === 'KeyZ'), 'slot 1 rebound to Z');
check(await a.evaluate(() => window.__axiom.Binds.get('kbm', 's6')[0] === 'KeyF'), 'slot 7 keeps F');
await a.evaluate(() => { const n = document.querySelector('#set-vol'); n.value = 40; n.dispatchEvent(new Event('input')); const m = document.querySelector('#set-mus'); m.value = 20; m.dispatchEvent(new Event('input')); });
const vols = await a.evaluate(() => { const S = window.__axiom.sound.Sound; return [S.master.gain.value, S.musBus.gain.value, JSON.parse(localStorage.getItem('axiom_settings')).vol]; });
check(Math.abs(vols[0] - 0.4) < 1e-6 && Math.abs(vols[1] - 0.11) < 1e-6 && vols[2] === 40, `volumes reach the synthesiser and are saved (${vols})`);
await a.click('#set-back'); await sleep(200); await a.click('#mback'); await sleep(200);
check(await a.evaluate(() => document.querySelector('#hotbar .slot .key').textContent) === 'Z', 'the hotbar shows Z');
await clear(a); await a.keyboard.press('Digit1'); await sleep(800); L = await log(a);
check(count(L, 'cast').length === 0, 'the old key 1 does nothing');
await a.keyboard.press('KeyZ'); await sleep(1200); L = await log(a);
check(count(L, 'cast').length === 1, 'Z casts');
await a.evaluate(() => { window.__axiom.Binds.reset('kbm'); });

console.log('Training Dummy, with a server bot (another player)');
await a.close();
const b = await page('&room=snd3&name=B');
await send(b, { t: 'class', cls: 'stormcaller' }); await send(b, { t: 'addBot', cls: 'stormcaller' }); await sleep(500);
await send(b, { t: 'start', boss: 'dummy' }); await inFight(b); await sleep(4000);
await clear(b); await sleep(6000);
let Lb = await log(b);
const bc = count(Lb, 'bolt').concat(count(Lb, 'cast'));
check(bc.length > 0, `the bot's skills are heard (${bc.length} bolt/cast sounds)`);
check(bc.length > 0 && bc.every((q) => q[1] <= 0.46), `softer than your own (volumes ${[...new Set(bc.map((q) => q[1]))].join(', ')})`);
await clear(b); await b.keyboard.press('Digit1'); await sleep(1500); Lb = await log(b);
const mine = count(Lb, 'cast').filter((q) => q[1] > 0.5);
check(mine.length === 1, `your own cast at full volume (${mine.map((q) => q[1])})`);
await b.close();

console.log('Pentimento, autopilot');
const c = await page('&room=snd2&name=C');
await send(c, { t: 'auto', on: true }); await sleep(300);
await send(c, { t: 'start', boss: 'atelier' }); await c.waitForFunction(() => window.__axiom.S.phase === 'fight', null, { timeout: 60000 });
await sleep(25000);
L = await log(c);
const pl = L.music.find((q) => q[0] === 'play');
check(pl && pl[1] === 100, 'Pentimento music plays (100 bpm)');
check(L.music.some((q) => q[0] === 'level' && q[1] === 0), `music at level 0 for phase 1 (${JSON.stringify(L.music)})`);
const names = [...new Set(L.sfx.map((q) => q[0]))];
check(names.length >= 5, 'the fight plays its sounds: ' + names.join(' '));
check(await c.evaluate(() => !!window.__axiom.sound.Music.spec), 'the sequencer is running');
await send(c, { t: 'end' }); await sleep(2500);
check(await c.evaluate(() => !window.__axiom.sound.Music.spec), 'the music stops when the fight ends');

await br.close(); srv.close && srv.close();
console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
