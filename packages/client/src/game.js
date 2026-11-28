// Axiom's browser client: connect, the lobby, then play. The server runs the fight; this page sends input frames and draws
// snapshots (view.js). Controls follow Threshold, remappable in Settings (controls.js, settings-ui.js): by default WASD move
// (camera-relative), hold left mouse to look, hold right mouse to look and steer, wheel to zoom, 1 2 3 Q E R F skills (hold
// to repeat), Space jump, Tab / Shift+Tab or click to target, Esc for the menu; or a controller (Threshold's 02_input.js
// pad reading: sticks, the bound buttons, Start for the menu, A / B and the d-pad in menus). Sound: sound.js.
import { Net, serverUrl, lineFromQuery } from './net.js';
import { SelfSim } from './self.js';
import { View, PIG, PIG_NAME } from './view.js';
import { ICON, scPipCls, G as LookG } from './look.js';
import { Settings, saveSettings, Input as Dev, UI as DevUI, Binds, PAD_START } from './controls.js';
import { FightSound, Sound, Music } from './sound.js';
import { createSettings } from './settings-ui.js';

const QS = new URLSearchParams(location.search), $ = (s) => document.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get(k, d) { try { return localStorage.getItem('axiom_' + k) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('axiom_' + k, v); } catch (e) { /* private mode */ } } };

const S = { god: store.get('god', '') === '1', superDmg: store.get('superDmg', '') === '1', catalog: null, lobby: null, me: null, you: null, enc: null, phase: 'connecting', end: null, menu: false, nm: false, view: null, lastSnap: null };
let name = QS.get('name') || store.get('name', '');
if (!name) { name = 'Player ' + Math.floor(100 + Math.random() * 900); }
const net = new Net(serverUrl(QS), { name, cls: store.get('cls', 'duskblade') }, lineFromQuery(QS));
// your own character is predicted (self.js) unless ?predict=0 (for comparison: then it is drawn from snapshots, like others)
const PREDICT = QS.get('predict') !== '0';
let self = null;
window.__axiom = { net, S, G: LookG, get self() { return self; }, netStats, Settings, Binds, get settings() { return settings; }, sound: { FightSound, Sound, Music } }; // for tests and the console (G: the drawing's clocks)

// ---------------- input
const input = { keys: {}, l: false, r: false, lookX: 0, lookY: 0, zoom: 0, press: [], jump: false, cycle: 0, target: undefined, targetId: null, downX: 0, downY: 0, moved: 0 };
const typing = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') && e.target.type !== 'checkbox' && e.target.type !== 'range';
const playing = () => S.phase === 'fight' && S.you && !S.menu && !settings.isOpen;
// a bound action (Binds.ACT ids): a skill slot, jump, next / previous target, camera reset
function act(id) {
  const a = Binds.ACT[id]; if (!a || !playing()) return;
  if (a.slot !== undefined) { input.press.push(a.slot); flashSlot(a.slot); }
  else if (id === 'jump') input.jump = true;
  else if (id === 'tnext') input.cycle = 1; else if (id === 'tprev') input.cycle = -1;
  else if (id === 'camreset') { S.camReset = true; return; }
  sendInput();
}
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.code === 'Escape') { if (settings.isOpen) settings.close(); else if (S.phase === 'fight') toggleMenu(); return; }
  if (!playing()) { if (settings.isOpen || S.menu) { const d = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok' }[e.code]; if (d) { e.preventDefault(); menuNav(d); } } return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const a = Binds.keyAction(e);
  if (a || e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  input.keys[e.code] = true;
  if (a && !e.repeat) act(a);
});
addEventListener('keyup', (e) => { input.keys[e.code] = false; });
addEventListener('blur', () => { input.keys = {}; input.l = input.r = false; lockOff(); });
// the middle and side mouse buttons can be bound (Mouse1, Mouse3, Mouse4); left and right turn the camera
addEventListener('mousedown', (e) => {
  if (e.button !== 1 && e.button !== 3 && e.button !== 4) return;
  const code = 'Mouse' + e.button, a = Binds.keyAction({ code, shiftKey: e.shiftKey });
  if (a || playing()) e.preventDefault();
  input.keys[code] = true; if (a) act(a);
});
addEventListener('mouseup', (e) => { if (e.button === 1 || e.button === 3 || e.button === 4) { input.keys['Mouse' + e.button] = false; if (playing()) e.preventDefault(); } });
addEventListener('auxclick', (e) => { if (playing()) e.preventDefault(); });
const cv = $('#c');
cv.addEventListener('contextmenu', (e) => e.preventDefault());
// Threshold's pointer lock (02_input.js): while a mouse button turns the camera the cursor is hidden and held in place, and it
// comes back where it was when both buttons are up (a short click still targets what was under it)
const lockOn = () => { if (cv.requestPointerLock && document.pointerLockElement !== cv) { try { const p = cv.requestPointerLock(); if (p && p.catch) p.catch(() => { }); } catch (err) { /* lock is optional */ } } };
const lockOff = () => { if (document.pointerLockElement === cv) document.exitPointerLock(); };
cv.addEventListener('mousedown', (e) => {
  if (e.button === 0) input.l = true; else if (e.button === 2) input.r = true; else return;
  input.downX = e.clientX; input.downY = e.clientY; input.moved = 0; input.downAt = performance.now();
  if (playing()) lockOn();
  e.preventDefault();
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) { if (input.l && input.moved < 6 && performance.now() - input.downAt < 350 && playing()) clickTarget(input.downX, input.downY); input.l = false; }
  if (e.button === 2) input.r = false;
  if (!input.l && !input.r) lockOff();
});
// Threshold's mouse look (02_input.js poll): 0.0026 rad per pixel at 100% sensitivity, Settings.inv flips up and down
addEventListener('mousemove', (e) => {
  if (!(input.l || input.r)) return;
  const sens = 0.0026 * Settings.sens / 100, dx = e.movementX || 0, dy = e.movementY || 0;
  input.lookX += dx * sens; input.lookY += dy * sens * (Settings.inv ? -1 : 1); input.moved += Math.abs(dx) + Math.abs(dy);
});
cv.addEventListener('wheel', (e) => { e.preventDefault(); input.zoom += Math.sign(e.deltaY); }, { passive: false });
function clickTarget(x, y) {
  const v = S.view; if (!v) return; let best = null, bd = 90;
  for (const [id, o] of v.ents) { const q = v.project(o.x, (o.aimY || 1.5) * 0.6, o.z); if (!q.on) continue; const d = Math.hypot(q.x - x, q.y - y); if (d < bd) { bd = d; best = id; } }
  if (best !== null) { input.target = best; sendInput(); }
}

