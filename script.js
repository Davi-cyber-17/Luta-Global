'use strict';
/* =====================================================
   LUTA GLOBAL — HTML + CSS + JS
   Modo Local (teclado + bots) e Modo Online (salas via PeerJS).
   O anfitrião da sala roda a simulação; os outros enviam
   seus comandos e recebem o estado do jogo ~20x por segundo.
   ===================================================== */

const W = 960, H = 540;
const COLORS = ['#ffe21a', '#35e07a', '#ff8a1a', '#b44cff', '#ff3030', '#2f8dff'];
const SPAWNS = [[150, 100], [810, 100], [90, 265], [870, 265], [210, 400], [750, 400]];
const ORDER = [0, 5, 1, 4, 2, 3];            // ordem de ocupação das posições (opostos primeiro)
const PREFIX = 'lutaglobal-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LAVA_BASE = 480, SUDDEN_AT = 40;

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const show = id => document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));

/* ---------- estado global ---------- */
let mode = null;          // 'local' | 'host' | 'client'
let G = null;             // estado do jogo
let inputs = [];          // comandos por posição (slot)
let mySlot = 0, loopId = 0, tick = 0, overShown = false;
let lastRoster = [], localMap = [], parts = [];
let lobby = [];           // [{slot,name,bot,conn}]
const net = { peer: null, hostConn: null, code: '', inGame: false };
const cfg = { total: 4, humans: 2 };

/* ---------- teclado e toque ---------- */
const KEYMAPS = [
  { l: ['KeyA'], r: ['KeyD'], u: ['KeyW'], d: ['KeyS'], f: ['Space'] },
  { l: ['ArrowLeft'], r: ['ArrowRight'], u: ['ArrowUp'], d: ['ArrowDown'], f: ['Enter'] },
  { l: ['KeyJ'], r: ['KeyL'], u: ['KeyI'], d: ['KeyK'], f: ['KeyO'] },
  { l: ['KeyF'], r: ['KeyH'], u: ['KeyT'], d: ['KeyG'], f: ['KeyY'] }
];
const KEYTXT = ['W A S D + Espaço', 'Setas + Enter', 'I J K L + O', 'T F G H + Y'];
const ONLINE_MAP = { l: ['KeyA', 'ArrowLeft'], r: ['KeyD', 'ArrowRight'], u: ['KeyW', 'ArrowUp'], d: ['KeyS', 'ArrowDown'], f: ['Space', 'Enter', 'KeyF'] };
const BLOCK = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const down = new Set();
const touch = { l: false, r: false, u: false, d: false, f: false };

addEventListener('keydown', e => {
  if (loopId && G && BLOCK.has(e.code)) e.preventDefault();
  down.add(e.code);
});
addEventListener('keyup', e => down.delete(e.code));
addEventListener('blur', () => down.clear());

const readKeys = (map, useTouch = false) => {
  const o = {};
  for (const k of 'lrudf') o[k] = map[k].some(c => down.has(c)) || (useTouch && touch[k]);
  return o;
};

const isTouch = matchMedia('(pointer:coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer:fine)').matches);
document.body.classList.toggle('touch', isTouch);

(function setupTouch() {                            // joystick virtual + botão de tiro
  const fire = document.querySelector('#touch .fire');
  const setF = v => { touch.f = v; fire.classList.toggle('on', v); };
  fire.addEventListener('pointerdown', e => { e.preventDefault(); try { fire.setPointerCapture(e.pointerId); } catch (x) { /* ok */ } setF(true); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => fire.addEventListener(ev, () => setF(false)));

  const joy = $('joy'), knob = $('joy-knob');
  let pid = null;
  const move = e => {
    const r = joy.getBoundingClientRect(), rad = r.width / 2;
    const dx = e.clientX - (r.left + rad), dy = e.clientY - (r.top + rad);
    const k = Math.min(1, rad * .6 / (Math.hypot(dx, dy) || 1)), th = .28;
    knob.style.transform = 'translate(' + dx * k + 'px,' + dy * k + 'px)';
    touch.l = dx / rad < -th; touch.r = dx / rad > th; touch.u = dy / rad < -th; touch.d = dy / rad > th;
  };
  const end = () => { pid = null; knob.style.transform = ''; touch.l = touch.r = touch.u = touch.d = false; };
  joy.addEventListener('pointerdown', e => { e.preventDefault(); pid = e.pointerId; try { joy.setPointerCapture(pid); } catch (x) { /* ok */ } move(e); });
  joy.addEventListener('pointermove', e => { if (e.pointerId === pid) move(e); });
  ['pointerup', 'pointercancel'].forEach(ev => joy.addEventListener(ev, e => { if (e.pointerId === pid) end(); }));
  addEventListener('contextmenu', e => { if (G) e.preventDefault(); });
})();

/* ---------- som ---------- */
let ac = null, muted = false;
function beep(f, d, type = 'square', v = .035) {
  if (muted) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f * .5), t + d);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(t + d);
  } catch (e) { /* sem áudio */ }
}
$('btn-mute').onclick = () => { muted = !muted; $('btn-mute').textContent = muted ? 'Mudo' : 'Som'; };

