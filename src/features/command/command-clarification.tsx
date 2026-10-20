/**
 * command-clarification.tsx
 *
 * NEX-197 — the medium-tier confirmation. When a capture is clear except for
 * ONE scoped field, we ask exactly one question answerable by a tap chip
 * (one exchange max — never a chat thread, never a form). Picking a chip
 * patches the action(s) and executes immediately.
 *
 * Pure presentation: all decision logic lives in confidence-tier.ts; this
 * component only renders the question + chips and reports the pick.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import tokens from '../../theme/tokens';
import { ambientGlowSoft } from '../../theme/glow';
import { stripEmoji } from '../../utils/text';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';
import { Clarification, ClarificationChip } from './confidence-tier';

export interface CommandClarificationProps {
  /** The just-parsed item's title, shown so the user knows what they're answering for. */
  title: string;
  clarification: Clarification;
  onPickChip: (chip: ClarificationChip) => void;
  onDismiss: () => void;
  /** Disables chips while the pick is executing (re-entrancy guard). */
  busy?: boolean;
}

export function CommandClarification({
  title,
  clarification,
  onPickChip,
  onDismiss,
  busy = false,
}: CommandClarificationProps) {
  const entranceFrom = useEntranceFrom(8);
  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: 1, translateY: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'timing', duration: 220 }}
      style={styles.container}
    >
      <Text style={styles.eyebrow}>ONE QUICK QUESTION</Text>
      <Text style={styles.title} numberOfLines={2}>
        {stripEmoji(title)}
      </Text>
      <Text style={styles.prompt}>{clarification.prompt}</Text>

      <View style={styles.chipRow}>
        {clarification.chips.map((chip) => (
          <Pressable
            key={chip.label}
            onPress={() => !busy && onPickChip(chip)}
            disabled={busy}
            style={[styles.chip, busy && styles.chipDisabled]}
            accessibilityRole="button"
            accessibilityLabel={`${clarification.prompt} ${chip.label}`}
          >
            <Text style={styles.chipText}>{chip.label}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable onPress={onDismiss} hitSlop={8} style={styles.dismiss} disabled={busy}>
        <Text style={styles.dismissText}>NOT NOW</Text>
      </Pressable>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: 24,
    padding: tokens.spacing.lg,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    marginBottom: tokens.spacing.xs,
    ...ambientGlowSoft,
  },
  eyebrow: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.teal,
    textAlign: 'center',
    marginBottom: tokens.spacing.xs,
  },
  title: {
    ...tokens.type.titleCard,
    color: tokens.color.text,
    textAlign: 'center',
    marginBottom: tokens.spacing.sm,
  },
  prompt: {
    ...tokens.type.poeticSm,
    color: tokens.color.textSecondary,
    textAlign: 'center',
    marginBottom: tokens.spacing.md,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
  },
  chip: {
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.tealWash,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    ...tokens.type.buttonTracked,
    color: tokens.color.teal,
  },
  dismiss: {
    alignSelf: 'center',
    marginTop: tokens.spacing.md,
  },
  dismissText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
});
