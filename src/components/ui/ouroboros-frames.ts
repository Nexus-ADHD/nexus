/**
 * Score -> authored frame. The whole score-to-visual model, in one file.
 *
 * This replaces the rig (`ouroboros-geometry` + `ouroboros-mesh` +
 * `ouroboros-layers`, ~1.5k lines of unroll/mesh/jaw maths). The rig existed to
 * synthesise every score from ONE strip texture; now every score is its own
 * authored render, so the only question left is which one to draw.
 *
 * Why the rig went: it laid a flat, de-lit strip along a flat circle, which
 * cannot express a coil's self-overlap or its volumetric light. Score 100 was
 * always an authored render for exactly that reason, and the seam between the
 * two showed -- "it just looks like two completely different snakes."
 *
 * Nothing here does geometry. The frames are pre-registered onto one circle by
 * `scripts/ouroboros/frames.py`, so there is no radius, no thickness and no
 * head angle to compute at runtime.
 */

/**
 * Frames are authored every 10 score points: 20, 30, ... 90, 100.
 *
 * Was 5, and the step is set by what the image models will actually draw rather
 * than by taste. Asked for a specific arc length they ignore it -- across 42
 * generated plates the requested-to-produced mapping was loose enough that a
 * 5-point set could not be filled and verified. Nine slots can be, with every
 * frame authored, which is the property that matters. The cost is coarser
 * quantisation, and the numeral beside the serpent still carries the exact value.
 */
export const FRAME_STEP = 10;

/** The bite. Score 100 only -- see `frameForScore`. */
export const FINALE_SCORE = 100;

/**
 * The shortest serpent that exists as art.
 *
 * Not 10, and this is a limit of the image models rather than a design choice.
 * Across 42 generated plates the shortest arc obtainable was 18.8 -- both models
 * collapse toward a closed ring and no prompt tested would take them below it.
 * So the hero draws nothing under 15 rather than shipping a frame that claims a
 * length it does not have. That extends the existing score-0-draws-nothing
 * behaviour by a few points; it does not invent a new one.
 */
export const FIRST_FRAME_SCORE = 20;

/**
 * Below this the hero draws NO serpent.
 *
 * Half a step below the first authored frame, so the nearest-frame rounding is
 * symmetric at both ends.
 * Drawing nothing at the bottom is inherited behaviour, not a new idea: the rig
 * built an empty layer list at score 0 and `AlignmentScoreRing` leans on that
 * as the still frame it paints during the async reduce-motion read. Preserving
 * it is load-bearing -- initialising the serpent to a DRAWN state made it paint
 * at full length and snap backwards on the first frame of the count-up (NEX-334).
 */
export const MIN_VISIBLE_SCORE = FIRST_FRAME_SCORE - FRAME_STEP / 2;

/**
 * Authored scores, ascending. Index into this is the frame index.
 *
 * EXPLICIT, not arithmetic. 95 is off the 10-point grid: the tenth frame exists
 * only to narrow the step into the finale, and between 90 and 100 is the one
 * place it can sit. `FRAME_STEP` still describes the original grid and is used
 * by `frameForScore`'s rounding; it no longer describes this list.
 */
export const FRAME_SCORES: readonly number[] = Object.freeze([
  20, 30, 40, 50, 60, 70, 80, 90, 95, 100,
]);

export const FRAME_COUNT = FRAME_SCORES.length;

/** Index of the bite frame (the last one). */
export const FINALE_INDEX = FRAME_COUNT - 1;

/**
 * Centreline radius as a fraction of the frame box.
 *
 * Mirrors `RING_FRAC` in `scripts/ouroboros/frames.py`, which is where it is
 * enforced. Runtime never uses it to position anything -- the frames are already
 * registered -- but the two must not drift, so it is stated once on each side
 * and asserted by the asset check.
 */
export const RING_FRAC = 0.38714;

