/**
 * NEX-303 — the loading-surface glyph rain.
 *
 * A restrained, gold Matrix-style rain that replaces the stock ActivityIndicator
 * on the app's loading surfaces. Sanctioned as the THIRD continuous-animation
 * exception in CLAUDE.md §2, scoped to loading surfaces only (it never runs on
 * an interactive screen), with a §19 ceremony carve-out for the gold budget.
 *
 * ── Why this is plain RN + Reanimated and NOT Skia ──────────────────────────
 *
 * Skia is already a dependency and drew the first draft of this. Two plan
 * reviews killed it, for reasons worth keeping written down:
 *
 *  - The cold-start gates render BEFORE fonts load. `app/_layout.tsx`'s auth
 *    gate returns earlier than its `!fontsLoaded` gate, and Skia's `useFont` is
 *    an async URI fetch (skia/core/Data.js → `Skia.Data.fromURI().then()`)
 *    racing the Font.loadAsync of seven faces. The gate would unmount before the
 *    font resolved: full cost paid, bare wordmark shown, every launch.
 *  - `Skia.Surface.MakeOffscreen` returns `SkSurface | null` and throws during
 *    render if unhandled — and those gates are early returns that never reach
 *    the <ErrorBoundary>. An atlas failure would be an uncaught render error on
 *    the app's first paint.
 *  - Skia's `useClock` is not an escape hatch: it is a four-line wrapper around
 *    `useFrameCallback`, the exact API StarField documents as silently failing
 *    on this Reanimated 4 / SDK 54 runtime.
 *  - The glyph budget never justified it. (This was the weakest of the four
 *    reasons and is now the only one that has moved: the field runs ~2600
 *    glyphs. It still does not justify Skia, because a column collapsed to a
 *    single native text view — see the next section — so the view count went
 *    DOWN while the glyph count went up. The three reasons above are the ones
 *    that actually bind, and none of them have changed.)
 *
 * ── Architecture: mirror StarField ──────────────────────────────────────────
 *
 * StarField is the in-repo existence proof, so copy it rather than invent:
 *
 *  - ONE setInterval(~16ms) writes a monotonic `time` SharedValue. NOT
 *    useFrameCallback (see StarField's v9.2 note — it silently fails here).
 *  - Each column reads `time` inside one useAnimatedStyle and derives its
 *    translateY purely from it. No per-column withRepeat, no per-column
 *    useEffect — that is what survives Fast Refresh.
 *  - A column's glyphs sit at STATIC opacity relative to the column (head at
 *    1.0, ramping to 0 down the trail), so the trail costs zero per-frame work.
 *    Only the column transform animates: 64 animated nodes for ~2600 glyphs.
 *    StarField holds 60fps with 80, and both fields run on the splash together,
 *    so ~144 animated nodes is the number to watch if it ever janks.
 *
 * ── One native view per COLUMN, not per glyph ────────────────────────────────
 *
 * The original renderer gave every glyph its own absolutely-positioned <Text>.
 * That is fine at a few hundred glyphs and untenable at the density this field
 * now runs (~2600), because each one is a native text view mounted on the app's
 * FIRST PAINT, on the cold-start gate, while the JS thread is also resolving
 * auth.
 *
 * A column is now ONE <Text> whose children are nested <Text> runs, one per
 * glyph, separated by newlines. Nested Text in React Native is not a view — it
 * compiles to attributed-string runs inside a single native text node — so a
 * 34-glyph column costs one view instead of 34. 64 native text views carry the
 * whole field.
 *
 * Two things this forces, both load-bearing:
 *
 *  - Per-glyph alpha is baked into the run's `color` as rgba, NOT set via the
 *    `opacity` style. `opacity` is a view property and has no meaning on a
 *    virtual text run; rgba is an attributed-string attribute and does.
 *  - The trail renders BOTTOM-UP. Text flows downward, but a column's head is
 *    its lowest glyph, so the runs are emitted tail-first and the block is
 *    offset up by `(n-1) * leading` to put the head back at the column origin.
 *    Line `j` therefore holds trail index `n - 1 - j`.
 *
 * `lineHeight` is set explicitly, so the one-glyph-per-line pitch holds even
 * before the fonts resolve and the OS is substituting a fallback face.
 *
 * Two concurrent tickers (this one + StarField's) run on the interstitial. That
 * is deliberate and accepted: the cost is ~145 JS wakeups/sec (this field's
 * ~62/sec clock plus its ~18/sec swap ticker, and StarField's own ~62/sec)
 * doing microsecond
 * work, and because position is a pure function of elapsed time (see
 * matrix-rain-motion.ts), tick drift self-corrects on the next sample instead of
 * accumulating into judder. Sharing StarField's clock would mean refactoring a
 * §2-LOCKED component for no visible gain; revisit only if device profiling says
 * otherwise.
 *
 * IMPORTANT (memory: reanimated_hook_aliases_break_worklets): Reanimated hook
 * names must NOT be renamed on import — the Babel plugin detects
 * useAnimatedStyle / useSharedValue by exact name.
 */

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { useReduceMotion } from '@/hooks/use-reduce-motion';
import tokens from '@/src/theme/tokens';
import {
  applyGlyphSwaps,
  buildColumns,
  columnHeadY,
  FROZEN_TIME_MS,
  glyphAlpha,
  glyphTier,
  KATAKANA,
  mulberry32,
  pickGlyphs,
  tickerActive,
  type ColumnConfig,
  type GlyphSwap,
} from './matrix-rain-motion';

