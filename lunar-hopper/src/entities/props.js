/**
 * Everything in the world the bunny can touch: the crystals to collect, the
 * bounce pads, the loose rocks you can punt across the basin, the lander and
 * the flag, plus the two particle systems (impact grit and collect sparks).
 *
 * Particle notes: lunar regolith does not billow. Apollo footage shows ejecta
 * flying in straight ballistic arcs, so the dust here is opaque little grains
 * under lunar gravity rather than a soft smoke cloud. The collect sparks use
 * additive blending with per-instance colour, which lets a particle fade to
 * black — and additive black is invisible, so that fades for free.
 */

import {
  Group,
  Mesh,
  InstancedMesh,
  IcosahedronGeometry,
  OctahedronGeometry,
  TorusGeometry,
  CylinderGeometry,
  SphereGeometry,
  PlaneGeometry,
  BoxGeometry,
  ConeGeometry,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  DynamicDrawUsage,
  Vector3,
  Quaternion,
  Matrix4,
  Euler,
  Color,
  AdditiveBlending,
  DoubleSide,
  Sprite,
  SpriteNodeMaterial,
} from 'three/webgpu';
import { clamp, lerp, saturate, makeRng, smoothstep } from '../util/math.js';

const _v = new Vector3();
const _q = new Quaternion();
const _e = new Euler();
const _m = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _scratchColor = new Color();

function mesh(geo, mat, parent, { pos, rot, scale, name, shadow = true } = {}) {
  const m = new Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  if (name) m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  parent.add(m);
  return m;
}

/** A cylinder stretched between two points — struts, braces, antennae. */
function strut(parent, mat, from, to, radiusTop, radiusBottom = radiusTop) {
  const dir = to.clone().sub(from);
  const len = dir.length();
  const m = mesh(new CylinderGeometry(radiusTop, radiusBottom, len, 10), mat, parent);
  m.position.copy(from).add(to).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, dir.normalize());
  return m;
}

/* ── collectible crystals ──────────────────────────────────── */

const CRYSTAL_TOTAL = 14;

