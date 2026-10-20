/**
 * Pure MatrixRain motion decisions, split out so vitest (node env) can cover
 * them — MatrixRain.tsx imports react-native + Reanimated and cannot load under
 * the node test runner. Exactly why `starfield-motion.ts` exists; mirror that
 * file's shape.
 *
 * NEX-303. Two rules this module exists to enforce, both learned the hard way
 * during planning:
 *
 * 1. Position is a pure function of ELAPSED time, never an accumulator.
 *    `y += speed * dt` drifts against vsync and reads as judder. StarField gets
 *    away with a lot because opacity twinkle is phase-insensitive; falling
 *    glyphs are position-sensitive and every dropped frame would show. The
 *    clock hands us `elapsedMs` and we derive absolute position from it, so a
 *    late or skipped tick self-corrects on the next one.
 *
 * 2. Randomness is seeded. No bare Math.random() anywhere in the model, so a
 *    given seed always builds the same field and tests are deterministic.
 */

/**
 * The frozen frame the rain holds at under Reduce Motion. Column position is a
 * pure function of time, so one static value lands the field mid-fall at varied
 * per-column offsets — a still but composed frame rather than every column
 * parked at the top. Device-tune if it lands sparse.
 *
 * Note the resume path does NOT use this: `matrix-rain-clock` freezes at the
 * CURRENT value so toggling Reduce Motion on holds the exact frame the user was
 * looking at. This constant is only the cold-start / pre-resolve frame.
 */
export const FROZEN_TIME_MS = 2200;

/**
 * Seeded PRNG (mulberry32). Same role as StarField's `seededRandom`: a stable
 * field per dimension, and deterministic tests.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A positive modulo. JS `%` keeps the sign of the dividend, which would put a
 *  negative-phase column above the field forever. */
export function pmod(n: number, m: number): number {
  'worklet';
  return ((n % m) + m) % m;
}

export interface ColumnConfig {
  /** Column index, left to right. */
  readonly index: number;
  /** Left offset in pt. */
  readonly x: number;
  /** Fall speed, pt per second. */
  readonly speedPtPerS: number;
  /** Starting offset in pt, so columns don't fall in lockstep. */
  readonly phasePt: number;
  /** Trail length for this column, head included. Varied per column. */
  readonly trailGlyphs: number;
  /** False for a column left empty by the sparsity budget — it renders nothing. */
  readonly active: boolean;
}

export interface BuildColumnsOptions {
  readonly fieldWidth: number;
  readonly columns: number;
  readonly columnFill: number;
  readonly trailGlyphs: number;
  readonly speedMinPtPerS: number;
  readonly speedMaxPtPerS: number;
  readonly glyphLeadingPt: number;
  readonly fieldHeight: number;
  readonly seed: number;
}

/**
 * Build the (stable, seeded) column field for a given size.
 *
 * Sparsity is deliberate and load-bearing for the §19 gold carve-out: roughly
 * `columnFill` of the columns carry a trail, the rest render nothing. Turning
 * this up spends the gold budget.
 *
 * Footgun for future editors: this calls `columnTravel`, which is declared BELOW
 * it and carries a 'worklet' directive. The Babel plugin rewrites a worklet
 * `export function` into a `var … = factory(…)` binding, which is NOT hoisted.
 * That is fine here because the call happens at call-time. It would throw a TDZ
 * error if `buildColumns` were ever invoked during this module's own evaluation.
 * Don't call it at module scope.
 */
