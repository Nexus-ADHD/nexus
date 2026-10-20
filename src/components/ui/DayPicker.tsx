/**
 * DayPicker — kit day-of-week selector (docs/plans/form-controls.md).
 *
 * Seven circles, Sunday first, matching every `daysOfWeek` array in the app.
 * One component covers both selection modes: the geometry, hit targets and
 * accessibility are identical, only the toggle rule differs.
 *
 * Usage:
 *   <DayPicker mode="multi" value={days} onChange={setDays} label="Active days" />
 *   <DayPicker mode="single" value={weeklyDay} onChange={setWeeklyDay} label="Send on" />
 */

import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { WEEKDAY_LABELS, WEEKDAY_NAMES } from '@/src/utils/recurrence';
import {
  DAY_CIRCLE_SIZE,
  DAY_HIT_SLOP,
  dayRole,
  groupRole,
  isDaySelected,
  toggleDay,
  toSelectionArray,
} from './day-picker-metrics';

type Common = {
  /** Names the GROUP for assistive tech ("Active days"). */
  label: string;
  disabled?: boolean;
  testID?: string;
};

/**
 * Discriminated on `mode` so single-select hands back a NUMBER. A shared
 * `number[]` API would let a single-select caller persist two days by
 * accident — and the largest consumer file is @ts-nocheck, so the compiler
 * would not catch it.
 */
export type DayPickerProps = Common &
  (
    | { mode: 'single'; value: number; onChange: (day: number) => void }
    | { mode: 'multi'; value: number[]; onChange: (days: number[]) => void }
  );

export function DayPicker(props: DayPickerProps) {
  const { label, disabled = false, testID } = props;
  const selected = toSelectionArray(props.value);

  const press = useCallback(
    (day: number) => {
      haptic('buttonSecondary');
      const next = toggleDay({ value: selected, day, mode: props.mode });
      if (props.mode === 'single') props.onChange(next[0]);
      else props.onChange(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.mode, props.onChange, JSON.stringify(selected)],
  );

  return (
    <View
      style={[styles.row, disabled && styles.disabled]}
      // radiogroup ONLY for single-select — it promises mutual exclusivity.
      accessibilityRole={groupRole(props.mode)}
      accessibilityLabel={label}
      testID={testID}
    >
      {WEEKDAY_LABELS.map((short, i) => {
        const on = isDaySelected(selected, i);
        return (
          <Pressable
            key={short}
            onPress={() => press(i)}
            disabled={disabled}
            hitSlop={DAY_HIT_SLOP}
            style={[styles.day, on && styles.dayOn]}
            // radio in single mode, checkbox in multi — the role is a promise
            // about whether picking one un-picks the others.
            accessibilityRole={dayRole(props.mode)}
            // The REAL day name, never "Mo" — the rendered label is an
            // abbreviation for the eye, not a name for the ear.
            accessibilityLabel={WEEKDAY_NAMES[i]}
            accessibilityState={{ checked: on, disabled }}
          >
            <Text
              style={[styles.letter, on && styles.letterOn]}
              maxFontSizeMultiplier={1.2}
            >
              {short}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    justifyContent: 'space-between',
  },

  disabled: { opacity: 0.4 },

  day: {
    width:           DAY_CIRCLE_SIZE,
    height:          DAY_CIRCLE_SIZE,
    borderRadius:    DAY_CIRCLE_SIZE / 2,
    borderWidth:     1,
    borderColor:     tokens.color.goldHairline,
    alignItems:      'center',
    justifyContent:  'center',
    backgroundColor: 'transparent',
  },

  // Teal, not gold. Selected days were solid GOLD in two of the three places
  // this replaces — and habit editing defaults to all seven, so a routine
  // control was painting the screen in the one colour §19 reserves as a seal.
  // Teal is the system's active signal and costs nothing from that budget.
  dayOn: {
    backgroundColor: tokens.color.teal,
    borderColor:     tokens.color.teal,
  },

  letter: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
  },

  letterOn: {
    color: tokens.color.textInverse,
  },
});
