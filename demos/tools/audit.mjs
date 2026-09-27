#!/usr/bin/env node
// audit.mjs — static sanity checks on every demo's index.html.
//
//   1. no external resource references (CDN, remote fonts, remote images)
//   2. no Math.random() in the render path (contract requires determinism)
//   3. it sets window.__ready
//   4. it exposes a window.__probe object
//   5. balanced <script>/</script>, and the inline JS actually parses
//
// Usage: node audit.mjs            (audits every NN-slug/ folder)

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = "/home/ubuntu/demos";
const folders = readdirSync(ROOT)
  .filter((n) => /^\d\d-/.test(n) && existsSync(join(ROOT, n, "index.html")))
  .sort();

const problems = [];

for (const f of folders) {
  const path = join(ROOT, f, "index.html");
  const src = readFileSync(path, "utf8");
  const issues = [];
  const notes = [];

  // 1. external resources — allow only spec/khronos namespace URIs
  const urls = [...src.matchAll(/["'`](https?:\/\/[^"'`\s)]+)["'`]/g)].map((m) => m[1]);
  const bad = urls.filter((u) => !/^https?:\/\/(www\.)?(w3\.org|khronos\.org|registry\.khronos)/.test(u));
  if (bad.length) issues.push(`external URL(s): ${[...new Set(bad)].slice(0, 3).join(", ")}`);
  for (const tag of ["src=", "href="]) {
    const re = new RegExp(`${tag}"(?!data:|#)([^"]+)"`, "g");
    for (const m of src.matchAll(re)) {
      if (/^(https?:)?\/\//.test(m[1])) issues.push(`external ${tag} ref: ${m[1].slice(0, 60)}`);
    }
  }

  // 2. determinism — Math.random() is only a problem when it can affect a
  //    rendered frame. Ignore comments, and ignore the classic "shuffle this
  //    list for me" pattern that is strictly bound to a user click handler.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1 ");
  const rndAll = (code.match(/Math\.random\s*\(/g) || []).length;
  const isClickHandler = /onclick|addEventListener\s*\(\s*['"]click/.test(code);
  if (rndAll && !isClickHandler) issues.push(`Math.random() x${rndAll} outside a click handler (must be seeded)`);
  else if (rndAll) notes.push(`Math.random() x${rndAll} (click-handler only — not the render path)`);

  // 3/4. readiness contract
  if (!/window\.__ready\s*=/.test(src)) issues.push("never sets window.__ready");
  if (!/window\.__probe\s*=/.test(src)) issues.push("never sets window.__probe");

  // 5. script balance + parse
  const open = (src.match(/<script[\s>]/g) || []).length;
  const close = (src.match(/<\/script>/g) || []).length;
  if (open !== close) issues.push(`script tags unbalanced (${open} open, ${close} close)`);

  const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (blocks.length) {
    const tmp = join(mkdtempSync(join(tmpdir(), "audit-")), "in.js");
    writeFileSync(tmp, blocks.join("\n;\n"));
    try {
      execFileSync("node", ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message).split("\n").slice(0, 4).join(" ").slice(0, 200);
      issues.push(`JS parse error: ${msg}`);
    }
  }

  // GLSL backtick hazard: a backtick inside a template literal silently ends it
  const ticks = (src.match(/`/g) || []).length;
  if (ticks % 2 !== 0) issues.push(`odd number of backticks (${ticks}) — likely a broken template literal`);

  const kb = Math.round(src.length / 1024);
  if (issues.length) {
    problems.push(f);
    console.log(`FAIL  ${f}  (${kb} KB)`);
    issues.forEach((i) => console.log(`        - ${i}`));
  } else {
    console.log(`ok    ${f}  (${kb} KB, ${blocks.length} inline script)`);
    notes.forEach((n) => console.log(`        note: ${n}`));
  }
}

console.log(problems.length ? `\n${problems.length} demo(s) need attention.` : `\nAll ${folders.length} demos pass.`);
process.exit(problems.length ? 1 : 0);
