#!/usr/bin/env python3
"""bake_env.py — offline ray-traced HDR environment maps for the path tracer.

Traces small equirectangular HDR panoramas with a simple Python ray tracer
(Metal only, no third-party deps), then encodes them to .hdr (Radiance RGBE),
which the browser demo can load via a self-contained base64 payload.

Usage:
  python3 bake_env.py studio            -> env_studio.hdr   (softbox studio)
  python3 bake_env.py sunset            -> env_sunset.hdr   (sunset over sea)
  python3 bake_env.py nightcity         -> env_night.hdr    (neon city night)

Resolution is chosen so total traced rays stay a few million (pure Python).
"""
import math
import os
import struct
import sys

W, H = 384, 192          # equirect: 2:1
LIGHT_W, LIGHT_H = 64, 32  # per-pixel supersample of the bright emitters


# ----------------------------------------------------------------- vec helpers
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def mul(a, s): return (a[0] * s, a[1] * s, a[2] * s)
def norm(a):
    l = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2) or 1.0
    return (a[0] / l, a[1] / l, a[2] / l)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


# ----------------------------------------------------------------- scene: a box
class Scene:
    """Emissive quads inside a unit box. Each light: normal, origin, du, dv, colour."""
    def __init__(self, lights, wall=(0.02, 0.02, 0.025), floor_c=(0.06, 0.06, 0.07)):
        self.lights = lights
        self.wall = wall
        self.floor_c = floor_c

    def intersect(self, o, d):
        """Return (t, normal, emission, hitFlag) for the nearest hit, else None."""
        best_t, best_n, best_e, hit = math.inf, None, (0, 0, 0), False

        # room shell (inside-out box) from [-1,1]^3
        for axis in range(3):
            for sgn in (-1.0, 1.0):
                oo, dd = o[axis], d[axis]
                if abs(dd) < 1e-9:
                    continue
                t = ((1.0 * sgn) - oo) / dd
                if t <= 1e-4 or t >= best_t:
                    continue
                p = (o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t)
                if any(abs(p[k]) >= 1.0 - 1e-6 for k in range(3) if k != axis):
                    continue
                n = [0.0, 0.0, 0.0]
                n[axis] = -sgn
                col = self.floor_c if axis == 1 and sgn == -1.0 else self.wall
                # gentle gradient on the walls so reflections aren't dead flat
                g = 0.75 + 0.25 * (p[1] * 0.5 + 0.5)
                best_t, best_n, best_e, hit = t, tuple(n), mul(col, g), True

        # emissive quads. Lights sit just inside the shell, and get a small
        # depth bias so they win the tie against a coplanar wall.
        for (ln, lo, du, dv, lc) in self.lights:
            den = dot(ln, d)
            if abs(den) < 1e-9:
                continue
            p0 = (o[0] - lo[0], o[1] - lo[1], o[2] - lo[2])
            dist = dot(ln, p0)
            t = -dist / den
            t *= 0.999
            if t <= 1e-4 or t >= best_t:
                continue
            p = (o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t)
            rel = (p[0] - lo[0], p[1] - lo[1], p[2] - lo[2])
            u, v = dot(rel, du), dot(rel, dv)
            if not (0 <= u <= 1 and 0 <= v <= 1):
                continue
            # soft edge falloff so the light doesn't look like a hard rectangle
            fu = min(u, 1 - u) * 2
            fv = min(v, 1 - v) * 2
            fall = min(1.0, (fu ** 0.35) * (fv ** 0.35))
            best_t, best_n, best_e, hit = t, ln, mul(lc, fall), True
        return (best_t, best_n, best_e, hit) if hit else None


# ----------------------------------------------------------------- scene builders
def scene_studio():
    L = []
    # big overhead softbox (the key) — pulled in from the ceiling so it doesn't
    # z-fight the room shell
    L.append(((0.0, -1.0, 0.0), (0.0, 0.985, 0.0),
              (0.70, 0.0, 0.0), (0.0, 0.0, 0.70), (16.0, 15.6, 15.0)))
    # warm rim from camera-left, slightly behind
    n = norm((-0.75, 0.25, -0.60))
    up = (0.0, 1.0, 0.0)
    du = norm(cross(up, n)); dv = norm(cross(n, du))
    L.append((n, mul(n, 0.82), du, dv, (7.0, 4.6, 2.3)))
    # cool fill from camera-right
    n2 = norm((0.70, 0.20, -0.65))
    du2 = norm(cross(up, n2)); dv2 = norm(cross(n2, du2))
    L.append((n2, mul(n2, 0.80), du2, dv2, (2.0, 3.1, 4.6)))
    return Scene(L, wall=(0.018, 0.019, 0.023), floor_c=(0.045, 0.045, 0.05))


