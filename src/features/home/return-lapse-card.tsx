/**
 * return-lapse-card.tsx
 *
 * NEX-191 (ADHD pivot P2-b) — the shame-free return surface. On first open after
 * a >=3-day lapse, Home collapses to this single calm card:
 *   - leads with the user's mandate as CONTINUITY ("you're still this person"),
 *   - offers ONE highest-signal thing for today (skippable in one tap),
 *   - hides the backlog behind an opt-in "Show what piled up."
 *
 * §1.5 Law C / §18: no day count, no "missed", no "where have you been?", no
 * streak ceremony, no exclamation/em-dash. Forward-looking, identity as steady
 * fact. Presentational only — all detection/selection lives in return-lapse.ts
 * and the screen.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import tokens from '../../theme/tokens';
import { Card } from '../../components/ui/Card';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { SecondaryButton } from '../../components/ui/SecondaryButton';
import { OneThing } from './return-lapse';

export interface ReturnLapseCardProps {
  /** The user's mandate / anchor line — the continuity lead. */
  mandateText: string;
  /** The single highest-signal item for today, or null (mandate-only). */
  oneThing: OneThing;
  /** Act on the one thing — reveals the full Home (where the item lives). */
  onActOneThing: () => void;
  /** Opt in to seeing the full Home / backlog. */
  onShowPiledUp: () => void;
}

// One calm, honest verb. Acting reveals the full Home (where the item lives near
// the top) — it does not deep-link to the specific item, so the copy must not
// promise that. A scroll-to/deep-link is a future refinement.
const ACT_LABEL = "Let's go";

export function ReturnLapseCard({
  mandateText,
  oneThing,
  onActOneThing,
  onShowPiledUp,
}: ReturnLapseCardProps) {
  // "Not today" genuinely sets THIS one thing aside — the card stays in the calm
  // return surface (mandate + "Show what piled up") rather than revealing the
  // backlog with the item still front-and-center. Distinct from act/show, which exit.
  const [skipped, setSkipped] = useState(false);
  const showOneThing = !!oneThing && !skipped;
  return (
    <View style={styles.wrap}>
      <Card accentBar="gold" cornerGlow style={styles.card}>
        {/* Continuity lead — the mandate as identity, not a verdict. */}
        <Text style={styles.eyebrow}>STILL YOURS</Text>
        <Text style={styles.mandate} accessibilityRole="text">
          {mandateText}
        </Text>

        {showOneThing && (
          <View style={styles.oneThing}>
            <Text style={styles.oneThingLabel}>ONE THING FOR TODAY</Text>
            <Text style={styles.oneThingTitle} numberOfLines={2}>
              {oneThing!.title}
            </Text>
            <PrimaryPill variant="cream" onPress={onActOneThing} style={styles.actPill}>
              {ACT_LABEL}
            </PrimaryPill>
            <Pressable
              onPress={() => setSkipped(true)}
              hitSlop={12}
              style={styles.skip}
              accessibilityRole="button"
              accessibilityLabel="Not today"
            >
              <Text style={styles.skipText}>Not today</Text>
            </Pressable>
          </View>
        )}
      </Card>

      <SecondaryButton variant="outline" compact onPress={onShowPiledUp} style={styles.pileBtn}>
        Show what piled up
      </SecondaryButton>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: tokens.spacing.lg,
    gap: tokens.spacing.md,
  },
  card: {
    // Card supplies frosted surface + ambient gold halo + gold accent bar.
  },
  eyebrow: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.gold,
    marginBottom: tokens.spacing.sm,
  },
  mandate: {
    ...tokens.type.poeticMd,
    color: tokens.color.text,
  },
  oneThing: {
    marginTop: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.color.goldHairline,
  },
  oneThingLabel: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
    marginBottom: tokens.spacing.sm,
  },
  oneThingTitle: {
    ...tokens.type.titleCard,
    color: tokens.color.text,
    marginBottom: tokens.spacing.md,
  },
  actPill: {
    alignSelf: 'flex-start',
  },
  skip: {
    marginTop: tokens.spacing.md,
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  skipText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
  pileBtn: {
    alignSelf: 'center',
  },
});
