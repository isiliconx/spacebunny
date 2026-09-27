#!/usr/bin/env node
/* check-random.mjs — classify every Math.random() call in projects/.
 *
 * The contract allows Math.random() only inside a user-triggered handler
 * (a shuffle button), never in the render path. A count is not a verdict, so
 * this prints the actual surrounding line for each hit to judge by eye. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const PROJ = join(ROOT, 'projects');

// A call is "handler-safe" if the nearest enclosing named function on the way
// out is bound to a DOM event, or sits inside an addEventListener callback.
const HANDLER = /(addEventListener|onclick|oninput|onchange|onpointer|onkeydown|onmousedown|onmouseup)\b/i;

let total = 0, flagged = 0;

for (const name of readdirSync(PROJ).sort()) {
  const dir = join(PROJ, name);
  if (!statSync(dir).isDirectory()) continue;
  const file = join(dir, 'index.html');
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }

  const lines = src.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (!/Math\.random/.test(line)) return;
    // A mention in prose is not a call. Strip out the cases that only assert
    // determinism ("no Math.random", "Math.random is never called") or are a
    // comment, so the review list is the real executable surface.
    const isCall = /Math\.random\s*\(/.test(line)
      && !/^\s*[/*]/.test(line)
      && !/\bno\b[^.]{0,40}Math\.random/i.test(line)
      && !/Math\.random[^.]{0,30}\bis never called\b/i.test(line);
    if (!isCall) return;
    // Walk backwards to find the enclosing function/method name.
    let ctx = '', depth = 0, safe = false;
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      const l = lines[j];
      ctx = l.trim();
      if (HANDLER.test(l)) { safe = true; break; }
      if (/\bfunction\b|\)\s*\{|=>\s*\{/.test(l)) depth++;
      if (depth > 3) break;
    }
    hits.push({ line: i + 1, text: line.trim().slice(0, 90), safe, ctx: ctx.slice(0, 80) });
  });
  if (!hits.length) continue;

  total += hits.length;
  const unsafe = hits.filter(h => !h.safe);
  flagged += unsafe.length;
  const mark = unsafe.length ? 'REVIEW' : 'ok';
  console.log(`${mark.padEnd(7)} ${name}  (${hits.length})`);
  for (const h of hits) {
    console.log(`   ${h.safe ? '  ' : '!!'} L${h.line}  ${h.text}`);
    if (!h.safe) console.log(`        context: ${h.ctx}`);
  }
}

console.log(`\ntotal Math.random() calls: ${total}   needing review: ${flagged}`);