export function buildColumns(opts: BuildColumnsOptions): ColumnConfig[] {
  const {
    fieldWidth, columns, columnFill, trailGlyphs,
    speedMinPtPerS, speedMaxPtPerS, glyphLeadingPt, fieldHeight, seed,
  } = opts;

  const rand = mulberry32(seed);
  const pitch = fieldWidth / Math.max(1, columns);
  const out: ColumnConfig[] = [];

  for (let i = 0; i < columns; i++) {
    // Draw every value for every column, active or not, so toggling a column's
    // active flag can't shift the shared rand() stream and reshuffle the field
    // (the trap StarField's NEX-156 comment documents for `spiked`).
    const active = rand() < columnFill;
    const speedPtPerS = speedMinPtPerS + rand() * (speedMaxPtPerS - speedMinPtPerS);
    // ±2 glyphs of trail variation, floored at 3 so the ramp never divides by
    // zero in glyphAlpha.
    const jitter = Math.round((rand() - 0.5) * 4);
    const len = Math.max(3, trailGlyphs + jitter);
    // Phase is drawn AFTER the jitter, against this column's OWN travel. Drawing
    // it from the base `trailGlyphs` travel (as an earlier draft did) meant a
    // longer-than-base column could never start in the last stretch of its cycle
    // — harmless, since pmod keeps it in range and a constant offset in a
    // continuous cycle is invisible, but the distribution didn't match what the
    // code claimed.
    const phasePt = rand() * columnTravel(fieldHeight, len, glyphLeadingPt);
    out.push({
      index: i,
      x: i * pitch + pitch / 2,
      speedPtPerS,
      phasePt,
      trailGlyphs: len,
      active,
    });
  }
  return out;
}

/**
 * The wrap span for a column, in pt.
 *
 * Sized so the column is FULLY off-screen at both ends of the cycle, which is
 * what makes the wrap invisible. A naive `fieldHeight` span pops: the trail is
 * still on screen when the head reaches the bottom, so the wrap yanks visible
 * glyphs away. One trail-length of clearance at each end fixes it.
 */
export function columnTravel(fieldHeight: number, trailGlyphs: number, glyphLeadingPt: number): number {
  'worklet';
  return fieldHeight + 2 * trailGlyphs * glyphLeadingPt;
}

/**
 * Head Y for a column at `elapsedMs`, in pt. Pure function of elapsed time —
 * see rule 1 in the file header.
 *
 * Range is [-trailGlyphs*leading, fieldHeight + trailGlyphs*leading): starts a
 * full trail above the field (invisible), ends a full trail below it
 * (invisible). Trail glyph `i` sits at `headY - i * leading`.
 *
 * Marked 'worklet' so `useAnimatedStyle` can call it on the UI thread. Keeping
 * the formula here rather than inlining it in the component is what lets the
 * tests cover the thing that actually renders.
 */
export function columnHeadY(
  col: Pick<ColumnConfig, 'speedPtPerS' | 'phasePt' | 'trailGlyphs'>,
  elapsedMs: number,
  fieldHeight: number,
  glyphLeadingPt: number,
): number {
  'worklet';
  const travel = columnTravel(fieldHeight, col.trailGlyphs, glyphLeadingPt);
  const raw = col.phasePt + col.speedPtPerS * (elapsedMs / 1000);
  return pmod(raw, travel) - col.trailGlyphs * glyphLeadingPt;
}

/**
 * Alpha for trail glyph `i` (0 = head).
 *
 * Head is full. The glyph directly behind it starts at `trailAlphaMax` and the
 * ramp reaches exactly 0 at the tail — a tail that never quite hits zero leaves
 * a dim smear.
 *
 * `falloff` bends the ramp between those fixed endpoints. At 0 it is the
 * original straight line. Above 0 the decay is front-loaded: brightness
 * collapses fast just behind the head and then trails off slowly, which is what
 * the reference footage actually does — a hot leading edge with a long, faint
 * wake, not an even fade. A linear ramp over a LONG trail reads as a uniform
 * grey bar, so the longer the trail the more this matters.
 *
 * The curve is `(1-t) * e^(-k*t)`, which is strictly decreasing for any k >= 0
 * (its derivative is `-e^(-kt) * (1 + k(1-t))`, negative across the range), so
 * the monotonicity the tests pin holds at every falloff.
 */
