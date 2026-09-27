/**
 * Lunar Hopper — bootstrap.
 *
 * Builds the world, wires the game systems together, and runs the frame loop.
 * The order here matters: textures are generated first (they are the slow
 * part and the loader needs to say so), then the scene graph, then the post
 * chain, and only then does the loop start.
 *
 * `window.APP` is a deliberate inspection handle: the headless render checks
 * drive the real game through it rather than poking at internals, so what gets
 * verified is what a player gets.
 */

import {
  Scene,
  PerspectiveCamera,
  WebGPURenderer,
  RenderPipeline,
  PCFShadowMap,
  ACESFilmicToneMapping,
  Vector3,
  SRGBColorSpace,
} from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

import {
  makeRegolith, makeFurNormal, makeFurTint, makeStarTexture, makeEarthTextures,
  makeGlowSprite, makePawPrint, makeDustHalo, makeRingGlow, makeFlagTexture,
  makeScuffRoughness, makeFoilNormal,
} from './util/textures.js';
import { Terrain, FootprintTrail } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Bunny } from './entities/bunny.js';
import {
  CrystalField, BouncePad, RockField, DustSpray, Sparkles,
  buildLander, Flag, buildPadMarking,
} from './entities/props.js';
import { Input } from './game/input.js';
import { CameraRig } from './game/camera.js';
import { GameAudio } from './game/audio.js';
import { BunnyController, GRAVITY } from './game/controller.js';

const SEED = 20260926;
// The threshold has to sit ABOVE the brightness of sunlit regolith. At 0.72
// the lit ground itself passed the bloom filter, which spread a broad milky
// wash over the lower half of every frame and read as fog. Only genuinely
// emissive things — crystals, pad rings, the sun, the lander beacon — should
// glow.
const BLOOM_DEFAULT = { strength: 0.55, radius: 0.45, threshold: 0.95 };

/* ── DOM ──────────────────────────────────────────────────── */
const dom = {
  canvas: document.getElementById('scene'),
  hud: document.getElementById('hud'),
  overlay: document.getElementById('overlay'),
  loader: document.getElementById('loader'),
  loaderFill: document.getElementById('loaderFill'),
  loaderText: document.getElementById('loaderText'),
  startBtn: document.getElementById('startBtn'),
  backendFoot: document.getElementById('backendFoot'),
  crystalCount: document.getElementById('crystalCount'),
  crystalTotal: document.getElementById('crystalTotal'),
  crystalPips: document.getElementById('crystalPips'),
  clock: document.getElementById('clock'),
  backend: document.getElementById('backend'),
  fps: document.getElementById('fps'),
  altitude: document.getElementById('altitude'),
  speed: document.getElementById('speed'),
  compassNeedle: document.getElementById('compassNeedle'),
  compassDist: document.getElementById('compassDist'),
  objective: document.getElementById('objective'),
  toasts: document.getElementById('toasts'),
  centerToast: document.getElementById('centerToast'),
  reticle: document.getElementById('reticle'),
  vignette: document.getElementById('vignette'),
  fatal: document.getElementById('fatal'),
  fatalMsg: document.getElementById('fatalMsg'),
};