// ---------------- the controller: Threshold's 02_input.js (pickPad, poll), feeding the same input frame
// Settings.pad: true on, false off, undefined never chosen (the first button press turns it on).
const pad = { prev: [], mx: 0, mz: 0, held: 0, navT: 0 };
function pickPad() {
  if (Settings.pad === false || !navigator.getGamepads) return null;
  let gp = null, any = null;
  for (const p of navigator.getGamepads()) if (p && p.connected && p.buttons.length >= 10) { if (!any) any = p; if (!gp && p.mapping === 'standard') gp = p; }
  gp = gp || any;
  if (gp && gp.id !== Dev.padId) {
    Dev.padId = gp.id; Dev.padKind = /054c|playstation|dualshock|dualsense|wireless controller/i.test(gp.id) ? 'ps' : 'xbox';
    Dev.padDualSense = /0ce6|0df2|dualsense/i.test(gp.id); DevUI.deviceChanged();
  }
  return gp;
}
addEventListener('gamepadconnected', () => { Dev.padId = ''; });
addEventListener('gamepaddisconnected', () => { Dev.padId = ''; DevUI.deviceChanged(); });
function pollPad(rdt) {
  pad.mx = pad.mz = 0; pad.held = 0;
  const gp = pickPad(); if (!gp) { pad.prev = []; return; }
  const b = gp.buttons.map((x, i) => (i === 6 || i === 7) ? x.value > 0.4 : x.pressed), prev = pad.prev, edge = (i) => b[i] && !prev[i];
  pad.prev = b;
  if (Settings.pad === undefined) { // never chosen: the first button press switches the controller on
    if (b.some((x, i) => edge(i))) { Settings.pad = true; saveSettings(); Dev.device = 'pad'; DevUI.deviceChanged(); toast('Controller on. Settings has its buttons and a switch to turn it off.'); }
    return;
  }
  if (settings.capturing) { for (let i = 0; i < b.length; i++) if (edge(i)) { settings.capturePad(i, PAD_START); break; } return; }
  const fight = playing();
  if (fight) {
    const dz = (v) => Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82;
    const ax = dz(gp.axes[0] || 0), ay = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    pad.mx = ax; pad.mz = -ay;
    const ps = 2.6 * Settings.psens / 100;
    input.lookX += rx * Math.abs(rx) * ps * rdt; input.lookY += ry * Math.abs(ry) * ps * 0.7 * rdt * (Settings.inv ? -1 : 1);
  }
  for (let i = 0; i < b.length; i++) {
    const a = Binds.padAction(i);
    if (fight && a && b[i] && Binds.ACT[a].slot !== undefined) pad.held |= 1 << Binds.ACT[a].slot;
    if (!edge(i)) continue;
    if (i === PAD_START) { if (settings.isOpen) settings.close(); else if (S.phase === 'fight') toggleMenu(); continue; }
    if (fight) { if (a) act(a); continue; }
    const d = { 0: 'ok', 1: 'back', 12: 'up', 13: 'down', 14: 'left', 15: 'right' }[i]; if (d) menuNav(d);
  }
  if (!fight) { // stick navigation in menus
    pad.navT -= rdt;
    const sx = gp.axes[0] || 0, sy = gp.axes[1] || 0;
    if (pad.navT <= 0 && (Math.abs(sx) > 0.6 || Math.abs(sy) > 0.6)) { menuNav(Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? 'right' : 'left') : (sy > 0 ? 'down' : 'up')); pad.navT = 0.22; }
    else if (Math.abs(sx) < 0.3 && Math.abs(sy) < 0.3) pad.navT = 0;
  }
}
// menus with the controller or the arrow keys: the Settings screen has Threshold's own navigation; the Esc menu and the lobby
// step through their buttons in page order
let navI = -1;
function menuNav(d) {
  if (settings.isOpen) { settings.nav(d); return; }
  const root = S.menu && S.phase === 'fight' ? $('#menu') : !$('#lobby').hidden ? $('#lobby') : null; if (!root) return;
  const items = [...root.querySelectorAll('button, input[type=checkbox]')].filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  items.forEach((n) => n.classList.remove('pfocus'));
  if (d === 'back') { navI = -1; if (S.menu) toggleMenu(); return; }
  if (d === 'ok') { const n = items[navI]; if (n) { n.click(); FightSound.ui(true); } return; }
  navI = navI < 0 ? 0 : (navI + (d === 'down' || d === 'right' ? 1 : -1) + items.length) % items.length;
  items[navI].classList.add('pfocus'); items[navI].scrollIntoView({ block: 'nearest' }); FightSound.ui(false);
}

