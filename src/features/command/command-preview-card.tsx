/**
 * command-preview-card.tsx
 *
 * NEX-318 (Phase 2) — the Fantastical-style live preview. As the user types, the
 * command screen shows this card: "here's what I'll do" before anything commits.
 * ONE primary action ("Add", Law A location-bearing) — except an ambiguous
 * "next <weekday>" calendar write, which offers two explicit date chips so the
 * user resolves the this-coming-vs-next-week ambiguity with one tap.
 *
 * Pure presentation: all projection logic lives in command-preview.ts; this only
 * renders the preview and reports Add (with an optional chosen date) or Dismiss.
 * Cancel leaves the typed text intact (the parent does not clear the input).
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import tokens from '../../theme/tokens';
import { ambientGlowSoft } from '../../theme/glow';
import { stripEmoji } from '../../utils/text';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';
import { CommandPreview } from './command-preview';

export interface CommandPreviewCardProps {
  preview: CommandPreview;
  /** Add the action; a dateStr is passed only from an ambiguous-date chip. */
  onAdd: (dateStr?: string) => void;
  /** Dismiss the preview; the typed text is left intact. */
  onDismiss: () => void;
  /** Disables actions while a commit is in flight (re-entrancy guard). */
  busy?: boolean;
}

export function CommandPreviewCard({ preview, onAdd, onDismiss, busy = false }: CommandPreviewCardProps) {
  const { action, typeLabel, destinationLabel, timingLabel, dateCandidates } = preview;
  // Law A: a location-bearing line so the user sees WHERE it lands before commit.
  const locationLine = timingLabel ? `${destinationLabel} · ${timingLabel}` : destinationLabel;
  const entranceFrom = useEntranceFrom(8);

  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: 1, translateY: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'timing', duration: 220 }}
      style={styles.container}
      accessibilityLabel={`Preview. ${typeLabel}. ${stripEmoji(action.title)}. ${locationLine}`}
    >
      <Text style={styles.eyebrow}>{typeLabel.toUpperCase()}</Text>
      <Text style={styles.title} numberOfLines={2}>
        {stripEmoji(action.title)}
      </Text>
      <Text style={styles.location}>{locationLine}</Text>

      {dateCandidates ? (
        <>
          <Text style={styles.prompt}>Which day?</Text>
          <View style={styles.chipRow}>
            {dateCandidates.map((chip) => (
              <Pressable
                key={chip.dateStr}
                onPress={() => !busy && onAdd(chip.dateStr)}
                disabled={busy}
                style={[styles.chip, busy && styles.disabled]}
                accessibilityRole="button"
                accessibilityLabel={`Add on ${chip.label}`}
              >
                <Text style={styles.chipText}>{chip.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <Pressable
          onPress={() => !busy && onAdd()}
          disabled={busy}
          style={[styles.primary, busy && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel={`Add. ${stripEmoji(action.title)}. ${locationLine}`}
        >
          <Text style={styles.primaryText}>ADD</Text>
        </Pressable>
      )}

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
    marginBottom: tokens.spacing.xs,
  },
  location: {
    ...tokens.type.poeticSm,
    color: tokens.color.textSecondary,
    textAlign: 'center',
    marginBottom: tokens.spacing.md,
  },
  prompt: {
    ...tokens.type.poeticSm,
    color: tokens.color.textSecondary,
    textAlign: 'center',
    marginBottom: tokens.spacing.sm,
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
  chipText: {
    ...tokens.type.buttonTracked,
    color: tokens.color.teal,
  },
  primary: {
    alignSelf: 'center',
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.xl,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.tealWash,
  },
  primaryText: {
    ...tokens.type.buttonTracked,
    color: tokens.color.teal,
  },
  disabled: {
    opacity: 0.5,
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
