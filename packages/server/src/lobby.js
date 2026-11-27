// Rooms and the lobby. A player opens the client's URL, the client connects to /ws?room=<name> (default "main") and says
// hello; they are in that room's lobby, where everyone picks a class. Anyone can pick an encounter: everyone in the lobby
// loads in. A boss fight locks the room (newcomers watch until it ends); the training dummy does not (newcomers walk in).
// When the fight ends (a kill, a wipe, or someone ends it) everyone is back in the lobby.
//
// Each running encounter gets its own worker thread (fight-worker.js). The lobby relays input to it and its snapshot
// messages to every socket in the room.
import { Worker } from 'node:worker_threads';
import { PROTOCOL_VERSION, LOBBY_CLASSES, ENCOUNTERS, MAX_PARTY, cleanName, decode } from '@axiom/protocol';
import { G, TICK_HZ } from '@axiom/sim';
import '@axiom/sim/bosses';

const WORKER = new URL('./fight-worker.js', import.meta.url);
const MAX_MEMBERS = 12, MAX_TRAINING = 8, BACKLOG = 512 * 1024;
let nextMember = 1;

// what the lobby can offer, for the welcome message (the sim's own definitions, filtered to the MVP roster)
function catalog() {
  const classes = LOBBY_CLASSES.map((id) => G.classes.find((c) => c.id === id)).filter(Boolean).map((c) => ({
    id: c.id, name: c.name, role: c.role, color: c.color, resource: c.resource.name, resKind: c.resource.kind || 'pips', resMax: c.resource.max, melee: !!c.melee, look: c.look,
    skills: c.skills.map((s, i) => s ? { slot: i, key: '123QERF'[i], id: s.id, icon: s.icon, name: s.name, desc: s.desc, gcd: s.gcd !== false, cd: s.cd || 0, cast: typeof s.cast === 'number' ? s.cast : 0, limited: s.limited || 0 } : null),
  }));
  const bosses = ENCOUNTERS.map((id) => G.bosses.find((b) => b.id === id)).filter(Boolean).map((b) => ({ id: b.id, name: b.name, title: b.title || '', training: !!b.training, nightmare: !!b.nightmare,
    ticks: (b.phases || []).map((q) => q.at).filter((at) => at < 1), nmTicks: b.nightmare && b.nightmare.phases ? b.nightmare.phases.map((q) => q.at).filter((at) => at < 1) : null }));
  return { classes, bosses };
}

