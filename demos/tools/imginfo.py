#!/usr/bin/env python3
"""imginfo.py — objective health check for a rendered demo screenshot.

Usage: python3 imginfo.py <png> [png ...]

Flags a screenshot that is blank, a single flat colour, or suspiciously
uniform -- i.e. a demo that failed to actually draw anything, even if it
claimed window.__ready = true.
"""
import sys
from PIL import Image, ImageStat


def check(path: str) -> int:
    try:
        im = Image.open(path).convert("RGB")
    except Exception as exc:
        print(f"{path}: UNREADABLE ({exc})")
        return 2

    w, h = im.size
    stat = ImageStat.Stat(im)
    mean = stat.mean
    stddev = stat.stddev
    lum_mean = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]

    # distinct colours on a downscaled copy (sampling-safe, fast)
    small = im.resize((min(240, w), min(240, h)), Image.NEAREST)
    colors = small.getcolors(maxcolors=240 * 240) or []
    n_colors = len(colors)

    # most common colour share
    top_share = max((c for c, _ in colors), default=0) / (small.size[0] * small.size[1])

    # mean per-channel stddev tells us about contrast/structure
    mean_std = sum(stddev) / 3.0

    print(f"{path}")
    print(f"  size        {w}x{h}")
    print(f"  mean RGB    {mean[0]:6.1f} {mean[1]:6.1f} {mean[2]:6.1f}   luma {lum_mean:6.1f}")
    print(f"  stddev RGB  {stddev[0]:6.1f} {stddev[1]:6.1f} {stddev[2]:6.1f}   (mean {mean_std:5.1f})")
    print(f"  colours     {n_colors} (top colour covers {top_share * 100:5.1f}% of pixels)")

    verdict, bad = "OK", False
    if n_colors <= 2:
        verdict, bad = "BLANK/FLAT", True
    elif top_share > 0.985:
        verdict, bad = "NEARLY-FLAT", True
    elif mean_std < 1.5:
        verdict, bad = "TOO-UNIFORM (no visible structure)", True
    elif lum_mean > 250 and mean_std < 6:
        verdict, bad = "SUSPECT: near-white with little structure", True

    print(f"  VERDICT: {verdict}")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    rc = 0
    for p in sys.argv[1:]:
        rc |= check(p)
        print()
    sys.exit(rc)
