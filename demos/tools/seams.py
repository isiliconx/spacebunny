#!/usr/bin/env python3
"""seams.py — detect tiling/repetition artifacts in a render.

A tiled frame (e.g. a small accumulation buffer stretched with REPEAT wrap)
repeats with a known period. The reliable test is PERIODICITY, not gradient
outliers: shift the image by candidate periods and look for a near-zero
difference. A natural scene (terrain horizon, object edges) has high local
gradients everywhere, so a "big row-to-row jump" heuristic false-positives on
almost every real render — do not use one.

Usage:
  python3 seams.py <png>                 # sweep for any strong period
  python3 seams.py <png> 480 300         # test a specific tile period
"""
import sys
from PIL import Image


def load_gray(path):
    im = Image.open(path).convert("L")
    return im, im.load(), im.size


def mean_abs_diff(px, W, H, dx, dy, step=3):
    """Mean |I(x,y) - I(x+dx, y+dy)| over the overlapping region."""
    total = 0
    count = 0
    for y in range(0, H - dy, step):
        for x in range(0, W - dx, step):
            total += abs(px[x, y] - px[x + dx, y + dy])
            count += 1
    return total / max(1, count)


def baseline(px, W, H, step=3):
    """A shift-independent reference scale: mean |I - neighbour| for a small
    offset. Identity-vs-identity is trivially 0, so it can never be the
    baseline."""
    return mean_abs_diff(px, W, H, 1, 0, step=step) + 1e-6


def test_period(px, W, H, dx, dy):
    return mean_abs_diff(px, W, H, dx, dy)


def main(path, tw=None, th=None):
    im, px, (W, H) = load_gray(path)
    print(f"{path}  {W}x{H}")

    if tw and th:
        dx, dy = int(tw), int(th)
        ref = baseline(px, W, H)
        d = test_period(px, W, H, dx, dy)
        ratio = d / ref
        verdict = "TILED" if ratio < 0.20 else "not tiled"
        print(f"  shift ({dx},{dy}): mean|diff| = {d:.2f}  (neighbour baseline {ref:.2f}, ratio {ratio:.3f})")
        print(f"  verdict: {verdict}")
        return 0 if verdict == "not tiled" else 1

    # Sweep plausible tile periods and look for a dip far below the baseline.
    ref = baseline(px, W, H, step=6)
    results = []
    cands = [p for p in range(64, min(W, H) + 1, 8)]
    for p in cands:
        d = test_period(px, W, H, p, 0, step=6)
        results.append((d / ref, p, "x"))
    best = min(results)
    print(f"  neighbour baseline = {ref:.2f}")
    print(f"  best x-period: {best[1]}px  ratio {best[0]:.3f}  ({'SUSPECT TILING' if best[0] < 0.20 else 'no strong period'})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], *(sys.argv[2:4] if len(sys.argv) > 3 else ())))