function fatal(err) {
  console.error(err);
  dom.fatal.hidden = false;
  dom.fatalMsg.textContent = (err && (err.stack || err.message)) || String(err);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
function setProgress(frac, label) {
  dom.loaderFill.style.width = `${Math.round(frac * 100)}%`;
  if (label) dom.loaderText.textContent = label;
}

/* ── boot ─────────────────────────────────────────────────── */

const state = {
  running: false,
  started: false,
  elapsed: 0,
  missionTime: 0,
  complete: false,
  bloomOn: true,
  muted: false,
  fps: 60,
  frame: 0,
};

let renderer, pipeline, bloomPass, scene, camera, sky;
let terrain, terrainMesh, farGround, trail, bunny, controller, crystals, rockField, dust, sparkles;
let flag, lander, pads = [];
let input, rig, audio;
let regolith;

async function boot() {
  /* ── renderer ────────────────────────────────────────────── */
  // Quality overrides, so the thing stays playable on a weak GPU without
  // editing code:  ?bloom=0  ?shadow=0  ?dpr=1  ?terrain=<segments>
  const params = new URLSearchParams(location.search);
  const flagOn = (name, dflt) => {
    if (!params.has(name)) return dflt;
    return params.get(name) !== '0' && params.get(name) !== 'false';
  };

  renderer = new WebGPURenderer({
    canvas: dom.canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  const forcedDpr = parseFloat(params.get('dpr'));
  renderer.setPixelRatio(Number.isFinite(forcedDpr)
    ? forcedDpr
    : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = flagOn('shadow', true);
  // r186 removed PCFSoftShadowMap; PCF plus shadow.radius is the supported
  // soft-shadow path now.
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.outputColorSpace = SRGBColorSpace;

  setProgress(0.05, 'starting the renderer…');
  await nextFrame();
  await renderer.init();

  const isWebGPU = !!renderer.backend?.isWebGPUBackend;
  const backendName = isWebGPU ? 'WebGPU' : 'WebGL 2 (fallback)';
  dom.backend.textContent = backendName;
  dom.backend.classList.toggle('webgpu', isWebGPU);
  dom.backendFoot.textContent = isWebGPU
    ? 'WebGPU active'
    : 'WebGPU unavailable — running the WebGL 2 fallback';
  const maxAniso = renderer.capabilities?.getMaxAnisotropy?.() ?? 8;

  /* ── textures ────────────────────────────────────────────── */
  const textures = {};
  const steps = [
    ['synthesising regolith', () => {
      regolith = makeRegolith({ size: 512, seed: SEED, aniso: maxAniso });
      // Fine tiling: one texture repeat every 4.5 m of ground.
      for (const t of [regolith.map, regolith.normalMap, regolith.roughnessMap]) {
        t.repeat.set(40, 40);
        t.needsUpdate = true;
      }
    }],
    ['growing fur and foil', () => {
      textures.furNormal = makeFurNormal({ size: 256, seed: SEED + 3 });
      textures.furTint = makeFurTint({ size: 128, seed: SEED + 21 });
      textures.scuff = makeScuffRoughness({ size: 256, seed: SEED + 61 });
      textures.foil = makeFoilNormal({ size: 256, seed: SEED + 88 });
    }],
    ['painting the night sky', () => {
      textures.stars = makeStarTexture({ w: 1536, h: 768, seed: SEED });
    }],
    ['assembling planet earth', () => {
      textures.earth = makeEarthTextures({ w: 768, h: 384, seed: SEED + 99 });
      textures.sunGlow = makeGlowSprite({ size: 256, power: 2.0 });
      textures.haloGlow = makeGlowSprite({ size: 256, power: 3.0 });
    }],
    ['carving the crater basin', () => {
      terrain = new Terrain({ seed: SEED });
    }],
    ['driving the lander', () => {
      textures.ring = makeRingGlow({ size: 256 });
      textures.paw = makePawPrint({ size: 128 });
      textures.dustHalo = makeDustHalo({ size: 128 });
      textures.flag = makeFlagTexture({ w: 256, h: 160 });
    }],
  ];

  for (let i = 0; i < steps.length; i++) {
    setProgress(0.1 + (i / steps.length) * 0.8, steps[i][0]);
    await nextFrame();
    steps[i][1]();
  }

  /* ── scene ───────────────────────────────────────────────── */
  setProgress(0.92, 'building the scene…');
  await nextFrame();

  scene = new Scene();
  scene.background = null;

  camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.08, 9000);
  camera.position.set(6, 4, 10);

  sky = new Sky({
    stars: textures.stars,
    earth: textures.earth,
    sunGlow: textures.sunGlow,
    haloGlow: textures.haloGlow,
  });
  scene.add(sky.group);

  terrainMesh = terrain.buildMesh(regolith);
  scene.add(terrainMesh);
  farGround = terrain.buildFarGround(regolith);
  scene.add(farGround);

  trail = new FootprintTrail({ max: 420, pawTexture: textures.paw, dustTexture: textures.dustHalo });
  scene.add(trail.group);

  /* ── entities ────────────────────────────────────────────── */
  bunny = new Bunny({
    furNormal: textures.furNormal,
    furTint: textures.furTint,
    scuffRoughness: textures.scuff,
  });
  scene.add(bunny.group);

  lander = buildLander(terrain, { foilNormal: textures.foil, scuffRoughness: textures.scuff });
  scene.add(lander);
  scene.add(buildPadMarking(terrain, textures.ring));

  flag = new Flag(terrain, { x: 6.4, z: 5.2 }, { flagTexture: textures.flag });
  scene.add(flag.group);

  crystals = new CrystalField(terrain, { glowTexture: textures.sunGlow, seed: SEED + 5 });
  scene.add(crystals.group);

  rockField = new RockField(terrain, { regolith, count: 26, seed: SEED + 8 });
  scene.add(rockField.mesh);

  // Pads: one on the basin floor, one in a crater, one part-way up the wall,
  // so each one rewards a different approach. ~5.6-6.2 m/s is a 10-12 m
  // launch in lunar gravity — dramatic, and short of the 27 m crater wall.
  pads = [
    new BouncePad(terrain, { x: -14, z: 9 }, { ringTexture: textures.ring, power: 5.6 }),
    new BouncePad(terrain, { x: 25, z: -22 }, { ringTexture: textures.ring, power: 6.2 }),
    new BouncePad(terrain, { x: -34, z: -31 }, { ringTexture: textures.ring, power: 5.9 }),
  ];
  for (const p of pads) scene.add(p.group);

  dust = new DustSpray({ max: 260, gravity: GRAVITY });
  scene.add(dust.mesh);
  sparkles = new Sparkles({ max: 180, glowTexture: textures.sunGlow });
  scene.add(sparkles.mesh);

  /* ── game systems ────────────────────────────────────────── */
  audio = new GameAudio();
  input = new Input(dom.canvas);
  rig = new CameraRig(camera, terrain);

  controller = new BunnyController({
    terrain,
    bunny,
    trail,
    pads,
    dust,
    audio,
    on: {
      land: (strength) => {
        rig.shake(strength * 0.85);
        flashVignette(strength * 0.5);
      },
      bounce: (pad) => {
        rig.shake(0.5);
        sparkles.burst(pad.position, {
          count: 22, speed: 3.4, size: 0.3, life: 0.7, color: 0x7fe8ff,
        });
        toast('bounce pad', 'gold');
      },
      airJump: () => toast('lunar hop'),
    },
  });
  controller.respawn();

  /* ── HUD ─────────────────────────────────────────────────── */
  dom.crystalTotal.textContent = String(crystals.total);
  dom.crystalPips.innerHTML = '';
  for (let i = 0; i < crystals.total; i++) {
    dom.crystalPips.appendChild(document.createElement('i'));
  }

  /* ── post chain ──────────────────────────────────────────── */
  const useBloom = flagOn('bloom', true);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  bloomPass = bloom(sceneColor, BLOOM_DEFAULT.strength, BLOOM_DEFAULT.radius, BLOOM_DEFAULT.threshold);
  pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = useBloom
    ? sceneColor.add(bloomPass)
    : sceneColor;
  bloomPass.strength.value = useBloom ? BLOOM_DEFAULT.strength : 0;
  state.bloomOn = useBloom;

  window.addEventListener('resize', onResize);
  dom.startBtn.addEventListener('click', onStart);

  /* ── loop ────────────────────────────────────────────────── */
  setProgress(1, 'ready');
  dom.loader.classList.add('done');
  dom.startBtn.hidden = false;

  state.running = true;
  renderer.setAnimationLoop(frame);

  // Title-screen camera: a slow orbit of the lander behind the menu.
  titleOrbit = { angle: 0.6, height: 3.4, dist: 13 };

  installProbe();
  return { backendName, isWebGPU };
}

let titleOrbit = null;

/* ── HUD helpers ──────────────────────────────────────────── */

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  dom.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 500);
  }, 2100);
  // Never let toasts stack past the panel.
  while (dom.toasts.children.length > 4) dom.toasts.firstChild.remove();
}

