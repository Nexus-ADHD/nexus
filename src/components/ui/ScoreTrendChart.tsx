/**
 * ScoreTrendChart — the alignment score as a ticker.
 *
 * A price-chart reading of the daily alignment score: a big current numeral, a
 * delta against the start of the selected window, an interactive line, and
 * 1W / 1M / 6M / 1Y / ALL range pills. Dragging a finger across the line scrubs
 * it — the header swaps to that day and a crosshair follows the touch.
 *
 * Why this shape. The 7 bars it replaces could only ever answer "how was this
 * week"; a line over a real time axis answers "which way is this going", which
 * is the question a trend is for. Scrubbing is what makes a long window
 * readable without adding a second screen.
 *
 * Rules this component is bound by:
 *  - Law C, non-negotiable: a DOWN trend is `textMuted`. There is no red here,
 *    and the down word is never a verdict. All color routing goes through
 *    `trendColor` in the helpers so it can be tested, not eyeballed.
 *  - A PAUSED day breaks the line rather than dipping it. A planned break is
 *    not a low day.
 *  - Colors come from `tokens` only; haptics go through the central `haptic()`
 *    helper and fire only when the scrubbed DAY changes, never per frame.
 *  - Quiet Mode (`calm`) retreats the accents to the muted register — the
 *    numerals stay full contrast. (On main-line builds without tokens.calm
 *    this falls back to textMuted; the branch wires the real calm palette.)
 *
 * All windowing / scaling / path math lives in `score-trend-chart-helpers.ts`
 * (pure, vitest-covered). This file owns pixels, gestures and copy.
 *
 * The component is also the Horizon review's habit ticker. Everything that made
 * that possible is an OPTIONAL prop defaulting to the behavior above — see
 * `ScoreTrendChartProps`. Home and /this-week pass none of them and are byte-for-
 * byte what they were.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
} from 'react-native-svg';
import tokens from '@/src/theme/tokens';
import { haptic } from '@/src/utils/haptics';
import type { PauseModeState } from '@/src/state/pause-mode';
import {
  DEFAULT_RANGE_KEYS,
  RANGE_A11Y_LABEL,
  buildLineSegments,
  formatDayKeyLabel,
  formatPointLabel,
  pointA11yLabel,
  scoredValues,
  scrubIndex,
  trendColor,
  trendDelta,
  windowScores,
  yDomain,
  type ScoreRangeKey,
} from './score-trend-chart-helpers';

// ─── Constants ────────────────────────────────────────────────────────────────

const PLOT_HEIGHT = 132;
/** Vertical breathing room so a 100 or a 0 doesn't sit flush on the edge. */
const PLOT_PAD = 8;
const LINE_WIDTH = 2;
const DOT_RADIUS = 3.5;
const SCRUB_DOT_RADIUS = 5;
/** Pan activates past this horizontal travel; vertical travel fails it first. */
const PAN_ACTIVATE_X = 10;
const PAN_FAIL_Y = 10;
const FADE = {
  duration: tokens.motion.standard.duration,
  easing: Easing.bezier(0.2, 0, 0, 1),
};

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Everything below `testID` is OPTIONAL and defaults to the shipped behavior, so
 * Home's card and /this-week render exactly what they rendered before: five
 * pills, no 3M, auto-scaled y-axis, "Alignment score trend". The Horizon review
 * is the only caller that passes any of them.
 */
