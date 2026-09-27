/**
 * The space bunny.
 *
 * No model file: the character is assembled from primitives into a hand-built
 * rig, then animated procedurally. Every joint here is a plain Object3D, which
 * keeps the animation readable and lets the physics drive it directly — the
 * walk cycle is a function of ground speed, the airborne pose is a function of
 * vertical velocity, and landings feed a squash value into the same rig.
 *
 * Hierarchy (each level is a transform the animator is allowed to drive):
 *
 *   root ─ tilt ─ squash ─ hips ─┬─ torso / haunches / belly
 *                                ├─ head ─┬─ skull, muzzle, eyes
 *                                │        ├─ earL ─ ear
 *                                │        └─ earR ─ ear
 *                                ├─ armL / armR ─ paw
 *                                ├─ legL / legR ─ shin ─ foot
 *                                ├─ tail
 *                                └─ backpack
 */

import {
  Group,
  Mesh,
  SphereGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  BoxGeometry,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  Vector3,
  Color,
} from 'three/webgpu';
import { clamp, lerp, damp, saturate, makeRng } from '../util/math.js';

const FUR_LIGHT = 0xf3ece0;
const FUR_DARK = 0xcfc5b6;
const EAR_PINK = 0xe79aa4;
const SUIT_ORANGE = 0xff7b33;