function frameNow() {
  const k = input.keys, yaw = S.view ? S.view.cam.yaw : 0, H = (id) => Binds.held(id, k) ? 1 : 0;
  let fwd = H('up') - H('down') + (input.l && input.r ? 1 : 0), str = H('right') - H('left');
  if (pad.mx || pad.mz) { fwd = pad.mz; str = pad.mx; } // the left stick, as in Threshold, wins over the keys
  let mx = Math.sin(yaw) * fwd - Math.cos(yaw) * str, mz = Math.cos(yaw) * fwd + Math.sin(yaw) * str; const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
  let held = pad.held; for (let i = 0; i < 7; i++) if (Binds.held('s' + i, k)) held |= 1 << i;
  const f = { mx, mz, held, press: input.press.splice(0) };
  if (input.r) f.face = yaw; // right mouse: the hero faces where the camera looks
  if (input.jump) f.jump = 1; if (input.cycle) f.cycle = input.cycle; if (input.target !== undefined) f.target = input.target;
  input.jump = false; input.cycle = 0; input.target = undefined;
  return f;
}
// Without prediction (watching, the autopilot, ?predict=0) the latest frame goes out 30 times a second and at once on a press.
// With it, the predictor samples one frame per tick and sends it stamped with that tick (self.js); presses wait for it.
function sendInput() { if (playing() && !(self && self.ready)) net.send({ t: 'input', f: frameNow() }); }
setInterval(sendInput, 1000 / 30);
function newSelf() {
  self = null; if (!PREDICT || !S.you || !S.enc) return;
  self = new SelfSim({ net, you: S.you, boss: S.enc.boss, nm: !!S.enc.nm, cls: (meM() || {}).cls || store.get('cls', 'duskblade'),
    sample: () => playing() ? frameNow() : { mx: 0, mz: 0, held: 0, press: [] },
    cue: (n, a) => { if (S.view) S.view.cue(n, a, S.you, S.you); } });
}
net.cueFilter = (c) => !self || self.keep(c);
// the Settings screen (from the lobby's button and the Esc menu); the skill names in its table are your class's
const settings = createSettings({
  classDef: () => { const C = S.catalog, id = (meM() || {}).cls || store.get('cls', 'duskblade'); return C ? C.classes.find((c) => c.id === id) : null; },
  onClose: (from) => { if (from === 'fight' && S.phase === 'fight') { S.menu = true; renderMenu(); } },
  onDevice: () => { hudKey = ''; render(); },
  pickPad,
});
DevUI.listeners.push(() => { hudKey = ''; render(); });
function openSettings(from) { if (from === 'fight') { S.menu = false; renderMenu(); } lockOff(); input.l = input.r = false; settings.open(from); }
$('#btn-settings').onclick = () => openSettings('lobby');
// menu clicks (Threshold's 'uiok')
for (const id of ['#lobby', '#menu']) $(id).addEventListener('click', (e) => { if (e.target.closest('button') || e.target.closest('input[type=checkbox]')) FightSound.ui(true); });
net.on('own', (m) => { if (self && m.me) self.own(m.me, m.s); });

// ---------------- network events
net.on('open', () => { S.phase = 'lobby'; render(); });
net.on('close', () => { S.phase = 'offline'; render(); if (!net.closedByUs) setTimeout(() => location.reload(), 4000); });
net.on('welcome', (m) => { S.catalog = m; S.me = m.id; if (!S.view) { S.view = new View(cv, m); S.view.onUi = (n, a) => { if (n === 'ui.hurtFlash') hurtA = Math.min(1, hurtA + 0.25 + (a[0] || 0) * 1.6); }; } render(); });
net.on('lobby', (m) => { S.lobby = m; if (m.phase === 'lobby') { if (S.phase === 'fight') FightSound.stop(1.5); S.phase = 'lobby'; S.you = null; S.menu = false; lockOff(); } render(); });
net.on('start', (m) => { if (S.view) S.view.reset(); S.phase = 'fight'; S.enc = m.enc; S.you = m.you; S.end = null; S.camReset = true; S.music = false; S.loading = !!m.loading; S.preview = null; S.sentReady = false; S.goAt = 0; hudKey = ''; banner(S.loading ? 'Loading' : '', 'wait'); if (!S.loading) newSelf(); render(); });
// the ready gate (lobby.js): the fight holds at its first moment (preview) until everyone in it has loaded it, then a countdown
net.on('preview', (m) => { S.preview = m.s; });
net.on('go', (m) => { S.loading = false; S.goAt = performance.now() + (m.in || 0) * 1000; newSelf(); });
net.on('end', (m) => { S.end = m; lockOff(); input.l = input.r = false; self = null; FightSound.stop(m.result === 'win' ? 3 : 1.5); render(); });
net.on('catchup', (m) => { if (S.view) S.view.catchUp(m, net.latest && net.latest.boss && net.latest.boss.pub); });
net.on('note', (m) => toast(m.text));

