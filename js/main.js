import { firebaseConfig } from "./firebase-config.js";
import { createLocalBackend } from "./backend-local.js";
import { W, H, MAX_LEVEL, PALETTE, Board, Effects, drawBalloon } from "./paint.js";

// ---------- Game settings ----------
const COUNTDOWN_MS = 3800;       // 3, 2, 1, go
const TIME_LIMIT_MS = 30_000;    // painting stops for everyone after this
const END_GRACE_MS = 1500;       // host waits this long after time's up for the last splats to arrive
const HOST_GRACE_MS = 60_000;    // how long the host can be away before someone else takes over
const MAX_PLAYERS = PALETTE.length; // one unique colour each
const PUMP_COOLDOWN_MS = 90;     // max ~11 pumps a second, so auto-clickers gain nothing
const BALLOON_SYNC_MS = 120;     // how often your inflating balloon is shared with others

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const VIEWS = ["home", "lobby", "game", "results"];
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O

const pct = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%";
const randomCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
const cleanCode = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const inviteUrl = (code) => `${location.origin}${location.pathname}?room=${code}${backend?.kind === "local" ? "&local" : ""}`;
const num = (v, lo, hi) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

function show(view) {
  const changed = document.body.dataset.view !== view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.body.dataset.view = view;
  if (changed && view !== "home") window.scrollTo(0, 0);
  if (changed && view === "game") requestAnimationFrame(layout);
}

// ---------- State ----------
let backend = null;
let code = null;            // current room code
let room = null;            // latest room snapshot
let unwatch = null;
let game = null;            // per-round state, see ensureGame()
let hostOfflineSince = 0;
let wakeLock = null;
let qrFor = null;
let celebratedRound = null;

const me = () => room?.players?.[backend.uid];
const isHost = () => room?.hostId === backend.uid;
const isParticipant = () => !!room?.participants?.[backend.uid] && room?.colors?.[backend.uid] != null;
const roomPath = (p = "") => `rooms/${code}${p ? "/" + p : ""}`;

/** Online players in join order: this decides colours for the next round. */
function lobbyOrder() {
  return Object.entries(room?.players || {})
    .filter(([, p]) => p.online)
    .sort(([, a], [, b]) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
function colourOf(uid) {
  if (room?.status !== "lobby") return room?.colors?.[uid] ?? null;
  const i = lobbyOrder().findIndex(([id]) => id === uid);
  return i >= 0 && i < MAX_PLAYERS ? i : null;
}

// ---------- Sound ----------
let audio = null;
let noise = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    if (!noise) {
      noise = audio.createBuffer(1, audio.sampleRate * 0.4, audio.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    }
  } catch { /* no audio */ }
}
function squeak(level) {
  if (!audio) return;
  const t = audio.currentTime;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(260 + level * 28, t);
  o.frequency.exponentialRampToValueAtTime(340 + level * 34, t + 0.07);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + 0.12);
}
function popSound(level, mine) {
  if (!audio || !noise) return;
  const t = audio.currentTime;
  const vol = (mine ? 0.5 : 0.15) * (0.5 + level / MAX_LEVEL / 2);
  const src = audio.createBufferSource();
  src.buffer = noise;
  const f = audio.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 2600 - level * 60;
  const g = audio.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.connect(f).connect(g).connect(audio.destination);
  src.start(t);
  if (mine) {
    const o = audio.createOscillator();
    const og = audio.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(og).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.22);
  }
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}

// ---------- Rooms ----------
function playerRecord(name) {
  return { name, online: true, ready: true, joinedAt: backend.serverNow() };
}

async function createRoom() {
  const name = readName();
  if (!name) return;
  unlockAudio();
  setBusy(true);
  try {
    for (let i = 0; i < 8; i++) {
      const c = randomCode();
      const ok = await backend.createIfAbsent(`rooms/${c}`, {
        hostId: backend.uid,
        status: "lobby",
        round: 0,
        createdAt: backend.serverNow(),
        players: { [backend.uid]: playerRecord(name) },
      });
      if (ok) return enterRoom(c);
    }
    homeError("Couldn't create a room. Try again.");
  } catch (err) {
    console.error(err);
    homeError("Couldn't create a room. Check your connection.");
  } finally {
    setBusy(false);
  }
}