export class CrystalField {
  constructor(terrain, { glowTexture, seed = 5150, total = CRYSTAL_TOTAL } = {}) {
    this.terrain = terrain;
    this.total = total;
    this.collected = 0;
    this.group = new Group();
    this.group.name = 'crystals';

    const body = new MeshStandardNodeMaterial({
      color: 0x1d5f70,
      emissive: new Color(0x53e6ff),
      emissiveIntensity: 2.4,
      roughness: 0.12,
      metalness: 0.15,
    });
    const ringMat = new MeshStandardNodeMaterial({
      color: 0x0d3a46,
      emissive: new Color(0x2fb9d8),
      emissiveIntensity: 1.5,
      roughness: 0.3,
      metalness: 0.6,
    });
    this.bodyMat = body;
    this.ringMat = ringMat;

    const haloMat = new MeshBasicNodeMaterial({
      map: glowTexture,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      // Over-bright on purpose (HDR values above 1 so it survives tone
      // mapping), but not so far above that a nearby crystal smears a
      // halo across a third of the frame.
      color: new Color(0.5, 1.15, 1.4),
    });
    this.haloMat = haloMat;

    this.items = [];
    const rng = makeRng(seed);
    const placed = [];
    let guard = 0;
    while (this.items.length < total && guard++ < 4000) {
      const ang = rng() * Math.PI * 2;
      const dist = 12 + Math.sqrt(rng()) * 44;
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      // Keep them reachable and readable: off the pad, off the steep walls,
      // and not stacked on top of each other.
      if (dist < 14) continue;
      if (terrain.slopeAt(x, z) > 0.22) continue;
      let ok = true;
      for (const p of placed) {
        if (Math.hypot(p.x - x, p.z - z) < 7) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push({ x, z });

      const g = new Group();
      const y = terrain.heightAt(x, z);
      g.position.set(x, y, z);
      this.group.add(g);

      const crystal = mesh(new OctahedronGeometry(0.19, 0), body, g,
        { scale: [0.8, 1.7, 0.8], name: 'crystal' });
      const ring = mesh(new TorusGeometry(0.3, 0.012, 8, 32), ringMat, g,
        { rot: [Math.PI / 2, 0, 0], shadow: false });
      // A Sprite rather than a plane: three billboards it for free, so the
      // halo always faces the camera without any per-frame quaternion work.
      const halo = new Sprite(haloMat);
      halo.scale.set(1.05, 1.05, 1);
      halo.position.set(0, 0, -0.05);
      halo.renderOrder = 2;
      g.add(halo);

      this.items.push({
        group: g, crystal, ring, halo,
        x, z, baseY: y,
        phase: rng() * Math.PI * 2,
        spin: 0.6 + rng() * 0.7,
        taken: false,
        pull: 0,
      });
    }
  }

  get remaining() { return this.total - this.collected; }

  /** Nearest un-taken crystal, for the HUD compass. */
  nearest(pos) {
    let best = null;
    let bestD = Infinity;
    for (const it of this.items) {
      if (it.taken) continue;
      const d = Math.hypot(it.group.position.x - pos.x, it.group.position.z - pos.z);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best ? { item: best, distance: bestD } : null;
  }

  /**
   * @param onCollect callback(item) → fire the burst, sound and HUD update
   * @returns {number} how many were collected this frame
   */
  update(dt, elapsed, bunnyPos, onCollect) {
    let got = 0;
    for (const it of this.items) {
      if (it.taken) continue;
      const g = it.group;
      const bob = Math.sin(elapsed * 1.5 + it.phase) * 0.11;
      g.position.y = it.baseY + 0.45 + bob;
      it.crystal.rotation.y += dt * it.spin;
      it.crystal.rotation.x = Math.sin(elapsed * 0.8 + it.phase) * 0.12;
      it.ring.rotation.z += dt * 0.8;
      it.ring.rotation.y += dt * 0.35;

      const dx = bunnyPos.x - g.position.x;
      const dz = bunnyPos.z - g.position.z;
      const dy = bunnyPos.y + 0.5 - g.position.y;
      const d = Math.hypot(dx, dy, dz);

      if (d < 3.0) {
        // Magnet: the crystal accelerates in, so the last metre feels like a
        // grab rather than a precision landing.
        it.pull = Math.min(1, it.pull + dt * 3);
        const pullSpeed = lerp(1.5, 7.0, it.pull);
        g.position.x += (dx / d) * pullSpeed * dt;
        g.position.y += (dy / d) * pullSpeed * dt;
        g.position.z += (dz / d) * pullSpeed * dt;
        const s = 1 + it.pull * 0.35;
        it.crystal.scale.set(0.8 * s, 1.7 * s, 0.8 * s);
      } else {
        it.pull = 0;
        it.crystal.scale.set(0.8, 1.7, 0.8);
        g.position.x = lerp(g.position.x, it.x, Math.min(1, dt * 6));
        g.position.z = lerp(g.position.z, it.z, Math.min(1, dt * 6));
        g.position.y = it.baseY + 0.45 + bob;
      }

      if (d < 0.85) {
        it.taken = true;
        it.group.visible = false;
        this.collected++;
        got++;
        onCollect?.(g.position);
      }
    }
    return got;
  }
}

/* ── bounce pads ───────────────────────────────────────────── */

export class BouncePad {
  constructor(terrain, position, { ringTexture, power = 7.2, radius = 1.0 } = {}) {
    this.power = power;
    this.radius = radius;
    this.cooldown = 0;
    this.pulse = Math.random() * Math.PI * 2;

    const y = terrain.heightAt(position.x, position.z);
    this.position = new Vector3(position.x, y, position.z);
    this.group = new Group();
    this.group.position.copy(this.position);
    // Sit the pad flush with the local slope.
    const n = terrain.normalAt(position.x, position.z, new Vector3());
    this.group.quaternion.setFromUnitVectors(_up, n);

    this.mat = new MeshStandardNodeMaterial({
      color: 0x0c2a33,
      emissive: new Color(0x3fe0ff),
      emissiveIntensity: 2.6,
      emissiveMap: ringTexture,
      roughness: 0.35,
      metalness: 0.2,
    });
    const rimMat = new MeshStandardNodeMaterial({
      color: 0x16323a,
      emissive: new Color(0x2ba8c8),
      emissiveIntensity: 1.2,
      roughness: 0.4,
      metalness: 0.7,
    });

    // A cylinder's cap UVs are a disc, so the radial ring texture lands
    // exactly where you would hope.
    mesh(new CylinderGeometry(radius, radius * 0.96, 0.07, 40), this.mat, this.group, { name: 'pad' });
    mesh(new TorusGeometry(radius * 1.02, 0.035, 10, 48), rimMat, this.group,
      { rot: [Math.PI / 2, 0, 0], pos: [0, 0.03, 0], name: 'pad-rim' });
  }

  /** @returns {boolean} true on the frame the pad fires */
  tryTrigger(dt, bunnyPos, bunnyRadius = 0.35) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.pulse += dt * 3.4;
    this.mat.emissiveIntensity = 2.2 + Math.sin(this.pulse) * 0.9;
    const dx = bunnyPos.x - this.position.x;
    const dz = bunnyPos.z - this.position.z;
    const dy = bunnyPos.y - this.position.y;
    const inXZ = Math.hypot(dx, dz) < this.radius + bunnyRadius;
    const inY = dy > -0.4 && dy < 1.3;
    if (inXZ && inY && this.cooldown <= 0) {
      this.cooldown = 0.4;
      this.flash = 1;
      return true;
    }
    this.flash = Math.max(0, (this.flash || 0) - dt * 2.2);
    if (this.flash > 0) this.mat.emissiveIntensity += this.flash * 6;
    return false;
  }
}

/* ── loose rocks ───────────────────────────────────────────── */

/**
 * Rocks with just enough physics to be satisfying: gravity, terrain
 * collision, bounce, and a shove when the bunny walks into them.
 */
export class RockField {
  constructor(terrain, { regolith, count = 26, seed = 808 } = {}) {
    this.terrain = terrain;
    this.rocks = [];
    const rng = makeRng(seed);

    const normalMap = regolith.normalMap.clone();
    normalMap.repeat.set(3, 3);
    normalMap.needsUpdate = true;
    this.mat = new MeshStandardNodeMaterial({
      color: 0x8d857a,
      normalMap,
      normalScale: { x: 1.4, y: 1.4 },
      roughness: 1.0,
      metalness: 0.0,
    });

    const geo = new IcosahedronGeometry(0.34, 1);
    this.mesh = new InstancedMesh(geo, this.mat, count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'rocks';

    for (let i = 0; i < count; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = 9 + Math.sqrt(rng()) * 46;
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      const scale = 0.45 + rng() * rng() * 1.5;
      this.rocks.push({
        pos: new Vector3(x, terrain.heightAt(x, z) + scale * 0.3, z),
        vel: new Vector3(),
        spin: new Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(2),
        quat: new Quaternion().setFromEuler(new Euler(rng() * 6, rng() * 6, rng() * 6)),
        radius: 0.34 * scale,
        scale,
        resting: true,
      });
    }
    this._writeAll();
  }

  _writeAll() {
    for (let i = 0; i < this.rocks.length; i++) {
      const r = this.rocks[i];
      _m.compose(r.pos, r.quat, _v.set(r.scale, r.scale, r.scale));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, gravity, bunnyPos, bunnyVel) {
    const { rocks, terrain } = this;
    for (let i = 0; i < rocks.length; i++) {
      const r = rocks[i];
      if (r.resting && r.vel.lengthSq() < 1e-5) {
        // Still asleep, but still worth a nudge test against the bunny.
        this._shove(r, bunnyPos, bunnyVel);
        continue;
      }
      r.vel.y -= gravity * dt;
      r.pos.addScaledVector(r.vel, dt);

      const ground = terrain.heightAt(r.pos.x, r.pos.z) + r.radius * 0.62;
      if (r.pos.y <= ground) {
        r.pos.y = ground;
        if (r.vel.y < 0) {
          // Lunar gravity plus no atmosphere: things bounce, they do not
          // settle instantly. Restitution 0.34 keeps it lively.
          r.vel.y = -r.vel.y * 0.34;
          if (Math.abs(r.vel.y) < 0.35) r.vel.y = 0;
        }
        // Rolling friction, plus spin derived from travel so rocks tumble
        // instead of sliding like hockey pucks.
        r.vel.x *= 1 - Math.min(1, 2.6 * dt);
        r.vel.z *= 1 - Math.min(1, 2.6 * dt);
        const speed = Math.hypot(r.vel.x, r.vel.z);
        r.spin.set(r.vel.z / r.radius, r.spin.y * 0.98, -r.vel.x / r.radius);
        r.quat.multiply(_q.setFromAxisAngle(_v.set(r.spin.x, 0, r.spin.z).normalize(), speed * dt * 1.2));
        if (speed < 0.02 && r.vel.y === 0) {
          r.resting = true;
          r.vel.set(0, 0, 0);
        }
      } else {
        r.resting = false;
        _q.setFromEuler(_e.set(r.spin.x * dt, r.spin.y * dt, r.spin.z * dt));
        r.quat.multiply(_q);
      }

      this._shove(r, bunnyPos, bunnyVel);
    }
    this._writeAll();
  }

  _shove(r, bunnyPos, bunnyVel) {
    const dx = r.pos.x - bunnyPos.x;
    const dz = r.pos.z - bunnyPos.z;
    const minD = r.radius + 0.42;
    const d2 = dx * dx + dz * dz;
    if (d2 > minD * minD || d2 < 1e-6) return;
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const nz = dz / d;
    // Push along the bunny's heading, scaled by how fast it is moving.
    const push = clamp(bunnyVel.x * nx + bunnyVel.z * nz, -6, 6) * 0.85;
    if (Math.abs(push) < 0.15) return;
    r.vel.x = push * nx;
    r.vel.z = push * nz;
    r.vel.y = Math.abs(push) * 0.22;   // a small hop, as if punted
    r.spin.set(nz * push * 1.4, (Math.random() - 0.5) * 3, -nx * push * 1.4);
    r.resting = false;
  }
}

/* ── particles ─────────────────────────────────────────────── */

/** Ballistic grit: opaque grains that fly out and fall back under 1.62 m/s². */
export class DustSpray {
  constructor({ max = 260, gravity = 1.62 } = {}) {
    this.max = max;
    this.gravity = gravity;
    this.p = [];
    for (let i = 0; i < max; i++) {
      this.p.push({ life: 0, maxLife: 1, pos: new Vector3(), vel: new Vector3(), size: 0.03 });
    }
    this.next = 0;
    this.mat = new MeshStandardNodeMaterial({ color: 0xb9b2a6, roughness: 1, metalness: 0 });
    this.mesh = new InstancedMesh(new IcosahedronGeometry(1, 0), this.mat, max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = 'dust';
    this._hideAll();
  }

  _hideAll() {
    _m.makeScale(0.0001, 0.0001, 0.0001);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Fire a cone of grains. `count` scales with the size of the event. */
  burst(origin, { count = 14, speed = 2.2, spread = 1.0, up = 1.0, size = 0.03, life = 1.1 } = {}) {
    for (let k = 0; k < count; k++) {
      const p = this.p[this.next];
      this.next = (this.next + 1) % this.max;
      const a = Math.random() * Math.PI * 2;
      // Bias the spray sideways: dust flies out along the ground, not up.
      const el = Math.random() * 0.9;
      const s = speed * (0.35 + Math.random() * 0.9);
      p.pos.copy(origin).add(_v.set(
        (Math.random() - 0.5) * 0.14,
        Math.random() * 0.06,
        (Math.random() - 0.5) * 0.14,
      ));
      p.vel.set(Math.cos(a) * Math.cos(el) * s * spread, Math.sin(el) * s * up, Math.sin(a) * Math.cos(el) * s * spread);
      p.life = life * (0.6 + Math.random() * 0.8);
      p.maxLife = p.life;
      p.size = size * (0.55 + Math.random() * 0.9);
    }
  }

  update(dt) {
    let alive = false;
    for (let i = 0; i < this.max; i++) {
      const p = this.p[i];
      if (p.life <= 0) continue;
      alive = true;
      p.life -= dt;
      p.vel.y -= this.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      const t = saturate(p.life / p.maxLife);
      // Shrink over the last third of life so grains vanish rather than pop.
      const s = p.size * (t > 0.35 ? 1 : t / 0.35);
      if (p.life <= 0) {
        _m.makeScale(0.0001, 0.0001, 0.0001);
      } else {
        _m.makeScale(s, s, s);
        _m.setPosition(p.pos);
      }
      this.mesh.setMatrixAt(i, _m);
    }
    if (alive) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Additive sparks for pickups. Colour fades to black, which reads as zero. */
export class Sparkles {
  constructor({ max = 180, glowTexture, gravity = 0.6 } = {}) {
    this.max = max;
    // Sparks drift down slowly and fade; they are light, not debris.
    this.gravity = gravity;
    this.p = [];
    for (let i = 0; i < max; i++) {
      this.p.push({ life: 0, maxLife: 1, pos: new Vector3(), vel: new Vector3(), size: 0.2, tint: new Color() });
    }
    this.next = 0;
    this.mat = new MeshBasicNodeMaterial({
      map: glowTexture || null,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      color: 0xffffff,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), this.mat, max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'sparkles';
    // Create the colour buffer up front so per-instance tint works from the
    // very first frame.
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, _black);
    this.mesh.instanceColor.needsUpdate = true;
    this._hideAll();
  }

  _hideAll() {
    _m.makeScale(0.0001, 0.0001, 0.0001);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  burst(origin, { count = 16, speed = 1.6, size = 0.22, life = 0.8, color = 0x8ff0ff } = {}) {
    for (let k = 0; k < count; k++) {
      const p = this.p[this.next];
      this.next = (this.next + 1) % this.max;
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.4 + Math.random());
      p.pos.copy(origin);
      p.vel.set(Math.sin(b) * Math.cos(a) * s, Math.abs(Math.cos(b)) * s * 0.9 + 0.4, Math.sin(b) * Math.sin(a) * s);
      p.life = life * (0.6 + Math.random() * 0.7);
      p.maxLife = p.life;
      p.size = size * (0.5 + Math.random());
      p.tint.set(color);
    }
  }

  update(dt, camera) {
    let alive = false;
    for (let i = 0; i < this.max; i++) {
      const p = this.p[i];
      if (p.life <= 0) continue;
      alive = true;
      p.life -= dt;
      p.vel.y -= this.gravity * dt;
      p.vel.multiplyScalar(1 - Math.min(1, 1.6 * dt));
      p.pos.addScaledVector(p.vel, dt);
      const t = saturate(p.life / p.maxLife);
      const s = p.size * (1.25 - t * 0.5);
      if (p.life <= 0) {
        _m.makeScale(0.0001, 0.0001, 0.0001);
        this.mesh.setColorAt(i, _black);
      } else {
        _m.makeScale(s, s, s);
        _m.setPosition(p.pos);
        if (camera) {
          // Billboard by baking the camera quaternion into the matrix.
          _m.multiply(_billboardMat.copy(camera.matrixWorld));
        }
        this.mesh.setColorAt(i, _scratchColor.copy(p.tint).multiplyScalar(t * t * 1.6));
      }
      this.mesh.setMatrixAt(i, _m);
    }
    if (alive) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

const _black = new Color(0, 0, 0);
const _billboardMat = new Matrix4();

/* ── the lander ────────────────────────────────────────────── */

export function buildLander(terrain, { foilNormal, scuffRoughness } = {}) {
  const g = new Group();
  g.name = 'lander';
  g.position.set(0, terrain.heightAt(0, 0), 0);

  const foilMat = new MeshStandardNodeMaterial({
    color: 0xd8a24a,
    // Crumpled foil, not a mirror. At 0.34 the low sun punched a blown-out
    // white specular blob across the whole descent stage.
    roughness: 0.46,
    metalness: 1.0,
    normalMap: foilNormal || null,
    normalScale: { x: 0.9, y: 0.9 },
    roughnessMap: scuffRoughness || null,
  });
  const whiteMat = new MeshStandardNodeMaterial({
    color: 0xe9eaee,
    roughness: 0.42,
    metalness: 0.15,
    roughnessMap: scuffRoughness || null,
  });
  const metalMat = new MeshStandardNodeMaterial({
    color: 0x9aa2ae,
    roughness: 0.36,
    metalness: 1.0,
    roughnessMap: scuffRoughness || null,
  });
  const darkMat = new MeshStandardNodeMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.4 });
  const glassMat = new MeshPhysicalNodeMaterial({
    color: 0x0a1a24,
    roughness: 0.05,
    metalness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
  });
  const beaconMat = new MeshStandardNodeMaterial({
    color: 0x330505,
    emissive: new Color(0xff3b2f),
    emissiveIntensity: 3.5,
    roughness: 0.3,
  });

  // Descent stage: an octagonal foil-wrapped drum.
  mesh(new CylinderGeometry(1.02, 1.18, 0.52, 8), foilMat, g, { pos: [0, 0.92, 0] });
  mesh(new CylinderGeometry(1.06, 1.06, 0.07, 8), metalMat, g, { pos: [0, 1.2, 0] });
  // Engine bell underneath.
  mesh(new CylinderGeometry(0.2, 0.44, 0.5, 20, 1, true), darkMat, g, { pos: [0, 0.42, 0] });
  mesh(new CylinderGeometry(0.46, 0.46, 0.05, 20), metalMat, g, { pos: [0, 0.68, 0] });

  // Ascent stage / cabin.
  mesh(new CylinderGeometry(0.62, 0.74, 0.46, 16), whiteMat, g, { pos: [0, 1.46, 0] });
  mesh(new SphereGeometry(0.62, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), whiteMat,
    g, { pos: [0, 1.69, 0], scale: [1, 0.75, 1] });
  // Triangular windows, angled outward.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    mesh(new BoxGeometry(0.3, 0.2, 0.04), glassMat, g, {
      pos: [Math.cos(a) * 0.6, 1.5, Math.sin(a) * 0.6],
      rot: [0, -a + Math.PI / 2, 0],
    });
  }
  mesh(new TorusGeometry(0.64, 0.035, 8, 24), metalMat, g, { pos: [0, 1.69, 0], rot: [Math.PI / 2, 0, 0] });

  // High-gain antenna.
  mesh(new CylinderGeometry(0.03, 0.03, 0.42, 8), metalMat, g, { pos: [0.1, 2.05, -0.1], rot: [0.35, 0, 0.2] });
  mesh(new ConeGeometry(0.26, 0.16, 20, 1, true), whiteMat, g,
    { pos: [0.16, 2.3, -0.18], rot: [0.35, 0, 0.2] });

  // Beacon.
  const beacon = mesh(new SphereGeometry(0.06, 12, 10), beaconMat, g, { pos: [0, 2.0, 0.2] });
  beacon.castShadow = false;

  // Four legs with footpads. Each strut is built by orienting a cylinder
  // along the line between two points, which is far less error-prone than
  // parenting to a group and hoping lookAt lines up with the cylinder axis.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const lx = Math.cos(a);
    const lz = Math.sin(a);

    const top = new Vector3(lx * 0.8, 0.82, lz * 0.8);
    const foot = new Vector3(lx * 2.0, 0.1, lz * 2.0);
    strut(g, metalMat, top, foot, 0.05, 0.062);

    const braceTop = new Vector3(lx * 0.95, 1.12, lz * 0.95);
    const braceFoot = new Vector3(lx * 1.85, 0.35, lz * 1.85);
    strut(g, metalMat, braceTop, braceFoot, 0.026, 0.03);

    mesh(new CylinderGeometry(0.3, 0.26, 0.07, 16), metalMat, g,
      { pos: [foot.x, 0.035, foot.z] });
  }

  // Ladder down the near leg.
  const ladder = new Group();
  ladder.position.set(0.0, 0, 2.05);
  g.add(ladder);
  for (let i = 0; i < 5; i++) {
    mesh(new BoxGeometry(0.36, 0.035, 0.035), metalMat, ladder, { pos: [0, 0.3 + i * 0.28, 0] });
  }
  for (const s of [-1, 1]) {
    mesh(new CylinderGeometry(0.022, 0.022, 1.5, 8), metalMat, ladder, { pos: [s * 0.18, 0.88, 0] });
  }

  g.userData.beacon = beacon;
  g.userData.beaconMat = beaconMat;
  return g;
}

/* ── the flag ──────────────────────────────────────────────── */

/**
 * CPU-animated flag. A 15×9 sheet is trivial to update per frame, and doing
 * the wave by hand lets the normals be derived analytically instead of
 * recomputed, which keeps the cloth reading as cloth under a hard sun.
 */
export class Flag {
  constructor(terrain, position, { flagTexture, height = 2.3, width = 0.95 } = {}) {
    this.group = new Group();
    this.height = height;
    const y = terrain.heightAt(position.x, position.z);
    this.group.position.set(position.x, y, position.z);

    const poleMat = new MeshStandardNodeMaterial({ color: 0xc4cad4, roughness: 0.3, metalness: 1.0 });
    const baseMat = new MeshStandardNodeMaterial({ color: 0x4a4e57, roughness: 0.7, metalness: 0.5 });

    mesh(new CylinderGeometry(0.028, 0.034, height, 12), poleMat, this.group, { pos: [0, height / 2, 0] });
    mesh(new CylinderGeometry(0.34, 0.42, 0.09, 20), baseMat, this.group, { pos: [0, 0.045, 0] });
    mesh(new SphereGeometry(0.05, 12, 10), poleMat, this.group, { pos: [0, height + 0.03, 0] });

    this.mat = new MeshStandardNodeMaterial({
      map: flagTexture,
      side: DoubleSide,
      roughness: 0.86,
      metalness: 0.0,
    });
    this.segX = 15;
    this.segY = 9;
    const geo = new PlaneGeometry(width, 0.6, this.segX, this.segY);
    this.width = width;
    this.clothH = 0.6;
    this.cloth = mesh(geo, this.mat, this.group, {
      pos: [width / 2 + 0.03, height - 0.42, 0],
      name: 'flag-cloth',
    });
    this.cloth.castShadow = true;
    this.basePos = this.cloth.geometry.attributes.position.array.slice();

    this.planted = false;
    this.plantT = 0;
    this.wave = Math.random() * 10;
    this._setFurled();
  }

  _setFurled() {
    // Before it is planted the flag is a tight roll at the top of the pole.
    this.cloth.scale.set(0.12, 0.16, 0.16);
    this.cloth.position.set(0.05, this.height - 0.14, 0);
  }

  plant() {
    if (this.planted) return false;
    this.planted = true;
    this.plantT = 0;
    return true;
  }

  update(dt, elapsed) {
    this.wave = elapsed;
    if (!this.planted) return;

    if (this.plantT < 1) {
      this.plantT = Math.min(1, this.plantT + dt / 1.5);
      const t = smoothstep(0, 1, this.plantT);
      // Unfurl: the roll opens and the cloth drops down the pole.
      this.cloth.scale.set(lerp(0.12, 1, t), lerp(0.16, 1, t), lerp(0.16, 1, t));
      this.cloth.position.set(
        lerp(0.05, this.width / 2 + 0.03, t),
        lerp(this.height - 0.14, this.height - 0.42, t),
        0,
      );
    }

    // Travelling wave, amplitude growing away from the pole.
    const pos = this.cloth.geometry.attributes.position;
    const nrm = this.cloth.geometry.attributes.normal;
    const arr = pos.array;
    const narr = nrm.array;
    const k = 5.2;
    const speed = 6.0;
    for (let i = 0; i < arr.length; i += 3) {
      const bx = this.basePos[i];
      const by = this.basePos[i + 1];
      const u = (bx + this.width / 2) / this.width;      // 0 at pole, 1 at fly
      const amp = u * u * 0.085;
      const phase = k * (bx + this.width / 2) - speed * this.wave;
      const dz = Math.sin(phase) * amp + Math.sin(phase * 1.7 + 1.3) * amp * 0.35;
      // The cloth also lifts a little where the wave crests.
      const lift = Math.max(0, Math.sin(phase)) * amp * 0.7;
      arr[i + 2] = dz;
      arr[i + 1] = by + lift * 0.25;
      // Analytic normal of the travelling wave.
      const dzd = Math.cos(phase) * amp * k + Math.cos(phase * 1.7 + 1.3) * amp * 0.35 * k * 1.7;
      const nx = -dzd;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, 0.25, nz);
      narr[i] = nx * inv;
      narr[i + 1] = 0.25 * inv;
      narr[i + 2] = nz * inv;
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }
}

/* ── the landing pad decal ─────────────────────────────────── */

/** Painted target ring on the regolith under the lander. */
export function buildPadMarking(terrain, ringTexture) {
  const g = new Group();
  const y = terrain.heightAt(0, 0) + 0.05;
  const mat = new MeshBasicNodeMaterial({
    map: ringTexture,
    transparent: true,
    depthWrite: false,
    // Additive at full strength reads as a pool of glowing water. This is a
    // worn paint marking catching low sun, so it stays barely there.
    opacity: 0.14,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const disc = mesh(new CylinderGeometry(2.8, 2.8, 0.01, 48), mat, g, { pos: [0, y, 0], shadow: false });
  disc.renderOrder = 1;
  return g;
}