/* =====================================================
   SIMULAÇÃO (roda no modo local e no anfitrião)
   ===================================================== */
function newGame(roster) {
  G = { T: 0, over: false, winner: -1, players: [], balls: [], ev: [], lava: LAVA_BASE, nextBall: 1 };
  roster.forEach(r => {
    const [x, y] = SPAWNS[r.slot];
    G.players.push({
      slot: r.slot, name: r.name, bot: !!r.bot, x, y, tx: x, ty: y, vx: 0, vy: 0,
      hp: 100, alive: true, cd: .6 + Math.random() * .4, face: x < W / 2 ? 1 : -1,
      hit: 0, swing: 0, bt: 0, skill: rand(.55, .95)
    });
  });
}

function ev(k, x, y, s) {            // evento visual/sonoro (+ envio aos clientes)
  fxEvent(k, x, y, s);
  if (mode === 'host') G.ev.push([k, Math.round(x), Math.round(y), s]);
}

function hurt(p, amount) {
  if (!p.alive) return;
  p.hp -= amount; p.hit = .12;
  if (p.hp <= 0) { p.hp = 0; p.alive = false; ev('d', p.x, p.y, p.slot); }
}

function nearest(p) {
  let best = null, bd = 1e9;
  for (const q of G.players) {
    if (q === p || !q.alive) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function botInput(p, target, dt) {
  p.bt -= dt;
  if (p.bt <= 0) { p.bt = rand(.7, 1.8); p.tx = rand(60, W - 60); p.ty = rand(80, 430); }
  let dx = p.tx - p.x, dy = p.ty - p.y;
  for (const b of G.balls) {                       // tenta desviar das bolas
    if (b.o === p.slot) continue;
    const rx = p.x - b.x, ry = p.y - b.y, d = Math.hypot(rx, ry);
    if (d > 190 * p.skill) continue;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    if ((rx * b.vx + ry * b.vy) / (d * sp + 1e-6) > .85) {
      const px = -b.vy / sp, py = b.vx / sp, side = (rx * px + ry * py) >= 0 ? 1 : -1;
      dx = px * side * 200; dy = py * side * 200; break;
    }
  }
  if (p.y + 40 > G.lava - 20) dy = -200;           // foge da lava
  const th = 14;
  return { l: dx < -th, r: dx > th, u: dy < -th, d: dy > th, f: !!target && Math.random() < .55 };
}

function shoot(p, t) {
  const a = Math.atan2(t.y - p.y, t.x - p.x), sp = 440;
  G.balls.push({ x: p.x + Math.cos(a) * 30, y: p.y + Math.sin(a) * 30, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, o: p.slot, life: 2.6 });
  p.cd = .55;
  ev('s', p.x, p.y, p.slot);
}

function step(dt) {
  if (G.over) return;
  G.T += dt;
  G.lava = Math.max(230, LAVA_BASE - Math.max(0, G.T - SUDDEN_AT) * 6);

  for (const p of G.players) {
    if (!p.alive) continue;
    const target = nearest(p);
    const inp = p.bot ? botInput(p, target, dt) : (inputs[p.slot] || {});
    const ax = (inp.r ? 1 : 0) - (inp.l ? 1 : 0), ay = (inp.d ? 1 : 0) - (inp.u ? 1 : 0);
    const len = Math.hypot(ax, ay) || 1, sp = 235, k = Math.min(1, dt * 10);
    p.vx += (ax / len * sp - p.vx) * k;
    p.vy += (ay / len * sp - p.vy) * k;
    p.x = clamp(p.x + p.vx * dt, 40, W - 40);
    p.y = clamp(p.y + p.vy * dt, 70, 440);
    if (target) p.face = target.x >= p.x ? 1 : -1;
    p.cd -= dt; p.hit = Math.max(0, p.hit - dt); p.swing = Math.max(0, p.swing - dt);
    if (inp.f && p.cd <= 0 && target) shoot(p, target);
    if (p.y + 34 > G.lava) hurt(p, 25 * dt);       // lava queima
  }

  for (const b of G.balls) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H) { b.dead = true; continue; }
    for (const p of G.players) {
      if (!p.alive || p.slot === b.o) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) < 25) {
        hurt(p, 12); p.vx += b.vx * .3; p.vy += b.vy * .3;
        ev('h', b.x, b.y, p.slot); b.dead = true; break;
      }
    }
  }
  for (let i = 0; i < G.balls.length; i++) {       // bolas se anulam ao colidir
    for (let j = i + 1; j < G.balls.length; j++) {
      const a = G.balls[i], b = G.balls[j];
      if (!a.dead && !b.dead && a.o !== b.o && Math.hypot(a.x - b.x, a.y - b.y) < 16) {
        a.dead = b.dead = true; ev('h', a.x, a.y, a.o);
      }
    }
  }
  G.balls = G.balls.filter(b => !b.dead);
  checkWin();
}