/**
 * The hero draws the frame into a box this many times the ring `size`.
 *
 * Was 1.36 while the rig drew the body at 0.7 of native thickness. The authored
 * frames are at NATIVE thickness, and measurement showed the score-100 art's
 * lowest gold reaching 170.5pt from the hero centre against a TODAY'S WIN card
 * whose top edge is at 164pt -- the serpent was 6.5pt INSIDE the card, which is
 * the crowding the owner reported. At 1.24 the same gold lands at 155.4pt, so
 * the card gets 8.6pt of clearance.
 *
 * Gold area goes as the SQUARE of this, so shrinking is budget-positive
 * ((1.24/1.36)^2 = 0.83x) -- but the lost 0.7 thickness pushes the other way at
 * mid scores, so CLAUDE.md section 19's table is re-measured against the
 * shipped frames rather than scaled from the old numbers.
 */
export const SERPENT_BOX_SCALE = 1.24;

/**
 * Which authored frame draws this score, or `null` to draw nothing.
 *
 * Nearest-frame, with two deliberate asymmetries:
 *
 * 1. **Below `MIN_VISIBLE_SCORE`, nothing.** See that constant.
 *
 * 2. **The bite is score 100 and nothing else.** Plain nearest-rounding would
 *    hand the tail-in-mouth frame to anything from 95 up, and the finale is a
 *    ceremony reserved for a real 100 -- the owner's words, "not necessarily it
 *    eating its tail, because obviously that's reserved for the 100." So 95 to
 *    99.999 hold at the frame below it and only an exact 100 crosses. This
 *    matches the rig's `isFinale` (`score >= 100`, with `99.99` explicitly
 *    asserted false) so the boundary survives the rewrite unchanged.
 *
 * Accepts the FRACTIONAL score the ring's rAF tick produces, not a rounded one.
 */
export function frameForScore(score: number): number | null {
  if (!Number.isFinite(score) || score < MIN_VISIBLE_SCORE) return null;
  if (score >= FINALE_SCORE) return FINALE_INDEX;

  // nearest step, then hold below the finale
  const idx = Math.round(score / FRAME_STEP) - FIRST_FRAME_SCORE / FRAME_STEP;
  return Math.min(Math.max(idx, 0), FINALE_INDEX - 1);
}

/** The score a frame index represents. Inverse of `frameForScore`'s rounding. */
export function scoreForFrame(index: number): number {
  const i = Math.min(Math.max(Math.round(index), 0), FINALE_INDEX);
  return FRAME_SCORES[i];
}

/**
 * Where each authored frame's HEAD sits, in degrees of arc swept from the tail
 * at twelve o'clock, measured off the shipped art by `frames.py audit`.
 *
 * These are the most important nine numbers in the hero, because they are not
 * evenly spaced and everyone assumed they were:
 *
 *     82  100  151  174  233  253  321  340  356  360
 *       +18  +51  +23  +59  +20  +68  +19  +16   +4
 *
 * The 356 is the tenth frame, authored later against the other two as
 * references and MEASURED at 356 rather than the 350 that was asked for. It
 * exists so the ramp can stop just short of the closed ring: before it, the
 * longest non-bite frame was 340 and crossing to the finale jumped 20 degrees.
 * Now it steps 4.
 *
 * The head advances 18 degrees for one ten-point step and 68 for another. That
 * is a 3.8x swing in how fast the animal grows per point of score, and it is
 * the larger half of what the owner called choppy: the serpent does not merely
 * step between frames, it CRAWLS then LURCHES. Easing between frames cannot fix
 * unevenly spaced frames.
 *
 * They are recorded rather than derived because the binning that produced this
 * spacing is gone -- the raw plates were destroyed -- and because a measurement
 * this load-bearing should be reviewable as data. `frames.py audit` re-derives
 * them from the shipped WebPs, and the asset check fails if the two disagree.
 */
export const FRAME_HEAD_DEG: readonly number[] = Object.freeze([
  82, 100, 151, 174, 233, 253, 321, 340, 356, 360,
]);

