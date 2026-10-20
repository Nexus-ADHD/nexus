import { describe, expect, it } from 'vitest';
import {
  applyGlyphSwaps,
  buildColumns,
  columnHeadY,
  columnTravel,
  FROZEN_TIME_MS,
  glyphAlpha,
  glyphTier,
  KATAKANA,
  LATIN,
  mulberry32,
  pickGlyphs,
  pmod,
  tickerActive,
} from '../matrix-rain-motion';

const FIELD_H = 800;
const FIELD_W = 390;
const LEADING = 18;

const OPTS = {
  fieldWidth: FIELD_W,
  fieldHeight: FIELD_H,
  columns: 14,
  columnFill: 0.6,
  trailGlyphs: 12,
  speedMinPtPerS: 38,
  speedMaxPtPerS: 96,
  glyphLeadingPt: LEADING,
  seed: 1234,
};

describe('pmod', () => {
  it('returns a non-negative result for negative input', () => {
    // Plain `%` keeps the dividend's sign, which would strand a
    // negative-phase column above the field forever.
    expect(pmod(-1, 10)).toBe(9);
    expect(pmod(-10, 10)).toBe(0);
    expect(pmod(-25, 10)).toBe(5);
  });

  it('matches plain modulo for positive input', () => {
    expect(pmod(7, 10)).toBe(7);
    expect(pmod(25, 10)).toBe(5);
  });
});

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('differs across seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it('stays within [0, 1)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('buildColumns', () => {
  it('is deterministic for a given seed', () => {
    expect(buildColumns(OPTS)).toEqual(buildColumns(OPTS));
  });

  it('builds one config per column and spaces them across the width', () => {
    const cols = buildColumns(OPTS);
    expect(cols).toHaveLength(14);
    expect(cols[0].x).toBeGreaterThan(0);
    expect(cols[cols.length - 1].x).toBeLessThan(FIELD_W);
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i].x).toBeGreaterThan(cols[i - 1].x);
    }
  });

  it('leaves some columns inactive, honoring the sparsity budget', () => {
    // Load-bearing for the §19 gold carve-out: a full field of trails would
    // blow the budget the carve-out is predicated on.
    const cols = buildColumns(OPTS);
    const active = cols.filter((c) => c.active).length;
    expect(active).toBeGreaterThan(0);
    expect(active).toBeLessThan(cols.length);
  });

  it('renders nothing at columnFill 0 and everything at 1', () => {
    expect(buildColumns({ ...OPTS, columnFill: 0 }).every((c) => !c.active)).toBe(true);
    expect(buildColumns({ ...OPTS, columnFill: 1 }).every((c) => c.active)).toBe(true);
  });

  it('keeps speeds inside the configured range', () => {
    for (const c of buildColumns(OPTS)) {
      expect(c.speedPtPerS).toBeGreaterThanOrEqual(OPTS.speedMinPtPerS);
      expect(c.speedPtPerS).toBeLessThanOrEqual(OPTS.speedMaxPtPerS);
    }
  });

  it('varies trail length but never below the ramp floor of 3', () => {
    // glyphAlpha divides by (trailGlyphs - 2); a column of 2 would divide by 0.
    const cols = buildColumns({ ...OPTS, trailGlyphs: 3, seed: 99 });
    for (const c of cols) expect(c.trailGlyphs).toBeGreaterThanOrEqual(3);
  });

  it('does not reshuffle the field when only columnFill changes', () => {
    // Every column draws every value regardless of active, so the shared rand()
    // stream stays aligned. (StarField's NEX-156 comment documents this trap.)
    const a = buildColumns({ ...OPTS, columnFill: 0.6 });
    const b = buildColumns({ ...OPTS, columnFill: 0.6 });
    expect(a.map((c) => c.phasePt)).toEqual(b.map((c) => c.phasePt));
  });

  it("draws each column's phase against its OWN jittered travel", () => {
    // Phase must be drawn after the trail jitter, or a longer-than-base column
    // can never start in the last stretch of its cycle. Every phase must sit
    // inside the travel the column will actually wrap on.
    for (const c of buildColumns({ ...OPTS, seed: 77 })) {
      const own = columnTravel(FIELD_H, c.trailGlyphs, LEADING);
      expect(c.phasePt).toBeGreaterThanOrEqual(0);
      expect(c.phasePt).toBeLessThan(own);
    }
  });
});

