// The sim's only door to the picture. Threshold's rules call FX, Sound, Music, Post, UI and Cam directly; in Axiom those
// names are stand-ins that turn every call into a one-shot cue (channel 3 of docs/plan.md, "How sim talks to the picture").
// With no sink attached, cues are dropped and the sim runs exactly as headless. A client (or a test) attaches a sink to
// receive them: View.setSink((name, args) => ...). Cue arguments are copied to plain data (Vec3 -> [x, y, z]) because
// the rules reuse scratch vectors.
//
// Rule for ported code: a cue may never change sim state, and nothing in the sim may depend on whether a sink is attached.
// test/determinism.test.js checks that a run with a sink attached hashes the same as one without.

let sink = null;

function plain(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number' && !Array.isArray(v)) return [v.x, v.y, v.z];
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.map((q) => plain(q, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) { const q = plain(v[k], depth + 1); if (q !== undefined) o[k] = q; }
  return o;
}

export const View = {
  get listening() { return !!sink; },
  setSink(fn) { sink = typeof fn === 'function' ? fn : null; },
  cue(name, ...args) { if (sink) sink(name, args.map((a) => plain(a))); },
};

// Any method call on one of these becomes the cue '<ns>.<method>'.
function cues(ns, extra = {}) {
  return new Proxy(extra, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string' || key === 'then') return undefined;
      return (...args) => { if (sink) sink(ns + '.' + key, args.map((a) => plain(a))); };
    },
  });
}

export const FX = cues('fx');
export const Sound = cues('sound');
export const Music = cues('music');
export const UI = cues('ui');
export const Hitch = { mark() { }, reset() { } }; // Threshold's freeze log: client-only
export const Post = cues('post', {
  // a mid-fight regrade; the sim only announces it (the coroutine ends at once)
  *lerpTo(o, dur = 2) { View.cue('post.lerpTo', o, dur); },
});

// Cinematic camera. The camera itself is client-side, but whether a cinematic is playing is a rule: every shot locks
// every player (Threshold PR #86, the cinematic input lock). So Cam.cine lives in the sim, and Cam.shot waits in sim time.
export const Cam = {
  cine: null, yaw: 0,
  *shot(p0, l0, p1, l1, dur, fov = 48) {
    const c = { p0, l0, p1, l1, dur, fov }; this.cine = c; View.cue('cam.shot', p0, l0, p1, l1, dur, fov);
    let t = 0; while (t < dur) { t += Sim_dt(); if (this.cine !== c) return; yield; }
  },
  release() { this.cine = null; View.cue('cam.release'); },
  reset() { this.cine = null; },
};
// set by core.js (avoids an import cycle)
let dtSource = () => 0;
export function bindDt(fn) { dtSource = fn; }
function Sim_dt() { return dtSource(); }