/**
 * How much of the arc, measured back from the head, is head-and-neck.
 *
 * The body is clipped to `headDeg - NECK_DEG` and the head sprite covers the
 * rest, so this is also the SHORTEST serpent that can be drawn: ask for less
 * arc than this and you get a floating head beside a detached stub of tail.
 * That is not theoretical -- it is what the first prototype rendered at score
 * 15, before the ramp was anchored to the authored art.
 */
export const NECK_DEG = 42;

/** Width of the cross-fade where the clipped body meets the head's neck. */
export const NECK_FEATHER_DEG = 14;

/**
 * Total arc at the first authored frame and at the finale.
 *
 * The ramp between them is EVEN, and it is anchored to these two ends so both
 * scores the owner has already approved render as their authored frame: score
 * 20 is the art's own 82 degrees and score 100 is the closed ring, untouched.
 * Everything between is spaced regularly rather than inheriting the authored
 * frames' 18-to-68-degree lurch.
 */
export const ARC_AT_FIRST_FRAME = FRAME_HEAD_DEG[0];
export const ARC_AT_FINALE = FRAME_HEAD_DEG[FINALE_INDEX];

/**
 * Where the sub-100 ramp STOPS. The longest arc that is not the bite.
 *
 * The ramp used to run all the way to `ARC_AT_FINALE`, and that shipped a
 * two-headed serpent for every score from 94.24 to 99.99.
 *
 * Why: `poseForScore` picks a body frame whose own head sits at or beyond the
 * arc, precisely so the clip at `arc - NECK_DEG` erases that frame's head and
 * leaves the head SPRITE as the only head. `NECK_DEG` is 42 because that is how
 * wide a head is. The rule is sound, but it has no valid answer above arc 340:
 * the only frame long enough is the FINALE, and the finale is the one frame
 * whose head curls INWARD to bite the tail instead of lying along the ring (its
 * art reaches radius 0.2198 of the box against 0.29-0.32 for every other frame).
 * An angular clip cannot remove a head that is not where the other heads are, so
 * it survived and the sprite was drawn on top of it.
 *
 * Ending the ramp at the longest non-bite frame means every score below 100 has
 * a body whose head the clip can actually remove, and the finale stays what the
 * owner reserved it for: an exact 100. The residual is a jump from this arc to
 * 360 at that moment, which reads as the mouth closing on the tail -- the
 * ceremony, not a glitch.
 *
 * **This is the number a tenth authored frame moves.** At 340 the jump is 20
 * degrees; a frame authored at 350 makes it 10. Nothing else about the fix
 * changes -- add the frame to `FRAME_HEAD_DEG` and this constant follows it,
 * because it is derived rather than typed.
 */
export const ARC_AT_RAMP_TOP = FRAME_HEAD_DEG[FINALE_INDEX - 1];

/**
 * Arc length for a score, in degrees, or `null` to draw nothing.
 *
 * Clamped at both ends: below `FIRST_FRAME_SCORE` it holds at the shortest
 * authored arc rather than continuing down, because a serpent shorter than its
 * own head is not a shorter serpent, it is a broken one. Scores between
 * `MIN_VISIBLE_SCORE` and 20 therefore all draw the 82-degree animal, which is
 * exactly what shipped before -- `frameForScore` returns index 0 across that
 * whole range too.
 *
 * At the top it stops at `ARC_AT_RAMP_TOP` rather than at the closed ring, and
 * only an exact 100 crosses to 360. See that constant: the ramp reaching past
 * the longest non-bite frame is what produced the two-headed serpent.
 */
export function arcForScore(score: number): number | null {
  if (!Number.isFinite(score) || score < MIN_VISIBLE_SCORE) return null;
  if (score >= FINALE_SCORE) return ARC_AT_FINALE;
  const t =
    (Math.min(Math.max(score, FIRST_FRAME_SCORE), FINALE_SCORE) - FIRST_FRAME_SCORE) /
    (FINALE_SCORE - FIRST_FRAME_SCORE);
  return ARC_AT_FIRST_FRAME + (ARC_AT_RAMP_TOP - ARC_AT_FIRST_FRAME) * t;
}

