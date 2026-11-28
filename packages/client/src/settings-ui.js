// The Settings screen: Threshold's (00_ui.html #settings and 09_ui.js refreshSettings / setOpt / adjust / buildBinds /
// the capture flow), ported to Axiom's page. Opened from the lobby and from the Esc menu in a fight.
//
// General: master volume, music, mouse sensitivity, camera speed (controller), character height on screen, invert camera Y,
// graphics. Controls: the controller toggle, Xbox / PlayStation prompts, and the binding table for the device in use
// (two keys per action on keyboard and mouse, one button on the controller; a key already in use swaps with the old one).
// Testing: the freeze log (copied to the clipboard). Threshold's God mode and Super damage change the fight for the whole
// party, so they are not personal settings here.
//
// Rebinding: the next key, mouse side button or pad button becomes the binding. Esc (or the pad's Start) cancels, Backspace
// clears a key. game.js hands pad buttons to capturePad() while a capture is open.
import { Settings, saveSettings, Input as Dev, UI, Binds } from './controls.js';
import { Hitch, setQuality } from './look.js';
import { FightSound } from './sound.js';

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const RANGE = { vol: [0, 100, 5], mus: [0, 100, 5], sens: [10, 300, 10], psens: [10, 300, 10], camY: [30, 60, 2] };
const KEY_RESERVED = /^(Escape|F3|F5|F11|F12|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|OS(Left|Right)|ContextMenu|Backspace|Delete)$/;
const BINDABLE_MOUSE = (b) => b === 1 || b === 3 || b === 4;

const HTML = `<h1>SETTINGS</h1>
  <div class="set-wrap">
    <div class="set-col set-gen">
      <h2>General</h2>
      <div class="srow nav" data-adj="vol"><label>Master volume</label><input type="range" id="set-vol" min="0" max="100" tabindex="-1"><span class="sv"></span></div>
      <div class="srow nav" data-adj="mus"><label>Music</label><input type="range" id="set-mus" min="0" max="100" tabindex="-1"><span class="sv"></span></div>
      <div class="srow nav kbm-only" data-adj="sens"><label>Mouse sensitivity</label><input type="range" id="set-sens" min="10" max="300" tabindex="-1"><span class="sv"></span></div>
      <div class="srow nav pad-only" data-adj="psens"><label>Camera speed</label><input type="range" id="set-psens" min="10" max="300" tabindex="-1"><span class="sv"></span></div>
      <div class="srow nav srow-peek" data-adj="camY"><label>Character height on screen</label><input type="range" id="set-camY" min="30" max="60" tabindex="-1"><span class="sv"></span></div>
      <div class="srow nav" data-adj="inv"><label>Invert camera Y</label><div class="seg" id="set-inv"><span data-v="0">Off</span><span data-v="1">On</span></div></div>
      <div class="srow nav" data-adj="q"><label>Graphics</label><div class="seg" id="set-q"><span data-v="low">Low</span><span data-v="med">Medium</span><span data-v="high">High</span></div></div>
      <h2 class="h2b">Testing</h2>
      <div class="srow"><label>Freeze log (late frames and their cause)</label><button class="btn nav small" id="hitch-copy">Copy</button></div>
      <h2 class="h2b">Fixed controls</h2>
      <div class="fixed" id="bind-fixed"></div>
    </div>
    <div class="set-col set-ctl">
      <div class="ctl-head"><h2>Controls</h2><span id="bind-hint"></span><button class="btn nav small" id="bind-reset"></button></div>
      <div class="srow nav" data-adj="pad"><label>Controller</label><div class="seg" id="set-pad"><span data-v="0">Off</span><span data-v="1">On</span></div></div>
      <div class="srow nav pad-only" data-adj="glyphs"><label>Button prompts</label><div class="seg" id="set-glyphs"><span data-v="auto">Auto</span><span data-v="xbox">Xbox</span><span data-v="ps">PlayStation</span></div></div>
      <div class="padstat pad-only" id="padstat"></div>
      <div id="binds"></div>
    </div>
  </div>
  <button class="btn nav primary" id="set-back">Back</button>`;

