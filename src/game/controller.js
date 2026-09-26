/**
 * Bunny physics and state.
 *
 * Lunar gravity is 1.62 m/s² — about a sixth of Earth's — and the whole feel
 * of the game comes from taking that literally rather than faking it: jumps
 * hang for five seconds, there is no air drag, and the only friction is the
 * regolith underfoot. Horizontal control is therefore loose and slidey, which
 * is exactly right and also exactly fun.
 *
 * Collision is against the terrain height field directly. There is no rigid
 * body, no raycast and no mesh test — the bunny is a point with a radius, and
 * "the ground" is a function.
 */

import { Vector3 } from 'three/webgpu';
import { clamp, saturate, approachAngle } from '../util/math.js';
import { BASIN_LIMIT } from '../world/terrain.js';

export const GRAVITY = 1.62;

const WALK_SPEED = 3.0;
const RUN_SPEED = 6.2;
const ACCEL_GROUND = 20;
const ACCEL_AIR = 5.5;
const FRICTION_GROUND = 11;
const TURN_RATE = 11;

const JUMP_VELOCITY = 4.2;
// Holding jump after takeoff softens the ascent. Falling is *not* softened —
// a slightly heavier descent keeps the arc floaty on the way up while
// landing with some authority instead of dead-slowing back to the ground.
const JUMP_HOLD_GRAVITY_SCALE = 0.62;
const FALL_GRAVITY_SCALE = 1.25;
const AIR_JUMP_VELOCITY = 3.8;
const DIVE_ACCEL = 11;
const MAX_FALL = 26;

const COYOTE_TIME = 0.14;       // grace period to jump after walking off a ledge
const JUMP_BUFFER = 0.16;       // grace period for pressing jump just before landing
const STEP_DISTANCE = 0.44;     // metres of travel per footstep
const SLOPE_LIMIT = 0.42;       // 1 - normal.y; beyond this the bunny slides
const SLIDE_ACCEL = 11;
// The rig is authored with straight legs, which leaves the soles about 6.4 cm
// above the group origin. Drop the group by that much so the feet rest on the
// regolith instead of hovering above it.
const FOOT_OFFSET = -0.062;

export class BunnyController {
  constructor({ terrain, bunny, trail, pads, dust, audio, on = {} }) {
    this.terrain = terrain;
    this.bunny = bunny;
    this.trail = trail;
    this.pads = pads;
    this.dust = dust;
    this.audio = audio;
    this.on = on;

    this.position = new Vector3(0, terrain.heightAt(0, 0), 6);
    this.velocity = new Vector3();
    this.yaw = Math.PI;
    this.speed = 0;
    this.grounded = true;
    this.coyote = 0;
    this.jumpBufferT = 0;
    this.airJumps = 1;          // one mid-air "lunar hop"
    this.spinT = 0;
    this.landImpact = 0;
    this.sprinting = false;
    this.stepAccum = 0;
    this.nextFoot = 0;
    this.diving = false;
    this.frozen = false;

    this._forward = new Vector3();
    this._wish = new Vector3();
    this._foot = new Vector3();
    this._head = new Vector3();

    this.applyTransform();
  }

  get eyePosition() {
    this.bunny.eyeWorld(this._head);
    return this._head;
  }

  respawn() {
    this.position.set(0, this.terrain.heightAt(0, 0), 6);
    this.velocity.set(0, 0, 0);
    this.spinT = 0;
    this.airJumps = 1;
    this.applyTransform();
  }

  applyTransform() {
    const g = this.bunny.group;
    g.position.set(this.position.x, this.position.y + FOOT_OFFSET, this.position.z);
    g.rotation.y = this.yaw;
  }

