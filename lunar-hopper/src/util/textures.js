/**
 * Procedural texture factory.
 *
 * Nothing in this project loads an image file. Every surface — regolith, fur,
 * the star field, Earth, the flag, the bunny's paw print — is rasterised into a
 * canvas at boot and uploaded as a texture. That keeps the whole scene a
 * single self-contained folder and lets the world regenerate from a seed.
 *
 * Convention: colour maps get SRGBColorSpace; normal/roughness/mask maps stay
 * linear (NoColorSpace), which is what three expects.
 */

import {
  CanvasTexture,
  SRGBColorSpace,
  RepeatWrapping,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
} from 'three/webgpu';
import { lerp, saturate, smoothstep, makeRng, tileFbm, worley, fbm } from './math.js';

/* ── plumbing ──────────────────────────────────────────────── */

function canvas(size, h = size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h;
  return c;
}

function finish(cv, { srgb = false, repeat = 1, aniso = 8, wrap = RepeatWrapping } = {}) {
  const tex = new CanvasTexture(cv);
  if (srgb) tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = wrap;
  if (repeat !== 1) tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Convert a height field into a tangent-space normal map.
 * Sobel gradients, wrapped at the edges so the result still tiles.
 */
function heightToNormal(height, size, strength = 2.0) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel: more stable than forward differences, which quantise badly.
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      const nzn = nz * inv;

      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nzn * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function grayCanvas(values, size) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = saturate(values[i]) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/* ── regolith ──────────────────────────────────────────────── */

/**
 * Lunar soil. Three maps from one shared height field so they agree:
 * a gritty normal map, a mottled albedo, and a roughness map that keeps
 * fresh slopes shinier than settled dust.
 */
export function makeRegolith({ size = 512, seed = 7, aniso = 8 } = {}) {
  const height = new Float32Array(size * size);
  const albedoCv = canvas(size);
  const actx = albedoCv.getContext('2d');
  const img = actx.createImageData(size, size);
  const px = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = y * size + x;

      // Broad dune-like undulation + fine grit + scattered clods.
      const broad = tileFbm(u, v, 3, { octaves: 4, gain: 0.55, seed });
      const grit = tileFbm(u, v, 22, { octaves: 3, gain: 0.5, seed: seed + 91 });
      const clods = 1 - worley(u * 26, v * 26, seed + 17);
      const h = broad * 0.55 + grit * 0.3 + clods * 0.15;
      height[i] = h;

      // Albedo: regolith is a desaturated warm grey; darker where the
      // surface dips (shadowed fines), lighter on the high grains.
      const shade = lerp(0.30, 0.60, saturate(h * 1.15 - 0.08));
      const mottle = tileFbm(u, v, 7, { octaves: 3, gain: 0.6, seed: seed + 313 });
      let l = shade * lerp(0.88, 1.1, mottle);
      // faint blue-grey in the hollows, warm on the crests
      const warm = saturate((h - 0.5) * 2);
      const r = l * lerp(0.97, 1.06, warm);
      const g = l * lerp(0.99, 1.0, warm);
      const b = l * lerp(1.07, 0.92, warm);

      px[i * 4] = r * 255;
      px[i * 4 + 1] = g * 255;
      px[i * 4 + 2] = b * 255;
      px[i * 4 + 3] = 255;
    }
  }
  actx.putImageData(img, 0, 0);

  // Micrometeorite glass beads: tiny bright specular flecks. Real regolith
  // is full of them and they catch the sun beautifully.
  const rng = makeRng(seed * 31 + 5);
  actx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < size * 1.6; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = rng() * 1.3 + 0.28;
    const a = 0.1 + rng() * 0.5;
    actx.fillStyle = `rgba(215,225,240,${a})`;
    actx.beginPath();
    actx.arc(x, y, r, 0, Math.PI * 2);
    actx.fill();
  }
  actx.globalCompositeOperation = 'source-over';

  const rough = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) rough[i] = lerp(0.99, 0.80, saturate(height[i] * 1.4 - 0.2));

  return {
    map: finish(albedoCv, { srgb: true, aniso }),
    normalMap: finish(heightToNormal(height, size, 2.6), { aniso }),
    roughnessMap: finish(grayCanvas(rough, size), { aniso }),
  };
}

/* ── bunny fur ─────────────────────────────────────────────── */

/**
 * Fine directional strands. Sampled with a small normalScale on the fur
 * material, it gives the flat-shaded body a soft velvety break-up that
 * reads as fur at any distance the camera actually gets to.
 */
