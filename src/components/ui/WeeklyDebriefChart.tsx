// WeeklyDebriefChart (NEX-121) — a compact 7-day bar row in the Home Weekly
// Debrief visual language (v3 stellar palette, tier-colored bars). Prop-driven
// and pure-presentational.
//
// v1 ships SHAPE-ONLY (bars, no day labels / KPI values) for the locked
// "paywall as content" preview — the bar HEIGHTS convey the user's shape, the
// numbers stay premium-gated. `showValues` is reserved for a future full
// version (day labels + KPI tiles) so Home's inline chart can migrate here.
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { barColorForScore, barHeightForScore, type DayScore } from './weekly-debrief-chart-helpers';

export type WeeklyDebriefBar = { key: string; score: DayScore };

export type WeeklyDebriefChartProps = {
  /** Oldest → newest. Bar height ∝ score; null = paused/missing (stub). */
  dayScores: WeeklyDebriefBar[];
  /** Tallest bar, px. Default 44 (Home's value). */
  maxHeight?: number;
  /** v1: bars only. true (future) adds day labels + KPI tiles. */
  showValues?: boolean;
  style?: ViewStyle;
};

const DEFAULT_MAX_HEIGHT = 44;
const BAR_WIDTH = 14;
const BAR_RADIUS = 4;

export function WeeklyDebriefChart({
  dayScores,
  maxHeight = DEFAULT_MAX_HEIGHT,
  style,
}: WeeklyDebriefChartProps) {
  return (
    <View style={[styles.row, { height: maxHeight }, style]}>
      {dayScores.map((d) => (
        <View
          key={d.key}
          style={{
            width: BAR_WIDTH,
            height: barHeightForScore(d.score, maxHeight),
            borderRadius: BAR_RADIUS,
            backgroundColor: barColorForScore(d.score),
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 10,
  },
});
