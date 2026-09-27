#!/usr/bin/env node
// render.mjs — zero-dep CDP renderer.
//   node render.mjs <url> <out.png> [--w 1280] [--h 800] [--wait 5000]
//                   [--ready "js expr"] [--timeout 90] [--full]
// Waits for the page (or a --ready JS predicate), captures console+errors,
// screenshots, prints diagnostics, exits 0/1.
//
// Node 22+ has a global WebSocket, so this needs no dependencies.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { connect } from 'node:net';

const argv = process.argv.slice(2);
const url = argv[0];
const out = argv[1];
if (!url || !out) {
  console.error('usage: node render.mjs <url> <out.png> [--w N] [--h N] [--wait ms] [--ready "js"] [--timeout s] [--full]');
  process.exit(2);
}
const opt = { w: 1280, h: 800, wait: 5000, ready: null, timeout: 90, full: false, verbose: false, inject: null };
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--w') opt.w = +next();
  else if (a === '--h') opt.h = +next();
  else if (a === '--wait') opt.wait = +next();
  else if (a === '--ready') opt.ready = next();
  else if (a === '--timeout') opt.timeout = +next();
  else if (a === '--full') opt.full = true;
  else if (a === '--inject') opt.inject = next();
  else if (a === '--verbose' || a === '-v') opt.verbose = true;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- minimal WebSocket client (text frames only; CDP sends small text msgs) ----
