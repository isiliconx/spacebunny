/**
 * The lunar surface.
 *
 * The playfield is the floor of a large crater: a rolling basin ringed by a
 * 16 m rim, with smaller craters punched into it and the Apollo-style lander
 * parked on a levelled pad at the origin. Beyond the rim a low plain runs out
 * to the horizon with a few distant massifs on the skyline.
 *
 * Elevation is baked once into a grid. Both the render mesh and the physics
 * read from that same grid, so the bunny's feet can never disagree with the
 * pixels underneath them.
 */

import {
  BufferGeometry,
  BufferAttribute,
  Mesh,
  Group,
  Color,
  InstancedMesh,
  PlaneGeometry,
  MeshStandardNodeMaterial,
  Vector3,
  Matrix4,
  Quaternion,
  DynamicDrawUsage,
} from 'three/webgpu';
import { fbm, smoothstep, clamp, lerp, makeRng } from '../util/math.js';

export const TERRAIN_SIZE = 180;      // metres across the playable square
export const TERRAIN_SEGMENTS = 192;  // grid resolution (193² vertices)
const HALF = TERRAIN_SIZE / 2;
const MOON_RADIUS = 1737400;         // metres, for horizon curvature
// The basin wall. Kept low on purpose: at 27 m it subtended ~25 degrees from
// the basin floor and filled the top of the frame, so there was no black sky
// left to hang the Earth and the stars in. At 16 m and set back to r=100 it
// reads as a crater rim on the horizon instead of a wall.
const RIM_INNER = 68;
const RIM_OUTER = 100;
const RIM_HEIGHT = 16;
export const BASIN_LIMIT = 74;       // soft barrier radius for the player

/**
 * Crater profile: a parabolic bowl with a raised rim and a low ejecta
 * blanket, summed in so the rim bump overlaps the bowl edge instead of
 * stepping at it.
 */
function craterContribution(dx, dz, radius, depth) {
  const d = Math.hypot(dx, dz) / radius;
  if (d > 1.6) return 0;
  let h = 0;
  if (d < 1) h -= depth * (1 - d * d);
  const rim = (d - 0.97) * (d - 0.97) / 0.011;
  if (rim < 12) h += depth * 0.34 * Math.exp(-rim);
  const ej = (d - 1.18) * (d - 1.18) / 0.06;
  if (ej < 12) h += depth * 0.10 * Math.exp(-ej);
  return h;
}

/** Distant peaks on the far plain — pure scenery, no collision. */
const MASSIFS = [
  { x: -430, z: -610, h: 78, r: 260 },
  { x: 520, z: -780, h: 104, r: 330 },
  { x: 760, z: 240, h: 62, r: 210 },
  { x: -820, z: 420, h: 88, r: 280 },
  { x: 120, z: 1180, h: 140, r: 420 },
  { x: -240, z: -1320, h: 96, r: 300 },
];

function massifContribution(x, z) {
  let h = 0;
  for (const m of MASSIFS) {
    const d = Math.hypot(x - m.x, z - m.z) / m.r;
    if (d < 1) {
      // Pointy, slightly irregular peaks read better than smooth domes.
      const t = 1 - d;
      h += m.h * Math.pow(t, 1.7) * (0.8 + 0.4 * fbm(x * 0.004, z * 0.004, { octaves: 3, seed: 12 }));
    }
  }
  return h;
}

export class Terrain {
  constructor({ seed = 7, craters = null } = {}) {
    this.seed = seed;
    this.n = TERRAIN_SEGMENTS + 1;
    this.cell = TERRAIN_SIZE / TERRAIN_SEGMENTS;
    this.heights = new Float32Array(this.n * this.n);
    this._craters = craters || Terrain.makeCraters(seed);
    this._padHeight = 0;
    this._bake();
  }

  /** Scatter craters inside the basin, keeping the landing pad clear. */
  static makeCraters(seed) {
    const rng = makeRng(seed * 977 + 13);
    const list = [];
    // Two large ones to break up the skyline inside the basin…
    for (let i = 0; i < 5; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = 20 + rng() * 32;
      const radius = 9 + rng() * 12;
      list.push({
        x: Math.cos(ang) * dist,
        z: Math.sin(ang) * dist,
        radius,
        depth: radius * (0.13 + rng() * 0.05),
      });
    }
    // …plus a scatter of small pockmarks, never on top of the lander.
    for (let i = 0; i < 16; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = 12 + rng() * 46;
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      if (Math.hypot(x, z) < 21) continue;
      const radius = 1.4 + rng() * 3.6;
      list.push({ x, z, radius, depth: radius * 0.17 });
    }
    return list;
  }

