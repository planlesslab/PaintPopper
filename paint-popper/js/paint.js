// Paint engine: splat shapes, the shared canvas, coverage scoring, balloons and effects.
//
// Every splat is built from a list of circles generated from a seed, so every phone
// draws exactly the same shape. The score uses the very same circles on a grid, so
// "what you see" is "what you score".

export const W = 300;              // world size of the shared canvas (3:4, portrait)
export const H = 400;
export const MAX_LEVEL = 20;       // pumps until the balloon bursts by itself
const CELL = 2;                    // scoring grid resolution (world units per cell)
const GW = W / CELL, GH = H / CELL;

// 12 bright, easy-to-tell-apart paint colours.
export const PALETTE = [
  { name: "Cherry",    hex: "#ff3b5c" },
  { name: "Blueberry", hex: "#2f6bff" },
  { name: "Sunshine",  hex: "#ffc21a" },
  { name: "Mint",      hex: "#14c47a" },
  { name: "Grape",     hex: "#9b4dff" },
  { name: "Tangerine", hex: "#ff7a1a" },
  { name: "Bubblegum", hex: "#ff4fd8" },
  { name: "Lagoon",    hex: "#12bfe0" },
  { name: "Lime",      hex: "#97d81f" },
  { name: "Cocoa",     hex: "#8b5a2b" },
  { name: "Midnight",  hex: "#1e2a78" },
  { name: "Teal",      hex: "#0f9488" },
];

/** Splat radius for a balloon pumped `level` times. Area grows with the square. */
export const splatRadius = (level) => 12 + 2.4 * Math.min(level, MAX_LEVEL);
/** Balloon body radius drawn while pumping (world units). */
export const balloonRadius = (level) => 7 + 1.15 * Math.min(level, MAX_LEVEL);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The circles [x, y, r] that make up one splat. Deterministic from the seed. */
export function splatCircles(x, y, level, seed) {
  const R = splatRadius(level);
  const rand = rng(seed);
  const out = [[x, y, R * 0.82]];
  // Wobbly body
  const lobes = 7 + Math.floor(rand() * 5);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rand() * 0.6;
    const d = R * (0.5 + rand() * 0.32);
    out.push([x + Math.cos(a) * d, y + Math.sin(a) * d, R * (0.32 + rand() * 0.22)]);
  }
  // Streaks shooting outwards
  const rays = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < rays; i++) {
    const a = rand() * Math.PI * 2;
    const steps = 3 + Math.floor(rand() * 3);
    for (let k = 1; k <= steps; k++) {
      const d = R * (0.8 + 0.2 * k);
      const r = R * Math.max(0.05, 0.24 - 0.045 * k);
      out.push([x + Math.cos(a) * d, y + Math.sin(a) * d, r]);
    }
  }
  // Loose droplets
  const drops = 6 + Math.floor(rand() * 8);
  for (let i = 0; i < drops; i++) {
    const a = rand() * Math.PI * 2;
    const d = R * (1.15 + rand() * 0.8);
    out.push([x + Math.cos(a) * d, y + Math.sin(a) * d, R * (0.04 + rand() * 0.08)]);
  }
  return out;
}

/** Order of splats on the canvas: newer covers older. Ties broken by key so everyone agrees. */
export const splatOrder = (a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The shared canvas. Keeps the scoring grid and a drawn picture in sync.
 * add() for splats in order; rebuild() when one arrives late and needs slotting in.
 */
export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.owner = new Int8Array(GW * GH).fill(-1);
    this.counts = new Array(PALETTE.length).fill(0);
    this.splats = [];   // applied, in order
    this.keys = new Set();
    this.scale = 1;
  }

  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = this.canvas.width / W;
    this.redraw();
  }

  clearPicture() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#fffdf8";
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  redraw() {
    this.clearPicture();
    for (const s of this.splats) this.drawSplat(s);
  }

  drawSplat(s) {
    const c = this.ctx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.fillStyle = PALETTE[s.color].hex;
    c.beginPath();
    for (const [x, y, r] of s.circles) {
      c.moveTo(x + r, y);
      c.arc(x, y, r, 0, Math.PI * 2);
    }
    c.fill();
  }

  paintGrid(s) {
    const { owner, counts } = this;
    for (const [x, y, r] of s.circles) {
      const r2 = r * r;
      const i0 = Math.max(0, Math.floor((x - r) / CELL)), i1 = Math.min(GW - 1, Math.floor((x + r) / CELL));
      const j0 = Math.max(0, Math.floor((y - r) / CELL)), j1 = Math.min(GH - 1, Math.floor((y + r) / CELL));
      for (let j = j0; j <= j1; j++) {
        const dy = (j + 0.5) * CELL - y;
        const row = j * GW;
        for (let i = i0; i <= i1; i++) {
          const dx = (i + 0.5) * CELL - x;
          if (dx * dx + dy * dy > r2) continue;
          const prev = owner[row + i];
          if (prev === s.color) continue;
          if (prev >= 0) counts[prev]--;
          owner[row + i] = s.color;
          counts[s.color]++;
        }
      }
    }
  }

  /**
   * Bring the board up to date with the full list of splats.
   * Returns the splats that were newly added (for effects).
   */
  sync(all) {
    const fresh = all.filter((s) => !this.keys.has(s.key));
    if (!fresh.length) return fresh;
    fresh.sort(splatOrder);
    for (const s of fresh) s.circles ||= splatCircles(s.x, s.y, s.l, s.s);
    const last = this.splats[this.splats.length - 1];
    if (last && splatOrder(fresh[0], last) < 0) {
      // Something arrived late: replay everything in the right order.
      this.splats = this.splats.concat(fresh).sort(splatOrder);
      this.owner.fill(-1);
      this.counts.fill(0);
      for (const s of this.splats) this.paintGrid(s);
      this.redraw();
    } else {
      for (const s of fresh) { this.splats.push(s); this.paintGrid(s); this.drawSplat(s); }
    }
    for (const s of fresh) this.keys.add(s.key);
    return fresh;
  }

  /** Share of the whole canvas each colour covers, 0–100. */
  percentages() {
    const total = GW * GH;
    return this.counts.map((n) => (n / total) * 100);
  }
}

