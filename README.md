# spacebunny

A space bunny exploring the Moon, rendered with three.js on the **WebGPU**
backend, plus eight GPU graphics demos collected in `demos/`.

**[Open the site](https://isiliconx.github.io/spacebunny/)**

---

## The demos

Eight self-contained WebGL2 pieces, each a single `index.html` with no CDN, no
build step, and no network access:

| Demo | What it does |
| --- | --- |
| `01-neon-plankton` | 73k GPU particles advected through a curl-noise field, additive sprites with HDR bloom |
| `02-raymarched-world` | SDF terrain eroded by 90k hydraulic droplets, raymarched with soft shadows and height fog |
| `03-gpu-fluid` | Navier–Stokes on ping-pong float textures: advect, curl, vorticity, divergence, 22 Jacobi iterations |
| `04-softbody-playground` | Verlet soft bodies with spring families, a signed-area volume constraint, and friction |
| `05-reaction-diffusion` | Gray–Scott Turing patterns integrated entirely in fragment shaders |
| `06-sonic-terrain` | A procedurally synthesised track driving a real FFT visualiser, with a deterministic fallback |
| `07-world-pulse` | Global air traffic over real coastlines — 67,663 routes, 5,247 airports, 780 aircraft in flight |
| `08-path-tracer` | Progressive GPU path tracing with NEE + MIS, lit by three procedurally ray-traced HDR environments |

Every demo exposes `window.__ready === true` once its scene is live, so a
headless harness can wait for a settled frame instead of guessing at a delay.

### Verifying them

`demos/tools/` holds the harness that was used to build and check them:

```bash
demos/tools/verify_all.sh      # render all 8, check health, promote previews
demos/tools/audit.mjs          # static check: no external refs, no Math.random in the render path
demos/tools/imginfo.py <png>   # colour count, clipping, blank/flat verdict
demos/tools/seams.py <png>     # detect tiled / repeating artifacts
```

`render.mjs` is a zero-dependency Chrome DevTools Protocol renderer. It replaced
a `--screenshot` invocation that fought a profile lock and left Chrome running;
consolidating the CDP event handling took a capture from 47 s to 2.1 s.

`demos/08-path-tracer/index.html` is generated rather than hand-written — it
embeds three HDR environments (~1.5 MB of float data). `template.html` is the
real source; rebuild with:

```bash
cd demos/tools
for e in studio sunset nightcity; do python3 bake_env.py $e; done
python3 build_pt.py
```

---

## The game

Walk, sprint, and jump around a procedurally generated lunar basin. Collect all
14 helium-3 crystals, then plant the mission flag. The world is built entirely
in code — no external models, textures, or audio files — and every asset ships
inside the repository.

## Play

[Play in the browser](https://isiliconx.github.io/spacebunny/lunar-hopper/)
([repo root](https://isiliconx.github.io/spacebunny/) is the demo dashboard)

Requires a browser with WebGPU (Chrome/Edge 113+, Safari 18+, or Firefox with
WebGPU enabled). If WebGPU is unavailable, three.js falls back to WebGL2
automatically and the game still runs — the telemetry panel shows which backend
is live.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Walk |
| `Shift` | Sprint |
| `Space` | Jump — tap again mid-air to hop again |
| `C` | Toggle first / third person |
| `E` | Plant the mission flag |
| `Q` | Lunar wiggle |
| `R` | Respawn at the lander |
| `G` | Toggle bloom |
| `M` | Mute |
| Drag | Orbit camera |
| Wheel | Zoom |

## Quality overrides

The game looks for URL parameters, which is handy on weak GPUs:

| Parameter | Effect |
| --- | --- |
| `?bloom=0` | Disable the bloom pass |
| `?shadow=0` | Disable shadow mapping |

## How it works

- **three.js r186**, vendored in `vendor/` so the site has no CDN dependency
  and works offline. The `three/webgpu`, `three/tsl`, and `three/addons/` import
  aliases resolve to these local files.
- **`src/main.js`** builds the scene, wires the systems together, and owns the
  render loop and post-processing pipeline.
- **`src/world/`** — shared analytic terrain. The elevation function used to
  build the mesh is the same one the physics samples, so the bunny never hovers
  above or sinks into the ground. Also the black sky, star field, Earth, sun,
  and the hard key plus fill lighting.
- **`src/entities/`** — the bunny rig is articulated primitives rather than a
  downloaded model, which keeps it light and fully animatable (locomotion,
  mid-air somersault, emotes). Also the crystals, bounce pads, kickable rocks,
  lander, flag, and particles.
- **`src/game/`** — controller with lunar gravity, orbit/first-person camera
  with terrain-aware collision, input, and a Web Audio synthesizer for every
  sound.

### Feel

Real lunar gravity is 1.62 m/s², which makes a naive jump feel like a bug. The
controller therefore uses asymmetric gravity: reduced while ascending for a
floaty rise, increased on the way down so the bunny still lands with authority.
Bounce pads and the mid-air somersault are tuned around that.

### Footprints

Prints are instanced decals rather than painted into a texture — a texture big
enough to resolve a 30 cm paw across 180 m of ground would need to be tens of
thousands of pixels square. The paw texture is built as an actual pit, with a
dark well, a sunlit lip, and an offset contact shadow, because a print that
merely matches the grey of the surrounding regolith is invisible at play
distance.

## Credits

Built with [three.js](https://threejs.org/). Everything is procedural — the
regolith, fur, stars, Earth, flag, and paw prints are all generated at runtime.