function checkWin() {
  const alive = G.players.filter(p => p.alive);
  if (alive.length <= 1 && G.players.length >= 2) {
    G.over = true;
    G.winner = alive.length ? alive[0].slot : -1;
  }
}

/* =====================================================
   EFEITOS
   ===================================================== */
function burst(x, y, c, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, s = 40 + Math.random() * 220;
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, l: .5 + Math.random() * .5, c, r: 2 + Math.random() * 3 });
  }
}
function fxEvent(k, x, y, s) {
  if (k === 's') {
    const p = G.players.find(q => q.slot === s); if (p) p.swing = .25;
    burst(x, y, '#fff', 3); beep(520, .08);
  } else if (k === 'h') {
    burst(x, y, COLORS[s], 10); burst(x, y, '#ff9a2e', 6); beep(180, .12, 'sawtooth');
  } else if (k === 'd') {
    burst(x, y, COLORS[s], 40); burst(x, y, '#ffd54a', 25); beep(90, .4, 'sawtooth', .06);
  }
}
function updateParts(dt) {
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 400 * dt; p.l -= dt; }
  parts = parts.filter(p => p.l > 0);
}

/* =====================================================
   REDE (PeerJS)
   ===================================================== */
const encodeIn = i => (i.l ? 1 : 0) | (i.r ? 2 : 0) | (i.u ? 4 : 0) | (i.d ? 8 : 0) | (i.f ? 16 : 0);
const decodeIn = n => ({ l: !!(n & 1), r: !!(n & 2), u: !!(n & 4), d: !!(n & 8), f: !!(n & 16) });
const getName = () => ($('name-in').value.trim().slice(0, 12)) || 'Jogador' + Math.floor(rand(10, 99));
const setStatus = t => { $('online-status').textContent = t; };
const genCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

function cleanupNet() {
  try { if (net.peer) net.peer.destroy(); } catch (e) { /* ok */ }
  net.peer = null; net.hostConn = null; net.code = ''; net.inGame = false;
  lobby = [];
}
/* Servidores ICE. O STUN gratuito resolve a maioria das redes (Wi-Fi <-> Wi-Fi, PC <-> celular).
   Em algumas redes 4G/5G ou Wi-Fi restritos é preciso um servidor TURN (relay).
   Para ativar: crie uma conta grátis em metered.ca, crie um app e preencha os dois campos abaixo. */
const TURN_APP = '';   // ex.: 'meuapp'  (de meuapp.metered.live)
const TURN_KEY = '';   // sua API key da Metered
const STUN = [
  { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }, { urls: 'stun:stun.cloudflare.com:3478' }
];
let iceCache = null;
async function getPeerOpts() {
  if (!iceCache) {
    let servers = STUN.slice();
    if (TURN_APP && TURN_KEY) {
      try {
        const r = await fetch('https://' + TURN_APP + '.metered.live/api/v1/turn/credentials?apiKey=' + TURN_KEY);
        const list = await r.json();
        if (Array.isArray(list)) servers = servers.concat(list);
      } catch (e) { /* segue só com STUN */ }
    }
    iceCache = { config: { iceServers: servers, iceCandidatePoolSize: 4 } };
  }
  return iceCache;
}

const sendAll = o => lobby.forEach(p => { if (p.conn && p.conn.open) p.conn.send(o); });
const publicLobby = () => lobby.map(p => ({ slot: p.slot, name: p.name, bot: p.bot }));

function broadcastLobby() {
  lobby.forEach(p => {
    if (p.conn && p.conn.open) p.conn.send({ m: 'lobby', code: net.code, players: publicLobby(), you: p.slot });
  });
  renderRoom();
}
function freeSlot() { return ORDER.find(s => !lobby.some(p => p.slot === s)); }

/* --- anfitrião --- */
function createRoom() {
  if (typeof Peer === 'undefined') { setStatus('Não foi possível carregar a biblioteca online. Verifique sua conexão.'); return; }
  cleanupNet();
  setStatus('Criando sala…');
  const name = getName();
  const attempt = async n => {
    const code = genCode();
    let opened = false;
    const peer = new Peer(PREFIX + code, await getPeerOpts());
    peer.on('open', () => {
      opened = true;
      net.peer = peer; net.code = code; mode = 'host';
      mySlot = ORDER[0];
      lobby = [{ slot: mySlot, name, bot: false, conn: null }];
      show('screen-room'); renderRoom();
    });
    peer.on('connection', onHostConn);
    peer.on('error', err => {
      if (!opened && err.type === 'unavailable-id' && n < 5) { peer.destroy(); attempt(n + 1); }
      else if (!opened) setStatus('Erro ao criar sala (' + err.type + '). Tente de novo.');
    });
  };
  attempt(0);
}