async function joinRoom(c) {
  const name = readName();
  if (!name) return;
  unlockAudio();
  c = cleanCode(c);
  if (c.length !== 4) return homeError("Room codes are 4 letters.");
  setBusy(true);
  try {
    const host = await backend.get(`rooms/${c}/hostId`);
    if (!host) {
      setInviteMode(null); // let them create their own room instead
      return homeError(`Room ${c} doesn't exist any more. Create a new one, or check the code.`);
    }
    const existing = await backend.get(`rooms/${c}/players/${backend.uid}`);
    await backend.update(`rooms/${c}/players/${backend.uid}`, existing
      ? { name, online: true, ready: true, b: null }
      : playerRecord(name));
    enterRoom(c);
  } catch (err) {
    console.error(err);
    homeError("Couldn't join that room. Check your connection.");
  } finally {
    setBusy(false);
  }
}

function enterRoom(c) {
  code = c;
  history.replaceState(null, "", `?room=${c}${backend.kind === "local" ? "&local" : ""}`);
  backend.onDisconnectSet(roomPath(`players/${backend.uid}/online`), false);
  unwatch?.();
  unwatch = backend.watch(roomPath(), (r) => { room = r; render(); });
}

async function leaveRoom() {
  if (!code) return;
  const c = code;
  unwatch?.();
  unwatch = null;
  await backend.cancelOnDisconnect(roomPath(`players/${backend.uid}/online`));
  await backend.set(`rooms/${c}/players/${backend.uid}`, null);
  code = null;
  room = null;
  endGame();
  history.replaceState(null, "", location.pathname + (backend.kind === "local" && params.has("local") ? "?local" : ""));
  setInviteMode(null);
  show("home");
}

async function startGame() {
  if (!isHost()) return;
  const players = lobbyOrder().slice(0, MAX_PLAYERS);
  if (!players.length) return;
  const startAt = backend.serverNow() + COUNTDOWN_MS;
  const updates = {
    status: "playing",
    round: (room.round || 0) + 1,
    seed: Math.floor(Math.random() * 1e9),
    startAt,
    endsAt: startAt + TIME_LIMIT_MS,
    participants: Object.fromEntries(players.map(([id, p]) => [id, p.name])),
    colors: Object.fromEntries(players.map(([id], i) => [id, i])),
    pops: null,
  };
  for (const id of Object.keys(room.players)) updates[`players/${id}/b`] = null;
  await backend.update(roomPath(), updates);
}

async function playAgain() {
  if (!isHost()) return;
  await backend.update(roomPath(), { status: "lobby", participants: null, colors: null, startAt: null, endsAt: null, pops: null });
}

// ---------- Round state ----------
function ensureGame() {
  if (game && game.round === room.round) return;
  endGame();
  game = {
    round: room.round,
    board: new Board($("paint")),
    fx: new Effects(),
    balloon: null,      // { id, x, y, l } while you're pumping
    lastPump: 0,
    lastSync: 0,
    syncTimer: null,
    ready: false,       // false while loading splats that already happened (no effects for those)
    raf: 0,
  };
  $("cover-bar").innerHTML = "";
  game.board.resize(240, 320); // until the game view is on screen (layout() resizes it then)
  layout();
  syncPaint();
  game.ready = true;
  if (me()?.b) backend.set(roomPath(`players/${backend.uid}/b`), null); // stale balloon from before a reload
  game.raf = requestAnimationFrame(frame);
}

function endGame() {
  if (!game) return;
  cancelAnimationFrame(game.raf);
  clearTimeout(game.syncTimer);
  game = null;
  keepAwake(false);
}

