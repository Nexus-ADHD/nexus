/**
 * The whole-frame model: one image, rotated, tail-clipped.
 *
 * The property this file exists to protect is that there IS no head/body join,
 * so no test here can be about one. What it can assert is that the model never
 * needs art it does not have: the visible arc must equal the target exactly, and
 * the rotation must only ever take surplus OFF the tail, never invent body past
 * a frame's authored head.
 */
import { describe, expect, it } from 'vitest';

import {
  ARC_AT_FINALE,
  ARC_AT_RAMP_TOP,
  FINALE_INDEX,
  FRAME_HEAD_DEG,
  MIN_VISIBLE_SCORE,
  ARC_AT_FIRST_FRAME,
  arcForScore,
  framePoseForScore,
} from '../ouroboros-frames';

/** Inverse of `arcForScore` on the ramp, so a test can target an arc directly. */
const scoreForArc = (arc: number) =>
  20 + ((arc - ARC_AT_FIRST_FRAME) * 80) / (ARC_AT_RAMP_TOP - ARC_AT_FIRST_FRAME);

const pose = (s: number) =>
  framePoseForScore(s) as NonNullable<ReturnType<typeof framePoseForScore>>;

describe('framePoseForScore', () => {
  it('draws nothing below the visible floor', () => {
    expect(framePoseForScore(0)).toBeNull();
    expect(framePoseForScore(MIN_VISIBLE_SCORE - 0.01)).toBeNull();
    expect(framePoseForScore(Number.NaN)).toBeNull();
  });

  it('shows exactly the arc the score asks for', () => {
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      expect(pose(s).arcDeg).toBeCloseTo(arcForScore(s) as number, 9);
    }
  });

  it('only ever takes surplus OFF the tail — rotation is never positive', () => {
    // A positive rotation would carry the head PAST the frame's authored head,
    // which is body that does not exist. This is the whole-frame equivalent of
    // "an authored frame has no pixels past its own head."
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      expect(pose(s).rotationDeg).toBeLessThanOrEqual(1e-9);
    }
  });

  it('lands the head exactly on the target arc', () => {
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      const p = pose(s);
      expect(FRAME_HEAD_DEG[p.frame] + p.rotationDeg).toBeCloseTo(p.arcDeg, 9);
    }
  });

  it('never clips away more tail than the frame has spare', () => {
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      const p = pose(s);
      // The surplus is the difference between the frame's authored arc and the
      // target. Clipping more than that would eat into the visible body.
      expect(-p.rotationDeg).toBeLessThanOrEqual(FRAME_HEAD_DEG[p.frame] - p.arcDeg + 1e-9);
    }
  });

  it('sources the SHORTEST frame that can cover the target', () => {
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.5) {
      const p = pose(s);
      expect(FRAME_HEAD_DEG[p.frame]).toBeGreaterThanOrEqual(p.arcDeg - 1e-9);
      if (p.frame > 0) {
        expect(FRAME_HEAD_DEG[p.frame - 1]).toBeLessThan(p.arcDeg);
      }
    }
  });

  it('draws the finale as authored — no rotation, no clip', () => {
    const p = pose(100);
    expect(p.frame).toBe(FINALE_INDEX);
    expect(p.rotationDeg).toBe(0);
    expect(p.arcDeg).toBe(ARC_AT_FINALE);
  });

  it('never borrows the bite frame below an exact 100', () => {
    for (let s = MIN_VISIBLE_SCORE; s < 100; s += 0.05) {
      expect(pose(s).frame).toBeLessThan(FINALE_INDEX);
    }
  });

  it('keeps the rotation within the authored gaps it interpolates', () => {
    // The rotation can only ever be as large as the gap below the chosen frame,
    // because a bigger one would have selected the shorter frame instead.
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      const p = pose(s);
      const gap = p.frame === 0 ? FRAME_HEAD_DEG[0] : FRAME_HEAD_DEG[p.frame] - FRAME_HEAD_DEG[p.frame - 1];
      expect(Math.abs(p.rotationDeg)).toBeLessThanOrEqual(gap + 1e-9);
    }
  });

  it('is continuous — the frame swap never jumps the visible arc', () => {
    let prev = pose(MIN_VISIBLE_SCORE);
    for (let s = MIN_VISIBLE_SCORE + 0.05; s < 100; s += 0.05) {
      const p = pose(s);
      expect(p.arcDeg - prev.arcDeg).toBeLessThan(0.5);
      expect(p.arcDeg).toBeGreaterThanOrEqual(prev.arcDeg - 1e-9);
      prev = p;
    }
  });

  it('tops out at the ramp, so 99.99 is still a real open serpent', () => {
    const p = pose(99.99);
    expect(p.arcDeg).toBeLessThanOrEqual(ARC_AT_RAMP_TOP);
    expect(p.frame).toBeLessThan(FINALE_INDEX);
  });
});