export class Bunny {
  constructor({ furNormal, furTint, scuffRoughness } = {}) {
    this.group = new Group();
    this.group.name = 'bunny';
    const rng = makeRng(4242);

    /* ── materials ─────────────────────────────────────────── */
    const furMat = new MeshPhysicalNodeMaterial({
      color: FUR_LIGHT,
      map: furTint || null,
      normalMap: furNormal || null,
      normalScale: { x: 0.3, y: 0.3 },
      roughness: 0.93,
      metalness: 0.0,
      // Sheen is what sells "fur" rather than "painted plastic": it puts a
      // soft retroreflective lift on the silhouette edge.
      sheen: 1.0,
      sheenColor: new Color(0xfff2dd),
      sheenRoughness: 0.42,
    });
    const furLightMat = new MeshPhysicalNodeMaterial({
      color: 0xfdf8f0,
      map: furTint || null,
      normalMap: furNormal || null,
      normalScale: { x: 0.4, y: 0.4 },
      roughness: 0.95,
      metalness: 0.0,
      sheen: 1.0,
      sheenColor: new Color(0xfff8ec),
      sheenRoughness: 0.4,
    });
    const pinkMat = new MeshPhysicalNodeMaterial({
      color: EAR_PINK,
      roughness: 0.62,
      metalness: 0.0,
      sheen: 0.5,
      sheenColor: new Color(0xffd9de),
    });
    const noseMat = new MeshPhysicalNodeMaterial({
      color: 0xd4697a,
      roughness: 0.42,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.3,
    });
    const eyeMat = new MeshPhysicalNodeMaterial({
      color: 0x090a12,
      roughness: 0.05,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
    });
    // The catchlight is unlit and deliberately overbright: a real specular
    // highlight would vanish whenever the sun is behind the bunny.
    const glintMat = new MeshBasicNodeMaterial({ color: new Color(2.6, 2.6, 2.7) });
    const suitMat = new MeshStandardNodeMaterial({
      color: SUIT_ORANGE,
      roughness: 0.52,
      metalness: 0.08,
      roughnessMap: scuffRoughness || null,
    });
    const suitWhite = new MeshStandardNodeMaterial({ color: 0xe6e8ee, roughness: 0.44, metalness: 0.1 });
    const metalMat = new MeshStandardNodeMaterial({
      color: 0xc2c8d2,
      roughness: 0.3,
      metalness: 1.0,
      roughnessMap: scuffRoughness || null,
    });
    const ledMat = new MeshStandardNodeMaterial({
      color: 0x0b2b33,
      emissive: new Color(0x5ce9ff),
      emissiveIntensity: 3.4,
      roughness: 0.3,
    });
    const ledRedMat = new MeshStandardNodeMaterial({
      color: 0x2b0b0b,
      emissive: new Color(0xff4d3a),
      emissiveIntensity: 3.0,
      roughness: 0.3,
    });

    this.materials = { furMat, eyeMat, ledMat };

    /* ── geometry helpers ──────────────────────────────────── */
    const add = (parent, geo, mat, { pos, rot, scale, name } = {}) => {
      const m = new Mesh(geo, mat);
      if (pos) m.position.set(pos[0], pos[1], pos[2]);
      if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
      if (scale) m.scale.set(scale[0], scale[1], scale[2]);
      if (name) m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    /* ── rig ───────────────────────────────────────────────── */
    this.tilt = new Group();      // pitch/roll from acceleration
    this.squash = new Group();    // squash & stretch, and the somersault
    this.hips = new Group();
    this.tilt.add(this.squash);
    this.squash.add(this.hips);
    this.group.add(this.tilt);

    const HIP_Y = 0.315;
    this.hips.position.y = HIP_Y;

    // Torso: one egg-shaped mass plus a chest and a belly so the silhouette
    // has a waist instead of reading as a single ball.
    add(this.hips, new SphereGeometry(0.2, 32, 24), furMat,
      { pos: [0, 0.13, 0], scale: [0.95, 1.12, 1.22], name: 'torso' });
    add(this.hips, new SphereGeometry(0.145, 24, 18), furLightMat,
      { pos: [0, 0.15, 0.13], scale: [1.0, 0.95, 0.72], name: 'chest' });
    add(this.hips, new SphereGeometry(0.125, 24, 18), furLightMat,
      { pos: [0, 0.1, 0.155], scale: [0.86, 1.0, 0.5], name: 'belly' });
    // Haunches: the heavy back legs that make a rabbit read as a rabbit.
    for (const s of [-1, 1]) {
      add(this.hips, new SphereGeometry(0.125, 20, 16), furMat,
        { pos: [s * 0.115, 0.02, -0.03], scale: [0.95, 1.0, 1.15], name: 'haunch' });
    }

    // Backpack.
    this.backpack = new Group();
    this.backpack.position.set(0, 0.26, -0.2);
    this.hips.add(this.backpack);
    add(this.backpack, new BoxGeometry(0.185, 0.175, 0.095), suitMat, { pos: [0, 0, 0] });
    add(this.backpack, new BoxGeometry(0.19, 0.05, 0.1), suitWhite, { pos: [0, 0.075, 0] });
    for (const s of [-1, 1]) {
      add(this.backpack, new SphereGeometry(0.02, 12, 10), ledMat,
        { pos: [s * 0.055, 0.02, -0.05], name: 'led' });
    }
    const antenna = add(this.backpack, new CylinderGeometry(0.006, 0.008, 0.17, 8), metalMat,
      { pos: [0.062, 0.12, -0.01], rot: [-0.32, 0, 0.14] });
    antenna.name = 'antenna';
    add(this.backpack, new SphereGeometry(0.016, 10, 8), ledRedMat,
      { pos: [0.085, 0.2, -0.036], name: 'antenna-tip' });

    // Head.
    this.head = new Group();
    this.head.position.set(0, 0.34, 0.02);
    this.hips.add(this.head);
    add(this.head, new SphereGeometry(0.155, 32, 24), furMat,
      { pos: [0, 0.03, 0], scale: [1.0, 1.02, 1.06], name: 'skull' });
    add(this.head, new SphereGeometry(0.088, 20, 16), furLightMat,
      { pos: [0, -0.022, 0.132], scale: [1.18, 0.88, 1.0], name: 'muzzle' });
    add(this.head, new SphereGeometry(0.024, 14, 12), noseMat,
      { pos: [0, 0.012, 0.216], scale: [1.25, 0.85, 1.0], name: 'nose' });
    // Mouth: two short dark bars, enough to imply a nose-to-mouth line.
    for (const s of [-1, 1]) {
      add(this.head, new BoxGeometry(0.055, 0.008, 0.008), new MeshStandardNodeMaterial({ color: 0x53363a, roughness: 0.7 }),
        { pos: [s * 0.026, -0.032, 0.205], rot: [0, 0, s * 0.55], name: 'mouth' });
    }
    for (const s of [-1, 1]) {
      add(this.head, new SphereGeometry(0.045, 20, 16), eyeMat,
        { pos: [s * 0.073, 0.045, 0.108], name: 'eye' });
      add(this.head, new SphereGeometry(0.015, 10, 8), glintMat,
        { pos: [s * 0.086, 0.066, 0.142], name: 'glint' });
      add(this.head, new SphereGeometry(0.052, 16, 12), pinkMat,
        { pos: [s * 0.128, -0.015, 0.075], scale: [0.45, 0.72, 0.62], name: 'cheek' });
    }

    // Ears. Each is a pivot at the base plus a flop angle the animator adds
    // on top, so the ear can lag behind the head as the bunny turns.
    //
    // The splay matters more than it looks: pivots only 0.068 apart with
    // 0.106-wide capsules made the two ears merge into a single forked shape
    // from every angle. Wider spacing plus a real outward roll separates them
    // into two distinct ears without pushing them off the skull.
    this.ears = [];
    for (const s of [-1, 1]) {
      const pivot = new Group();
      pivot.position.set(s * 0.086, 0.125, -0.012);
      pivot.rotation.set(-0.12, 0, s * 0.34);
      this.head.add(pivot);
      const ear = new Group();
      pivot.add(ear);
      add(ear, new CapsuleGeometry(0.048, 0.31, 8, 20), furMat,
        { pos: [0, 0.2, 0], scale: [1.0, 1.0, 0.72], name: 'ear' });
      add(ear, new CapsuleGeometry(0.033, 0.25, 8, 16), pinkMat,
        { pos: [0, 0.195, 0.026], scale: [1.0, 1.0, 0.42], name: 'ear-inner' });
      this.ears.push({ pivot, ear, base: pivot.rotation.clone(), side: s });
    }

    // Arms.
    this.arms = [];
    for (const s of [-1, 1]) {
      const pivot = new Group();
      pivot.position.set(s * 0.178, 0.235, 0.01);
      this.hips.add(pivot);
      add(pivot, new CapsuleGeometry(0.042, 0.1, 8, 16), furMat,
        { pos: [0, -0.082, 0], name: 'arm' });
      add(pivot, new SphereGeometry(0.05, 16, 12), furLightMat,
        { pos: [0, -0.145, 0.008], scale: [1.0, 0.9, 1.1], name: 'paw' });
      this.arms.push({ pivot, side: s });
    }

    // Legs: thigh pivot, shin, and a broad foot.
    this.legs = [];
    for (const s of [-1, 1]) {
      const pivot = new Group();
      pivot.position.set(s * 0.108, 0.035, 0.005);
      this.hips.add(pivot);
      add(pivot, new CapsuleGeometry(0.062, 0.085, 8, 16), furMat,
        { pos: [0, -0.072, 0], name: 'thigh' });
      const shin = new Group();
      shin.position.y = -0.135;
      pivot.add(shin);
      add(shin, new CapsuleGeometry(0.05, 0.075, 8, 16), furMat,
        { pos: [0, -0.06, 0], name: 'shin' });
      const foot = add(shin, new SphereGeometry(0.062, 16, 12), furLightMat,
        { pos: [0, -0.115, 0.032], scale: [0.95, 0.58, 1.45], name: 'foot' });
      this.legs.push({ pivot, shin, foot, side: s });
    }

    // Tail. Sits lower and further back than the backpack so it reads as a
    // pom behind the pack instead of being swallowed by it.
    this.tail = new Group();
    this.tail.position.set(0, 0.125, -0.235);
    this.hips.add(this.tail);
    add(this.tail, new SphereGeometry(0.095, 20, 16), furLightMat,
      { pos: [0, 0, 0], name: 'tail' });

    // Ground clearance: the rig is authored with the hips at HIP_Y, so the
    // root sits on the terrain with the feet just touching.
    this.footRestY = -HIP_Y;
    // How far the sole sits below the foot mesh's origin. The sole is a
    // sphere of radius 0.062 squashed to 0.58, so this is the rest offset the
    // controller compensates for.
    this.soleDrop = 0.062 * 0.58;

    /* ── animation state ───────────────────────────────────── */
    this._phase = 0;
    this._squash = 0;        // >0 squashed, <0 stretched
    this._squashVel = 0;
    this._earLag = 0;
    this._earVel = 0;
    this._headYaw = 0;
    this._headPitch = 0;
    this._lookTarget = null;
    this._blink = 0;
    this._nextBlink = 2 + rng() * 4;
    this._twitch = 0;
    this._nextTwitch = 3 + rng() * 5;
    this._spinAngle = 0;
    this._emote = 0;
    this._emoteKind = null;
    this._lastYaw = 0;
    this._lean = 0;
    this._roll = 0;
    this._headWorld = new Vector3();
    this._prevFootY = [null, null];
  }

  /** Total height including ears, for camera framing. */
  get height() { return 1.12; }

  setLookTarget(v) { this._lookTarget = v; }

  /** Kick off a canned flourish. `kind` is 'wiggle' or 'salute'. */
  emote(kind = 'wiggle', duration = 1.7) {
    this._emote = duration;
    this._emoteKind = kind;
    this._emoteDuration = duration;
  }

  get emoting() { return this._emote > 0; }

  /**
   * Pose the rig.
   *
   * @param {object} s  { dt, elapsed, speed, maxSpeed, grounded, vy, sprint,
   *                      landImpact, yaw, airborne, spinning }
   */
  update(s) {
    const { dt, elapsed } = s;
    const speed = s.speed || 0;
    const speedFrac = saturate(speed / (s.maxSpeed || 5.5));
    const moving = speed > 0.25;

    /* ── squash & stretch ────────────────────────────────────
       A critically-damped spring on a single scalar. Landing feeds it an
       impulse; it rings down on its own. */
    if (s.landImpact) this._squashVel -= s.landImpact * 0.9;
    // Airborne stretch keyed to vertical speed: stretch going up, squash
    // coming down. This is the cheapest possible "game feel" and it reads.
    const targetStretch = s.grounded ? 0 : clamp(s.vy * 0.055, -0.10, 0.13);
    const stiffness = s.grounded ? 170 : 60;
    const damping = s.grounded ? 17 : 9;
    this._squashVel += ((targetStretch - this._squash) * stiffness - this._squashVel * damping) * dt;
    this._squash += this._squashVel * dt;
    this._squash = clamp(this._squash, -0.28, 0.34);

    const sq = 1 + this._squash * 0.9;
    this.squash.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    /* ── gait ──────────────────────────────────────────────── */
    if (moving && s.grounded) {
      // Stride frequency rises with speed but not linearly, or a sprint
      // turns into a blur of legs.
      this._phase += dt * (2.1 + speed * 1.05);
    } else if (!s.grounded) {
      this._phase += dt * 0.6;    // slow drift so the pose never freezes
    } else {
      // Ease to a stop rather than snapping out of the cycle.
      this._phase += dt * 0.9 * (1 - speedFrac);
    }
    const ph = this._phase;
    const swing = moving ? 0.30 + speedFrac * 0.62 : 0;

    /* ── legs ──────────────────────────────────────────────── */
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const phase = ph + i * Math.PI;
      let hipRot;
      let kneeRot = 0;
      let footRot;

      if (!s.grounded) {
        // Tuck on the way up, reach on the way down.
        const rise = saturate(s.vy / 5);
        hipRot = lerp(0.45, -0.95, rise) + (i === 0 ? 0.12 : -0.12);
        kneeRot = lerp(0.2, 1.15, rise);
        footRot = -hipRot * 0.35 - kneeRot * 0.5;
      } else if (moving) {
        hipRot = Math.sin(phase) * swing;
        // The knee only bends one way, and mostly on the recovery stroke.
        kneeRot = Math.max(0, -Math.sin(phase + 0.75)) * (0.45 + speedFrac * 0.75);
        footRot = -(hipRot * 0.6 + kneeRot * 0.75);
      } else {
        // Idle: legs straight and planted. A bent idle knee would float the
        // feet a few centimetres above the regolith, which reads as a bug.
        hipRot = Math.sin(elapsed * 0.9 + i) * 0.02;
        kneeRot = 0.02;
        footRot = -hipRot - kneeRot;
      }
      leg.pivot.rotation.x = damp(leg.pivot.rotation.x, hipRot, 22, dt);
      leg.shin.rotation.x = damp(leg.shin.rotation.x, kneeRot, 22, dt);
      leg.foot.rotation.x = damp(leg.foot.rotation.x, footRot, 20, dt);
    }

    /* ── arms ──────────────────────────────────────────────── */
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      const phase = ph + i * Math.PI;
      let shoulder;
      let out = 0;

      if (!s.grounded) {
        const rise = saturate(s.vy / 5);
        shoulder = lerp(-0.35, -2.0, rise);
        out = lerp(0.5, 0.15, rise);
      } else if (moving) {
        shoulder = -Math.sin(phase) * swing * 0.85 - 0.05;
      } else {
        // Gentle breathing sway.
        shoulder = Math.sin(elapsed * 1.1 + i * 1.7) * 0.07 - 0.04;
      }
      arm.pivot.rotation.x = damp(arm.pivot.rotation.x, shoulder, 18, dt);
      arm.pivot.rotation.z = damp(arm.pivot.rotation.z, arm.side * out, 16, dt);
    }

