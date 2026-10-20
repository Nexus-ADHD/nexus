import React from 'react';
import { View, Text, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useAppState, getXPProgress } from '../state/app-state';
import tokens from '@/src/theme/tokens';
import { useBreakpoints } from '@/src/theme/layout';
import { PrimaryPill } from './ui/PrimaryPill';

const GOLD = tokens.color.gold;

interface ComebackScreenProps {
  onDismiss: () => void;
}

export function ComebackScreen({ onDismiss }: ComebackScreenProps) {
  const totalXP = useAppState((s) => s.totalXP);
  const xpProgress = getXPProgress(totalXP || 0);
  // Card width tracks the live window (was a module-scope Dimensions.get,
  // which never updates on rotation/resize) and is capped to the adaptive
  // content column on wide viewports.
  const { isWide, contentMaxWidth } = useBreakpoints();
  const windowWidth = useWindowDimensions().width;
  const cardWidth = isWide ? contentMaxWidth : windowWidth - 48;

  return (
    <View style={styles.overlay}>
      <View style={[styles.card, { width: cardWidth }]}>
        <Text style={styles.emoji}>🌅</Text>
        <Text style={styles.title}>WELCOME BACK</Text>
        <Text style={styles.subtitle}>
          Today, return.
        </Text>

        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>LVL {xpProgress.level}</Text>
            <Text style={styles.statLabel}>YOUR LEVEL</Text>
          </View>
        </View>

        <PrimaryPill fullWidth onPress={onDismiss}>BEGIN</PrimaryPill>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // FIXME(nex-56): black-alpha overlay rgba(0,0,0,0.92), no token — design review
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  card: {
    // Width is dynamic (live window width, capped to the adaptive column on
    // wide viewports) — see ComebackScreen.
    backgroundColor: tokens.color.void,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: tokens.color.surfaceElevated,
    padding: tokens.spacing.xl,
    alignItems: 'center',
  },
  // FIXME(nex-56): off-scale 48pt fontSize (decorative emoji) — design review
  emoji: {
    fontSize: 48,
    marginBottom: tokens.spacing.md,
  },
  // FIXME(nex-56): off-scale 18pt fontSize — design review (matches titleCard 18pt but weight 900 differs)
  title: {
    color: GOLD,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 4,
    marginBottom: tokens.spacing.sm,
  },
  // FIXME(nex-56): off-scale gray #999 + off-scale 14pt fontSize — design review
  subtitle: {
    color: tokens.color.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: tokens.spacing.lg,
  },
  // FIXME(nex-56): off-scale 28pt marginBottom — design review
  statsRow: {
    flexDirection: 'row',
    gap: tokens.spacing.md,
    marginBottom: 28,
  },
  statBox: {
    flex: 1,
    backgroundColor: tokens.color.surface,
    borderRadius: 14,
    padding: tokens.spacing.md,
    alignItems: 'center',
  },
  // FIXME(nex-56): off-scale 20pt fontSize — design review
  statValue: {
    color: tokens.color.text,
    fontSize: 20,
    fontWeight: '900',
    marginBottom: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale gray #666 + 9pt fontSize — design review
  statLabel: {
    color: tokens.color.textMuted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
});
