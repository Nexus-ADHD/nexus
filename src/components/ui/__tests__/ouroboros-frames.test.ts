import { describe, expect, it } from 'vitest';

import {
  FINALE_INDEX,
  FIRST_FRAME_SCORE,
  FINALE_SCORE,
  FRAME_COUNT,
  FRAME_SCORES,
  FRAME_STEP,
  MIN_VISIBLE_SCORE,
  frameForScore,
  scoreForFrame,
} from '../ouroboros-frames';

describe('the frame table', () => {
  it('is 10 frames from 20, ending on the finale', () => {
    // Was 9 on a strict 10-point grid. The tenth is score 95, added to narrow
    // the step into the finale from 20 degrees of arc to 4.
    expect(FRAME_COUNT).toBe(10);
    expect(FRAME_SCORES[0]).toBe(FIRST_FRAME_SCORE);
    expect(FRAME_SCORES[FINALE_INDEX]).toBe(FINALE_SCORE);
  });

  it('ascends strictly, on the 10-point grid apart from the deliberate 95', () => {
    // The grid assertion is kept rather than dropped, because an ACCIDENTAL
    // off-grid score is still a bug -- it would mean a frame was binned to a
    // slot nobody chose. 95 is named here so it has to be intended.
    const OFF_GRID = new Set([95]);
    FRAME_SCORES.forEach((s, i) => {
      if (i > 0) expect(s).toBeGreaterThan(FRAME_SCORES[i - 1]);
      if (!OFF_GRID.has(s)) {
        expect((s - FIRST_FRAME_SCORE) % FRAME_STEP).toBe(0);
      }
    });
  });

  it('round-trips every frame through scoreForFrame', () => {
    FRAME_SCORES.forEach((score, i) => {
      expect(scoreForFrame(i)).toBe(score);
      // and the score that frame represents maps back to it
      expect(frameForScore(score)).toBe(i);
    });
  });
});

describe('frameForScore', () => {
  it('draws NOTHING at zero — the still frame the ring paints while reduce-motion resolves', () => {
    // Load-bearing, not cosmetic. AlignmentScoreRing initialises the serpent
    // score to 0 precisely because that drew an empty layer list under the rig;
    // initialising it to a DRAWN state made the serpent paint at full length
    // and snap backwards on the first count-up frame (NEX-334).
    expect(frameForScore(0)).toBeNull();
  });

  it('draws nothing below half a step, and something from half a step up', () => {
    expect(frameForScore(MIN_VISIBLE_SCORE - 0.001)).toBeNull();
    expect(frameForScore(MIN_VISIBLE_SCORE)).toBe(0);
  });

  it('reserves the bite for an exact 100', () => {
    // The owner's constraint: the tail-in-mouth pose is the score-100 ceremony,
    // so nearest-rounding must NOT hand it to 97.5+. Mirrors the rig's isFinale,
    // which asserted 99.99 is not the finale.
    expect(frameForScore(FINALE_SCORE)).toBe(FINALE_INDEX);
    expect(frameForScore(101)).toBe(FINALE_INDEX);
    expect(frameForScore(99.99)).toBe(FINALE_INDEX - 1);
    expect(frameForScore(95)).toBe(FINALE_INDEX - 1);
    expect(frameForScore(99.999999)).toBe(FINALE_INDEX - 1);
  });

  it('holds the frame below the finale across the whole 95..100 approach', () => {
    for (let s = 95; s < 100; s += 0.1) {
      expect(frameForScore(s)).toBe(FINALE_INDEX - 1);
    }
  });

  it('never decreases as the score rises', () => {
    let prev = -1;
    for (let s = 0; s <= 100; s += 0.25) {
      const f = frameForScore(s) ?? -1;
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('reaches every frame — no frame is unreachable', () => {
    const seen = new Set<number>();
    for (let s = 0; s <= 100; s += 0.1) {
      const f = frameForScore(s);
      if (f !== null) seen.add(f);
    }
    seen.add(frameForScore(100) as number);
    expect(seen.size).toBe(FRAME_COUNT);
  });

  it('rounds to the nearest frame, not the floor', () => {
    expect(frameForScore(43)).toBe(frameForScore(40)); // 43 -> 40
    expect(frameForScore(47)).toBe(frameForScore(50)); // 47 -> 50
    // and the floor: anything under 15 draws nothing at all
    expect(frameForScore(14.9)).toBeNull();
  });

  it('clamps a too-high score to the finale but draws nothing for garbage', () => {
    expect(frameForScore(101)).toBe(FINALE_INDEX);
    expect(frameForScore(-1)).toBeNull();
    expect(frameForScore(-9999)).toBeNull();
    // Non-finite is not a score, so it fails toward drawing nothing rather than
    // toward the finale — a NaN must never light the score-100 ceremony.
    expect(frameForScore(NaN)).toBeNull();
    expect(frameForScore(Infinity)).toBeNull();
    expect(frameForScore(-Infinity)).toBeNull();
  });

  it('stays inside the frame table for every score it accepts', () => {
    for (let s = 0; s <= 120; s += 0.13) {
      const f = frameForScore(s);
      if (f === null) continue;
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(FINALE_INDEX);
      expect(FRAME_SCORES[f]).toBeDefined();
    }
  });
});