    /* ── torso lean and roll ───────────────────────────────── */
    const leanTarget = s.grounded ? speedFrac * 0.30 : clamp(-s.vy * 0.02, -0.12, 0.16);
    this._lean = damp(this._lean, leanTarget, 9, dt);
    this.tilt.rotation.x = this._lean;

    // Bank into turns: compare facing before and after this frame.
    if (s.yaw !== undefined) {
      let dYaw = (s.yaw - this._lastYaw) % (Math.PI * 2);
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      const lateral = clamp(dYaw / Math.max(dt, 1e-3) * 0.045, -0.30, 0.30);
      this._roll = damp(this._roll, -lateral, 7, dt);
      this._lastYaw = s.yaw;
    }
    this.tilt.rotation.z = this._roll + Math.sin(ph) * speedFrac * 0.05;

    // Vertical bob, doubled frequency because the body rises twice per stride.
    const bob = moving && s.grounded
      ? Math.abs(Math.sin(ph)) * 0.035 * (0.4 + speedFrac)
      : Math.sin(elapsed * 1.6) * 0.006;
    this.hips.position.y = 0.315 + bob;

    /* ── head: look-at, blink, and a curious tilt ──────────── */
    let wantYaw = 0;
    let wantPitch = 0;
    if (this._lookTarget) {
      this.head.getWorldPosition(this._headWorld);
      _lookVec.copy(this._lookTarget).sub(this._headWorld);
      const worldYaw = Math.atan2(_lookVec.x, _lookVec.z);
      wantYaw = clamp(Math.atan2(Math.sin(worldYaw - this.group.rotation.y), Math.cos(worldYaw - this.group.rotation.y)), -0.9, 0.9);
      wantPitch = clamp(-Math.atan2(_lookVec.y, Math.hypot(_lookVec.x, _lookVec.z)), -0.5, 0.5);
    } else if (moving) {
      wantPitch = -0.04;
    }
    this._headYaw = damp(this._headYaw, wantYaw, 6, dt);
    this._headPitch = damp(this._headPitch, wantPitch, 6, dt);
    this.head.rotation.y = this._headYaw;
    this.head.rotation.x = this._headPitch;

