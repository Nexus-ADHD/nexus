/**
 * The glide mapper, covered before any component draws with it.
 *
 * This seam has shipped three bugs and every one of them was a correct pure
 * module driven wrongly, so the rule for NEX-339 is that the maths is tested in
 * Node first and the component gets to own no arithmetic at all.
 *
 * The `poseForScore` and `fullResMatchesPose` suites were removed with the
 * functions: the hero draws ONE image now, so there is no body/head pair to
 * pose or to check for staleness. Their successor is
 * `ouroboros-frame-pose.test.ts`, which covers `framePoseForScore`. What stays
 * here is the arc ramp and the authored head table, both still live.
 */
import { describe, expect, it } from 'vitest';

import {
  ARC_AT_FINALE,
  ARC_AT_RAMP_TOP,
  ARC_AT_FIRST_FRAME,
  FINALE_INDEX,
  FINALE_SCORE,
  FIRST_FRAME_SCORE,
  FRAME_COUNT,
  FRAME_HEAD_DEG,
  MIN_VISIBLE_SCORE,
  NECK_DEG,
  arcForScore,
} from '../ouroboros-frames';

describe('FRAME_HEAD_DEG', () => {
  it('has one measured head angle per authored frame', () => {
    expect(FRAME_HEAD_DEG).toHaveLength(FRAME_COUNT);
  });

  it('is strictly increasing — the serpent only ever grows clockwise', () => {
    for (let i = 1; i < FRAME_HEAD_DEG.length; i += 1) {
      expect(FRAME_HEAD_DEG[i]).toBeGreaterThan(FRAME_HEAD_DEG[i - 1]);
    }
  });

  it('closes the ring exactly at the finale', () => {
    expect(FRAME_HEAD_DEG[FINALE_INDEX]).toBe(360);
  });

  it('is UNEVENLY spaced — the fact the whole ticket turns on', () => {
    const steps = FRAME_HEAD_DEG.slice(1).map((d, i) => d - FRAME_HEAD_DEG[i]);
    const spread = Math.max(...steps) / Math.min(...steps);
    // If this ever drops to ~1 the art was re-binned evenly and the glide is
    // no longer earning its complexity. That would be good news, not a failure,
    // but it should not pass silently.
    expect(spread).toBeGreaterThan(3);
  });
});

describe('arcForScore', () => {
  it('draws nothing below the visible floor', () => {
    expect(arcForScore(0)).toBeNull();
    expect(arcForScore(MIN_VISIBLE_SCORE - 0.01)).toBeNull();
  });

  it('draws nothing for values that are not numbers', () => {
    expect(arcForScore(Number.NaN)).toBeNull();
    expect(arcForScore(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('holds at the shortest authored arc between the floor and the first frame', () => {
    // A serpent shorter than its own head is broken, not short.
    expect(arcForScore(MIN_VISIBLE_SCORE)).toBe(ARC_AT_FIRST_FRAME);
    expect(arcForScore(18)).toBe(ARC_AT_FIRST_FRAME);
    expect(arcForScore(FIRST_FRAME_SCORE)).toBe(ARC_AT_FIRST_FRAME);
  });

  it('never asks for less arc than a head and neck occupy', () => {
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      const arc = arcForScore(s);
      expect(arc).not.toBeNull();
      expect(arc as number).toBeGreaterThanOrEqual(NECK_DEG);
    }
  });

  it('closes the ring at an exact 100', () => {
    expect(arcForScore(FINALE_SCORE)).toBe(ARC_AT_FINALE);
    expect(arcForScore(101)).toBe(ARC_AT_FINALE);
  });

  it('grows at a CONSTANT rate — the fix for the lurch', () => {
    const rate = (s: number) => (arcForScore(s + 1) as number) - (arcForScore(s) as number);
    const first = rate(FIRST_FRAME_SCORE);
    for (let s = FIRST_FRAME_SCORE; s < FINALE_SCORE - 1; s += 1) {
      expect(rate(s)).toBeCloseTo(first, 6);
    }
    // and that rate is the even one, not the art's 19-to-68 swing.
    // The ramp ends at ARC_AT_RAMP_TOP, not at the closed ring: running it to
    // 360 is what borrowed the bite frame as a body and drew two heads.
    expect(first).toBeCloseTo((ARC_AT_RAMP_TOP - ARC_AT_FIRST_FRAME) / 80, 6);
  });

  it('stops the ramp at the longest NON-bite frame', () => {
    expect(ARC_AT_RAMP_TOP).toBe(FRAME_HEAD_DEG[FINALE_INDEX - 1]);
    expect(ARC_AT_RAMP_TOP).toBeLessThan(ARC_AT_FINALE);
    // 99.99 must still be reachable by a real body frame; 100 alone closes.
    expect(arcForScore(99.99) as number).toBeLessThanOrEqual(ARC_AT_RAMP_TOP);
    expect(arcForScore(100)).toBe(ARC_AT_FINALE);
  });

  it('is monotonic across the whole range', () => {
    let prev = -1;
    for (let s = MIN_VISIBLE_SCORE; s <= 100; s += 0.25) {
      const arc = arcForScore(s) as number;
      expect(arc).toBeGreaterThanOrEqual(prev);
      prev = arc;
    }
  });
});
