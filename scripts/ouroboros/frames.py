"""
Every score is authored art now, not a rig.

The rig unrolled the serpent into a flat strip and bent it back onto a circle at
runtime. That works geometrically and fails artistically: a flat band has no
self-overlap, no coil perspective and no volumetric light, so the score-100
render -- which has all three -- read as a different animal from every other
score. The owner's words were "it just looks like two completely different
snakes," and he was describing two literally different renderers.

So the finish is the beginning: one authored frame per score step, all of them
generated against the score-100 master as a style reference, and all of them
normalised HERE onto one circle so the hero can step between them without the
body jumping.

This module owns that normalisation. It is deliberately the same maths finale.py
used for the single bite frame -- ray-cast the ring, least-squares fit its
centreline, recentre, rotate, scale -- generalised to a partial serpent whose
arc does not close.

## The one number that matters

RING_FRAC is the centreline radius as a fraction of the frame box. Every frame
is scaled so its body rides that circle. Get this wrong per-frame and adjacent
frames pop radially, which is the exact defect this whole ticket exists to kill.

It is 0.38714 because that is what the master already has: bake.py normalised
the bite to `profile.ring_radius` (396.43 in a 1024 frame) and shipped it. So
the master is canonical BY DEFINITION and needs no geometric change -- only a
re-bake from 792 to 1024, which also retires the 1.36x upscale it has been
suffering (bake.py:28 sized it for a 792px box the hero stopped drawing at).

Anchoring on the master rather than on the rig's `INNER_ANCHOR` is deliberate:
the frame the owner likes is the one thing in here that must not be touched by
a transform.
"""
from PIL import Image, ImageFilter
import numpy as np
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "assets", "images", "ouroboros-frames")
# QC output stays OUT of the shipped-asset dir and rides the existing
# `proof-*.png` gitignore, so a contact sheet can never be mistaken for a frame
# the app loads.
PROOF_DIR = HERE

N = 1024                      # authored frame size; ~981px is what the hero draws at 3x
C = N / 2
RING_FRAC = 0.38714           # centreline radius / frame width. See the docstring.
RING_R = RING_FRAC * N        # 396.43 in a 1024 frame

ALPHA_HIT = 40 / 255.0        # a texel counts as body above this
R_MIN, R_MAX = 0.18, 0.497    # ray search band, as fractions of the frame

# Where each authored frame's HEAD sits, degrees clockwise from twelve o'clock,
# measured off the shipped art by `measure_head_angles`. Recorded rather than
# derived at import because it costs a full ray-cast of nine 1024px frames, and
# because the raw plates that produced this spacing were destroyed -- these nine
# numbers are now the only record of it.
#
# They are NOT evenly spaced (+18, +51, +23, +59, +20, +68, +19, +20), which is
# the larger half of the "choppy" the owner reported. `FRAME_HEAD_DEG` in
# src/components/ui/ouroboros-frames.ts must agree; the asset check enforces it.
#
# The value is the SPAN the body sweeps from its tail, not the index of the last
# covered degree -- one degree apart, and the span is the one that does not move
# when a frame's tail is re-anchored.
#
# 95 was added later (the tenth frame). Its slot is NOT on the 10-point grid,
# which is why FRAME_SCORES below is an explicit list rather than a range: the
# frame exists to narrow the jump into the finale, and the only place it can sit
# is between 90 and 100. Measured at 356, not the 350 that was asked for --
# `measure_arc`'s docstring is right that the models ignore a requested arc, and
# 356 is the better number anyway (a 4-degree step into the bite instead of 20).
HEAD_DEG = {20: 82, 30: 100, 40: 151, 50: 174, 60: 233, 70: 253, 80: 321,
            90: 340, 95: 356, 100: 360}


# ---------------------------------------------------------------- keying

def key_alpha(rgb):
    """Cut the render's black background to alpha.

    The plates come back as opaque RGB on black, so the brightest channel IS
    the coverage -- gold and cyan both sit far above the background, and a
    max() key keeps the glow's soft edge instead of hard-clipping it the way a
    threshold would. Same key finale.py used; kept identical so the master
    re-bakes byte-comparably.
    """
    arr = np.asarray(rgb, dtype=np.uint8)
    return np.dstack([arr, arr.max(axis=2)])


# ---------------------------------------------------------------- ring fitting

def ring_stats(alpha, cx=C, cy=C):
    """Ray-cast 360 spokes; return per-degree centreline radius and thickness.

    Degrees with three or fewer hits are omitted rather than zero-filled, which
    is what lets a PARTIAL serpent through: the uncovered arc simply has no
    entries, and every consumer below reads the key set rather than assuming
    360 of them.
    """
    n = alpha.shape[0]
    rmin, rmax = n * R_MIN, n * R_MAX
    steps = 400
    mid, th = {}, {}
    for deg in range(360):
        ang = math.radians(deg - 90)          # -90 so 0deg is twelve o'clock
        ca, sa = math.cos(ang), math.sin(ang)
        hits = []
        for j in range(steps):
            r = rmin + (rmax - rmin) * j / (steps - 1)
            x, y = int(cx + r * ca), int(cy + r * sa)
            if 0 <= x < n and 0 <= y < n and alpha[y, x] > ALPHA_HIT * 255:
                hits.append(r)
        if len(hits) > 3:
            mid[deg] = (hits[0] + hits[-1]) / 2
            th[deg] = hits[-1] - hits[0]
    return mid, th


def fit_circle(mid, cx=C, cy=C):
    """Least-squares circle through the centreline samples -> (dx, dy, radius)."""
    pts = np.array([(cx + r * math.cos(math.radians(d - 90)),
                     cy + r * math.sin(math.radians(d - 90)))
                    for d, r in mid.items()])
    if len(pts) < 3:
        raise ValueError(f"ring fit needs 3+ samples, got {len(pts)}")
    m = np.c_[2 * pts[:, 0], 2 * pts[:, 1], np.ones(len(pts))]
    a, b, c0 = np.linalg.lstsq(m, (pts ** 2).sum(axis=1), rcond=None)[0]
    return a, b, math.sqrt(c0 + a * a + b * b)


# ------------------------------------------------- robust ring registration
#
# `fit_circle` above is fine for a long arc and WRONG for a short one, in two
# separate ways that both shipped in NEX-338 as frames 20 and 30 sitting off
# the shared circle by 30px and 18px -- a ~10pt jump at hero size, every time
# the score crossed 40.
#
#  1. A circle fit through an 84-degree arc is ill-conditioned. Centre and
#     radius trade off against each other along a degenerate direction, so the
#     fit slides the centre tens of pixels and still reports a small residual.
#  2. `ring_stats` takes `(hits[0] + hits[-1]) / 2`, which assumes a ray crosses
#     the body exactly once. The scale texture is not solid alpha, so a ray
#     crosses it dozens of times and that midpoint is noise.
#
# The fix for (2) is to close the filigree holes before measuring. The fix for
# (1) is to stop asking a short arc a question it cannot answer: pin the radius
# to RING_R -- which is a DESIGN CONSTANT every frame is meant to share, not
# something to be recovered per frame -- and solve only for the centre.

CLOSE_PX = 9          # morphological close width; spans the filigree gaps
PINNED_BELOW_DEG = 140  # arcs shorter than this cannot determine their own radius