  update(dt, input, elapsed) {
    const wasGrounded = this.grounded;
    const axis = this.frozen ? { x: 0, y: 0 } : input.axis();
    const axisMag = Math.hypot(axis.x, axis.y);
    this.sprinting = !this.frozen && input.sprinting && axisMag > 0.1;

    const groundY = this.terrain.heightAt(this.position.x, this.position.z);
    // A small tolerance keeps the bunny "grounded" while walking over the
    // small bumps the height field makes between samples.
    const onGround = this.velocity.y <= 0.02 && this.position.y <= groundY + 0.07;
    this.grounded = onGround;

    /* ── horizontal movement ───────────────────────────────── */
    const maxSpeed = this.sprinting ? RUN_SPEED : WALK_SPEED;
    if (axisMag > 0.08) {
      // Rotate the input into world space using the current facing.
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      this._wish.set(axis.x * cos + axis.y * sin, 0, -axis.x * sin + axis.y * cos);
      if (this._wish.lengthSq() > 1) this._wish.normalize();

      // Turn toward the direction of travel before accelerating hard, so the
      // bunny never moonwalks.
      const want = Math.atan2(this._wish.x, this._wish.z);
      this.yaw = approachAngle(this.yaw, want, TURN_RATE * dt);

      const accel = this.grounded ? ACCEL_GROUND : ACCEL_AIR;
      const target = _wishVel.copy(this._wish).multiplyScalar(maxSpeed * saturate(axisMag));
      this.velocity.x = approach(this.velocity.x, target.x, accel * dt);
      this.velocity.z = approach(this.velocity.z, target.z, accel * dt);
    } else if (this.grounded) {
      // Regolith friction. There is no air drag, so this is the only thing
      // that slows the bunny down.
      const f = Math.max(0, 1 - FRICTION_GROUND * dt);
      this.velocity.x *= f;
      this.velocity.z *= f;
    }

    /* ── slope ─────────────────────────────────────────────── */
    if (this.grounded) {
      const normal = this.terrain.normalAt(this.position.x, this.position.z, _normal);
      const steep = 1 - normal.y;
      if (steep > SLOPE_LIMIT) {
        // Slide down the fall line, harder the steeper it gets.
        const k = (steep - SLOPE_LIMIT) * SLIDE_ACCEL * 2.2;
        this.velocity.x += normal.x * k * dt * 8;
        this.velocity.z += normal.z * k * dt * 8;
      }
    }

    /* ── jump ──────────────────────────────────────────────── */
    if (!this.frozen && input.consumePress('Space')) this.jumpBufferT = JUMP_BUFFER;
    this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);
    this.coyote = this.grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);

    if (this.jumpBufferT > 0) {
      if (this.coyote > 0 || this.grounded) {
        this._doJump(JUMP_VELOCITY);
      } else if (this.airJumps > 0) {
        // The lunar hop: a second push that comes with a somersault.
        this.airJumps--;
        this._doJump(AIR_JUMP_VELOCITY);
        this.spinT = 0.85;
        this.on.airJump?.();
        this.audio?.doubleJump();
        this.dust?.burst(this.position, {
          count: 10, speed: 1.4, size: 0.025, life: 0.7, up: 0.5,
        });
      }
    }

    /* ── gravity ───────────────────────────────────────────── */
    this.diving = false;
    if (!this.grounded) {
      let g = GRAVITY;
      // Holding jump after takeoff: reduced gravity for a higher, floatier arc.
      if (this.velocity.y > 0 && input.jumpHeld) g *= JUMP_HOLD_GRAVITY_SCALE;
      else if (this.velocity.y < 0) g *= FALL_GRAVITY_SCALE;
      // Poking the stick down while airborne dives.
      if (axis.y < -0.5) {
        this.diving = true;
        g += DIVE_ACCEL;
      }
      this.velocity.y -= g * dt;
      this.velocity.y = Math.max(this.velocity.y, -MAX_FALL);
    } else {
      this.velocity.y = Math.max(0, this.velocity.y);
      this.airJumps = 1;
    }

    /* ── integrate + collide ───────────────────────────────── */
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    // Keep the bunny inside the basin. The crater wall is climbable, so the
    // barrier sits past where the slope gets genuinely unpleasant — but the
    // soft push has to be strong enough that sprinting into the wall settles
    // against it instead of pinning into the hard clamp.
    const r = Math.hypot(this.position.x, this.position.z);
    if (r > BASIN_LIMIT) {
      const over = r - BASIN_LIMIT;
      const push = saturate(over / 2.5) * 55;
      this.velocity.x -= (this.position.x / r) * push * dt;
      this.velocity.z -= (this.position.z / r) * push * dt;
      if (r > BASIN_LIMIT + 5) {
        this.position.x = (this.position.x / r) * (BASIN_LIMIT + 5);
        this.position.z = (this.position.z / r) * (BASIN_LIMIT + 5);
      }
    }

    const newGroundY = this.terrain.heightAt(this.position.x, this.position.z);
    if (this.position.y <= newGroundY) {
      // Landing.
      const impact = Math.max(0, -this.velocity.y);
      this.position.y = newGroundY;
      this.grounded = true;
      this.velocity.y = 0;
      if (!wasGrounded && impact > 0.9) {
        const strength = saturate(impact / 7.5);
        this.landImpact = strength;
        this.audio?.land(strength);
        this.on.land?.(strength);
        // Regolith sprays outward along the ground, not upward.
        this.dust?.burst(this.position, {
          count: Math.round(10 + strength * 34),
          speed: 1.4 + strength * 4.2,
          spread: 1.25,
          up: 0.55,
          size: 0.022 + strength * 0.03,
          life: 0.9 + strength * 0.7,
        });
      }
    } else {
      this.grounded = false;
    }

    /* ── bounce pads ───────────────────────────────────────── */
    for (const pad of this.pads) {
      if (pad.tryTrigger(dt, this.position, 0.34)) {
        this.velocity.y = pad.power;
        this.grounded = false;
        this.spinT = 0.8;
        this.airJumps = 1;
        this.on.bounce?.(pad);
        this.audio?.bounce();
        this.dust?.burst(pad.position, {
          count: 26, speed: 5.5, spread: 0.8, up: 0.9, size: 0.03, life: 1.2,
        });
      }
    }

    /* ── footsteps and prints ──────────────────────────────── */
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && this.speed > 0.35) {
      this.stepAccum += this.speed * dt;
      if (this.stepAccum >= STEP_DISTANCE) {
        this.stepAccum -= STEP_DISTANCE;
        this._footstep();
      }
    } else if (!this.grounded) {
      this.stepAccum = Math.min(this.stepAccum, STEP_DISTANCE * 0.6);
    }

    if (this.spinT > 0) this.spinT = Math.max(0, this.spinT - dt);

    this.applyTransform();

    /* ── drive the animation rig ───────────────────────────── */
    this.bunny.update({
      dt,
      elapsed,
      speed: this.speed,
      maxSpeed: RUN_SPEED,
      grounded: this.grounded,
      vy: this.velocity.y,
      sprint: this.sprinting,
      yaw: this.yaw,
      landImpact: this.landImpact,
      spinning: this.spinT > 0,
    });
    this.landImpact = 0;   // consumed
  }

  _doJump(velocity) {
    this.velocity.y = velocity;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBufferT = 0;
    this.on.jump?.();
    this.audio?.jump();
    this.dust?.burst(this.position, {
      count: 12, speed: 2.2, spread: 1.1, up: 0.4, size: 0.026, life: 0.8,
    });
  }

  _footstep() {
    const i = this.nextFoot;
    this.nextFoot = 1 - i;
    this.bunny.footWorld(i, this._foot);
    // Only leave a print if the foot is actually near the ground.
    const ground = this.terrain.heightAt(this._foot.x, this._foot.z);
    if (this._foot.y - ground < 0.16) {
      this.trail?.add(this.terrain, this._foot.x, this._foot.z, this.yaw, {
        // A rabbit's hind foot is roughly a hand across. Below ~0.3 m the print
        // is sub-pixel at normal play distance and the trail reads as nothing.
        size: 0.34 + Math.random() * 0.06,
      });
    }
    const speedFrac = saturate(this.speed / RUN_SPEED);
    this.audio?.step(speedFrac);
    // Running kicks up more dust than walking; it is a dry moon, so even a
    // slow walk raises a little.
    if (this.speed > 1.2) {
      this.dust?.burst(this._foot, {
        count: 2 + Math.round(speedFrac * 5),
        speed: 0.8 + speedFrac * 2.2,
        spread: 0.7,
        up: 0.5,
        size: 0.016 + speedFrac * 0.014,
        life: 0.55 + speedFrac * 0.4,
      });
    }
    this.on.step?.(i, this._foot);
  }
}

const _wishVel = new Vector3();
const _normal = new Vector3();

/** Move `a` toward `b` by at most `step`. */
function approach(a, b, step) {
  const d = b - a;
  if (Math.abs(d) <= step) return b;
  return a + Math.sign(d) * step;
}
