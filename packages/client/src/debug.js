// Axiom debug viewer: draws the fight top-down from the worker's snapshots. Plan step 2 replaces this with the Three.js
// view half; until then it is the quickest way to watch the sim, or to play it, in a browser.
const QS = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s), cv = $('#c'), ctx = cv.getContext('2d');
const HEX = ['#ffffff', '#e23a2e', '#f2c218', '#f08a1e', '#2a5fe0', '#8a3cd0', '#2aa858', '#5c4332'];
const PIG = ['white', 'red', 'yellow', 'orange', 'blue', 'purple', 'green', 'brown'];
const hex = (n) => typeof n === 'number' ? '#' + n.toString(16).padStart(6, '0') : n || '#ff5a2a';
let snap = null, grid = null, botOn = QS.has('bot') ? +QS.get('bot') || 3 : 0;

$('#cls').value = QS.get('class') || 'stormcaller'; $('#diff').value = QS.get('nm') ? '1' : '0';
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => { if (e.data.t === 'snap') { snap = e.data.s; if (e.data.grid) grid = e.data.grid; } };
function start() {
  worker.postMessage({ t: 'start', setup: { boss: QS.get('boss') || 'atelier', cls: $('#cls').value, nm: $('#diff').value === '1', seed: +(QS.get('seed') || (Date.now() & 0xffff)), intro: !QS.has('skipintro') } });
  worker.postMessage({ t: 'bot', level: botOn }); grid = null;
}
$('#go').onclick = start; $('#cls').onchange = start; $('#diff').onchange = start; start();

// ---- input: keys -> one world-space input frame, sent on every change
const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'], down = new Set();
function send(extra = {}) {
  const x = (down.has('KeyD') ? 1 : 0) - (down.has('KeyA') ? 1 : 0), z = (down.has('KeyS') ? 1 : 0) - (down.has('KeyW') ? 1 : 0), l = Math.hypot(x, z) || 1;
  let held = 0; SLOT_KEYS.forEach((k, i) => { if (down.has(k)) held |= 1 << i; });
  worker.postMessage({ t: 'input', f: Object.assign({ mx: x / l, mz: z / l, held, press: [] }, extra) });
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.code === 'Tab') { e.preventDefault(); send({ cycle: 1 }); return; }
  if (e.repeat) return; down.add(e.code);
  const i = SLOT_KEYS.indexOf(e.code);
  if (i >= 0) send({ press: [i] }); else if (e.code === 'Space') { e.preventDefault(); send({ jump: 1 }); }
  else if (e.code === 'KeyB') { botOn = botOn ? 0 : 3; worker.postMessage({ t: 'bot', level: botOn }); } else send();
});
addEventListener('keyup', (e) => { down.delete(e.code); send(); });
addEventListener('blur', () => { down.clear(); send(); });