function onHostConn(conn) {
  conn.on('open', () => {
    if (net.inGame || lobby.length >= 6) {
      conn.send({ m: 'busy', why: net.inGame ? 'A batalha já começou.' : 'A sala está cheia.' });
      setTimeout(() => conn.close(), 400);
    }
  });
  conn.on('data', d => hostData(conn, d));
  conn.on('close', () => hostLeave(conn));
}

function hostData(conn, d) {
  if (!d) return;
  if (d.m === 'join') {
    if (net.inGame || lobby.length >= 6 || lobby.some(p => p.conn === conn)) return;
    lobby.push({ slot: freeSlot(), name: String(d.name || 'Jogador').slice(0, 12), bot: false, conn });
    broadcastLobby();
  } else if (d.m === 'in') {
    const p = lobby.find(x => x.conn === conn);
    if (p) inputs[p.slot] = decodeIn(d.k | 0);
  }
}

function hostLeave(conn) {
  const i = lobby.findIndex(p => p.conn === conn);
  if (i < 0) return;
  const [gone] = lobby.splice(i, 1);
  if (net.inGame && G) {
    const p = G.players.find(q => q.slot === gone.slot);
    if (p && p.alive) { p.alive = false; p.hp = 0; ev('d', p.x, p.y, p.slot); checkWin(); }
  } else broadcastLobby();
}

function hostStart() {
  if (lobby.length < 2) { alert('São necessários pelo menos 2 jogadores.'); return; }
  lastRoster = lobby.map(p => ({ slot: p.slot, name: p.name, bot: p.bot }));
  net.inGame = true;
  sendAll({ m: 'start', roster: lastRoster });
  startGame(lastRoster);
}

function snapshot() {
  return {
    m: 'snap', T: +G.T.toFixed(2), l: Math.round(G.lava), o: G.over ? 1 : 0, w: G.winner,
    p: G.players.map(p => [p.slot, Math.round(p.x), Math.round(p.y), Math.round(p.hp), p.alive ? 1 : 0, p.face, p.hit > 0 ? 1 : 0]),
    b: G.balls.map(b => [Math.round(b.x), Math.round(b.y), b.o, Math.round(b.vx), Math.round(b.vy)]),
    e: G.ev
  };
}

/* --- cliente --- */
async function joinRoom() {
  if (typeof Peer === 'undefined') { setStatus('Não foi possível carregar a biblioteca online. Verifique sua conexão.'); return; }
  const code = $('code-in').value.trim().toUpperCase();
  if (code.length !== 4) { setStatus('Digite o código de 4 letras da sala.'); return; }
  cleanupNet();
  setStatus('Conectando…');
  const name = getName();
  mode = null;
  const peer = new Peer(await getPeerOpts());
  net.peer = peer;
  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code, { reliable: true });
    net.hostConn = conn; net.code = code;
    const timer = setTimeout(() => {
      if (mode !== 'client') {
        setStatus('Não foi possível conectar. Confira o código e se todos abriram o mesmo site. Em algumas redes 4G/5G é preciso configurar um servidor TURN (veja o topo da seção de rede no script.js).');
        cleanupNet();
      }
    }, 15000);
    conn.on('open', () => { clearTimeout(timer); mode = 'client'; conn.send({ m: 'join', name }); });
    conn.on('data', clientData);
    conn.on('close', () => { if (mode === 'client') { alert('A conexão com a sala foi encerrada.'); leaveAll(); } });
  });
  peer.on('error', err => {
    setStatus(err.type === 'peer-unavailable' ? 'Sala não encontrada. Confira o código.' : 'Erro de conexão (' + err.type + ').');
    mode = null;
  });
}

function clientData(d) {
  if (!d) return;
  if (d.m === 'lobby') {
    lobby = d.players; mySlot = d.you; net.code = d.code;
    if (!net.inGame) { show('screen-room'); renderRoom(); }
  } else if (d.m === 'busy') {
    setStatus(d.why); cleanupNet(); mode = null;
  } else if (d.m === 'start') {
    net.inGame = true; lastRoster = d.roster; startGame(d.roster);
  } else if (d.m === 'snap') applySnap(d);
}

function applySnap(s) {
  if (!G) return;
  G.T = s.T; G.lava = s.l;
  for (const a of s.p) {
    const p = G.players.find(q => q.slot === a[0]); if (!p) continue;
    p.tx = a[1]; p.ty = a[2]; p.hp = a[3]; p.alive = !!a[4]; p.face = a[5]; p.hit = a[6] ? .1 : 0;
  }
  G.balls = s.b.map(a => ({ x: a[0], y: a[1], o: a[2], vx: a[3], vy: a[4] }));
  s.e.forEach(e => fxEvent(e[0], e[1], e[2], e[3]));
  if (s.o) { G.over = true; G.winner = s.w; }
}

/* =====================================================
   LOOP PRINCIPAL
   ===================================================== */
