import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { FlameGlyph } from '@/src/components/ui/FlameGlyph';
import tokens from '@/src/theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StreakChipProps = {
  count?: number;
  unit?: 'day' | 'week' | 'rep';
  milestone?: boolean;
  /**
   * NEX-190 cumulative mode: when provided, the chip renders this literal label
   * (e.g. "2× this wk", "1 of 3", "NEW") instead of `count`+unit. This is the
   * default-surface progress chip — non-breakable, never red. The breakable
   * day-count lives in <StreakBadge/> (Soft Mode only).
   */
  text?: string;
  /** Flame glyph. Defaults on for the legacy count mode, off for cumulative text. */
  showFlame?: boolean;
  style?: ViewStyle;
  testID?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const UNIT_SUFFIX: Record<NonNullable<StreakChipProps['unit']>, string> = {
  day:  'D',
  week: 'W',
  rep:  'X',
};

// v3 stellar: default streak chips retone from gold → white-on-translucent.
// Reasoning: gold screen budget tightens to ≤5% per screen, and a habit
// row with N streak chips would blow that budget. Streaks are a quiet
// repeated metric — they don't carry the "fresh earned ceremony" weight
// that the alignment-ring gold or the Today's Win accent does. Milestone
// state (true 7/30/66/365 day hits) still uses amber — that's the v3-
// sanctioned amber-only context.
// FIXME(nex-56): amber-alpha bg (15%) and white-alpha bg (12%) have no
// tokens — design review can add tokens.color.milestoneWash / textWash.
const MILESTONE_BG = 'rgba(245,160,74,0.15)';
const DEFAULT_BG   = 'rgba(255,255,255,0.10)';

// ─── Component ────────────────────────────────────────────────────────────────

export function StreakChip({
  count,
  unit = 'day',
  milestone = false,
  text,
  showFlame,
  style,
  testID,
}: StreakChipProps) {
  const cumulative  = typeof text === 'string';
  const accentColor = milestone ? tokens.color.amber : tokens.color.text;
  const bgColor     = milestone ? MILESTONE_BG       : DEFAULT_BG;
  const label       = cumulative ? text : `${count ?? 0}${UNIT_SUFFIX[unit]}`;
  // Flame defaults on for the legacy day/rep streak, off for cumulative progress
  // (a weekly count isn't a streak — no need for the streak ornament).
  const withFlame   = showFlame ?? !cumulative;
  const a11y        = cumulative ? label : `${count ?? 0} ${unit} streak`;

  return (
    <View
      style={[styles.chip, { backgroundColor: bgColor }, style]}
      testID={testID}
      accessibilityLabel={a11y}
    >
      {withFlame && (
        <>
          <FlameGlyph size={10} color={accentColor} />
          <View style={styles.gap} />
        </>
      )}
      <Text style={[styles.label, { color: accentColor }]}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  chip: {
    height:            24,
    // FIXME(nex-56): off-scale 10pt paddingHorizontal (between xs 8 and sm 12) — design review
    paddingHorizontal: 10,
    borderRadius:      12,
    flexDirection:     'row',
    alignItems:        'center',
  },

  gap: {
    width: 4,
  },

  label: {
    ...tokens.type.labelTrackedSm,
  },
});
