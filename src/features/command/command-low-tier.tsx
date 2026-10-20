/**
 * command-low-tier.tsx
 *
 * NEX-197 — the low-tier confirmation. When the parse fails or returns nothing
 * actionable, we never guess and never scold (§18 / Law C). We show the verbatim
 * transcript so the user sees exactly what was heard, and offer a single
 * "Tap to try again" that re-arms capture.
 *
 * Law A safety net: when there IS a transcript (the parser heard the words but
 * couldn't sort them, or the AI path failed), the card also offers a one-tap
 * "SAVE TO INBOX" so the captured intention is never silently dropped. The
 * empty-transcript case (we genuinely heard nothing) keeps the original
 * "I didn't catch that" copy and has nothing to save.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import tokens from '../../theme/tokens';
import { ambientGlowSoft } from '../../theme/glow';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';

export interface CommandLowTierProps {
  /** What we heard, shown verbatim. */
  transcript: string;
  onTryAgain: () => void;
  onDismiss: () => void;
  /** Law A: save the raw transcript to Inbox. Shown only for a non-empty transcript. */
  onSaveToInbox?: () => void;
  /** Disables SAVE while an execution is in flight (double-tap guard). */
  busy?: boolean;
}

export function CommandLowTier({ transcript, onTryAgain, onDismiss, onSaveToInbox, busy }: CommandLowTierProps) {
  const trimmed = (transcript ?? '').trim();
  // A non-empty transcript means we heard words we couldn't sort — accept the
  // blame ("I couldn't sort that", never "you were unclear") and offer to keep
  // them. Empty means the mic caught nothing; the original copy stands.
  const hasWords = !!trimmed;
  const canSave = hasWords && !!onSaveToInbox;
  const entranceFrom = useEntranceFrom(8);
  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: 1, translateY: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'timing', duration: 220 }}
      style={styles.container}
    >
      <Text style={styles.eyebrow}>{hasWords ? 'I COULDN’T SORT THAT' : 'I DIDN’T CATCH THAT'}</Text>
      {hasWords && (
        <View style={styles.quoteWrap}>
          <Text style={styles.quote} numberOfLines={4}>
            “{trimmed}”
          </Text>
        </View>
      )}
      {canSave && (
        <Pressable
          onPress={onSaveToInbox}
          disabled={busy}
          style={[styles.saveToInbox, busy && styles.saveToInboxBusy]}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Save to Inbox"
          accessibilityState={{ disabled: !!busy }}
        >
          <Text style={styles.saveToInboxText}>SAVE TO INBOX</Text>
        </Pressable>
      )}
      <Pressable
        onPress={onTryAgain}
        style={canSave ? styles.tryAgainSecondary : styles.tryAgain}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Text style={canSave ? styles.tryAgainSecondaryText : styles.tryAgainText}>TAP TO TRY AGAIN</Text>
      </Pressable>
      {/* NEX-255: bottom-heavy hitSlop — DISMISS renders ~14pt; extend down to
          clear 44pt without the top slop overlapping TRY AGAIN (16pt gap above). */}
      <Pressable onPress={onDismiss} hitSlop={{ top: 6, bottom: 24, left: 12, right: 12 }} style={styles.dismiss} accessibilityRole="button" accessibilityLabel="Dismiss">
        <Text style={styles.dismissText}>DISMISS</Text>
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
    color: tokens.color.stateInfo,
    textAlign: 'center',
    marginBottom: tokens.spacing.sm,
  },
  quoteWrap: {
    marginBottom: tokens.spacing.md,
  },
  quote: {
    ...tokens.type.poeticSm,
    color: tokens.color.textSecondary,
    textAlign: 'center',
  },
  tryAgain: {
    alignSelf: 'center',
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.tealWash,
  },
  tryAgainText: {
    ...tokens.type.buttonTracked,
    color: tokens.color.teal,
  },
  // When SAVE TO INBOX is the primary, TRY AGAIN steps down to a quiet text link.
  tryAgainSecondary: {
    alignSelf: 'center',
    marginTop: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.md,
  },
  tryAgainSecondaryText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textSecondary,
  },
  saveToInbox: {
    alignSelf: 'center',
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.teal,
  },
  saveToInboxBusy: {
    opacity: 0.5,
  },
  saveToInboxText: {
    ...tokens.type.buttonTracked,
    color: tokens.color.void,
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
