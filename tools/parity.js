// node tools/parity.js [boss] [classes|all] [nm] [seed] [sec]
// Plays the same seeded bot fight in Threshold (in Chromium, through Threshold's own test harness) and in Axiom's sim
// (in Node, 60 Hz like Threshold's fastForward), and compares boss health and player position (to 1e-6 m) every second.
// A match means the port carried the rules over unchanged. Not part of npm test: it needs a Threshold checkout and a browser.
//
// Needs: TH_ROOT = a fun-stuff checkout (default ../fun-stuff), THREE_DIR = an unpacked three@0.170.0 npm package
// (npm pack three@0.170.0 && tar xzf three-0.170.0.tgz), and Playwright resolvable from NODE_PATH (e.g. NODE_PATH=$(npm root -g)).
//
// Known: Chromium's and Node's V8 can disagree in the last bit of Math.sin / Math.cos. The bot picks between near-equal
// spots, so a fight can split there after a while even with identical rules (2026-11-26: 6 of 8 Pentimento fights matched
// to the end, the other 2 split on one cosine). tools/parity.js prints where a split starts; check it with a probe before
// calling it a port bug.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFight, tick, over, G } from '@axiom/sim';
import '@axiom/sim/bosses';

const here = path.dirname(fileURLToPath(import.meta.url));
const TH = path.resolve(process.env.TH_ROOT || path.join(here, '../../fun-stuff'));
const [boss = 'atelier', clsArg = 'all', nmArg = '1', seed = '7', sec = '600'] = process.argv.slice(2);
const nm = nmArg === '1' || nmArg === 'nm', classes = clsArg === 'all' ? ['duskblade', 'stormcaller', 'ashwarden', 'hexslinger'] : clsArg.split(',');
process.env.TH_ROOT = TH;
const { launch } = createRequire(import.meta.url)(path.join(TH, 'threshold/tools/harness.js'));

function axiomRun(cls) {
  startFight({ boss, cls, seed: +seed, nm, bot: 3, god: true, tickHz: 60 });
  const rows = [];
  for (let i = 1; i <= +sec * 60 && !over(); i++) { tick(); if (i % 60 === 0) rows.push([i, G.boss.hp, +G.player.pos.x.toFixed(6), +G.player.pos.z.toFixed(6)]); }
  return rows;
}

const { browser, page } = await launch({ w: 320, h: 200 });
await page.goto('http://game.local/threshold/?mute=1&quality=low');
await page.waitForFunction('window.__game && window.__game.G.state === "menu"', null, { timeout: 90000 });
let bad = 0;
for (const cls of classes) {
  const th = await page.evaluate(([boss, cls, seed, nm, sec]) => {
    const g = window.__game, G = g.G;
    const mul = (s) => { let a = s >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
    G.rng = mul(seed); g.god(true); g.bot(3); g.Bot.goal = null; g.Bot.timer = 0; g.Bot.pressT = 0;
    g.start(boss, { cls, nm, noRehearsal: true }); // the rehearsal leaves the bot's goal behind, which would differ from a fresh start
    G.headless = true; const rows = [], dt = 1 / 60;
    try { for (let i = 1; i <= sec * 60; i++) { g.Bot.update(dt); G.step(dt * G.timeScale); if (i % 60 === 0) rows.push([i, G.boss.hp, +G.player.pos.x.toFixed(6), +G.player.pos.z.toFixed(6)]); if (G.state === 'win' || G.state === 'dead') break; } } finally { G.headless = false; }
    return rows;
  }, [boss, cls, +seed, nm, +sec]);
  const ax = axiomRun(cls), n = Math.min(th.length, ax.length);
  const i = th.findIndex((r, k) => k < n && JSON.stringify(r) !== JSON.stringify(ax[k]));
  if (i < 0 && th.length === ax.length) console.log(`${cls.padEnd(12)} MATCH: ${n} s identical (boss ${th[n - 1][1]} hp at the last sample)`);
  else { bad++; const k = i < 0 ? n : i; console.log(`${cls.padEnd(12)} SPLIT at ${k + 1} s  threshold ${JSON.stringify(th[k] || 'ended')}  axiom ${JSON.stringify(ax[k] || 'ended')}`); }
}
await browser.close();
console.log(bad ? `${bad} of ${classes.length} split (see the note at the top of this file)` : 'all match');