function startGame(roster) {
  inputs = [0, 1, 2, 3, 4, 5].map(() => ({}));
  newGame(roster);
  parts = []; overShown = false; tick = 0;
  show('screen-game');
  $('overlay').hidden = true;
  $('keys-hint').textContent = mode === 'local'
    ? 'Mire automática no inimigo mais próximo. Desvie das bolas e cuidado com a lava!'
    : 'Mover: WASD ou setas · Atirar: Espaço ou Enter · Mire automática';
  const id = ++loopId;
  let last = performance.now(), lastSend = 0, lastBits = -1;
  const frame = ts => {
    if (id !== loopId) return;
    const dt = Math.min(.05, (ts - last) / 1000); last = ts;

    if (mode === 'local') {
      localMap.forEach(m => { inputs[m.slot] = readKeys(KEYMAPS[m.k], m.k === 0); });
      step(dt);
    } else if (mode === 'host') {
      inputs[mySlot] = readKeys(ONLINE_MAP, true);
      const wasOver = G.over;
      step(dt); tick++;
      if (tick % 3 === 0 || (G.over && !wasOver)) { sendAll(snapshot()); G.ev = []; }
    } else if (mode === 'client') {
      const bits = encodeIn(readKeys(ONLINE_MAP, true));
      if (net.hostConn && net.hostConn.open && (bits !== lastBits || ts - lastSend > 150)) {
        net.hostConn.send({ m: 'in', k: bits }); lastBits = bits; lastSend = ts;
      }
      const k = Math.min(1, dt * 12);
      for (const p of G.players) {
        p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
        p.swing = Math.max(0, p.swing - dt); p.hit = Math.max(0, p.hit - dt);
      }
      for (const b of G.balls) { b.x += b.vx * dt; b.y += b.vy * dt; }
      if (!G.over) G.T += dt;
    }

    updateParts(dt);
    draw(ts / 1000);
    if (G.over && !overShown) showOver();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function showOver() {
  overShown = true;
  const w = G.players.find(p => p.slot === G.winner);
  $('over-title').textContent = w ? w.name + ' venceu!' : 'Empate!';
  $('over-title').style.color = w ? COLORS[w.slot] : '#fff';
  $('btn-again').hidden = mode === 'client';
  $('over-wait').hidden = mode !== 'client';
  $('overlay').hidden = false;
}

function leaveAll() {
  loopId++; G = null; mode = null; localMap = [];
  Object.keys(touch).forEach(k => { touch[k] = false; });
  cleanupNet();
  show('screen-menu');
}

/* =====================================================
   DESENHO (visual tecnológico)
   ===================================================== */
const cv = $('cv'), ctx = cv.getContext('2d');
const DPR = Math.min(2, window.devicePixelRatio || 1);
cv.width = W * DPR; cv.height = H * DPR;
const FONT = '"Chakra Petch", system-ui, sans-serif';

const bg = document.createElement('canvas');
bg.width = W * DPR; bg.height = H * DPR;
(function buildBg() {
  const c = bg.getContext('2d');
  c.scale(DPR, DPR);
  let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const HZ = 300;                                   // linha do horizonte
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#04061a'); g.addColorStop(.5, '#1b0c42'); g.addColorStop(.72, '#5a1257'); g.addColorStop(1, '#b8226a');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = '#fff';                             // estrelas
  for (let i = 0; i < 90; i++) { c.globalAlpha = .2 + r() * .7; const s = r() < .15 ? 2 : 1; c.fillRect(r() * W, r() * 260, s, s); }
  c.globalAlpha = 1;
  const hg = c.createRadialGradient(W / 2, HZ, 10, W / 2, HZ, 430);
  hg.addColorStop(0, 'rgba(255,90,160,.55)'); hg.addColorStop(1, 'rgba(255,90,160,0)');
  c.fillStyle = hg; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(34,230,255,.2)'; c.lineWidth = 2;   // anéis holográficos
  [[170, []], [212, [6, 10]], [255, [2, 14]]].forEach(([rad, dash]) => { c.setLineDash(dash); c.beginPath(); c.arc(W / 2, HZ - 10, rad, Math.PI, 0); c.stroke(); });
  c.setLineDash([]);
  let x = 0;                                        // cidade ao fundo
  while (x < W) {
    const w = 26 + r() * 40, h = 30 + r() * 120;
    c.fillStyle = '#0a0620'; c.fillRect(x, HZ - h, w, h);
    c.fillStyle = 'rgba(255,61,129,.55)'; c.fillRect(x, HZ - h, w, 2);
    c.fillStyle = 'rgba(34,230,255,.6)';
    for (let k = 0; k < 5; k++) if (r() < .6) c.fillRect(x + 4 + r() * (w - 10), HZ - h + 8 + r() * (h - 14), 2, 3);
    x += w + r() * 6;
  }
  c.fillStyle = '#0b0522'; c.fillRect(0, HZ, W, H - HZ); // chão com grade em perspectiva
  const fg = c.createLinearGradient(0, HZ, 0, H);
  fg.addColorStop(0, 'rgba(255,61,129,.4)'); fg.addColorStop(1, 'rgba(8,4,30,0)');
  c.fillStyle = fg; c.fillRect(0, HZ, W, H - HZ);
  c.strokeStyle = 'rgba(34,230,255,.35)'; c.lineWidth = 1.2;
  for (let i = -14; i <= 14; i++) { c.beginPath(); c.moveTo(W / 2 + i * 14, HZ); c.lineTo(W / 2 + i * 110, H); c.stroke(); }
  for (let i = 0; i < 9; i++) { const y = HZ + Math.pow(i / 8, 2) * (H - HZ); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
})();

const CORNERS = [
  [[0, 0], [78, 0], [0, 78]], [[W, 0], [W - 78, 0], [W, 78]],
  [[0, 205], [58, 265], [0, 325]], [[W, 205], [W - 58, 265], [W, 325]],
  [[0, H], [0, H - 78], [78, H]], [[W, H], [W - 78, H], [W, H - 78]]
];

function drawCorners() {
  CORNERS.forEach((tri, slot) => {
    const inGame = G.players.some(p => p.slot === slot);
    ctx.globalAlpha = inGame ? 1 : .22;
    ctx.fillStyle = COLORS[slot] + 'dd';
    ctx.beginPath(); ctx.moveTo(...tri[0]); ctx.lineTo(...tri[1]); ctx.lineTo(...tri[2]); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    ctx.strokeStyle = 'rgba(5,8,26,.55)'; ctx.lineWidth = 2;   // faixa interna
    ctx.beginPath();
    ctx.moveTo(tri[1][0] + (cx - tri[1][0]) * .45, tri[1][1] + (cy - tri[1][1]) * .45);
    ctx.lineTo(tri[2][0] + (cx - tri[2][0]) * .45, tri[2][1] + (cy - tri[2][1]) * .45);
    ctx.stroke();
    ctx.globalAlpha = 1;
  });
}

function drawLava(t) {
  const ly = G.lava, wave = x => ly + Math.sin(x * .03 + t * 2) * 4;
  const halo = ctx.createLinearGradient(0, ly - 38, 0, ly);
  halo.addColorStop(0, 'rgba(255,90,60,0)'); halo.addColorStop(1, 'rgba(255,90,60,.4)');
  ctx.fillStyle = halo; ctx.fillRect(0, ly - 38, W, 38);
  const g = ctx.createLinearGradient(0, ly, 0, H);
  g.addColorStop(0, '#ff5a3c'); g.addColorStop(.35, '#e01e6a'); g.addColorStop(1, '#6a0a4a');
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 16) ctx.lineTo(x, wave(x));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  for (const [lw, col] of [[7, 'rgba(255,200,120,.3)'], [2.5, '#fff2b0']]) {
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
    for (let x = 0; x <= W; x += 16) x ? ctx.lineTo(x, wave(x)) : ctx.moveTo(x, wave(x));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,225,140,.65)';
  for (let i = 0; i < 9; i++) {
    const bx = (i * 113 + 40) % W, by = ly + 14 + ((Math.sin(t * 1.3 + i * 2) + 1) / 2) * Math.max(4, H - ly - 18);
    ctx.beginPath(); ctx.arc(bx, by, 3 + (i % 3), 0, 7); ctx.fill();
  }
}

function drawKnight(p, t) {
  const f = p.face || 1, c = COLORS[p.slot], x = p.x, y = p.y + Math.sin(t * 3 + p.slot * 1.3) * 3;
  const flash = p.hit > 0, ink = '#0a0f22';
  ctx.lineJoin = 'round';
  // brilho e jato sob a plataforma
  const gl = ctx.createRadialGradient(x, y + 46, 2, x, y + 46, 44);
  gl.addColorStop(0, c + 'bb'); gl.addColorStop(1, c + '00');
  ctx.fillStyle = gl; ctx.fillRect(x - 46, y + 30, 92, 62);
  ctx.fillStyle = c + 'cc';
  ctx.beginPath(); ctx.moveTo(x - 10, y + 41); ctx.lineTo(x + 10, y + 41); ctx.lineTo(x, y + 54 + Math.sin(t * 30 + p.slot) * 3); ctx.fill();
  // plataforma metálica
  ctx.fillStyle = '#161d3a'; ctx.strokeStyle = ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x - 38, y + 29); ctx.lineTo(x + 38, y + 29); ctx.lineTo(x + 30, y + 41); ctx.lineTo(x - 30, y + 41); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x - 34, y + 31.5); ctx.lineTo(x + 34, y + 31.5); ctx.stroke();
  ctx.fillStyle = '#2b365f'; ctx.fillRect(x - 20, y + 35, 40, 3);
  // pernas
  ctx.fillStyle = '#2a3558'; ctx.fillRect(x - 10, y + 18, 8, 11); ctx.fillRect(x + 2, y + 18, 8, 11);
  // escudo de energia (costas)
  ctx.fillStyle = '#1c2548'; ctx.strokeStyle = c; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x - f * 21, y - 4); ctx.lineTo(x - f * 28, y + 3); ctx.lineTo(x - f * 28, y + 15); ctx.lineTo(x - f * 21, y + 22); ctx.lineTo(x - f * 14, y + 15); ctx.lineTo(x - f * 14, y + 3); ctx.closePath(); ctx.fill(); ctx.stroke();
  // corpo
  ctx.fillStyle = flash ? '#fff' : '#8d9bb8'; ctx.strokeStyle = ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(x - 13, y - 6, 26, 26, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = c; ctx.fillRect(x - 4, y - 3, 8, 20);
  ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(x - 1, y - 3, 2, 20);
  // espada de energia
  ctx.save();
  ctx.translate(x + f * 13, y + 6); ctx.scale(f, 1);
  ctx.rotate(-.9 + (p.swing > 0 ? (p.swing / .25) * 1.7 : 0));
  ctx.fillStyle = '#2a3558'; ctx.fillRect(0, -2.5, 9, 5);
  ctx.fillStyle = c + '66'; ctx.fillRect(9, -6, 30, 12);
  ctx.fillStyle = c; ctx.fillRect(9, -3.5, 28, 7);
  ctx.fillStyle = '#fff'; ctx.fillRect(9, -1.2, 28, 2.4);
  ctx.restore();
  // crista
  ctx.fillStyle = c; ctx.strokeStyle = ink; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x - 3, y - 29); ctx.quadraticCurveTo(x - f * 6, y - 47, x - f * 24, y - 37);
  ctx.quadraticCurveTo(x - f * 10, y - 33, x + 3, y - 29); ctx.closePath(); ctx.fill(); ctx.stroke();
  // capacete com visor luminoso
  ctx.fillStyle = flash ? '#fff' : '#a9b6d3'; ctx.strokeStyle = ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, y - 17, 13, 0, 6.283); ctx.fill(); ctx.stroke();
  ctx.fillStyle = ink; ctx.fillRect(x + f * 3 - 6, y - 21, 12, 6);
  ctx.fillStyle = c; ctx.fillRect(x + f * 3 - 5, y - 19.5, 10, 3);
  // barra de vida segmentada
  const bx = x - 32, by = y - 60;
  ctx.fillStyle = '#070a1c'; ctx.fillRect(bx - 2, by - 2, 68, 13);
  ctx.fillStyle = '#1c2548'; ctx.fillRect(bx, by, 64, 9);
  ctx.fillStyle = c; ctx.fillRect(bx, by, 64 * p.hp / 100, 9);
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(bx, by, 64 * p.hp / 100, 2);
  ctx.fillStyle = 'rgba(5,8,28,.85)'; for (let i = 1; i < 8; i++) ctx.fillRect(bx + i * 8 - .5, by, 1, 9);
  // nome
  ctx.font = '700 12px ' + FONT; ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.strokeText(p.name, x, by - 6);
  ctx.fillStyle = '#fff'; ctx.fillText(p.name, x, by - 6);
  if (mode !== 'local' && p.slot === mySlot) {      // marcador "você"
    ctx.fillStyle = c; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 6, by - 26); ctx.lineTo(x + 6, by - 26); ctx.lineTo(x, by - 17); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}