let bannerTimer = 0;
function banner(text, seconds = 4) {
  dom.centerToast.textContent = text;
  dom.centerToast.classList.add('show');
  bannerTimer = seconds;
}

let vignetteT = 0;
function flashVignette(amount) {
  vignetteT = Math.max(vignetteT, amount);
}

/* ── interactions ─────────────────────────────────────────── */

function onStart() {
  if (state.started) return;
  state.started = true;
  audio.start();
  dom.overlay.classList.add('gone');
  dom.hud.hidden = false;
  setTimeout(() => { dom.overlay.style.display = 'none'; }, 800);
  toast('collect the crystals');
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  pipeline?.setSize?.(w, h);
}

function handleActions(dt) {
  if (!state.started) return;

  // Camera mode
  if (input.consumePress('KeyC')) {
    const mode = rig.toggle();
    bunny.group.visible = mode !== 'first';
    dom.reticle.hidden = mode !== 'first';
    toast(mode === 'first' ? 'first person' : 'third person');
  }
  // Emote
  if (input.consumePress('KeyQ')) {
    bunny.emote('wiggle');
    audio.emote();
    toast('lunar wiggle');
  }
  // Respawn
  if (input.consumePress('KeyR')) {
    controller.respawn();
    toast('back to the lander');
  }
  // Bloom
  if (input.consumePress('KeyG')) {
    state.bloomOn = !state.bloomOn;
    bloomPass.strength.value = state.bloomOn ? BLOOM_DEFAULT.strength : 0;
    toast(state.bloomOn ? 'bloom on' : 'bloom off');
  }
  // Mute
  if (input.consumePress('KeyM')) {
    state.muted = audio.toggleMute();
    toast(state.muted ? 'muted' : 'sound on');
  }

  // Plant the flag
  if (input.consumePress('KeyE') && !flag.planted) {
    const d = Math.hypot(
      controller.position.x - flag.group.position.x,
      controller.position.z - flag.group.position.z,
    );
    if (d < 4.0) {
      plantFlag();
    } else {
      toast('get closer to the flag');
    }
  }
}

