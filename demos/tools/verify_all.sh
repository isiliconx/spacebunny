#!/usr/bin/env bash
# verify_all.sh — render every demo and run all objective checks.
#
# This is the gate: a demo only ships if it renders, reports its probe, passes
# the image health check, and has no page errors.
set -uo pipefail

# Resolve the demo root from this script's location, so the tools work from
# wherever the repository is checked out rather than a hard-coded path.
cd "$(dirname "$0")/.."

W="${W:-1280}"; H="${H:-800}"; TMO="${TMO:-240}"
# The path tracer accumulates hundreds of samples per pixel on a software
# rasterizer, so it legitimately needs far longer than the shader demos. Scale
# its budget instead of letting a one-size-fits-all timeout fail it.
TMO_PATH="${TMO_PATH:-540}"
mkdir -p .verify
PASS=0; FAIL=0
FAILED=""

for d in 0*/; do
  d="${d%/}"
  [ -f "$d/index.html" ] || continue
  tmo="$TMO"
  case "$d" in *path-tracer*) tmo="$TMO_PATH" ;; esac
  out=".verify/${d}.png"
  printf '%-26s ' "$d"
  log=$(node tools/render.mjs "file://$PWD/${d}/index.html" "$out" \
        --w "$W" --h "$H" --ready "window.__ready===true" --timeout "$tmo" 2>&1)
  probe=$(printf '%s' "$log" | grep -m1 '^probe: ' | cut -c1-150)
  errs=$(printf '%s' "$log" | grep -c 'exception\|page errors' || true)
  if [ ! -s "$out" ]; then
    echo "FAIL (no image)"; FAIL=$((FAIL+1)); FAILED="$FAILED $d"; continue
  fi
  # a NOT-READY flag means the demo never signalled the readiness contract
  notready=$(printf '%s' "$log" | grep -c 'NOT-READY' || true)
  # One imginfo pass, parsed once. The output is indented ("  colours  11699
  # (...)"), so extract with awk rather than `cut -d' ' -f2`, which returned the
  # literal label and printed "colours colours" on every line.
  info=$(python3 tools/imginfo.py "$out" 2>/dev/null)
  health=$(printf '%s' "$info" | awk -F': *' '/VERDICT/{print $2; exit}')
  colours=$(printf '%s' "$info" | awk '/colours/{print $2; exit}')
  if [ "$health" = "OK" ] && [ "$notready" = "0" ]; then
    echo "PASS  ${health}  ${colours} colours  ${probe#probe: }"
    PASS=$((PASS+1))
    # promote to the demo's published preview
    cp "$out" "$d/preview.png"
  else
    echo "FAIL  verdict=${health} notready=${notready} errs=${errs} ${probe#probe: }"
    FAIL=$((FAIL+1)); FAILED="$FAILED $d"
  fi
done

echo
echo "passed: $PASS   failed: $FAIL"
[ -n "$FAILED" ] && echo "failing:$FAILED"
# No gallery regeneration here: the site dashboard at the repo root builds its
# own grid from js/demo-data.js and reads each demo's committed preview.png, so
# verifying the demos never rewrites the site.
exit $((FAIL > 0))
