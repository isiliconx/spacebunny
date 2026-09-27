#!/usr/bin/env node
/* build-project-data.mjs — generate js/projects-data.js for the site.
 *
 * Derives the dashboard metadata from what is actually on disk: the project
 * folder name, the <title> of each index.html, and a short description. Doing
 * it this way means the site can never list a project that is not committed, or
 * miss one that is.
 *
 * Categories are assigned by slug prefix so the site groups them sensibly
 * without every project having to hand-declare a category. */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const PROJ = join(ROOT, 'projects');

// Hand-written descriptions from js/project-copy.js. A scraped sentence makes
// a good debugging aid and a poor portfolio entry, so the copy is authored.
// The file is a plain JS object literal, so evaluate it rather than JSON.parse
// (it uses unquoted keys, and single-quoted strings with typographic dashes).
function loadCopy() {
  const f = join(ROOT, 'js', 'project-copy.js');
  if (!existsSync(f)) return {};
  const src = readFileSync(f, 'utf8');
  // Take the object literal assigned to PROJECT_COPY: from the first { after
  // the assignment through the matching close. Slicing to end-of-file would
  // swallow the trailing semicolon and any comment after it.
  const assign = src.indexOf('PROJECT_COPY');
  const start = src.indexOf('{', assign);
  if (assign < 0 || start < 0) return {};
  const end = src.lastIndexOf('}');
  if (end <= start) return {};
  const obj = Function(`"use strict"; return (${src.slice(start, end + 1)});`)();
  return obj && typeof obj === 'object' ? obj : {};
}
const COPY = loadCopy();

const GROUPS = [
  { key: 'volumetric', label: 'Volumetrics & SDF', test: /^(volumetric-clouds|sdf-explorer|caustics-pool|dispersion-glass|mandelbulb|menger-sponge|exoplanet|nebula)$/ },
  { key: 'physics',    label: 'Physics & Simulation', test: /^(nbody-orbits|cloth-simulation|rigidbody-2d|double-pendulum|sandpile|cellular-automata|cpu-fluid|spring-lattice)$/ },
  { key: 'generative', label: 'Generative Geometry', test: /^(lsystem-flora|marching-cubes|poisson-disc|chaos-game-ifs|fractal-flames|ising-model|diffusion-limited|quadtree-fractal|wang-tiles|parametric-surfaces)$/ },
  { key: 'field',      label: 'Field & Mathematics', test: /^(sdf-2d|boolean-sdf-2d|collatz|fourier-drawing|harmonograph|color-theory|phase-portrait|curve-fitting)$/ },
  { key: 'signal',     label: 'Audio & Signal', test: /^(spectrogram|dsp-filters|wave-interference|synth-lab)$/ },
  { key: 'tools',      label: 'Tools & Type', test: /^(bezier-editor|type-specimen|generative-poster|wave-function-collapse|tilemap-generator|pixel-painter|sdf-text)$/ },
  { key: 'rendering',  label: 'Rendering & 3D', test: /^(cpu-raytracer|model-viewer|procedural-city|boolean-3d-csg|shader-lab)$/ },
];

const groupFor = (slug) => GROUPS.find(g => g.test.test(slug))?.key || 'other';

function titleOf(html, slug) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return slug;
  return m[1].replace(/\s*[—–-]\s*(spacebunny|Lunar Hopper).*$/i, '').trim();
}

// A description. Preference order:
//   1. a <meta name="description"> the project already declares
//   2. the first substantive sentence of body prose, entity-decoded and
//      stripped of markup
//   3. a readable fallback derived from the slug
// A candidate must read as a sentence, not a heading or a control label —
// otherwise we fall through rather than shipping "bezier editor" as a blurb.
function descOf(html, slug) {
  const decode = (s) => s
    .replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

  const meta = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  if (meta && meta[1].trim().length > 50) return decode(meta[1]);

  const words = (t) => t.split(/\s+/).length;
  for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = decode(m[1].replace(/<[^>]+>/g, ' '));
    // A real description: long enough to explain, short enough to be a blurb,
    // and prose rather than a UI label or a control hint.
    if (t.length > 90 && t.length < 320 && words(t) > 12
        && !/^(controls?|keyboard|press |click |drag |use the )/i.test(t)
        && !/^(compile|compiling|converging)\b/i.test(t)) {
      return t;
    }
  }
  return titleOf(html, slug).replace(/[—–].*$/, '').trim() + ' — a self-contained WebGL demo.';
}

const projects = [];
for (const name of readdirSync(PROJ).sort()) {
  const dir = join(PROJ, name);
  if (!statSync(dir).isDirectory()) continue;
  const file = join(dir, 'index.html');
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  if (!existsSync(join(dir, 'preview.png'))) continue; // not shipped yet
  projects.push({
    slug: name,
    title: titleOf(html, name),
    desc: COPY[name] || descOf(html, name),
    group: groupFor(name),
    kb: Math.round(statSync(file).size / 1024),
  });
}

const out = `// Generated by demos/tools/build-project-data.mjs — do not edit by hand.
// Run \`node demos/tools/build-project-data.mjs\` after adding a project.
window.PROJECT_GROUPS = ${JSON.stringify(GROUPS.map(g => ({ key: g.key, label: g.label })), null, 2)};

window.PROJECTS = ${JSON.stringify(projects, null, 2)};
`;

writeFileSync(join(ROOT, 'js', 'projects-data.js'), out);
console.log(`wrote js/projects-data.js  (${projects.length} projects)`);
for (const p of projects) console.log(`  ${p.slug.padEnd(24)} ${String(p.kb).padStart(4)} KB  [${p.group}]`);