const RAIN = tokens.motion.rain;

/** '#RRGGBB' → [r, g, b], so per-glyph alpha can be composed into an rgba()
 *  string. Module scope: the palette never changes at runtime. */
function rgbTriple(hex: string): readonly [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The head glyph is WHITE, not gold. This is the effect's signature — a
// white-hot leading character with a colored wake — and it is the single
// biggest visual gain available here, because a uniformly-gold column reads as
// a gradient rather than as a stream with a front. White is also the most
// sanctioned color in the system (§4.3 primary text, the StarField's own star
// color), so the leading edge costs nothing against the gold rules.
const TIER_RGB = {
  head: rgbTriple(tokens.color.text),
  near: rgbTriple(tokens.color.goldBright),
  far:  rgbTriple(tokens.color.gold),
} as const;

/**
 * Katakana comes from the Plex Sans JP subset (§2's sanctioned fourth face);
 * Latin and numerals stay on the already-bundled Plex Mono, which §5 already
 * designates for "all numerals and data".
 *
 * Before Font.loadAsync resolves these names are unregistered and the OS falls
 * back to the system face, which has katakana on iOS. That is not a bug, it is
 * the entire reason this is not Skia: the rain still DRAWS at cold start, then
 * snaps to Plex once the faces land.
 */
function glyphFamily(g: string): string {
  return KATAKANA.includes(g) ? 'IBMPlexSansJP-Katakana' : tokens.font.plexMonoMedium;
}

/** The seeded glyph rows for a field. Per column, so a column's glyphs are
 *  stable across rebuilds at the same size. */
function seedGlyphs(cols: readonly ColumnConfig[], seed: number): string[][] {
  return cols.map((c) => pickGlyphs(mulberry32(seed + c.index), c.trailGlyphs));
}

interface RainColumnProps {
  readonly col: ColumnConfig;
  readonly time: SharedValue<number>;
  readonly fieldHeight: number;
  readonly glyphs: readonly string[];
  /** Vertical pitch between glyphs — differs per layer (near vs far field). */
  readonly leading: number;
  readonly size: number;
  /** Trail ramp ceiling for this layer. */
  readonly alphaMax: number;
  /** Trail ramp curvature for this layer — see glyphAlpha. */
  readonly falloff: number;
}

/**
 * One falling column, rendered as a single native text view. Memoized on
 * referentially-stable props so the swap ticker's setState only re-renders the
 * columns whose glyph rows actually changed.
 */
const RainColumn = memo(function RainColumn({ col, time, fieldHeight, glyphs, leading, size, alphaMax, falloff }: RainColumnProps) {
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: columnHeadY(col, time.value, fieldHeight, leading) }],
  }));

  const n = glyphs.length;

  // The per-slot colors depend only on the trail geometry, never on WHICH
  // character sits in a slot — so they survive every glyph swap and are worth
  // memoizing away from the ~110 column-renders/sec the swap ticker drives.
  const slotColor = useMemo(
    () =>
      Array.from({ length: n }, (_, i) => {
        const [r, g, b] = TIER_RGB[glyphTier(i)];
        return `rgba(${r},${g},${b},${glyphAlpha(i, n, alphaMax, falloff).toFixed(3)})`;
      }),
    [n, alphaMax, falloff],
  );

  // Comfortably wider than any single glyph's advance (full-width katakana is
  // ~1em, Latin mono ~0.6em) so a run can never wrap. A wrap would put two
  // glyphs on one line and break the pitch for the whole column.
  const blockWidth = size * 2;

  return (
    <Animated.View style={[styles.column, { left: col.x }, animStyle]} pointerEvents="none">
      <Text
        allowFontScaling={false}
        style={[
          styles.stack,
          {
            top: -(n - 1) * leading,
            left: -blockWidth / 2,
            width: blockWidth,
            fontSize: size,
            lineHeight: leading,
          },
        ]}
      >
        {glyphs.map((_, j) => {
          // Emitted tail-first: line j carries trail index n-1-j, so the head
          // (index 0) is the LAST line and lands at the column origin.
          const i = n - 1 - j;
          const g = glyphs[i];
          return (
            <Text
              // Index key is correct here: the array is a fixed-length ring of
              // slots, and a swap replaces the glyph AT a slot. Keying by value
              // would remount on every swap.
              key={i}
              style={{ color: slotColor[i], fontFamily: glyphFamily(g) }}
            >
              {g}
              {j < n - 1 ? '\n' : ''}
            </Text>
          );
        })}
      </Text>
    </Animated.View>
  );
});