export type ScoreTrendChartProps = {
  scoreHistory: Record<string, number> | null | undefined;
  pauseMode: PauseModeState | null | undefined;
  /** Today's local YYYY-MM-DD key — the default right edge of every window. */
  todayKey: string;
  initialRange?: ScoreRangeKey;
  height?: number;
  /** Quiet Mode (capacity 'RECOVERY') — accents retreat, numerals do not. */
  calm?: boolean;
  testID?: string;
  /**
   * Right edge of the window, when it isn't today. The Horizon review reviews a
   * COMPLETED period and supports back-fills; a line running to today under a
   * "March 2026" header would describe a different span than the cards beside it.
   */
  endKey?: string;
  /** Which range pills to offer. Defaults to the shipped five (3M is opt-in). */
  ranges?: ScoreRangeKey[];
  /**
   * Pin the y-axis to 0–100 instead of auto-scaling. A completion PERCENTAGE is
   * an absolute scale: auto-zoom would draw a 78→82 wobble as a crash, and would
   * make two habits' charts un-comparable because each had its own axis. The
   * alignment score keeps auto-scale — that is what makes its trend legible.
   */
  fixedDomain?: boolean;
  /** VoiceOver name for the plot. Defaults to the alignment-score wording. */
  chartLabel?: string;
  /** What the plotted number IS, for the per-day readout. Defaults to 'score'. */
  a11yNoun?: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ScoreTrendChart({
  scoreHistory,
  pauseMode,
  todayKey,
  initialRange = '1M',
  height = PLOT_HEIGHT,
  calm = false,
  testID,
  endKey,
  ranges,
  fixedDomain = false,
  chartLabel = 'Alignment score trend',
  a11yNoun = 'score',
}: ScoreTrendChartProps) {
  // Unique per mount so two charts (Home + /this-week) can't share a fill.
  // useId's raw value contains colons, which are not safe inside an SVG
  // `url(#…)` reference — strip everything but word characters.
  const gradientId = `scoreTrendFill${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  // A pill set that somehow excludes the opening range would leave the selected
  // window unreachable, so fall back rather than render a dead row.
  const pillKeys = useMemo(() => {
    const list = Array.isArray(ranges) && ranges.length > 0 ? ranges : DEFAULT_RANGE_KEYS;
    return list.includes(initialRange) ? list : DEFAULT_RANGE_KEYS;
  }, [ranges, initialRange]);

  const [range, setRange] = useState<ScoreRangeKey>(initialRange);
  const [width, setWidth] = useState(0);
  const [scrubbed, setScrubbed] = useState<number | null>(null);

  // ── Data ────────────────────────────────────────────────────────────────────
  const points = useMemo(
    () => windowScores(scoreHistory, pauseMode, todayKey, range, endKey),
    [scoreHistory, pauseMode, todayKey, range, endKey],
  );
  const scoredCount = useMemo(() => scoredValues(points).length, [points]);
  const domain = useMemo(
    () => (fixedDomain ? { min: 0, max: 100 } : yDomain(points)),
    [points, fixedDomain],
  );
  const layout = useMemo(
    () => buildLineSegments(points, { width, height, domain, topPad: PLOT_PAD, bottomPad: PLOT_PAD }),
    [points, width, height, domain],
  );

  // Last day that actually has a score — the resting header value. Usually
  // today, but a user opening after a pause should still see their last number
  // rather than a blank.
  const lastScoredIndex = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i -= 1) {
      if (typeof points[i].score === 'number') return i;
    }
    return -1;
  }, [points]);

  // Clamp a stale scrub index when the window changes underneath it.
  const activeIndex = scrubbed != null && scrubbed < points.length ? scrubbed : lastScoredIndex;
  const isScrubbing = scrubbed != null && scrubbed < points.length;
  const activePoint = activeIndex >= 0 ? points[activeIndex] : null;
  const activeLabel = formatPointLabel(activePoint, a11yNoun);

  // Delta runs from the window's first scored day to the ACTIVE day, so
  // scrubbing answers "where was I by then", not just "where am I now".
  const delta = useMemo(
    () => trendDelta(isScrubbing ? points.slice(0, activeIndex + 1) : points),
    [points, isScrubbing, activeIndex],
  );

  const accent = trendColor(delta.delta);
  const lineColor = calm ? tokens.color.textMuted : accent;
  const baselineY = useMemo(() => {
    if (delta.first == null || !width) return null;
    const coord = layout.coords.find((c) => c !== null);
    return coord ? coord.y : null;
  }, [delta.first, width, layout.coords]);

  // ── Scrub ───────────────────────────────────────────────────────────────────
  // Haptic on DAY change only (never per frame) — tokens.hapticMap.dragReorderSwap
  // is the selection-tick used for "the value under your finger moved".
  const lastHapticIndex = useRef<number | null>(null);

  const applyScrub = useCallback(
    (x: number) => {
      if (points.length === 0 || width <= 0) return;
      const next = scrubIndex(x, width, points.length);
      if (lastHapticIndex.current !== next) {
        lastHapticIndex.current = next;
        void haptic('dragReorderSwap');
      }
      setScrubbed(next); // same value is a no-op re-render
    },
    [points.length, width],
  );

  const endScrub = useCallback(() => {
    lastHapticIndex.current = null;
    setScrubbed(null);
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // The chart lives inside a vertical ScrollView. These two make the
        // ScrollView win any ambiguous drag: the pan only claims the touch after
        // real horizontal travel, and fails outright on vertical travel.
        .activeOffsetX([-PAN_ACTIVATE_X, PAN_ACTIVATE_X])
        .failOffsetY([-PAN_FAIL_Y, PAN_FAIL_Y])
        .onStart((e) => { runOnJS(applyScrub)(e.x); })
        .onUpdate((e) => { runOnJS(applyScrub)(e.x); })
        .onFinalize(() => { runOnJS(endScrub)(); }),
    [applyScrub, endScrub],
  );

  // ── Range change ────────────────────────────────────────────────────────────
  const fade = useSharedValue(1);
  useEffect(() => {
    fade.value = 0.2;
    fade.value = withTiming(1, FADE);
  }, [range, fade]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  const selectRange = useCallback((next: ScoreRangeKey) => {
    void haptic('tabChange');
    endScrub();
    setRange(next);
  }, [endScrub]);

  const onPlotLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);

  // ── a11y: the plot is adjustable, so VoiceOver keeps per-day parity with the
  //    bars it replaces (one swipe = one day). §17.6 / Codex #8.
  const shiftScrub = useCallback(
    (step: number) => {
      if (points.length === 0) return;
      const base = activeIndex >= 0 ? activeIndex : points.length - 1;
      const next = Math.max(0, Math.min(points.length - 1, base + step));
      setScrubbed(next);
    },
    [points.length, activeIndex],
  );

  const onAccessibilityAction = useCallback(
    (e: { nativeEvent: { actionName: string } }) => {
      if (e.nativeEvent.actionName === 'increment') shiftScrub(1);
      else if (e.nativeEvent.actionName === 'decrement') shiftScrub(-1);
    },
    [shiftScrub],
  );

  // ── Header copy ─────────────────────────────────────────────────────────────
  const caption = activePoint
    ? (activePoint.dateKey === todayKey && !isScrubbing
        ? 'Today'
        : formatDayKeyLabel(activePoint.dateKey, todayKey))
    : 'No days scored yet';

  const deltaText = delta.delta == null
    ? null
    : `${delta.delta > 0 ? '+' : delta.delta < 0 ? '-' : ''}${Math.abs(delta.delta)} pts` +
      (delta.pct != null && delta.pct !== 0 ? ` (${delta.pct > 0 ? '+' : ''}${delta.pct}%)` : '');

  // Until onLayout lands we know neither the width nor whether there's a plot —
  // render an empty box rather than flashing the sparse copy for one frame.
  const measured = width > 0;
  const hasPlot = measured && scoredCount >= 2;
  const scrubX = isScrubbing && layout.coords.length > 0
    ? (points.length > 1 ? (activeIndex / (points.length - 1)) * width : width / 2)
    : null;
  const scrubCoord = isScrubbing ? layout.coords[activeIndex] ?? null : null;

  return (
    // Codex #1: the app mounts no GestureHandlerRootView above this component,
    // so the chart carries its own. Without it the pan never receives touches.
    <GestureHandlerRootView style={styles.root} testID={testID}>
      {/* ── Header: the number, the day it belongs to, the delta ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text
            style={[
              styles.value,
              activeLabel.kind === 'score' ? null : styles.valueWord,
            ]}
            maxFontSizeMultiplier={1.5}
            numberOfLines={1}
          >
            {activeLabel.value}
          </Text>
          <Text style={[styles.caption, calm ? { color: tokens.color.textMuted } : null]} numberOfLines={1}>
            {caption}
          </Text>
        </View>

        <View style={styles.headerRight}>
          {deltaText && (
            <Text style={[styles.delta, { color: lineColor }]} numberOfLines={1}>
              {deltaText}
            </Text>
          )}
          <Text style={styles.rangeCaption} numberOfLines={1}>
            {RANGE_A11Y_LABEL[range]}
          </Text>
        </View>
      </View>

      {/* ── Plot ── */}
      <View style={[styles.plot, { height }]} onLayout={onPlotLayout}>
        {hasPlot ? (
          <GestureDetector gesture={pan}>
            <Animated.View
              style={[StyleSheet.absoluteFill, fadeStyle]}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={`${chartLabel}, ${RANGE_A11Y_LABEL[range]}`}
              accessibilityHint="Swipe up or down to move one day at a time"
              accessibilityValue={{ text: pointA11yLabel(activePoint, todayKey, a11yNoun) }}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={onAccessibilityAction}
            >
              <Svg width={width} height={height}>
                <Defs>
                  <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={lineColor} stopOpacity={0.22} />
                    <Stop offset="1" stopColor={lineColor} stopOpacity={0} />
                  </LinearGradient>
                </Defs>

                {/* Baseline at the window's opening value — the delta made
                    visible, the way a price chart marks the previous close. */}
                {baselineY != null && (
                  <Line
                    x1={0}
                    y1={baselineY}
                    x2={width}
                    y2={baselineY}
                    stroke={tokens.color.luminousEdgeSoft}
                    strokeWidth={1}
                    strokeDasharray="3 5"
                  />
                )}

                {layout.areas.map((d, i) => (
                  <Path key={`area-${i}`} d={d} fill={`url(#${gradientId})`} />
                ))}
                {layout.segments.map((d, i) => (
                  <Path
                    key={`line-${i}`}
                    d={d}
                    stroke={lineColor}
                    strokeWidth={LINE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                ))}
                {/* A scored day with gaps on both sides has no line to live on
                    — without the dot it would render as nothing at all. */}
                {layout.dots.map((c, i) => (
                  <Circle key={`dot-${i}`} cx={c.x} cy={c.y} r={DOT_RADIUS} fill={lineColor} />
                ))}

                {scrubX != null && (
                  <Line
                    x1={scrubX}
                    y1={0}
                    x2={scrubX}
                    y2={height}
                    stroke={tokens.color.luminousEdge}
                    strokeWidth={1}
                  />
                )}
                {scrubCoord && (
                  <>
                    <Circle
                      cx={scrubCoord.x}
                      cy={scrubCoord.y}
                      r={SCRUB_DOT_RADIUS + 3}
                      fill={lineColor}
                      opacity={0.22}
                    />
                    <Circle cx={scrubCoord.x} cy={scrubCoord.y} r={SCRUB_DOT_RADIUS} fill={lineColor} />
                  </>
                )}
              </Svg>

              {/* Floating day chip. The header carries the number; this says
                  WHICH day the finger is on without making the user look away. */}
              {scrubX != null && activePoint && (
                <View
                  style={[
                    styles.scrubChip,
                    { left: Math.max(0, Math.min(width - 76, scrubX - 38)) },
                  ]}
                  pointerEvents="none"
                >
                  <Text style={styles.scrubChipText} numberOfLines={1}>
                    {formatDayKeyLabel(activePoint.dateKey, todayKey)}
                  </Text>
                </View>
              )}
            </Animated.View>
          </GestureDetector>
        ) : measured ? (
          <View style={styles.sparse} accessible accessibilityLabel="History builds one day at a time">
            <Text style={styles.sparseText}>History builds one day at a time.</Text>
          </View>
        ) : null}
      </View>

      {/* ── Range pills ── */}
      <View style={styles.pills}>
        {pillKeys.map((key) => {
          const selected = key === range;
          return (
            <Pressable
              key={key}
              onPress={() => selectRange(key)}
              hitSlop={tokens.icon.hitTarget.linkSlopTight}
              accessibilityRole="button"
              accessibilityLabel={RANGE_A11Y_LABEL[key]}
              accessibilityState={{ selected }}
              style={[
                styles.pill,
                selected
                  ? { backgroundColor: calm ? tokens.color.surfaceElevated : tokens.color.goldWash, borderColor: calm ? tokens.color.goldHairline : tokens.color.gold }
                  : null,
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  selected ? { color: calm ? tokens.color.textSecondary : tokens.color.gold } : null,
                ]}
              >
                {key}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </GestureHandlerRootView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  headerLeft: {
    flex: 1,
    paddingRight: tokens.spacing.sm,
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  // Plex Mono for numerals (§5) — the ticker read.
  value: {
    ...tokens.type.numericDisplay,
    color: tokens.color.text,
  },
  // "Paused" / "No score" are words, not data — drop to the UI face and size so
  // they don't masquerade as a number.
  valueWord: {
    ...tokens.type.titleCard,
    color: tokens.color.textSecondary,
  },
  caption: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.xxs,
  },
  delta: {
    ...tokens.type.numericSm,
  },
  rangeCaption: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.xxs,
  },

  plot: {
    width: '100%',
    justifyContent: 'center',
  },

  scrubChip: {
    position: 'absolute',
    top: 0,
    width: 76,
    alignItems: 'center',
  },
  scrubChipText: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textSecondary,
  },

  sparse: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sparseText: {
    ...tokens.type.bodyMd,
    color: tokens.color.textMuted,
    textAlign: 'center',
  },

  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: tokens.spacing.sm,
  },
  pill: {
    flex: 1,
    marginHorizontal: 2,
    paddingVertical: 6,
    borderRadius: tokens.radii.full,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
  },
  pillText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
});
