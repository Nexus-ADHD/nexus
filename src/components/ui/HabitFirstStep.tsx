/**
 * HabitFirstStep — NEX-208 (H-6)
 *
 * The optional pre-framed "first step" rendered as a quiet, tappable line BELOW a
 * habit row on Home (a sibling of HabitRow, outside its completion Pressable, so
 * the tap can never toggle the habit). Tapping it is the ephemeral "started"
 * acknowledgment: a quiet teal haptic + a brief "Started." swap, then it reverts.
 * Nothing is tracked or persisted (flat, never cumulative — H-6/M8).
 *
 * Sits on the cosmos below the card, so the text carries the §4.11 floating-text
 * shadow, matching the NEX-202 mandate echo's treatment.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { STARTED_ACK } from './habit-first-step';

// Brief hold, matching the XP-toast register (~1.2-1.5s). Static swap, no
// animation (§1.4 stillness; Reduce-Motion identical).
const STARTED_HOLD_MS = 1500;

export function HabitFirstStep({
  firstStep,
  habitTitle,
}: {
  firstStep: string;
  habitTitle?: string;
}) {
  const [started, setStarted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hold the acknowledgment, then revert. Cleared on unmount / re-render so a
  // completing tap that unmounts this line mid-flash can't setState after unmount.
  useEffect(() => {
    if (!started) return;
    timerRef.current = setTimeout(() => setStarted(false), STARTED_HOLD_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [started]);

  const onPress = useCallback(() => {
    if (started) return; // ignore re-taps while already acknowledging
    haptic('tabChange'); // quiet selection — distinct from the gold completion
    setStarted(true);
  }, [started]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={
        started
          ? 'Started'
          : `Mark started${habitTitle ? `, ${habitTitle}` : ''}: ${firstStep}`
      }
      style={styles.wrap}
    >
      <Text style={styles.marker}>{started ? '✓' : '▸'}</Text>
      <Text
        style={[styles.text, started && styles.textStarted]}
        numberOfLines={2}
        ellipsizeMode="tail"
      >
        {started ? STARTED_ACK : firstStep}
      </Text>
    </Pressable>
  );
}

// Matches the mandate echo's under-card containment (paddingHorizontal lg,
// marginTop sm) so the line reads as belonging to the card above it.
const SHADOW = {
  // FIXME(nex-56): §4.11 floating-text shadow rgba(0,0,0,0.55) — the spec's
  // canonical literal (the NEX-202 mandate echo + align.tsx use the same);
  // closest token material.shadow.floating is 0.45. Tokenize in the nex-56 pass.
  textShadowColor: 'rgba(0,0,0,0.55)',
  textShadowRadius: 4,
  textShadowOffset: { width: 0, height: 1 },
} as const;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  marker: {
    color: tokens.color.teal,
    fontSize: 13,
    fontWeight: '700',
    ...SHADOW,
  },
  text: {
    flex: 1,
    color: tokens.color.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    ...SHADOW,
  },
  textStarted: {
    color: tokens.color.teal,
  },
});
