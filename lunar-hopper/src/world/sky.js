/**
 * Sky and lighting.
 *
 * On the Moon there is no atmosphere to scatter light, so the sky is black,
 * the shadows are nearly black, and every edge is razor sharp. The scene is
 * lit by one hard directional "sun" with a small amount of cheat fill so the
 * shadow side of the bunny still reads as a shape rather than a hole.
 *
 * The Earth and the sun are placed at fixed, believable angles so that there
 * is a camera heading where both are in frame at once.
 */

import {
  Group,
  Mesh,
  SphereGeometry,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  SpriteNodeMaterial,
  Sprite,
  DirectionalLight,
  HemisphereLight,
  Color,
  Vector3,
  AdditiveBlending,
  BackSide,
} from 'three/webgpu';

const DEG = Math.PI / 180;

/**
 * Unit vector toward a given azimuth/elevation.
 *
 * Azimuth is measured from +Z toward +X — i.e. the direction is
 * (sin az, sin el, cos az) — which is the SAME convention the camera rig and
 * the bunny's facing use. The earlier (cos az, ., sin az) form was internally
 * consistent but offset the sun by 90 degrees from every other heading in the
 * project, so "put the camera where the sun is" silently produced a backlit
 * subject instead of a lit one.
 */
function skyDirection(azDeg, elDeg) {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  const ce = Math.cos(el);
  return new Vector3(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az));
}

export class Sky {
  /**
   * @param {object} textures  star, earth and glow textures from textures.js
   * @param {object} opts      sun/earth placement and exposure
   */
  constructor(textures, opts = {}) {
    const {
      sunAzimuth = 148, sunElevation = 19,
      earthAzimuth = 216, earthElevation = 31,
      earthDistance = 2100, sunDistance = 3200,
    } = opts;

    this.group = new Group();
    this.group.name = 'sky';

    /* ── stars ────────────────────────────────────────────── */
    // Values above 1.0 are deliberate: the composite is tone-mapped at the
    // end of the post chain, so a pure-white star would come out grey. The
    // overbright end of the field is what the bloom pass latches onto.
    const starMat = new MeshBasicNodeMaterial({
      map: textures.stars,
      side: BackSide,
      depthWrite: false,
      color: new Color(1.9, 1.9, 2.1),
    });
    this.stars = new Mesh(new SphereGeometry(4200, 48, 32), starMat);
    this.stars.renderOrder = -10;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    /* ── sun ──────────────────────────────────────────────── */
    this.sunDir = skyDirection(sunAzimuth, sunElevation).normalize();

    const sunSpriteMat = new SpriteNodeMaterial({
      map: textures.sunGlow,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
      color: new Color(2.4, 2.3, 2.1),
    });
    this.sunSprite = new Sprite(sunSpriteMat);
    this.sunSprite.position.copy(this.sunDir).multiplyScalar(sunDistance);
    this.sunSprite.scale.setScalar(sunDistance * 0.075);   // ≈ 4.3° across
    this.sunSprite.renderOrder = -5;
    this.group.add(this.sunSprite);

    /* ── Earth ────────────────────────────────────────────── */
    this.earth = new Group();
    const earthMat = new MeshStandardNodeMaterial({
      map: textures.earth.map,
      roughness: 1.0,
      metalness: 0.0,
    });
    const globe = new Mesh(new SphereGeometry(118, 64, 48), earthMat);
    globe.receiveShadow = false;
    globe.castShadow = false;
    this.earth.add(globe);
    this.globe = globe;

    // Cloud shell, a hair larger so it never z-fights with the surface.
    const cloudMat = new MeshStandardNodeMaterial({
      map: textures.earth.cloudMap,
      roughness: 1.0,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      opacity: 0.92,
    });
    this.clouds = new Mesh(new SphereGeometry(120.5, 48, 32), cloudMat);
    this.earth.add(this.clouds);

    // Atmospheric halo, additively blended behind the disc.
    const haloMat = new SpriteNodeMaterial({
      map: textures.haloGlow,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.5,
      color: new Color(0.55, 0.75, 1.0),
    });
    const halo = new Sprite(haloMat);
    halo.scale.setScalar(118 * 4.6);
    this.earth.add(halo);

    const earthDir = skyDirection(earthAzimuth, earthElevation).normalize();
    this.earth.position.copy(earthDir).multiplyScalar(earthDistance);
    this.earth.rotation.z = 23.4 * DEG;   // axial tilt, seen from the Moon
    this.earth.renderOrder = -4;
    this.group.add(this.earth);

    /* ── lights ───────────────────────────────────────────── */
    // The sun. Tight ortho frustum that follows the bunny keeps the shadow
    // map dense enough for crisp contact shadows at this scale.
    this.sun = new DirectionalLight(0xfff3e0, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.028;
    this.sun.shadow.radius = 2.2;
    this._setShadowExtent(26);
    this.group.add(this.sun, this.sun.target);

    // Regolith bounce. On the real Moon this is ~1/10000 of direct sun, but
    // dropping shadows to absolute black hides the geometry; this is the one
    // deliberate departure from physical accuracy.
    this.bounce = new HemisphereLight(0x141c2e, 0x6d6357, 0.46);
    this.group.add(this.bounce);

    // A dim opposing fill so silhouettes stay readable from any angle. At
    // 0.22 the back of the bunny read as a silhouette hole on WebGPU, where
    // the same frame lands a little darker than the WebGL fallback.
    this.fill = new DirectionalLight(0x9fc0ff, 0.38);
    this.fill.position.copy(this.sunDir).multiplyScalar(-60).setY(24);
    this.group.add(this.fill, this.fill.target);

    // Offsets from the player's position, so the sky can be re-centred every
    // frame without the celestial objects sliding across each other.
    this._earthOffset = this.earth.position.clone();
    this._sunOffset = this.sunSprite.position.clone();
  }

  _setShadowExtent(half) {
    const c = this.sun.shadow.camera;
    c.left = -half;
    c.right = half;
    c.top = half;
    c.bottom = -half;
    c.updateProjectionMatrix();
  }

  /** Keep the shadow frustum and the sky centred on the player. */
  update(dt, elapsed, focus) {
    // Snap the sun to the focus so the shadow map never runs out of range.
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 90);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.fill.position.copy(focus).addScaledVector(this.sunDir, -60);
    this.fill.position.y = focus.y + 24;
    this.fill.target.position.copy(focus);
    this.fill.target.updateMatrixWorld();

    // Earth turns once every ~50 s of play time, which reads as a slow,
    // believable drift rather than a spinning globe.
    this.globe.rotation.y = elapsed * 0.0125;
    this.clouds.rotation.y = elapsed * 0.0148;
  }

  /** Called once per frame to keep the horizon from sliding as the player moves. */
  follow(focus) {
    this.stars.position.set(focus.x, 0, focus.z);
    this.earth.position.set(
      focus.x + this._earthOffset.x,
      this._earthOffset.y,
      focus.z + this._earthOffset.z,
    );
    this.sunSprite.position.set(
      focus.x + this._sunOffset.x,
      this._sunOffset.y,
      focus.z + this._sunOffset.z,
    );
  }
}