    // Blink by scaling the eye spheres; skip it mid-sprint.
    this._nextBlink -= dt;
    if (this._nextBlink <= 0 && speedFrac < 0.7) {
      this._blink = 0.13;
      this._nextBlink = 2.5 + Math.random() * 5;
    }
    this._blink = Math.max(0, this._blink - dt);
    const eyeScale = this._blink > 0 ? 0.12 : 1;
    for (const child of this.head.children) {
      if (child.name === 'eye') child.scale.set(1, eyeScale, 1);
    }

    /* ── ears: spring lag, twitch, speed streaming ─────────── */
    // A second spring, driven by body motion. Ears that trail behind the
    // head are most of what makes the character feel alive.
    const earTargetVel = (this._roll * 2.4 + (moving ? -speedFrac * 0.5 : 0) + (s.grounded ? 0 : 0.55));
    this._earVel += (earTargetVel - this._earLag) * 46 * dt - this._earVel * 7.5 * dt;
    this._earLag += this._earVel * dt;

    this._nextTwitch -= dt;
    if (this._nextTwitch <= 0) {
      this._twitch = 0.45;
      this._nextTwitch = 2.5 + Math.random() * 6;
    }
    this._twitch = Math.max(0, this._twitch - dt);
    const twitchImpulse = this._twitch > 0 ? Math.sin(this._twitch * 34) * 0.5 * (this._twitch / 0.45) : 0;