function draw(t) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.drawImage(bg, 0, 0, W, H);
  drawLava(t);
  for (const b of G.balls) {                        // orbes de energia
    const c = COLORS[b.o];
    ctx.strokeStyle = c + '88'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(b.x - b.vx * .045, b.y - b.vy * .045); ctx.lineTo(b.x, b.y); ctx.stroke();
    const g = ctx.createRadialGradient(b.x, b.y, 1, b.x, b.y, 17);
    g.addColorStop(0, '#fff'); g.addColorStop(.35, c); g.addColorStop(1, c + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, 17, 0, 7); ctx.fill();
  }
  ctx.lineCap = 'butt';
  for (const p of G.players) if (p.alive) drawKnight(p, t);
  ctx.globalCompositeOperation = 'lighter';
  for (const q of parts) {
    ctx.globalAlpha = clamp(q.l * 2, 0, 1); ctx.fillStyle = q.c;
    ctx.fillRect(q.x - q.r / 2, q.y - q.r / 2, q.r, q.r);
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  drawCorners();
  // HUD
  const s = Math.floor(G.T), txt = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  ctx.textAlign = 'center'; ctx.font = '700 17px "Share Tech Mono", monospace';
  ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.fillStyle = '#22e6ff';
  ctx.strokeText(txt, W / 2, 62); ctx.fillText(txt, W / 2, 62);
  if (G.T > SUDDEN_AT && !G.over && Math.floor(t * 2) % 2 === 0) {
    ctx.font = '700 20px ' + FONT;
    ctx.strokeText('A lava está subindo!', W / 2, 92); ctx.fillStyle = '#ffb02e'; ctx.fillText('A lava está subindo!', W / 2, 92);
  }
}