// ---------------- the lobby (and the end screen, the menu)
function meM() { return S.lobby && S.lobby.members.find((q) => q.id === S.me); }
function render() {
  const lob = $('#lobby'), L = S.lobby, C = S.catalog;
  document.body.dataset.phase = S.phase;
  $('#status').textContent = S.phase === 'offline' ? 'Disconnected. Reconnecting...' : S.phase === 'connecting' ? 'Connecting...' : `Room ${L ? L.room : ''}`;
  const showLobby = S.phase !== 'fight' || !!(S.end && L && L.phase === 'lobby');
  lob.hidden = !showLobby;
  $('#hud').hidden = S.phase !== 'fight';
  $('#watching').hidden = !(S.phase === 'fight' && !S.you);
  if (!C || !L) { $('#lobbyBody').innerHTML = `<p class="dim">${S.phase === 'offline' ? 'Lost the connection to the server.' : 'Connecting to the server...'}</p>`; return; }
  const me = meM() || {}, locked = L.phase === 'fight';
  const clsName = (id) => (C.classes.find((c) => c.id === id) || { name: id }).name;
  const clsCol = (id) => (C.classes.find((c) => c.id === id) || { color: '#ccc' }).color;
  const end = S.end ? `<div class="endcard ${S.end.result}"><h2>${S.end.result === 'win' ? 'Victory' : S.end.result === 'dead' ? 'Wiped' : 'Encounter ended'}</h2>
    ${S.end.ft ? `<p class="dim">${fmt(S.end.ft)}</p>` : ''}${S.end.by ? `<p class="dim">Ended by ${esc(S.end.by)}</p>` : ''}
    ${S.end.stats && S.end.stats.length ? `<table><tr><th>Player</th><th>Class</th><th>Damage</th><th>DPS</th><th>Taken</th></tr>${S.end.stats.map((s) => `<tr><td>${esc(s.name)}</td><td style="color:${clsCol(s.cls)}">${esc(clsName(s.cls))}</td><td>${s.dmg}</td><td>${s.dps}</td><td>${s.taken}</td></tr>`).join('')}</table>` : ''}</div>` : '';
  $('#lobbyBody').innerHTML = `${end}
    <section><h3>Players</h3><ul class="members">${L.members.map((q) => `<li><span class="dot" style="background:${clsCol(q.cls)}"></span><b>${esc(q.name)}</b>${q.id === S.me ? ' <span class="dim">(you)</span>' : ''} <span class="dim">${esc(clsName(q.cls))}</span>${q.bot ? ' <span class="tag">bot</span>' : ''}${q.auto ? ' <span class="tag">autopilot</span>' : ''}${q.inFight ? ' <span class="tag">in fight</span>' : ''}${q.bot && !locked ? ` <button class="mini" data-drop="${q.id}">remove</button>` : ''}</li>`).join('')}</ul>
      <div class="row"><label>Your name <input id="name" maxlength="16" value="${esc(me.name || name)}"></label>${!locked ? `<button id="addBot">Add a bot</button>` : ''}
      <label class="check"><input type="checkbox" id="auto" ${me.auto ? 'checked' : ''}> Autopilot plays me</label></div></section>
    <section><h3>Class</h3><div class="classes">${C.classes.map((c) => `<button class="cls ${me.cls === c.id ? 'on' : ''}" data-cls="${c.id}" style="--c:${c.color}"><b>${esc(c.name)}</b><span>${esc(c.role)}</span>
      <ul>${c.skills.map((k, i) => k ? `<li><kbd>${esc(Binds.slotLabel(i).t || '—')}</kbd> <b>${esc(k.name)}</b> <span class="dim">${esc(k.desc)}</span></li>` : '').join('')}</ul></button>`).join('')}</div></section>
    <section><h3>Encounter</h3>${locked ? `<p>${esc(L.enc.name)} is under way. ${L.enc.training ? '' : 'The room is locked until it ends.'}</p>` : `<div class="encs">${C.bosses.map((b) => `<button class="enc" data-boss="${b.id}"><b>${esc(b.name)}</b><span>${esc(b.title)}</span><span class="dim">${b.training ? 'Try the classes. Anyone can walk in, change class, leave.' : b.solo ? 'A duel: solo for now. Only you load in; everyone else watches.' : 'A boss: everyone here loads in and the room locks.'}</span></button>`).join('')}</div>
      <div class="row"><label class="check"><input type="checkbox" id="nm" ${S.nm ? 'checked' : ''}> Nightmare (tuned solo so far)</label>
      <label class="check" title="Testing: nobody in the party drops below 1 health"><input type="checkbox" id="god" ${S.god ? 'checked' : ''}> God mode</label>
      <label class="check" title="Testing: any player's hit drops the boss to his next phase"><input type="checkbox" id="superDmg" ${S.superDmg ? 'checked' : ''}> Super damage</label></div>`}</section>`;
  for (const b of document.querySelectorAll('[data-cls]')) b.onclick = () => { store.set('cls', b.dataset.cls); net.send({ t: 'class', cls: b.dataset.cls }); };
  for (const b of document.querySelectorAll('[data-boss]')) b.onclick = () => net.send({ t: 'start', boss: b.dataset.boss, nm: S.nm, god: S.god, superDmg: S.superDmg });
  for (const b of document.querySelectorAll('[data-drop]')) b.onclick = () => net.send({ t: 'dropBot', id: +b.dataset.drop });
  const ab = $('#addBot'); if (ab) ab.onclick = () => net.send({ t: 'addBot' });
  $('#auto').onchange = (e) => net.send({ t: 'auto', on: e.target.checked });
  const nmb = $('#nm'); if (nmb) nmb.onchange = (e) => { S.nm = e.target.checked; };
  for (const k of ['god', 'superDmg']) { const n = $('#' + k); if (n) n.onchange = (e) => { S[k] = e.target.checked; store.set(k, S[k] ? '1' : ''); }; }
  const tt = $('#testtag'), en = S.phase === 'fight' && S.enc; tt.textContent = en ? [en.godMode && 'GOD MODE', en.superDmg && 'SUPER DAMAGE'].filter(Boolean).join(' · ') : ''; tt.hidden = !tt.textContent;
  $('#name').onchange = (e) => { store.set('name', e.target.value); toast('Your new name is used the next time you join.'); };
  renderMenu();
}
function renderMenu() {
  const m = $('#menu'); m.hidden = !S.menu || S.phase !== 'fight'; if (m.hidden) return;
  const C = S.catalog, me = meM() || {}, training = S.enc && S.enc.training;
  m.innerHTML = `<div class="panel"><h3>${esc(S.enc ? S.enc.name : '')}</h3>
    ${training && S.you ? `<p>Change class</p><div class="row">${C.classes.map((c) => `<button data-mcls="${c.id}" style="border-color:${c.color}" class="${me.cls === c.id ? 'on' : ''}">${esc(c.name)}</button>`).join('')}</div>` : ''}
    ${S.you ? `<label class="check"><input type="checkbox" id="mauto" ${me.auto ? 'checked' : ''}> Autopilot plays me</label>` : ''}
    <div class="row"><button id="mset">Settings &amp; controls</button></div>
    <div class="row"><button id="mend">End the encounter for everyone</button><button id="mback">Back to the fight</button></div></div>`;
  for (const b of m.querySelectorAll('[data-mcls]')) b.onclick = () => { store.set('cls', b.dataset.mcls); net.send({ t: 'class', cls: b.dataset.mcls }); };
  const ma = $('#mauto'); if (ma) ma.onchange = (e) => net.send({ t: 'auto', on: e.target.checked });
  $('#mend').onclick = () => { net.send({ t: 'end' }); S.menu = false; renderMenu(); };
  $('#mback').onclick = () => toggleMenu();
  $('#mset').onclick = () => openSettings('fight');
}
function toggleMenu() { S.menu = !S.menu; navI = -1; if (S.menu) { lockOff(); input.l = input.r = false; } renderMenu(); }
let toastT = null;
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4500); }
function banner(text, cls = '') { const b = $('#banner'); b.textContent = text; b.className = cls; b.hidden = !text; }
const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

