#!/usr/bin/env python3
"""Measure a rendered SDF fractal, from the PNG the browser actually produced.

Why this exists
---------------
The Menger sponge shipped a distance estimator that rendered a solid block.
Every CPU re-implementation of it that I wrote passed its own sign checks and
a re-derived copy of itself -- but re-typing a shader to test it is the exact
step that hides the bug, because the copy and the original drift apart and the
copy is what gets asserted on. Two of those copies disagreed with each other
while both looked reasonable.

So: measure the shipped artefact. Render the real page in Chrome, then ask the
pixels what shape they are. No transcription, no second implementation.

What it measures
----------------
For a fractal that fills a known region, the informative statistics are:

  fill      fraction of the solid's bounding box that is actually solid.
            A Menger sponge at recursion n is a cross of (3^n-2)^n sub-cubes
            out of (3^n)^n, so fill falls fast: ~0.46 at n=1, ~0.29 at n=2.
            A SOLID CUBE measures ~1.0. This is the number that separates
            "fractal" from "block", and it needs no reference image.

  perim     boundary pixels / area. A fractal has proportionally far more
            surface than a plain solid of the same footprint.

  holes     enclosed background regions, i.e. voids that do not reach the
            frame edge. A sponge's signature: square voids visible through
            the openings AND ones fully enclosed. Counted by flood-filling
            background from the border and seeing what is left over.

  luma      the flat-plain failure mode -- a solid block with Lambertian
            shading has almost no tonal range, so a low luma stddev with a
            high fill is the "it rendered, but it is a box" signature.

Usage
-----
    python3 fractal-check.py out.png [--mask r,g,b] [--expect max-fill]
    python3 fractal-check.py --self-test
"""
from __future__ import annotations

import random
import sys
from collections import deque

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("needs Pillow: python3 -m pip install pillow")


def load_mask(path: str, rgb: tuple[int, int, int] | None, tol: int = 10):
    """Return (solid_mask, luma_array) as flat lists of bools / floats.

    The background is the modal colour, but only among colours that actually
    reach the frame EDGE. Picking the global mode is wrong for a lit solid:
    the brightest face can outnumber the sky, and masking against it swallows
    the object. These demos always render the fractal over a void, so the
    border is a reliable sample of what "background" means here.
    """
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = list(im.getdata())
    lum = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]

    edge: dict[tuple[int, int, int], int] = {}
    for x in range(w):
        for y in (0, h - 1):
            p = px[y * w + x]
            key = (p[0] >> 3, p[1] >> 3, p[2] >> 3)
            edge[key] = edge.get(key, 0) + 1
    for y in range(h):
        for x in (0, w - 1):
            p = px[y * w + x]
            key = (p[0] >> 3, p[1] >> 3, p[2] >> 3)
            edge[key] = edge.get(key, 0) + 1
    dom = max(edge, key=edge.get)
    if rgb is None:
        rgb = (dom[0] << 3, dom[1] << 3, dom[2] << 3)

    solid = [max(abs(p[0] - rgb[0]), abs(p[1] - rgb[1]), abs(p[2] - rgb[2])) > tol
             for p in px]
    return solid, lum, w, h, rgb


