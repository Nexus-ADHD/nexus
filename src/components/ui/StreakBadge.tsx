import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import tokens from '@/src/theme/tokens';

/**
 * Streak indicator used by HabitRow + Horizon Review.
 *
 * Visual structure (right-aligned column):
 *
 *   ▲ 6
 *   DAYS
 *   TUE      ← optional, when `bestDay` is provided
 *
 * - chevron + numeric streak in gold mono
 * - "DAY" / "DAYS" caption beneath in tracked-caps muted
 * - optional 3rd row (day-of-week the streak last hit) in same caption style
 *
 * Caller is responsible for hiding the badge when streak <= 0; we still
 * defend with a guard so usage stays forgiving.
 */
export type StreakBadgeProps = {
  streak: number;
  /** Optional day-of-week label shown beneath "DAYS" (e.g. "TUE"). */
  bestDay?: string;
};

export function StreakBadge({ streak, bestDay }: StreakBadgeProps) {
  if (!streak || streak <= 0) return null;
  return (
    <View style={styles.col} pointerEvents="none">
      <View style={styles.row}>
        <Svg width={10} height={8} viewBox="0 0 10 8">
          <Polyline
            points="1,6 5,2 9,6"
            fill="none"
            stroke={tokens.color.gold}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
        <Text style={styles.num}>{streak}</Text>
      </View>
      <Text style={styles.label}>{streak === 1 ? 'DAY' : 'DAYS'}</Text>
      {bestDay ? <Text style={styles.label}>{bestDay.toUpperCase()}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  col: {
    alignItems: 'flex-end',
  },
  row: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  },
  num: {
    fontFamily:    tokens.font.plexMonoMedium,
    fontSize:      13,
    color:         tokens.color.gold,
    letterSpacing: 1,
  },
  label: {
    ...tokens.type.labelTrackedMicro,
    color:     tokens.color.textMuted,
    marginTop: 2,
  },
});
