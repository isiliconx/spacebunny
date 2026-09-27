#!/usr/bin/env node
/* Capture a full-page screenshot over CDP, or report the page's own height.
 *
 * render.mjs sizes the viewport explicitly, which is right for demos but wrong
 * for the dashboard: the page is thousands of pixels tall, and clipping the
 * capture to an arbitrary height silently hides whatever is below the fold.
 * Asking the page how tall it is first is the honest way to know whether the
 * last capture actually reached the bottom.
 *
 *   node capture-full.mjs <url> <out.png> [--w 1400] [--ready "<expr>"] [--dry]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out] = process.argv.slice(2);
if (!url) {
  console.error('usage: node capture-full.mjs <url> <out.png> [--w N] [--dry]');
  process.exit(2);
}
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i === -1 ? d : process.argv[i + 1];
};
const W = Number(arg('w', 1400));
const ready = arg('ready', 'true');
const dry = process.argv.includes('--dry');

const profile = mkdtempSync(join(tmpdir(), 'cap-'));
const PORT = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--disable-dev-shm-usage',
  `--window-size=${W},1200`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome did not expose a debugging target');
}

let ws;
try {
  const wsUrl = await cdpTargets();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) {
      events.push(m);
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: 1200, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url });

  const deadline = Date.now() + 120000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(400);
    const r = await send('Runtime.evaluate', {
      expression: ready, returnByValue: true,
    });
    const v = r.result?.result?.value;
    if (v === true) { ok = true; break; }
  }
  if (!ok) {
    console.error('never became ready: ' + ready);
    process.exit(1);
  }
  await sleep(1200);

  const hRes = await send('Runtime.evaluate', {
    expression: 'Math.ceil(document.documentElement.scrollHeight)', returnByValue: true,
  });
  const fullH = Math.min(hRes.result?.result?.value ?? 1200, 20000);
  console.log('page height ' + fullH + 'px at width ' + W);

  if (dry) process.exit(0);

  // Cap the raster: a 14,000px screenshot is ~78 MP and Chrome will refuse or
  // die. Capture in vertical slices instead and stitch.
  const SLICE = 2400;
  const slices = Math.ceil(fullH / SLICE);
  const parts = [];
  for (let i = 0; i < slices; i++) {
    const y = i * SLICE;
    const h = Math.min(SLICE, fullH - y);
    await send('Emulation.setDeviceMetricsOverride', {
      width: W, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await send('Runtime.evaluate', {
      expression: `window.scrollTo(0, ${y}); void 0`, returnByValue: true,
    });
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) {
      console.error('slice ' + i + ' failed');
      process.exit(1);
    }
    const p = join(profile, `slice-${i}.png`);
    writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    parts.push(p);
    console.log('  slice ' + (i + 1) + '/' + slices + '  ' + W + 'x' + h);
  }

  console.log('SLICES=' + parts.join(','));
  writeFileSync(join(profile, 'slices.txt'), parts.join('\n'));

  // Stitch here, while the slices still exist. Stitching in a separate step
  // means depending on the temp profile surviving, and the cleanup below
  // deletes it.
  const canvas = await send('Page.navigate', { url: 'about:blank' });
  void canvas;
  const { execFileSync } = await import('node:child_process');
  const tmpPy = join(profile, 'stitch.py');
  writeFileSync(tmpPy, `
from PIL import Image
import sys
fs = sys.argv[2:]
ims = [Image.open(f).convert("RGB") for f in fs]
W = max(i.width for i in ims); H = sum(i.height for i in ims)
out = Image.new("RGB", (W, H))
y = 0
for i in ims:
    out.paste(i, (0, y)); y += i.height
out.save(sys.argv[1])
print("stitched", out.size)
`);
  execFileSync('python3', [tmpPy, out, ...parts], { stdio: 'inherit' });
  console.log('wrote ' + out);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