/** All valid splats for this round, from the room data. */
function collectSplats() {
  const out = [];
  const pops = room?.pops || {};
  for (const [uid, list] of Object.entries(pops)) {
    const color = room.colors?.[uid];
    if (color == null || !list) continue;
    for (const [k, p] of Object.entries(list)) {
      if (!p || p.r !== room.round) continue;
      const x = num(p.x, 0, W), y = num(p.y, 0, H), l = num(p.l, 0, MAX_LEVEL), t = num(p.t, 0, Infinity);
      if (x == null || y == null || l == null || t == null) continue;
      if (t < room.startAt || t > room.endsAt) continue; // painting stops when the timer hits zero
      out.push({ key: `${uid}/${k}`, uid, color, x, y, l, s: p.s | 0, t });
    }
  }
  return out;
}

function syncPaint() {
  if (!game) return;
  const fresh = game.board.sync(collectSplats());
  if (game.ready) {
    const now = backend.serverNow();
    for (const s of fresh) {
      if (now - s.t > 2500) continue;
      game.fx.burst(s.x, s.y, s.l, PALETTE[s.color].hex);
      if (s.uid !== backend.uid) popSound(s.l, false);
    }
  }
  if (fresh.length || !game.barBuilt) updateCoverage();
}

function updateCoverage() {
  const p = game.board.percentages();
  const ids = Object.keys(room.colors || {}).sort((a, b) => room.colors[a] - room.colors[b]);
  const bar = $("cover-bar");
  if (bar.children.length !== ids.length) {
    bar.innerHTML = "";
    for (const id of ids) {
      const seg = document.createElement("i");
      seg.style.background = PALETTE[room.colors[id]].hex;
      bar.appendChild(seg);
    }
  }
  ids.forEach((id, i) => { bar.children[i].style.width = p[room.colors[id]] + "%"; });
  game.barBuilt = true;
  const mine = room.colors?.[backend.uid];
  $("hud-me").hidden = mine == null || !isParticipant();
  if (mine != null) {
    $("hud-dot").style.background = PALETTE[mine].hex;
    $("hud-pct").textContent = pct(p[mine]);
  }
}

// Size the canvas to fit the stage at 3:4.
function layout() {
  if (!game || document.body.dataset.view !== "game") return;
  const stage = $("stage").getBoundingClientRect();
  if (!stage.width || !stage.height) return;
  const w = Math.floor(Math.min(stage.width - 8, (stage.height - 8) * (W / H)));
  const h = Math.floor(w * (H / W));
  game.board.resize(w, h);
  const fx = $("fx");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fx.width = Math.round(w * dpr);
  fx.height = Math.round(h * dpr);
  fx.style.width = w + "px";
  fx.style.height = h + "px";
  game.fxScale = fx.width / W;
}
window.addEventListener("resize", layout);

// ---------- Playing: pick, pump, pop ----------
function canPlay() {
  if (!game || !room || room.status !== "playing" || !isParticipant()) return false;
  const now = backend.serverNow();
  return now >= room.startAt && now < room.endsAt;
}

function worldPoint(e) {
  const r = $("canvas-wrap").getBoundingClientRect();
  return {
    x: Math.min(W, Math.max(0, ((e.clientX - r.left) / r.width) * W)),
    y: Math.min(H, Math.max(0, ((e.clientY - r.top) / r.height) * H)),
  };
}

function placeOrPump(e) {
  if (!canPlay()) return;
  if (!game.balloon) {
    const { x, y } = worldPoint(e);
    game.balloon = { id: Math.random().toString(36).slice(2, 8), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, l: 0 };
    game.lastPump = performance.now();
    squeak(0);
    navigator.vibrate?.(10);
    shareBalloon();
  } else {
    pump();
  }
}

function pump() {
  if (!canPlay() || !game.balloon) return;
  const t = performance.now();
  if (t - game.lastPump < PUMP_COOLDOWN_MS) return;
  game.lastPump = t;
  game.balloon.l++;
  squeak(game.balloon.l);
  navigator.vibrate?.(6);
  if (game.balloon.l >= MAX_LEVEL) popBalloon(); // too big: it bursts by itself (and still counts)
  else shareBalloon();
}