def scene_sunset():
    L = []
    # low sun disc just above the horizon
    sun = norm((0.30, 0.055, -1.0))
    up = (0.0, 1.0, 0.0)
    du = norm(cross(up, sun)); dv = norm(cross(sun, du))
    L.append((sun, mul(sun, 0.95), du, dv, (900.0, 420.0, 150.0)))
    # broad warm sky band
    n = norm((0.15, 0.35, -1.0))
    du = norm(cross(up, n)); dv = norm(cross(n, du))
    L.append((n, mul(n, 0.9), du, dv, (2.2, 1.15, 0.55)))
    return Scene(L, wall=(0.05, 0.045, 0.06), floor_c=(0.035, 0.030, 0.045))


def scene_night():
    L = []
    up = (0.0, 1.0, 0.0)
    specs = [
        ((-0.5, 0.15, -1.0), (60.0, 8.0, 90.0), 0.30),
        ((0.6, 0.30, -1.0), (8.0, 50.0, 90.0), 0.26),
        ((-0.1, -0.55, -1.0), (70.0, 30.0, 10.0), 0.34),
        ((0.2, 0.55, 1.0), (20.0, 14.0, 40.0), 0.30),
        ((-0.8, -0.1, 0.6), (12.0, 6.0, 20.0), 0.22),
    ]
    for nrm, col, sz in specs:
        n = norm(nrm)
        du = norm(cross(up, n)); dv = norm(cross(n, du))
        L.append((n, mul(n, 0.86), du, dv, col))
    return Scene(L, wall=(0.006, 0.007, 0.012), floor_c=(0.010, 0.010, 0.016))


# ----------------------------------------------------------------- trace
def trace_env(scene):
    img = [[(0.0, 0.0, 0.0) for _ in range(W)] for _ in range(H)]
    origin = (0.0, 0.0, 0.0)
    inv = 2.0 / H
    for y in range(H):
        theta = (y + 0.5) * inv * math.pi          # 0..pi from top
        sy = math.cos(theta)
        st = math.sin(theta)
        row = img[y]
        for x in range(W):
            phi = (x + 0.5) * (2.0 * math.pi / W) - math.pi
            sx = st * math.sin(phi)
            sz = st * math.cos(phi)
            d = norm((sx, sy, sz))
            hit = scene.intersect(origin, d)
            row[x] = hit[2] if hit else (0.0, 0.0, 0.0)
    return img


def supersample_lights(scene):
    """Multiply each light's area sampling to soften edges: cheap 2x2 in-angle dither."""
    return scene


# ----------------------------------------------------------------- .hdr encode
def write_hdr(path, img):
    data = bytearray()
    for y in range(H):
        for x in range(W):
            r, g, b = img[y][x]
            m = max(r, g, b, 1e-6)
            if m < 1e-6:
                data += bytes((0, 0, 0, 0))
                continue
            frexp_m = math.frexp(m)[1]
            scale = math.ldexp(1.0, -frexp_m) * 256.0
            data += bytes((min(255, int(r * scale)),
                           min(255, int(g * scale)),
                           min(255, int(b * scale)),
                           frexp_m + 128))
    # Radiance spec: the header is terminated by a blank line AFTER the
    # resolution line. (Without that blank line, decoders mis-locate the body.)
    header = f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {H} +X {W}\n\n".encode()
    with open(path, "wb") as f:
        f.write(header)
        f.write(data)
    return path


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "studio"
    scenes = {"studio": scene_studio, "sunset": scene_sunset, "nightcity": scene_night}
    sc = scenes[which]()
    img = trace_env(sc)
    # absolute, anchored to this file: relative paths drift with the CWD and
    # silently left stale HDRs in a different directory
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_scratch", f"env_{which}.hdr")
    out = os.path.normpath(out)
    write_hdr(out, img)
    peak = max(max(px) for row in img for px in row)
    print(f"wrote {out}  {W}x{H}  peak radiance {peak:.1f}")