def bbox(solid, w, h):
    xs, ys = [], []
    for i, s in enumerate(solid):
        if s:
            xs.append(i % w)
            ys.append(i // w)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def fill_fraction(solid, w, h):
    """Solid pixels / area of the solid's own bounding box."""
    bb = bbox(solid, w, h)
    if bb is None:
        return 0.0, 0
    x0, y0, x1, y1 = bb
    area = (x1 - x0 + 1) * (y1 - y0 + 1)
    n = sum(solid)
    return n / area, n


def components(solid, w, h, min_px=1):
    """Connected components of the solid, 4-connected.

    min_px filters out anti-aliasing speckle: a raymarched edge pixel that
    lands a few levels off the surface still differs slightly from the void
    colour, and at 1280x800 that is enough to register as a 2-4 pixel island.
    Real geometry does not come in fragments that small.
    """
    seen = bytearray(w * h)
    sizes = []
    for start in range(w * h):
        if not solid[start] or seen[start]:
            continue
        size = 0
        q = deque([start])
        seen[start] = 1
        while q:
            i = q.popleft()
            size += 1
            x, y = i % w, i // w
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if solid[j] and not seen[j]:
                        seen[j] = 1
                        q.append(j)
        sizes.append(size)
    if not sizes:
        return 0, []
    # Speckle is anything too small to be geometry. A fixed pixel count does
    # not work across resolutions, and neither does a fixed fraction: the
    # stray pixels here are 8-25 px fragments of panel borders and text, next
    # to a 290,180 px object, so the useful rule is relative -- keep only
    # components carrying at least 0.1% of the largest one.
    floor = max(min_px, max(sizes) * 0.001)
    kept = [s for s in sizes if s >= floor]
    return len(kept), kept


def enclosed_holes(solid, w, h):
    """Background regions that do not touch the frame edge."""
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if not solid[i] and not seen[i]:
                seen[i] = 1
                q.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if not solid[i] and not seen[i]:
                seen[i] = 1
                q.append(i)
    while q:
        i = q.popleft()
        x, y = i % w, i // w
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if not solid[j] and not seen[j]:
                    seen[j] = 1
                    q.append(j)
    holes, sizes = 0, []
    for start in range(w * h):
        if solid[start] or seen[start]:
            continue
        holes += 1
        size = 0
        q = deque([start])
        seen[start] = 1
        while q:
            i = q.popleft()
            size += 1
            x, y = i % w, i // w
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not solid[j] and not seen[j]:
                        seen[j] = 1
                        q.append(j)
        sizes.append(size)
    return holes, sizes


def analyse(path: str, rgb=None, speckle=16):
    solid, lum, w, h, used_rgb = load_mask(path, rgb)
    frac, nsolid = fill_fraction(solid, w, h)
    comps, csizes = components(solid, w, h, min_px=speckle)
    holes, hsizes = enclosed_holes(solid, w, h)
    sl = [lum[i] for i in range(w * h) if solid[i]]
    if len(sl) > 1:
        mean = sum(sl) / len(sl)
        var = sum((v - mean) ** 2 for v in sl) / len(sl)
        std = var ** 0.5
        lo, hi = min(sl), max(sl)
    else:
        mean = std = 0.0
        lo = hi = 0.0
    big_holes = [s for s in hsizes if s >= 4]
    return {
        "path": path, "size": (w, h), "bg": used_rgb,
        "solid_px": nsolid, "coverage": nsolid / (w * h),
        "fill_of_bbox": frac, "components": comps,
        "largest_component": max(csizes) if csizes else 0,
        "holes": holes, "big_holes": len(big_holes),
        "luma_mean": mean, "luma_std": std, "luma_range": hi - lo,
    }


def verdict(r, max_fill: float, min_holes: int):
    bad = []
    if r["components"] != 1:
        bad.append(f"{r['components']} components (want 1 connected solid)")
    # Fill is measured on a PROJECTION, so a genuine sponge sits high: you
    # are looking through the holes at the back faces, and the silhouette is
    # still the cross. Calibrated against a voxelised Menger at scale 3, which
    # projects to ~0.71 at depth 3 and ~0.79 at depth 2, against 1.00 for a
    # solid cube. The band that separates them is narrow, so holes and
    # components carry most of the signal; fill is the tiebreaker.
    if r["fill_of_bbox"] > max_fill:
        bad.append(
            f"fill {r['fill_of_bbox']:.2f} of its own bbox (want <= {max_fill:.2f})"
            " -- reads as a solid block, not a fractal")
    if r["holes"] < min_holes:
        bad.append(f"{r['holes']} enclosed voids (want >= {min_holes})")
    # Absent for the synthetic self-test shapes, which are flat masks by
    # construction; only a real render can be judged on tonal range.
    if "luma_std" in r and r["luma_std"] < 6.0:
        bad.append(f"luma stddev {r['luma_std']:.1f} -- flat, no surface detail")
    return bad


def render(r):
    print(f"  image          {r['size'][0]}x{r['size'][1]}   background rgb{r['bg']}")
    print(f"  solid pixels   {r['solid_px']}  ({r['coverage']*100:.1f}% of frame)")
    print(f"  fill of bbox   {r['fill_of_bbox']:.3f}"
          f"   <- a Menger sponge falls off fast; a solid cube is ~1.0")
    print(f"  components     {r['components']}"
          f"  (largest {r['largest_component']} px)")
    print(f"  enclosed voids {r['holes']}  ({r['big_holes']} of >= 4 px)")
    print(f"  luma           mean {r['luma_mean']:.1f}  stddev {r['luma_std']:.1f}"
          f"  range {r['luma_range']:.0f}")


def self_test():
    """Prove the checkers separate the real thing from the failure modes.

    A metric that cannot tell a sponge from a box is decoration. The good
    control is a genuine Menger solid, voxelised from the level function
    rather than drawn by hand -- my first hand-drawn attempt came out as 64
    disconnected blocks and the check correctly rejected it, which is exactly
    the failure this tool exists to catch, so hand-drawing the control was
    the wrong way to build it.
    """
    N = 121

    def sd_box(px, py, pz, bx, by, bz):
        dx, dy, dz = abs(px) - bx, abs(py) - by, abs(pz) - bz
        out = max(dx, dy, dz)
        out = min(out, 0.0)
        return out + ((max(dx, 0.0) ** 2 + max(dy, 0.0) ** 2
                       + max(dz, 0.0) ** 2) ** 0.5)

    def level(px, py, pz, s=3.0):
        """One Menger level: unit cube minus the central cross."""
        t = 1.0 / s
        outer = sd_box(px, py, pz, 1.0, 1.0, 1.0)
        void = min(sd_box(px, py, pz, 1.0, t, t),
                   sd_box(px, py, pz, t, 1.0, t),
                   sd_box(px, py, pz, t, t, 1.0))
        return max(outer, -void)

    def menger(px, py, pz, depth):
        """Recurse by explicit union over the 20 surviving sub-cubes."""
        if depth <= 1:
            return level(px, py, pz)
        o = 2.0 / 3.0
        best = 1e30
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for k in (-1, 0, 1):
                    on_axis = (i == 0) + (j == 0) + (k == 0)
                    if on_axis > 1:
                        continue
                    best = min(best, menger((px - i * o) * 3.0,
                                            (py - j * o) * 3.0,
                                            (pz - k * o) * 3.0, depth - 1))
        return best * 3.0

    def project(fn, half=1.0, zs=None):
        """Silhouette of the SOLID along z -- what a camera actually sees.

        A 2D slice is the wrong control here and produced a false failure: the
        mid-plane of a Menger sponge really is four disconnected squares, so
        a slice reads as 16 components at depth 2 even though the solid is
        perfectly connected in 3D. What a render shows is the union over the
        whole ray, so the control has to be that too.
        """
        if zs is None:
            zs = [(-half + 2 * half * t / (N // 2 - 1))
                  for t in range(N // 2)]
        m = [[False] * N for _ in range(N)]
        for y in range(N):
            py = -half + 2 * half * y / (N - 1)
            for x in range(N):
                px = -half + 2 * half * x / (N - 1)
                for pz in zs:
                    if fn(px, py, pz) < 0:
                        m[y][x] = True
                        break
        return m

    box = [[False] * N for _ in range(N)]
    for y in range(10, 111):
        for x in range(10, 111):
            box[y][x] = True

    rng = random.Random(7)
    scatter = [[False] * N for _ in range(N)]
    for _ in range(8):
        cx, cy = rng.randrange(15, 90), rng.randrange(15, 90)
        for y in range(cy, cy + 16):
            for x in range(cx, cx + 16):
                scatter[y][x] = True

    cases = [
        ("Menger d2", project(lambda x, y, z: menger(x, y, z, 2))),
        ("Menger d3", project(lambda x, y, z: menger(x, y, z, 3))),
        ("solid box", box),
        ("8 blocks", scatter),
    ]
    out = []
    for name, m in cases:
        flat = [m[y][x] for y in range(N) for x in range(N)]
        comps, _ = components(flat, N, N)
        _, hsizes = enclosed_holes(flat, N, N)
        bb = bbox(flat, N, N)
        assert bb is not None, "self-test shapes must not be empty"
        fill = sum(flat) / ((bb[2] - bb[0] + 1) * (bb[3] - bb[1] + 1))
        r = {"fill_of_bbox": fill, "components": comps, "holes": len(hsizes)}
        bad = verdict(r, 0.88, 1)
        out.append((name, r, bad))
        print(f"  {name:11s} fill {fill:.3f}  comps {comps:2d}  "
              f"holes {len(hsizes):3d}  -> {'REJECT: ' + bad[0] if bad else 'accept'}")

    accepted = {n for n, _, b in out if not b}
    rejected = {n for n, _, b in out if b}
    ok = ({"Menger d2", "Menger d3"} <= accepted
          and {"solid box", "8 blocks"} <= rejected)
    print("\n  self-test:", "PASS -- real sponge accepted; box and scatter rejected"
          if ok else "FAIL -- the metric does not separate the cases")
    return ok


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        print("fractal-check self-test")
        sys.exit(0 if self_test() else 1)

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    max_fill = 0.88
    mf = sys.argv.index("--max-fill") if "--max-fill" in sys.argv else -1
    if mf > 0:
        max_fill = float(sys.argv[mf + 1])
    mh = sys.argv.index("--min-holes") if "--min-holes" in sys.argv else -1
    min_holes = int(sys.argv[mh + 1]) if mh > 0 else 1

    r = analyse(args[0])
    render(r)
    bad = verdict(r, max_fill, min_holes)
    print()
    if bad:
        for b in bad:
            print("  REJECT:", b)
        print("VERDICT: BROKEN")
        sys.exit(1)
    print("VERDICT: OK")