/* =====================================================
   INTERFACE (menus, local, sala)
   ===================================================== */
function renderCfg() {
  $('v-total').textContent = cfg.total;
  $('v-humans').textContent = cfg.humans;
  const ul = $('ctrl-list'); ul.innerHTML = '';
  for (let i = 0; i < cfg.total; i++) {
    const li = document.createElement('li'), dot = document.createElement('i'), nm = document.createElement('span'), tag = document.createElement('small');
    dot.style.background = COLORS[ORDER[i]];
    nm.textContent = i < cfg.humans ? 'Jogador ' + (i + 1) : 'Bot ' + (i - cfg.humans + 1);
    tag.textContent = i < cfg.humans ? KEYTXT[i] : 'automático';
    li.append(dot, nm, tag); ul.append(li);
  }
}
document.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
  const k = b.dataset.k, d = +b.dataset.step;
  cfg[k] = clamp(cfg[k] + d, k === 'total' ? 2 : 1, k === 'total' ? 6 : 4);
  cfg.humans = Math.min(cfg.humans, cfg.total);
  renderCfg();
});

function startLocal() {
  const roster = [];
  for (let i = 0; i < cfg.total; i++) {
    roster.push({ slot: ORDER[i], name: i < cfg.humans ? 'Jogador ' + (i + 1) : 'Bot ' + (i - cfg.humans + 1), bot: i >= cfg.humans });
  }
  localMap = roster.filter(r => !r.bot).map((r, i) => ({ slot: r.slot, k: i }));
  mode = 'local'; lastRoster = roster;
  startGame(roster);
}

