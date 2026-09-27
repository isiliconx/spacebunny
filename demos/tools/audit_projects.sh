#!/usr/bin/env bash
# audit_projects.sh — static checks across projects/.
#
# Complements verify_projects.sh: the render gate proves a project draws
# something, these checks prove it is self-contained and deterministic, which
# the render gate cannot see.
#
# A render gate reports a project as failing on a timeout when the real cause
# is a SyntaxError: the script never runs, nothing ever sets __ready, and the
# only symptom is that the page went quiet. That is a bad failure to debug
# from a screenshot, so the extracted script is parsed here first and the
# reason is named.
set -uo pipefail

# Resolve the repo root from this script's own location, so it works whether it
# is run as ./tools/audit_projects.sh, demos/tools/audit_projects.sh, or with an
# absolute path. tools/ is two levels below the root.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PASS=0; FAIL=0
BAD=""

# Pull every inline <script> that is not a shader back out and hand it to
# node --check. Shaders live in <script type="x-shader/..."> and are GLSL, so
# they are skipped; their correctness is the render gate's business.
check_js() {
  local f="$1" tmp
  tmp=$(mktemp /tmp/jscheck-XXXXXX.js)
  python3 - "$f" > "$tmp" <<'PY' || { rm -f "$tmp"; return 0; }
import re, sys
html = open(sys.argv[1], encoding="utf-8", errors="replace").read()
parts = []
for m in re.finditer(r"<script(?![^>]*\bsrc=)(?![^>]*x-shader)[^>]*>(.*?)</script>",
                     html, re.S):
    parts.append(m.group(1))
sys.stdout.write("\n;\n".join(parts))
PY
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; return 0; fi
  if ! out=$(node --check "$tmp" 2>&1); then
    # Collapse node's multi-line report to the one line that names the fault.
    echo "$out" | grep -m1 -E 'SyntaxError|Error:' | sed 's/^/js: /'
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  return 0
}

for d in projects/*/; do
  d="${d%/}"
  f="$d/index.html"
  name=$(basename "$d")
  [ -f "$f" ] || continue

  problems=()

  # External resources. The whole point is that these run from a local disk
  # with no network, so any remote reference is a real defect.
  if grep -qE 'https?://[^"'"'"' )]+' "$f" 2>/dev/null; then
    # An xmlns or a comment mentioning a URL is fine; a loaded resource is not.
    if grep -qE '(src|href)[[:space:]]*=[[:space:]]*["'"'"']https?://' "$f"; then
      problems+=("external resource")
    fi
  fi
  if grep -qE '<script[^>]+src[[:space:]]*=[[:space:]]*["'"'"']https?://' "$f"; then
    problems+=("remote script")
  fi
  if grep -qE 'fetch\(|XMLHttpRequest' "$f"; then
    problems+=("runtime fetch")
  fi

  # The script has to actually parse. Cheap, and it turns an unnameable
  # render timeout into a specific error.
  if ! js_err=$(check_js "$f"); then
    problems+=("script does not parse — $js_err")
  fi

  # The harness contract every project must honour.
  if ! grep -q '__ready' "$f"; then problems+=("no __ready signal"); fi

  # Math.random() in the render path breaks reproducibility. It is only allowed
  # inside a user-triggered handler, which is hard to prove statically, so
  # report it for a human to judge rather than failing outright.
  rnd=$(grep -c 'Math\.random' "$f" 2>/dev/null | head -1)
  rnd=${rnd:-0}
  note=""
  if [ "$rnd" -gt 0 ] 2>/dev/null; then
    note=" (Math.random x${rnd} — verify it is click-handler only)"
  fi

  if [ ${#problems[@]} -eq 0 ]; then
    printf 'ok    %-26s %6s KB%s\n' "$name" "$(( $(wc -c < "$f") / 1024 ))" "$note"
    PASS=$((PASS+1))
  else
    printf 'FAIL  %-26s %s\n' "$name" "${problems[*]}"
    FAIL=$((FAIL+1)); BAD="$BAD $name"
  fi
done

echo
echo "ok: $PASS   failed: $FAIL"
[ -n "$BAD" ] && echo "failing:$BAD"
exit $((FAIL > 0))
