import { describe, expect, it } from 'vitest';

import {
  ARC_AT_FINALE,
  ARC_AT_FIRST_FRAME,
  NECK_DEG,
} from '../ouroboros-frames';
import {
  angleFromTwelve,
  angularTaper,
  buildBaseGrid,
  displaceGrid,
  radialProfile,
  restScale,
  waveOffsetAt,
  type Pt,
} from '../ouroboros-wave';

const SIZE = 300;

/** Every neck angle the score can actually put the join at. */
const NECK_ANGLES = Array.from({ length: 41 }, (_, i) => {
  const arc = ARC_AT_FIRST_FRAME + ((ARC_AT_FINALE - ARC_AT_FIRST_FRAME) * i) / 40;
  return Math.max(arc - NECK_DEG, 0);
});

/** A full cycle of the wave, sampled finely enough to catch a sign flip. */
const PHASES = Array.from({ length: 24 }, (_, i) => (i / 24) * 2 * Math.PI);

describe('angleFromTwelve', () => {
  it('measures clockwise from twelve, matching FRAME_HEAD_DEG', () => {
    expect(angleFromTwelve(0, -1)).toBeCloseTo(0);
    expect(angleFromTwelve(1, 0)).toBeCloseTo(90);
    expect(angleFromTwelve(0, 1)).toBeCloseTo(180);
    expect(angleFromTwelve(-1, 0)).toBeCloseTo(270);
  });
});