/*
 * `poseForScore`, `GlidePose` and `fullResMatchesPose` lived here and are gone.
 *
 * They described the TWO-LAYER hero: a clipped body plus a rotated head sprite,
 * and the guard for the window where a settled pair no longer matched the pose.
 * The renderer draws one image now, so there is no pair to mismatch. Deleted
 * rather than left unused for the same reason the entries below were: a dead
 * export describing a retired concept is how the next bug starts.
 *
 * `travelPlan` / `flipbookFrames` lived here and are gone (NEX-339).
 *
 * They walked between frames on this module's own schedule, which was a second
 * animator for a quantity `AlignmentScoreRing` was already animating: it runs a
 * 1400ms ease-out-cubic rAF loop and pushes a fractional score every frame. Two
 * clocks for one value, and the slower one kept being torn down before it ticked
 * — that was the "stiff" the owner reported.
 *
 * The frame to draw is now a pure function of the score, so there is nothing to
 * schedule. Deleted rather than left unused: this seam has shipped three bugs,
 * and a dead export describing a retired concept is how the fourth starts.
 */

/**
 * WHOLE-FRAME POSE — the model that has no head/body join to get wrong.
 *
 * `poseForScore` above draws the animal as TWO images: a body clipped back to
 * `arc - NECK_DEG`, and a separately-authored head rotated into place on top.
 * That join is only invisible when the rotation is zero, which happens at
 * exactly nine scores. Everywhere else the head sprite arrives with its own
 * straight edge and its scale lattice offset from the body's by up to 34 degrees
 * (half the widest authored gap, which `poseForScore`'s own test asserts). The
 * owner's report was that "you can clearly tell where the head and the body are
 * two separate images," and that is a literal description of the renderer.
 *
 * Rendered A/B at rotation 0 against rotation -15.6 confirmed it: identical art,
 * seamless at zero, visibly two pieces at -15.6.
 *
 * This model draws ONE image. Rotate the whole authored frame -- head, neck,
 * body and tail together -- until its head lands on the target arc, then clip
 * the excess off the TAIL. Head and body cannot disagree because they were never
 * separated. There is no head sprite, no second decode, and no window in which
 * a stale head can pair with a current body.
 *
 * WHAT IT COSTS. The tail is a cut rather than the authored point. That is the
 * deliberate trade: a discontinuity at the tail is where the body is thinnest
 * (21px against 157px at the neck, measured on frame-060), and it sits at the
 * twelve o'clock anchor where an end is expected. Feathering it is cheap; the
 * lattice offset at a rotated neck could not be feathered away at all.
 *
 * A second defect this removes by construction: the head sprite was drawn
 * UNCLIPPED, so any stray pixel elsewhere in its 1024px frame landed on screen
 * wherever the rotation carried it -- the detached gold fleck visible near the
 * tail at score 62.
 *
 * THERE IS NO BLEND, and that is deliberate. This type used to carry a
 * cross-fade (`nextFrame`/`mix`, a window of arc before each boundary) because
 * the art SNAPS at each boundary without one -- 46k pixels differ at the
 * narrowest crossing, 225k at the widest, since a longer authored serpent is a
 * different thickness at the same angle. But the art is a filigree lattice,
 * mostly transparent between the gold, so ANY opacity blend between two plates
 * both ghosts (the first animal shows through the second one's gaps) and fades
 * (neither lattice covers the other's holes, so mid-blend the serpent sits at
 * half strength). The owner named the scores: 63, 69, 87, 88, 89 -- every one
 * a blend window at rest. The snap the blend hid passes in ~40ms during the
 * count-up and never exists at rest; the ghost cost seconds at every score
 * near a boundary, forever. Cut, don't dissolve.
 */
