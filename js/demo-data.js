/* Demo metadata for the dashboard.
   Kept as data rather than markup so the cards stay one source of truth and
   the grid can be re-ordered or filtered without touching the HTML. */
window.DEMOS = [
  {
    id: '01-neon-plankton',
    title: 'Neon Plankton',
    kicker: 'WebGL2 · GPU particles',
    desc: 'Seventy thousand bioluminescent plankton advected through a curl-noise field, drawn as additive point sprites with HDR bloom.',
    tags: ['particles', 'curl noise', 'bloom'],
    metrics: '73k particles · 1280×800',
  },
  {
    id: '02-raymarched-world',
    title: 'Raymarched World',
    kicker: 'SDF raymarching · erosion',
    desc: 'A fractal terrain eroded by ninety thousand hydraulic droplets, then raymarched as a Lipschitz-bounded signed distance field with soft shadows and height fog.',
    tags: ['raymarching', 'erosion', 'terrain'],
    metrics: '512² heightfield · 90k droplets',
  },
  {
    id: '03-gpu-fluid',
    title: 'GPU Fluid',
    kicker: 'WebGL2 · Navier–Stokes',
    desc: 'A real-time incompressible fluid solver on ping-pong float textures: advect, curl, vorticity confinement, divergence, twenty-two Jacobi pressure iterations, gradient subtract.',
    tags: ['fluid', 'advection', 'vorticity'],
    metrics: '22 Jacobi iterations · dye 448²',
  },
  {
    id: '04-softbody-playground',
    title: 'Soft-Body Playground',
    kicker: 'Verlet · constraint relaxation',
    desc: 'Eight squishy bodies simulated with substepped Verlet integration, four spring families, a signed-area volume constraint, and Coulomb friction. Grab and drag them.',
    tags: ['physics', 'soft body', 'interaction'],
    metrics: '0.008 px mean constraint residual',
  },
  {
    id: '05-reaction-diffusion',
    title: 'Reaction–Diffusion',
    kicker: 'Gray–Scott · GPGPU',
    desc: 'Turing patterns from a Gray–Scott system integrated entirely in fragment shaders. The chemical gradient falls out of the stencil for free, giving analytic normals for the relief shading.',
    tags: ['reaction diffusion', 'Turing', 'shaders'],
    metrics: '448×280 cells · 6 regimes',
  },
  {
    id: '06-sonic-terrain',
    title: 'Sonic Terrain',
    kicker: 'WebAudio · generative visuals',
    desc: 'A music visualiser driven by a procedurally synthesised track. Real FFT analysis when audio is live; a deterministic spectral model stands in so screenshots stay reproducible.',
    tags: ['audio', 'spectrum', 'generative'],
    metrics: '120 BPM · 96-band spectrum',
  },
  {
    id: '07-world-pulse',
    title: 'World Pulse',
    kicker: 'data visualisation · real data',
    desc: 'Global air traffic over a real coastline map, with great-circle arcs for actual airline routes and seven hundred eighty aircraft in flight. Hubs sized by real route degree.',
    tags: ['dataviz', 'maps', 'animation'],
    metrics: '67,663 routes · 5,247 airports',
  },
  {
    id: '08-path-tracer',
    title: 'Material Lab',
    kicker: 'WebGL2 · path tracing',
    desc: 'A progressive GPU path tracer with next-event estimation and multiple importance sampling, lit by three procedurally ray-traced HDR environments. Reflective metals on a glossy floor.',
    tags: ['path tracing', 'HDR', 'global illumination'],
    metrics: '512 spp · 5 bounces · NEE + MIS',
  },
];