class WS {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    this.sock = connect({ host: u.hostname, port: +u.port || 80 });
    this.key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');
    this.buf = Buffer.alloc(0);
    this.handlers = [];
    this.open = new Promise((res, rej) => {
      this.sock.once('error', rej);
      this.sock.once('connect', () => {
        this.sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let handshook = false;
      this.sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!handshook) {
          const i = this.buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          handshook = true;
          this.buf = this.buf.subarray(i + 4);
          res();
        }
        this.drain();
      });
    });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len);
      for (const h of this.handlers) { try { h(payload); } catch {} }
    }
  }
  onMessage(h) { this.handlers.push(h); }
  send(str) {
    const data = Buffer.from(str, 'utf8');
    const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
    const n = data.length;
    let head;
    if (n < 126) head = Buffer.from([0x81, 0x80 | n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
    const masked = Buffer.alloc(n);
    for (let i = 0; i < n; i++) masked[i] = data[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  close() { try { this.sock.destroy(); } catch {} }
}

// ---- launch chrome ----
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const PORT = 9000 + Math.floor(Math.random() * 900);
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-features=Translate,OptimizationHints,MediaRouter',
  '--no-pings', '--mute-audio', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb',
  '--disable-lcd-text', `--window-size=${opt.w},${opt.h}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); if (chromeErr.length > 20000) chromeErr = chromeErr.slice(-8000); });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// ---- wait for the browser's devtools endpoint ----
let wsBase = null;
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json();
    if (j.webSocketDebuggerUrl) { wsBase = j.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(150);
}
if (!wsBase) { console.error('FAIL: chrome devtools never came up\n' + chromeErr.slice(-1500)); cleanup(); process.exit(1); }

// ---- connect ----
const browser = new WS(wsBase);
await browser.open;
let msgId = 0;
const pending = new Map();
const events = [];
browser.onMessage((raw) => {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method) {
    for (const l of listeners) l(m);
  }
});
// single event bus: consumers register, nobody races to drain a shared queue
const listeners = [];
const onEvent = (fn) => { listeners.push(fn); };
const once = (method, sessionId) => new Promise((res) => {
  const fn = (e) => {
    if (e.method === method && (!sessionId || e.sessionId === sessionId)) {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
      res(e.params);
    }
  };
  onEvent(fn);
});
// long-lived collector: console + page errors, for the whole run
const console_ = [], errors = [];
onEvent((e) => {
  if (e.method === 'Runtime.consoleAPICalled') {
    const txt = (e.params.args || [])
      .map(a => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ');
    console_.push(`[${e.params.type}] ${txt}`);
  } else if (e.method === 'Log.entryAdded') {
    const l = e.params.entry;
    if (l.level === 'error') errors.push(`[${l.source}] ${l.text} ${l.url || ''}`);
  } else if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params.exceptionDetails;
    errors.push(`[exception] ${d.exception?.description || d.text}`);
  }
});
// Default CDP command budget. Page.captureScreenshot on a software rasterizer
// can legitimately take minutes when the page is hammering the CPU, so this is
// generous on purpose — the --ready deadline, not this, bounds the run.
const CDP_TIMEOUT = 420000;
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, CDP_TIMEOUT);
  browser.send(JSON.stringify({ id, method, params, sessionId }));
});

// ---- attach to a page target ----
const { targetInfos } = await send('Target.getTargets');
let target = targetInfos.find(t => t.type === 'page');
if (!target) { const c = await send('Target.createTarget', { url: 'about:blank' }); target = { targetId: c.targetId }; }
const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
try {
  await send('Emulation.setDeviceMetricsOverride',
    { width: opt.w, height: opt.h, deviceScaleFactor: 1, mobile: false }, sessionId);
} catch {}

// ---- navigate ----
const loadPromise = once('Page.loadEventFired', sessionId);
await send('Page.navigate', { url }, sessionId);
await Promise.race([loadPromise, sleep(45000)]);

// ---- optional pre-load script ----
// Apps that gate on a button rather than a readiness flag need something to
// drive them. --inject runs a script in the page before the wait begins, which
// lets a capture dismiss a "Start" overlay and let the world stream in first.
if (opt.inject) {
  try {
    const src = readFileSync(opt.inject, 'utf8');
    await send('Runtime.evaluate', { expression: src, awaitPromise: true, returnByValue: true }, sessionId);
  } catch (e) {
    console.error(`--inject failed: ${e.message}`);
  }
}

// ---- wait for a readiness predicate (or a fixed budget) ----
const deadline = Date.now() + opt.timeout * 1000;
let ready = false;
while (Date.now() < deadline) {
  if (opt.ready) {
    try {
      const r = await send('Runtime.evaluate',
        { expression: `(()=>{try{return !!(${opt.ready})}catch(e){return false}})()`, returnByValue: true }, sessionId);
      if (r.result?.value === true) { ready = true; break; }
    } catch {}
    await sleep(150);
  } else {
    await sleep(opt.wait);
    ready = true; break;
  }
}

// let animation/RAF advance a bit past the ready point
await sleep(350);

// ---- optional extra JS probe (e.g. stats) ----
let probe = null;
if (opt.ready) {
  try {
    const r = await send('Runtime.evaluate',
      { expression: `(()=>{try{return JSON.stringify(window.__probe||null)}catch(e){return 'null'}})()`, returnByValue: true }, sessionId);
    probe = r.result?.value ?? null;
  } catch {}
}

// ---- screenshot ----
let shot;
try {
  shot = await send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: !!opt.full, fromSurface: true }, sessionId);
} catch (e) { console.error('screenshot failed: ' + e.message); }

let status = 'FAIL';
if (shot?.data) {
  mkdirSync(dirname(out), { recursive: true });
  const buf = Buffer.from(shot.data, 'base64');
  writeFileSync(out, buf);
  status = `OK ${out} ${buf.length} bytes ${opt.w}x${opt.h}`;
}

console.log(status + (ready ? '' : ' [NOT-READY]'));
if (probe && probe !== 'null') console.log('probe: ' + probe);
const errTxt = [...new Set(errors)].filter(e => !/favicon|net::ERR_FILE_NOT_FOUND.*favicon/i.test(e));
if (errTxt.length) { console.log('--- page errors ---'); errTxt.slice(0, 12).forEach(e => console.log('  ' + e)); }
// Print console output. By default only error/warn lines (to keep a successful
// run quiet), but --verbose echoes everything — sweeps and probes use that to
// read structured payloads off the page.
const verbose = opt.verbose;
const allConsole = [...new Set(console_)];
const shown = verbose ? allConsole
  : allConsole.filter((c) => /error|warn|fail/i.test(c) && !/favicon/i.test(c));
if (shown.length) {
  console.log(verbose ? '--- console (all) ---' : '--- console ---');
  shown.forEach((c) => console.log('  ' + c));
}

browser.close(); cleanup();
process.exit(shot?.data && ready ? 0 : 1);
