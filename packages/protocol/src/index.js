// The messages between an Axiom client and the server. JSON for now; the plan's MessagePack is a drop-in change to
// encode/decode once the shapes settle. Nothing here is wired to a socket yet (plan step 3).
//
// Client -> server, once per tick:   { t: 'input', tick, f: <input frame> }
// Server -> client:                  { t: 'welcome', v, room, you, tickHz, setup }
//                                     { t: 'snap', tick, s: <snapshot from @axiom/sim snapshot()> }
//                                     { t: 'cues', tick, c: [[name, args], ...] }
//                                     { t: 'end', state, ft }
export const PROTOCOL_VERSION = 1;
export const MSG = { HELLO: 'hello', WELCOME: 'welcome', INPUT: 'input', SNAP: 'snap', CUES: 'cues', END: 'end' };

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
