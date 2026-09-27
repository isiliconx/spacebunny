#!/usr/bin/env node
/* capture-game.mjs — render Lunar Hopper and save a poster frame.
 *
 * The game gates on a Start button rather than a readiness flag, so this waits
 * for the button, clicks it, lets the world stream in, then hides the HUD
 * overlays so the result reads as a screenshot rather than a UI screenshot.
 *
 * Served over http:// rather than file:// because the game is ES modules, and
 * module imports are blocked by CORS on the file: scheme. The demos are fine
 * from disk (single inline scripts); this one is not.
 *
 *   python3 -m http.server 8777 --bind 127.0.0.1
 *   node capture-game.mjs [out.png] [baseUrl] */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = process.argv[2] || join(REPO, 'lunar-hopper', 'preview.png');
const BASE = (process.argv[3] || 'http://127.0.0.1:8777').replace(/\/$/, '');
const W = 1280, H = 800;

const tmp = mkdtempSync(join(tmpdir(), 'lunar-'));
const inject = `
  (async () => {
    const btn = document.getElementById('startBtn');
    const t0 = Date.now();
    // The button is revealed once the world is built.
    while (btn.hidden && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 120));
    if (btn.hidden) { console.log('GAMECAP start button never appeared'); return; }
    btn.click();
    await new Promise(r => setTimeout(r, 9000));   // let the scene stream in
    // Hide the HUD chrome so the poster is the world, not the interface.
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    await new Promise(r => setTimeout(r, 1200));
    console.log('GAMECAP ready');
  })();
`;
writeFileSync(join(tmp, 'hook.js'), inject);

let out = '';
try {
  out = spawnSync('node', [
    join(HERE, 'render.mjs'),
    BASE + '/lunar-hopper/',
    OUT, '--w', String(W), '--h', String(H),
    '--ready', 'false', '--wait', '40000', '--verbose',
    '--inject', join(tmp, 'hook.js'),
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 }).stdout || '';
} catch (e) {
  out = (e.stdout || '') + '\n' + (e.stderr || '');
}
rmSync(tmp, { recursive: true, force: true });

for (const line of out.split('\n')) {
  if (/GAMECAP|error|Error|warn/.test(line)) console.log(line.trim().slice(0, 400));
}
console.log(out.match(/^(OK|FAIL).*/m)?.[0] || 'no result line');