# How much worse a frame may sit against the CANONICAL circle than against its
# own best fit before it counts as misregistered. The gap, not the absolute
# residual, is the signal: the art wobbles 3-23px about its own circle by hand,
# and that is style. 4px is ~1.3pt at hero size -- below where a jump reads.
REGISTRATION_TOL = 4.0


def solid_mask(alpha):
    """Alpha with the scale-texture holes closed, so a ray crosses the body once."""
    m = Image.fromarray((alpha > ALPHA_HIT * 255).astype(np.uint8) * 255)
    m = m.filter(ImageFilter.MaxFilter(CLOSE_PX)).filter(ImageFilter.MinFilter(CLOSE_PX))
    return np.asarray(m) > 127


def centreline(mask, cx=C, cy=C, steps=500):
    """Per-degree centreline points of the body as an (n, 2) array of (x, y).

    Takes the LONGEST contiguous run along each ray -- the body -- so a detached
    glint or the far side of a coil cannot drag the sample.
    """
    n = mask.shape[0]
    rmin, rmax = n * R_MIN, n * R_MAX
    pts = []
    for deg in range(360):
        ang = math.radians(deg - 90)
        ca, sa = math.cos(ang), math.sin(ang)
        runs, cur = [], []
        for j in range(steps):
            r = rmin + (rmax - rmin) * j / (steps - 1)
            x, y = int(cx + r * ca), int(cy + r * sa)
            if 0 <= x < n and 0 <= y < n and mask[y, x]:
                cur.append(r)
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        runs = [r for r in runs if len(r) > 2]
        if runs:
            best = max(runs, key=len)
            m = (best[0] + best[-1]) / 2
            pts.append((cx + m * ca, cy + m * sa))
    return np.array(pts)


def fit_centre_pinned(pts, radius=RING_R, start=(C, C), iters=400, lr=0.8):
    """Centre of a circle of KNOWN radius through the points, by descent.

    With the radius pinned this is well-conditioned even on an 84-degree arc,
    which is the whole point -- it is the question a short arc CAN answer.
    """
    c = np.array(start, dtype=float)
    for _ in range(iters):
        d = pts - c
        n = np.linalg.norm(d, axis=1)
        n = np.where(n < 1e-9, 1e-9, n)
        c -= lr * (-2.0 * ((n - radius)[:, None] * (d / n[:, None])).sum(axis=0) / len(pts))
    return float(c[0]), float(c[1])


def ring_residual(pts, cx, cy, r):
    """RMS distance of the centreline from a given circle, in pixels."""
    return float(np.sqrt(np.mean((np.linalg.norm(pts - np.array([cx, cy]), axis=1) - r) ** 2)))


def fit_ring(alpha, start=(C, C), passes=4):
    """Best (cx, cy, radius) for a serpent's centreline, short arcs included.

    Re-measures from each new centre because the rays move with it; a single
    pass fits a circle to samples taken about the wrong origin.
    """
    mask = solid_mask(alpha)
    cx, cy = start
    pts = centreline(mask, cx, cy)
    pinned = len(pts) < PINNED_BELOW_DEG
    r = RING_R
    for _ in range(passes):
        if pinned:
            cx, cy = fit_centre_pinned(pts, RING_R, (cx, cy))
        else:
            m = np.c_[2 * pts[:, 0], 2 * pts[:, 1], np.ones(len(pts))]
            a, b, c0 = np.linalg.lstsq(m, (pts ** 2).sum(axis=1), rcond=None)[0]
            cx, cy, r = a, b, math.sqrt(c0 + a * a + b * b)
        pts = centreline(mask, cx, cy)
    return cx, cy, r, pts


def _smooth_ring(values, win=15):
    """Circular moving average, so one stray bright texel cannot win a vote."""
    deg = np.arange(360)
    v = np.array([values.get(int(d), 0.0) for d in deg], dtype=float)
    half = win // 2
    k = np.ones(win) / win
    return np.convolve(np.r_[v[-half:], v, v[:half]], k, mode="valid")


# Plates whose automatic head/tail call is known WRONG, by filename.
#
# Three separate heuristics were tried and all three are unreliable on a SHORT
# arc, which is exactly where it matters:
#
#   - thickness at the endpoint, read through `_smooth_ring`: margins collapsed to
#     3.6 and 2.1 on a scale where a confident call is ~30, because the smoother
#     zero-fills the gap and drags both ends down.
#   - mean thickness over the first/last dozen covered degrees: better (7.9, 6.6)
#     but still not separating, because a short serpent's head is a compact skull
#     that can read THINNER radially than the body behind it.
#   - gold brightness in a wedge at each end, hunting the eye: 1.00 ratio on the
#     shortest frame. The whole animal is saturated gold; the eye does not stand
#     out at any percentile tested.
#
# The call decides whether the plate gets mirrored, so getting it wrong faces the
# serpent backwards -- which the owner caught on three frames by eye in seconds.
#
# So it is recorded rather than inferred. `proof-headtail.png` renders every
# shipped frame with the detected head and tail marked, which is how this list was
# built and how it is re-checked. Nine frames is a small enough set that a looked-at
# answer beats a clever one.
FLIP_ENDS = {
    "x10a.png",   # slot 20
    "yg1.png",    # slot 30
    "w30a.png",   # slot 50
}

# Slots where the owner rejected the automatic pick and named the replacement.
#
# The cost function ranks arc accuracy and body mass, which are the two things
# it can measure. It cannot see a rendering defect or an off-model head, and
# both turned up in plates that scored well:
#
#   60: p063 won on arc (61.8) and mass (0.164) but has a washed-out patch
#       through the upper body -- "some of his middle section is missing or
#       blurred out".
#   70: t025 won on the same grounds and carries both a faded section and a
#       small malformed skull -- "looks like a totally different snake".
#
# Replacements are the best-looking plate still inside the arc tolerance:
# t050 is the cleanest at 60 and the thickest available, and w80a has a
# properly formed fanged head and keeps the thickness ramp climbing where
# p073 (0.148) would have dipped it.
PIN_PLATES = {
    60: "t050.png",
    70: "w80a.png",
}


