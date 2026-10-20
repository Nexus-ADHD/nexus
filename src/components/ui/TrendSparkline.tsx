/**
 * TrendSparkline — a habit's trend at the size of a word.
 *
 * The tiny line that sits at the right edge of each habit row in the Horizon
 * review: same series, same helpers and same color law as the full
 * `ScoreTrendChart`, with everything that needs a finger removed. No scrub, no
 * pills, no header, no gesture handler — a row that scrolls must not fight the
 * ScrollView for the touch, and the number the row already shows is the readout.
 *
 * Three deliberate choices:
 *  - **The y-axis is pinned to 0–100, always.** A sparkline has no axis labels,
 *    so an auto-scaled one is a shape with no scale — and thirty of them stacked
 *    down a card would each be drawn against a different invisible ruler. Pinned,
 *    the heights are comparable across rows at a glance, which is the only thing
 *    a chart this small can honestly deliver.
 *  - **Law C, inherited whole:** the stroke routes through `trendColor`, so a
 *    downward line is `textMuted` and never red. A flat line is gold — the same
 *    shipped rule the big chart follows; a 24pt hairline is not a gold surface.
 *  - **Invisible to VoiceOver.** The row's own accessibility label already speaks
 *    the reps and the rate; a second unlabeled element there would be noise, and
 *    a labeled one would be the same sentence twice.
 *
 * Renders nothing at all when the window holds fewer than two scored days — a
 * one-point "trend" is a dot pretending to be a direction.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { PauseModeState } from '@/src/state/pause-mode';
import {
  buildLineSegments,
  scoredValues,
  trendColor,
  trendDelta,
  windowScores,
  type ScoreRangeKey,
} from './score-trend-chart-helpers';

const SPARK_WIDTH = 64;
const SPARK_HEIGHT = 24;
const SPARK_PAD = 3;
const SPARK_LINE_WIDTH = 1.5;
const SPARK_DOT_RADIUS = 2;

/** Completion rate is an absolute 0–100 scale — see the note above. */
const PINNED_DOMAIN = { min: 0, max: 100 };

export type TrendSparklineProps = {
  /** `Record<dateKey, 0-100>` — a habit series, or any score-shaped history. */
  series: Record<string, number> | null | undefined;
  pauseMode: PauseModeState | null | undefined;
  /** Right edge of the window: the reviewed period's end, not necessarily today. */
  endKey: string;
  range: ScoreRangeKey;
  width?: number;
  height?: number;
};

export function TrendSparkline({
  series,
  pauseMode,
  endKey,
  range,
  width = SPARK_WIDTH,
  height = SPARK_HEIGHT,
}: TrendSparklineProps) {
  const points = useMemo(
    () => windowScores(series, pauseMode, endKey, range, endKey),
    [series, pauseMode, endKey, range],
  );
  const scoredCount = useMemo(() => scoredValues(points).length, [points]);
  const delta = useMemo(() => trendDelta(points), [points]);
  const layout = useMemo(
    () => buildLineSegments(points, {
      width,
      height,
      domain: PINNED_DOMAIN,
      topPad: SPARK_PAD,
      bottomPad: SPARK_PAD,
    }),
    [points, width, height],
  );

  if (scoredCount < 2) return null;

  const stroke = trendColor(delta.delta);

  return (
    <View
      style={{ width, height }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <Svg width={width} height={height}>
        {layout.segments.map((d, i) => (
          <Path
            key={`spark-line-${i}`}
            d={d}
            stroke={stroke}
            strokeWidth={SPARK_LINE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ))}
        {/* An isolated day between two gaps has no line to live on. Same reason
            the full chart draws dots: without it the day renders as nothing. */}
        {layout.dots.map((c, i) => (
          <Circle key={`spark-dot-${i}`} cx={c.x} cy={c.y} r={SPARK_DOT_RADIUS} fill={stroke} />
        ))}
      </Svg>
    </View>
  );
}