export type FramePose = {
  /** The authored frame to draw. */
  frame: number;
  /** Degrees to rotate that whole frame, clockwise-positive. Always <= 0. */
  rotationDeg: number;
  /** Visible arc after the tail is clipped. Equals the target arc exactly. */
  arcDeg: number;
};

export function framePoseForScore(score: number): FramePose | null {
  const arc = arcForScore(score);
  if (arc === null) return null;

  if (score >= FINALE_SCORE) {
    // The closed ring is drawn as authored: nothing to rotate, nothing to clip.
    return {
      frame: FINALE_INDEX,
      rotationDeg: 0,
      arcDeg: ARC_AT_FINALE,
    };
  }

  // Shortest authored frame at least as long as the target, so the surplus can
  // be taken off the tail rather than invented at the head.
  let frame = FINALE_INDEX;
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    if (FRAME_HEAD_DEG[i] >= arc) {
      frame = i;
      break;
    }
  }

  return {
    frame,
    rotationDeg: arc - FRAME_HEAD_DEG[frame],
    arcDeg: arc,
  };
}

/**
 * The geometry a given frame's pixels are authored to be drawn with.
 *
 * These three travel together or not at all. Frame 0's art is a serpent 82
 * degrees long; frame 4's is 233. Drawing frame 0's pixels at frame 4's
 * rotation and clip yields an animal that is neither.
 */
export type PaintGeometry = {
  frame: number;
  rotationDeg: number;
  arcDeg: number;
};

/**
 * Pick the image and the geometry to paint it with, as ONE unit.
 *
 * The hero degrades to "slightly stale" rather than to "empty" while a frame
 * decodes, and the whole point of that fallback is that what it shows must be a
 * coherent serpent a beat behind. Caching the last image WITHOUT its pose is
 * the bug NEX-339's `lastPair` existed to prevent, reintroduced one layer down:
 * Greptile T-Rex reproduced frame 0's pixels rendered at frame 4's -14 degree
 * rotation, 219 degree clip and [14, 233] wave band, against frame 0's own 0,
 * 82 and [0, 82]. (PR #439.)
 *
 * The distinction the naive fix misses: **a cached image of the SAME frame is
 * not stale.** Rotation moves every rAF while the frame index changes a handful
 * of times in a whole count-up, so freezing the pose whenever a decode is
 * pending would stall the animal's growth on every tick that missed. Only a
 * change of FRAME forces the pixels and the pose to travel together.
 */
export function coherentPaint<T>(
  fresh: T | null,
  want: PaintGeometry,
  last: (PaintGeometry & { image: T }) | null,
): (PaintGeometry & { image: T; stale: boolean }) | null {
  if (fresh !== null) return { ...want, image: fresh, stale: false };
  if (last === null) return null;
  // Same frame: these ARE this frame's pixels. Take the live pose.
  if (last.frame === want.frame) return { ...want, image: last.image, stale: false };
  // Different frame: hold the geometry the pixels were authored for.
  return { ...last, stale: true };
}

/**
 * May the full-resolution pixels currently in hand be used?
 *
 * Two independent things can be wrong with them, and checking only the second
 * is how PR #439 shipped its second round of the same defect:
 *
 *   PROVENANCE — `useImage` never clears its result when its source changes, so
 *     after the settle advances, the state still holds the pixels the PREVIOUS
 *     loader resolved. Comparing the new frame against the live pose says
 *     "usable" about an image that came from a different frame entirely.
 *   FRESHNESS  — the settled frame may be one the pose no longer wants,
 *     because the 150ms debounce has not fired yet.
 *
 * So the loaded pixels must be tagged with the frame that produced them, and
 * that tag has to match before the index is even worth comparing. (Was a pair
 * key while the cross-fade existed; one frame is loaded now, so the key is the
 * frame index itself.)
 */
export function fullResFrameUsable(
  settled: number | null,
  loadedFrame: number | null,
  primaryFrame: number | null,
): boolean {
  return (
    settled !== null &&
    loadedFrame !== null &&
    loadedFrame === settled &&
    settled === primaryFrame
  );
}
