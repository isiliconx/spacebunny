#!/usr/bin/env node
/* Exercise the dashboard's project filters over CDP.
 *
 * A filter bar that renders the right pills proves nothing: the counts can be
 * painted from the data while the click handler filters nothing, and the page
 * still looks correct in a screenshot. This clicks each pill and counts the
 * cards that survive, then checks the total against the data.
 *
 *   node check-filters.mjs <url>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8777/index.html';
const profile = mkdtempSync(join(tmpdir(), 'filt-'));
const PORT = 9200 + Math.floor(Math.random() * 300);
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--disable-dev-shm-usage',
  '--window-size=1400,1200', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('no debugging target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text ?? 'eval threw');
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params?.exceptionDetails?.text ?? 'exception');
    }
  });
  await send('Page.navigate', { url });

  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(400);
    if (await evalJs("document.querySelectorAll('#project-grid .card').length") === 50) {
      ready = true; break;
    }
  }
  if (!ready) { console.error('50 cards never rendered'); process.exit(1); }

  const pills = await evalJs(`
    Array.from(document.querySelectorAll('#project-filters button, .filters button'))
      .map((b, i) => ({ i, label: b.textContent.trim() }))
  `);
  console.log('filter pills: ' + pills.length);
  for (const p of pills) console.log('  [' + p.i + '] ' + p.label);

// Count cards the user can actually SEE, not elements in the DOM. The bug
// this caught was invisible to a DOM count: card.hidden was set correctly,
// but .card { display: flex } outranks the UA's [hidden] rule, so all 50 cards
// stayed on screen while the hash and the pill counts both looked right.
// offsetParent is null for display:none subtrees, which is what we need.
const VISIBLE = "Array.from(document.querySelectorAll('#project-grid .card'))" +
  ".filter(c => c.offsetParent !== null).length";

  const dataCount = await evalJs('window.PROJECTS.length');
  const allCards = await evalJs(VISIBLE);
  console.log(`\nwindow.PROJECTS = ${dataCount}, visible cards with ALL = ${allCards}`);
  if (dataCount !== allCards) {
    console.log('  MISMATCH: data and rendered grid disagree');
  }

  let bad = 0;
  for (const p of pills) {
    const before = await evalJs("location.hash");
    await evalJs(`document.querySelectorAll('#project-filters button, .filters button')[${p.i}].click()`);
    await sleep(450);
    const shown = await evalJs(VISIBLE);
    const label = p.label.replace(/\s+/g, ' ');
    // The pill's own trailing number is the expected count.
    const m = label.match(/(\d+)\s*$/);
    const claimed = m ? Number(m[1]) : null;
    const after = await evalJs("location.hash");
    const mismatch = claimed !== null && claimed !== shown;
    if (mismatch) bad++;
    console.log(`  ${label.padEnd(30)} -> ${String(shown).padStart(3)} visible` +
                `   hash ${before || '(none)'} -> ${after || '(none)'}` +
                (mismatch ? `   <-- MISMATCH, pill claims ${claimed}` : ''));
  }

  // Back to "all" so the page is left in a sane state.
  await evalJs(`document.querySelectorAll('#project-filters button, .filters button')[0].click()`);
  await sleep(300);
  const restored = await evalJs(VISIBLE);
  if (restored !== allCards) {
    console.log(`  <-- "all" did not restore: ${restored} visible, expected ${allCards}`);
    bad++;
  }

  if (errors.length) {
    console.log('\npage errors:');
    for (const e of errors) console.log('  ' + e);
  }
  console.log(bad === 0 && errors.length === 0
    ? '\nVERDICT: OK — every pill filters to its advertised count'
    : `\nVERDICT: BROKEN (${bad} count mismatches, ${errors.length} page errors)`);
  process.exit(bad === 0 && errors.length === 0 ? 0 : 1);
} catch (e) {
  console.error('failed: ' + e.message);
  process.exit(1);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