// ---------------- the HUD: Threshold's in-fight frames (09_ui.js update), fed from the latest snapshot
const svg = (name, color) => ICON[name] ? `<svg viewBox="0 0 24 24"><path d="${ICON[name]}" fill="${color}" fill-rule="evenodd"/></svg>` : '';
const hotbar = $('#hotbar'), cache = {};
let slots = [], hudKey = '', hurtA = 0;
const setSx = (key, el, k, ax = 'X') => { const v = Math.round(Math.max(0, Math.min(1, k)) * 1000); if (cache[key] !== v) { cache[key] = v; el.style.transform = `scale${ax}(${v / 1000})`; } };
const setTxt = (key, el, t) => { if (cache[key] !== t) { cache[key] = t; el.textContent = t; } };
const setCls = (key, el, c, on) => { if (cache[key] !== on) { cache[key] = on; el.classList.toggle(c, on); } };
function flashSlot(i) { const q = slots[i]; if (q) { q.flash = 0.1; q.d.classList.add('press'); } }
function buildHud(s, me, cdef) {
  for (const k of Object.keys(cache)) delete cache[k];
  document.documentElement.style.setProperty('--cls', cdef.color || '#e8c77a');
  hotbar.innerHTML = ''; slots = []; let sep = false;
  (cdef.skills || []).forEach((q, i) => {
    if (!q) { slots.push(null); return; }
    const gs = i >= 3 && !sep; if (gs) sep = true;
    const d = document.createElement('div'); d.className = 'slot' + (gs ? ' gsep' : ''); d.title = q.name + ': ' + q.desc;
    const lab = Binds.slotLabel(i); d.innerHTML = `<span class="ico">${svg(q.icon, cdef.color)}</span><span class="key"${lab.c ? ` style="color:${lab.c}"` : ''}>${esc(lab.t)}</span><div class="cdm"></div><div class="cdt"></div><span class="chg"></span>`;
    d.onmousedown = (e) => { e.stopPropagation(); if (playing()) { input.press.push(i); flashSlot(i); sendInput(); } };
    hotbar.appendChild(d); slots.push({ d, cdm: d.querySelector('.cdm'), cdt: d.querySelector('.cdt'), chg: d.querySelector('.chg'), flash: 0, def: q });
  });
  const pips = $('#pips'), kind = cdef.resKind || 'pips'; pips.innerHTML = ''; pips.className = kind;
  if (kind === 'bar') pips.innerHTML = '<div class="stam"><b></b><u></u></div>'; else for (let i = 0; i < (cdef.resMax || 0); i++) pips.appendChild(document.createElement('i'));
  const bar = $('#bbar'), bdef = (S.catalog.bosses.find((q) => q.id === s.boss.id) || {}); bar.querySelectorAll('.tick').forEach((t) => t.remove());
  for (const at of (s.nm && bdef.nmTicks) || bdef.ticks || []) { const t = document.createElement('div'); t.className = 'tick'; t.style.left = (at * 100) + '%'; bar.appendChild(t); }
  $('#bname').textContent = s.boss.name; $('#bname').classList.toggle('nm', !!s.nm);
}
// a body's cast at the drawn moment: from the snapshots' cast progress turned into a start tick, so the bar runs on the
// shared clock (smooth at any frame rate, whatever the packets do) and lines up with the body's animation
function castAt(W, id, rt, hz) {
  if (!W) return null;
  const ea = W.a.ents.find((q) => q.id === id), eb = W.b.ents.find((q) => q.id === id), ca = ea && ea.cast, cb = eb && eb.cast;
  if (cb) { const t = (rt - (W.b.tick - cb.t * hz)) / hz; if (t >= 0) return { name: cb.name, t: Math.min(t, cb.time), time: cb.time }; }
  if (ca) { const t = (rt - (W.a.tick - ca.t * hz)) / hz; if (t <= ca.time) return { name: ca.name, t: Math.max(0, t), time: ca.time }; }
  return null;
}
function castBar(key, node, cs) { const on = !!cs; setCls(key + 'on', node, 'on', on); if (!on) return; setSx(key + 'f', node.firstElementChild, cs.t / cs.time); setTxt(key + 'n', node.lastElementChild, cs.name); }
// s: the snapshot at the drawn moment (the world), W: the blend around it, pme: your predicted state (or null)
function hud(s, rdt, W, pme) {
  if (hurtA > 0) { hurtA = Math.max(0, hurtA - rdt * 1.6); $('#hurtv').style.opacity = hurtA.toFixed(2); }
  if (!s) return;
  const C = S.catalog, b = s.ents.find((e) => e.boss), pub = s.boss.pub || {}, me = pme || s.players.find((p) => p.id === S.you), dummy = s.boss.id === 'dummy';
  const col = (id) => (C.classes.find((c) => c.id === id) || { color: '#ccc' }).color;
  const cdef = me ? (C.classes.find((c) => c.id === me.cls) || {}) : {};
  const key = s.boss.id + (s.nm ? '!' : '') + ':' + (me ? me.cls : '-'); if (key !== hudKey) { hudKey = key; buildHud(s, me, cdef); }
  // boss
  if (b) { setSx('bhp', $('#bbar .fill'), b.hp / b.maxHp); setSx('bhpl', $('#bbar .lag'), b.hp / b.maxHp); setTxt('bhpt', $('#bhp'), dummy ? '' : (b.hp / b.maxHp * 100).toFixed(1) + '%'); castBar('bc', $('#bcast'), castAt(W, b.id, net.renderTick, net.hz)); }
  setTxt('binfo', $('#bossInfo'), pub.split && pub.call ? `calls ${pub.call.tone === 'w' ? 'white' : 'black'} + ${PIG_NAME[pub.call.col]}` : '');
  setTxt('enr', $('#enrage'), dummy ? '' : fmt(s.t)); setCls('enrh', $('#enrage'), 'hot', !!s.boss.enraged);
  // your target, when it is not the boss
  const t = me && me.target !== null ? s.ents.find((e) => e.id === me.target) : null, showT = !!(t && !t.boss && t.alive);
  setCls('tf', $('#tgtframe'), 'on', showT);
  if (showT) { const th = (t.ow && s.ents.find((e) => e.id === t.ow)) || t; setTxt('tn', $('#tname'), t.name); setSx('thp', $('#tbar .fill'), th.hp / th.maxHp); /* a body sharing another's health (Issen's reflection) shows the owner's */ castBar('tc', $('#tcast'), castAt(W, t.id, net.renderTick, net.hz)); }
  // party and the meter, ten times a second
  if ((cache.partyT = (cache.partyT || 0) - rdt) <= 0) { cache.partyT = 0.1; party(s, pub, col); }
  mine(s, me, cdef, pub, rdt);
}
function party(s, pub, col) {
  $('#party').innerHTML = s.players.length < 2 ? '' : s.players.map((p) => `<div class="pf ${p.alive ? '' : 'down'} ${p.id === S.you ? 'me' : ''}"><span class="pn" style="color:${col(p.cls)}">${esc(p.name || 'Player')}${p.bot ? ' ·auto' : ''}</span><div class="hp"><i style="width:${(Math.max(0, p.hp / p.maxHp) * 100).toFixed(1)}%"></i>${p.shield ? `<b class="sh" style="width:${Math.min(100, p.shield / p.maxHp * 100)}%"></b>` : ''}</div>${pub.pw && pub.pw[p.id] && pub.pw[p.id].wear ? `<span class="sw" style="background:#${PIG[pub.pw[p.id].wear].toString(16).padStart(6, '0')}"></span>` : ''}</div>`).join('');
  // the dummy's meter
  const meter = $('#meter'); meter.hidden = !pub.meter;
  if (pub.meter) meter.innerHTML = '<h4>Damage meter</h4>' + s.players.map((p) => { const m = pub.meter[p.id]; return `<div><span style="color:${col(p.cls)}">${esc(p.name)}</span><b>${m ? m.dps : 0}</b> dps <span class="dim">${m ? m.total.toLocaleString() + ' in ' + m.dur + ' s' : '-'}</span></div>`; }).join('') + '<p class="dim small">A burst ends 6 s after your last hit. Esc to change class.</p>';
}
function mine(s, me, cdef, pub, rdt) {
  // you
  $('#playerframe').hidden = !me; hotbar.hidden = !me; $('#buffs').hidden = !me;
  if (!me) { setCls('hint', $('#hint'), 'on', false); return; }
  setSx('php', $('#pbar .fill'), me.hp / me.maxHp); setCls('plow', $('#pbar'), 'low', me.hp / me.maxHp < 0.35);
  setTxt('phpt', $('#pbar .hpt'), Math.ceil(me.hp) + ' / ' + me.maxHp);
  const sh = Math.round(Math.max(0, Math.min(1, me.shield / me.maxHp)) * 100); if (cache.sh !== sh) { cache.sh = sh; $('#pbar .shield').style.width = sh + '%'; }
  const pips = $('#pips').children, rk = cdef.resKind || 'pips';
  if (rk === 'bar') { if (pips[0]) setSx('stam', pips[0].firstElementChild, me.res / me.resMax); }
  else if (me.sc) { for (let i = 0; i < pips.length; i++) { const v = scPipCls({ sc: me.sc, res: me.res }, i); if (cache['pc' + i] !== v) { cache['pc' + i] = v; pips[i].className = v; } } } // Stormcaller's glowing slot
  else for (let i = 0; i < pips.length; i++) setCls('pip' + i, pips[i], 'on', i < me.res);
  const pc = $('#pcast'), c = me.casting; if (cache.pcon !== !!c) { cache.pcon = !!c; pc.style.opacity = c ? 1 : 0; }
  if (c) { setSx('pcf', pc.firstElementChild, c.t / c.time); setTxt('pcn', pc.lastElementChild, c.name); }
  me.slots.forEach((q, i) => {
    const el = slots[i]; if (!el || !q) return; const d = el.def, why = q.why;
    let frac = 0, txt = '';
    if (q.charges <= 0 && q.cd > 0) { frac = q.cd / (q.maxCd || 1); txt = q.cd > 9.5 ? String(Math.ceil(q.cd)) : q.cd.toFixed(q.cd < 3 ? 1 : 0); }
    else if (d.gcd !== false && me.gcd > 0) frac = me.gcd / (me.gcdMax || 1);
    setSx('cd' + i, el.cdm, frac, 'Y'); setTxt('ct' + i, el.cdt, txt);
    setCls('off' + i, el.d, 'off', why === 'res' || why === 'range' || why === 'target' || why === 'spent' || why === 'no' || why === 'dead' || /^[A-Z]/.test(why) || q.charges <= 0);
    setTxt('ch' + i, el.chg, q.uses !== null ? String(q.uses) : (q.charges > 1 ? String(q.charges) : ''));
    setCls('rdy' + i, el.d, 'rdy', !!q.rdy); setCls('act' + i, el.d, 'act', !!q.act);
    if (el.flash > 0) { el.flash -= rdt; if (el.flash <= 0) el.d.classList.remove('press'); }
  });
  const bw = $('#buffs'), sig = me.buffs.map((q) => q.id).join(',');
  if (cache.buffs !== sig) { cache.buffs = sig; bw.innerHTML = me.buffs.map((q) => `<div class="bf">${svg(q.icon || q.id, cdef.color)}<span></span></div>`).join(''); }
  for (let i = 0; i < me.buffs.length && i < bw.children.length; i++) setTxt('bft' + i + sig, bw.children[i].lastElementChild, me.buffs[i].t.toFixed(0));
  const hint = me.alive ? me.hint || '' : 'You are down. Your party fights on.'; setCls('hint', $('#hint'), 'on', !!hint); if (hint) setTxt('hintt', $('#hint'), hint);
  const w = pub.pw && pub.pw[me.id] ? pub.pw[me.id].wear : null;
  if (cache.wear !== w) { cache.wear = w; $('#wear').hidden = w === null; if (w !== null) $('#wear').innerHTML = `<span class="sw" style="background:#${PIG[w].toString(16).padStart(6, '0')}"></span> wearing ${PIG_NAME[w]}`; }
}
// name plates over other players
function plates(s) {
  const v = S.view, box = $('#plates'); if (!v || !s) { box.innerHTML = ''; return; }
  const out = [];
  for (const p of s.players) { if (p.id === S.you) continue; const h = v.heroes.get(p.id); if (!h) continue; const q = v.project(h.x, h.y + 2.3, h.z); if (!q.on) continue; out.push(`<div class="plate ${p.alive ? '' : 'down'}" style="transform:translate(${q.x.toFixed(0)}px,${q.y.toFixed(0)}px)">${esc(p.name)}</div>`); }
  box.innerHTML = out.join('');
}

