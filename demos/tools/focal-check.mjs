// Probe: does the poster's hero actually sit where the "Focal point" label claims?
// Reads the live composition via window.__probe (focalMm is the hero's top-left
// in mm on the A2 sheet) and compares it against the option text in the sidebar.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
if (!url) { console.error('usage: focal-check.mjs <url>'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'foc-'));
const PORT = 9222 + Math.floor(Math.random() * 900);
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu-sandbox', '--window-size=1280,800',
  '--hide-scrollbars', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no devtools endpoint');
}

const ws = new WebSocket(await cdp());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
for (let i = 0; i < 200; i++) { if (events.some(e => e.method === 'Page.loadEventFired')) break; await sleep(100); }
await sleep(4000);

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

const out = await evalJs(`(async () => {
  // A2 sheet = 420 x 594 mm. Read hero centre as a fraction of the live area.
  const W = 420, H = 594, M = 18;
  const rows = [];
  const set = (id, v) => { const el = document.getElementById(id); el.value = v;
    el.dispatchEvent(new Event('change', {bubbles:true})); el.dispatchEvent(new Event('input', {bubbles:true})); };
  for (const opt of [0,1,2,3]) {
    set('iFocal', String(opt));
    await new Promise(r => setTimeout(r, 800));
    const pr = window.__probe || {};
    const f = pr.focalMm;
    rows.push({
      opt,
      label: document.getElementById('vFocal').textContent,
      typePos: pr.typePos,
      focalMm: f,
      // fraction of the live area, 0 = top/left edge
      cx: f ? +(((f[0]) - M) / (W - 2*M)).toFixed(3) : null,
      cy: f ? +(((f[1]) - M) / (H - 2*M)).toFixed(3) : null,
    });
  }
  return rows;
})()`);

console.log('opt  label                typePos  focalMm            cx     cy   (fraction of live area)');
for (const r of out) {
  console.log(
    String(r.opt).padEnd(4),
    String(r.label).padEnd(20),
    String(r.typePos).padEnd(8),
    JSON.stringify(r.focalMm).padEnd(18),
    String(r.cx).padEnd(5),
    r.cy
  );
}
ws.close();
chrome.kill('SIGKILL');
await sleep(300);
rmSync(profile, { recursive: true, force: true });