function popBalloon() {
  if (!game?.balloon) return;
  const b = game.balloon;
  game.balloon = null;
  clearTimeout(game.syncTimer);
  game.syncTimer = null;
  const t = Math.floor(backend.serverNow());
  backend.set(roomPath(`players/${backend.uid}/b`), null);
  if (!room || t > room.endsAt || t < room.startAt) return;
  const key = `k${t}${Math.random().toString(36).slice(2, 6)}`;
  backend.set(roomPath(`pops/${backend.uid}/${key}`), {
    x: b.x, y: b.y, l: b.l, s: Math.floor(Math.random() * 2 ** 31), t, r: room.round,
  });
  popSound(b.l, true);
  navigator.vibrate?.(b.l >= MAX_LEVEL ? [40, 30, 80] : 30);
}

/** Share your inflating balloon so others can see it (throttled). */
function shareBalloon() {
  if (!game || game.syncTimer) return;
  const send = () => {
    game.syncTimer = null;
    game.lastSync = performance.now();
    const b = game.balloon;
    if (b) backend.set(roomPath(`players/${backend.uid}/b`), { x: b.x, y: b.y, l: b.l });
  };
  const wait = BALLOON_SYNC_MS - (performance.now() - game.lastSync);
  if (wait <= 0) send();
  else game.syncTimer = setTimeout(send, wait);
}

$("canvas-wrap").addEventListener("pointerdown", (e) => { e.preventDefault(); placeOrPump(e); });
$("pop-btn").addEventListener("pointerdown", (e) => { e.preventDefault(); popBalloon(); });
window.addEventListener("keydown", (e) => {
  if (document.body.dataset.view !== "game") return;
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) pump(); }
  if (e.code === "Enter" || e.key === "p" || e.key === "P") { e.preventDefault(); popBalloon(); }
});

// Draw balloons and effects every frame.
function frame(ts) {
  if (!game) return;
  game.raf = requestAnimationFrame(frame);
  if (document.body.dataset.view !== "game") return;
  const c = $("fx").getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  c.setTransform(game.fxScale || 1, 0, 0, game.fxScale || 1, 0, 0);

  const now = backend.serverNow();
  const live = room?.status === "playing" && now < room.endsAt;
  if (live) {
    for (const [id, p] of Object.entries(room.players || {})) {
      if (id === backend.uid || !p.online || !p.b) continue;
      const colour = room.colors?.[id];
      const x = num(p.b.x, 0, W), y = num(p.b.y, 0, H), l = num(p.b.l, 0, MAX_LEVEL);
      if (colour == null || x == null || y == null || l == null) continue;
      drawBalloon(c, x, y, l, PALETTE[colour].hex, { ghost: true, time: ts, label: p.name });
    }
    const b = game.balloon;
    if (b) drawBalloon(c, b.x, b.y, b.l, PALETTE[room.colors[backend.uid]].hex, { time: ts });
  }
  game.fx.draw(c, performance.now());
}

// ---------- Rendering ----------
function render() {
  if (!code) return show("home");
  if (!room) {
    const c = code;
    code = null;
    unwatch?.();
    endGame();
    show("home");
    homeError(`Room ${c} has closed.`);
    return;
  }
  if (!me()) return; // our join write hasn't landed yet

  maybeTakeOverHost();

  if (room.status === "lobby") {
    if (game) endGame();
    return renderLobby();
  }
  ensureGame();
  syncPaint();
  // Results: when the host says so, or (if the host has vanished) shortly after time's up.
  if (room.status === "results" || backend.serverNow() > room.endsAt + END_GRACE_MS + 2500) return renderResults();
  show("game");
  if (isParticipant()) keepAwake(true);
  renderGameStatus();
}