export interface MatrixRainProps {
  /**
   * Seed for the column field. Same seed + same size = same field. Defaults to
   * a constant so the rain looks identical across the surfaces that share a
   * session.
   */
  readonly seed?: number;
}

/**
 * The rain field. Decorative: hidden from the accessibility tree entirely —
 * NexusSplash owns the busy semantics for the whole surface.
 */
function MatrixRainImpl({ seed = 0x9e37 }: MatrixRainProps) {
  const { width, height } = useWindowDimensions();
  const { reduceMotion, resolved } = useReduceMotion();

  // Init at the frozen frame so a reduce-motion user — and the brief window
  // before the async OS read resolves — never sees a first frame of motion.
  const time = useSharedValue(FROZEN_TIME_MS);

  useEffect(() => {
    // Freeze holds `time` at its CURRENT value rather than resetting, so
    // toggling Reduce Motion on mid-fall holds the exact frame the user was
    // looking at instead of lurching. The cold-start frozen frame comes from the
    // useSharedValue init above and is never written here.
    if (!tickerActive(reduceMotion, resolved)) return;
    // Resume from the current phase, not 0, or toggling Reduce Motion off
    // yanks every column back to the top.
    const start = Date.now() - time.value;
    const id = setInterval(() => {
      time.value = Date.now() - start;
    }, RAIN.tickMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- time is a stable SharedValue
  }, [reduceMotion, resolved]);

  const columns = useMemo<ColumnConfig[]>(
    () =>
      buildColumns({
        fieldWidth: width,
        fieldHeight: height,
        columns: RAIN.columns,
        columnFill: RAIN.columnFill,
        trailGlyphs: RAIN.trailGlyphs,
        speedMinPtPerS: RAIN.speedMinPtPerS,
        speedMaxPtPerS: RAIN.speedMaxPtPerS,
        glyphLeadingPt: RAIN.glyphLeadingPt,
        seed: seed + Math.floor(width * 31 + height),
      }),
    [width, height, seed],
  );

  // NEX-304: the dim far field. Distinct seed so it never mirrors the near
  // field; slower speeds read as distance. Rendered behind the near field
  // under ONE wrapper View at farLayerOpacity — the reference image's density
  // is mostly defocused background, and dim glyphs are nearly free against
  // the §19 budget (measured +0.69% lit gold for +401 glyphs).
  const farColumns = useMemo<ColumnConfig[]>(
    () =>
      buildColumns({
        fieldWidth: width,
        fieldHeight: height,
        columns: RAIN.farColumns,
        columnFill: RAIN.farColumnFill,
        trailGlyphs: RAIN.farTrailGlyphs,
        speedMinPtPerS: RAIN.farSpeedMinPtPerS,
        speedMaxPtPerS: RAIN.farSpeedMaxPtPerS,
        glyphLeadingPt: RAIN.farGlyphLeadingPt,
        seed: (seed ^ 0x77c3) + Math.floor(width * 31 + height),
      }),
    [width, height, seed],
  );

  // Far glyphs used to be a static useMemo — defensible when the layer sat at
  // 12% opacity and nothing in it was legible. At 30% it is the plane that
  // fills the screen, and a wall of characters that never changes reads as a
  // printed backdrop being slid past the camera. It mutates now, sharing the
  // near field's ticker.
  const [farGlyphs, setFarGlyphs] = useState<readonly (readonly string[])[]>(() =>
    seedGlyphs(farColumns, seed ^ 0x77c3),
  );

  // A dedicated seeded stream for runtime glyph mutation, so the swap never
  // perturbs the field's own stream and the component holds no Math.random.
  // Lazy-init: useRef ignores its argument after mount, so `useRef(mulberry32(x))`
  // would build and throw away a PRNG closure on every render.
  const swapRandRef = useRef<(() => number) | null>(null);
  if (swapRandRef.current === null) swapRandRef.current = mulberry32(seed ^ 0x5bf0);
  const swapRand = swapRandRef.current;

  const [glyphs, setGlyphs] = useState<readonly (readonly string[])[]>(() => seedGlyphs(columns, seed));

  // Re-seed DURING RENDER when the field is rebuilt (rotation / size change),
  // rather than in an effect. `columns` is a useMemo (recomputed during render)
  // while state written from an effect lands after commit — so an effect would
  // render one frame pairing the NEW column with the OLD glyph row, and
  // glyphAlpha would ramp over the old trail length while columnHeadY wrapped on
  // the new one. Adjusting state during render makes React re-render with both
  // in sync before committing anything. (React's documented pattern for
  // "derived state that can't just be computed".)
  const [prevColumns, setPrevColumns] = useState(columns);
  if (prevColumns !== columns) {
    setPrevColumns(columns);
    setGlyphs(seedGlyphs(columns, seed));
  }

  // Same re-seed-during-render contract for the far field, for the same reason
  // — now that its glyphs are state rather than a useMemo, an effect would
  // render one frame pairing new far columns with the old glyph rows.
  const [prevFarColumns, setPrevFarColumns] = useState(farColumns);
  if (prevFarColumns !== farColumns) {
    setPrevFarColumns(farColumns);
    setFarGlyphs(seedGlyphs(farColumns, seed ^ 0x77c3));
  }

  // How the tick's swap budget splits between the layers. Weighting by glyph
  // count keeps both planes churning at the same per-glyph rate; a flat 50/50
  // would make the smaller near field visibly busier than the wall behind it.
  const farSwapShare = useMemo(() => {
    const nearCount = columns.length * RAIN.trailGlyphs;
    const farCount = farColumns.length * RAIN.farTrailGlyphs;
    const total = nearCount + farCount;
    return total > 0 ? farCount / total : 0;
  }, [columns.length, farColumns.length]);

  useEffect(() => {
    if (!tickerActive(reduceMotion, resolved)) return;
    // Flicker individual glyphs in place — the defining texture of the effect —
    // rather than re-rolling whole columns, which would churn and would also
    // defeat RainColumn's memo. Rate lives in tokens; see the note there on why
    // this is priced in column-renders/sec.
    const id = setInterval(() => {
      // Draw ALL the randoms OUTSIDE the updaters, then apply. React may invoke
      // an updater more than once (StrictMode double-render), which would
      // advance the PRNG a non-deterministic number of times and break the
      // seeded-determinism rule matrix-rain-motion.ts sets out.
      const nearSwaps: GlyphSwap[] = [];
      const farSwaps: GlyphSwap[] = [];
      for (let k = 0; k < RAIN.swapsPerTick; k++) {
        const toFar = swapRand() < farSwapShare;
        const swap: GlyphSwap = {
          colPick: swapRand(),
          slotPick: swapRand(),
          glyph: pickGlyphs(swapRand, 1)[0],
        };
        (toFar ? farSwaps : nearSwaps).push(swap);
      }
      // applyGlyphSwaps returns the same reference when nothing changed, so an
      // all-no-op tick bails out of the re-render entirely.
      if (nearSwaps.length > 0) setGlyphs((prev) => applyGlyphSwaps(prev, nearSwaps));
      if (farSwaps.length > 0) setFarGlyphs((prev) => applyGlyphSwaps(prev, farSwaps));
    }, RAIN.swapIntervalMs);
    return () => clearInterval(id);
  }, [reduceMotion, resolved, swapRand, farSwapShare]);

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      // Decorative. NexusSplash is the single a11y element for the surface.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[StyleSheet.absoluteFill, styles.farLayer]} pointerEvents="none">
        {farColumns.map((col, i) =>
          col.active && farGlyphs[i] ? (
            <RainColumn
              key={col.index}
              col={col}
              time={time}
              fieldHeight={height}
              glyphs={farGlyphs[i]}
              leading={RAIN.farGlyphLeadingPt}
              size={RAIN.farGlyphSizePt}
              alphaMax={RAIN.farAlphaMax}
              falloff={RAIN.farTrailFalloff}
            />
          ) : null,
        )}
      </View>
      {columns.map((col, i) =>
        col.active && glyphs[i] ? (
          <RainColumn
            key={col.index}
            col={col}
            time={time}
            fieldHeight={height}
            glyphs={glyphs[i]}
            leading={RAIN.glyphLeadingPt}
            size={RAIN.glyphSizePt}
            alphaMax={RAIN.trailAlphaMax}
            falloff={RAIN.trailFalloff}
          />
        ) : null,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    position: 'absolute',
    top: 0,
  },
  stack: {
    position: 'absolute',
    // Every glyph in the column lives in this ONE text node, one per line.
    // fontSize / lineHeight / top / left / width are per-layer and per-column,
    // so they're set inline in RainColumn. textAlign centers each line inside
    // the block, which centers mixed-width glyphs on the column's x properly —
    // katakana is full-width and Latin is not, so the old per-glyph
    // `marginLeft: -size/2` could only ever be a compromise between the two.
    textAlign: 'center',
  },
  farLayer: {
    opacity: RAIN.farLayerOpacity,
  },
});

/** Also memoized at the boundary: parents re-render during long waits. */
export const MatrixRain = memo(MatrixRainImpl);
export default MatrixRain;