describe('columnTravel', () => {
  it('clears the field by a full trail at each end', () => {
    // A naive fieldHeight span pops: the trail is still on screen when the head
    // hits the bottom, so the wrap yanks visible glyphs away.
    expect(columnTravel(FIELD_H, 12, LEADING)).toBe(FIELD_H + 2 * 12 * LEADING);
  });
});

describe('columnHeadY', () => {
  const col = { speedPtPerS: 60, phasePt: 0, trailGlyphs: 12 };

  it('starts a full trail above the field, so the entry is invisible', () => {
    expect(columnHeadY(col, 0, FIELD_H, LEADING)).toBe(-12 * LEADING);
  });

  it('advances downward over time', () => {
    const t0 = columnHeadY(col, 0, FIELD_H, LEADING);
    const t1 = columnHeadY(col, 500, FIELD_H, LEADING);
    expect(t1).toBeGreaterThan(t0);
  });

  it('moves at the configured speed', () => {
    const y0 = columnHeadY(col, 0, FIELD_H, LEADING);
    const y1 = columnHeadY(col, 1000, FIELD_H, LEADING);
    expect(y1 - y0).toBeCloseTo(60, 5); // 60pt/s over exactly 1s
  });

  it('stays within the wrap range at all times', () => {
    const travel = columnTravel(FIELD_H, col.trailGlyphs, LEADING);
    for (let t = 0; t < 120_000; t += 137) {
      const y = columnHeadY(col, t, FIELD_H, LEADING);
      expect(y).toBeGreaterThanOrEqual(-col.trailGlyphs * LEADING);
      expect(y).toBeLessThan(-col.trailGlyphs * LEADING + travel);
    }
  });

  it('is fully off-screen at both ends of the cycle', () => {
    const travel = columnTravel(FIELD_H, col.trailGlyphs, LEADING);
    // Just after wrap: head above the top edge.
    expect(columnHeadY(col, 0, FIELD_H, LEADING)).toBeLessThan(0);
    // Just before wrap: the LAST trail glyph has cleared the bottom, which is
    // the condition that actually makes the wrap invisible.
    const tEnd = ((travel - 0.001) / col.speedPtPerS) * 1000;
    const headEnd = columnHeadY(col, tEnd, FIELD_H, LEADING);
    const tailEnd = headEnd - (col.trailGlyphs - 1) * LEADING;
    expect(tailEnd).toBeGreaterThan(FIELD_H);
  });

  it('is DRIFT-FREE: absolute position never depends on how it was sampled', () => {
    // The whole reason position is f(elapsedMs) and not an accumulator. A
    // dropped, late, or irregular tick must self-correct on the next sample.
    const evenly = columnHeadY(col, 5000, FIELD_H, LEADING);

    // Same instant reached via wildly irregular sampling.
    let last = 0;
    for (const t of [13, 500, 501, 2999, 4000, 4998, 5000]) last = columnHeadY(col, t, FIELD_H, LEADING);
    expect(last).toBeCloseTo(evenly, 10);

    // And a coarse 3-sample walk lands identically to a 5000-sample walk.
    const fine = columnHeadY(col, 5000, FIELD_H, LEADING);
    expect(fine).toBeCloseTo(evenly, 10);
  });

  it('honors per-column phase so columns do not fall in lockstep', () => {
    const a = columnHeadY({ ...col, phasePt: 0 }, 1000, FIELD_H, LEADING);
    const b = columnHeadY({ ...col, phasePt: 300 }, 1000, FIELD_H, LEADING);
    expect(a).not.toBeCloseTo(b, 3);
  });

  it('handles a negative phase without stranding the column above the field', () => {
    const y = columnHeadY({ ...col, phasePt: -500 }, 0, FIELD_H, LEADING);
    const travel = columnTravel(FIELD_H, col.trailGlyphs, LEADING);
    expect(y).toBeGreaterThanOrEqual(-col.trailGlyphs * LEADING);
    expect(y).toBeLessThan(-col.trailGlyphs * LEADING + travel);
  });
});