function renderRoom() {
  $('room-code').textContent = net.code || '----';
  $('room-count').textContent = lobby.length + '/6';
  const ul = $('room-list'); ul.innerHTML = '';
  lobby.forEach(p => {
    const li = document.createElement('li'), dot = document.createElement('i'), nm = document.createElement('span');
    dot.style.background = COLORS[p.slot];
    nm.textContent = p.name + (p.slot === mySlot ? ' (você)' : '');
    li.append(dot, nm);
    if (p.bot) { const t = document.createElement('small'); t.textContent = 'bot'; li.append(t); }
    ul.append(li);
  });
  const isHost = mode === 'host';
  $('host-controls').hidden = !isHost;
  $('client-wait').hidden = isHost;
  $('btn-room-start').disabled = lobby.length < 2;
  $('start-hint').hidden = lobby.length >= 2;
  $('btn-add-bot').disabled = lobby.length >= 6;
  $('btn-del-bot').disabled = !lobby.some(p => p.bot);
}

function copyText(txt, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = 'Copiado!'; setTimeout(() => { btn.textContent = o; }, 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => prompt('Copie:', txt));
  else prompt('Copie:', txt);
}

/* ---------- botões ---------- */
$('btn-local').onclick = () => { renderCfg(); show('screen-local'); };
$('btn-online').onclick = () => { setStatus(''); show('screen-online'); };
document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show('screen-menu'));
$('btn-local-start').onclick = startLocal;
$('btn-create').onclick = createRoom;
$('btn-join').onclick = joinRoom;
$('code-in').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('btn-copy-code').onclick = e => copyText(net.code, e.currentTarget);
$('btn-copy-link').onclick = e => copyText(location.origin + location.pathname + '?sala=' + net.code, e.currentTarget);
$('btn-room-leave').onclick = leaveAll;
$('btn-quit').onclick = leaveAll;
if (!document.documentElement.requestFullscreen) $('btn-fs').hidden = true;
$('btn-fs').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen();
      try { await screen.orientation.lock('landscape'); } catch (e) { /* nem todo aparelho permite */ }
    }
  } catch (e) { /* sem tela cheia */ }
};
$('btn-over-quit').onclick = leaveAll;
$('btn-room-start').onclick = hostStart;
$('btn-add-bot').onclick = () => {
  if (mode !== 'host' || lobby.length >= 6) return;
  const n = lobby.filter(p => p.bot).length + 1;
  lobby.push({ slot: freeSlot(), name: 'Bot ' + n, bot: true, conn: null });
  broadcastLobby();
};
$('btn-del-bot').onclick = () => {
  if (mode !== 'host') return;
  for (let i = lobby.length - 1; i >= 0; i--) if (lobby[i].bot) { lobby.splice(i, 1); break; }
  broadcastLobby();
};
$('btn-again').onclick = () => {
  if (mode === 'local') startGame(lastRoster);
  else if (mode === 'host') hostStart();
};

/* ---------- inicialização ---------- */
(function init() {
  try { const n = localStorage.getItem('mb-name'); if (n) $('name-in').value = n; } catch (e) { /* ok */ }
  $('name-in').addEventListener('change', () => { try { localStorage.setItem('mb-name', $('name-in').value.trim()); } catch (e) { /* ok */ } });
  const sala = new URLSearchParams(location.search).get('sala');
  if (sala) { $('code-in').value = sala.toUpperCase().slice(0, 4); show('screen-online'); }
  renderCfg();
})();
addEventListener('beforeunload', cleanupNet);