function renderGameStatus() {
  if (!game || !room) return;
  const now = backend.serverNow();
  const spectator = !isParticipant();

  // countdown
  const cd = $("countdown");
  let label = "";
  if (now < room.startAt) {
    const n = Math.ceil((room.startAt - now) / 1000);
    label = n > 3 ? "" : String(n);
  } else if (now - room.startAt < 600) label = "GO!";
  if (label !== game.lastCount) {
    cd.hidden = !label;
    if (label) {
      cd.textContent = label;
      cd.classList.remove("pop"); void cd.offsetWidth; cd.classList.add("pop");
      if (label !== "GO!") squeak(label === "1" ? 10 : label === "2" ? 5 : 0);
    }
    game.lastCount = label;
  }

  // timer
  const left = Math.max(0, Math.min(TIME_LIMIT_MS, room.endsAt - Math.max(now, room.startAt)));
  $("hud-time").textContent = (left / 1000).toFixed(1);
  $("hud-time").classList.toggle("hurry", left > 0 && left <= 5000);

  // overlay
  const over = $("overlay-msg");
  const ended = now >= room.endsAt;
  if (ended) {
    if (game.balloon) { game.balloon = null; backend.set(roomPath(`players/${backend.uid}/b`), null); }
    over.hidden = false;
    over.className = "overlay-msg";
    over.textContent = "Time's up!";
  } else if (spectator) {
    over.hidden = false;
    over.className = "overlay-msg small";
    over.textContent = "👀 Watching · you'll play next round";
  } else over.hidden = true;

  // controls
  const b = game.balloon;
  const btn = $("pop-btn");
  btn.disabled = !b;
  btn.hidden = spectator;
  $("pop-meter").style.width = b ? (b.l / MAX_LEVEL) * 100 + "%" : "0";
  btn.classList.toggle("danger", !!b && b.l >= MAX_LEVEL - 4);
  let hint;
  if (spectator) hint = "Round in progress";
  else if (ended) hint = "Painting stopped!";
  else if (now < room.startAt) hint = "Get ready…";
  else if (!b) hint = "Tap the canvas to place your balloon";
  else if (b.l < 3) hint = "Tap tap tap to pump it up!";
  else if (b.l >= MAX_LEVEL - 4) hint = "Max size soon: it'll burst by itself!";
  else hint = "Keep pumping, or hit POP!";
  $("hint").textContent = hint;
}

function renderLobby() {
  show("lobby");
  $("room-code").textContent = code;
  renderQr();

  const mine = colourOf(backend.uid);
  $("my-dot").style.background = mine == null ? "#ddd" : PALETTE[mine].hex;
  $("my-colour-name").textContent = mine == null ? "Next round (room full)" : PALETTE[mine].name;

  const players = lobbyOrder();
  $("player-count").textContent = players.length;
  const list = $("player-list");
  list.innerHTML = "";
  players.forEach(([id, p], i) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    if (i < MAX_PLAYERS) dot.style.background = PALETTE[i].hex;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (id === room.hostId ? "👑 " : "") + p.name + (id === backend.uid ? " (you)" : "");
    if (id === backend.uid) name.classList.add("me");
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = i < MAX_PLAYERS ? PALETTE[i].name : "next round";
    li.append(dot, name, tag);
    list.appendChild(li);
  });

  const n = Math.min(players.length, MAX_PLAYERS);
  $("start-btn").hidden = !isHost();
  $("start-btn").disabled = n === 0;
  $("start-btn").textContent = `Start game · ${n} player${n === 1 ? "" : "s"}`;
  $("lobby-wait").textContent = isHost()
    ? (players.length > MAX_PLAYERS ? `Up to ${MAX_PLAYERS} can paint at once; the rest watch.` : "Tap Start once everyone has joined.")
    : "Waiting for the host to start…";
}

function renderQr() {
  if (qrFor === code) return;
  const box = $("qr");
  if (!window.qrcode) {
    box.innerHTML = "";
    window.addEventListener("load", () => { qrFor = null; if (room?.status === "lobby") renderQr(); }, { once: true });
    return;
  }
  const qr = window.qrcode(0, "M");
  qr.addData(inviteUrl(code));
  qr.make();
  box.innerHTML = qr.createImgTag(5, 0, "QR code to join");
  qrFor = code;
}

function standings() {
  const p = game.board.percentages();
  return Object.keys(room.participants || {})
    .filter((id) => room.colors?.[id] != null)
    .map((id) => {
      const savedName = typeof room.participants[id] === "string" ? room.participants[id] : "Someone";
      const color = room.colors[id];
      return { id, name: room.players?.[id]?.name || savedName, color, pct: p[color] };
    })
    .sort((a, b) => b.pct - a.pct || a.color - b.color);
}

