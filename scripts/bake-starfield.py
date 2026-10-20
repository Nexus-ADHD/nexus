#!/usr/bin/env python3
"""
Bake the static half of the cosmic backdrop into one @3x asset.

WHY THIS EXISTS
The shipped backdrop was a 941x1672 JPEG rendering at ~1.53x upscale — about
65% of native panel resolution. Every star inside it was a soft, JPEG-mushed
blob, sitting underneath 80 crisp full-resolution vector stars. Two optical
worlds stacked, which the eye reads as "UI drawn on a picture" rather than as
one sky. No design review catches that, because both layers look fine alone.

WHAT THIS BAKES (the layers that never animate)
  1  void base
  2  low-frequency nebulosity — 3 huge blooms in different hues
  3  mid-frequency dust — 2-octave value noise, soft-light
  4  far star field — 600 stars, power-law, static
  8  grain — monochrome dither, kills 8-bit banding on near-black
  9  vignette — radial, centred above middle

The NEAR field (130 animated stars) is drawn at runtime on a Skia canvas; see
src/components/ui/StarField.tsx. Layer numbers match the research doc.

The parameters below mirror src/components/ui/starfield-optics.ts, which is the
source of truth and is vitest-covered. They are duplicated here rather than
imported because this is a Python build step — the assertions at the end fail
loudly if the bake drifts from spec.

USAGE
  python3 scripts/bake-starfield.py                  # writes the @3x PNG
  python3 scripts/bake-starfield.py --stats-only     # measure, write nothing
"""

import argparse
import math
import os
import random
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
except ImportError:
    sys.exit("Pillow required:  python3 -m pip install Pillow")

# ── Output ────────────────────────────────────────────────────────────────────
# @3x for the largest phone (iPhone Pro Max, 430x932pt). Anything smaller ships
# upscaled, which is the whole bug this replaces.
WIDTH, HEIGHT = 1290, 2796
# Every size below is expressed in POINTS (the unit the design system and the
# runtime use) and multiplied by this to get pixels. Baking at @3x with point
# values leaves every star a third of its intended size — sub-pixel, invisible.
SCALE = 3
OUT = "assets/images/cosmic-field-bg.png"
GRAIN_TILE_OUT = "assets/images/film-grain-tile.png"
# Tiled over the WHOLE app, cards included, so one grain structure runs across
# the entire frame the way a camera's does. Pure random noise is seamless by
# construction — there is no low-frequency structure to mismatch at the edges.
GRAIN_TILE_PX = 128
# React Native has no blend modes on Image, so the tile must average to neutral
# or it lifts (or crushes) everything under it. Half the pixels carry white
# alpha, half black, so plain source-over compositing nets out as dither.
GRAIN_TILE_PEAK_ALPHA = 26  # of 255, before the component's own opacity

VOID = (6, 6, 12)  # tokens.color.void #06060C

# ── Layer 2 · nebulosity ──────────────────────────────────────────────────────
# Huge, low-alpha, DIFFERENT hues, never centred. Uniform hue is the single
# most reliable "synthetic" tell — the shipped photo varied by only ~3 units of
# blue-minus-red across the entire frame.
NEBULAE = [
    # (hex,      peak alpha, cx frac, cy frac, radius frac of max(W,H))
    ("#3B2E86", 0.30, 0.30, 0.18, 0.62),  # deep indigo, high left
    ("#0C4C63", 0.24, 0.76, 0.44, 0.54),  # cold cyan, mid right
    ("#5C361F", 0.15, 0.46, 0.88, 0.50),  # warm ember, low centre
]

# ── Layer 3 · dust ────────────────────────────────────────────────────────────
DUST_ALPHA = 0.05
DUST_FEATURE_PX = 360  # ~120pt at @3x

# ── Layer 4 · far field ───────────────────────────────────────────────────────
FAR_STAR_COUNT = 600
FAR_ALPHA_FLOOR, FAR_ALPHA_CEIL, FAR_ALPHA_GAMMA = 0.10, 0.62, 2.4
FAR_SIZE_MIN, FAR_SIZE_MAX, FAR_SIZE_GAMMA = 0.4, 1.4, 2.2  # POINTS, x SCALE below
FAR_GLOW_SCALE = 3.0

# Spectral ramp — mirrors STAR_CHROMA in starfield-optics.ts
CHROMA = [
    ("#9BB0FF", 0.15),
    ("#CAD7FF", 0.25),
    ("#FFFFFF", 0.30),
    ("#FFF4E8", 0.20),
    ("#FFD2A1", 0.10),
]

# ── Layers 8-9 · grain + vignette ─────────────────────────────────────────────
GRAIN_ALPHA = 0.018   # 1.8% — below this banding survives, above it reads grainy
VIGNETTE_MAX = 0.20
VIGNETTE_CENTRE_Y = 0.40