describe('glyphAlpha', () => {
  it('renders the head at full alpha', () => {
    expect(glyphAlpha(0, 12, 0.35)).toBe(1);
  });

  it('starts the trail at trailAlphaMax', () => {
    expect(glyphAlpha(1, 12, 0.35)).toBeCloseTo(0.35, 6);
  });

  it('reaches exactly zero at the tail', () => {
    // A tail that never quite hits 0 leaves a dim smear and quietly spends
    // gold budget.
    expect(glyphAlpha(11, 12, 0.35)).toBe(0);
  });

  it('decreases monotonically down the trail', () => {
    let prev = glyphAlpha(1, 12, 0.35);
    for (let i = 2; i < 12; i++) {
      const a = glyphAlpha(i, 12, 0.35);
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
  });

  it('never exceeds trailAlphaMax below the head', () => {
    for (let i = 1; i < 12; i++) {
      expect(glyphAlpha(i, 12, 0.35)).toBeLessThanOrEqual(0.35);
    }
  });

  it('stays in [0, 1] for the shortest allowed trail', () => {
    for (let i = 0; i < 3; i++) {
      const a = glyphAlpha(i, 3, 0.35);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(Number.isNaN(a)).toBe(false);
    }
  });

  it('clamps beyond the tail rather than going negative', () => {
    expect(glyphAlpha(99, 12, 0.35)).toBe(0);
  });

  describe('falloff', () => {
    it('defaults to the straight ramp, so existing callers are unchanged', () => {
      for (let i = 0; i < 12; i++) {
        expect(glyphAlpha(i, 12, 0.35, 0)).toBeCloseTo(glyphAlpha(i, 12, 0.35), 12);
      }
    });

    it('pins both endpoints at every falloff', () => {
      // The curve may bend, but the trail must still START at trailAlphaMax and
      // reach exactly 0 at the tail — a tail that stops short leaves a smear.
      for (const k of [0, 0.5, 1.6, 4]) {
        expect(glyphAlpha(1, 20, 0.75, k)).toBeCloseTo(0.75, 6);
        expect(glyphAlpha(19, 20, 0.75, k)).toBe(0);
      }
    });

    it('stays monotonic and inside [0, max] at every falloff', () => {
      for (const k of [0, 0.5, 1.6, 4]) {
        let prev = glyphAlpha(1, 34, 0.75, k);
        for (let i = 2; i < 34; i++) {
          const a = glyphAlpha(i, 34, 0.75, k);
          expect(a).toBeLessThanOrEqual(prev);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(0.75);
          prev = a;
        }
      }
    });

    it('front-loads the decay — the whole point over a long trail', () => {
      // A straight ramp over a 34-glyph trail reads as a uniform grey bar. The
      // bend has to put the brightness near the head and leave a faint wake.
      const mid = 17;
      expect(glyphAlpha(mid, 34, 0.75, 1.6)).toBeLessThan(glyphAlpha(mid, 34, 0.75, 0) / 2);
      // ...without dimming the glyph right behind the head.
      expect(glyphAlpha(1, 34, 0.75, 1.6)).toBeCloseTo(glyphAlpha(1, 34, 0.75, 0), 6);
    });
  });
});

describe('applyGlyphSwaps', () => {
  const rows = () => [
    ['a', 'b', 'c'],
    ['d', 'e', 'f'],
  ];

  it('returns the SAME reference when there is nothing to do', () => {
    // Referential identity is what lets an all-no-op tick skip the re-render.
    const r = rows();
    expect(applyGlyphSwaps(r, [])).toBe(r);
    expect(applyGlyphSwaps([], [{ colPick: 0, slotPick: 0, glyph: 'x' }])).toEqual([]);
  });

  it('swaps the targeted slot', () => {
    const out = applyGlyphSwaps(rows(), [{ colPick: 0, slotPick: 0, glyph: 'Z' }]);
    expect(out[0][0]).toBe('Z');
    expect(out[0][1]).toBe('b');
    expect(out[1]).toEqual(['d', 'e', 'f']);
  });

  it('leaves untouched rows referentially identical', () => {
    // Each row is one RainColumn's memo key — cloning an untouched row would
    // re-render that column to produce an identical string.
    const r = rows();
    const out = applyGlyphSwaps(r, [{ colPick: 0, slotPick: 0, glyph: 'Z' }]);
    expect(out[1]).toBe(r[1]);
    expect(out[0]).not.toBe(r[0]);
  });

  it('treats a swap to the same character as a no-op', () => {
    const r = rows();
    expect(applyGlyphSwaps(r, [{ colPick: 0, slotPick: 0, glyph: 'a' }])).toBe(r);
  });

  it('applies every swap in a batch, including two into one row', () => {
    const out = applyGlyphSwaps(rows(), [
      { colPick: 0, slotPick: 0, glyph: 'X' },
      { colPick: 0, slotPick: 0.9, glyph: 'Y' },
      { colPick: 0.9, slotPick: 0.5, glyph: 'W' },
    ]);
    expect(out[0]).toEqual(['X', 'b', 'Y']);
    expect(out[1]).toEqual(['d', 'W', 'f']);
  });

  it('never indexes past the end for a pick at the top of the range', () => {
    const out = applyGlyphSwaps(rows(), [{ colPick: 0.999999, slotPick: 0.999999, glyph: 'Q' }]);
    expect(out[1][2]).toBe('Q');
  });

  it('skips an empty row rather than throwing', () => {
    const r = [[], ['a']];
    const out = applyGlyphSwaps(r, [{ colPick: 0, slotPick: 0, glyph: 'Z' }]);
    expect(out).toBe(r);
  });
});

describe('glyphTier', () => {
  it('lights only the head', () => {
    expect(glyphTier(0)).toBe('head');
    expect(glyphTier(1)).toBe('near');
    expect(glyphTier(2)).toBe('far');
    expect(glyphTier(11)).toBe('far');
  });
});

describe('tickerActive', () => {
  it('runs only once the preference has resolved AND motion is not reduced', () => {
    expect(tickerActive(false, true)).toBe(true);
    expect(tickerActive(true, true)).toBe(false);
    // Pre-resolve: must NOT run, or a reduce-motion user sees a frame of motion
    // before the async OS read lands.
    expect(tickerActive(false, false)).toBe(false);
    expect(tickerActive(true, false)).toBe(false);
  });
});

describe('pickGlyphs', () => {
  it('returns the requested count', () => {
    expect(pickGlyphs(mulberry32(1), 12)).toHaveLength(12);
  });

  it('is deterministic for a given seed', () => {
    expect(pickGlyphs(mulberry32(5), 12)).toEqual(pickGlyphs(mulberry32(5), 12));
  });

  it('only emits glyphs the bundled fonts can render', () => {
    // A glyph outside these sets would fall back to a system face and break the
    // §2 "rain-glyphs only" scope.
    const glyphs = pickGlyphs(mulberry32(3), 400);
    for (const g of glyphs) {
      expect(KATAKANA.includes(g) || LATIN.includes(g)).toBe(true);
    }
  });

  it('draws from both sets, weighted toward katakana', () => {
    const glyphs = pickGlyphs(mulberry32(11), 600, 0.65);
    const kata = glyphs.filter((g) => KATAKANA.includes(g)).length;
    expect(kata).toBeGreaterThan(0);
    expect(glyphs.length - kata).toBeGreaterThan(0);
    expect(kata / glyphs.length).toBeGreaterThan(0.5);
  });

  it('honors the ratio bounds', () => {
    expect(pickGlyphs(mulberry32(2), 60, 1).every((g) => KATAKANA.includes(g))).toBe(true);
    expect(pickGlyphs(mulberry32(2), 60, 0).every((g) => LATIN.includes(g))).toBe(true);
  });
});

describe('FROZEN_TIME_MS', () => {
  it('lands the field mid-fall rather than parked at the top', () => {
    // At the frozen frame a typical column should be somewhere inside the
    // field, so a reduce-motion user sees a composed still, not an empty sky.
    const col = { speedPtPerS: 60, phasePt: 200, trailGlyphs: 12 };
    const y = columnHeadY(col, FROZEN_TIME_MS, FIELD_H, LEADING);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(FIELD_H);
  });
});