/** Draw one balloon (world coords) on a 2D context already scaled to world units. */
export function drawBalloon(c, x, y, level, hex, { ghost = false, time = 0, label = "" } = {}) {
  const r = balloonRadius(level);
  const danger = level >= MAX_LEVEL - 4;
  const shake = danger ? Math.sin(time * 0.06) * (level - (MAX_LEVEL - 5)) * 0.5 : 0;
  const bob = Math.sin(time * 0.004 + x) * 1.2;
  const cx = x + shake, cy = y - r * 0.15 + bob;
  c.save();
  c.globalAlpha = ghost ? 0.6 : 1;

  // string
  c.strokeStyle = "rgba(40,30,60,.45)";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(cx, cy + r * 1.12);
  c.quadraticCurveTo(cx - 4, cy + r * 1.12 + 8, cx + 1, cy + r * 1.12 + 16);
  c.stroke();

  // body
  c.fillStyle = hex;
  c.beginPath();
  c.ellipse(cx, cy, r * 0.92, r * 1.05, 0, 0, Math.PI * 2);
  c.fill();
  // knot
  c.beginPath();
  c.moveTo(cx - 3, cy + r * 1.12);
  c.lineTo(cx + 3, cy + r * 1.12);
  c.lineTo(cx, cy + r * 1.0);
  c.closePath();
  c.fill();
  // outline + shine
  c.lineWidth = 1.5;
  c.strokeStyle = "rgba(30,20,50,.35)";
  c.beginPath();
  c.ellipse(cx, cy, r * 0.92, r * 1.05, 0, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = "rgba(255,255,255,.55)";
  c.beginPath();
  c.ellipse(cx - r * 0.35, cy - r * 0.45, r * 0.18, r * 0.28, -0.5, 0, Math.PI * 2);
  c.fill();

  if (label) {
    c.globalAlpha = 0.9;
    c.font = "700 9px Figtree, system-ui, sans-serif";
    c.textAlign = "center";
    c.lineWidth = 3;
    c.strokeStyle = "rgba(255,255,255,.9)";
    c.strokeText(label, cx, cy - r * 1.05 - 4);
    c.fillStyle = "#231942";
    c.fillText(label, cx, cy - r * 1.05 - 4);
  }
  c.restore();
}

/** Short-lived burst effects drawn over the canvas. */
export class Effects {
  constructor() { this.items = []; }

  burst(x, y, level, hex) {
    const R = splatRadius(level);
    const now = performance.now();
    this.items.push({ kind: "ring", x, y, R, hex, born: now, life: 380 });
    const n = 10 + Math.floor(level / 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = R * (1.4 + Math.random() * 1.6);
      this.items.push({
        kind: "drop", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        r: 1.5 + Math.random() * (2 + level * 0.15), hex, born: now, life: 320 + Math.random() * 200,
      });
    }
  }

  draw(c, now) {
    this.items = this.items.filter((it) => now - it.born < it.life);
    for (const it of this.items) {
      const k = (now - it.born) / it.life;
      c.save();
      if (it.kind === "ring") {
        c.globalAlpha = 1 - k;
        c.strokeStyle = it.hex;
        c.lineWidth = 3 * (1 - k) + 0.5;
        c.beginPath();
        c.arc(it.x, it.y, it.R * (0.4 + k * 1.1), 0, Math.PI * 2);
        c.stroke();
      } else {
        const e = 1 - (1 - k) * (1 - k); // ease out
        c.globalAlpha = 1 - k * 0.8;
        c.fillStyle = it.hex;
        c.beginPath();
        c.arc(it.x + it.vx * e, it.y + it.vy * e, it.r * (1 - k * 0.5), 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
  }
}