function renderResults() {
  if (document.body.dataset.view !== "results") {
    // Avoid accidental taps on the buttons while people are still mid-pump.
    for (const id of ["again-btn", "leave-btn-2"]) {
      $(id).disabled = true;
      setTimeout(() => ($(id).disabled = false), 1500);
    }
    game.balloon = null;
  }
  show("results");
  keepAwake(false);
  const rows = standings();

  // the final canvas
  const fin = $("final");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fin.width = 180 * dpr;
  fin.height = 240 * dpr;
  const fc = fin.getContext("2d");
  const src = game.board.canvas;
  if (src.width) fc.drawImage(src, 0, 0, fin.width, fin.height);

  const total = rows.reduce((s, r) => s + r.pct, 0);
  const top = rows[0];
  $("winner-line").textContent = !top || top.pct === 0
    ? "Nobody popped a single balloon!"
    : `${top.id === backend.uid ? "You" : top.name} claimed the canvas! · ${pct(Math.max(0, 100 - total))} left blank`;

  const podium = $("podium");
  podium.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  for (let i = 0; i < 3; i++) {
    const r = rows[i];
    const step = document.createElement("div");
    step.className = `step p${i + 1}` + (r ? "" : " empty");
    const block = document.createElement("div");
    block.className = "block";
    block.textContent = i + 1;
    if (r) {
      const crown = document.createElement("div");
      crown.className = "crown";
      crown.textContent = medals[i];
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = r.name + (r.id === backend.uid ? " (you)" : "");
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = pct(r.pct);
      step.append(crown, who, t);
      block.style.background = PALETTE[r.color].hex;
    }
    step.appendChild(block);
    podium.appendChild(step);
  }

  const rest = $("rest-list");
  rest.innerHTML = "";
  rows.slice(3).forEach((r, i) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = PALETTE[r.color].hex;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${i + 4}. ${r.name}${r.id === backend.uid ? " (you)" : ""}`;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = pct(r.pct);
    li.append(dot, n, t);
    rest.appendChild(li);
  });

  $("again-btn").hidden = !isHost() || room.status !== "results";
  $("again-wait").hidden = isHost() && room.status === "results";

  if (room.status === "results" && celebratedRound !== room.round) {
    celebratedRound = room.round;
    if (top?.id === backend.uid && top.pct > 0) confetti(PALETTE[top.color].hex);
  }
}

function confetti(hex) {
  const layer = document.createElement("div");
  layer.className = "confetti";
  document.body.appendChild(layer);
  const colours = [hex, "#ffc21a", "#2f6bff", "#ff3b5c", "#14c47a"];
  for (let i = 0; i < 70; i++) {
    const d = document.createElement("div");
    const size = 6 + Math.random() * 10;
    Object.assign(d.style, {
      position: "absolute", left: Math.random() * 100 + "vw", top: "-20px",
      width: size + "px", height: size + "px",
      background: colours[i % colours.length], borderRadius: "50%", border: "2px solid #231942",
    });
    layer.appendChild(d);
    d.animate(
      [
        { transform: "translate(0,0) scale(1)" },
        { transform: `translate(${(Math.random() - 0.5) * 200}px, 110vh) scale(${0.6 + Math.random()})` },
      ],
      { duration: 2200 + Math.random() * 1800, delay: Math.random() * 600, easing: "cubic-bezier(.3,.6,.6,1)", fill: "forwards" }
    );
  }
  setTimeout(() => layer.remove(), 5000);
}

// ---------- Clock tick: countdown, timer, host duties ----------
setInterval(() => {
  if (!room || !code) return;
  const now = backend.serverNow();

  if (room.status === "playing" && game) {
    if (document.body.dataset.view === "game") renderGameStatus();
    if (now > room.endsAt + END_GRACE_MS + 2500 && document.body.dataset.view !== "results") render();
  }

  // Host ends the round shortly after time's up (painting already stopped at endsAt).
  if (isHost() && room.status === "playing" && now > room.endsAt + END_GRACE_MS) {
    backend.update(roomPath(), { status: "results" });
  }

  maybeTakeOverHost();
}, 100);

function maybeTakeOverHost() {
  if (!room || isHost() || !me()?.online) return;
  const host = room.players?.[room.hostId];
  if (host?.online) { hostOfflineSince = 0; return; }
  if (!hostOfflineSince) hostOfflineSince = Date.now();
  if (Date.now() - hostOfflineSince < HOST_GRACE_MS) return;
  const next = lobbyOrder()[0];
  if (next?.[0] === backend.uid) {
    hostOfflineSince = 0;
    backend.set(roomPath("hostId"), backend.uid).catch(() => {});
  }
}

// ---------- Home screen ----------
function readName() {
  const name = $("name-input").value.trim().slice(0, 16);
  if (!name) {
    homeError("Enter your name first.");
    $("name-input").focus();
    return null;
  }
  localStorage.setItem("paint-popper-name", name);
  return name;
}
function homeError(msg) { $("home-error").textContent = msg; }

/** Opened from an invite link: only show name + join. */
function setInviteMode(c) {
  const on = !!c;
  document.body.classList.toggle("invite", on);
  $("invite-head").hidden = !on;
  $("invite-code").textContent = c || "";
  $("invite-join-btn").hidden = !on;
  $("create-btn").hidden = on;
  $("join-divider").hidden = on;
  $("join-row").hidden = on;
  document.querySelector(".tagline").hidden = on;
}
function setBusy(b) { $("create-btn").disabled = b; $("join-btn").disabled = b; $("invite-join-btn").disabled = b; }

$("create-btn").addEventListener("click", () => { homeError(""); createRoom(); });
$("join-btn").addEventListener("click", () => { homeError(""); joinRoom($("code-input").value); });
$("invite-join-btn").addEventListener("click", () => { homeError(""); joinRoom($("invite-code").textContent); });
$("name-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!$("invite-join-btn").hidden) $("invite-join-btn").click();
  else $("create-btn").click();
});
$("code-input").addEventListener("input", (e) => { e.target.value = cleanCode(e.target.value); });
$("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("start-btn").addEventListener("click", () => { unlockAudio(); startGame(); });
$("again-btn").addEventListener("click", playAgain);
$("leave-btn").addEventListener("click", leaveRoom);
$("leave-btn-2").addEventListener("click", leaveRoom);
$("share-btn").addEventListener("click", async () => {
  const url = inviteUrl(code);
  try {
    if (navigator.share) {
      await navigator.share({ title: "Paint Popper", text: `Join my Paint Popper room: ${code}`, url });
    } else {
      await navigator.clipboard.writeText(url);
      $("share-note").textContent = "Link copied!";
      setTimeout(() => ($("share-note").textContent = ""), 2500);
    }
  } catch { /* share cancelled */ }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && game && room?.status === "playing" && isParticipant()) keepAwake(true);
});

// ---------- Boot ----------
async function boot() {
  show("home");
  $("name-input").value = localStorage.getItem("paint-popper-name") || "";
  const roomParam = cleanCode(params.get("room"));
  if (roomParam) { $("code-input").value = roomParam; setInviteMode(roomParam); }

  const configured = firebaseConfig?.apiKey && !firebaseConfig.apiKey.startsWith("YOUR");
  const banner = $("mode-banner");
  setBusy(true);
  try {
    if (configured && !params.has("local")) {
      const { createFirebaseBackend } = await import("./backend-firebase.js");
      backend = await createFirebaseBackend(firebaseConfig);
      backend.onReconnect(() => {
        if (!code) return;
        backend.update(roomPath(`players/${backend.uid}`), { online: true });
        backend.onDisconnectSet(roomPath(`players/${backend.uid}/online`), false);
      });
    } else {
      backend = createLocalBackend();
      banner.hidden = false;
      banner.textContent = configured
        ? "Local demo mode: open more tabs on this device to add players."
        : "Local demo mode: add your Firebase config to play across phones. Open more tabs to add players.";
    }
  } catch (err) {
    console.error(err);
    banner.hidden = false;
    banner.textContent = "Couldn't connect to the game server. Check your connection and reload.";
    return;
  }
  setBusy(false);
}

boot();
