#!/usr/bin/env bash
# verify_projects.sh — the gate for projects/.
#
# Renders every project and checks it objectively. This is deliberately
# independent of whatever the building agents reported: a self-report is not a
# measurement.
#
# Renders into .verify/ first and promotes to preview.png only on a pass, so a
# late or failed render can never overwrite a good preview.
set -uo pipefail

# Resolve the repo root from this script's own location (tools/ is two levels
# below it), so the gate works from any working directory.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

W="${W:-1280}"; H="${H:-800}"; TMO="${TMO:-200}"
# ONLY="name name" restricts the gate. Re-running all 50 to confirm two
# projects is slow enough that people skip the re-run, and a stale preview
# promoted by a contended run is worse than no re-run at all.
ONLY="${ONLY:-}"
mkdir -p .verify
PASS=0; FAIL=0
MISSING=0
FAILED=""

for d in projects/*/; do
  d="${d%/}"
  name=$(basename "$d")
  [ -f "$d/index.html" ] || { echo "SKIP $name (no index.html)"; MISSING=$((MISSING+1)); continue; }

  if [ -n "$ONLY" ]; then
    case " $ONLY " in *" $name "*) ;; *) continue ;; esac
  fi

  out=".verify/${name}.png"
  printf '%-26s ' "$name"

  log=$(node demos/tools/render.mjs "file://$PWD/${d}/index.html" "$out" \
        --w "$W" --h "$H" --ready "window.__ready===true" --timeout "$TMO" 2>&1)

  if [ ! -s "$out" ]; then
    echo "FAIL (no image)"; FAIL=$((FAIL+1)); FAILED="$FAILED $name"; continue
  fi

  notready=$(printf '%s' "$log" | grep -c 'NOT-READY' || true)
  info=$(python3 demos/tools/imginfo.py "$out" 2>/dev/null)
  health=$(printf '%s' "$info" | awk -F': *' '/VERDICT/{print $2; exit}')
  colours=$(printf '%s' "$info" | awk '/colours/{print $2; exit}')
  topcolour=$(printf '%s' "$info" | awk -F'covers +' '/colours/{split($2,a,"%"); print a[1]; exit}')
  stddev=$(printf '%s' "$info" | awk '/stddev/{print $3; exit}')
  # A pass needs a healthy, non-degenerate image and a live readiness signal.
  # Track *why* it failed: a single "FAIL notready=0 colours=1288" line sent
  # me looking for a readiness timeout that never happened.
  why=""
  [ "$health" = "OK" ] || why="${why} health=${health}"
  [ "$notready" = "0" ] || why="${why} not-ready"
  # Colour count catches a blank or single-blob frame, but a hard floor is
  # wrong: a flat-shaded grey fractal legitimately has far fewer colours than
  # a volumetric one -- the Menger sponge sits at ~1,290 and was failing a
  # 1500-colour threshold while rendering perfectly. imginfo.py already judges
  # degeneracy on its own terms (clipping, dominance, tonal range), so here it
  # is enough to require real tonal range plus a non-trivial colour count.
  if ! { [ -n "$colours" ] && [ "$colours" -gt 400 ]; } 2>/dev/null; then
    why="${why} colours=${colours:-none}"
  fi
  if ! awk "BEGIN{exit !($stddev > 8)}" 2>/dev/null; then
    why="${why} stddev=${stddev:-none}"
  fi
  ok=1
  [ -z "$why" ] || ok=0

  if [ "$ok" = "1" ]; then
    echo "PASS  ${health}  ${colours} colours  top ${topcolour}%"
    cp "$out" "$d/preview.png"
    PASS=$((PASS+1))
  else
    echo "FAIL ${why# }"
    FAIL=$((FAIL+1)); FAILED="$FAILED $name"
  fi
done

echo
echo "passed: $PASS   failed: $FAIL   missing: $MISSING"
[ -n "$FAILED" ] && echo "failing:$FAILED"
exit $((FAIL > 0))
