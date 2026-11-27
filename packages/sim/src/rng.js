// Seeded randomness. Same mulberry32 stream as Threshold (01_core.js), but the state is readable and settable,
// so it can go into the per-tick state hash and, later, into a snapshot.
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  Object.defineProperty(next, 'state', { get: () => a >>> 0, set: (v) => { a = v >>> 0; } });
  return next;
}
// Threshold's name for the same thing, kept so carried-over code reads the same.
export const mulberry = createRng;