export function makeFurNormal({ size = 256, seed = 3 } = {}) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Stretched vertically: strands run down the body.
      const strands = tileFbm(u * 30, v * 3.2, 30, { octaves: 3, gain: 0.55, seed });
      const clumps = tileFbm(u, v, 8, { octaves: 3, gain: 0.5, seed: seed + 77 });
      height[y * size + x] = strands * 0.72 + clumps * 0.28;
    }
  }
  // Tile several times across each body part. Left at 1:1, the strand pattern
  // stretches over a whole 0.3 m sphere and the bunny reads as a golf ball.
  const tex = finish(heightToNormal(height, size, 1.5), { aniso: 4 });
  tex.repeat.set(4, 4);
  return tex;
}

/** Subtle mottling so the fur is not a flat colour under hard sunlight. */
export function makeFurTint({ size = 128, seed = 21 } = {}) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = tileFbm(x / size, y / size, 5, { octaves: 3, gain: 0.55, seed });
      const l = lerp(0.82, 1.06, n);
      const i = (y * size + x) * 4;
      img.data[i] = l * 255;
      img.data[i + 1] = l * 252;
      img.data[i + 2] = l * 248;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(cv, { srgb: true, aniso: 4 });
}

/* ── sky ───────────────────────────────────────────────────── */

export function makeStarTexture({ w = 2048, h = 1024, seed = 1234 } = {}) {
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  const rng = makeRng(seed);

  // A faint galactic band: broad dust glow plus dense unresolved stars.
  // Kept deliberately dim. 260 overlapping radial gradients at alpha ~0.17
  // accumulate to roughly 60% white under 'lighter' compositing, which turns
  // the whole upper sky into flat grey haze instead of a starfield.
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 170; i++) {
    // A great circle tilted off the horizon.
    const t = rng();
    const lon = t * Math.PI * 2;
    const bandY = h * 0.5 + Math.sin(lon * 1.0) * h * 0.17;
    const x = ((lon / (Math.PI * 2)) * w + w) % w;
    const y = bandY + (rng() - 0.5) * h * 0.14;
    const r = 30 + rng() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tint = 0.016 + rng() * 0.028;
    g.addColorStop(0, `rgba(${Math.round(150 + rng() * 60)},${Math.round(160 + rng() * 50)},210,${tint})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 5200; i++) {
    // Denser inside the band, sparse elsewhere.
    const inBand = rng() < 0.55;
    const lon = rng() * Math.PI * 2;
    let y;
    if (inBand) {
      y = h * 0.5 + Math.sin(lon) * h * 0.17 + (rng() + rng() - 1) * h * 0.1;
    } else {
      y = rng() * h;
    }
    const x = rng() * w;
    // Thin out near the poles where equirectangular projection stretches.
    const poleFade = saturate(1 - Math.abs(y / h - 0.5) * 2.2);
    const b = (0.12 + rng() * 0.88) * (0.35 + 0.65 * poleFade);
    const r = rng() * rng() * 1.7 + 0.32;
    const warm = rng();
    const col = warm < 0.7 ? [225, 235, 255] : warm < 0.9 ? [255, 238, 210] : [255, 210, 180];
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${b})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A handful of hero stars with a soft halo — these sell the scale.
  for (let i = 0; i < 26; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 5 + rng() * 9;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.25, 'rgba(200,225,255,0.35)');
    g.addColorStop(1, 'rgba(120,170,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = 'source-over';

  return finish(cv, { srgb: true, wrap: RepeatWrapping, aniso: 4 });
}

/**
 * Earth, seen from 384,000 km: banded climate colours on an fBm continent
 * mask, ice at the poles, and a separate cloud layer with matching alpha.
 */
export function makeEarthTextures({ w = 1024, h = 512, seed = 99 } = {}) {
  const surface = canvas(w, h);
  const sctx = surface.getContext('2d');
  const simg = sctx.createImageData(w, h);
  const clouds = canvas(w, h);
  const cctx = clouds.getContext('2d');
  const cimg = cctx.createImageData(w, h);

  for (let y = 0; y < h; y++) {
    const lat = (y / h) * 2 - 1; // -1 south pole .. 1 north pole
    const absLat = Math.abs(lat);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const i = (y * w + x) * 4;

      // Equirectangular: the cosine term keeps continents from piling up
      // at the poles.
      const cx = u * Math.PI * 2;
      const nx = Math.cos(cx) * 1.6 + 4;
      const ny = lat * 1.9 + 4;

      const cont = fbm(nx, ny, { octaves: 5, gain: 0.55, seed });
      const land = cont + 0.5 * Math.exp(-absLat * 3) - 0.42; // more land at the equator
      const isLand = saturate((land - 0.02) * 14);
      const coast = saturate(1 - Math.abs(land) * 22);

      // Ocean: deep blue, shallower and greener near the shelves.
      const deep = [8, 26, 62], shallow = [22, 78, 120];
      const shelf = saturate(1 - land * 9);
      let r = lerp(deep[0], shallow[0], shelf);
      let g = lerp(deep[1], shallow[1], shelf);
      let b = lerp(deep[2], shallow[2], shelf);

      // Land: ice caps, tundra, forest, and desert belts near ±25°.
      const desert = Math.exp(-Math.pow((absLat - 0.27) * 5.2, 2));
      const ice = smoothstep(0.78, 0.93, absLat);
      const veg = fbm(nx * 2.3 + 11, ny * 2.3, { octaves: 4, gain: 0.5, seed: seed + 40 });
      let lr = lerp(74, 150, veg);
      let lg = lerp(96, 122, veg);
      let lb = lerp(58, 74, veg);
      lr = lerp(lr, 186, desert); lg = lerp(lg, 158, desert); lb = lerp(lb, 104, desert);
      lr = lerp(lr, 236, ice); lg = lerp(lg, 244, ice); lb = lerp(lb, 252, ice);

      r = lerp(r, lr, isLand);
      g = lerp(g, lg, isLand);
      b = lerp(b, lb, isLand);
      // Surf line
      r = lerp(r, 190, coast * 0.35);
      g = lerp(g, 220, coast * 0.35);
      b = lerp(b, 235, coast * 0.35);

      simg.data[i] = r; simg.data[i + 1] = g; simg.data[i + 2] = b; simg.data[i + 3] = 255;

      // Clouds: stretched fBm, banded by latitude (ITCZ + mid-lat storms).
      const cl = fbm(nx * 1.7 + 3, ny * 2.6 + 7, { octaves: 5, gain: 0.55, seed: seed + 202 });
      const band = 0.55 + 0.45 * Math.sin(absLat * 9.0);
      const a = saturate((cl * 0.75 + band * 0.35 - 0.52) * 3.4);
      cimg.data[i] = 255; cimg.data[i + 1] = 255; cimg.data[i + 2] = 255;
      cimg.data[i + 3] = a * 235;
    }
  }
  sctx.putImageData(simg, 0, 0);
  cctx.putImageData(cimg, 0, 0);

  return {
    map: finish(surface, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 4 }),
    cloudMap: finish(clouds, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 4 }),
  };
}

/* ── sprites & decals ──────────────────────────────────────── */

/** Soft radial glow. Used additively for the sun, crystal halos, flares. */
export function makeGlowSprite({ size = 256, inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.28)', power = 2.4 } = {}) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5) / c;
      const a = Math.pow(saturate(1 - d), power);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Tint by compositing the two stops through the alpha mask.
  ctx.globalCompositeOperation = 'source-in';
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return finish(cv, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 2 });
}

/**
 * A bunny paw print: a heart-ish main pad plus three toe pads.
 *
 * Baked as a pit, not a smudge. Real prints read because the compressed
 * bottom sits in its own shadow while the displaced rim catches the low sun,
 * so the texture is built dark-in-the-middle with a bright lip. Anything that
 * merely matches the grey of the surrounding regolith is invisible at any
 * useful camera distance.
 */
export function makePawPrint({ size = 128 } = {}) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const s = size / 128;

  // Contact shadow first, offset away from the low sun, so the print keeps a
  // dark readable edge at play distance. The sun sits low, so its shadow is
  // long: offset the well's shade down-right and let it spill past the pads.
  const cs = ctx.createRadialGradient(70 * s, 92 * s, 0, 70 * s, 92 * s, 58 * s);
  cs.addColorStop(0.00, 'rgba(24,22,20,0.62)');
  cs.addColorStop(0.55, 'rgba(28,26,24,0.38)');
  cs.addColorStop(1.00, 'rgba(30,28,26,0)');
  ctx.fillStyle = cs;
  ctx.fillRect(0, 0, size, size);

  // One pad: dark well in the middle, sunlit lip around the upper-left edge
  // (the sun sits low, so the near lip is the lit one).
  const pad = (x, y, rx, ry, rot, shade) => {
    ctx.save();
    ctx.translate(x * s, y * s);
    ctx.rotate(rot);

    const r = Math.max(rx, ry) * s;
    const g = ctx.createRadialGradient(-r * 0.25, -r * 0.3, 0, 0, 0, r);
    g.addColorStop(0.00, `rgba(44,41,38,${shade})`);
    g.addColorStop(0.58, `rgba(64,60,56,${shade})`);
    g.addColorStop(0.82, `rgba(104,99,93,${shade})`);
    g.addColorStop(0.94, `rgba(150,145,137,${shade * 0.85})`);
    g.addColorStop(1.00, 'rgba(150,146,138,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * s, ry * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // main pad
  pad(64, 84, 31, 26, 0, 1.0);
  // toe pads
  pad(40, 44, 14, 17, -0.35, 0.98);
  pad(64, 33, 14, 18, 0, 1.0);
  pad(88, 44, 14, 17, 0.35, 0.98);

  // Fine grit inside the well so it does not read as clean vector art.
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (img.data[i + 3] < 8) continue;
      const n = tileFbm(x / size * 9, y / size * 9, 6, { octaves: 3, seed: 11 });
      const k = 1 + (n - 0.5) * 0.5;
      img.data[i] *= k;
      img.data[i + 1] *= k;
      img.data[i + 2] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);

  return finish(cv, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 4 });
}

/** Faint dust halo left around a fresh print. */
export function makeDustHalo({ size = 128 } = {}) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.hypot(dx, dy);
      // Ring-shaped: bright just outside the print, fading both ways.
      const ring = Math.exp(-Math.pow((d - 0.52) * 4.2, 2));
      const n = tileFbm(x / size * 6, y / size * 6, 6, { octaves: 3, seed: 5 });
      const a = ring * saturate(n * 1.5) * 0.5;
      const i = (y * size + x) * 4;
      img.data[i] = 176; img.data[i + 1] = 170; img.data[i + 2] = 162;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(cv, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 2 });
}

/** Bright annulus used as the bounce-pad emissive map. */
export function makeRingGlow({ size = 256 } = {}) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5) / c;
      const ring = Math.exp(-Math.pow((d - 0.72) * 7.0, 2));
      const core = Math.exp(-Math.pow(d * 2.1, 2)) * 0.35;
      // Chevron ticks around the rim.
      const ang = Math.atan2(y - c, x - c);
      const ticks = 0.5 + 0.5 * Math.cos(ang * 16);
      const a = saturate(ring * (0.65 + 0.35 * ticks) + core) * (1 - smoothstep(0.86, 1.0, d));
      const i = (y * size + x) * 4;
      img.data[i] = 150; img.data[i + 1] = 245; img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(cv, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 4 });
}

/** The mission flag: red field, white stripes, blue canton, stars. */
export function makeFlagTexture({ w = 256, h = 160 } = {}) {
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#b8262f';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#f2f2f2';
  for (let i = 0; i < 7; i++) {
    if (i % 2 === 0) continue;
    ctx.fillRect(0, (i * h) / 7, w, h / 7);
  }
  ctx.fillStyle = '#1c3f7c';
  ctx.fillRect(0, 0, w * 0.42, (h * 7) / 13);
  ctx.fillStyle = '#ffffff';
  const rng = makeRng(4);
  for (let r = 0; r < 6; r++) {
    for (let c2 = 0; c2 < 9; c2++) {
      if (rng() < 0.22) continue;
      const x = 5 + (c2 * (w * 0.42 - 10)) / 9;
      const y = 5 + (r * ((h * 7) / 13 - 10)) / 6;
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // weathering
  ctx.globalCompositeOperation = 'multiply';
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.6, 'rgba(210,200,190,1)');
  g.addColorStop(1, 'rgba(150,140,130,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return finish(cv, { srgb: true, wrap: ClampToEdgeWrapping, aniso: 4 });
}

/** Brushed, slightly scuffed metal for the lander — used as a roughness map. */
export function makeScuffRoughness({ size = 256, seed = 61 } = {}) {
  const values = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Anisotropic streaks: stretch the noise along U.
      const streak = tileFbm(u * 2, v * 40, 40, { octaves: 3, gain: 0.5, seed });
      const blotch = tileFbm(u, v, 6, { octaves: 3, gain: 0.6, seed: seed + 9 });
      values[y * size + x] = lerp(0.18, 0.62, streak * 0.6 + blotch * 0.4);
    }
  }
  return finish(grayCanvas(values, size), { aniso: 4 });
}

/** Crinkled gold foil normal map for the lander's thermal blankets. */
export function makeFoilNormal({ size = 256, seed = 88 } = {}) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const crease = 1 - worley(u * 9, v * 9, seed);
      const wrinkle = tileFbm(u, v, 14, { octaves: 3, gain: 0.5, seed: seed + 4 });
      height[y * size + x] = crease * 0.6 + wrinkle * 0.4;
    }
  }
  return finish(heightToNormal(height, size, 3.2), { aniso: 4 });
}

export { heightToNormal, grayCanvas, finish as finishTexture, canvas as makeCanvas };