    for (let i = 0; i < 2; i++) {
      const e = this.ears[i];
      const idle = Math.sin(elapsed * (1.25 + i * 0.3) + i * 2.1) * 0.055;
      const flop = -this._earLag * (i === 0 ? 1 : 0.9);
      // Airborne ears stand up; fast running streams them backwards.
      const air = s.grounded ? 0 : lerp(0.25, -0.75, saturate(-s.vy / 4));
      const run = moving ? -speedFrac * 0.55 : 0;
      e.pivot.rotation.x = e.base.x + idle + flop + air + run + twitchImpulse * (i === 0 ? 1 : -0.6);
      e.pivot.rotation.z = e.base.z + e.side * (0.06 + twitchImpulse * 0.35 + Math.sin(elapsed * 0.8 + i) * 0.03);
    }

    /* ── tail ──────────────────────────────────────────────── */
    this.tail.rotation.y = Math.sin(elapsed * 2.3) * 0.16 * (0.4 + speedFrac);
    this.tail.rotation.x = -0.1 + Math.sin(elapsed * 1.7) * 0.07 + speedFrac * 0.25;

    /* ── somersault ────────────────────────────────────────── */
    if (s.spinning) {
      this._spinAngle += dt * 12.0;
    } else if (this._spinAngle !== 0) {
      // Settle back to upright quickly rather than unwinding a full turn.
      this._spinAngle = damp(this._spinAngle, 0, 14, dt);
      if (Math.abs(this._spinAngle) < 0.01) this._spinAngle = 0;
    }
    this.squash.rotation.x = this._spinAngle;