  /**
   * Analytic elevation. Sampled directly for the far plain, baked into a grid
   * for the playfield. `padHeight` is the natural ground level at the origin,
   * which the levelled landing pad blends toward.
   */
  _rawHeight(x, z, padHeight) {
    const r = Math.hypot(x, z);

    let h = (fbm(x * 0.0125, z * 0.0125, { octaves: 4, gain: 0.52, seed: this.seed }) - 0.5) * 9;
    h += (fbm(x * 0.055, z * 0.055, { octaves: 3, gain: 0.5, seed: this.seed + 51 }) - 0.5) * 1.4;

    for (const c of this._craters) h += craterContribution(x - c.x, z - c.z, c.radius, c.depth);

    // Crater wall around the basin.
    h += smoothstep(RIM_INNER, RIM_OUTER, r) * RIM_HEIGHT;
    h += massifContribution(x, z);

    // Lunar horizon: the ground curves away, very gently at these distances.
    h -= (r * r) / (2 * MOON_RADIUS);

    // Level pad under the lander: dead flat inside 10 m, natural by 17 m.
    h = lerp(h, padHeight, smoothstep(17, 10, r));
    return h;
  }

  _bake() {
    const { n, cell, heights } = this;
    // The pad height is the raw field at the origin *before* flattening.
    this._padHeight = this._rawHeight(0, 0, 0);
    for (let j = 0; j < n; j++) {
      const z = -HALF + j * cell;
      for (let i = 0; i < n; i++) {
        heights[j * n + i] = this._rawHeight(-HALF + i * cell, z, this._padHeight);
      }
    }
  }

