// The messages between an Axiom client and the server, as JSON over one WebSocket (the plan's MessagePack is a drop-in
// change to encode / decode once the shapes settle).
//
// Client -> server
//   { t: 'hello', v, name }                 first message; the server answers 'welcome' and then 'lobby'
//   { t: 'class', cls }                     pick a class (in the lobby; on the training dummy it swaps on the spot)
//   { t: 'start', boss, nm }                pick an encounter: everyone in the lobby loads in. A boss locks the room until it ends;
//                                           the training dummy does not (people can walk in, change class, walk out)
//   { t: 'end' }                            end the encounter for everyone (back to the lobby)
//   { t: 'frames', k, fs: [<input frame>] } the predicting client, once per tick: the frames for ticks k - fs.length + 1 .. k
//                                           (the newest three, so a late message costs nothing). The server applies each on its
//                                           own tick, exactly as the client predicted (packages/client/src/self.js)
//   { t: 'input', f: <input frame> }        without prediction (tools, fake clients): the latest frame; presses and jumps are
//                                           kept until the next sim tick
//   { t: 'auto', on }                       hand your character to the autopilot (or take it back)
//   { t: 'addBot', cls } / { t: 'dropBot', id }   lobby: fill a seat with a server-side bot
//   { t: 'ping', c }                        answered with { t: 'pong', c } (once a second)
// Server -> client
//   { t: 'welcome', v, id, room, tickHz, classes, bosses }
//   { t: 'lobby', room, phase: 'lobby' | 'fight', enc, members: [{ id, name, cls, bot, inFight, sim }] }
//   { t: 'start', enc, you, tickHz }        the encounter is loading; `you` is your character's id in snapshots (null: watching)
//   { t: 'joined', you }                    you walked into a running training dummy, or changed class there
//   { t: 'snap', s: <snapshot>, c: [[cue, args, actor?], ...], me? }   once per tick: the whole picture, and the cues of that
//                                           tick (actor: the id of the player whose action raised the cue, when one did).
//                                           me (only in a player's own copy): { k: tick, id, cls, bot, st: their character's whole
//                                           state (sim ownState), ia: how many ticks early their frames arrive (lower tenth of the
//                                           last 2 s), late, miss: frames too late for their tick, ticks with no frame }
//   { t: 'end', result: 'win' | 'dead' | 'ended', ft, stats }
//   { t: 'note', text }                     something the player should read (a refused request, a locked room)
export const PROTOCOL_VERSION = 2;
export const MSG = { HELLO: 'hello', WELCOME: 'welcome', LOBBY: 'lobby', START: 'start', JOINED: 'joined', INPUT: 'input', SNAP: 'snap', END: 'end', NOTE: 'note' };

// The MVP's roster: Threshold's first two classes and two encounters. The sim keeps all four classes; the lobby offers these.
export const LOBBY_CLASSES = ['duskblade', 'stormcaller'];
export const ENCOUNTERS = ['dummy', 'atelier'];
export const MAX_PARTY = 4;   // a boss fight; the training dummy takes up to 8
export const MAX_NAME = 16;
export const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, MAX_NAME);

export const SLOTS = 7;      // hotbar slots 0-6
export const MAX_PRESSES = 4; // per tick; more is a broken or hostile client

// An input frame (see packages/sim/src/fight.js applyInput):
//   mx, mz   world-space move, length <= 1 (the camera stays client-side, so the client rotates its keys into the world)
//   held     bit i set while slot i is held (hold-to-repeat)
//   face     camera yaw while the player steers with the mouse, else absent
//   jump     1 to jump this tick
//   target   entity id to target          cycle  +1 / -1 to cycle targets
//   cancelQueue  1 to drop a buffered press
//   press    slots pressed this tick, in order
// sanitizeFrame never throws: anything malformed is dropped, so the server can apply whatever comes back.
export function sanitizeFrame(f) {
  const out = { mx: 0, mz: 0, held: 0, press: [] };
  if (!f || typeof f !== 'object') return out;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  if (fin(f.mx) && fin(f.mz)) { const l = Math.hypot(f.mx, f.mz); const k = l > 1 ? 1 / l : 1; out.mx = f.mx * k; out.mz = f.mz * k; }
  if (Number.isInteger(f.held)) out.held = f.held & ((1 << SLOTS) - 1);
  if (fin(f.face)) out.face = f.face;
  if (f.jump) out.jump = 1;
  if (Number.isInteger(f.target) && f.target > 0) out.target = f.target;
  if (f.cycle === 1 || f.cycle === -1) out.cycle = f.cycle;
  if (f.cancelQueue) out.cancelQueue = 1;
  if (Array.isArray(f.press)) for (const i of f.press.slice(0, MAX_PRESSES)) if (Number.isInteger(i) && i >= 0 && i < SLOTS) out.press.push(i);
  return out;
}

export const encode = (msg) => JSON.stringify(msg);
export function decode(data) { try { const m = JSON.parse(typeof data === 'string' ? data : String(data)); return m && typeof m.t === 'string' ? m : null; } catch (e) { return null; } }