def arc_ends(th, plate=None):
    """Describe a partial serpent's arc, or None if the ring closes.

    Returns (tail_deg, head_deg, span_deg, clockwise).

    Degrees increase CLOCKWISE from twelve o'clock: `ring_stats` casts its ray
    at `radians(deg - 90)`, so deg 0 is straight up and deg 90 is to the right.

    ## The span is the BODY, not the gap

    This got the wrong answer first time round, and visibly: a plate whose
    serpent wraps 325 degrees with a small opening at the top measured as a
    17-degree arc, because the code found the two ends correctly and then took
    the short way between them. The body is the COVERED degrees; the gap is
    everything else. Counting coverage directly is unambiguous and needs no
    reasoning about which way round to walk.

    ## Direction is not guaranteed and must be measured

    The art direction says the body grows CLOCKWISE from the tail (CLAUDE.md
    §2), but a generated plate obeys that only by luck -- the models return
    either handedness. So detect it and let the caller mirror, rather than
    silently binning a frame that runs the wrong way and shipping a serpent that
    reverses direction halfway up the score.
    """
    covered = sorted(th.keys())
    if len(covered) >= 358:
        return None                                    # closed ring: the bite
    if len(covered) < 3:
        return None

    # Largest uncovered run, wrapping the 0/359 seam.
    gaps, run_start = [], None
    for d in range(360):
        empty = d not in th
        if empty and run_start is None:
            run_start = d
        elif not empty and run_start is not None:
            gaps.append((run_start, d - 1))
            run_start = None
    if run_start is not None:
        gaps.append((run_start, 359))
    if len(gaps) > 1 and gaps[0][0] == 0 and gaps[-1][1] == 359:
        gaps = [(gaps[-1][0], gaps[0][1] + 360)] + gaps[1:-1]
    if not gaps:
        return None
    gap = max(gaps, key=lambda g: g[1] - g[0])

    start = (gap[1] + 1) % 360        # body resumes here, walking clockwise
    end = (gap[0] - 1) % 360          # body stops here
    span = float(len(covered))        # the body IS the covered degrees

    # WHICH END IS THE HEAD. This decides the growth direction, which decides
    # whether the plate gets mirrored, so getting it wrong flips the animal
    # round and the serpent faces backwards. The owner caught exactly that on
    # two frames.
    #
    # The first cut asked `_smooth_ring(th)` for its value AT each endpoint. That
    # smoother zero-fills uncovered degrees, so at an arc END its 15-wide window
    # straddles the gap and drags the reading down -- by a different amount at
    # each end, depending on how the body happens to sit. Margins collapsed to
    # 3.6 and 2.1 on a scale where a confident call is ~30, i.e. a coin flip.
    #
    # Walk inward over COVERED degrees only, and compare the profiles. A tail
    # tapers to a point, so it stays thin for a good many degrees; a head is a
    # blunt skull that is already full-width at its tip.
    ordered = []
    d = start
    for _ in range(len(covered)):
        if d in th:
            ordered.append(th[d])
        d = (d + 1) % 360
    k = max(3, min(12, len(ordered) // 3))
    near_start = float(np.mean(ordered[:k]))
    near_end = float(np.mean(ordered[-k:]))

    head_at_end = near_end >= near_start
    if plate is not None and os.path.basename(plate) in FLIP_ENDS:
        head_at_end = not head_at_end
    if head_at_end:
        # walking clockwise from `start` reaches the head last -> grows clockwise
        return start, end, span, True
    return end, start, span, False


# ---------------------------------------------------------------- normalise

def normalise(src, verbose=True, label=""):
    """Put an authored plate on the canonical circle.

    Recentre on the fitted circle, rotate so the TAIL sits at twelve o'clock
    (the anchor the art direction fixes; the head is wherever the score puts
    it), then scale the fitted centreline to RING_R.

    Anchoring on the tail rather than the head matters: the tail is the fixed
    end of the animal, so a frame whose generated arc came back a few degrees
    long stays registered with its neighbours instead of sliding the whole body
    round to compensate.
    """
    im = Image.open(src).convert("RGB")
    if im.size != (N, N):
        im = im.resize((N, N), Image.LANCZOS)

    a = np.asarray(im, dtype=np.uint8).max(axis=2)
    # `fit_ring` re-measures from each new centre and pins the radius on short
    # arcs; the plain `fit_circle` used here through NEX-338 put frames 20 and
    # 30 tens of pixels off the shared circle. See the block above it.
    fx, fy, r, _ = fit_ring(a)

    im = im.transform((N, N), Image.AFFINE, (1, 0, fx - C, 0, 1, fy - C),
                      resample=Image.BICUBIC)
    a = np.asarray(im, dtype=np.uint8).max(axis=2)
    mid, th = ring_stats(a)

    ends = arc_ends(th, plate=src)
    if ends is None:
        # closed ring: no tail to find, so register on the head like finale did
        found = float(np.argmax(_smooth_ring(th)))
        rotate_by = found - 0.0
        anchor = f"head {found:.0f}deg -> 0"
    else:
        tail_deg, head_deg, span, clockwise = ends
        if not clockwise:
            # Mirror so every frame grows the same way. A plate that runs
            # counter-clockwise is not wrong art -- the models return either
            # handedness -- but a set that mixes them would have the serpent
            # reverse direction partway up the score. Mirroring is safe on this
            # subject: the body is a filigree tube and the head is in profile,
            # and the lighting is re-levelled downstream anyway.
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
            a = np.asarray(im, dtype=np.uint8).max(axis=2)
            mid, th = ring_stats(a)
            tail_deg, head_deg, span, clockwise = arc_ends(th, plate=src)
        rotate_by = float(tail_deg)
        anchor = f"tail {tail_deg:.0f}->0, head {head_deg:.0f}, span {span:.0f}deg"

    if abs(rotate_by) > 1e-3:
        im = im.rotate(rotate_by, resample=Image.BICUBIC, center=(C, C))

    s = RING_R / r
    if abs(s - 1.0) > 1e-3:
        n2 = max(8, int(round(N * s)))
        sm = im.resize((n2, n2), Image.LANCZOS)
        canvas = Image.new("RGB", (N, N), (0, 0, 0))
        if n2 <= N:
            canvas.paste(sm, ((N - n2) // 2, (N - n2) // 2))
        else:
            off = (n2 - N) // 2
            canvas.paste(sm.crop((off, off, off + N, off + N)), (0, 0))
        im = canvas

    if verbose:
        print(f"  {label:<14} ring R {r:6.1f} -> {RING_R:.1f} (x{s:.3f})   {anchor}")

    return Image.fromarray(key_alpha(im), "RGBA")


# ---------------------------------------------------------------- measuring

def measure_arc(src):
    """How far round the ring a plate's serpent actually reaches, in degrees.

    Needed because the image models do NOT obey a requested arc length. Asked
    for 40% of a circle they return anywhere from 180 to 330 degrees, and no
    amount of prompt precision fixed it in testing. So the pipeline stops
    trusting the prompt: generate, MEASURE, and bin each plate against the score
    whose arc it actually matches. The prompt becomes a nudge rather than a
    contract.

    Returns (span_deg, thickness_ratio, clockwise). `thickness_ratio` is the
    body's mean half-width over the ring radius, which is how a frame is checked
    for the §1.5 Law C requirement that a short serpent reads as SMALL rather
    than as a fat crescent.
    """
    im = Image.open(src).convert("RGB")
    if im.size != (N, N):
        im = im.resize((N, N), Image.LANCZOS)

    # RECENTRE FIRST, exactly as normalise() does, or the number is a lie.
    # A generated plate is rarely centred, and an off-centre arc subtends a
    # different angle about the frame's middle than it does about its own. The
    # first cut measured the raw plate and binned on that: slots 20 and 30 came
    # back at 96 and 97 degrees -- two frames of visibly identical length,
    # because their true spans had been read as 73 and 102. Measure what
    # normalise will actually produce.
    a = np.asarray(im, dtype=np.uint8).max(axis=2)
    mid, th = ring_stats(a)
    if len(mid) < 3:
        return 0.0, 0.0, True
    fx, fy, _ = fit_circle(mid)
    im = im.transform((N, N), Image.AFFINE, (1, 0, fx - C, 0, 1, fy - C),
                      resample=Image.BICUBIC)
    a = np.asarray(im, dtype=np.uint8).max(axis=2)
    mid, th = ring_stats(a)
    if len(mid) < 3:
        return 0.0, 0.0, True

    ends = arc_ends(th, plate=src)
    span = 360.0 if ends is None else ends[2]
    clockwise = True if ends is None else ends[3]

    _, _, r = fit_circle(mid)
    half = float(np.median(list(th.values()))) / 2.0
    return span, (half / r if r > 0 else 0.0), clockwise


def score_for_span(span):
    """Invert the rig's arc model: which score does this much arc represent?

    MAX_HEAD_DEG was spanDeg(358.5) + OVERLAP(20) = 378.5 in the rig, and the
    frames inherit that mapping so a frame's arc means the same thing it always
    did.
    """
    return max(0.0, min(100.0, 100.0 * span / 378.5))


# ---------------------------------------------------------------- level match

def gold_level(rgba):
    """A frame's brightness reference: the MEDIAN of covered luminance.

    Not a high percentile, and this was measured rather than assumed: on the two
    authored plates the repo already has, p99 is 255.0 for both -- the gold
    highlights are blown, so any upper percentile saturates and reports every
    frame as identical no matter how differently exposed it is. The median
    separates them properly (119.0 vs 121.0) and is immune to both the blown
    highlights and to how much of the frame the serpent covers, which changes by
    design as the score rises.
    """
    arr = np.asarray(rgba, dtype=np.float32)
    lum = arr[:, :, :3].max(axis=2)
    covered = lum[arr[:, :, 3] > 40]
    if covered.size == 0:
        return 0.0
    return float(np.median(covered))


def level_match(frames, target=None):
    """Scale each frame's RGB so the set shares one brightness.

    Without this, adjacent frames flicker: the generator has no reason to
    return two plates at the same exposure, and a step between them reads as
    the serpent pulsing rather than growing.
    """
    levels = [gold_level(f) for f in frames]
    if target is None:
        target = float(np.median([l for l in levels if l > 0])) if any(levels) else 0.0
    out = []
    for f, l in zip(frames, levels):
        if l <= 0 or target <= 0:
            out.append(f)
            continue
        arr = np.asarray(f, dtype=np.float32)
        arr[:, :, :3] = np.clip(arr[:, :, :3] * (target / l), 0, 255)
        out.append(Image.fromarray(arr.astype(np.uint8), "RGBA"))
    return out, target


# ---------------------------------------------------------------- QC output

def contact_sheet(frames, labels, cols=5, cell=256, path=None):
    """One image of the whole set. Identity drift is only visible side by side."""
    rows = (len(frames) + cols - 1) // cols
    pad = 18
    sheet = Image.new("RGB", (cols * cell, rows * (cell + pad)), (6, 6, 12))
    for i, (f, lab) in enumerate(zip(frames, labels)):
        x, y = (i % cols) * cell, (i // cols) * (cell + pad)
        sheet.paste(f.resize((cell, cell), Image.LANCZOS).convert("RGB"), (x, y + pad))
        _label(sheet, x + 6, y + 4, str(lab))
    if path:
        sheet.save(path)
    return sheet


def flipbook(frames, path, size=384, ms=110):
    """The set as an animation. Jitter and pacing do not show in a still."""
    seq = [f.resize((size, size), Image.LANCZOS).convert("RGB") for f in frames]
    seq[0].save(path, save_all=True, append_images=seq[1:], duration=ms, loop=0)
    return path


def _label(img, x, y, text):
    from PIL import ImageDraw
    ImageDraw.Draw(img).text((x, y), text, fill=(229, 186, 110))


# ---------------------------------------------------------------- emit

FRAME_STEP = 10
FIRST_FRAME_SCORE = 20
# Explicit, not a range: score 95 is off the 10-point grid. See HEAD_DEG.
FRAME_SCORES = [20, 30, 40, 50, 60, 70, 80, 90, 95, 100]
PROXY_PX = 384               # motion set; see the manifest note
WEBP_QUALITY = 85

MANIFEST = os.path.join(ROOT, "src", "components", "ui", "ouroboros-frame-sources.ts")


def emit(by_score, quality=WEBP_QUALITY):
    """Write the shipped frame set and the require() manifest.

    Two resolutions per score. The full-res frame is what the hero rests on;
    the 384px proxy is what the flipbook plays while the score travels. That
    split is a memory decision, not a quality one -- twenty 1024px frames are
    ~84MB decoded if they are ever all live at once, where the proxy set is
    ~11.8MB and can stay warm for the whole session. Motion hides the softness,
    and the hero swaps to the full-res frame the moment it settles.

    WebP with alpha, verified supported on this stack: `webp` is in Metro's
    default assetExts and SkWebpCodec is present in every slice of the shipped
    Skia xcframework, including ios-arm64.
    """
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = []
    for score in FRAME_SCORES:
        img = by_score[score]
        full = os.path.join(OUT_DIR, f"frame-{score:03d}.webp")
        prox = os.path.join(OUT_DIR, f"proxy-{score:03d}.webp")
        img.save(full, "WEBP", quality=quality, method=6)
        img.resize((PROXY_PX, PROXY_PX), Image.LANCZOS).save(
            prox, "WEBP", quality=quality, method=6)
        rows.append((score, os.path.getsize(full), os.path.getsize(prox)))

    full_kb = sum(r[1] for r in rows) / 1024
    prox_kb = sum(r[2] for r in rows) / 1024
    print(f"\n{'score':>6} {'full KB':>9} {'proxy KB':>9}")
    for score, f, p in rows:
        print(f"{score:>6} {f/1024:>9.1f} {p/1024:>9.1f}")
    print(f"{'TOTAL':>6} {full_kb:>9.1f} {prox_kb:>9.1f}   "
          f"= {(full_kb + prox_kb)/1024:.2f} MB shipped")

    # The heads are CUT FROM these frames, so they are not optional output --
    # leaving them behind ships a head sprite carved out of pixels that have
    # since moved, and the runtime rotates it about a centre its body no longer
    # shares. The asset guard cannot see that: both files exist and are the
    # right size. Regenerating the frames regenerates the heads, always.
    emit_heads(quality=quality)

    _write_manifest()
    return rows


def _write_manifest():
    lines = [
        "/**",
        " * GENERATED by scripts/ouroboros/frames.py -- do not edit by hand.",
        " *",
        " * Metro needs a STATIC string in every require(), so the frame set cannot be",
        " * indexed at runtime and has to be spelled out. Keeping it in its own file",
        " * means regenerating the art never touches hand-written code.",
        " *",
        " * Two resolutions: `FULL` is what the hero rests on, `PROXY` is the 384px set",
        " * drawn while the score travels. See emit() for why they are split.",
        " *",
        " * Two layers: the FRAME sets are whole authored serpents, and the HEAD sets are",
        " * the same frames cut back to head-and-neck (emit_heads). The hero draws a frame",
        " * clipped to a wedge, then a head rotated to where the score puts it.",
        " */",
        "",
        "export const OUROBOROS_FRAME_FULL = [",
    ]
    for s in FRAME_SCORES:
        lines.append(f"  require('@/assets/images/ouroboros-frames/frame-{s:03d}.webp'),")
    lines += ["] as const;", "", "export const OUROBOROS_FRAME_PROXY = ["]
    for s in FRAME_SCORES:
        lines.append(f"  require('@/assets/images/ouroboros-frames/proxy-{s:03d}.webp'),")
    lines += ["] as const;", "", "export const OUROBOROS_HEAD_FULL = ["]
    for s in FRAME_SCORES:
        lines.append(f"  require('@/assets/images/ouroboros-frames/head-{s:03d}.webp'),")
    lines += ["] as const;", "", "export const OUROBOROS_HEAD_PROXY = ["]
    for s in FRAME_SCORES:
        lines.append(f"  require('@/assets/images/ouroboros-frames/headproxy-{s:03d}.webp'),")
    lines += [
        "] as const;",
        "",
        "/** The score each index represents. Mirrors FRAME_SCORES in ouroboros-frames.ts. */",
        "export const OUROBOROS_FRAME_SCORES = [" + ", ".join(str(s) for s in FRAME_SCORES) + "] as const;",
        "",
    ]
    with open(MANIFEST, "w") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {MANIFEST}")


RAW_DIR = os.path.join(HERE, "raw")


def build_from_raw(verbose=True):
    """Bin every generated plate against the score its arc ACTUALLY shows.

    The models do not honour a requested arc length -- see `measure_arc` -- so
    the prompt is a nudge and this is the contract. Measure each plate, convert
    its span to a score, and let it compete for the nearest slot. A plate wins
    its slot on arc accuracy first and thickness plausibility second.

    Returns (chosen, gaps): a score -> path map and the list of slots nothing
    landed near enough to fill. Gaps are the regeneration list, which is the
    whole point of measuring rather than trusting.
    """
    import glob

    plates = sorted(glob.glob(os.path.join(RAW_DIR, "*.png")))
    if not plates:
        print(f"no plates in {RAW_DIR}")
        return {}, list(FRAME_SCORES)

    measured = []
    for p in plates:
        try:
            span, thick, cw = measure_arc(p)
        except Exception as exc:
            print(f"  {os.path.basename(p):<28} unreadable: {exc}")
            continue
        measured.append((p, span, score_for_span(span), thick, cw))

    if verbose:
        print(f"{'plate':<30} {'span':>6} {'score':>6} {'thick':>7} {'dir':>4}")
        for p, span, sc, th, cw in sorted(measured, key=lambda m: m[2]):
            print(f"{os.path.basename(p):<30} {span:>6.0f} {sc:>6.0f} {th:>7.3f} "
                  f"{'CW' if cw else 'ccw':>4}")

    # A slot only accepts a plate whose measured score is within half a step,
    # so a frame never claims a score it does not actually depict.
    tol = FRAME_STEP / 2.0
    chosen, gaps = {}, []
    used = set()
    for score in FRAME_SCORES:
        if score == 100:
            continue                       # the master owns the finale
        pin = PIN_PLATES.get(score)
        if pin:
            hit = [m for m in measured if os.path.basename(m[0]) == pin]
            if hit:
                chosen[score] = hit[0][0]
                used.add(hit[0][0])
                continue
            print(f"  WARNING: pinned plate {pin} for slot {score} is missing")
        cands = [m for m in measured
                 if abs(m[2] - score) <= tol and m[0] not in used]
        if not cands:
            gaps.append(score)
            continue
        best = min(cands, key=lambda m: _cost(m, score))
        chosen[score] = best[0]
        used.add(best[0])

    if verbose:
        print(f"\nfilled {len(chosen)}/{len(FRAME_SCORES) - 1} partial slots")
        if gaps:
            print(f"GAPS still to generate: {gaps}")
        _report_ramp(chosen, measured)
    return chosen, gaps


def target_thickness(score):
    """The body half-width / ring radius a frame at this score SHOULD have.

    A short serpent is meant to read as small rather than fat -- that was
    settled in NEX-337 and it is a §1.5 Law C call, since a hero that visibly
    shrinks when the score falls is a verdict rendered as geometry. So thickness
    is a RAMP, not a constant, and a spread across the set is correct.

    What is NOT correct is a ramp that dips. On a flipbook a dip means the
    animal briefly slims as it grows, which reads as a wobble. Anchored at the
    master's measured 0.196 at score 100 and a slender 0.130 at the bottom.
    """
    lo, hi = 0.130, 0.196
    t = max(0.0, min(1.0, (score - FIRST_FRAME_SCORE) / (100.0 - FIRST_FRAME_SCORE)))
    return lo + (hi - lo) * t


def _cost(m, slot):
    """Rank a candidate for a slot: arc accuracy first, then body mass.

    Arc is primary because a frame that depicts the wrong length is simply the
    wrong frame. Thickness is secondary but real -- the first cut of this
    selector ignored it entirely and handed slots 50 and 60 to plates at 0.071
    and 0.096 against a master of 0.196, which is a different animal, which is
    the complaint this whole ticket exists to answer.
    """
    _, _, score, thick, _ = m
    arc_err = abs(score - slot) / max(1e-6, FRAME_STEP / 2.0)
    want = target_thickness(slot)
    mass_err = abs(thick - want) / want

    # Weight tuned by running it: at 1.5 the arc term still won outright and
    # slot 30 went to a plate at 0.086 against a 0.145 target -- a perfect arc
    # on a wisp. Arc error is already bounded by the tolerance gate above, so
    # mass can afford to dominate inside it. UNDER-thickness is penalised harder
    # than over: too fat still reads as the same animal, too thin does not.
    penalty = 5.0 if thick < want else 3.0
    return arc_err + penalty * mass_err


def _report_ramp(chosen, measured):
    """Print the thickness ramp and flag any dip."""
    by_path = {m[0]: m for m in measured}
    print(f"\n{'slot':>5} {'plate':<16} {'score':>6} {'thick':>7} {'want':>7}  ramp")
    prev = None
    for score in sorted(chosen):
        m = by_path[chosen[score]]
        th = m[3]
        flag = ""
        if prev is not None and th < prev - 1e-9:
            flag = "  DIP"
        prev = th
        print(f"{score:>5} {os.path.basename(m[0]):<16} {m[2]:>6.0f} {th:>7.3f} "
              f"{target_thickness(score):>7.3f}{flag}")


def build_final():
    """Ship the real set: bin the raw plates, normalise, level-match, emit.

    The master takes score 100 untouched by any geometric transform -- it is the
    frame the owner likes and the circle every other frame is registered to.
    """
    chosen, gaps = build_from_raw(verbose=True)
    if gaps:
        print(f"\nREFUSING to build: slots {gaps} have no plate. "
              f"A missing frame would ship as an out-of-range index.")
        return 1

    order = [s for s in FRAME_SCORES if s != 100]
    imgs = [normalise(chosen[s], label=str(s)) for s in order]
    imgs.append(normalise(os.path.join(HERE, "sources/serpent-bite.png"), label="100"))
    imgs, target = level_match(imgs)
    print(f"\nlevel-matched to {target:.1f}")

    by_score = dict(zip(FRAME_SCORES, imgs))
    emit(by_score)

    flip = os.path.join(PROOF_DIR, "proof-frames-flipbook.gif")
    flipbook(imgs, flip)
    sheet = os.path.join(PROOF_DIR, "proof-frames-contact.png")
    contact_sheet(imgs, [str(s) for s in FRAME_SCORES], cols=5, path=sheet)
    print(f"wrote {flip}\nwrote {sheet}")
    return 0


def build_provisional():
    """Fill the whole frame set from the two authored plates the repo owns.

    NOT shippable art. This exists so the runtime, the manifest, the asset
    guard and the on-device flipbook can all be built and verified BEFORE the
    19 new renders are generated -- the generation is blocked on credits, and
    everything downstream of it should not be.

    `serpent-growing.png` measures out at roughly score 94 (its head lands 356
    degrees round from the tail, against a 378.5 degree full sweep), so it
    stands in for every partial score and the real bite takes 100. Every slot
    is therefore a REAL authored serpent at the canonical radius -- the set is
    wrong about length, and right about everything the code touches.
    """
    print("PROVISIONAL frame set — placeholder art, real geometry\n")
    growing = normalise(os.path.join(HERE, "sources/serpent-growing.png"), label="growing")
    bite = normalise(os.path.join(HERE, "sources/serpent-bite.png"), label="bite")
    (growing, bite), _ = level_match([growing, bite])

    by_score = {s: (bite if s == 100 else growing) for s in FRAME_SCORES}
    rows = emit(by_score)

    flip = os.path.join(PROOF_DIR, "proof-frames-flipbook.gif")
    flipbook([by_score[s] for s in FRAME_SCORES], flip)
    sheet = os.path.join(PROOF_DIR, "proof-frames-contact.png")
    contact_sheet([by_score[s] for s in FRAME_SCORES],
                  [str(s) for s in FRAME_SCORES], path=sheet)
    print(f"wrote {flip}\nwrote {sheet}")
    return rows


# ---------------------------------------------------------------- self-check

def _selfcheck():
    """Prove the pipeline on the two authored frames the repo already owns.

    `ouroboros-bite.png` is the shipped score-100 master and
    `sources/serpent-growing.png` is an authored partial serpent. Between them
    they exercise both branches -- closed ring and open arc -- so the
    normalisation is verified before a single credit is spent on new art.
    """
    print(f"canonical ring radius {RING_R:.2f}px in a {N}px frame ({RING_FRAC})\n")
    cases = [
        (os.path.join(HERE, "sources/serpent-bite.png"), "bite/100"),
        (os.path.join(HERE, "sources/serpent-growing.png"), "growing"),
    ]
    frames, labels = [], []
    for path, label in cases:
        if not os.path.exists(path):
            print(f"  {label:<14} MISSING {path}")
            continue
        frames.append(normalise(path, label=label))
        labels.append(label)

    if not frames:
        return 1

    print("\nverifying every normalised frame lands on the same circle:")
    ok = True
    for f, lab in zip(frames, labels):
        a = np.asarray(f)[:, :, 3]
        cx, cy, r, _ = fit_ring(a)
        err = abs(r - RING_R)
        off = math.hypot(cx - C, cy - C)
        # CENTRE, not just radius. Through NEX-338 this checked the radius
        # alone, which is why frames 20 and 30 shipped 30px and 18px off the
        # shared circle with a clean selfcheck: a frame can sit on a circle of
        # exactly the right size in exactly the wrong place.
        flag = "ok" if err < 1.5 and off < 2.0 else "DRIFT"
        if flag == "DRIFT":
            ok = False
        print(f"  {lab:<14} R {r:7.2f}  err {err:5.2f}px  centre off {off:5.2f}px  {flag}")

    frames, target = level_match(frames)
    print(f"\nlevel-matched to {target:.1f}")
    for f, lab in zip(frames, labels):
        print(f"  {lab:<14} level {gold_level(f):6.1f}")

    sheet = os.path.join(PROOF_DIR, "proof-frames-selfcheck.png")
    contact_sheet(frames, labels, cols=2, path=sheet)
    print(f"\nwrote {sheet}")

    # And the set that actually ships, which the two masters above cannot speak
    # for. `register --apply` fixes anything this catches.
    if os.path.isdir(OUT_DIR):
        print("\nverifying every SHIPPED frame sits on the canonical circle:")
        for score, _, _, _, own, can, exc, _ in audit_registration(verbose=False):
            flag = "ok" if exc < REGISTRATION_TOL else "OFF-CIRCLE"
            if exc >= REGISTRATION_TOL:
                ok = False
            print(f"  score {score:<9} own {own:6.2f}px  canonical {can:6.2f}px  "
                  f"excess {exc:6.2f}px  {flag}")

    return 0 if ok else 1



# How far a frame's measured half-width may sit from the `target_thickness`
# ramp, as a fraction of the ring radius. Generous: the ramp is a design intent
# and the plates are hand-made, so the tolerance exists to catch a frame that is
# a DIFFERENT ANIMAL, not one that is a few pixels plump.
THICKNESS_TOL = 0.045

# How much a frame may slim relative to the one below it before it counts as the
# wobble `target_thickness` forbids.
#
# NOT zero. These are hand-made plates and a percent or two of measured wobble is
# the art's own noise, not a defect -- gating on any dip at all would red every
# build forever and teach everyone to ignore the check. Set above the measured
# noise floor (the shipped set dips 3%, 1% and 4%) and below what actually reads
# as the animal changing build.
DIP_TOL = 0.06


def body_thickness(alpha, span):
    """A frame's body thickness in px, excluding the head and the tail taper.

    The head is wider and differently shaped than the body, and a ray through it
    crosses jaw and skull as well, so including it measures the wrong thing.
    Everything from `span - NECK_DEG` forward is dropped for that reason.

    A high percentile rather than the max, because a single spoke that clips a
    coil overlap or a stray filament would otherwise set the number.
    """
    _, th = ring_stats(alpha)
    hi = max(span - NECK_DEG, 1.0)
    vals = sorted(t for d, t in th.items() if 0.0 <= d <= hi)
    if not vals:
        return 0.0
    return vals[int(0.9 * (len(vals) - 1))]


def audit_thickness(verbose=True):
    """Does the shipped set actually follow the thickness ramp, and never dip?

    `target_thickness` has said since NEX-337 that a DIP is the one thing that
    is not allowed -- "on a flipbook a dip means the animal briefly slims as it
    grows, which reads as a wobble." Nothing checked it. The shipped set dips:
    frame 90 measures thinner than frame 80 while being longer, and that
    boundary is the second-worst art pop in the whole set (252k pixels change at
    a fixed arc, against 46k at the mildest boundary).

    That is why the hero reads as a different animal either side of a boundary,
    and it is the residual no amount of renderer cross-fading can remove: you
    cannot blend two snakes of different build into one snake.
    """
    rows = []
    for score in FRAME_SCORES:
        path = os.path.join(OUT_DIR, f"frame-{score:03d}.webp")
        im = Image.open(path).convert("RGBA")
        if im.size != (N, N):
            im = im.resize((N, N), Image.LANCZOS)
        alpha = np.asarray(im)[:, :, 3]
        px = body_thickness(alpha, HEAD_DEG[score])
        half = (px / 2.0) / RING_R
        want = target_thickness(score)
        rows.append((score, px, half, want, half - want))

    dips = [
        (rows[i - 1][0], rows[i][0], rows[i - 1][2], rows[i][2])
        for i in range(1, len(rows))
        if rows[i][2] < rows[i - 1][2] * (1.0 - DIP_TOL)
    ]
    wobbles = [
        (rows[i - 1][0], rows[i][0], rows[i - 1][2], rows[i][2])
        for i in range(1, len(rows))
        if rows[i - 1][2] * (1.0 - DIP_TOL) <= rows[i][2] < rows[i - 1][2] - 1e-6
    ]
    off = [r for r in rows if abs(r[4]) > THICKNESS_TOL]

    if verbose:
        print(f"  {'score':>5} {'body px':>8} {'half/R':>7} {'target':>7} {'delta':>7}")
        for score, px, half, want, d in rows:
            flag = "   <-- off ramp" if abs(d) > THICKNESS_TOL else ""
            print(f"  {score:>5} {px:>8.1f} {half:>7.3f} {want:>7.3f} {d:>+7.3f}{flag}")
        for a, b, ta, tb in dips:
            print(f"  DIP: frame {a} is {ta:.3f} but frame {b} is {tb:.3f} "
                  f"-- the animal slims by {(1 - tb / ta) * 100:.0f}% as it GROWS")
        for a, b, ta, tb in wobbles:
            print(f"  (wobble, within tolerance: {a}->{b} slims "
                  f"{(1 - tb / ta) * 100:.0f}%)")
        if not dips:
            print(f"  no dip beyond {DIP_TOL * 100:.0f}% -- ramp is acceptable")
    return rows, dips, off


def audit_registration(verbose=True):
    """How far each SHIPPED frame's body sits off the shared circle.

    Reports two residuals per frame: against the canonical circle, and against
    that frame's own best-fit circle. The second is the art's own hand-drawn
    wobble and is irreducible; the EXCESS of the first over the second is
    misregistration, and is the only part worth fixing.
    """
    rows = []
    for score in FRAME_SCORES:
        path = os.path.join(OUT_DIR, f"frame-{score:03d}.webp")
        im = Image.open(path).convert("RGBA")
        if im.size != (N, N):
            im = im.resize((N, N), Image.LANCZOS)
        alpha = np.asarray(im)[:, :, 3]
        cx, cy, r, pts = fit_ring(alpha)
        own = ring_residual(pts, cx, cy, r)
        can = ring_residual(centreline(solid_mask(alpha)), C, C, RING_R)
        rows.append((score, cx, cy, r, own, can, can - own, len(pts)))
    if verbose:
        print(f"  {'score':>5} {'span':>5} {'centre':>16} {'radius':>7} "
              f"{'own':>7} {'canon':>7} {'excess':>7}")
        for s, cx, cy, r, own, can, exc, span in rows:
            flag = "" if exc < REGISTRATION_TOL else "   <-- off-circle"
            print(f"  {s:>5} {span:>4}d ({cx:>6.1f},{cy:>6.1f}) {r:>7.1f} "
                  f"{own:>6.2f}px {can:>6.2f}px {exc:>6.2f}px{flag}")
    return rows


TAIL_TOL_DEG = 1.5      # how far the tail may sit from twelve o'clock

# Mirrors NECK_DEG / NECK_FEATHER_DEG in src/components/ui/ouroboros-frames.ts.
# The head sprite is cut here and the body is clipped there, so the two numbers
# describe one seam and must agree.
NECK_DEG = 42.0
NECK_FEATHER_DEG = 14.0


def angle_grid():
    """Per-pixel angle, degrees clockwise from twelve o'clock."""
    yy, xx = np.mgrid[0:N, 0:N]
    return (np.degrees(np.arctan2(yy - C, xx - C)) + 90.0) % 360.0


def emit_heads(quality=WEBP_QUALITY):
    """Cut the head-and-neck sprite out of every authored frame.

    The runtime draws two layers: the body, which is an authored frame hard-
    clipped to a wedge at `headDeg - NECK_DEG`, and one of these, rotated about
    the ring centre to put the head where the score says. The sprite is opaque
    from the neck forward and fades to nothing over NECK_FEATHER_DEG behind it,
    so it covers the body's hard cut instead of butting against it.

    Kept full-frame rather than cropped to the head's bounding box: at 1024 the
    sprite shares the body's coordinate system exactly, so the runtime rotation
    is one transform about the frame centre with no offset bookkeeping. Cropping
    would save perhaps 75% of the proxy bytes and is the first thing to try if
    the warm set ever needs to shrink.
    """
    ang = angle_grid()
    rows = []
    for score in FRAME_SCORES:
        src = os.path.join(OUT_DIR, f"frame-{score:03d}.webp")
        im = Image.open(src).convert("RGBA")
        if im.size != (N, N):
            im = im.resize((N, N), Image.LANCZOS)
        arr = np.asarray(im).astype(np.float32)

        head = float(HEAD_DEG[score])
        base = head - NECK_DEG - NECK_FEATHER_DEG

        # The feather must finish before it reaches the tail at zero, or the
        # closed ring's sprite eats the tail it is biting. With the current
        # constants the score-100 feather runs 304->318deg, comfortably clear.
        #
        # This was a `if score == 100` special case that did nothing: it masked
        # `ang > head`, and `angle_grid` is already `% 360`, so at head=360 the
        # mask selected zero pixels. An assert is what it was reaching for --
        # the risk is real, it just arrives by widening NECK_FEATHER_DEG rather
        # than at score 100 specifically.
        assert base > 0, (
            f"score {score}: head-and-neck ({NECK_DEG + NECK_FEATHER_DEG}deg) reaches "
            f"back past the tail on a {head:.0f}deg arc; the sprite would eat the tail"
        )
        keep = np.clip((ang - base) / NECK_FEATHER_DEG, 0, 1)
        # The ramp above keeps [base, 360), and the tail lives at ~360 -- so the
        # sprite ate a sliver of its own tail, which then orbited with the head
        # and read as a detached fragment floating beside the tail start (owner
        # report: "at 62 the snake looks off"). Cap the keep just past the head;
        # the finale's head is 360, where the cap is a no-op and the bite is the
        # authored art anyway. The +1 is for the nose tip's anti-aliasing.
        keep[ang > head + 1.0] = 0.0
        arr[:, :, 3] *= keep

        out = Image.fromarray(arr.astype(np.uint8), "RGBA")
        f = os.path.join(OUT_DIR, f"head-{score:03d}.webp")
        p = os.path.join(OUT_DIR, f"headproxy-{score:03d}.webp")
        out.save(f, "WEBP", quality=quality, method=6)
        out.resize((PROXY_PX, PROXY_PX), Image.LANCZOS).save(
            p, "WEBP", quality=quality, method=6)
        rows.append((score, head, os.path.getsize(f), os.path.getsize(p)))

    print(f"\n{'score':>6} {'head':>7} {'full KB':>9} {'proxy KB':>9}")
    for score, head, f, p in rows:
        print(f"{score:>6} {head:>6.0f}d {f/1024:>9.1f} {p/1024:>9.1f}")
    print(f"{'TOTAL':>6} {'':>7} {sum(r[2] for r in rows)/1024:>9.1f} "
          f"{sum(r[3] for r in rows)/1024:>9.1f}")
    return rows


def arc_run(mask):
    """The body's angular coverage as (tail_deg, head_deg, span).

    Returns absolute degrees clockwise from twelve o'clock. Found as the
    complement of the LARGEST uncovered gap, which is wrap-safe: a frame whose
    tail sits a degree or two below zero covers 358..360 and 0..head, and taking
    `max(covered)` on that reads the head as 359.
    """
    rmin, rmax = N * R_MIN, N * R_MAX
    covered = set()
    for deg in range(360):
        ang = math.radians(deg - 90)
        ca, sa = math.cos(ang), math.sin(ang)
        hits = 0
        for j in range(300):
            r = rmin + (rmax - rmin) * j / 299
            x, y = int(C + r * ca), int(C + r * sa)
            if 0 <= x < N and 0 <= y < N and mask[y, x]:
                hits += 1
        if hits > 2:
            covered.add(deg)
    if len(covered) >= 359:
        return 0.0, 360.0, 360        # closed ring: no tail to find

    gaps, cur = [], []
    for deg in list(range(360)) + list(range(360)):
        if deg not in covered:
            cur.append(deg)
        elif cur:
            gaps.append(cur)
            cur = []
    if cur:
        gaps.append(cur)
    biggest = max(gaps, key=len)
    tail = (biggest[-1] + 1) % 360
    span = 360 - len(set(biggest))
    return float(tail), float((tail + span - 1) % 360), span


def measure_head_angles(verbose=True):
    """Re-derive HEAD_DEG from the shipped frames.

    Every frame is normalised with its TAIL at zero and grows clockwise, so the
    head angle is the span of the body's coverage. Reported alongside the tail
    offset, because a head angle is only meaningful if the tail is where the
    art direction says it is.
    """
    out, tails = {}, {}
    for score in FRAME_SCORES:
        im = Image.open(os.path.join(OUT_DIR, f"frame-{score:03d}.webp")).convert("RGBA")
        if im.size != (N, N):
            im = im.resize((N, N), Image.LANCZOS)
        tail, _, span = arc_run(solid_mask(np.asarray(im)[:, :, 3]))
        out[score] = span
        tails[score] = tail if tail <= 180 else tail - 360

    if verbose:
        ok = True
        print(f"  {'score':>5} {'measured':>9} {'recorded':>9} {'step':>7} {'tail':>7}")
        prev = None
        for score in FRAME_SCORES:
            got, want, tl = out[score], HEAD_DEG[score], tails[score]
            step = "" if prev is None else f"{got - prev:+4}d"
            # Exact, not a tolerance: HEAD_DEG is a transcription of this
            # measurement, and `audit` gates on the same comparison. Two
            # definitions of "drift" in one command is how one of them rots.
            bad = got != want or abs(tl) > TAIL_TOL_DEG
            if bad:
                ok = False
            print(f"  {score:>5} {got:>8}d {want:>8}d {step:>7} {tl:>+6.1f}d"
                  f"{'   <-- DRIFT' if bad else ''}")
            prev = got
        if not ok:
            print("\n  Does not match the art. Run `register --apply`, and if the "
                  "spans really changed update HEAD_DEG here AND FRAME_HEAD_DEG in "
                  "src/components/ui/ouroboros-frames.ts.")
    return out, tails


def register_shipped(apply=False):
    """Re-seat the shipped frames on the canonical circle.

    A pure translation: the art is correct, only its placement is wrong, so
    nothing is rotated, rescaled or resampled beyond the shift itself. Frames
    already on the circle move by a fraction of a pixel and are left alone.

    This exists because `build_final()` cannot be re-run -- its raw plates were
    destroyed -- and because it should not need to be. The pixels were never
    the problem.
    """
    rows = audit_registration()
    moved = []
    for score, _, _, _, own, can, exc, _ in rows:
        path = os.path.join(OUT_DIR, f"frame-{score:03d}.webp")
        im = Image.open(path).convert("RGBA")
        if im.size != (N, N):
            im = im.resize((N, N), Image.LANCZOS)
        alpha = np.asarray(im)[:, :, 3]
        mask = solid_mask(alpha)
        pts = centreline(mask)
        cx, cy = fit_centre_pinned(pts, RING_R, (C, C))
        dx, dy = C - cx, C - cy

        # A translation moves the tail off twelve o'clock -- shifting frame 20
        # by 33px swung its tail to 357 -- so the tail is re-anchored after the
        # shift, in the same order `normalise` does it: recentre, THEN rotate.
        tail, _, _ = arc_run(mask)
        tail_off = tail if tail <= 180 else tail - 360

        needs_shift = exc >= REGISTRATION_TOL
        needs_spin = abs(tail_off) > TAIL_TOL_DEG
        if not (needs_shift or needs_spin):
            continue

        if not needs_shift:
            dx = dy = 0.0

        ys, xs = np.nonzero(alpha > 8)
        if not (xs.min() + dx > 0 and ys.min() + dy > 0
                and xs.max() + dx < N and ys.max() + dy < N):
            print(f"  REFUSING score {score}: shifting ({dx:+.1f},{dy:+.1f}) "
                  f"would push the body out of the frame")
            return 1

        after = ring_residual(pts + np.array([dx, dy]), C, C, RING_R)
        print(f"  score {score}: shift ({dx:+6.1f},{dy:+6.1f})px  "
              f"tail {tail_off:+5.1f}d -> 0   canonical {can:.2f} -> {after:.2f}px")
        if apply:
            out = im
            if needs_shift:
                out = out.transform((N, N), Image.AFFINE, (1, 0, -dx, 0, 1, -dy),
                                    resample=Image.BICUBIC)
            if needs_spin or needs_shift:
                # re-measure the tail AFTER the shift; the shift is what moved it
                t2, _, _ = arc_run(solid_mask(np.asarray(out)[:, :, 3]))
                t2 = t2 if t2 <= 180 else t2 - 360
                if abs(t2) > 1e-3:
                    out = out.rotate(t2, resample=Image.BICUBIC, center=(C, C))
            out.save(path, "WEBP", quality=WEBP_QUALITY, method=6)
            out.resize((PROXY_PX, PROXY_PX), Image.LANCZOS).save(
                os.path.join(OUT_DIR, f"proxy-{score:03d}.webp"),
                "WEBP", quality=WEBP_QUALITY, method=6)
        moved.append(score)

    if not moved:
        print("\n  every frame already on the circle; nothing to do")
    elif apply:
        # Moving a frame invalidates the head cut from it -- see emit(). The head
        # angles are measured from the tail, and re-anchoring the tail is exactly
        # what this function just did, so HEAD_DEG is re-checked too.
        print("\n  re-cutting heads from the moved frames")
        emit_heads()
        measure_head_angles()
        print(f"\n  re-seated and re-emitted {moved}")
    else:
        print(f"\n  would re-seat {moved}   (re-run with --apply to write)")
    return 0


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "selfcheck"
    if cmd == "selfcheck":
        raise SystemExit(_selfcheck())
    if cmd == "provisional":
        build_provisional()
        raise SystemExit(0)
    if cmd == "final":
        raise SystemExit(build_final())
    if cmd == "audit":
        # Exits non-zero on drift. It reported and returned 0 either way, which
        # made it a printout rather than a check -- and this is the ONLY thing
        # that compares the constants to the actual pixels.
        rows = audit_registration()
        print()
        spans, tails = measure_head_angles()
        print()
        _, dips, off = audit_thickness()
        ok = all(exc < REGISTRATION_TOL for *_, exc, _ in rows)
        ok = ok and all(spans[s] == HEAD_DEG[s] for s in FRAME_SCORES)
        ok = ok and all(abs(t) <= TAIL_TOL_DEG for t in tails.values())
        # A dip is the failure `target_thickness` was written to forbid, and it
        # is what makes the hero read as two different animals across a
        # boundary. Nothing checked it before.
        ok = ok and not dips and not off
        raise SystemExit(0 if ok else 1)
    if cmd == "register":
        raise SystemExit(register_shipped(apply="--apply" in sys.argv))
    if cmd == "heads":
        emit_heads()
        _write_manifest()
        raise SystemExit(0)
    print("usage: frames.py [selfcheck|provisional|final|audit|register [--apply]|heads]")
    raise SystemExit(2)