SEED = 20260808


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def pick_chroma(r, brightness=0.0):
    """Mirrors starChroma(): brighter stars bias toward the blue end."""
    t = r * (1 - 0.25 * brightness)
    acc = 0.0
    for hexcode, weight in CHROMA:
        acc += weight
        if t <= acc:
            return hex_rgb(hexcode)
    return hex_rgb(CHROMA[-1][0])


def radial_bloom(size, colour, peak_alpha, cx, cy, radius):
    """One nebula bloom as an RGBA layer, drawn small then upscaled — a huge
    smooth gradient at full res is slow and bands; a blurred small one doesn't."""
    w, h = size
    small = max(1, w // 8), max(1, h // 8)
    layer = Image.new("RGBA", small, (0, 0, 0, 0))
    px = layer.load()
    scx, scy = cx * small[0], cy * small[1]
    srad = radius * max(small)
    r, g, b = colour
    for y in range(small[1]):
        for x in range(small[0]):
            d = math.hypot(x - scx, y - scy) / srad
            if d >= 1.0:
                continue
            # smooth falloff, not linear
            a = (1.0 - d) ** 2.2
            px[x, y] = (r, g, b, int(255 * peak_alpha * a))
    return layer.resize((w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(w / 90))


def value_noise(size, feature_px, rnd):
    """2-octave value noise via upscaled random fields."""
    w, h = size
    out = Image.new("L", size, 0)
    for octave, weight in ((1, 0.65), (2, 0.35)):
        cells = (max(2, int(w / feature_px * octave)), max(2, int(h / feature_px * octave)))
        small = Image.new("L", cells)
        small.putdata([rnd.randint(0, 255) for _ in range(cells[0] * cells[1])])
        big = small.resize(size, Image.BICUBIC)
        out = ImageChops.add(out, big.point(lambda v, wt=weight: int(v * wt)))
    return out.filter(ImageFilter.GaussianBlur(feature_px / 10))


def draw_star(draw, x, y, size, alpha, colour, glow_scale):
    """Gamma falloff: blazing core, steep decay, long tail. Concentric discs
    approximate the four-stop gradient from glowStops()."""
    r, g, b = colour
    radius = max(size * glow_scale, 1.0)
    steps = 7
    for i in range(steps, 0, -1):
        t = i / steps
        # matches glowStops(): ~75% of alpha gone by 18% of the radius
        a = alpha * (0.25 if t > 0.45 else 1.0) * ((1.0 - t) ** 2.6)
        if a <= 0.002:
            continue
        rr = radius * t
        draw.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(r, g, b, int(255 * min(a, 1))))
    core = max(size * 0.42, 0.4)
    draw.ellipse([x - core, y - core, x + core, y + core],
                 fill=(r, g, b, int(255 * min(alpha * 1.15, 1))))


def bake():
    rnd = random.Random(SEED)
    img = Image.new("RGB", (WIDTH, HEIGHT), VOID)

    # 2 · nebulosity
    for hexcode, alpha, cx, cy, rad in NEBULAE:
        img = Image.alpha_composite(
            img.convert("RGBA"),
            radial_bloom((WIDTH, HEIGHT), hex_rgb(hexcode), alpha, cx, cy, rad),
        ).convert("RGB")

    # 3 · dust, soft-light-ish (screen at low alpha reads the same on near-black)
    dust = value_noise((WIDTH, HEIGHT), DUST_FEATURE_PX, rnd).convert("RGB")
    img = Image.blend(img, ImageChops.screen(img, dust), DUST_ALPHA)

    # 4 · far field
    stars = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(stars)
    buckets = [0, 0, 0, 0]
    for _ in range(FAR_STAR_COUNT):
        x, y = rnd.random() * WIDTH, rnd.random() * HEIGHT
        ra = rnd.random()
        alpha = FAR_ALPHA_FLOOR + (FAR_ALPHA_CEIL - FAR_ALPHA_FLOOR) * (ra ** FAR_ALPHA_GAMMA)
        size = (FAR_SIZE_MIN + (FAR_SIZE_MAX - FAR_SIZE_MIN)
                * (rnd.random() ** FAR_SIZE_GAMMA)) * SCALE
        bright = (alpha - FAR_ALPHA_FLOOR) / (FAR_ALPHA_CEIL - FAR_ALPHA_FLOOR)
        draw_star(draw, x, y, size, alpha, pick_chroma(rnd.random(), bright), FAR_GLOW_SCALE)
        buckets[min(3, int(bright * 4))] += 1
    img = Image.alpha_composite(img.convert("RGBA"), stars).convert("RGB")

    # 9 · vignette
    vig = Image.new("L", (WIDTH, HEIGHT), 0)
    vpx = vig.load()
    cx, cy = WIDTH / 2, HEIGHT * VIGNETTE_CENTRE_Y
    maxd = math.hypot(max(cx, WIDTH - cx), max(cy, HEIGHT - cy))
    step = 4  # compute coarse, blur back — a per-pixel hypot at 3.6MP is slow
    for y in range(0, HEIGHT, step):
        for x in range(0, WIDTH, step):
            d = math.hypot(x - cx, y - cy) / maxd
            v = int(255 * VIGNETTE_MAX * (d ** 2))
            for yy in range(y, min(y + step, HEIGHT)):
                for xx in range(x, min(x + step, WIDTH)):
                    vpx[xx, yy] = v
    vig = vig.filter(ImageFilter.GaussianBlur(step * 2))
    img = Image.composite(Image.new("RGB", (WIDTH, HEIGHT), (0, 0, 0)), img, vig)

    # 8 · grain — last, over everything, so it dithers the composite
    grain = Image.new("L", (WIDTH, HEIGHT))
    grain.putdata([rnd.randint(0, 255) for _ in range(WIDTH * HEIGHT)])
    img = Image.blend(img, ImageChops.overlay(img, grain.convert("RGB")), GRAIN_ALPHA)

    return img, buckets


def measure(img, buckets):
    """Print what we actually made. Eyeballing a PNG is not verification."""
    small = img.resize((img.width // 4, img.height // 4), Image.LANCZOS)
    px = list(small.getdata())
    luma = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]
    mean_luma = sum(luma) / len(luma)

    # Weight each pixel by its own luminance, so the measurement reflects the
    # colour of the LIGHT rather than the colour of the void it sits in.
    bands, bh = [], small.height // 8
    for i in range(8):
        seg = px[i * bh * small.width:(i + 1) * bh * small.width]
        if not seg:
            continue
        wsum = sum(max(1e-6, 0.2126 * r + 0.7152 * g + 0.0722 * b) for r, g, b in seg)
        br = sum((p[2] - p[0]) * max(1e-6, 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
                 for p in seg) / wsum
        bands.append(br)
    spread = max(bands) - min(bands)

    dark = [l for l in luma if l < 40]
    levels = len(set(int(l) for l in dark))

    print(f"  size                 {img.width} x {img.height}")
    print(f"  mean luma            {mean_luma:.1f} / 255")
    print(f"  colour-temp spread   {spread:.1f} units of B-R across 8 bands")
    print(f"  distinct dark levels {levels}")
    print(f"  far stars by decile  faint {buckets[0]}  {buckets[1]}  {buckets[2]}  bright {buckets[3]}")
    return mean_luma, spread, buckets


def bake_grain_tile(rnd):
    """Symmetric dither tile: white and black speckle around neutral."""
    tile = Image.new("RGBA", (GRAIN_TILE_PX, GRAIN_TILE_PX))
    px = tile.load()
    for y in range(GRAIN_TILE_PX):
        for x in range(GRAIN_TILE_PX):
            v = rnd.uniform(-1.0, 1.0)
            a = int(abs(v) * GRAIN_TILE_PEAK_ALPHA)
            px[x, y] = (255, 255, 255, a) if v > 0 else (0, 0, 0, a)
    return tile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats-only", action="store_true")
    args = ap.parse_args()

    print("Baking cosmic field...")
    img, buckets = bake()
    print("\nMeasured:")
    mean_luma, spread, buckets = measure(img, buckets)

    # Assertions — the bake fails loudly rather than shipping something off-spec.
    problems = []
    if not (WIDTH >= 1290 and HEIGHT >= 2796):
        problems.append(f"resolution {WIDTH}x{HEIGHT} below the @3x floor 1290x2796")
    if mean_luma > 30:
        problems.append(f"mean luma {mean_luma:.1f} too bright for a void ground (want <= 30)")
    if spread < 4:
        problems.append(f"colour-temp spread {spread:.1f} too uniform (want >= 4) — reads synthetic")
    if buckets[0] <= buckets[3]:
        problems.append("far field is not power-law: faintest bucket should hold the most stars")
    if problems:
        print("\nFAILED:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("\n  all assertions passed")

    if args.stats_only:
        print("\n(--stats-only: nothing written)")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    kb = os.path.getsize(OUT) / 1024
    mp = (WIDTH * HEIGHT) / 1e6
    print(f"\nWrote {OUT}  —  {kb:.0f} KB  ({kb / mp:.0f} KB/megapixel)")

    tile = bake_grain_tile(random.Random(SEED + 1))
    tile.save(GRAIN_TILE_OUT, "PNG", optimize=True)
    # Assert it really is neutral, or it will tint the entire app.
    px = list(tile.getdata())
    signed = sum((1 if p[0] > 128 else -1) * p[3] for p in px) / len(px)
    if abs(signed) > 0.6:
        sys.exit(f"grain tile is not neutral (mean signed alpha {signed:.2f}) — it would tint the UI")
    print(f"Wrote {GRAIN_TILE_OUT}  —  {os.path.getsize(GRAIN_TILE_OUT) / 1024:.1f} KB, "
          f"{GRAIN_TILE_PX}x{GRAIN_TILE_PX}, mean signed alpha {signed:+.2f}")


if __name__ == "__main__":
    main()