// ---------------- the loop
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const real = Math.min(1, Math.max(0, (now - last) / 1000)), dt = Math.min(0.1, real); last = now;
  net.advance(real); // the clocks keep real time through a slow frame (the drawing's own effects take the clamped dt)
  pollPad(real);
  if (self) self.update(real);
  overlay(dt);
  const v = S.view; if (!v || S.phase !== 'fight') return;
  if (S.goAt) { const left = (S.goAt - now) / 1000; if (left > 0) banner(String(Math.ceil(left)), 'wait'); else { S.goAt = 0; banner(''); } }
  if (S.loading || net.renderTick === null) { // loading, or counting down: the first moment, still; once it is drawn (the arena built, every shader warmed) this client is ready
    const P = S.preview; if (!P) return;
    v.draw(dt, P, P, 0, { a: P, b: P, k: 0 }, S.you, input);
    if (S.loading && S.you && !S.sentReady) { S.sentReady = true; net.send({ t: 'ready' }); }
    if (S.loading) { const L = S.lobby, wait = L ? L.members.filter((q) => q.loading && q.id !== S.me).map((q) => q.name) : []; banner(S.sentReady || !S.you ? (wait.length ? 'Waiting for ' + wait.join(', ') : 'Starting') : 'Loading', 'wait'); }
    return;
  }
  const tRender = net.renderTick, A = net.at(tRender), pred = self && self.ready ? self.view() : null;
  const B = pred || net.at(net.serverNow() - 1.5); // not predicting: your character with a short delay, as before
  if (!A) return;
  if (!S.music) { S.music = true; FightSound.start(A.b.boss.id, !!A.b.nm, A.b.boss.phase); } // the fight's music, from its first drawn moment
  if (S.camReset) { const me = A.b.players.find((p) => p.id === S.you), c = v.camFor(A.b.boss.id); v.cam.yaw = me ? me.facing : Math.PI; v.cam.pitch = c.pitch; v.cam.tDist = v.cam.dist = c.dist; S.camReset = false; }
  for (const c of net.dueCues(tRender)) {
    if (c.name === 'fight.win') { banner('Victory', 'win'); v.cue(c.name, c.args, c.actor, S.you); }
    else if (c.name === 'fight.dead') banner('Wiped', 'dead');
    else if (c.name === 'fight.down') { const p = net.latest && net.latest.players.find((q) => q.id === c.args[0]); if (p) toast(`${p.name || 'A player'} is down (${c.args[1]}).`); }
    else v.cue(c.name, c.args, c.actor, S.you);
  }
  const mine = pred ? self.hud() : null;
  input.targetId = mine ? mine.target : (net.latest && net.latest.players.find((p) => p.id === S.you) || {}).target;
  v.draw(dt, A.a, A.b, A.k, B, S.you, input);
  hud(A.b, dt, A, mine);
  plates(A.b);
  $('#ping').textContent = net.rtt ? Math.round(net.rtt * 1000) + ' ms' : '';
}

