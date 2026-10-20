"""
What the Home hero actually spends in gold, measured rather than argued.

CLAUDE.md §19 grants Home THREE gold elements where the rest of the app gets
two: the serpent, the §18.4 band word, and the ornament's single seal. §4.4 caps
gold at 5% of the screen. This script prints the table that claim rests on, and
§19 says plainly that a stale number there is a false claim rather than a typo.

## Rewritten for NEX-338

It used to SIMULATE the shipped rig -- lay the unrolled strip along the ring at
a given score, apply BODY_THICKNESS and the inner anchor, and count the result.
That is gone with the rig, and good riddance: the simulation had already been
caught measuring a frame no user ever sees (score 100 never drew the mesh), and
it agreed with the truth by luck rather than by equivalence.

Every score is an authored frame now, so every row is measured the way the old
`finale_gold_pt2` measured its one row -- open the actual shipped asset and
count. There is nothing left to model, which is the point.

## Reading the numbers

Gold is `clip((R - B) / 90, 0, 1)` weighted by alpha, unchanged from before so
the new table is comparable with the old one. The serpent's frame is square and
drawn `fit="contain"` into a square box, so its coverage fraction maps to the
box area directly.

Two forces moved these numbers in opposite directions, which is why the whole
table is re-measured rather than scaled:

  - the box shrank 1.36 -> 1.24, and gold area goes as the SQUARE of it (0.83x)
  - BODY_THICKNESS (0.7) and lengthThinning (0.62..1.0) are GONE, because the
    authored frames are at native thickness. Mid scores used to be drawn at
    ~0.58 of the art's real silhouette and are now at 1.0.

Shrinking is the cheap lever and enlarging is the dear one. Never buy size by
raising the cap.
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FRAMES = os.path.join(ROOT, "assets", "images", "ouroboros-frames")

HERO_PT = 264          # the hero's size on Home
SCALE = 3
SCREEN_PT = (393, 852) # iPhone 15/16 logical points, the reference screen

# Must match SERPENT_BOX_SCALE in src/components/ui/ouroboros-frames.ts. The
# animal is nearly all of the hero's gold and its area goes as the SQUARE of
# this, so a box change is a budget change.
SERPENT_BOX_SCALE = 1.24

FRAME_STEP = 10
FIRST_FRAME_SCORE = 20
FRAME_SCORES = list(range(FIRST_FRAME_SCORE, 101, FRAME_STEP))

WORD_PT = 24                  # AlignmentScoreRing wordStyles.fontSize
WORD_FONT = "assets/fonts/Fraunces-LightItalic.ttf"
# CLAUDE.md §18.4. The word is tokens.color.gold, so its ink is gold outright.
BANDS = ((90, "Rising"), (75, "Steady"), (60, "Holding"), (45, "Drifting"), (0, "Quiet"))
# ouroboros-ornament-geometry.ts cardinals(): the origin seal is a filled dot.
SEAL_R_FRAC = 0.0055 * 0.62


def band_word(score):
    for lo, word in BANDS:
        if score >= lo:
            return word
    return "Quiet"


def word_gold_pt2(word):
    """Gold ink in the band word, in pt^2. Rendered at @3x for antialias detail,
    then divided back down, so partly-covered edge pixels count as partial gold."""
    font = ImageFont.truetype(os.path.join(ROOT, WORD_FONT), WORD_PT * SCALE)
    box = font.getbbox(word)
    img = Image.new("L", (box[2] - box[0] + 8, box[3] - box[1] + 8), 0)
    ImageDraw.Draw(img).text((4 - box[0], 4 - box[1]), word, font=font, fill=255)
    return float(np.asarray(img).sum()) / 255.0 / (SCALE ** 2)


def seal_gold_pt2():
    """The ornament's one gold mark: a filled dot, so simply its area.

    NOTE (NEX-338): OuroborosOrnament is not currently mounted anywhere, so this
    row is what the design grants rather than what the screen spends. Left in
    because §19's count of three rests on it; flagged so nobody reads the total
    as purely observed.
    """
    return math.pi * (SEAL_R_FRAC * HERO_PT) ** 2


def frame_gold_pt2(score, box_pt):
    """Gold in the authored frame for `score`, in pt^2."""
    path = os.path.join(FRAMES, f"frame-{score:03d}.webp")
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float64)
    alpha = a[..., 3] / 255.0
    goldness = np.clip((a[..., 0] - a[..., 2]) / 90.0, 0, 1)
    # square source, fit="contain" into a square box -> fills it exactly
    frac = float((alpha * goldness).sum()) / (im.size[0] * im.size[1])
    return frac * (box_pt * box_pt)


def main():
    box_pt = HERO_PT * SERPENT_BOX_SCALE
    screen_pt2 = SCREEN_PT[0] * SCREEN_PT[1]
    seal = seal_gold_pt2()
    cap = 5.0

    print(f"hero {HERO_PT}pt, serpent box {box_pt:.1f}pt "
          f"(x{SERPENT_BOX_SCALE}) on a {SCREEN_PT[0]}x{SCREEN_PT[1]}pt screen")
    print("all three gold elements CLAUDE.md §19 grants Home: serpent, band word, seal\n")
    print(f"{'score':>6} {'serpent':>9} {'word':>16} {'seal':>6} "
          f"{'total pt^2':>11} {'% screen':>9}   vs {cap:.0f}%")

    worst = 0.0
    for score in FRAME_SCORES:
        s_pt2 = frame_gold_pt2(score, box_pt)
        word = band_word(score)
        w_pt2 = word_gold_pt2(word)
        total = s_pt2 + w_pt2 + seal
        pct = 100.0 * total / screen_pt2
        worst = max(worst, pct)
        flag = "" if pct <= cap else "  OVER CAP"
        print(f"{score:>6} {s_pt2:>9.1f} {word + ' ' + format(w_pt2, '.0f'):>16} "
              f"{seal:>6.1f} {total:>11.1f} {pct:>8.2f}%{flag}")

    print(f"\nworst {worst:.2f}% against a {cap:.0f}% cap "
          f"— {cap - worst:.2f} points of headroom")
    if worst > cap:
        print("OVER THE CAP. The fix is thinner art, never a raised cap (§19).")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
