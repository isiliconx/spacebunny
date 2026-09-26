/**
 * Camera rig.
 *
 * Third person by default: an orbit around the bunny that lags behind with
 * critically-damped smoothing and refuses to sink into the regolith. Press C
 * to drop into the bunny's own eyes for a first-person view.
 *
 * The camera never uses a raycast for terrain — it samples the height field
 * along the boom and pulls in when the ground gets in the way, which is both
 * cheaper and steadier than a physics ray against a 74k-triangle mesh.
 */

import { Vector3 } from 'three/webgpu';
import { clamp, damp } from '../util/math.js';

const MIN_DIST = 1.6;
const MAX_DIST = 16;
const MIN_PITCH = -0.35;
const MAX_PITCH = 1.25;

export class CameraRig {
  constructor(camera, terrain) {
    this.camera = camera;
    this.terrain = terrain;
    this.mode = 'third';

    this.yaw = Math.PI * 0.25;
    this.pitch = 0.28;
    this.distance = 5.2;
    this.wantDistance = 5.2;

    this.focus = new Vector3(0, 1, 0);       // damped look-at point
    this.smoothFocus = new Vector3(0, 1, 0);
    this.shakeAmount = 0;
    this.shakeTime = 0;
    this.fov = 55;
    this.wantFov = 55;
    this._tmp = new Vector3();
    this._pos = new Vector3();
  }

  toggle() {
    this.mode = this.mode === 'third' ? 'first' : 'third';
    this.wantFov = this.mode === 'first' ? 72 : 55;
    return this.mode;
  }

  shake(amount) {
    this.shakeAmount = Math.min(1.4, this.shakeAmount + amount);
  }

  /** Consume the frame's orbit/zoom input. */
  applyInput(input) {
    if (input.orbitDX || input.orbitDY) {
      // Drag right to swing the camera left, like turning a globe.
      this.yaw -= input.orbitDX * 0.0055;
      this.pitch = clamp(this.pitch + input.orbitDY * 0.0042, MIN_PITCH, MAX_PITCH);
    }
    if (input.zoomDelta) {
      this.wantDistance = clamp(this.wantDistance + input.zoomDelta * 0.9, MIN_DIST, MAX_DIST);
    }
  }

  /**
   * @param target   world position of the bunny's feet
   * @param height   bunny height, used to frame the body
   * @param headPos  eye position, for first person
   * @param facing   bunny yaw, for first-person look direction
   */
  update(dt, target, height, headPos, facing) {
    this.distance = damp(this.distance, this.wantDistance, 8, dt);

    if (this.mode === 'first') {
      this.fov = damp(this.fov, 72, 9, dt);
      this._updateFirst(dt, headPos, facing);
    } else {
      this.fov = damp(this.fov, 55, 9, dt);
      this._updateThird(dt, target, height);
    }

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _updateThird(dt, target, height) {
    // Focus a little above the feet so the bunny sits in the lower third of
    // frame rather than dead centre.
    this.focus.set(target.x, target.y + height * 0.62, target.z);
    this.smoothFocus.x = damp(this.smoothFocus.x, this.focus.x, 9, dt);
    this.smoothFocus.y = damp(this.smoothFocus.y, this.focus.y, 6, dt);
    this.smoothFocus.z = damp(this.smoothFocus.z, this.focus.z, 9, dt);

    const cp = Math.cos(this.pitch);
    const dir = this._tmp.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );

    // Walk the boom outward and stop at the first point that would put the
    // camera underground. The test deliberately starts a little way out: at
    // a shallow pitch the first sample sits almost on the focus point, which
    // is only ~0.7 m above the ground, so testing from t=0 would report a
    // collision and slam the camera into the bunny's back on every frame.
    const clearance = 0.45;
    const startT = Math.min(0.9, this.distance * 0.35);
    const span = Math.max(0.001, this.distance - startT);
    const steps = 8;
    let allowed = this.distance;
    for (let i = 1; i <= steps; i++) {
      const t = startT + (i / steps) * span;
      const px = this.smoothFocus.x + dir.x * t;
      const pz = this.smoothFocus.z + dir.z * t;
      const py = this.smoothFocus.y + dir.y * t;
      const ground = this.terrain.heightAt(px, pz) + clearance;
      if (py < ground) {
        allowed = Math.max(MIN_DIST * 0.55, t - span / steps);
        break;
      }
    }

    this._pos.copy(this.smoothFocus).addScaledVector(dir, allowed);
    // Hard floor: never below the regolith, whatever the boom decided.
    const floor = this.terrain.heightAt(this._pos.x, this._pos.z) + 0.35;
    if (this._pos.y < floor) this._pos.y = floor;

    this._applyShake(dt);
    this.camera.position.copy(this._pos);
    this.camera.lookAt(this.smoothFocus);
  }

  _updateFirst(dt, headPos, facing) {
    // First person inherits the orbit yaw so the mouse still turns the view,
    // and adds the bunny's own facing on top.
    this.smoothFocus.x = damp(this.smoothFocus.x, headPos.x, 24, dt);
    this.smoothFocus.y = damp(this.smoothFocus.y, headPos.y, 24, dt);
    this.smoothFocus.z = damp(this.smoothFocus.z, headPos.z, 24, dt);

    this._pos.copy(this.smoothFocus);
    this._applyShake(dt);
    this.camera.position.copy(this._pos);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw + facing);
    this.camera.rotateX(this.pitch - 0.12);
  }

  _applyShake(dt) {
    if (this.shakeAmount <= 0.0005) {
      this.shakeAmount = 0;
      return;
    }
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.6);
    this.shakeTime += dt * 47;
    const a = this.shakeAmount * this.shakeAmount * 0.16;
    this._pos.x += Math.sin(this.shakeTime * 1.7) * a;
    this._pos.y += Math.sin(this.shakeTime * 2.3 + 1.1) * a;
    this._pos.z += Math.sin(this.shakeTime * 1.3 + 2.7) * a;
  }
}
