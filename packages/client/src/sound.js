// Plays the fight's sound: the sim's sound.* and music.* cues through Threshold's synthesiser (audio.js, imported unchanged).
//
// Where the cues come from (the same path as the pictures, docs/plan.md "How sim talks to the picture"):
// - the server's cues, when the drawn moment reaches their tick (net.dueCues), so a sound lines up with what it belongs to;
// - your own skills' cues straight from the prediction, the moment you press (self.js); the server's copy is dropped.
// Each fight's music starts with the fight (Threshold's 10_game.js: def.music at level 0) and follows the music.intensity
// cues the phases raise. Someone who joins mid-fight starts at the level of the phase under way.
//
// Several players: a sound raised by another player (their swing, their heal, their death) plays softer, and the ones that
// only make sense on your own screen (getting hit, cycling your target) are not played for them. The sim names the player
// a sound is about as the fourth argument when the acting player is not that player (player.js: hurt, heal, absorb, death).
import { Sound, Music, BOSS_MUSIC } from './audio.js';

const OTHERS = 0.45;                  // another player's sounds, against your own
const OWN_ONLY = { hurt: 1, ui: 1 };  // your screen only
// the music level each Nightmare phase sets (the boss files' phases[].music); Normal phases use their index (combat.js)
const NM_LEVELS = { duelist: [1, 2, 3, 5], atelier: [1, 2, 3] };
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d); // the cues cross JSON: a missing argument arrives as null

export { Sound, Music };
export const FightSound = {
  boss: null, nm: false,
  // a fight's first drawn snapshot: its music, at the level of the phase it is in
  start(boss, nm, phase) {
    this.boss = boss; this.nm = !!nm; Sound.init(); Music.stop(0.3);
    const m = BOSS_MUSIC[boss]; if (!m) return;
    const ph = Math.max(0, phase | 0), lvl = nm ? (NM_LEVELS[boss] || [])[ph] : ph;
    Music.play(nm ? m.nightmare : m.normal, lvl === undefined ? ph : lvl);
  },
  stop(fade = 1.5) { this.boss = null; Music.stop(fade); },
  // name: 'sound.<fn>' or 'music.<fn>'; actor: the player whose action raised it (null: the boss, the world); you: your id
  cue(name, args, actor, you) {
    if (name === 'music.intensity') { Music.intensity(num(args[0], 0)); return; }
    if (name === 'music.stop') { Music.stop(num(args[0], 1.5)); return; }
    if (name === 'sound.sfx') {
      const sfx = args[0]; if (typeof sfx !== 'string') return;
      const who = args[3] !== undefined && args[3] !== null ? args[3] : actor, other = who !== null && who !== undefined && who !== you;
      if (other && OWN_ONLY[sfx]) return;
      Sound.sfx(sfx, num(args[1], 1) * (other ? OTHERS : 1), num(args[2], 1));
      return;
    }
    if (name === 'sound.note') { Sound.note(num(args[0], 60), typeof args[1] === 'string' ? args[1] : 'organ', num(args[2], 0.8), num(args[3], 0.2)); return; }
    if (name === 'sound.tone' || name === 'sound.noise') { const o = args[0]; if (o && typeof o === 'object') { const q = Object.assign({}, o); delete q.when; delete q.bus; Sound[name.slice(6)](q); } }
  },
  // the menus' clicks (Threshold's 09_ui.js 'ui' and 'uiok')
  ui(ok) { Sound.sfx(ok ? 'uiok' : 'ui'); },
  applyVolume() { Sound.init(); Sound.applyVolume(); },
};
