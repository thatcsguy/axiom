// @axiom/sim: the headless rules of Axiom. No Three.js, no DOM: runs in Node (server, tools, tests) and in a browser worker.
// Importing this registers the four classes; import './bosses/index.js' (or '@axiom/sim/bosses') to register the fights.
export { G, Co, Hooks, rnd, rndi, pick, shuffle, NM } from './core.js';
export { createRng } from './rng.js';
export * from './math.js';
export { View, Cam } from './view.js';
export { Hz, Bul, Ent, Boss } from './combat.js';
export { Player } from './player.js';
import './classes.js';
export { MELEE } from './classes.js';
export { Bot, emptyFrame } from './bot.js';
export { TICK_HZ, startFight, tick, applyInput, nightmareDef, currentFight, over } from './fight.js';
export { stateHash } from './hash.js';
export { snapshot } from './snapshot.js';
export { record, replay } from './replay.js';
