// node tools/sim.js [boss] [classes|all|party:a,b,..] [runs] [nm]    bot fights in Node, one line per run, then a summary per class.
// party:duskblade,stormcaller runs one party of bots together (health scales with the party) instead of one class at a time.
// Env: GOD=1 (no damage at all, like Threshold's __game.god: pace only), GODMODE=1 (Settings > Testing > God mode: hits land,
// health stays at 1 or more), LEVEL=1..3 (bot skill, default 3), SEED=n (first seed, default 1), HZ=n (tick rate, default 30).
import { startFight, tick, over, G } from '@axiom/sim';
import '@axiom/sim/bosses';

const [boss = 'atelier', clsArg = 'all', runs = '4', nmArg = ''] = process.argv.slice(2);
const nm = nmArg === 'nm' || nmArg === '1';
const partyOf = clsArg.startsWith('party:') ? clsArg.slice(6).split(',') : null;
const classes = partyOf ? [clsArg] : clsArg === 'all' ? G.classes.map((c) => c.id) : clsArg.split(',');
const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const seed0 = +(process.env.SEED || 1), hz = +(process.env.HZ || 30);
for (const cls of classes) {
  const res = [];
  for (let k = 0; k < +runs; k++) {
    const t0 = performance.now();
    startFight({ boss, cls, players: partyOf ? partyOf.map((c) => ({ cls: c })) : undefined, seed: seed0 + k, nm, bot: +(process.env.LEVEL || 3), god: !!process.env.GOD, godMode: !!process.env.GODMODE, tickHz: hz });
    for (let n = hz * 900; n > 0 && !over(); n--) tick();
    const b = G.boss, p = G.player, src = p.deathSrc && (typeof p.deathSrc === 'string' ? p.deathSrc : p.deathSrc.name || 'hit');
    res.push({ win: G.state === 'win', t: G.ft });
    console.log(`${cls.padEnd(12)} seed ${String(seed0 + k).padEnd(4)} ${G.state === 'win' ? 'KILL' : G.state === 'dead' ? 'DEAD' : 'TIME'} ${fmt(G.ft)}  boss ${(b.hp / b.maxHp * 100).toFixed(1).padStart(5)}%  phase ${b.phase + 1}  dps ${G.players.map((q) => Math.round(q.stats.dmg / Math.max(1, G.ft))).join('/')}  taken ${Math.round(p.stats.taken)}${src ? '  died to ' + src : ''}${G.errors.length ? '  ERRORS ' + G.errors[0] : ''}  (${Math.round(performance.now() - t0)} ms)`);
  }
  const kills = res.filter((r) => r.win).map((r) => r.t).sort((x, y) => x - y);
  console.log(`${cls}: ${kills.length}/${res.length} kills${kills.length ? `, median ${fmt(kills[kills.length >> 1])}, best ${fmt(kills[0])}, worst ${fmt(kills[kills.length - 1])}` : ''}\n`);
}