// ---------------- the network overlay (F3, or ?net=1): ping, jitter, the render delay, the prediction's lead and corrections
const dbg = document.createElement('div'); dbg.id = 'netdbg'; dbg.hidden = QS.get('net') !== '1'; document.body.appendChild(dbg);
addEventListener('keydown', (e) => { if (e.code === 'F3' || (e.code === 'Backquote' && !typing(e))) { e.preventDefault(); dbg.hidden = !dbg.hidden; } });
let dbgT = 0, kbT = performance.now(), kb0 = 0, kbps = 0;
function netStats() { const n = net.stats(), p = self ? self.stats() : null; return { net: n, self: p, kbps }; }
function overlay(dt) {
  if ((dbgT -= dt) > 0) return; dbgT = 0.25;
  const t = performance.now(); if (t - kbT > 1000) { kbps = (net.bytes - kb0) / (t - kbT); kb0 = net.bytes; kbT = t; }
  if (dbg.hidden) return;
  const { net: n, self: p } = netStats(), f = (v, d = 0) => v === null || v === undefined ? '-' : v.toFixed(d);
  dbg.innerHTML = `<b>net</b> ping ${f(n.rtt)} ms · jitter ${f(n.jitter)} ms · ${n.snapHz} snaps/s · ${f(kbps, 0)} kB/s
    <br>world drawn ${f(n.behind)} ms behind (buffer ${f(n.delay)} ms)${n.sim ? ` · <span class="sim">simulated line ${n.sim.lag} ms ±${n.sim.jitter} ms, ${n.sim.loss}% loss</span>` : ''}
    <br>${p && p.on ? `<b>you</b> predicted ${f(p.ahead)} ms ahead · inputs arrive ${f(p.ia)} ms early (${p.late} late, ${p.miss} missed ticks)
    <br>correction now ${f(p.corrNow * 100, 1)} cm · last ${f(p.corrLast * 100, 1)} cm · max 5 s ${f(p.corrMax5s * 100, 1)} cm · cast ${f(p.castCorr)} ms · ${p.mispredicts} mispredicts` : `<b>you</b> ${PREDICT ? 'not predicted (watching or autopilot)' : 'prediction off (?predict=0)'}`}`;
}

requestAnimationFrame(loop);
render();