export class Room {
  constructor(server, name) { this.server = server; this.name = name; this.members = []; this.phase = 'lobby'; this.enc = null; this.worker = null; }
  get humans() { return this.members.filter((m) => !m.bot); }
  post(msg) { if (this.worker) this.worker.postMessage(msg); }
  send(m, msg) { if (m.sock && m.sock.open) m.sock.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
  broadcast(msg) { const s = typeof msg === 'string' ? msg : JSON.stringify(msg); for (const m of this.members) this.send(m, s); }
  note(m, text) { this.send(m, { t: 'note', text }); }
  lobbyMsg() {
    return { t: 'lobby', room: this.name, phase: this.phase, enc: this.enc,
      members: this.members.map((m) => ({ id: m.id, name: m.name, cls: m.cls, bot: !!m.bot, auto: !!m.auto, inFight: !!m.inFight, sim: m.sim || null })) };
  }
  sync() { this.broadcast(this.lobbyMsg()); }

  // ---- membership
  join(m) {
    if (this.members.length >= MAX_MEMBERS) { this.note(m, 'This room is full.'); m.sock.close(1008, 'room full'); return false; }
    m.room = this; this.members.push(m);
    this.send(m, Object.assign({ t: 'welcome', v: PROTOCOL_VERSION, id: m.id, room: this.name, tickHz: TICK_HZ }, catalog()));
    if (this.phase === 'fight') {
      if (this.enc.training && this.members.filter((q) => q.inFight).length < MAX_TRAINING) this.walkIn(m);
      else { this.send(m, { t: 'start', enc: this.enc, you: null, tickHz: TICK_HZ }); this.note(m, `A fight is under way (${this.enc.name}). You are watching; you will be in the lobby when it ends.`); }
    }
    this.sync(); return true;
  }
  walkIn(m) { m.inFight = true; this.post({ t: 'join', entry: { key: m.id, cls: m.cls, name: m.name, bot: m.bot || m.auto } }); }
  leave(m) {
    const i = this.members.indexOf(m); if (i < 0) return; this.members.splice(i, 1);
    if (this.phase === 'fight' && m.inFight) {
      if (this.enc.training) this.post({ t: 'leave', key: m.id });
      else { this.post({ t: 'auto', key: m.id, on: true }); } // a boss fight goes on: the autopilot takes the empty seat
    }
    if (!this.humans.length) { this.stopFight(); this.server.rooms.delete(this.name); return; }
    this.sync();
  }

  // ---- messages from a member
  onMessage(m, msg) {
    switch (msg.t) {
      case 'ping': return this.send(m, { t: 'pong', c: msg.c });
      case 'input': if (this.phase === 'fight' && m.inFight && !m.auto) this.post({ t: 'input', key: m.id, f: msg.f }); return;
      case 'class': {
        if (!LOBBY_CLASSES.includes(msg.cls)) return this.note(m, 'That class is not open yet.');
        if (this.phase === 'lobby') { m.cls = msg.cls; return this.sync(); }
        if (this.enc.training && m.inFight) { m.cls = msg.cls; this.post({ t: 'swap', key: m.id, cls: msg.cls }); return this.sync(); }
        return this.note(m, 'You can change class in the lobby, or on the training dummy.');
      }
      case 'start': return this.start(m, msg.boss, !!msg.nm);
      case 'end': if (this.phase === 'fight') { this.stopFight(); this.broadcast({ t: 'end', result: 'ended', by: m.name, ft: 0, stats: [] }); this.backToLobby(); } return;
      case 'auto': { // the autopilot plays your character; asked in the lobby, it plays from the pull
        m.auto = !!msg.on; if (this.phase === 'fight' && m.inFight) this.post({ t: 'auto', key: m.id, on: m.auto });
        return this.sync();
      }
      case 'addBot': {
        if (this.phase !== 'lobby') return this.note(m, 'Bots join in the lobby.');
        if (this.members.length >= MAX_MEMBERS) return;
        const n = this.members.filter((q) => q.bot).length + 1;
        this.members.push({ id: nextMember++, name: 'Bot ' + n, cls: LOBBY_CLASSES.includes(msg.cls) ? msg.cls : LOBBY_CLASSES[n % LOBBY_CLASSES.length], bot: true, sock: null, room: this });
        return this.sync();
      }
      case 'dropBot': { const b = this.members.find((q) => q.bot && q.id === msg.id); if (b && this.phase === 'lobby') { this.members.splice(this.members.indexOf(b), 1); this.sync(); } return; }
    }
  }

  // ---- encounters
  start(m, boss, nm) {
    if (this.phase !== 'lobby') return this.note(m, 'An encounter is already running.');
    const def = ENCOUNTERS.includes(boss) && G.bosses.find((d) => d.id === boss); if (!def) return this.note(m, 'Unknown encounter.');
    const cap = def.training ? MAX_TRAINING : MAX_PARTY, party = this.members.slice(0, cap);
    this.enc = { boss, name: def.name, nm: nm && !!def.nightmare, training: !!def.training, by: m.name, at: Date.now() };
    this.phase = 'fight';
    for (const q of this.members) { q.inFight = party.includes(q); q.sim = null; }
    const w = this.worker = new Worker(WORKER);
    w.on('message', (e) => this.onWorker(w, e));
    w.on('error', (e) => { console.error('fight worker', e); if (this.worker === w) { this.broadcast({ t: 'note', text: 'The fight crashed on the server.' }); this.stopFight(); this.backToLobby(); } });
    w.postMessage({ t: 'start', speed: this.server.speed, setup: { boss, nm: this.enc.nm, intro: !def.training && this.server.intro, players: party.map((q) => ({ key: q.id, cls: q.cls, name: q.name, bot: q.bot || q.auto })) }, seed: this.server.seed });
    if (this.members.length > party.length) for (const q of this.members) if (!q.inFight) this.note(q, `A boss takes ${cap} players: you are watching this one.`);
    this.sync();
  }
  onWorker(w, e) {
    if (w !== this.worker) return;
    if (e.t === 'snap') { for (const m of this.members) if (m.sock && m.sock.open && m.sock.buffered < BACKLOG) m.sock.send(e.data); }
    else if (e.t === 'started') {
      const ids = new Map(e.ids); this.enc.seed = e.seed;
      for (const m of this.members) { m.sim = ids.get(m.id) || null; this.send(m, { t: 'start', enc: this.enc, you: m.sim, tickHz: e.hz }); }
      this.sync();
    } else if (e.t === 'joined') {
      const m = this.members.find((q) => q.id === e.key); if (!m) return; m.sim = e.you;
      this.send(m, { t: 'start', enc: this.enc, you: e.you, tickHz: TICK_HZ }); this.sync();
    } else if (e.t === 'end') {
      if (e.errors && e.errors.length) console.error('fight errors', e.errors);
      this.broadcast({ t: 'end', result: e.result, ft: e.ft, stats: e.stats.map((s) => Object.assign(s, { name: s.name || (this.members.find((q) => q.sim === s.id) || {}).name || '' })) });
      this.stopFight(); this.backToLobby();
    } else if (e.t === 'error') console.error('fight worker:', e.msg);
  }
  stopFight() { const w = this.worker; this.worker = null; if (w) { w.postMessage({ t: 'stop' }); setTimeout(() => w.terminate(), 200); } }
  backToLobby() { this.phase = 'lobby'; this.enc = null; for (const m of this.members) { m.inFight = false; m.sim = null; } this.sync(); }
}

// one socket: a member of a room once it has said hello
export function onConnection(server, sock, url) {
  const roomName = (url.searchParams.get('room') || 'main').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'main';
  const m = { id: nextMember++, name: '', cls: LOBBY_CLASSES[0], bot: false, sock, room: null, inFight: false };
  sock.on('message', (text) => {
    const msg = decode(text); if (!msg) return;
    if (!m.room) {
      if (msg.t !== 'hello') return;
      m.name = cleanName(msg.name) || 'Player ' + m.id;
      if (LOBBY_CLASSES.includes(msg.cls)) m.cls = msg.cls;
      let room = server.rooms.get(roomName); if (!room) server.rooms.set(roomName, room = new Room(server, roomName));
      room.join(m); return;
    }
    try { m.room.onMessage(m, msg); } catch (e) { console.error('message', msg.t, e); }
  });
  server.socks.add(sock);
  sock.on('close', () => { server.socks.delete(sock); if (m.room) m.room.leave(m); });
}
