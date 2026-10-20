// NEX-35 — Honest failure UX.
//
// Shown when Pulse generation fails. Replaces the old curated-defaults
// silent fallback. We surface what went wrong in one line, and give
// the user two ways out: try the call again, or go back and edit the
// reflection. No fake content, no pretending Pulse succeeded.
//
// Three reasons map to three copy variants:
//   - network:        the API call threw — likely connectivity / 5xx.
//   - parse:          we got a response but couldn't parse it.
//   - no_reflection:  the reflection arrived without a usable "best
//                     version" answer, so we never even called Pulse.
//                     TRY AGAIN is hidden — there's nothing to retry
//                     against. Only EDIT REFLECTION is offered.
//
// Visual register shares the NEXUS wordmark + gold accent with the loading
// surfaces, over the global StarField (the root is transparent — an earlier
// version of this comment said "warm void background", which was v2 language
// and was never true of this file's actual style). The primary pill matches the
// review-screen `acceptBtn` (gold pill, black text, 2px tracking). Secondary
// action is a transparent pill with a muted border — quiet by design.
//
// NEX-303 deliberately did NOT migrate this screen to <NexusSplash/>. It shares
// the wordmark but it is not a loading surface: it is a terminal failure state
// with actions. The splash's glyph rain reads as "still working" and its
// accessibilityState.busy would tell VoiceOver the app is loading when it has
// in fact stopped and is waiting on the user. Same glyph, different meaning.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import tokens from '@/src/theme/tokens';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';

// Match the app-shell splash / preparing-interstitial wordmark.
const GOLD = tokens.color.gold;
const TEXT_MUTED = tokens.color.textMuted;
// v3 stellar: dim gray #666 → tokens.color.textMuted (cool blue-gray).
const TEXT_DIM = tokens.color.textMuted;

export type RetryReason = 'no_reflection' | 'network' | 'parse';

interface Props {
  reason: RetryReason;
  onRetry: () => void;
  onEditReflection: () => void;
}

const COPY: Record<RetryReason, { headline: string; body: string }> = {
  network: {
    headline: "We couldn't reach Pulse.",
    body: 'Try again.',
  },
  parse: {
    headline: "We couldn't read your reflection.",
    body: 'Try again.',
  },
  no_reflection: {
    headline: 'We need a bit more from you.',
    body: 'Go back and answer the prompts.',
  },
};

export default function RetryScreen({ reason, onRetry, onEditReflection }: Props) {
  const { headline, body } = COPY[reason];
  const showRetry = reason !== 'no_reflection';
  const router = useRouter();

  return (
    <View style={styles.root}>
      <View style={styles.stack}>
        <Text style={styles.wordmark}>N E X U S</Text>
        <Text style={styles.headline}>{headline}</Text>
        <Text style={styles.body}>{body}</Text>

        <View style={styles.actions}>
          {showRetry && (
            <PrimaryPill fullWidth onPress={onRetry}>TRY AGAIN</PrimaryPill>
          )}
          <Pressable
            style={[styles.editBtn, !showRetry && styles.editBtnSolo]}
            onPress={onEditReflection}
            accessibilityRole="button"
            accessibilityLabel="Edit reflection"
          >
            <Text style={styles.editBtnText}>EDIT REFLECTION</Text>
          </Pressable>
          {__DEV__ && (
            <Pressable
              style={styles.editBtn}
              onPress={() => router.push('/redesign/showcase')}
            >
              <Text style={styles.editBtnText}>DEV: GO TO SHOWCASE</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Transparent so the global StarField (app/_layout.tsx) shows through.
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.xl,
  },
  stack: {
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
  },
  wordmark: {
    color: GOLD,
    // FIXME(nex-56): off-scale fontSize 20 (wordmark display), design review
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 8,
  },
  headline: {
    color: tokens.color.text,
    // FIXME(nex-56): off-scale fontSize 20 (headline), design review
    fontSize: 20,
    fontWeight: '600',
    marginTop: 40 /* FIXME(nex-56): off-scale spacing 40 — review */,
    textAlign: 'center',
    lineHeight: 28,
  },
  body: {
    color: TEXT_MUTED,
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    marginTop: tokens.spacing.sm,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  actions: {
    width: '100%',
    marginTop: tokens.spacing.xxl,
  },
  editBtn: {
    backgroundColor: 'transparent',
    borderRadius: 30,
    borderWidth: 1,
    borderColor: TEXT_DIM,
    paddingVertical: tokens.spacing.md,
    alignItems: 'center',
    marginTop: tokens.spacing.sm,
  },
  editBtnSolo: {
    marginTop: 0,
  },
  editBtnText: {
    color: TEXT_MUTED,
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 2,
  },
});