  /** Bilinear elevation sample. Clamps to the edge of the grid. */
  heightAt(x, z) {
    const { n, cell, heights } = this;
    let fx = (x + HALF) / cell;
    let fz = (z + HALF) / cell;
    fx = clamp(fx, 0, n - 1.0001);
    fz = clamp(fz, 0, n - 1.0001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const h00 = heights[j * n + i];
    const h10 = heights[j * n + i + 1];
    const h01 = heights[(j + 1) * n + i];
    const h11 = heights[(j + 1) * n + i + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** Surface normal by central difference on the baked grid. */
  normalAt(x, z, out = new Vector3()) {
    const e = this.cell;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** 0 = flat, 1 = vertical. */
  slopeAt(x, z) {
    return 1 - this.normalAt(x, z, _tmpNormal).y;
  }

  /**
   * Build the render mesh by hand rather than rotating a PlaneGeometry, so
   * the UVs, the winding, and the vertex colours are all explicit and line
   * up with `heightAt` without any guesswork.
   */
  buildMesh(regolith) {
    const { n, cell } = this;
    const count = n * n;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const colors = new Float32Array(count * 3);
    const indices = new Uint32Array(TERRAIN_SEGMENTS * TERRAIN_SEGMENTS * 6);

    const c = new Color();
    let ii = 0;
    for (let j = 0; j < n; j++) {
      const z = -HALF + j * cell;
      for (let i = 0; i < n; i++) {
        const x = -HALF + i * cell;
        const idx = j * n + i;
        const h = this.heights[idx];

        positions[idx * 3] = x;
        positions[idx * 3 + 1] = h;
        positions[idx * 3 + 2] = z;

        uvs[idx * 2] = i / (n - 1);
        uvs[idx * 2 + 1] = j / (n - 1);

        // Analytic-ish normal from neighbouring samples.
        const hl = this.heights[j * n + Math.max(0, i - 1)];
        const hr = this.heights[j * n + Math.min(n - 1, i + 1)];
        const hd = this.heights[Math.max(0, j - 1) * n + i];
        const hu = this.heights[Math.min(n - 1, j + 1) * n + i];
        const dx = (hl - hr) / (2 * cell);
        const dz = (hd - hu) / (2 * cell);
        const inv = 1 / Math.hypot(dx, 1, dz);
        normals[idx * 3] = dx * inv;
        normals[idx * 3 + 1] = inv;
        normals[idx * 3 + 2] = dz * inv;

        // Vertex colour carries the macro variation the tiled texture
        // cannot: fresh ejecta is brighter, settled hollows are darker and
        // a touch blue, steep faces are dusty and pale.
        const slope = 1 - inv;
        const macro = fbm(x * 0.035, z * 0.035, { octaves: 3, gain: 0.55, seed: this.seed + 700 });
        const fresh = smoothstep(1.5, 9, h);          // high ground = fresh material
        const hollow = smoothstep(0, -3.5, h);        // depressions = old, dark fines
        let lum = 0.80 + macro * 0.30;
        lum *= lerp(1.0, 1.10, fresh);
        lum *= lerp(1.0, 0.74, hollow);
        lum *= lerp(1.0, 1.05, smoothstep(0.25, 0.7, slope));
        c.setRGB(
          lum * lerp(0.97, 1.0, fresh),
          lum,
          lum * lerp(1.09, 0.93, fresh),
        );
        colors[idx * 3] = c.r;
        colors[idx * 3 + 1] = c.g;
        colors[idx * 3 + 2] = c.b;

        if (i < n - 1 && j < n - 1) {
          const a = idx;
          const b = idx + 1;
          const d = idx + n;
          const e = idx + n + 1;
          // Wound so the face normal points up.
          indices[ii++] = a; indices[ii++] = d; indices[ii++] = b;
          indices[ii++] = b; indices[ii++] = d; indices[ii++] = e;
        }
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('normal', new BufferAttribute(normals, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mat = new MeshStandardNodeMaterial({
      map: regolith.map,
      normalMap: regolith.normalMap,
      roughnessMap: regolith.roughnessMap,
      normalScale: { x: 1.15, y: 1.15 },
      roughness: 1.0,
      metalness: 0.0,
      vertexColors: true,
      dithering: true,
    });

    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  /**
   * The plain beyond the crater wall, out to the horizon. Sampled from the
   * analytic function rather than the grid, so it can be cheap while still
   * meeting the terrain.
   *
   * The radii are graded, not uniform: 1 m steps out past the corner of the
   * playfield, then geometrically expanding to the horizon. RingGeometry
   * distributes its rings linearly, which put ~27 m between samples — coarse
   * enough that the interpolated surface bulged *above* the finely-tessellated
   * terrain and painted smooth grey slabs across the foreground. The drop of
   * 0.6 m guarantees the real terrain always wins the depth test where the
   * two overlap; the residual step at the playfield edge is 0.4 degrees of
   * arc and sits on the crater wall, so it is not visible from the basin.
   */
  buildFarGround(regolith) {
    const outer = 1500;
    const segs = 128;
    const radii = [];
    for (let r = 0.8; r <= 132; r += 1.0) radii.push(r);
    let r = 132;
    let step = 1.7;
    while (r < outer) {
      r += step;
      step *= 1.19;
      radii.push(Math.min(r, outer));
    }

    const rings = radii.length;
    const count = rings * segs;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const colors = new Float32Array(count * 3);
    const indices = [];
    const c = new Color();
    // World-space UVs at the terrain's own texel density (180 m / 40 repeats =
    // 4.5 m per tile), so the far plain continues the near ground's texture
    // exactly and simply blurs out with distance instead of tiling in rings.
    const UV_SCALE = 1 / 4.5;
    const cosT = new Float32Array(segs);
    const sinT = new Float32Array(segs);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      cosT[s] = Math.cos(a);
      sinT[s] = Math.sin(a);
    }

    for (let i = 0; i < rings; i++) {
      const rad = radii[i];
      for (let s = 0; s < segs; s++) {
        const x = cosT[s] * rad;
        const z = sinT[s] * rad;
        const drop = rad < HALF * 1.5 ? 0.6 : 0;
        const h = this._rawHeight(x, z, this._padHeight) - drop;
        const v = i * segs + s;
        positions[v * 3] = x;
        positions[v * 3 + 1] = h;
        positions[v * 3 + 2] = z;
        uvs[v * 2] = x * UV_SCALE;
        uvs[v * 2 + 1] = z * UV_SCALE;

        // Match the near ground's vertex tinting, or the far plain reads as a
        // brighter haze band along the horizon purely because it has no
        // vertex colours to darken it.
        const macro = fbm(x * 0.035, z * 0.035, { octaves: 3, gain: 0.55, seed: this.seed + 700 });
        const fresh = smoothstep(1.5, 9, h);
        const hollow = smoothstep(0, -3.5, h);
        let lum = 0.74 + macro * 0.26;
        lum *= lerp(1.0, 1.08, fresh);
        lum *= lerp(1.0, 0.78, hollow);
        c.setRGB(lum * lerp(0.97, 1.0, fresh), lum, lum * lerp(1.09, 0.93, fresh));
        colors[v * 3] = c.r;
        colors[v * 3 + 1] = c.g;
        colors[v * 3 + 2] = c.b;
      }
    }

    for (let i = 0; i < rings - 1; i++) {
      for (let s = 0; s < segs; s++) {
        const s2 = (s + 1) % segs;
        const a = i * segs + s;
        const b = i * segs + s2;
        const c2 = (i + 1) * segs + s2;
        const d = (i + 1) * segs + s;
        // Wound so the face normal points up. Angles advance from +X toward
        // +Z, which is clockwise seen from above, so the naive order would
        // have lit the far plain from underneath.
        indices.push(a, b, d, b, c2, d);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Clones, but the tiling now lives in the UVs rather than in repeat.
    const map = regolith.map.clone();
    const normalMap = regolith.normalMap.clone();
    const roughnessMap = regolith.roughnessMap.clone();
    for (const t of [map, normalMap, roughnessMap]) {
      t.repeat.set(1, 1);
      t.needsUpdate = true;
    }

    const mat = new MeshStandardNodeMaterial({
      map,
      normalMap,
      roughnessMap,
      normalScale: { x: 0.6, y: 0.6 },
      roughness: 1.0,
      metalness: 0.0,
      vertexColors: true,
      dithering: true,
    });
    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.name = 'far-ground';
    return mesh;
  }
}

const _tmpNormal = new Vector3();

/* ── footprints ───────────────────────────────────────────── */

/**
 * Persistent boot prints.
 *
 * Moon soil does not slide or heal, so prints stay forever. They are drawn
 * as instanced decals rather than painted into a texture — a texture big
 * enough to resolve a 30 cm paw across 180 m of ground would need to be
 * tens of thousands of pixels square. Instancing gives unlimited crispness
 * in two draw calls, with a ring buffer that recycles the oldest print.
 */
export class FootprintTrail {
  constructor({ max = 420, pawTexture, dustTexture }) {
    this.max = max;
    this.next = 0;

    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);

    // Contrast lives in the texture (dark well, sunlit lip), so the material
    // stays neutral: any tint here would wash the pit back into the ground.
    const printMat = new MeshStandardNodeMaterial({
      map: pawTexture,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      dithering: true,
    });
    this.prints = new InstancedMesh(geo, printMat, max);
    this.prints.instanceMatrix.setUsage(DynamicDrawUsage);
    this.prints.frustumCulled = false;
    this.prints.receiveShadow = false;
    this.prints.castShadow = false;
    this.prints.name = 'footprints';

    const dustMat = new MeshStandardNodeMaterial({
      map: dustTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      dithering: true,
    });
    const dustGeo = new PlaneGeometry(1, 1);
    dustGeo.rotateX(-Math.PI / 2);
    this.dust = new InstancedMesh(dustGeo, dustMat, max);
    this.dust.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dust.frustumCulled = false;
    this.dust.castShadow = false;
    this.dust.renderOrder = 1;
    this.dust.name = 'footprint-dust';

    this.group = new Group();
    this.group.add(this.prints, this.dust);

    // Park every instance out of sight until it is used.
    const hidden = new Matrix4().makeScale(0.0001, 0.0001, 0.0001).setPosition(0, -4000, 0);
    for (let i = 0; i < max; i++) {
      this.prints.setMatrixAt(i, hidden);
      this.dust.setMatrixAt(i, hidden);
    }
    this.prints.instanceMatrix.needsUpdate = true;
    this.dust.instanceMatrix.needsUpdate = true;
  }

  /**
   * Lay a print. `yaw` follows the bunny's heading so the toe pads point the
   * way it was walking; the surface normal keeps it flush on slopes.
   */
  add(terrain, x, z, yaw, { size = 0.3, dust = 0.62 } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;

    const y = terrain.heightAt(x, z) + 0.012;
    const normal = terrain.normalAt(x, z, _tmpNormal);
    const q = new Quaternion().setFromUnitVectors(_up, normal);
    q.multiply(_yawQ.setFromAxisAngle(_up, yaw));

    const m = new Matrix4().compose(
      new Vector3(x, y, z),
      q,
      new Vector3(size * (0.9 + Math.random() * 0.2), 1, size * (1.1 + Math.random() * 0.2)),
    );
    this.prints.setMatrixAt(i, m);

    const d = new Matrix4().compose(
      new Vector3(x, y - 0.004, z),
      q,
      new Vector3(dust, 1, dust),
    );
    this.dust.setMatrixAt(i, d);

    this.prints.instanceMatrix.needsUpdate = true;
    this.dust.instanceMatrix.needsUpdate = true;
  }

  clear() {
    const hidden = new Matrix4().makeScale(0.0001, 0.0001, 0.0001).setPosition(0, -4000, 0);
    for (let i = 0; i < this.max; i++) {
      this.prints.setMatrixAt(i, hidden);
      this.dust.setMatrixAt(i, hidden);
    }
    this.prints.instanceMatrix.needsUpdate = true;
    this.dust.instanceMatrix.needsUpdate = true;
    this.next = 0;
  }
}

const _up = new Vector3(0, 1, 0);
const _yawQ = new Quaternion();