// o: { classDef: () => the class whose skill names label the table, onClose: () => void, onDevice: () => void, pickPad: () => gamepad|null }
export function createSettings(o) {
  const el = document.createElement('div'); el.id = 'settings'; el.hidden = true; el.innerHTML = HTML; document.body.appendChild(el);
  const seg = (k) => $('#set-' + k, el);
  let capture = null, focusI = -1, from = 'lobby';
  const sfx = (ok) => FightSound.ui(ok);

  function segSet(k, v) { for (const n of seg(k).children) n.classList.toggle('on', n.dataset.v === String(v)); }
  function refresh() {
    el.classList.toggle('pad', Dev.device === 'pad');
    for (const k in RANGE) { const n = $('#set-' + k, el); n.value = Settings[k]; n.nextElementSibling.textContent = Settings[k] + (k === 'camY' ? '%' : ''); }
    segSet('inv', Settings.inv ? 1 : 0); segSet('q', Settings.q); segSet('pad', Settings.pad ? 1 : 0); segSet('glyphs', Settings.glyphs || 'auto');
    buildBinds();
    const items = navItems(); if (focusI >= items.length) focusI = items.length - 1; if (focusI >= 0 && items[focusI]) items[focusI].classList.add('focus');
  }
  function setPad(on) { Settings.pad = !!on; saveSettings(); Dev.device = on ? 'pad' : 'kbm'; UI.deviceChanged(); }
  function setOpt(k, v) {
    if (k in RANGE) { const [lo, hi] = RANGE[k]; Settings[k] = clamp(Math.round(+v), lo, hi); FightSound.applyVolume(); }
    else if (k === 'inv') Settings.inv = String(v) === '1';
    else if (k === 'q') { setQuality(v); }
    else if (k === 'pad') { setPad(String(v) === '1'); refresh(); return; }
    else if (k === 'glyphs') Settings.glyphs = v;
    saveSettings(); if (k === 'glyphs') UI.deviceChanged(); else refresh();
  }
  function adjust(k, d) { // left / right on a focused row (d 0: next value, wrapping)
    if (k in RANGE) { setOpt(k, Settings[k] + (d || 1) * RANGE[k][2]); sfx(false); return; }
    const vals = [...seg(k).children].map((n) => n.dataset.v), on = seg(k).querySelector('.on');
    const i = on ? vals.indexOf(on.dataset.v) : 0, j = d === 0 ? (i + 1) % vals.length : clamp(i + d, 0, vals.length - 1);
    if (j !== i) { setOpt(k, vals[j]); sfx(false); }
  }
  for (const k in RANGE) $('#set-' + k, el).oninput = (e) => setOpt(k, e.target.value);
  $('.set-wrap', el).addEventListener('click', (e) => {
    const sv = e.target.closest('.seg span'), row = e.target.closest('.srow');
    if (sv) { setOpt(row.dataset.adj, sv.dataset.v); sfx(true); }
    else if (row && row.dataset.adj && !e.target.closest('input') && !(row.dataset.adj in RANGE)) adjust(row.dataset.adj, 0);
  });

  function padLabel() {
    const gp = o.pickPad(); if (!gp) return 'No controller found. Press a button on it.';
    return gp.id.replace(/\s*\(.*$/, '').slice(0, 48) + (gp.mapping === 'standard' ? '' : ' (unusual layout: rebind anything that feels wrong)');
  }
  function bindCell(dev, id, i) {
    const c = capture, waiting = c && c.dev === dev && c.id === id && c.idx === i;
    const v = dev === 'pad' ? Binds.get('pad', id) : Binds.get('kbm', id)[i];
    const t = waiting ? (dev === 'pad' ? 'press a button' : 'press a key') : (dev === 'pad' ? Binds.padName(v) : Binds.keyName(v)) || '—';
    const col = !waiting && dev === 'pad' ? Binds.padColor(v) : '';
    return `<button class="bk nav${waiting ? ' wait' : ''}${col ? ' face' : ''}${!waiting && (v === null || v === undefined) ? ' empty' : ''}" data-id="${id}" data-i="${i}"${col ? ` style="color:${col}"` : ''}>${t}</button>`;
  }
  function buildBinds() {
    const dev = Dev.device, pad = dev === 'pad', w = $('#binds', el), cls = o.classDef(), c = capture;
    w.className = pad ? 'pad' : '';
    let h = '', grp = '';
    for (const a of Binds.acts(dev)) {
      const g = a.kbmOnly ? 'Movement' : a.slot !== undefined ? 'Skills' : 'Other';
      if (g !== grp) { grp = g; h += `<div class="bh grp">${g}</div>`; }
      const sk = a.slot !== undefined && cls && cls.skills && cls.skills[a.slot];
      h += `<div class="bn">${a.slot !== undefined ? 'Skill ' + (a.slot + 1) + (sk ? `<small>${sk.name}</small>` : '') : a.name}</div>`;
      h += pad ? bindCell('pad', a.id, 0) : bindCell('kbm', a.id, 0) + bindCell('kbm', a.id, 1);
    }
    w.innerHTML = h;
    const k = (t) => `<kbd>${t}</kbd>`, P = (b) => Binds.padName(b);
    const fixed = pad ? [['Move', 'Left stick'], ['Camera', 'Right stick'], ['Menu', P(9)], ['Menus: confirm / back', P(0) + ' / ' + P(1)]]
      : [['Turn camera', 'Hold left mouse'], ['Turn camera and character', 'Hold right mouse'], ['Run forward', 'Both mouse buttons'], ['Zoom', 'Wheel'], ['Pick a target', 'Click it'], ['Menu', 'Esc'], ['Network overlay', 'F3']];
    $('#bind-fixed', el).innerHTML = fixed.map(([a, b]) => `<span>${a}</span>${k(b)}`).join('');
    $('#bind-hint', el).innerHTML = !c ? '' : c.dev === 'pad' ? `${k(P(9))} cancels` : `${k('Esc')} cancels &nbsp;${k('Backspace')} clears`;
    $('#bind-reset', el).classList.toggle('hidden', !!c);
    $('#padstat', el).textContent = pad ? padLabel() : '';
    $('#bind-reset', el).textContent = pad ? 'Reset buttons' : 'Reset keys';
  }
  $('#binds', el).addEventListener('click', (e) => {
    const b = e.target.closest('.bk'); if (!b) return;
    const id = b.dataset.id, i = +b.dataset.i;
    if (capture && capture.id === id && capture.idx === i) { endCapture(); return; }
    capture = { dev: Dev.device, id, idx: i, t: performance.now(), shift: null }; sfx(true); buildBinds(); focusCell(id, i);
  });
  function endCapture(value) {
    const c = capture; capture = null; if (!c) return;
    let swapped = null; if (value !== undefined) swapped = Binds.assign(c.dev, c.id, c.idx, value);
    o.onDevice(); buildBinds(); focusCell(c.id, c.idx); sfx(value !== undefined);
    if (swapped) for (const n of $('#binds', el).querySelectorAll(`.bk[data-id="${swapped}"]`)) { n.classList.add('swap'); setTimeout(() => n.classList.remove('swap'), 1400); }
  }
  // the keyboard and mouse while a capture is open (registered first, on the capture phase, so the game never sees them)
  addEventListener('keydown', (e) => {
    if (!capture) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const c = capture;
    if (e.code === 'Escape') return endCapture();
    if (e.code === 'Backspace' || e.code === 'Delete') return c.dev === 'kbm' ? endCapture(null) : undefined;
    if (c.dev !== 'kbm' || e.repeat || KEY_RESERVED.test(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^Shift(Left|Right)$/.test(e.code)) { c.shift = e.code; return; } // a lone Shift binds on release; Shift + key binds the combo
    endCapture((e.shiftKey ? 'Shift+' : '') + e.code);
  }, true);
  addEventListener('keyup', (e) => { if (capture && capture.shift === e.code) { e.preventDefault(); e.stopImmediatePropagation(); endCapture(e.code); } }, true);
  let swallowClick = false;
  addEventListener('mousedown', (e) => {
    if (!capture) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (capture.dev === 'kbm' && BINDABLE_MOUSE(e.button)) endCapture('Mouse' + e.button);
    else { swallowClick = e.button === 0; endCapture(); }
  }, true);
  addEventListener('click', (e) => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  setInterval(() => { if (capture && performance.now() - capture.t > 8000) endCapture(); }, 500);

  $('#hitch-copy', el).onclick = () => { const n = $('#hitch-copy', el), t = Hitch.text(), done = (ok) => { n.textContent = ok ? 'Copied' : 'Failed'; sfx(true); setTimeout(() => { n.textContent = 'Copy'; }, 1500); }; try { navigator.clipboard.writeText(t).then(() => done(true), () => done(false)); } catch (e) { done(false); } };
  $('#bind-reset', el).onclick = () => { Binds.reset(Dev.device); sfx(true); o.onDevice(); refresh(); };
  $('#set-back', el).onclick = () => close();
  UI.listeners.push(() => { if (!el.hidden) refresh(); });

  // ---- controller / keyboard focus navigation (Threshold's navItems / setFocus / moveFocus, for this screen)
  function navItems() { return [...el.querySelectorAll('.nav')].filter((n) => n.offsetParent !== null); }
  function setFocus(i, quiet) {
    const items = navItems(); if (!items.length) return; items.forEach((n) => n.classList.remove('focus'));
    focusI = clamp(i, 0, items.length - 1); items[focusI].classList.add('focus'); items[focusI].scrollIntoView({ block: 'nearest' }); if (!quiet) sfx(false);
  }
  function focusCell(id, i) { const items = navItems(), j = items.findIndex((n) => n.dataset.id === id && +n.dataset.i === i); if (j >= 0 && (focusI >= 0 || Dev.device === 'pad')) setFocus(j, true); }
  // dir: 'up' | 'down' | 'left' | 'right' | 'ok' | 'back'
  function nav(dir) {
    if (capture) return;
    const items = navItems(); if (!items.length) return;
    if (focusI < 0) { if (dir !== 'back') { setFocus(0); return; } }
    const cur = items[focusI];
    if (dir === 'back') { close(); return; }
    if (dir === 'up' || dir === 'down') {
      // in the binding table, up / down keeps the column
      if (cur && cur.classList.contains('bk')) { const col = cur.dataset.i, cells = items.map((n, j) => [n, j]).filter(([n]) => n.classList.contains('bk') && n.dataset.i === col), k = cells.findIndex(([, j]) => j === focusI), nx = cells[k + (dir === 'down' ? 1 : -1)]; if (nx) { setFocus(nx[1]); return; } }
      setFocus((focusI + (dir === 'down' ? 1 : -1) + items.length) % items.length); return;
    }
    if (dir === 'left' || dir === 'right') {
      if (cur && cur.dataset.adj) { adjust(cur.dataset.adj, dir === 'right' ? 1 : -1); return; }
      if (cur && cur.classList.contains('bk')) { const nx = items[focusI + (dir === 'right' ? 1 : -1)]; if (nx && nx.classList.contains('bk') && nx.dataset.id === cur.dataset.id) setFocus(focusI + (dir === 'right' ? 1 : -1)); }
      return;
    }
    if (dir === 'ok' && cur) { if (cur.dataset.adj) adjust(cur.dataset.adj, 0); else cur.click(); }
  }

  function open(where) { from = where || 'lobby'; el.classList.toggle('in-fight', from === 'fight'); el.hidden = false; focusI = Dev.device === 'pad' ? 0 : -1; refresh(); if (focusI >= 0) setFocus(0, true); }
  function close() { if (capture) endCapture(); el.hidden = true; el.querySelectorAll('.focus').forEach((n) => n.classList.remove('focus')); focusI = -1; sfx(false); o.onClose(from); }
  return {
    open, close, nav, refresh,
    get isOpen() { return !el.hidden; },
    get capturing() { return capture ? capture.dev : null; },
    // a pad button while a capture is open: Start cancels, anything else binds (when the capture is for the pad)
    capturePad(i, start) { if (!capture) return; if (i === start) endCapture(); else if (capture.dev === 'pad' && i < 16) endCapture(i); },
  };
}