function plantFlag() {
  if (!flag.plant()) return;
  audio.plant();
  bunny.emote('salute', 1.4);
  sparkles.burst(
    _tmpVec.set(flag.group.position.x, flag.group.position.y + 2.2, flag.group.position.z),
    { count: 26, speed: 2.2, size: 0.3, life: 1.2, color: 0xffd9a0 },
  );
  if (crystals.remaining === 0) {
    finishMission();
  } else {
    toast(`flag planted · ${crystals.remaining} crystals left`, 'gold');
    updateObjective();
  }
}

function updateObjective() {
  if (state.complete) {
    dom.objective.textContent = 'Mission complete. Go for a walk.';
  } else if (flag.planted) {
    dom.objective.textContent = `Flag planted. ${crystals.remaining} crystals still out there.`;
  } else if (crystals.remaining === 0) {
    dom.objective.textContent = 'All crystals found — press E at the flag.';
  } else {
    dom.objective.textContent = `Collect every crystal (${crystals.remaining} left), then plant the flag.`;
  }
}

function finishMission() {
  if (state.complete) return;
  state.complete = true;
  audio.complete();
  banner('mission complete', 6);
  bannerTimer = 6;
  updateObjective();
}

/* ── frame ────────────────────────────────────────────────── */

const _tmpVec = new Vector3();
const _bunnyPos = new Vector3();
const _camDir = new Vector3();
let lastTime = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;

function frame() {
  const now = performance.now();
  // Clamp dt so a stalled tab does not teleport the bunny through the floor.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    state.fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  simulate(dt);
  pipeline.render();
}

/**
 * One simulation step. Split out from the render loop so the headless checks
 * can advance gameplay by thousands of steps without waiting on the
 * rasteriser — software WebGL needs seconds per frame, which is useless for
 * verifying a jump arc or a walk cycle.
 */
