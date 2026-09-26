/**
 * Small math toolbox shared by the whole scene.
 *
 * The world is generated rather than authored, so almost everything starts
 * life as noise: terrain elevation, regolith texture, crater placement, the
 * star field. These helpers are deliberately allocation-free and cheap enough
 * to call thousands of times per frame from the physics and particle code.
 */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

export const saturate = (v) => clamp(v, 0, 1);

/** Hermite smoothstep, the workhorse for every falloff in this project. */
export function smoothstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is roughly "how many e-folds per second" — higher is snappier.
 */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference, in radians. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Move `from` toward `to` by at most `maxStep`, respecting angle wrap. */
export function approachAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

/** Deterministic PRNG (mulberry32) — same seed always rebuilds the same world. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Value noise ──────────────────────────────────────────────
   A cheap integer hash feeds bilinear-interpolated value noise. It is
   lower quality than gradient noise but far cheaper, and at the
   frequencies used here (metres-wide terrain, centimetre regolith)
   the difference is invisible. */

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t) {
  // quintic fade keeps the second derivative continuous, so normals of
  // displaced surfaces do not show grid-shaped creases.
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const wrap = (v, period) => ((v % period) + period) % period;

/** 2D value noise in [0,1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = fade(x - ix);
  const uy = fade(y - iy);

  const n00 = hash2(ix, iy, seed);
  const n10 = hash2(ix + 1, iy, seed);
  const n01 = hash2(ix, iy + 1, seed);
  const n11 = hash2(ix + 1, iy + 1, seed);

  const a = n00 + (n10 - n00) * ux;
  const b = n01 + (n11 - n01) * ux;
  return a + (b - a) * uy;
}

/**
 * Value noise that wraps seamlessly every `period` lattice cells.
 * Tiling regolith needs this — without it a repeated texture shows its
 * own grid across the terrain.
 */
export function tileNoise2(x, y, period, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = fade(x - ix);
  const uy = fade(y - iy);

  const x0 = wrap(ix, period);
  const y0 = wrap(iy, period);
  const x1 = wrap(ix + 1, period);
  const y1 = wrap(iy + 1, period);

  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x1, y0, seed);
  const n01 = hash2(x0, y1, seed);
  const n11 = hash2(x1, y1, seed);

  const a = n00 + (n10 - n00) * ux;
  const b = n01 + (n11 - n01) * ux;
  return a + (b - a) * uy;
}

/** Seamlessly tiling fBm. `baseCells` is the lattice period at octave 0. */
export function tileFbm(x, y, baseCells, { octaves = 4, gain = 0.5, lacunarity = 2, seed = 0 } = {}) {
  let amp = 1;
  let cells = baseCells;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise2(x * cells, y * cells, cells, seed + i * 1013);
    norm += amp;
    amp *= gain;
    cells = Math.round(cells * lacunarity);
  }
  return sum / norm;
}

/** Fractal Brownian motion over value noise, normalised to [0,1]. */
export function fbm(x, y, { octaves = 4, lacunarity = 2.03, gain = 0.5, seed = 0 } = {}) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fBm — sharp creases, used for ejecta rays and rocky detail. */
export function ridged(x, y, opts = {}) {
  const { octaves = 4, lacunarity = 2.07, gain = 0.5, seed = 0 } = opts;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq, seed + i * 7919) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Worley/cellular F1 distance in [0,1] — good for regolith clumping. */
export function worley(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = 8;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 5171);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}
