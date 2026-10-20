/**
 * NEX-48 Phase 4: /this-week route. Holds the deeper retrospective surfaces
 * that used to live below the fold on Home:
 *   - SCORE TREND (7d / 30d / best, trending direction)
 *   - PROGRESS (level + XP + badges)
 *   - THIS WEEK'S LEVERAGE (Mon-Wed only, computed from the past 7 days)
 *   - HORIZON REVIEWS (with + START REVIEW action + preview cards)
 *
 * Home retains the daily-active retrospective (WEEKLY DEBRIEF + THIS WEEK'S
 * WINS) plus a "THIS WEEK ›" entry card that pushes this route.
 *
 * The Badges Detail Modal lives here (it's only triggered from the PROGRESS
 * section) and the HorizonReviewModal renders here when setDueReview fires.
 * The Score Breakdown Modal stays on Home — it's the canonical drill-down for
 * tapping the AlignmentScoreRing.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Modal,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tokens from '@/src/theme/tokens';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';
import { ambientGlow, ambientGlowSoft } from '@/src/theme/glow';
import { useAppState, getXPProgress, BADGE_DEFINITIONS, type RecurringRule } from '@/src/state/app-state';
import { isPausedOn, scoresExcludingPaused, lastNDayKeys } from '@/src/state/pause-mode';
import { computeLeveragePoints } from '@/src/utils/leverage';
import { stripEmoji } from '@/src/utils/text';
import { HorizonReviewModal } from '../home/horizon-review';
import { Card } from '@/src/components/ui/Card';
import { SectionHeader } from '@/src/components/ui/SectionHeader';
import { ScoreTrendChart } from '@/src/components/ui/ScoreTrendChart';
import { IconButton } from '@/src/components/ui/IconButton';
import { SacredShape, shapeForBadgeId } from '@/src/components/ui/SacredShape';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';
import { SymbolView } from 'expo-symbols';

// ── Color aliases (mirrors home-screen NEX-56 block). Identical FIXMEs so the
//    awk gate stays clean and Phase 5 Card sweep can lift them to a shared
//    module if needed. Spec migrations are intentional.
const BG = tokens.color.voidDeep;
// NEX-161: dead SURFACE const (never used) and now-orphaned BORDER const
// (its only consumer, modalCard, migrated to luminousEdge) removed.
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;
const GOLD = tokens.color.gold;

// v3 stellar: semantic + gray aliases retoned to v3 tokens.
// Same pattern as home-screen.tsx — aliases preserved for call-site
// readability, underlying values now resolve to the v3 cool palette.
// NEX-217: SEMANTIC_SUCCESS / SEMANTIC_ERROR removed — SEMANTIC_ERROR (red)
// was the de-shamed leverage rate bar's only consumer, and SEMANTIC_SUCCESS was
// already unused. No red verdict on the weekly-review surface anymore.
const GRAY_555 = tokens.color.textMuted;     // was #555
const GRAY_444 = tokens.color.textDisabled;  // was #444
const GRAY_333 = tokens.color.textDisabled;  // was #333
const GRAY_888 = tokens.color.textMuted;     // was #888
const GRAY_666 = tokens.color.textMuted;     // was #666
const GRAY_111 = tokens.color.voidDeep;      // was #111

function getTodayKey(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function ThisWeekScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // ── Store slices (Zustand selectors so each section re-renders only on its
  //    own data). Mirrors the patterns used on Home.
  const recurringRules = useAppState((s: any) => s.recurringRules) as RecurringRule[];
  const habitLog       = useAppState((s: any) => s.habitLog);
  const scoreHistory   = useAppState((s: any) => s.scoreHistory);
  const pauseMode      = useAppState((s: any) => s.pauseMode); // NEX-207
  const totalXP        = useAppState((s: any) => s.totalXP);
  const badges         = useAppState((s: any) => s.badges);
  const horizonReviews = useAppState((s: any) => s.horizonReviews);
  const pillars        = useAppState((s: any) => s.pillars);
  const goalHabitMap   = useAppState((s: any) => s.goalHabitMap);

  const todayKey = getTodayKey();
  const xpProgress = getXPProgress(totalXP || 0);

  // ── Local UI state ────────────────────────────────────────────────────────
  const [showBadgesModal, setShowBadgesModal] = useState(false);
  const [dueReview, setDueReview] = useState<string | null>(null);

  // ── Computed: best day + whether there's enough history to show a trend. ────
  // NEX-207: built over CALENDAR-day windows (not the last-N recorded keys), with
  // paused days excluded — so a planned break can't reach back and surface the
  // pre-pause week as "current". Null (rendered "—", never 0; Law C) when the
  // whole window is paused or empty.
  //
  // The 7d/30d averages and the direction word that used to live here are gone:
  // ScoreTrendChart below is now the single definition of "the trend" on this
  // screen (see the render note).
  const scoreTrend = useMemo(() => {
    const history = scoreHistory || {};
    const v30 = scoresExcludingPaused(history, lastNDayKeys(todayKey, 30), pauseMode);
    const bestScore = v30.length > 0 ? Math.max(...v30) : null;
    // daysTracked gates the trend block — count non-paused recorded days.
    const daysTracked = Object.keys(history).filter((k) => !isPausedOn(k, pauseMode)).length;
    return { bestScore, daysTracked };
  }, [scoreHistory, todayKey, pauseMode]);

  // ── Computed: this week's leverage (Mon-Wed only). Mirrors home-screen. ──
  const leverageThisWeek = useMemo(() => {
    const dow = new Date().getDay();
    if (dow < 1 || dow > 3) return [];
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const { leverage } = computeLeveragePoints({
      recurringRules: Array.isArray(recurringRules) ? recurringRules : [],
      habitLog: Array.isArray(habitLog) ? habitLog : [],
      pillars: Array.isArray(pillars) ? pillars : [],
      goalHabitMap: (goalHabitMap && typeof goalHabitMap === 'object') ? goalHabitMap : {},
      range: { start, end },
    });
    return leverage;
  }, [recurringRules, habitLog, pillars, goalHabitMap, todayKey]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Badges Detail Modal — moved from Home (its only trigger is the
          PROGRESS section's badge row). */}
      <Modal visible={showBadgesModal} transparent animationType="slide">
        {/* Restructured so the dismiss-tap backdrop is a sibling of the
            modal card, not a parent. With the previous Pressable-wraps-
            everything shape, taps inside the card bubbled to the
            backdrop's onPress (dismissing on grid taps) and the
            ScrollView's pan gesture lost the race for touch ownership
            (grid couldn't scroll). Now: absoluteFill Pressable behind,
            card sits on top as a sibling — its taps don't reach the
            backdrop, and the ScrollView owns its own pan inside. */}
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,2,8,0.78)' }}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowBadgesModal(false)}
          />
          <View style={[styles.modalCard, { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, maxHeight: '80%' as any }]}>
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 28, fontWeight: '900', letterSpacing: 4 }}>LEVEL {xpProgress.level}</Text>
              <View style={{ width: '100%', height: 8, backgroundColor: tokens.color.surfaceElevated, borderRadius: 4, overflow: 'hidden', marginTop: 12, marginBottom: 6 }}>
                <View style={{ height: '100%', backgroundColor: GOLD, borderRadius: 4, width: `${xpProgress.percent}%` }} />
              </View>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_888, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>{xpProgress.current} / {xpProgress.needed} XP</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_555, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 4 }}>{totalXP || 0} TOTAL XP  ·  GRACE DAY ON</Text>
            </View>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_666, fontSize: 10, fontWeight: '900', letterSpacing: 2, marginBottom: 12 }}>
              {(badges || []).filter((b: any) => b.unlockedAt).length} / {(badges || []).length} BADGES UNLOCKED
            </Text>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 16 }}
            >
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {(badges || []).map((badge: any) => {
                  const unlocked = !!badge.unlockedAt;
                  // NEX-220: render copy from defs by id (no migration needed).
                  // Fall back per field — a persisted/cloud badge may be shaped
                  // {id, unlockedAt} with no title/description, so a whole-object
                  // `?? badge` would render `undefined` and blank the card.
                  const def = BADGE_DEFINITIONS.find((d) => d.id === badge.id);
                  const title = def?.title ?? badge.title ?? badge.id;
                  const description = def?.description ?? badge.description ?? 'Achievement unlocked';
                  return (
                    <View key={badge.id} style={{
                      width: '47%', backgroundColor: tokens.color.surface, borderRadius: 16,
                      borderWidth: 1, borderColor: unlocked ? GOLD + '40' : tokens.color.luminousEdge,
                      padding: 14, alignItems: 'center', opacity: unlocked ? 1 : 0.5,
                    }}>
                      <SacredShape
                        name={shapeForBadgeId(badge.id)}
                        size={48}
                        opacity={unlocked ? 1 : 0.2}
                        glow={unlocked}
                        showLockOverlay={!unlocked}
                        style={{ marginBottom: 6 }}
                      />
                      <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: unlocked ? tokens.color.text : GRAY_555, fontSize: 11, fontWeight: '900', letterSpacing: 1, textAlign: 'center', marginBottom: 3 }}>{title}</Text>
                      <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: unlocked ? GRAY_888 : GRAY_444, fontSize: 9, textAlign: 'center', lineHeight: 13 }}>{description}</Text>
                      {unlocked && badge.unlockedAt && (
                        <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 8, fontWeight: '700', marginTop: 5, letterSpacing: 1 }}>
                          {new Date(badge.unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 9, marginTop: 12, letterSpacing: 1, textAlign: 'center' }}>TAP ANYWHERE TO CLOSE</Text>
          </View>
        </View>
      </Modal>

      {/* HorizonReviewModal — opens when setDueReview fires from the
          HORIZON REVIEWS section below. */}
      {dueReview && (
        <HorizonReviewModal
          initialCadence={dueReview as any}
          onDismiss={() => setDueReview(null)}
        />
      )}

      <AdaptiveScreen>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + tokens.spacing.md }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header — back chevron + page title. Single-line layout to keep
            the screen feeling lightweight and scrollable from the top. */}
        <View style={styles.header}>
          <IconButton
            icon={
              <SymbolView
                name="chevron.left"
                size={tokens.icon.size.md}
                tintColor={tokens.color.text}
                weight={tokens.icon.weight.default}
              />
            }
            onPress={() => router.back()}
            size="md"
            accessibilityLabel="Back to Home"
          />
          <Text style={styles.title}>This Week</Text>
          {/* Spacer mirrors the IconButton width so the title stays centered. */}
          <View style={{ width: tokens.icon.hitTarget.icon }} />
        </View>

        {/* SCORE TREND — the same ScoreTrendChart Home mounts, at depth.
            The old readout here (7-day avg / 30-day avg / best day + a
            RISING / RECALIBRATING / STEADY word) is gone on purpose: it
            defined "the trend" as last-7-vs-previous-7 while the chart defines
            it as first-vs-last of the selected window, and two definitions on
            one screen can disagree in front of the user. The chart is the
            richer of the two (every range, every day scrubbable), so it wins
            and the avg tiles retire with the word.
            BEST DAY was the one earned, gold-worthy number in that block, so it
            stays on as a quiet footer row under the chart. */}
        {scoreTrend.daysTracked >= 2 && (
          <>
            <SectionHeader>SCORE TREND</SectionHeader>
            <Card style={styles.cardSpacing}>
              <ScoreTrendChart
                scoreHistory={scoreHistory}
                pauseMode={pauseMode}
                todayKey={todayKey}
                initialRange="1M"
                height={160}
              />
              {scoreTrend.bestScore != null && (
                <View style={styles.bestDayRow}>
                  <Text style={styles.bestDayLabel}>BEST DAY</Text>
                  <Text style={styles.bestDayValue}>{scoreTrend.bestScore}</Text>
                </View>
              )}
            </Card>
          </>
        )}

        {/* PROGRESS — level + XP + badges. NEX-48 Phase 5: Card primitive. */}
        <SectionHeader>PROGRESS</SectionHeader>
        <Card style={styles.cardSpacing}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 }}>LEVEL</Text>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 1 }}>LVL {xpProgress.level}</Text>
          </View>

          <View style={{ marginTop: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 }}>XP</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_555, fontSize: 9, fontWeight: '700' }}>{xpProgress.current}/{xpProgress.needed} XP</Text>
            </View>
            <View style={[styles.xpTrack, { marginTop: 8 }]}>
              <View style={[styles.xpFill, { width: `${xpProgress.percent}%` }]} />
            </View>
          </View>

          <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: tokens.color.surfaceElevated, paddingTop: 12 }}>
            <Pressable onPress={() => setShowBadgesModal(true)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 8, fontWeight: '900', letterSpacing: 2 }}>BADGES</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 8, fontWeight: '700', letterSpacing: 1 }}>
                {(badges || []).filter((b: any) => b.unlockedAt).length}/{(badges || []).length}  ›
              </Text>
            </Pressable>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {(badges || []).map((badge: any) => (
                <Pressable key={badge.id} onPress={() => setShowBadgesModal(true)} style={{
                  width: 36, height: 36, borderRadius: 10,
                  backgroundColor: badge.unlockedAt ? GOLD + '15' : GRAY_111,
                  borderWidth: 1, borderColor: badge.unlockedAt ? GOLD + '40' : tokens.color.luminousEdge,
                  justifyContent: 'center', alignItems: 'center',
                }}>
                  <SacredShape
                    name={shapeForBadgeId(badge.id)}
                    size={22}
                    opacity={badge.unlockedAt ? 1 : 0.2}
                    showLockOverlay={!badge.unlockedAt}
                  />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Card>

        {/* WHERE TO LEAN — Mon-Wed only. NEX-217: de-shamed. Was "THIS WEEK'S
            LEVERAGE" ("Leverage" is a §18-banned word) with a red fill bar +
            rate% + "Needs attention."/"Drifting." verdict copy — a backward
            grade on a low week. Now additive + forward: the identity habits
            worth leaning on, with a non-judgmental rep count. No rate, no red,
            no denominator. "recently" (not "this week") since the leverage
            window is a rolling 7 days, not the calendar week. */}
        {leverageThisWeek.length > 0 && (
          <>
            <SectionHeader>WHERE TO LEAN</SectionHeader>
            <Card style={styles.cardSpacing}>
              {leverageThisWeek.map((p: any) => {
                const linkPart =
                  p.pillarLinkCount > 0
                    ? `Linked to ${p.pillarLinkCount} mandate${p.pillarLinkCount === 1 ? '' : 's'}.`
                    : 'Identity habit.';
                return (
                  <View key={p.ruleId} style={styles.leverageRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.leverageTitle}>{stripEmoji(p.title)}</Text>
                      {/* NEX-217: no count here. computeLeveragePoints' `completed`
                          is SCHEDULE-CAPPED (it can read 0 with raw logs present),
                          so "0 reps recently" would re-introduce the exact verdict
                          this surface removes. WHERE TO LEAN is forward ("lean on
                          these identity habits"); the mandate link is the signal. */}
                      <Text style={styles.leverageReason} numberOfLines={1}>
                        {linkPart}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </Card>
          </>
        )}

        {/* HORIZON REVIEWS — NEX-48 Phase 5: outer Card primitive. The inner
            horizontal-scroll preview cards stay inline — their 220pt narrow
            shape with custom 14pt padding doesn't fit Card's standard 24pt
            content padding. Phase 5.1 (if needed) can introduce a compact
            Card variant for these. */}
        <SectionHeader
          action={{
            label: '+ START REVIEW',
            onPress: () => setDueReview('weekly'),
          }}
        >
          HORIZON REVIEWS
        </SectionHeader>
        <Card>
          {Array.isArray(horizonReviews) && horizonReviews.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 4 }}>
              {horizonReviews.slice(0, 8).map((r: any) => (
                <Pressable
                  key={r.id}
                  onPress={() => setDueReview(r.cadence)}
                  style={styles.horizonPreviewCard}
                >
                  <Text style={styles.horizonPreviewCadence}>{String(r.cadence || '').toUpperCase()}</Text>
                  <Text style={styles.horizonPreviewPeriod} numberOfLines={1}>{r.periodLabel || ''}</Text>
                  <Text style={styles.horizonPreviewSummary} numberOfLines={4}>
                    {r.summary || '—'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.mutedText}>No reviews yet. Tap + START REVIEW to begin.</Text>
          )}
        </Card>
      </ScrollView>
      </AdaptiveScreen>
      <StatusBarScrim />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// FIXME(nex-56): styles below are a direct lift from home-screen.tsx with the
// same off-scale paddings/fontSizes flagged for design review. Phase 5 Card
// sweep will refactor these to use the <Card> primitive + tokens.spacing/radii.

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent'},
  // FIXME(nex-56): off-scale 22pt horiz + 120pt bottom — design review
  scroll: { paddingHorizontal: 22, paddingBottom: 120 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: tokens.spacing.xs,
    marginBottom: tokens.spacing.lg,
  },
  title: {
    ...tokens.type.titleScreen,
    color: TEXT,
  },
  // NEX-48 Phase 5: card / leverageCard dropped — replaced with <Card>
  // primitive. cardSpacing is the standard margin between stacked cards.
  // FIXME(nex-56): off-scale 14pt margin — design review (nearest md 16 or lg 24)
  cardSpacing: { marginBottom: 14 },
  // BEST DAY — the one earned number kept from the retired avg row. Gold, since
  // it's an achievement rather than a grade (the averages were the grade).
  bestDayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: tokens.spacing.md,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: tokens.color.goldHairline,
  },
  bestDayLabel: { ...tokens.type.labelTrackedMicro, color: MUTED },
  bestDayValue: { ...tokens.type.numericMd, color: GOLD },
  leverageRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm, marginTop: tokens.spacing.sm },
  // FIXME(nex-56): off-scale 14pt fontSize + 6pt margin — design review
  leverageTitle: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 14, fontWeight: '700', marginBottom: 6 },
  // NEX-217: leverageBar / leverageFill / leveragePct / leverageMeta removed
  // with the de-shamed "WHERE TO LEAN" rework (no rate%, no fill bar, no count).
  // FIXME(nex-56): off-scale 11pt fontSize + 2pt margin — design review
  leverageReason: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 11, marginTop: 2 },
  xpTrack: { height: 4, backgroundColor: tokens.color.surfaceElevated, borderRadius: 2, overflow: 'hidden' },
  xpFill: { height: '100%', backgroundColor: GOLD, borderRadius: 2 },
  // FIXME(nex-56): off-scale 14pt padding — design review
  horizonPreviewCard: {
    width: 220,
    backgroundColor: tokens.color.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    borderLeftWidth: 3,
    borderLeftColor: GOLD,
    padding: 14,
    ...ambientGlowSoft,
  },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  horizonPreviewCadence: { color: GOLD, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  horizonPreviewPeriod: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, fontWeight: '700', marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 12pt fontSize + 17pt lineHeight — design review
  horizonPreviewSummary: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 12, lineHeight: 17 },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  mutedText: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 14 },
  // FIXME(nex-56): black-alpha modal scrim + off-scale 28pt padding — design review
  // v3 stellar: warmth-tinted backdrop (voidDeep at 78%) instead of pure
  // black — matches the gradient.vignette pattern in CLAUDE.md §4.8.
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(2,2,8,0.78)', justifyContent: 'center', padding: 28 },
  // FIXME(nex-56): off-scale 28pt padding — design review
  modalCard: { backgroundColor: tokens.color.surfaceElevated, borderRadius: 24, padding: 28, borderWidth: 1, borderColor: tokens.color.luminousEdge, ...ambientGlow },
});