export function glyphAlpha(
  i: number,
  trailGlyphs: number,
  trailAlphaMax: number,
  falloff = 0,
): number {
  // Deliberately NOT a worklet: the trail ramp is static relative to its column,
  // so this is evaluated once per glyph on the JS thread when the row renders,
  // never on the UI thread. A 'worklet' directive here would emit a dead
  // __initData blob (source + sourcemap) into the bundle for nothing.
  if (i <= 0) return 1;
  if (i >= trailGlyphs - 1) return 0;
  // i=1 → trailAlphaMax, i=trailGlyphs-1 → 0.
  const t = (i - 1) / (trailGlyphs - 2);
  return trailAlphaMax * (1 - t) * Math.exp(-falloff * t);
}

/** One pending glyph mutation. The picks are raw [0,1) draws rather than
 *  resolved indices so the caller can draw them OUTSIDE a React updater — see
 *  the swap ticker in MatrixRain.tsx for why that matters. */
export interface GlyphSwap {
  readonly colPick: number;
  readonly slotPick: number;
  readonly glyph: string;
}

/**
 * Apply a batch of glyph mutations to a field's glyph rows.
 *
 * Returns the SAME array reference when nothing actually changed, and clones
 * only the rows it touches — both matter, because each row is the memo key for
 * one RainColumn, and a fresh array for an untouched column would re-render it
 * for nothing. At the mutation rates this field runs, that difference is most
 * of the swap ticker's cost.
 */
export function applyGlyphSwaps(
  rows: readonly (readonly string[])[],
  swaps: readonly GlyphSwap[],
): readonly (readonly string[])[] {
  if (rows.length === 0 || swaps.length === 0) return rows;
  let next: (readonly string[])[] | null = null;
  for (const s of swaps) {
    const c = Math.min(rows.length - 1, Math.max(0, Math.floor(s.colPick * rows.length)));
    const row = (next ?? rows)[c];
    if (!row || row.length === 0) continue;
    const slot = Math.min(row.length - 1, Math.max(0, Math.floor(s.slotPick * row.length)));
    // A swap to the same character is a no-op; skipping it keeps the column's
    // memo intact instead of re-rendering to produce an identical string.
    if (row[slot] === s.glyph) continue;
    if (!next) next = rows.slice();
    const swapped = row.slice();
    swapped[slot] = s.glyph;
    next[c] = swapped;
  }
  return next ?? rows;
}

export type GlyphTier = 'head' | 'near' | 'far';

/**
 * Color tier for trail glyph `i`. Three discrete tiers rather than a continuous
 * hue interpolation: the alpha ramp already carries the fade, and only the head
 * is meant to read as lit (§19 carve-out).
 */
export function glyphTier(i: number): GlyphTier {
  // JS-thread only, same as glyphAlpha — see the note there.
  if (i <= 0) return 'head';
  if (i === 1) return 'near';
  return 'far';
}

/**
 * Whether the ~60fps clock should run. Re-exported from starfield-motion rather
 * than restated: it is the same predicate ("resolved AND not reduced"), and two
 * copies would drift. The shared clock freezes both fields together.
 */
export { tickerActive } from './starfield-motion';

/**
 * Glyph alphabet. Latin caps + digits come from IBM Plex Mono (already
 * bundled); katakana comes from the Plex Sans JP subset sanctioned in §2.
 *
 * Katakana is deliberately weighted heavier than Latin — it carries the
 * reference look, and Latin alone reads as a terminal, not rain.
 */
export const KATAKANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
export const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Pick `count` glyphs for one column. Seeded — see rule 2 in the file header. */
export function pickGlyphs(rand: () => number, count: number, katakanaRatio = 0.65): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const set = rand() < katakanaRatio ? KATAKANA : LATIN;
    out.push(set[Math.floor(rand() * set.length)]);
  }
  return out;
}

// There is deliberately no `swapEpoch(elapsedMs, interval)` helper here. An
// earlier draft had one, documented as driving the component's glyph mutation —
// but the component drives that off its own low-frequency wall-clock interval
// and never imported it, so the helper was unshipped code with five tests
// asserting behaviour nothing depended on.
//
// Rule 1 (position from elapsed time, never an accumulator) does NOT extend to
// the glyph swap: a swap is phase-insensitive, so a late or dropped tick costs
// nothing, and there is no position to drift. The rule exists for the fall,
// where a dropped tick would otherwise accumulate into judder.