    /* ── emote overlay ─────────────────────────────────────── */
    if (this._emote > 0) {
      this._emote = Math.max(0, this._emote - dt);
      const t = 1 - this._emote / this._emoteDuration;      // 0 → 1
      const env = Math.sin(t * Math.PI);                     // fade in and out
      if (this._emoteKind === 'salute') {
        this.arms[1].pivot.rotation.x = lerp(this.arms[1].pivot.rotation.x, -2.3, env * 0.9);
        this.arms[1].pivot.rotation.z = lerp(this.arms[1].pivot.rotation.z, -0.35, env * 0.9);
        this.hips.position.y += Math.abs(Math.sin(t * Math.PI * 3)) * 0.07 * env;
      } else {
        // Lunar wiggle: a side-to-side shimmy with a little hop. The sway
        // lives on `tilt`, not the root, so it composes with (rather than
        // fights) the facing yaw the controller writes every frame.
        const sway = Math.sin(t * Math.PI * 7) * 0.34 * env;
        this.tilt.rotation.y = sway;
        this.tilt.rotation.z += sway * 0.5;
        this.hips.position.y += Math.abs(Math.sin(t * Math.PI * 3.5)) * 0.16 * env;
        for (const arm of this.arms) {
          arm.pivot.rotation.x = lerp(arm.pivot.rotation.x, -1.9, env * 0.7);
          arm.pivot.rotation.z = lerp(arm.pivot.rotation.z, arm.side * 0.9, env * 0.7);
        }
        for (const ear of this.ears) {
          ear.pivot.rotation.x = lerp(ear.pivot.rotation.x, -0.4, env * 0.8);
        }
      }
    } else if (this._emoteKind) {
      // Snap the overlay back to neutral the frame the emote ends.
      this.tilt.rotation.y = 0;
      this._emoteKind = null;
    }
  }

  /** World position of a foot, for stamping prints. */
  footWorld(index, out = new Vector3()) {
    return this.legs[index].foot.getWorldPosition(out);
  }

  /** Where the eyes are, for the first-person camera. */
  eyeWorld(out = new Vector3()) {
    return this.head.getWorldPosition(out).add(_eyeOffset);
  }
}

const _eyeOffset = new Vector3(0, 0.05, 0.1);
const _lookVec = new Vector3();
