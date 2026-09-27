// Curated copy for the projects dashboard.
//
// Descriptions are written, not scraped: an auto-extracted sentence makes a
// fine tool and a poor portfolio. build-project-data.mjs reads this file and
// falls back to the project's own <title> when a slug is missing here, so a
// new project still shows up before it has copy.
window.PROJECT_COPY = {
  'volumetric-clouds': 'Raymarched volumetric clouds: a 3D density field from domain-warped FBM, lit with Beer–Lambert transmittance and a powder term for the dark edges.',
  'sdf-explorer': 'Compose organic merged forms from SDF primitives. Add, move, and blend spheres, boxes, tori and capsules with smooth-min, over a soft-shadowed ground plane.',
  'caustics-pool': 'The bright web of light that refracted water casts on a pool floor, from analytic Gerstner-wave normals through Snell refraction to focused irradiance.',
  'dispersion-glass': 'A refractive glass solid traced three times at a slightly different index per colour channel, so dispersion and coloured fringes are physically real.',
  'mandelbulb': 'The Mandelbulb by distance estimation, with orbit-trap colouring that turns the fractal into structured bands rather than a flat blob.',
  'menger-sponge': 'A Menger sponge raymarched with correct distance bounds, so the recursion resolves cleanly instead of the march overshooting through it.',
  'exoplanet': 'A procedural planet from a seed: FBM terrain, biome colour by elevation and latitude, an animated cloud shell, a Fresnel atmosphere, and a real terminator.',
  'nebula': 'Layered FBM bands in a deep palette, a bright core, parallax star fields, and god rays raking from an off-screen star.',

  'nbody-orbits': 'The same star system under forward Euler, velocity Verlet and RK4, with a live energy-drift plot showing which integrator is lying to you.',
  'cloth-simulation': 'A mass-spring cloth pinned at the corners, grabbable with the mouse, that frays progressively as springs exceed their strain limit.',
  'rigidbody-2d': 'An impulse-based 2D physics engine: SAT collision, rotation, friction and restitution, rendered as lit solid shapes rather than wireframes.',
  'double-pendulum': 'A double pendulum with a fading trail, beside a live plot of successive angle pairs so the strange attractor becomes visible.',
  'sandpile': 'The Bak–Tang–Wiesenfeld sandpile. Grains accumulate, overloaded cells topple, and branching avalanches spread outward like lightning.',
  'cellular-automata': 'A rule bench for Conway’s Life, Langton’s ant and Brian’s Brain, plus a free B/S rule string, drawn as crisp blocks.',
  'cpu-fluid': 'An incompressible fluid solver in plain JavaScript on a 2D canvas — advect, add forces, solve pressure, subtract gradient. No GPU at all.',
  'spring-lattice': 'A 3D structural lattice under load, deforming in real time, with every spring coloured by whether it is stretched or compressed.',

  'lsystem-flora': '3D L-system turtle grammar growing branching plants, rendered as tapered shaded tubes — trees, ferns and flowers from one algorithm.',
  'marching-cubes': 'The real marching cubes algorithm over an animated scalar field, extracting a lit isosurface mesh every frame with flat shading.',
  'poisson-disc': 'Three sampling strategies side by side — uniform random, jittered lattice, and Poisson-disc — with a nearest-neighbour metric proving which clumps.',
  'chaos-game-ifs': 'The chaos game for Sierpinski, Koch, Barnsley fern and the dragon curve, density-accumulated so the attractor resolves.',
  'fractal-flames': 'The fractal flame algorithm: affine transforms with colour, a density histogram, and a gamma-correct display.',
  'ising-model': 'The 2D Ising model under Metropolis Monte Carlo, plotting magnetisation against temperature so the phase transition becomes visible.',
  'diffusion-limited': 'Random walkers that stick where they touch, growing branching dendritic structures — the same physics as coral and frost.',
  'quadtree-fractal': 'A square subdividing into four wherever seeded noise crosses a threshold, growing level by level.',
  'wang-tiles': 'A procedural tileset with coloured edge sockets, filled by a constraint solver so the result is seamless by construction.',
  'parametric-surfaces': 'Klein bottle, Enneper surface, Möbius strip and trefoil knot, tessellated and lit as rotating 3D meshes.',

  'sdf-2d': 'Compose 2D distance primitives with union, intersection, subtraction and smooth-min, anti-aliased exactly from the distance value.',
  'boolean-sdf-2d': 'Two moving shapes and a boolean operation between them, so you can watch a hole open and close in real time.',
  'collatz': 'Collatz trajectories as time-series plots, with many starts coloured by fate so the basins of attraction become visible.',
  'fourier-drawing': 'A discrete Fourier transform keeping only the lowest coefficients — and the image still reads as the original.',
  'harmonograph': 'Two orthogonal damped pendulums at related frequencies, traced as a fading path into intricate plotted figures.',
  'color-theory': 'An OKLab/OKLCH colour wheel with analogous, complementary and triadic harmony built in a perceptual space, plus real contrast ratios.',
  'phase-portrait': 'Lorenz, van der Pol, Hénon, Clifford and the logistic bifurcation, each traced as a live fading phase portrait.',
  'curve-fitting': 'Least-squares fits for linear, quadratic, exponential and sine models, with a residual plot and R² beneath each.',

  'spectrogram': 'A scrolling log-frequency spectrogram waterfall from a real FFT, fed a deterministic synthesised signal so it renders identically offline.',
  'dsp-filters': 'Biquad and comb filters implemented for real, with their magnitude response and the before/after spectrum of a test signal.',
  'wave-interference': 'Plane and point sources summed into a live field, where interference fringes, nodes and antinodes are plainly visible.',
  'synth-lab': 'A subtractive synthesis chain — oscillator, ADSR, resonant filter, output — with the live waveform, spectrum and signal path.',

  'bezier-editor': 'A cubic Bézier shape editor: drag the four control points, watch the control polygon, fill the result as a real shape.',
  'type-specimen': 'A typography specimen built only from system font stacks — display scale, rhythm, reading measure, and a letterform row.',
  'generative-poster': 'A parameterised poster system with real compositional rules: alignment, a clear focal point, negative space, restrained palette.',
  'wave-function-collapse': 'A true WFC solver: lowest-entropy selection, arc-consistency propagation, contradiction backtracking, restart on failure.',
  'tilemap-generator': 'A top-down tilemap from value noise and cellular smoothing, drawn with 47-tile autotiling so every edge blends correctly.',
  'pixel-painter': 'A small indexed-colour pixel editor: limited palette, pencil and fill, nearest-neighbour zoom, on a generated starting image.',
  'sdf-text': 'Text rendered from a signed distance field, so it stays crisp at any scale, with the underlying field visible underneath.',

  'cpu-raytracer': 'A progressive raytracer written in JavaScript and running in Web Workers. No GPU involved — just spheres, shadows and reflections.',
  'model-viewer': 'A 3D model generated entirely in code, presented like a product render: studio lighting, turntable, soft ground shadow, PBR shading.',
  'procedural-city': 'A generated city from a road grid with variation, blocks subdivided into lots, and a taller downtown falling away to suburbs.',
  'boolean-3d-csg': 'Constructive solid geometry in 3D — union, intersection and difference on signed distance fields, with the operands in motion.',
  'shader-lab': 'A live fragment-shader editor with presets, uniform sliders, and compile errors shown instead of failing silently.',
};