// ---- drawing
let W = 0, H = 0, S = 1, dpr = 1;
function resize() { dpr = devicePixelRatio || 1; W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
addEventListener('resize', resize); resize();
const sx = (x) => W / 2 + x * S, sy = (z) => H / 2 + z * S + 20;
function shapePath(s) {
  ctx.beginPath();
  if (s.type === 'circle') ctx.arc(sx(s.x), sy(s.z), s.r * S, 0, Math.PI * 2);
  else if (s.type === 'donut') { ctx.arc(sx(s.x), sy(s.z), s.r1 * S, 0, Math.PI * 2); ctx.arc(sx(s.x), sy(s.z), s.r0 * S, 0, Math.PI * 2, true); }
  else if (s.type === 'cone') { const a0 = Math.PI / 2 - s.dir - s.arc / 2, a1 = Math.PI / 2 - s.dir + s.arc / 2; ctx.arc(sx(s.x), sy(s.z), s.r * S, a0, a1); ctx.arc(sx(s.x), sy(s.z), (s.r0 || 0) * S, a1, a0, true); ctx.closePath(); }
  else { const fx = Math.sin(s.dir), fz = Math.cos(s.dir), px = fz, pz = -fx, h = s.w / 2, P = [[s.x + px * h, s.z + pz * h], [s.x + px * h + fx * s.len, s.z + pz * h + fz * s.len], [s.x - px * h + fx * s.len, s.z - pz * h + fz * s.len], [s.x - px * h, s.z - pz * h]]; P.forEach(([x, z], i) => i ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))); ctx.closePath(); }
}
function bar(x, y, w, k, col) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, w, 5); ctx.fillStyle = col; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, k)), 5); }
function frame() {
  requestAnimationFrame(frame);
  const dark = !matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  ctx.fillStyle = dark ? '#101116' : '#f2f0ea'; ctx.fillRect(0, 0, W, H);
  if (!snap || !snap.arena) return;
  const R = snap.arena.radius, pub = snap.boss.pub || {}; S = Math.min(W, H - 60) / (2 * R + 4);
  // canvas floor (the Negative turns it dark)
  ctx.fillStyle = pub.neg ? '#16161c' : '#e9e3d6'; ctx.beginPath(); ctx.arc(sx(0), sy(0), R * S, 0, Math.PI * 2); ctx.fill();
  if (grid) { const GN = Math.round(Math.sqrt(grid.length)), C = 2 * R / GN; for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) { const v = grid[j * GN + i], m = v & 7; if (!m) continue; ctx.globalAlpha = v & 8 ? 0.9 : 0.35; ctx.fillStyle = HEX[m]; ctx.fillRect(sx(i * C - R), sy(j * C - R), C * S + 0.5, C * S + 0.5); } ctx.globalAlpha = 1; }
  // the finale's split: the black half
  if (pub.split) { const A = pub.lineA, ca = Math.cos(A), sa = Math.sin(A); ctx.save(); ctx.beginPath(); ctx.arc(sx(0), sy(0), R * S, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); const n = [-ca, sa]; const t = [sa, ca]; ctx.moveTo(sx(t[0] * 30), sy(t[1] * 30)); ctx.lineTo(sx(t[0] * 30 + n[0] * 30), sy(t[1] * 30 + n[1] * 30)); ctx.lineTo(sx(-t[0] * 30 + n[0] * 30), sy(-t[1] * 30 + n[1] * 30)); ctx.lineTo(sx(-t[0] * 30), sy(-t[1] * 30)); ctx.fill(); ctx.restore(); }
  if (pub.wash) { ctx.strokeStyle = '#5ab0e0'; ctx.lineWidth = 3; ctx.fillStyle = 'rgba(159,216,240,0.7)'; ctx.beginPath(); ctx.arc(sx(pub.wash.x), sy(pub.wash.z), pub.wash.r * S, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  ctx.strokeStyle = dark ? '#555' : '#999'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(0), sy(0), R * S, 0, Math.PI * 2); ctx.stroke();
  // hazards: outline while telegraphing (fill grows with the timer), solid while a zone burns, flash when fired
  for (const h of snap.hazards) {
    const col = pub.neg ? '#f4f4ff' : hex(h.color); shapePath(h.shape);
    if (h.state === 'tele') { ctx.globalAlpha = 0.12 + 0.3 * Math.min(1, h.t / Math.max(h.delay, 1e-3)); ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); }
    else if (h.state === 'zone') { ctx.globalAlpha = h.dmg ? 0.35 : 0.15; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; }
    else if (h.state === 'fired') { ctx.globalAlpha = 0.6; ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.globalAlpha = 1; }
  }
  if (pub.roll) { const q = pub.roll, fx = Math.sin(q.a), fz = Math.cos(q.a), x = q.cx + fx * q.s, z = q.cz + fz * q.s; ctx.strokeStyle = HEX[q.m]; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(sx(x + fz * 6), sy(z - fx * 6)); ctx.lineTo(sx(x - fz * 6), sy(z + fx * 6)); ctx.stroke(); }
  for (const b of snap.bullets) { ctx.fillStyle = hex(b.color); ctx.beginPath(); ctx.arc(sx(b.x), sy(b.z), Math.max(2, b.r * S), 0, Math.PI * 2); ctx.fill(); }
  // entities
  const p = snap.player;
  for (const e of snap.ents) {
    if (!e.alive) continue; const x = sx(e.x), y = sy(e.z), r = Math.max(4, e.radius * S);
    ctx.fillStyle = e.boss ? (pub.flood ? '#ffffff' : HEX[pub.col] || '#f0e8d8') : hex(e.color); ctx.strokeStyle = e.id === (p && p.target) ? '#f0c060' : '#222'; ctx.lineWidth = e.id === (p && p.target) ? 3 : 1.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(e.facing) * r * 1.6, y + Math.cos(e.facing) * r * 1.6); ctx.stroke();
    if (e.boss && pub.shell) { ctx.strokeStyle = '#d8a050'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 6, 0, Math.PI * 2); ctx.stroke(); }
    if (e.cast) { bar(x - 30, y - r - 14, 60, e.cast.t / e.cast.time, '#f0c060'); ctx.fillStyle = dark ? '#fff' : '#000'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(e.cast.name, x, y - r - 18); }
  }
  if (p) {
    const x = sx(p.x), y = sy(p.z), r = Math.max(4, 0.45 * S) * (1 + Math.max(0, p.y) * 0.15);
    if (pub.wear) { ctx.strokeStyle = HEX[pub.wear]; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = p.alive ? '#40d0ff' : '#666'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(p.facing) * r * 2, y + Math.cos(p.facing) * r * 2); ctx.stroke();
    if (p.casting) bar(x - 25, y + r + 6, 50, p.casting.t / p.casting.time, '#40d0ff');
  }
  // HUD
  const b = snap.ents.find((e) => e.boss);
  const call = pub.call ? `${pub.call.tone === 'w' ? 'white' : 'black'} half, ${PIG[pub.call.col]}` : '';
  $('#boss').innerHTML = `<b>${snap.boss.name}</b>${snap.nm ? ' (Nightmare)' : ''}   phase ${snap.boss.phase + 1}\n${(b.hp / b.maxHp * 100).toFixed(1)}%  ${b.hp} / ${b.maxHp}${snap.boss.enraged ? '   ENRAGED' : ''}\n${b.cast ? b.cast.name : ''}${call ? '\ncall: ' + call : ''}${pub.step !== undefined && pub.split ? '   step ' + pub.step : ''}`;
  if (p) {
    const slots = p.slots.map((q, i) => q ? `${'123QERF'[i]} ${q.name}${q.cd > 0 ? ' ' + q.cd.toFixed(1) : ''}${q.uses !== null ? ' x' + q.uses : ''}` : null).filter(Boolean).join('\n');
    $('#me').innerHTML = `<b>${p.cls}</b>   ${p.hp} / ${p.maxHp}${p.shield ? '  +' + p.shield : ''}   ${snap.state}${snap.cine ? ' (cinematic)' : ''}   t ${snap.t.toFixed(1)}\nresource ${typeof p.res === 'number' ? Math.round(p.res) : p.res} / ${p.resMax}   wearing ${PIG[pub.wear || 0]}${botOn ? '   BOT' : ''}\n${slots}`;
  }
}
frame();
