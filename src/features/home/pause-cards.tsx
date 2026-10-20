/**
 * pause-cards.tsx
 *
 * NEX-207 B2 — the two calm Pause Mode Home surfaces.
 *
 *   PausedCard      — shown while pauseMode.active. Finch-style "you're on a
 *                     planned break", mandate continuity, one Resume action. No
 *                     day count, no backlog (Law C / §18).
 *   ResumePauseCard — shown once on the open after resuming (resumingFromPause).
 *                     Forward-only welcome-back + the one next thing (Law A).
 *                     NEVER "what piled up" (a planned break is not a lapse).
 *
 * Presentational only — detection/precedence lives in pause-mode.ts
 * (homeSurfaceMode / isPausePromptDue) and the screen. No em dashes /
 * exclamations / day counts.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import tokens from '../../theme/tokens';
import { Card } from '../../components/ui/Card';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { OneThing } from './return-lapse';

export interface PausedCardProps {
  /** The user's mandate / anchor line — continuity, not a verdict. */
  mandateText: string;
  /** True once today is on/after the optional planned return day. Static line only. */
  promptDue?: boolean;
  /** End the break and return to the full Home. */
  onResume: () => void;
}

export function PausedCard({ mandateText, promptDue, onResume }: PausedCardProps) {
  return (
    <View style={styles.wrap}>
      <Card accentBar="gold" cornerGlow style={styles.card}>
        <Text style={styles.eyebrow}>ON A PLANNED BREAK</Text>
        <Text style={styles.mandate} accessibilityRole="text">{mandateText}</Text>
        <View style={styles.body}>
          <Text style={styles.bodyText}>
            {promptDue
              ? 'Your break is held, and so is your progress. Resume whenever you are ready.'
              : 'Expectations are paused and the nudges are quiet. Your progress is held, not lost.'}
          </Text>
          <PrimaryPill onPress={onResume} style={styles.pill}>
            Resume
          </PrimaryPill>
        </View>
      </Card>
    </View>
  );
}

export interface ResumePauseCardProps {
  mandateText: string;
  /** The single highest-signal item for today, or null (mandate-only). */
  oneThing: OneThing;
  /** Acknowledge + reveal the full Home (clears resumingFromPause on focus-leave). */
  onContinue: () => void;
}

export function ResumePauseCard({ mandateText, oneThing, onContinue }: ResumePauseCardProps) {
  return (
    <View style={styles.wrap}>
      <Card accentBar="gold" cornerGlow style={styles.card}>
        <Text style={styles.eyebrow}>WELCOME BACK</Text>
        <Text style={styles.mandate} accessibilityRole="text">{mandateText}</Text>
        {oneThing && oneThing.title ? (
          <View style={styles.oneThing}>
            <Text style={styles.oneThingLabel}>ONE THING FOR TODAY</Text>
            <Text style={styles.oneThingTitle} numberOfLines={2}>{oneThing.title}</Text>
          </View>
        ) : null}
        <PrimaryPill onPress={onContinue} style={styles.pill}>
          Pick up where you are
        </PrimaryPill>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: tokens.spacing.lg, gap: tokens.spacing.md },
  card: {},
  eyebrow: { ...tokens.type.labelTrackedSm, color: tokens.color.gold, marginBottom: tokens.spacing.sm },
  mandate: { ...tokens.type.poeticMd, color: tokens.color.text },
  body: {
    marginTop: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.color.goldHairline,
  },
  bodyText: { ...tokens.type.bodyMd, color: tokens.color.textSecondary, marginBottom: tokens.spacing.md },
  oneThing: {
    marginTop: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.color.goldHairline,
    marginBottom: tokens.spacing.md,
  },
  oneThingLabel: { ...tokens.type.labelTrackedSm, color: tokens.color.textMuted, marginBottom: tokens.spacing.sm },
  oneThingTitle: { ...tokens.type.titleCard, color: tokens.color.text },
  pill: { alignSelf: 'flex-start' },
});