function simulate(dt) {
  state.elapsed += dt;
  state.frame++;

  if (state.started) {
    state.missionTime += dt;
    rig.applyInput(input);
    handleActions(dt);
    controller.update(dt, input, state.elapsed);

    crystals.update(dt, state.elapsed, _bunnyPos.copy(controller.position).setY(controller.position.y + 0.5), (pos) => {
      audio.collect(crystals.collected);
      sparkles.burst(pos, { count: 20, speed: 2.6, size: 0.3, life: 0.8, color: 0x8ff0ff });
      dust.burst(pos, { count: 6, speed: 1.2, size: 0.02, life: 0.6, up: 0.3 });
      dom.crystalCount.textContent = String(crystals.collected);
      const pips = dom.crystalPips.children;
      if (pips[crystals.collected - 1]) pips[crystals.collected - 1].classList.add('on');
      if (crystals.remaining === 0) {
        toast('all crystals found', 'gold');
        if (flag.planted) finishMission();
        else toast('plant the flag to finish');
      }
      updateObjective();
    });

    rockField.update(dt, GRAVITY, controller.position, controller.velocity);
    flag.update(dt, state.elapsed);
    sky.update(dt, state.elapsed, controller.position);
    dust.update(dt);
    sparkles.update(dt, camera);

    // The look-at target: the nearest crystal, or straight ahead when the
    // mission is done and there is nothing left to want.
    const near = crystals.nearest(controller.position);
    if (near && near.distance > 3.5) {
      bunny.setLookTarget(near.item.group.position);
    } else if (!state.complete) {
      bunny.setLookTarget(near ? near.item.group.position : null);
    } else {
      bunny.setLookTarget(null);
    }

    rig.update(dt, controller.position, bunny.height, controller.eyePosition, controller.yaw);
    updateHud(near, dt);
  } else {
    // Slow cinematic orbit of the lander behind the title card.
    titleOrbit.angle += dt * 0.075;
    const a = titleOrbit.angle;
    const cx = Math.cos(a) * titleOrbit.dist;
    const cz = Math.sin(a) * titleOrbit.dist;
    camera.position.set(cx, terrain.heightAt(0, 0) + titleOrbit.height, cz);
    camera.lookAt(0, terrain.heightAt(0, 0) + 1.5, 0);
    sky.update(dt, state.elapsed, camera.position);
    flag.update(dt, state.elapsed);
    dust.update(dt);
  }

  sky.follow(state.started ? controller.position : camera.position);

  // Vignette decay
  if (vignetteT > 0) {
    vignetteT = Math.max(0, vignetteT - dt * 1.6);
    dom.vignette.style.opacity = String(vignetteT * 0.8);
  }
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    if (bannerTimer <= 0) dom.centerToast.classList.remove('show');
  }

  // Beacon blink on the lander.
  if (lander) {
    const b = 0.5 + 0.5 * Math.sin(state.elapsed * 3.4);
    lander.userData.beaconMat.emissiveIntensity = 0.6 + b * 4.5;
  }

  input.endFrame();
}

function updateHud(near, dt) {
  // Text updates every few frames: the DOM does not need 60 Hz.
  if (state.frame % 5 !== 0) return;

  dom.fps.textContent = String(Math.round(state.fps));
  dom.altitude.textContent = (controller.position.y - terrain.heightAt(controller.position.x, controller.position.z)).toFixed(1);
  dom.speed.textContent = controller.speed.toFixed(1);

  const secs = Math.floor(state.missionTime);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  dom.clock.textContent = `${mm}:${ss}`;

  if (near) {
    const dist = Math.hypot(
      near.item.group.position.x - controller.position.x,
      near.item.group.position.z - controller.position.z,
    );
    dom.compassDist.textContent = `${dist.toFixed(0)} m`;
    // Bearing of the crystal relative to where the camera is looking.
    const bearing = Math.atan2(
      near.item.group.position.x - controller.position.x,
      near.item.group.position.z - controller.position.z,
    );
    const viewYaw = rig.mode === 'first'
      ? rig.yaw + controller.yaw
      : rig.yaw + Math.PI;
    dom.compassNeedle.setAttribute(
      'transform',
      `rotate(${(-(bearing - viewYaw) * 180) / Math.PI} 20 20)`,
    );
  } else {
    dom.compassDist.textContent = '—';
    dom.compassNeedle.setAttribute('transform', 'rotate(0 20 20)');
  }

  // Nudge the player toward the flag once the crystals are gone.
  if (!flag.planted && crystals.remaining === 0) {
    const d = Math.hypot(
      controller.position.x - flag.group.position.x,
      controller.position.z - flag.group.position.z,
    );
    if (d < 4.0) dom.objective.textContent = 'Press E to plant the flag.';
  }
}

/* ── inspection handle (used by the headless render checks) ─ */

