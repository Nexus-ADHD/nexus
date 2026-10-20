/**
 * Stepper — kit wrapping value stepper (docs/plans/form-controls.md).
 *
 * `‹ value ›` for a value that WRAPS (hour mod 24, minute mod 60). Built for
 * the in-row time control, so it deliberately does NOT take the spec's Opal
 * geometry (two 44pt circles either side of a wide value pill) — that is a
 * standalone control and is far too heavy inside a list row. Compact chevrons
 * with real 44pt hit targets satisfy the touch law at row scale.
 *
 * Accessibility: the whole control is ONE 'adjustable' element, so VoiceOver
 * users swipe up/down to change the value instead of hunting two small
 * chevrons. The chevrons are therefore hidden from the a11y tree — leaving
 * them exposed would give three elements per stepper (two buttons plus the
 * adjustable) and two competing ways to fire the same change.
 */

import React, { useCallback } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { stepValue } from './stepper-metrics';

export type StepperProps = {
  value: number;
  /** Modulus: 24 for hours, 60 for minutes. Wrap, never clamp. */
  wrap: number;
  step?: number;
  onChange: (next: number) => void;
  /** How the value renders. Defaults to the bare number. */
  format?: (value: number) => string;
  /** Names the control — required, since a control-hosting row (§10.19 shape 3) never names it. */
  accessibilityLabel: string;
  /** Spoken value. Give it the MEANINGFUL form ("7:15 AM"), not the bare number. */
  accessibilityValueText?: string;
  testID?: string;
};

// Visual chevron box. hitSlop lifts the touch target to the 44pt floor without
// changing layout — the same trick §10.2's inline links use.
const ARROW_SIZE = 28;
const ARROW_SLOP = (tokens.icon.hitTarget.minimum - ARROW_SIZE) / 2; // 8

export function Stepper({
  value,
  wrap,
  step = 1,
  onChange,
  format,
  accessibilityLabel,
  accessibilityValueText,
  testID,
}: StepperProps) {
  // One path for every way the value can change — chevron tap AND the
  // VoiceOver adjust action — so the haptic can never double- or zero-fire.
  const bump = useCallback(
    (dir: 1 | -1) => {
      haptic('buttonSecondary');
      onChange(stepValue({ value, dir, step, wrap }));
    },
    [value, step, wrap, onChange],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'increment') bump(1);
      else if (event.nativeEvent.actionName === 'decrement') bump(-1);
    },
    [bump],
  );

  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: wrap - 1,
        now: value,
        text: accessibilityValueText,
      }}
      accessibilityActions={ACCESSIBILITY_ACTIONS}
      onAccessibilityAction={handleAccessibilityAction}
      testID={testID}
    >
      {/* Chevrons are hidden from the a11y tree: the container above is the
          single adjustable element. */}
      <Pressable
        onPress={() => bump(-1)}
        hitSlop={ARROW_SLOP}
        style={styles.arrow}
        accessible={false}
        importantForAccessibility="no"
      >
        <Text style={styles.arrowGlyph} maxFontSizeMultiplier={1.3}>‹</Text>
      </Pressable>

      <Text style={styles.value} maxFontSizeMultiplier={1.3}>
        {format ? format(value) : String(value)}
      </Text>

      <Pressable
        onPress={() => bump(1)}
        hitSlop={ARROW_SLOP}
        style={styles.arrow}
        accessible={false}
        importantForAccessibility="no"
      >
        <Text style={styles.arrowGlyph} maxFontSizeMultiplier={1.3}>›</Text>
      </Pressable>
    </View>
  );
}

const ACCESSIBILITY_ACTIONS = [
  { name: 'increment' as const },
  { name: 'decrement' as const },
];

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems:    'center',
  },

  arrow: {
    width:          ARROW_SIZE,
    height:         ARROW_SIZE,
    alignItems:     'center',
    justifyContent: 'center',
  },

  arrowGlyph: {
    ...tokens.type.titleSection,
    color: tokens.color.chevron,
  },

  // Plex Mono so the digits don't shift width as they change (§5: numerals
  // are always mono) — a proportional face makes the chevrons jitter.
  value: {
    ...tokens.type.numericSm,
    color:     tokens.color.text,
    minWidth:  28,
    textAlign: 'center',
  },
});
