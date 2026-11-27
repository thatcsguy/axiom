// Math helpers carried over from Threshold's 01_core.js, plus a small Vec3 that stands in for THREE.Vector3.
// The sim never imports Three.js: positions are Vec3, and only the subset of the Vector3 API the rules use exists here.

export const TAU = Math.PI * 2, PI = Math.PI;

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const sat = (v) => clamp(v, 0, 1);
export const smooth = (t) => { t = sat(t); return t * t * (3 - 2 * t); };
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const wrapPi = (a) => { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; };
export const angDiff = (a, b) => wrapPi(b - a);
export const dampAng = (a, b, k, dt) => a + angDiff(a, b) * (1 - Math.exp(-k * dt));
// Angle convention everywhere: angle a points along (sin a, cos a) on XZ. 0 = +Z, PI/2 = +X. Matches Object3D.rotation.y.
export const angTo = (x0, z0, x1, z1) => Math.atan2(x1 - x0, z1 - z0);
export const dist2 = (x0, z0, x1, z1) => Math.hypot(x1 - x0, z1 - z0);
export const dirX = (a) => Math.sin(a), dirZ = (a) => Math.cos(a);

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  lerpVectors(a, b, t) { return this.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)); }
  toArray() { return [this.x, this.y, this.z]; }
}
export const V3 = Vec3;