describe('angularTaper', () => {
  it('is zero at the tail anchor and at the neck, for every reachable neck', () => {
    for (const neck of NECK_ANGLES) {
      expect(angularTaper(0, 0, neck)).toBe(0);
      expect(angularTaper(neck, 0, neck)).toBe(0);
    }
  });

  it('never goes negative or exceeds one, anywhere', () => {
    for (const neck of NECK_ANGLES) {
      for (let deg = 0; deg <= 360; deg += 0.5) {
        const t = angularTaper(deg, 0, neck);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stays zero past the neck, so nothing moves under the head sprite', () => {
    for (const neck of NECK_ANGLES) {
      for (let deg = neck; deg <= 360; deg += 1) {
        expect(angularTaper(deg, 0, neck)).toBe(0);
      }
    }
  });

  it('still reaches full strength on a long serpent', () => {
    const neck = ARC_AT_FINALE - NECK_DEG;
    expect(angularTaper(neck / 2, 0, neck)).toBeCloseTo(1);
  });

  it('degrades continuously rather than tearing when the serpent is short', () => {
    // The shortest reachable neck is under two nominal ramps, which is the case
    // a fixed-width taper would get wrong.
    const neck = ARC_AT_FIRST_FRAME - NECK_DEG;
    expect(neck).toBeLessThan(80);
    let prev = angularTaper(0, 0, neck);
    for (let deg = 0; deg <= neck; deg += 0.25) {
      const t = angularTaper(deg, 0, neck);
      expect(Math.abs(t - prev)).toBeLessThan(0.05);
      prev = t;
    }
  });
});

describe('radialProfile', () => {
  // Measured from the shipped WebPs: the art spans 0.2198..0.4936 of the box at
  // the finale, so every one of those radii must move as one piece or the
  // filigree shears.
  const ART_MIN = 0.2198;
  const ART_MAX = 0.4936;

  it('moves the whole authored silhouette at full strength', () => {
    for (let f = ART_MIN; f <= ART_MAX; f += 0.005) {
      expect(radialProfile(f * SIZE, SIZE)).toBe(1);
    }
  });

  it('is gone by the corner, so no corner vertex can leave the frame', () => {
    expect(radialProfile(Math.SQRT1_2 * SIZE, SIZE)).toBe(0);
  });

  it('is monotonic moving outward', () => {
    let prev = 1;
    for (let r = 0; r <= SIZE; r += 1) {
      const p = radialProfile(r, SIZE);
      expect(p).toBeLessThanOrEqual(prev + 1e-9);
      prev = p;
    }
  });

  it('keeps the finale inside the frame once the rest-inset is applied', () => {
    // The score-100 art's outer gold sits 0.0064 of the box from the edge. This
    // is the case that made the inset necessary; assert it directly rather than
    // trusting the grid test to happen to sample that radius.
    // 0.05 is selectable on the spike screen, so the bound is checked there too.
    for (const amp of [0.01, 0.02, 0.03, 0.05]) {
      const peak = ART_MAX * restScale(amp) + amp * radialProfile(ART_MAX * SIZE, SIZE);
      expect(peak).toBeLessThanOrEqual(ART_MAX);
    }
  });
});

describe('waveOffsetAt — the neck invariant', () => {
  it('displaces nothing at the tail or the neck, at every score and phase', () => {
    const c = SIZE / 2;
    const rBody = 0.38714 * SIZE;
    for (const neck of NECK_ANGLES) {
      for (const phase of PHASES) {
        // On the tail anchor (twelve o'clock) and on the neck join.
        const tail = waveOffsetAt(c, c - rBody, SIZE, 0, neck, phase, 0.03);
        expect(tail).toBe(0);

        const rad = (neck * Math.PI) / 180;
        const nx = c + Math.sin(rad) * rBody;
        const ny = c - Math.cos(rad) * rBody;
        expect(Math.abs(waveOffsetAt(nx, ny, SIZE, 0, neck, phase, 0.03))).toBeLessThan(1e-9);
      }
    }
  });

  it('is identically zero at zero amplitude — the Reduce Motion path', () => {
    for (const neck of NECK_ANGLES) {
      for (const phase of PHASES) {
        for (let deg = 0; deg < 360; deg += 7) {
          const rad = (deg * Math.PI) / 180;
          const x = SIZE / 2 + Math.sin(rad) * 0.38714 * SIZE;
          const y = SIZE / 2 - Math.cos(rad) * 0.38714 * SIZE;
          expect(waveOffsetAt(x, y, SIZE, 0, neck, phase, 0)).toBe(0);
        }
      }
    }
  });

  it('actually moves the body somewhere, or the whole ticket is a no-op', () => {
    const neck = 200;
    let peak = 0;
    for (const phase of PHASES) {
      for (let deg = 0; deg < 360; deg += 2) {
        const rad = (deg * Math.PI) / 180;
        const x = SIZE / 2 + Math.sin(rad) * 0.38714 * SIZE;
        const y = SIZE / 2 - Math.cos(rad) * 0.38714 * SIZE;
        peak = Math.max(peak, Math.abs(waveOffsetAt(x, y, SIZE, 0, neck, phase, 0.02)));
      }
    }
    expect(peak).toBeGreaterThan(0.015 * SIZE);
  });
});

describe('displaceGrid', () => {
  const N = 24;

  it('keeps every vertex inside the frame, so no UV samples off-texture', () => {
    const base = buildBaseGrid(SIZE, N);
    const out: Pt[] = new Array(base.points.length);
    // Accumulate the extremes and assert once. Asserting per vertex is ~2.4M
    // expect() calls and times the suite out without testing anything more.
    let lo = Infinity;
    let hi = -Infinity;
    for (const neck of NECK_ANGLES) {
      for (const phase of PHASES) {
        displaceGrid(base.points, out, SIZE, 0, neck, phase, 0.03);
        for (const p of out) {
          lo = Math.min(lo, p.x, p.y);
          hi = Math.max(hi, p.x, p.y);
        }
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(SIZE);
  });

  it('returns the base grid unchanged at zero amplitude', () => {
    const base = buildBaseGrid(SIZE, N);
    const out: Pt[] = new Array(base.points.length);
    displaceGrid(base.points, out, SIZE, 0, 300, 1.2, 0);
    out.forEach((p, i) => {
      expect(p.x).toBeCloseTo(base.points[i].x);
      expect(p.y).toBeCloseTo(base.points[i].y);
    });
  });

  it('emits three indices per triangle and two triangles per cell', () => {
    const { points, indices } = buildBaseGrid(SIZE, N);
    expect(points).toHaveLength((N + 1) * (N + 1));
    expect(indices).toHaveLength(N * N * 6);
    expect(Math.max(...indices)).toBeLessThan(points.length);
    expect(Math.min(...indices)).toBe(0);
  });
});