describe('framePoseForScore — the boundary is a CUT, never a blend', () => {
  // The cross-fade this describe used to cover is gone. It existed to hide the
  // texture snap between two separately authored plates, but the art is a
  // filigree lattice — mostly transparent between the gold — so every opacity
  // blend both ghosted (the first animal showed through the second's gaps) and
  // faded (neither lattice covers the other's holes, so mid-blend the serpent
  // sat at half strength). Owner-named scores: 63, 69, 87, 88, 89 — every one
  // a blend window at rest. The snap passes in ~40ms during the count-up and
  // never exists at rest. What remains to assert is that the cut lands exactly
  // on the authored heads and that no score ever names a second frame.

  it('carries no second frame anywhere — the pose is one frame, rotated, clipped', () => {
    // The type no longer has nextFrame/mix; if a blend ever creeps back in,
    // the compile fails here first. What this CAN assert: the visible arc is
    // always fully covered by the ONE frame named.
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.05) {
      const p = pose(s);
      expect(FRAME_HEAD_DEG[p.frame]).toBeGreaterThanOrEqual(p.arcDeg - 1e-9);
    }
  });

  it('swaps frames exactly at the authored head', () => {
    // Just below a head the shorter frame still covers the arc; at the head the
    // shorter frame draws pure and unrotated; just past it the longer frame
    // takes over. Frame 0's lower side is unreachable — the arc never goes
    // below ARC_AT_FIRST_FRAME (arcForScore clamps there).
    for (let i = 1; i < FINALE_INDEX - 1; i += 1) {
      const head = FRAME_HEAD_DEG[i];
      if (head > ARC_AT_RAMP_TOP) continue;
      const below = pose(scoreForArc(head - 0.01));
      const at = pose(scoreForArc(head));
      const above = pose(scoreForArc(head + 0.01));
      expect(below.frame).toBe(i);
      expect(at.frame).toBe(i);
      expect(at.rotationDeg).toBeCloseTo(0, 9);
      expect(above.frame).toBe(i + 1);
    }
  });

  it('draws the clamped floor PURE — the first frame, unrotated', () => {
    // Every score from the floor to 20 pins the arc at exactly
    // FRAME_HEAD_DEG[0]. An exact hit is the frame's own authored art and must
    // draw as authored: frame 0, no rotation, full authored arc.
    for (let s = MIN_VISIBLE_SCORE; s <= 20; s += 0.5) {
      const p = pose(s);
      expect(p.frame).toBe(0);
      expect(p.rotationDeg).toBe(0);
      expect(p.arcDeg).toBe(ARC_AT_FIRST_FRAME);
    }
  });

  it('crosses into the bite as a CUT, not a fade', () => {
    // The last sub-100 sample must be pure open-serpent, and 100 must be pure
    // finale, with no frame in between drawing both.
    const justUnder = pose(99.999);
    expect(justUnder.frame).toBe(FINALE_INDEX - 1);
    expect(pose(100).frame).toBe(FINALE_INDEX);
    expect(pose(100).rotationDeg).toBe(0);
  });
});
