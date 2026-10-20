import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useAppState, getXPProgress, BADGE_DEFINITIONS, Badge } from '../../state/app-state';
import { useShallow } from 'zustand/react/shallow';
import tokens from '@/src/theme/tokens';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';
import { ambientGlowSoft } from '@/src/theme/glow';
import { SacredShape, shapeForBadgeId } from '@/src/components/ui/SacredShape';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';

const BG = tokens.color.textInverse;
const GOLD = tokens.color.gold;

export function TrophiesScreen(): React.JSX.Element {
  const router = useRouter();
  const { totalXP, badges } = useAppState(
    useShallow((s) => ({ totalXP: s.totalXP, badges: s.badges })),
  );
  const xpProgress = getXPProgress(totalXP || 0);
  const unlockedCount = (badges || []).filter((b: Badge) => b.unlockedAt).length;

  return (
    <View style={styles.container}>
      <AdaptiveScreen>
      <View style={[styles.header, { zIndex: 10 }]}>
        <Pressable onPress={() => router.back()} hitSlop={20}>
          <Text style={styles.backBtn}>{'‹'}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>TROPHIES</Text>
        <View style={{ width: 30 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.levelCard}>
          <Text style={styles.levelLabel}>LEVEL {xpProgress.level}</Text>
          <View style={styles.xpBarContainer}>
            <View style={[styles.xpBarFill, { width: `${xpProgress.percent}%` }]} />
          </View>
          <Text style={styles.xpText}>{xpProgress.current} / {xpProgress.needed} XP</Text>
          <Text style={styles.totalXP}>{totalXP || 0} TOTAL XP</Text>
        </View>

        <Text style={styles.sectionTitle}>{unlockedCount} / {(badges || []).length} BADGES UNLOCKED</Text>

        <View style={styles.badgeGrid}>
          {(badges || []).map((badge: Badge) => {
            const unlocked = !!badge.unlockedAt;
            // NEX-220: render copy from BADGE_DEFINITIONS by id (persisted badges
            // keep their old copy) so reframed titles/descriptions show without a
            // migration. Fall back per field — a persisted/cloud badge may be shaped
            // {id, unlockedAt} with no title/description, so a whole-object `?? badge`
            // would render `undefined` and blank the card.
            const def = BADGE_DEFINITIONS.find((d) => d.id === badge.id);
            const title = def?.title ?? badge.title ?? badge.id;
            const description = def?.description ?? badge.description ?? 'Achievement unlocked';
            return (
              <View key={badge.id} style={[styles.badgeCard, !unlocked && styles.badgeCardLocked]}>
                <SacredShape
                  name={shapeForBadgeId(badge.id)}
                  size={48}
                  opacity={unlocked ? 1 : 0.2}
                  glow={unlocked}
                  showLockOverlay={!unlocked}
                  style={{ marginBottom: 6 }}
                />
                <Text style={[styles.badgeTitle, !unlocked && styles.badgeTitleLocked]}>{title}</Text>
                <Text style={[styles.badgeDesc, !unlocked && styles.badgeDescLocked]}>{description}</Text>
                {unlocked && badge.unlockedAt && (
                  <Text style={styles.badgeDate}>
                    {new Date(badge.unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>
      </AdaptiveScreen>
      <StatusBarScrim />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent'},
  // FIXME(nex-56): off-scale 60pt paddingTop — design review
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.md,
  },
  // FIXME(nex-56): off-scale 28pt fontSize (back chevron) — design review
  backBtn: { color: GOLD, fontSize: 28, fontWeight: '300' },
  // FIXME(nex-56): off-scale 12pt fontSize — design review
  headerTitle: { color: tokens.color.text, fontSize: 12, fontWeight: '900', letterSpacing: 3 },
  // FIXME(nex-56): off-scale 100pt paddingBottom — design review
  scroll: { paddingHorizontal: tokens.spacing.lg, paddingBottom: 100 },
  // FIXME(nex-56): off-scale 28pt marginBottom — design review
  levelCard: {
    backgroundColor: tokens.color.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    padding: tokens.spacing.lg,
    marginBottom: 28,
    alignItems: 'center',
    ...ambientGlowSoft,
  },
  // FIXME(nex-56): off-scale 28pt fontSize — design review
  levelLabel: {
    color: GOLD,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 4,
    marginBottom: tokens.spacing.md,
  },
  xpBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: tokens.color.surfaceElevated,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: tokens.spacing.xs,
  },
  xpBarFill: {
    height: '100%',
    backgroundColor: GOLD,
    borderRadius: 4,
  },
  // FIXME(nex-56): off-scale gray #888 + 11pt fontSize — design review
  xpText: {
    color: tokens.color.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  // FIXME(nex-56): off-scale gray #555 + 10pt fontSize — design review
  totalXP: {
    color: tokens.color.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginTop: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale gray #666 + 10pt fontSize — design review
  sectionTitle: {
    color: tokens.color.textMuted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 2,
    marginBottom: tokens.spacing.md,
  },
  badgeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.sm,
  },
  // FIXME(nex-56): runtime gold-alpha border (GOLD + '40' = gold @ 25% alpha) — design review (see align/review-screen for matching pattern)
  badgeCard: {
    width: '47%',
    backgroundColor: tokens.color.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GOLD + '40',
    padding: tokens.spacing.md,
    alignItems: 'center',
  },
  badgeCardLocked: {
    borderColor: tokens.color.surfaceElevated,
    opacity: 0.5,
  },
  // FIXME(nex-56): off-scale 32pt fontSize (badge emoji) — design review
  badgeIcon: {
    fontSize: 32,
    marginBottom: tokens.spacing.xs,
  },
  // FIXME(nex-56): off-scale 12pt fontSize — design review
  badgeTitle: {
    color: tokens.color.text,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale gray #555 — design review
  badgeTitleLocked: { color: tokens.color.textMuted },
  // FIXME(nex-56): off-scale gray #888 + 10pt fontSize — design review
  badgeDesc: {
    color: tokens.color.textMuted,
    fontSize: 10,
    textAlign: 'center',
    lineHeight: 14,
  },
  // FIXME(nex-56): off-scale gray #444 — design review
  badgeDescLocked: { color: tokens.color.textDisabled },
  // FIXME(nex-56): off-scale 9pt fontSize + 6pt margin — design review
  badgeDate: {
    color: GOLD,
    fontSize: 9,
    fontWeight: '700',
    marginTop: 6,
    letterSpacing: 1,
  },
});