function installProbe() {
  const held = new Set();
  const synthetic = new Set();
  // Release after a number of *simulated* frames, not wall-clock time: the
  // checks step the simulation synchronously, so a setTimeout would never
  // fire mid-run and a tapped key would stay held for the whole arc.
  const releaseAfter = new Map();
  const press = (code, holdFrames = 4) => {
    held.add(code);
    synthetic.add(code);
    input.pressed.add(code);
    releaseAfter.set(code, holdFrames);
  };
  const hold = (code, on) => {
    if (on) { held.add(code); synthetic.add(code); releaseAfter.delete(code); input.keys.add(code); }
    else { held.delete(code); input.keys.delete(code); }
  };
  const origEnd = input.endFrame.bind(input);
  input.endFrame = () => {
    for (const [code, n] of releaseAfter) {
      if (n <= 1) { held.delete(code); releaseAfter.delete(code); }
      else releaseAfter.set(code, n - 1);
    }
    for (const c of synthetic) {
      if (held.has(c)) input.keys.add(c);
      else input.keys.delete(c);
    }
    origEnd();
  };

  window.APP = {
    get ready() { return state.running; },
    get started() { return state.started; },
    start: onStart,
    press,
    hold,
    /**
     * Advance the simulation without rendering. Lets the checks exercise a
     * five-second jump arc in a few milliseconds instead of waiting on the
     * software rasteriser.
     */
    step: (seconds = 1, dtStep = 1 / 60) => {
      const n = Math.max(1, Math.round(seconds / dtStep));
      for (let i = 0; i < n; i++) simulate(dtStep);
      return state.frame;
    },
    look: (dx, dy) => { input.orbitDX += dx; input.orbitDY += dy; },
    zoom: (d) => { input.zoomDelta += d; },
    teleport: (x, z, y = null) => {
      controller.position.x = x;
      controller.position.z = z;
      controller.position.y = y ?? terrain.heightAt(x, z);
      controller.velocity.set(0, 0, 0);
      controller.applyTransform();
    },
    teleportToCrystal: (i = 0) => {
      const it = crystals.items.filter((c) => !c.taken)[i];
      if (!it) return null;
      controller.position.set(it.x + 0.4, terrain.heightAt(it.x, it.z), it.z + 0.4);
      controller.velocity.set(0, 0, 0);
      controller.applyTransform();
      return [it.x, it.z];
    },
    teleportToPad: (i = 0) => {
      const p = pads[i];
      if (!p) return null;
      controller.position.set(p.position.x, p.position.y, p.position.z);
      controller.velocity.set(0, 0, 0);
      controller.applyTransform();
      return [p.position.x, p.position.z];
    },
    teleportToFlag: (d = 2.0) => {
      const f = flag.group.position;
      controller.position.set(f.x + d, terrain.heightAt(f.x + d, f.z), f.z);
      controller.velocity.set(0, 0, 0);
      controller.applyTransform();
    },
    setCamera: (yaw, pitch, dist) => {
      rig.yaw = yaw;
      rig.pitch = pitch;
      if (dist !== undefined) rig.wantDistance = rig.distance = dist;
    },
    lookAt: (x, y, z) => {
      const dx = x - camera.position.x;
      const dz = z - camera.position.z;
      rig.yaw = Math.atan2(dx, dz) + Math.PI;
      rig.pitch = Math.atan2(y - camera.position.y, Math.hypot(dx, dz));
    },
    collectAll: () => {
      for (const it of crystals.items) {
        if (!it.taken) { it.taken = true; it.group.visible = false; crystals.collected++; }
      }
      dom.crystalCount.textContent = String(crystals.collected);
      for (const p of dom.crystalPips.children) p.classList.add('on');
      toast('all crystals found', 'gold');
      // Take the same path the real pickup takes, so the mission-complete
      // check cannot be skipped by using this helper.
      if (crystals.remaining === 0 && flag.planted) finishMission();
      else if (crystals.remaining === 0) toast('plant the flag to finish');
      updateObjective();
    },
    /** Scene-graph census — a renderer-independent "is anything there". */
    sceneStats: () => {
      let meshes = 0;
      let instanced = 0;
      let triangles = 0;
      let visible = 0;
      let lights = 0;
      scene.traverse((o) => {
        if (o.isLight) lights++;
        if (!o.isMesh && !o.isInstancedMesh && !o.isSprite) return;
        if (o.visible) visible++;
        if (o.isInstancedMesh) {
          instanced++;
          const g = o.geometry;
          const per = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
          triangles += per * o.count;
        } else {
          meshes++;
          const g = o.geometry;
          if (g && g.index) triangles += g.index.count / 3;
          else if (g && g.attributes.position) triangles += g.attributes.position.count / 3;
        }
      });
      return { meshes, instanced, sprites: 0, visible, triangles: Math.round(triangles), lights };
    },
    renderOnce: () => { pipeline.render(); return renderer.info?.render?.drawCalls ?? null; },
    setBloom: (v) => { bloomPass.strength.value = v; return v; },
    setShadows: (on) => {
      renderer.shadowMap.enabled = on;
      // Materials must recompile when the shadow define changes.
      scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
      return on;
    },
    /** Force the bunny's facing, for framing a portrait. */
    setYaw: (y) => { controller.yaw = y; return y; },
    /** Read the real sun heading so camera setups can aim the key light. */
    sunAzimuth: () => {
      const d = sky.sunDir;
      return +(Math.atan2(d.x, d.z) * 180 / Math.PI).toFixed(1);
    },
    /** Hide a named subsystem so a visual artefact can be attributed. */
    setVisible: (what, on) => {
      let n = 0;
      const apply = (obj) => { if (obj) { obj.visible = on; n++; } };
      switch (what) {
        case 'dust': apply(dust?.mesh); break;
        case 'sparkles': apply(sparkles?.mesh); break;
        case 'prints': apply(footprintTrail?.prints); apply(footprintTrail?.cavity); break;
        case 'crystals': for (const it of crystals.items) apply(it.group); break;
        case 'halos': for (const it of crystals.items) apply(it.halo); break;
        case 'rocks': apply(rockField?.mesh); break;
        case 'lander': apply(lander); break;
        case 'flag': apply(flag?.group); break;
        case 'pads': for (const p of pads) apply(p.group); break;
        case 'far': apply(farGround); break;
        case 'terrain': apply(terrainMesh); break;
        case 'stars': apply(sky?.stars); apply(sky?.earth); apply(sky?.sunSprite); break;
        case 'vignette': dom.vignette.style.display = on ? '' : 'none'; return 'dom';
        default: return 'unknown:' + what;
      }
      return n;
    },
    probe: () => {
      const ground = terrain.heightAt(controller.position.x, controller.position.z);
      const foot = controller.bunny.footWorld(0, _tmpVec);
      return {
        backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl',
        started: state.started,
        elapsed: +state.elapsed.toFixed(2),
        missionTime: +state.missionTime.toFixed(2),
        fps: +state.fps.toFixed(1),
        drawCalls: renderer.info?.render?.drawCalls ?? null,
        triangles: renderer.info?.render?.triangles ?? null,
        bunny: {
          position: controller.position.toArray().map((n) => +n.toFixed(2)),
          ground: +ground.toFixed(2),
          // Distance from the sole of the front-left foot to the regolith:
          // ~0 when planted, positive mid-hop.
          soleClearance: +(foot.y - ground - bunny.soleDrop).toFixed(3),
          speed: +controller.speed.toFixed(2),
          vy: +controller.velocity.y.toFixed(2),
          grounded: controller.grounded,
          yaw: +controller.yaw.toFixed(2),
          visible: bunny.group.visible,
          spinT: +controller.spinT.toFixed(2),
        },
        camera: {
          mode: rig.mode,
          position: camera.position.toArray().map((n) => +n.toFixed(2)),
          fov: +camera.fov.toFixed(1),
        },
        crystals: { collected: crystals.collected, total: crystals.total },
        flag: { planted: flag.planted, unfurl: +flag.plantT.toFixed(2) },
        pads: pads.map((p) => ({ at: p.position.toArray().map((n) => +n.toFixed(1)), power: p.power })),
        printsLaid: trail.next,
        dustAlive: dust.p.filter((p) => p.life > 0).length,
        complete: state.complete,
        hud: {
          crystals: dom.crystalCount.textContent,
          fps: dom.fps.textContent,
          altitude: dom.altitude.textContent,
          objective: dom.objective.textContent,
        },
      };
    },
  };
}

/* ── go ───────────────────────────────────────────────────── */

boot().catch(fatal);
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));
