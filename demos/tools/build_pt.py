#!/usr/bin/env python3
"""build_pt.py — turn the baked .hdr panoramas into the path tracer's index.html.

For each environment it:
  1. decodes Radiance RGBE -> float RGB
  2. bins luminance into a coarse equirect grid (default 32x16 = 512 cells)
  3. builds a cumulative distribution for importance sampling, normalising each
     cell to its *average* radiance so a big bright softbox contributes a few
     large cells instead of dominating every texel it covers
  4. emits the float data as a compact JS array literal

Usage: python3 build_pt.py
"""
import base64
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRATCH = os.path.join(ROOT, "tools")
OUT = os.path.join(ROOT, "08-path-tracer", "index.html")
TEMPLATE = os.path.join(ROOT, "08-path-tracer", "template.html")

ENVS = [("studio", "env_studio.hdr"), ("sunset", "env_sunset.hdr"), ("nightcity", "env_nightcity.hdr")]
CDF_W, CDF_H = 32, 16


def read_hdr(path):
    with open(path, "rb") as f:
        data = f.read()
    # Scan for the -Y/+X resolution line, then take the first blank line AFTER it
    # as the end of the header. (The first b"\n\n" in the file is only the
    # blank line after FORMAT=, which is NOT the end of the header.)
    res = data.find(b"+X")
    if res < 0:
        res = data.find(b"-X")
    if res < 0:
        raise SystemExit(f"{path}: no resolution line found")
    nl = data.find(b"\n", res)
    idx = data.find(b"\n\n", nl)
    if idx < 0:
        raise SystemExit(f"{path}: header not terminated by a blank line after resolution")
    header = data[:idx].decode("latin1")
    body = data[idx + 2:]
    dims = {}
    for line in header.splitlines():
        parts = line.split()
        # e.g. "-Y 192 +X 384"
        if len(parts) == 4 and parts[0] in ("-Y", "+Y") and parts[2] in ("+X", "-X"):
            dims["h"] = int(parts[1])
            dims["w"] = int(parts[3])
    if "w" not in dims:
        # tolerate other orderings, e.g. "+X 384 -Y 192"
        for line in header.splitlines():
            parts = line.split()
            if len(parts) == 4 and parts[0] in ("+X", "-X") and parts[2] in ("-Y", "+Y"):
                dims["w"] = int(parts[1])
                dims["h"] = int(parts[3])
    if "w" not in dims:
        raise SystemExit(f"{path}: no resolution line in header:\n{header}")
    w, h = dims["w"], dims["h"]
    if len(body) < w * h * 4:
        raise SystemExit(f"{path}: body too short ({len(body)} < {w*h*4})")
    rgb = [0.0] * (w * h * 3)
    for i in range(w * h):
        r, g, b, e = body[i * 4], body[i * 4 + 1], body[i * 4 + 2], body[i * 4 + 3]
        if e == 0:
            continue
        f = math.ldexp(1.0, e - (128 + 8))
        rgb[i * 3] = r * f
        rgb[i * 3 + 1] = g * f
        rgb[i * 3 + 2] = b * f
    return w, h, rgb


def build_cdf(w, h, rgb):
    """Bin into a coarse grid, weight by mean radiance, accumulate a CDF.

    Returns (cdf list of length n+1 with cdf[0]=0, cell weights)."""
    n = CDF_W * CDF_H
    acc = [0.0] * n
    cnt = [0] * n
    for y in range(h):
        cy = min(CDF_H - 1, int(y * CDF_H / h))
        for x in range(w):
            cx = min(CDF_W - 1, int(x * CDF_W / w))
            i = cy * CDF_W + cx
            acc[i] += rgb[(y * w + x) * 3] + rgb[(y * w + x) * 3 + 1] + rgb[(y * w + x) * 3 + 2]
            cnt[i] += 1
    weights = []
    for i in range(n):
        mean = (acc[i] / cnt[i]) if cnt[i] else 0.0
        # sin(theta) area weight: equirect cells shrink toward the poles
        yc = (i // CDF_W + 0.5) / CDF_H
        theta = yc * math.pi
        weights.append(max(mean, 0.0) * math.sin(theta))
    total = sum(weights)
    if total <= 0:
        weights = [1.0] * n
        total = float(n)
    cdf = [0.0]
    run = 0.0
    for wgt in weights:
        run += wgt
        cdf.append(run / total)
    cdf[-1] = 1.0
    return cdf, weights


def js_floats(vals, decimals=5):
    out = []
    for v in vals:
        s = f"{v:.{decimals}f}".rstrip("0").rstrip(".")
        if s in ("", "-0"):
            s = "0"
        out.append(s)
    return ",".join(out)


def main():
    parts = []
    # Report every missing environment at once. bake_env.py bakes one name per
    # invocation, so a partial bake used to surface as a single "missing X" that
    # read like a build break rather than an incomplete bake.
    missing = [fn for _, fn in ENVS
               if not os.path.exists(os.path.join(SCRATCH, fn))]
    if missing:
        print("missing HDR environment(s): " + ", ".join(missing), file=sys.stderr)
        print("bake each one, then retry:\n"
              "  for e in " + " ".join(n for n, _ in ENVS) + "; do "
              "_tools/bake_env.py $e; done", file=sys.stderr)
        return 1
    for name, fn in ENVS:
        path = os.path.join(SCRATCH, fn)
        w, h, rgb = read_hdr(path)
        cdf, weights = build_cdf(w, h, rgb)
        peak = max(rgb) if rgb else 0.0
        lit = sum(1 for x in weights if x > 1e-6)
        print(f"{name}: {w}x{h} peak={peak:.1f} lit-cells={lit}/{CDF_W*CDF_H}")
        parts.append(
            '{name:"%s",w:%d,h:%d,cw:%d,ch:%d,'
            'rgb:new Float32Array([%s]),cdf:new Float32Array([%s])}'
            % (name, w, h, CDF_W, CDF_H, js_floats(rgb, 4), js_floats(cdf, 7))
        )

    with open(TEMPLATE) as f:
        tpl = f.read()
    payload = "[\n" + ",\n".join(parts) + "\n]"
    out = tpl.replace("__ENV_DATA__", payload)
    with open(OUT, "w") as f:
        f.write(out)
    size = os.path.getsize(OUT)
    print(f"wrote {OUT}  {size/1024:.0f} KB")

    # Validate: extract the inline script and parse it with node. A backtick or
    # stray sequence inside the injected payload will otherwise only surface as a
    # browser SyntaxError after a full (slow) render.
    import re
    import subprocess
    import tempfile
    with open(OUT) as f:
        src = f.read()
    blocks = re.findall(r"<script>([\s\S]*?)</script>", src)
    if not blocks:
        print("FAIL: no inline <script> block found in output", file=sys.stderr)
        return 1
    script = blocks[-1]
    # Write the extracted script to a NamedTemporaryFile rather than a fixed
    # path: a fixed name left a 4 MB artifact sitting in the repo after every
    # build, which is exactly the kind of thing that gets committed by accident.
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(script)
        tmp = f.name
    try:
        r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    finally:
        os.unlink(tmp)
    if r.returncode != 0:
        print("FAIL: generated index.html has a JS syntax error:", file=sys.stderr)
        print(r.stderr[-2000:], file=sys.stderr)
        return 1
    print("syntax check: OK")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
