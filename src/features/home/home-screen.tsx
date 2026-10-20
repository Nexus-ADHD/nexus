import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput,
  AppState, Modal, KeyboardAvoidingView, Platform, Alert, Animated, Share, RefreshControl,
} from 'react-native';
// NEX-48 Phase 8: Reanimated for the first-open ceremonial fade. Mixes
// cleanly with the existing legacy Animated.* usage (modal/XP/streak toast)
// since they live on separate views. Reanimated runs on the UI thread.
//
// CRITICAL: hook names (useAnimatedStyle, useSharedValue, withTiming) must
// stay UNALIASED. Reanimated's Babel plugin detects worklets by exact
// identifier match at the call site — if these are renamed, the worklet
// body never gets compiled and `scheduleOnUI` crashes when it tries to
// invoke a plain JS function on the UI runtime. Only the namespace default
// is aliased here to avoid colliding with RN's legacy `Animated`.
import ReAnimated, {
  Easing as ReEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import * as Device from 'expo-device';
import tokens from '@/src/theme/tokens';
import { ambientGlow, ambientGlowSoft } from '@/src/theme/glow';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';
import { announce } from '@/src/utils/a11y';
import { useMinuteClock } from '@/src/utils/use-minute-clock';
import { compareByStartISO } from '@/src/utils/orbit-sort';
import { addAppBreadcrumb } from '@/src/utils/breadcrumbs';
import ConfettiCannon from 'react-native-confetti-cannon';
import { scheduleMilestoneNotification } from '../../services/notifications';
import { AnimatePresence } from 'moti';
import { shouldShowCaptureEcho } from '../command/capture-echo';
import { CommandExecutionLedger } from '../command/command-execution-ledger';
import type { LedgerItem } from '../command/command-executor';
import { extractCaptures } from '@/src/services/north-star-metrics';
import { useAppState, getXPProgress, BADGE_DEFINITIONS, type RecurringRule } from '@/src/state/app-state';
import { isScheduledOn, selectTodayTaskRollup } from '@/src/state/selectors/today-rollup';
import { computeHomeDailyScore } from '@/src/state/selectors/daily-score';
import { selectLeadTimeRollup } from '@/src/state/selectors/lead-time';
import { formatKeyShortWithWeekday, daysBetweenKeys, addDaysToKey } from '@/src/state/lead-time-types';
import { computeHabitProgress, computeLifetimeReps, computeWeeklyReps, crossedRepMilestone, weeklyProgressLabel } from '@/src/state/selectors/habit-rollup';
import { checkAndSendWeeklySummary, sendWelcomeEmailIfNeeded } from '../../services/weekly-email';
import { isDevSkipSessionActive } from '@/src/utils/dev-skip-session';
import { maybeRequestStoreReviewAfterHabitCompletion } from '../settings/store-review';

import { HorizonReviewModal, getDueReview } from './horizon-review';
import { selectCutOrCommitItems } from './cut-or-commit';
import { shouldShowCue } from '@/src/components/ui/cue-library';
import { resolveMandateEcho } from '@/src/utils/mandate-echo';
import {
  selectTodaysHabits,
  selectTodaysCompletionCounts,
  isHabitCompleteToday as isHabitCompleteTodayWith,
  habitCompletionKey,
} from './todays-habits';
import { HabitFirstStep } from '@/src/components/ui/HabitFirstStep';
import { shouldShowFirstStep } from '@/src/components/ui/habit-first-step';
// NEX-48 Phase 4: computeLeveragePoints used only by THIS WEEK'S LEVERAGE,
// which moved to /this-week. Import dropped.
import { normalize, stripEmoji } from '@/src/utils/text';
import { getStreakGraceStatus } from '@/src/utils/streak-grace';
import { isPausedOn, homeSurfaceMode, isPausePromptDue } from '@/src/state/pause-mode';
import { buildAIContext, AI_PERSONA } from '../../utils/ai-context';
import { MORNING_BRIEF_SUFFIX } from '@/src/ai/prompts';
import { chatCompletion } from '../../utils/ai-client';
// NEX-305: name the tier at each call site. All three of this screen's AI calls
// used to pass no model and ride the shared default.
import { MODELS } from '../../utils/ai-models';
import { generateWisdom } from '../wisdom/wisdom-service';
import { SettingsScreen } from '../settings/settings-screen';
import { ManageHabitsModal } from '../../components/manage-habits-modal';
import { AlignmentScoreRing, scoreBandKey } from '@/src/components/ui/AlignmentScoreRing';
import { trackEvent } from '@/src/services/analytics';
import { recordCapture, recordFirstReach } from '@/src/services/capture-reach-tracker';
import { Card } from '@/src/components/ui/Card';
// barColorForScore / barHeightForScore left with the paywall preview — THIS
// WEEK's bars became the ScoreTrendChart line. kpiColorForRate still tiers the
// KPI tiles under it.
import { kpiColorForRate } from '@/src/components/ui/weekly-debrief-chart-helpers';
import { ScoreTrendChart } from '@/src/components/ui/ScoreTrendChart';
import { selectDueReminders } from '@/src/state/reminder-schedule';
import { ReturnLapseCard } from '@/src/features/home/return-lapse-card';
import { PausedCard, ResumePauseCard } from '@/src/features/home/pause-cards';
import { pickOneThing } from '@/src/features/home/return-lapse';
import { HabitRow } from '@/src/components/ui/HabitRow';
import { IconButton } from '@/src/components/ui/IconButton';
import { SectionHeader } from '@/src/components/ui/SectionHeader';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';
import { SymbolView } from 'expo-symbols';
import { useTarget } from '@/src/onboarding/use-target';
import { useOnboarding } from '@/src/onboarding/onboarding-context';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { ornamentMayAnimate } from '@/src/utils/reduce-motion-policy';
import { buildWidgetData, updateWidgetData } from '../../widgets/widget-bridge';
import { buildWatchData, sendDataToWatch } from '../../widgets/watch-bridge';
import { fetchConnectedCalendarEventsWindow } from '../../services/calendar-events';

// NEX-56: top-level aliases route through tokens. Spec migrations are intentional.
const BG = tokens.color.voidDeep;
// NEX-161: frosted parity — SURFACE feeds only statusCard + card (verified),
// both card-shaped surfaces, so the translucent surface token applies cleanly.
const SURFACE = tokens.color.surface;
const BORDER = tokens.color.goldHairline;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;
const GOLD = tokens.color.gold;

// v3 stellar: semantic + gray aliases retoned to v3 tokens.
// Each alias is kept for code-reading clarity at call sites; the underlying
// value is now the v3 token (cool palette + frosted-friendly grays).
// Per CLAUDE.md §4.7: success → teal, warning → gold, error → warm red.
const SEMANTIC_SUCCESS = tokens.color.teal;        // was #4CAF50 Material green
const SEMANTIC_ERROR   = tokens.color.stateError;  // was #FF5252 Material red
const SEMANTIC_INFO    = tokens.color.stateInfo;   // was #4A90D9 Material blue
const SEMANTIC_WARN    = tokens.color.gold;        // was #FF9800 Material orange (warning uses gold in v3)
// Gray aliases collapse onto v3's three cool-shifted text tiers. Visual
// subtleties between e.g. #555 and #666 are sacrificed; nothing
// load-bearing relied on the distinction.
const GRAY_555 = tokens.color.textMuted;     // was #555
const GRAY_444 = tokens.color.textDisabled;  // was #444
const GRAY_333 = tokens.color.textDisabled;  // was #333
const GRAY_888 = tokens.color.textMuted;     // was #888
const GRAY_666 = tokens.color.textMuted;     // was #666
const GRAY_111 = tokens.color.voidDeep;      // was #111 — deep surface tier
const GRAY_3A  = tokens.color.textDisabled;  // was #3A3A3A
// Pre-warming gold retired; aligns with v3 tokens.color.gold (#E5BA6E).
const LEGACY_GOLD = tokens.color.gold;       // was #D4AF37

// §5.5: clamp featured display numerals for Dynamic Type — honor larger sizes
// but never let them blow out of their container (the level number lives in a
// fixed 120pt circle; the score numeral in a fixed modal card). Mirrors the
// AlignmentScoreRing hero clamp (NEX-250 C5a). 1.5 keeps multi-digit values in.
const DISPLAY_MAX_FONT_SCALE = 1.5;
// NEX-161: BORDER_DARK retired — its only consumer (the inline empty-state card)
// now uses tokens.color.luminousEdge directly.

// NEX-191: calm continuity line when the user has no anchor/mandate set yet.
// Forward-looking, identity-as-fact, no shame (Law C / §18).
const RETURN_FALLBACK_MANDATE = "You're still the person who started this.";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Good night';
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// First-open ceremony fade duration (§11.1). Shared so the below-the-fold
// reveal delay (which must wait out the fade) can derive from it, not duplicate
// the number.
const CEREMONY_FADE_MS = 800;

// NEX-perf: the two Home time-display widgets own the minute tick (via the
// shared useMinuteClock) instead of a 60s setInterval in HomeScreen that
// re-rendered the whole ~3120-line tree every minute. Behavior is identical to
// the prior `now`-state computations; only the re-render scope shrinks to these
// leaves. They share one clock so they can't disagree near an event boundary.

/** The events-left status pill value (was the first statusCard, lines ~1976). */
function EventsLeftCard({ events }: { events: any[] }) {
  const nowMs = useMinuteClock(); // shared minute snapshot — both leaves read the same value
  const total = events.length;
  const remaining = events.filter(
    (e: any) => new Date(e.endISO ?? e.startISO).getTime() > nowMs,
  ).length;
  return (
    <View style={styles.statusCard}>
      <Text style={styles.statusValue}>{remaining}</Text>
      <Text style={styles.statusTitle}>{remaining === total ? 'EVENTS TODAY' : 'LEFT'}</Text>
      {remaining !== total && <Text style={styles.statusSubtitle}>{total} TOTAL</Text>}
    </View>
  );
}

/** TODAY'S HORIZON / UP NEXT card (was inline, lines ~2445). */
function HorizonUpNextCard({ events }: { events: any[] }) {
  const nowMs = useMinuteClock(); // shared minute snapshot — both leaves read the same value
  const nextEvent = events.find((e: any) => new Date(e.startISO).getTime() > nowMs) ?? null;
  return (
    <>
      <SectionHeader>{"TODAY'S HORIZON"}</SectionHeader>
      <Card style={styles.cardSpacing}>
        {nextEvent ? (
          <>
            <Text style={styles.horizonEyebrow}>UP NEXT</Text>
            <Text style={styles.nextEventTitle}>{nextEvent.title}</Text>
            <Text style={styles.nextEventTime}>{formatTime(nextEvent.startISO)}</Text>
          </>
        ) : events.length > 0 ? (
          <Text style={styles.mutedText}>All events for today are done.</Text>
        ) : (
          <Text style={styles.mutedText}>No events on calendar today.</Text>
        )}
      </Card>
    </>
  );
}

function getTodayKey(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function isSunday(): boolean {
  return new Date().getDay() === 0;
}

function getThisSundayKey(): string {
  const d = new Date();
  const day = d.getDay();
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  const y = sunday.getFullYear();
  const m = String(sunday.getMonth() + 1).padStart(2, '0');
  const dd = String(sunday.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function HomeScreen() {
  const router = useRouter();
  const {
    userProfile, inbox, orbitDays, pillars, recurringRules,
    morningIntention, morningIntentionDate, morningIntentionCompletedDate, toggleMorningIntentionComplete,
    weeklyReflection, weeklyReflectionDate,
    nightlyForward, nightlyForwardDate,
    setMorningIntention, setWeeklyReflection, setWeeklyWins,
    computeDailyScore, getStreak, habitStreaks, habitStreakUpdatedDate, habitLog, logHabit, unlogHabit,
    softMode,
    pauseMode, // NEX-207
    weeklyWins, weeklyWinsDate,
    pinnedHabits, setHabitExcludedFromScore, deleteRecurringRule, renameRecurringRule, addRecurringRule,
    updateRecurringRule, // NEX-202: sever the mandate echo (mandateEchoPillarId: null)
    lastReviewDates,
    leadTimeActions, toggleLeadTimeAction,
    activateUser,
    hasSeenTutorial, setHasSeenTutorial,
    totalXP, badges, streakFreezes,
    pendingLevelUp, pendingBadgeUnlock, clearPendingLevelUp, clearPendingBadgeUnlock,
    recordDailyScore, scoreHistory,
    horizonReviews,
    dailyTasks, recurringToDos,
    pendingMondayIntention, consumePendingMondayIntention, clearPendingMondayIntention,
    applyPendingRuleOverrides,
    goalHabitMap,
    activatedDate,
    weeklyEmailEnabled, weeklyEmailConsent, weeklyEmailDay,
    firstAlignmentScoreSeenFired, markFirstAlignmentScoreSeen,
    justCaptured, clearJustCaptured, setJustCaptured, resolveInboxTask,
    addInboxTask, deleteInboxTask, // NEX-200: Home one-off quick-capture
    returningFromLapse, setReturningFromLapse,
    resumingFromPause, setResumingFromPause, resumePauseMode, // NEX-207 B2
    dailyWisdomQuotes, dailyWisdomDate, wisdomQuoteCount, // widget quote + guard
  } = useAppState() as any;

  // NEX-191: shame-free return mode. `returningFromLapse` is set once per launch
  // in recordAppOpen after a >=3-day lapse (and only for onboarded users). Home
  // collapses to the calm return surface until the user opts into the full Home
  // ("Show what piled up", acts on the one thing, or skips it).
  const [showPiledUp, setShowPiledUp] = useState(false);
  // NEX-207 B2 (Greptile #167): the "show piled up" opt-out is per-lapse-episode,
  // but the Home tab stays mounted so the local flag is sticky across episodes.
  // Reset it SYNCHRONOUSLY when a new lapse begins (returningFromLapse flips true),
  // using React's "adjust state during render". Crucially we DERIVE the corrected
  // value locally (`effectiveShowPiledUp`) and feed THAT into homeSurfaceMode this
  // same render — the queued setShowPiledUp(false) only lands next render, so
  // relying on it would let the first render of a new episode select 'normal'
  // (stale opt-out) and fire normal-Home side effects before correcting (Greptile #167).
  const [lastReturningFromLapse, setLastReturningFromLapse] = useState(!!returningFromLapse);
  let effectiveShowPiledUp = showPiledUp;
  if (!!returningFromLapse !== lastReturningFromLapse) {
    setLastReturningFromLapse(!!returningFromLapse);
    if (returningFromLapse && showPiledUp) {
      setShowPiledUp(false);
      effectiveShowPiledUp = false;
    }
  }
  // NEX-207 B2: one pure state machine for the calm Home surfaces.
  // Precedence paused > resume > return > normal (homeSurfaceMode).
  const surfaceMode = homeSurfaceMode({
    pauseActive: !!pauseMode?.active,
    resumingFromPause: !!resumingFromPause,
    returningFromLapse: !!returningFromLapse,
    showPiledUp: effectiveShowPiledUp,
  });
  const pausedMode = surfaceMode === 'paused';
  const resumeMode = surfaceMode === 'resume';
  const returnMode = surfaceMode === 'return';
  // Any calm surface collapses the normal Home (render AND its side effects).
  const collapsedHome = surfaceMode !== 'normal';
  const exitReturnMode = useCallback(() => {
    setShowPiledUp(true);
    setReturningFromLapse?.(false);
  }, [setReturningFromLapse]);

  // NEX-196: Home echo chip for a just-captured one-off. Validity-gated (shows
  // only while the item is still in the Inbox) — no wall-clock timer.
  const showCaptureEcho = shouldShowCaptureEcho(justCaptured, inbox);

  // NEX-200 (H-3): capture a one-off WITHOUT leaving Home. A pure Inbox capture
  // is synchronous (a store write — no LLM, no Apple mirror), so it needs none
  // of the Command tab's async-race / execution-lock machinery. The item
  // surfaces in place (the reused execution ledger + the NEX-196 echo) with
  // one-tap undo, before any confirmation closes (§1.5 Law A). Smart
  // natural-language parsing (dates / habits / calendar) stays on Command.
  const [captureText, setCaptureText] = useState('');
  const [captureLedger, setCaptureLedger] = useState<LedgerItem[] | null>(null);
  const captureSubmittingRef = useRef(false);

  const handleHomeCapture = useCallback(() => {
    // Double-submit LATCH. Two onSubmitEditing events in one tick (RN can batch
    // native submit, or "ADD" tap + keyboard "done") run against the SAME
    // memoized closure where captureText is still the old non-empty value, so
    // the !text check can't catch them. We latch the ref true and DON'T reset it
    // synchronously — it re-arms only when the user edits the input again
    // (onChangeText), which is the next genuine capture intent. (setCaptureText('')
    // below is programmatic and does NOT fire onChangeText, so the latch holds.)
    if (captureSubmittingRef.current) return;
    const text = captureText.trim();
    if (!text) return;
    captureSubmittingRef.current = true;
    const id = addInboxTask(text, { source: 'manual' });
    const item: LedgerItem = {
      key: id,
      title: text,
      type: 'inbox_add',
      status: 'success',
      detail: 'In your Inbox.',
      entityId: id,
      surface: 'inbox',
    };
    setCaptureLedger([item]);
    // NEX-196 echo: persistent "it's in your Inbox" proof that lingers after
    // the ledger is dismissed (validity-gated; auto-hides on undo/complete).
    setJustCaptured?.({ id, title: text, surface: 'inbox' });
    // NEX-222 / NEX-200: emit the SAME item_captured fact Command does (reuse
    // extractCaptures so the prop shape can't drift), tagged origin 'home'.
    // `void` (not awaited) is safe here unlike Command's sequential await: this
    // is a SINGLE event, so there's no in-loop cold-cache last-writer race.
    for (const c of extractCaptures([item])) {
      void trackEvent('item_captured', {
        capture_id: c.captureId,
        item_type: c.itemType,
        capture_surface: c.surface,
        capture_origin: 'home',
        local_day_key: getTodayKey(),
      });
      // NEX-261: register the capture for the first-reach tracker (mirrors the
      // Command-tab item_captured site).
      void recordCapture(c.captureId);
    }
    haptic('voiceSuccess');
    setCaptureText('');
  }, [captureText, addInboxTask, setJustCaptured]);

  const handleCaptureUndo = useCallback((item: LedgerItem) => {
    if (item.entityId) deleteInboxTask(item.entityId);
    // The echo is validity-gated on the item still existing, so the delete
    // already hides it; clear explicitly so there's no stale pointer (§1.5 Law E).
    clearJustCaptured?.();
  }, [deleteInboxTask, clearJustCaptured]);

  const handleCaptureJump = useCallback(() => {
    clearJustCaptured?.();
    setCaptureLedger(null);
    router.push('/(tabs)/inbox' as any);
  }, [clearJustCaptured, router]);

  // One-visit echo: clear the ref when leaving Home so the chip doesn't reappear
  // on a later visit. A capture may originate on Command (Home entered after) or
  // on Home itself (NEX-200) — either way the chip is a one-visit acknowledgment;
  // reading via getState avoids a stale closure.
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        const st = (useAppState as any).getState?.();
        if (st?.justCaptured) {
          st.clearJustCaptured?.();
        }
        // NEX-200: clear the in-place capture confirmation on focus-leave so it's
        // a one-visit acknowledgment (mirrors the echo above). The Inbox item
        // persists; only the transient ledger + its undo window close on leave.
        setCaptureLedger(null);
        // NEX-207 B2: clear resumingFromPause on focus-leave (AFTER the resume
        // card was shown on Home) so it's a one-visit forward acknowledgment,
        // never silently dropped. Mirrors the justCaptured one-visit pattern.
        if (st?.resumingFromPause) {
          st.setResumingFromPause?.(false);
        }
      };
    }, []),
  );

  // ── Onboarding engine wiring ─────────────────────────────────────────────
  // useTarget calls happen at the top of the component body so hook order
  // stays stable across renders. Each returns a stable ref-callback that
  // registers/unregisters the View with the OnboardingProvider.
  const scoreCardRef = useTarget('home.scoreCard');
  const gettingStartedRef = useTarget('home.gettingStarted');
  const { startFlow, currentFlowId, completedSteps, isFlowActive } = useOnboarding();

  // NEX-36: Kick the home flow when Home becomes focused, not on every
  // mount. The 600ms delay lets the screen finish laying out so target
  // refs are registered + measurable before the first step opens.
  //
  // Why useFocusEffect instead of useEffect: expo-router's tab navigator
  // keeps tab children mounted across tab switches. With a bare
  // useEffect, the post-onboarding destination picker routing to a
  // non-Home tab would still trigger the 600ms timer because Home
  // mounted as the initial tab (then was replaced by router.replace).
  // useFocusEffect cleans up on blur, so a fast tab switch cancels the
  // timer before it fires.
  //
  // isFlowActive guards against re-queueing while a flow is already
  // showing — defensive, e.g. if hasSeenTutorial flips inside a focus
  // window.
  useFocusEffect(
    useCallback(() => {
      if (hasSeenTutorial) return;
      // NEX-191/NEX-207 B2: never start the home onboarding flow while ANY calm
      // surface is up (return / paused / resume) — they hide the ring/habit
      // spotlight targets, and a cloud-restored user can have hasSeenTutorial=false
      // yet be returning or paused.
      if (collapsedHome) return;
      if (isFlowActive) return;
      const t = setTimeout(() => startFlow('home'), 600);
      return () => clearTimeout(t);
    }, [hasSeenTutorial, collapsedHome, isFlowActive, startFlow])
  );

  // NEX-48 Phase 8: pull-to-refresh handler. Re-fetches today's Apple
  // Calendar events; on Sundays also regenerates the weekly reflection.
  // Spec §11.1 wants a "teal hairline grows top-down on pull" custom
  // ceremony — that's a Phase 8.1 enhancement requiring a gesture handler.
  // For now this uses the native RefreshControl with teal tintColor.
  // Callback body references fetchTodayAppleEvents + generateWeeklyReflection
  // by lexical scope — they're defined later in the component body but
  // resolved at invocation time after render. Deps [] keeps the handler
  // identity stable across renders.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    haptic('pullRefreshTrigger');
    try {
      await fetchTodayAppleEvents();
      if (isSunday() && !reflectionLoading) {
        await generateWeeklyReflection();
      }
    } catch {
      /* swallow — refresh failures are non-fatal */
    }
    setRefreshing(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror flow completion into the legacy hasSeenTutorial flag so the
  // rest of the app (and resetState semantics) stays consistent. Detects
  // the home → null transition rather than reading completedSteps.
  const prevFlowIdRef = useRef<string | null>(null);
  useEffect(() => {
    // NEX-193: the home flow is now a single step ('home-score') after the
    // guided-habit coachmark was removed. Mark seen only when that step
    // completes; a tap-outside dismissal leaves hasSeenTutorial false so the
    // engine can resume on next launch.
    if (
      prevFlowIdRef.current === 'home' &&
      currentFlowId === null &&
      !hasSeenTutorial &&
      completedSteps['home-score']
    ) {
      setHasSeenTutorial(true);
    }
    prevFlowIdRef.current = currentFlowId;
  }, [currentFlowId, hasSeenTutorial, setHasSeenTutorial, completedSteps]);

  const [appleEvents, setAppleEvents] = useState<any[]>([]);
  // Anchor state moved to align.tsx with the card.
  const [showConfetti, setShowConfetti] = useState(false);
  const [xpToast, setXpToast] = useState<string | null>(null);
  const xpToastOpacity = useRef(new Animated.Value(0)).current;

  // Resting a habit (excludedFromScore = true) filters it out of Today's Habits
  // with no way to re-include it from Home — so a mistap silently vanishes a
  // habit. Surface a location-bearing, one-tap-undo toast (§1.5 Law A / error
  // recovery) whenever a habit is rested.
  const [restUndo, setRestUndo] = useState<{ ruleId: string; title: string } | null>(null);
  const restUndoOpacity = useRef(new Animated.Value(0)).current;
  const restUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRestUndo = useCallback(() => {
    if (restUndoTimer.current) { clearTimeout(restUndoTimer.current); restUndoTimer.current = null; }
    Animated.timing(restUndoOpacity, { toValue: 0, duration: 250, useNativeDriver: true })
      // Guard on `finished`: if a new toast interrupts this fade-out, RN fires
      // this callback with finished=false — don't clear the just-shown toast.
      .start(({ finished }) => { if (finished) setRestUndo(null); });
  }, [restUndoOpacity]);
  const showRestUndo = useCallback((ruleId: string, title: string) => {
    if (restUndoTimer.current) { clearTimeout(restUndoTimer.current); restUndoTimer.current = null; }
    setRestUndo({ ruleId, title });
    restUndoOpacity.setValue(0);
    Animated.timing(restUndoOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    restUndoTimer.current = setTimeout(() => hideRestUndo(), 6000);
  }, [restUndoOpacity, hideRestUndo]);
  const handleRestUndo = useCallback(() => {
    const target = restUndo;
    if (target) setHabitExcludedFromScore?.(target.ruleId, false);
    hideRestUndo();
  }, [restUndo, setHabitExcludedFromScore, hideRestUndo]);
  // Clear the auto-hide timer on unmount so it can't fire on a gone screen.
  useEffect(() => () => { if (restUndoTimer.current) clearTimeout(restUndoTimer.current); }, []);

  const xpProgress = getXPProgress(totalXP || 0);

  const [showSettings, setShowSettings] = useState(false);

  // NEX-48 Phase 8: pull-to-refresh state. onRefresh re-fetches today's Apple
  // Calendar events and regenerates the weekly reflection on Sundays.
  const [refreshing, setRefreshing] = useState(false);

  // NEX-48 Phase 8: first-open-of-the-day ceremonial fade. Tracks the last
  // dayKey we ran the fade for in AsyncStorage; if today differs, the screen
  // content fades in from 0 → 1 over 800ms with a slight upward translate.
  // Spec §11.1's "ceremonial entry" — first impression of the day reads as
  // ritual, not utility. On subsequent opens during the same day the
  // content appears instantly (sharedValue stays at 1).
  const firstOpenFade = useSharedValue(1);
  const firstOpenTranslate = useSharedValue(0);
  const firstOpenStyle = useAnimatedStyle(() => ({
    opacity: firstOpenFade.value,
    transform: [{ translateY: firstOpenTranslate.value }],
  }));
  // Reduce Motion for the first-open ceremony below. Held in a ref, not read
  // as an effect dependency, because that effect also writes
  // `nexus_lastDailyOpen` — adding a dep that flips on a live toggle could
  // re-run a once-per-day side effect. The ref is refreshed every render, so
  // the ceremony reads a current value whenever it happens to run.
  const reduceMotionState = useReduceMotion();
  const ceremonyMayAnimateRef = useRef(ornamentMayAnimate(reduceMotionState));
  ceremonyMayAnimateRef.current = ornamentMayAnimate(reduceMotionState);
  const scrollRef = useRef<any>(null);
  const lastScrollCrumbRef = useRef(0);

  // App-Hang repro path breadcrumbs (no PII): record Home mount and (throttled)
  // user scroll, so a hang on Home carries a trail of what the user was doing.
  useEffect(() => {
    addAppBreadcrumb('home', 'mounted');
  }, []);
  const handleHomeScroll = useCallback(() => {
    const now = Date.now();
    // Throttle: scroll fires constantly; at most one crumb per second so the
    // 100-entry breadcrumb buffer isn't flooded out.
    if (now - lastScrollCrumbRef.current < 1000) return;
    lastScrollCrumbRef.current = now;
    addAppBreadcrumb('home', 'scrolled');
  }, []);

  // NEX-189 (Law A — zero hunting): when the capture confirmation's "TAKE ME
  // THERE" jumps here for a home_today item, land ON the Today's Habits section,
  // not at Home-top. The jump pushes `?focus=habits`; we scroll to the section
  // once, then clear the param so a later Home focus doesn't re-scroll. The
  // section's y is captured via onLayout (it's a direct child of the scroll
  // content wrapper, so layout.y is the scroll offset, transform-independent —
  // measureLayout was rejected by the Fabric renderer for the scroll node).
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const habitsSectionY = useRef(0);
  const scrolledForFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (focus !== 'habits') {
      scrolledForFocusRef.current = null;
      return;
    }
    if (scrolledForFocusRef.current === 'habits') return;
    scrolledForFocusRef.current = 'habits';
    // Delay so the tab is focused and laid out after navigation.
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo?.({ y: Math.max(0, habitsSectionY.current - 16), animated: true });
      router.setParams({ focus: undefined } as any);
    }, 400);
    return () => clearTimeout(t);
  }, [focus, router]);

  // NEX-48 Phase 4: showBadgesModal / showProgressSection / showTrendSection
  // state moved to /this-week alongside their JSX. Phase 5 will clean up the
  // remaining unused selectors (badges, streakFreezes).

  const [showLevelUpModal, setShowLevelUpModal] = useState(false);
  const [levelUpLevel, setLevelUpLevel] = useState(0);
  const [showBadgeToast, setShowBadgeToast] = useState(false);
  const [badgeToastData, setBadgeToastData] = useState<any>(null);
  const badgeToastOpacity = useRef(new Animated.Value(0)).current;
  const levelUpScale = useRef(new Animated.Value(0.5)).current;
  const levelUpOpacity = useRef(new Animated.Value(0)).current;

  const [shareStreakData, setShareStreakData] = useState<{ title: string; reps: number } | null>(null);

  const [showDay1Nudge, setShowDay1Nudge] = useState(false);
  useEffect(() => {
    const liveState = (useAppState as any).getState() as any;
    const activatedDate = liveState.activatedDate;
    if (!activatedDate) return;
    const hoursSinceActivation = (Date.now() - new Date(activatedDate).getTime()) / (1000 * 60 * 60);
    if (hoursSinceActivation > 24) return;
    AsyncStorage.getItem('nexus_day1NudgeDismissed').then(val => {
      if (!val) setShowDay1Nudge(true);
    }).catch(() => {});
  }, []);

  const dismissDay1Nudge = () => {
    setShowDay1Nudge(false);
    AsyncStorage.setItem('nexus_day1NudgeDismissed', 'true').catch(() => {});
  };

  // Welcome email — fires once on first activation
  useEffect(() => {
    if (!activatedDate || !userProfile?.email) return;
    // Dev-skip session (SKIP SIGN-IN on AuthScreen): local state can carry a
    // real email; never fire the edge-function send for the fake session.
    if (__DEV__ && isDevSkipSessionActive()) return;
    sendWelcomeEmailIfNeeded({
      userEmail: userProfile.email,
      userName: userProfile.name ?? '',
    });
  }, [activatedDate]);

  // Weekly email — check on every app open
  useEffect(() => {
    if (!userProfile?.email) return;
    // Dev-skip session: same guard as the welcome email above.
    if (__DEV__ && isDevSkipSessionActive()) return;
    checkAndSendWeeklySummary({
      weeklyEmailEnabled: weeklyEmailEnabled ?? false,
      weeklyEmailConsent: weeklyEmailConsent ?? 'unset',
      weeklyEmailDay: weeklyEmailDay ?? 0,
      userEmail: userProfile.email,
      userName: userProfile.name ?? '',
      habitLog: habitLog ?? [],
      recurringRules: recurringRules ?? [],
      habitStreaks: habitStreaks ?? {},
      dailyScores: scoreHistory ?? {},
      pauseMode, // NEX-207
    });
    // userProfile?.email is in the deps: the email loads async on cold open, so
    // without it this effect runs once before the profile arrives, bails at the
    // guard above, and never retries — the original startup-race bug.
  }, [weeklyEmailEnabled, weeklyEmailConsent, weeklyEmailDay, userProfile?.email]);

  // Drain any nextWeekRuleOverrides staged in the prior 7 days into
  // recurringRules. Idempotent: applied keys are removed from the map.
  // Also expires pendingMondayIntention if its target Monday has passed.
  useEffect(() => {
    if (typeof applyPendingRuleOverrides === 'function') {
      applyPendingRuleOverrides();
    }
    const liveState = (useAppState as any).getState() as any;
    const pending = liveState.pendingMondayIntention;
    if (
      pending &&
      typeof pending.targetDateKey === 'string' &&
      pending.targetDateKey < getTodayKey() &&
      typeof clearPendingMondayIntention === 'function'
    ) {
      clearPendingMondayIntention();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NEX-48 Phase 3: dropped getHabitScale + habitScaleAnims. The old chip
  // checkbox animation lived here; HabitRow now owns its ceremonial checkbox
  // animation internally (§10.3 800ms sequence).

  // Morning intention modal
  const [showIntentionModal, setShowIntentionModal] = useState(false);
  const [intentionDraft, setIntentionDraft] = useState('');

  // Weekly reflection loading
  const [reflectionLoading, setReflectionLoading] = useState(false);

  // Weekly wins modal
  const [showWinsModal, setShowWinsModal] = useState(false);
  const [winsDraft, setWinsDraft] = useState(['', '', '']);

  const today = new Date();
  const todayKey = getTodayKey();

  // NEX-48 Phase 8: first-open-of-the-day ceremonial fade-in. Reads the last
  // dayKey we marked in AsyncStorage; if today differs, sets the shared
  // values to (0, 8pt) and animates back to (1, 0) over 800ms. Spec §11.1's
  // "ceremonial entry" — first impression of the day reads as ritual, not
  // utility. On subsequent opens during the same day, content appears
  // instantly (shared values stay at 1, 0).
  useEffect(() => {
    let cancelled = false;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      let isFirstOpen = false;
      try {
        const lastOpen = await AsyncStorage.getItem('nexus_lastDailyOpen');
        if (cancelled) return;
        if (lastOpen !== todayKey) {
          isFirstOpen = true;
          addAppBreadcrumb('home', 'first_open_ceremony');
          // The fade is the ceremony; the 8pt rise is the ornament on it. Under
          // Reduce Motion the day still opens with its cross-fade, it just
          // does not travel.
          const mayRise = ceremonyMayAnimateRef.current;
          firstOpenFade.value = 0;
          firstOpenTranslate.value = mayRise ? 8 : 0;
          firstOpenFade.value = withTiming(1, {
            duration: CEREMONY_FADE_MS,
            easing: ReEasing.bezier(0.2, 0, 0, 1),
          });
          if (mayRise) {
            firstOpenTranslate.value = withTiming(0, {
              duration: CEREMONY_FADE_MS,
              easing: ReEasing.bezier(0.2, 0, 0, 1),
            });
          }
          await AsyncStorage.setItem('nexus_lastDailyOpen', todayKey);
        }
      } catch {
        /* non-fatal — content still renders without the fade */
      }
      // NEX-perf: reveal the below-the-fold sections AFTER first paint so the
      // initial mount commit is just the above-the-fold ritual (not the whole
      // ~3120-line tree in one main-thread block → no single >2000ms App Hang).
      // On a first-open-of-day, wait out the ~800ms ceremony so mounting the
      // heavy below-fold cards can't hitch the fade. Always scheduled (even on
      // the catch path) so below-fold can never be stranded unmounted.
      if (cancelled) return;
      revealTimer = setTimeout(() => {
        if (!cancelled) setBelowFoldReady(true);
      }, isFirstOpen ? CEREMONY_FADE_MS + 50 : 0);
    })();
    return () => { cancelled = true; if (revealTimer) clearTimeout(revealTimer); };
  }, [todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const scoreBreakdown = useMemo(() => {
    const liveState = (useAppState as any).getState() as any;
    // The formula lives in ONE place now — selectors/daily-score.ts — shared
    // (in spirit) with the iOS widget's Swift port; this memo only shapes the
    // breakdown object the modal renders. NEX-171: score the habits DUE today
    // and not excluded-from-score (a habit counts unless explicitly excluded).
    const scored = computeHomeDailyScore({
      rules: liveState.recurringRules,
      habitLog: liveState.habitLog,
      recurringToDos: liveState.recurringToDos,
      dailyTasksForDay: (liveState.dailyTasks ?? {})[todayKey],
      intentionSet:
        liveState.morningIntentionDate === todayKey && !!liveState.morningIntention,
      dateKey: todayKey,
    });
    const scoringLabel = `${scored.scoredHabitCount} habit${scored.scoredHabitCount !== 1 ? 's' : ''}`;

    return {
      total: scored.total,
      intention: { pts: scored.intentionPts, max: 33, set: scored.intentionPts > 0, text: liveState.morningIntention ?? null },
      habits: { pts: scored.habitPts, max: 33, completed: scored.habitsCompleted, total: scored.habitsRequired, label: scoringLabel },
      tasks: { pts: scored.taskPts, max: 34, completed: scored.tasksCompleted, total: scored.tasksTotal },
    };
    // NEX-perf: `morningIntention` (the text) is read in the body (set flag +
    // breakdown text) but was missing from deps — editing today's intention text
    // without changing its date left the breakdown stale. `pinnedHabits` was a
    // dead dep (not read since NEX-171) and is dropped so an unrelated pin change
    // can't force this O(n) memo to recompute.
  }, [todayKey, morningIntention, morningIntentionDate, habitLog, recurringRules, dailyTasks, recurringToDos]);

  const todayScore = scoreBreakdown.total;
  // NEX-17: mid-band score color reads from the user's chosen ring tint
  // (set in onboarding step 3, persisted on userProfile.ringTint).
  // Defaults to GOLD for pre-NEX-17 profiles. The success/failure
  // colors are intentionally not retinted — they carry semantic weight.
  const ringTintHex =
    userProfile?.ringTint === 'teal' ? tokens.color.teal :
    userProfile?.ringTint === 'amber' ? tokens.color.amber :
    GOLD;
  const scoreColor = todayScore >= 80 ? SEMANTIC_SUCCESS : todayScore >= 50 ? ringTintHex : SEMANTIC_ERROR;

  // Morning Brief — AI daily briefing
  const [morningBrief, setMorningBrief] = useState<string[]>([]);
  const [briefLoading, setBriefLoading] = useState(false);
  const briefGeneratingRef = useRef(false);

  const sanitizeInsightItems = useCallback((items: string[]) => {
    const banned = ["you've built exactly nothing", 'no baseline to stand on', 'pattern is identical'];
    return (Array.isArray(items) ? items : [])
      .map((s) => String(s || '').trim())
      .filter((s) => !!s)
      .filter((s) => !banned.some((b) => s.toLowerCase().includes(b)));
  }, []);

  // NEX-193: the `habitsToday` memo was removed with the guided-first-habit
  // recovery effect (its only consumer). NEX-199: the Today's Habits render now
  // reads the top-level `scheduledTodayHabits` → `selectTodaysHabits` (cap +
  // collapse) computed below, not an inline list in the render IIFE.

  // NEX-191: today's INCOMPLETE scheduled habits (titles + ids), in order — the
  // first is the return screen's preferred "one thing." Mirrors habitsToday's
  // filtering + completion count, but keeps the per-habit list (habitsToday is
  // aggregate only) and excludes ones already done today.
  const incompleteHabitsToday = useMemo(() => {
    const dow = new Date().getDay();
    const rules = Array.isArray(recurringRules) ? recurringRules.filter((r: any) => !r?.archived) : [];
    const scheduled = rules.filter((r: any) => isScheduledOn(r, dow) && !r?.excludedFromScore);
    const todayLogs = Array.isArray(habitLog) ? habitLog.filter((e: any) => e.dateKey === todayKey) : [];
    // Emoji-SENSITIVE normalize(title) key, matching the write path + scoreBreakdown
    // (Greptile #214): "Run" and "Run 🏃" stay distinct, and a row reads done here iff
    // the score counts it done. See selectTodaysCompletionCounts.
    const counts = selectTodaysCompletionCounts(todayLogs);
    return scheduled
      .filter((rule: any) => !isHabitCompleteTodayWith(rule, counts))
      .map((rule: any) => ({ title: String(rule?.title || '').trim(), id: rule?.id as string | undefined }));
  }, [recurringRules, habitLog, todayKey]);

  // ── NEX-199: Today's Habits list contract ──────────────────────────────────
  // Cap the visible rows, hide only completed overflow (never a live one), keep
  // natural order (a fresh capture is prepended by addRecurringRule = slot 0; no
  // completion re-sort, so checking off never moves the list). A sticky set keeps
  // a row visible once shown this session, so completing it can't make it vanish;
  // the collapse re-applies on the next Home open / new day (reset below).
  const scheduledTodayHabits = useMemo(() => {
    const dow = new Date().getDay();
    return (Array.isArray(recurringRules) ? recurringRules : []).filter(
      // Exclude archived (retired) rules so they can't reappear in / be logged
      // from Today's Habits, matching incompleteHabitsToday + the score selectors
      // (Greptile #214). `archived` is always falsy today (no archive UI yet).
      (r: any) => isScheduledOn(r, dow) && !r?.excludedFromScore && !r?.archived,
    );
  }, [recurringRules, todayKey]);

  // NEX-199: precompute today's completion count per habit key ONCE (Greptile
  // #214 perf) so isHabitCompleteToday and the row both do an O(1) lookup instead
  // of re-scanning all of habitLog per habit on every render. Keyed on the
  // canonical emoji-SENSITIVE normalize(title) (write path + scoreBreakdown
  // convention) so "Run"/"Run 🏃" stay distinct and the row agrees with the score.
  const todayCompletionCounts = useMemo(() => {
    const logs = Array.isArray(habitLog) ? habitLog.filter((e: any) => e?.dateKey === todayKey) : [];
    return selectTodaysCompletionCounts(logs);
  }, [habitLog, todayKey]);

  const isHabitCompleteToday = useCallback(
    (rule: any) => isHabitCompleteTodayWith(rule, todayCompletionCounts),
    [todayCompletionCounts],
  );

  // NEXUS-5 (Home main-thread hang): the habit-row chip label used to call
  // computeHabitProgress + computeLifetimeReps INLINE per row on EVERY render
  // (rowsToRenderHabits.map). Both selectors scan the unbounded, append-only
  // habitLog, so the row block was O(visibleRows × habitLog) on every re-render
  // — and Home re-renders constantly (whole-store subscription + the 60s `now`
  // timer + modals + focus). Precompute the chip label per rule ONCE per data
  // change here (Map<rule.id, label>); the row then does an O(1) lookup.
  //
  // Behavior-preserving: weekStart/now are frozen at compute time, but
  // computeHabitProgress reduces period.end to a day key (startOfDay /
  // getLocalDateKey) and tallies logs by dateKey (habit-rollup.ts), so the
  // [weekStart, now] window is day-grained — an intra-day change in `now` never
  // changes the counted logs. The memo is therefore keyed on todayKey, NOT
  // `now`; do NOT add `now` to the deps or it would re-introduce the per-60s
  // rescans. Built over the full scheduledTodayHabits (rowsToRenderHabits is
  // always a subset) so both the capped and expanded views read from it.
  const habitProgressLabels = useMemo(() => {
    // NEX-190 cumulative weekly window — computed ONCE per pass, not per rule.
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // back to Sunday
    weekStart.setHours(0, 0, 0, 0);
    const period = { start: weekStart, end: now };
    const m = new Map<string, string>();
    for (const rule of scheduledTodayHabits) {
      // NEX §1.5 Law B: the cumulative chip numerator counts capped completions across
      // ALL scheduled days this week REGARDLESS of pause — a rep logged on a paused day
      // is still earned and must never be subtracted. computeWeeklyReps deliberately
      // ignores pauseMode (unlike computeHabitProgress, whose pause-excluded `completed`
      // is correct only for the % / debrief surfaces, NOT this additive chip).
      const weeklyReps = computeWeeklyReps(rule, period, habitLog);
      const lifetimeReps = computeLifetimeReps(rule, habitLog);
      // Intrinsic weekly cadence (stable denominator), not days-elapsed. Derive
      // from daysOfWeek.length to match computeWeeklyReps, which treats an empty
      // daysOfWeek as unscheduled (0 reps) — not daily — so the chip's numerator
      // (weeklyReps) and denominator stay consistent.
      const cadencePerWeek = (Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek.length : 0)
        * (rule.timesPerDay || 1);
      m.set(rule.id, weeklyProgressLabel(weeklyReps, cadencePerWeek, lifetimeReps));
    }
    return m;
  }, [scheduledTodayHabits, habitLog, todayKey]);

  const [showAllHabits, setShowAllHabits] = useState(false);

  // Reset the sticky collapse on each Home focus + new day. A mounted tab won't
  // remount, so a memo can't see "Home opened" — bump an epoch on focus and reset
  // the ref synchronously (keyed) before the selector reads it this render.
  const [habitFocusEpoch, setHabitFocusEpoch] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setHabitFocusEpoch((e) => e + 1);
      setShowAllHabits(false);
    }, []),
  );
  const stickyVisibleHabitIds = useRef<Set<string>>(new Set());
  const habitStickyResetKey = `${habitFocusEpoch}:${todayKey}`;
  const lastHabitStickyResetKey = useRef(habitStickyResetKey);
  if (lastHabitStickyResetKey.current !== habitStickyResetKey) {
    lastHabitStickyResetKey.current = habitStickyResetKey;
    stickyVisibleHabitIds.current = new Set();
  }

  const { visible: visibleHabits, hiddenCount: hiddenHabitCount } = selectTodaysHabits(
    scheduledTodayHabits,
    { isComplete: isHabitCompleteToday, sticky: stickyVisibleHabitIds.current },
  );
  const rowsToRenderHabits = showAllHabits ? scheduledTodayHabits : visibleHabits;
  // Pin currently-visible rows so a row completed while visible holds its slot.
  const visibleHabitIdsKey = visibleHabits.map((r: any) => r.id).join(',');
  useEffect(() => {
    for (const r of visibleHabits) stickyVisibleHabitIds.current.add(r.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleHabitIdsKey]);

  const generateMorningBrief = async () => {
    if (briefGeneratingRef.current) return;
    briefGeneratingRef.current = true;
    setBriefLoading(true);
    try {
      const liveState = (useAppState as any).getState() as any;
      const todayStr = todayKey;
      // Check if already generated today
      if (liveState.morningBriefDate === todayStr && Array.isArray(liveState.morningBriefItems) && liveState.morningBriefItems.length > 0) {
        setMorningBrief(sanitizeInsightItems(liveState.morningBriefItems));
        return;
      }

      const ctx = buildAIContext();

      const raw = await chatCompletion([
        { role: 'system', content: AI_PERSONA + MORNING_BRIEF_SUFFIX },
        { role: 'user', content: ctx.contextString + ' Generate the morning brief.' },
      ], { model: MODELS.MORNING_BRIEF });
      const cleaned = raw.replace(/```[a-z]*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const sanitized = sanitizeInsightItems(parsed);
        setMorningBrief(sanitized);
        // Persist
        (useAppState as any).setState({ morningBriefItems: sanitized, morningBriefDate: todayStr });
      }
    } catch {
      // Fallback brief
      const liveState = (useAppState as any).getState() as any;
      const todayTasks = (liveState.dailyTasks ?? {})[todayKey] ?? [];
      const pending = todayTasks.filter((t: any) => !t.completed).length;
      const fallback = [];
      if (pending > 0) fallback.push(`You have ${pending} task${pending > 1 ? 's' : ''} to complete today.`);
      const activeCount = (liveState.recurringRules ?? []).filter((r: any) => !r?.excludedFromScore).length;
      if (activeCount > 0) fallback.push(`${activeCount} habits to log. Start with the hardest one.`);
      fallback.push('Set your intention if you haven\'t already.');
      setMorningBrief(fallback);
    } finally {
      setBriefLoading(false);
      briefGeneratingRef.current = false;
    }
  };

  useEffect(() => {
    const liveState = (useAppState as any).getState() as any;
    if (liveState.morningBriefDate === todayKey && Array.isArray(liveState.morningBriefItems) && liveState.morningBriefItems.length > 0) {
      setMorningBrief(sanitizeInsightItems(liveState.morningBriefItems));
    } else {
      generateMorningBrief();
    }
  }, [todayKey]);

  // NEX-perf: below-the-fold sections mount after first paint (see the ceremony
  // effect above). Above-the-fold (ring + win + habits) mounts instantly.
  const [belowFoldReady, setBelowFoldReady] = useState(false);

  // NEX-perf: the minute tick now lives in the two leaf time-widgets (EventsLeft
  // / HorizonUpNext, via useMinuteClock), so the full Home no longer re-renders
  // every 60s. This parent `now` is kept ONLY for `returnOneThing` (the
  // collapsed return/pause CTA), and the interval runs ONLY in collapsed mode —
  // a small tree — so the expensive full Home never ticks while the return CTA
  // still updates when it's the one on screen.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    // Only the collapsed return/pause surface consumes `now` (via nextEvent →
    // returnOneThing), and it's a small tree — so the interval (which just forces
    // a periodic re-render to keep the CTA fresh) runs ONLY in collapsed mode.
    // The full Home never ticks. nextEvent reads the clock at RENDER time when
    // collapsed (below), so the first collapsed render is already fresh — the
    // interval only keeps it current as time passes.
    if (!collapsedHome) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [collapsedHome]);

  useEffect(() => {
    if (pendingLevelUp) {
      setLevelUpLevel(pendingLevelUp);
      setShowLevelUpModal(true);
      setShowConfetti(true);
      haptic('streakMilestone');
      levelUpScale.setValue(0.5);
      levelUpOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(levelUpScale, { toValue: 1, friction: 4, tension: 80, useNativeDriver: true }),
        Animated.timing(levelUpOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
      clearPendingLevelUp();
      setTimeout(() => setShowConfetti(false), 5000);
    }
  }, [pendingLevelUp]);

  useEffect(() => {
    if (pendingBadgeUnlock) {
      // NEX-220: show the badge's CURRENT copy/icon from BADGE_DEFINITIONS (persisted
      // badges keep old copy), so a reframed badge never toasts the old streak text/🔥.
      const def = BADGE_DEFINITIONS.find((d) => d.id === pendingBadgeUnlock.id);
      setBadgeToastData(def ? { ...pendingBadgeUnlock, ...def } : pendingBadgeUnlock);
      setShowBadgeToast(true);
      haptic('streakMilestone');
      // §9.6: the badge toast is a transient, pointerEvents-none overlay, so
      // VoiceOver won't read it — announce the unlock once, at the transition.
      const badgeName = def?.title ?? pendingBadgeUnlock.title;
      if (badgeName) announce(`Badge unlocked. ${badgeName}.`);
      badgeToastOpacity.setValue(0);
      Animated.sequence([
        Animated.timing(badgeToastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.delay(3000),
        Animated.timing(badgeToastOpacity, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]).start(() => {
        setShowBadgeToast(false);
        setBadgeToastData(null);
        // NEX-220: advance the queue only after this toast fully finishes, so
        // multiple badges unlocked in one log surface one at a time instead of
        // overlapping. Draining here (not synchronously) is what sequences them.
        clearPendingBadgeUnlock();
      });
    }
  }, [pendingBadgeUnlock]);

  useEffect(() => {
    // NEX-207: don't record a daily score on a paused day — a planned break is
    // not a low/"Drifting" day. The day simply has no scoreHistory key; debrief
    // and averages exclude it (and render "Paused", not 0, for an all-paused
    // window). Paused-ness is derived from pauseMode, so no extra persisted field.
    if (recordDailyScore && !isPausedOn(todayKey, pauseMode)) {
      recordDailyScore(todayKey, todayScore);
    }
  }, [todayScore, todayKey, pauseMode]);

  // NEX-124: first_alignment_score_seen — fires once, the first time Home (and
  // its AlignmentScoreRing) renders post-activation for this install. Gated on
  // activatedDate so we never emit a pre-activation phantom band (and so
  // hours_since_activation is real); activatedDate is in the deps so the emit
  // fires as soon as it populates. Claim the set-once guard synchronously before
  // the async trackEvent so a re-render can't double-emit. score_band is the
  // first-paint value by design.
  useEffect(() => {
    // NEX-191: in return mode the alignment ring is hidden (a low score on return
    // reads as a verdict on the lapse — Law C), so don't mark/emit "saw the score."
    if (firstAlignmentScoreSeenFired || !activatedDate || collapsedHome) return;
    markFirstAlignmentScoreSeen?.();
    const hoursSinceActivation = Math.max(
      0,
      Math.round((Date.now() - new Date(activatedDate).getTime()) / (1000 * 60 * 60)),
    );
    void trackEvent('first_alignment_score_seen', {
      score_band: scoreBandKey(todayScore),
      hours_since_activation: hoursSinceActivation,
    });
    // todayScore is in deps to avoid a stale closure, but the set-once flag means
    // it's only ever read on the first eligible render — the first-paint band is
    // the intended semantic (what the user first sees).
  }, [firstAlignmentScoreSeenFired, activatedDate, todayScore, collapsedHome]);

  useEffect(() => {
    try {
      const liveState = (useAppState as any).getState() as any;
      const watchData = buildWatchData({
        recurringRules: liveState.recurringRules ?? [],
        habitLog: liveState.habitLog ?? [],
        habitStreaks: liveState.habitStreaks ?? {},
        pinnedHabits: liveState.pinnedHabits ?? [],
        computeDailyScore: liveState.computeDailyScore,
        totalXP: liveState.totalXP ?? 0,
        softMode: liveState.softMode === true,
      });
      sendDataToWatch(watchData);
    } catch {}
    // NEX-219: softMode in deps so toggling Soft Mode immediately re-sends the watch payload.
  }, [habitLog, totalXP, todayScore, recurringRules, pinnedHabits, habitStreaks, softMode]);

  // NEX-48 Phase 4: scoreTrend useMemo moved to /this-week (the only screen
  // that renders SCORE TREND now).

  // Show morning intention modal once per day before 1pm if not set
  useEffect(() => {
    const hour = new Date().getHours();
    const notSetToday = morningIntentionDate !== todayKey;
    if (notSetToday && hour < 13) {
      const timer = setTimeout(() => setShowIntentionModal(true), 800);
      return () => clearTimeout(timer);
    }
  }, []);

  // Auto-generate weekly reflection (regenerate on Sundays, auto-gen once per week otherwise)
  useEffect(() => {
    const sundayKey = getThisSundayKey();
    if (isSunday() && weeklyReflectionDate !== sundayKey) {
      generateWeeklyReflection();
    } else if (!weeklyReflection && !reflectionLoading) {
      generateWeeklyReflection();
    }
    if (isSunday() && weeklyWinsDate !== sundayKey) {
      setTimeout(() => setShowWinsModal(true), 1500);
    }
  }, []);

  // NEX-45/NEX-44: widened from today-only to today + tomorrow so the widget
  // bridge can surface tomorrow's first event at 12:01am. NEX-44 routes this
  // through the multi-calendar window fetcher: Apple EventKit plus connected
  // Google/Outlook accounts all land in one normalized stream.
  const fetchTodayAppleEvents = async () => {
    try {
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const endOfTomorrow = new Date();
      endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
      endOfTomorrow.setHours(23, 59, 59, 999);
      const startOfTomorrow = new Date();
      startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
      startOfTomorrow.setHours(0, 0, 0, 0);
      const events = await fetchConnectedCalendarEventsWindow({
        startDate: startOfToday,
        endDate: endOfTomorrow,
      });
      const mapped = events
        .map((e: any) => ({
          id: e.id,
          title: e.title,
          startISO: e.startISO ?? e.startDate,
          endISO: e.endISO ?? e.endDate,
          provider: e.provider,
          cal: e.cal,
        }))
        .sort((a: any, b: any) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime());
      const todayCutoff = startOfTomorrow.getTime();
      setAppleEvents(mapped.filter((e: any) => new Date(e.startISO).getTime() < todayCutoff));
      const liveState = (useAppState as any).getState();
      if (typeof liveState.setAppleEventsWindow === 'function') {
        liveState.setAppleEventsWindow(mapped);
      }
    } catch { /* silent */ }
  };

  // Silently auto-map habits to goals using AI — runs once when goals exist
  const autoMapHabitsToGoals = useCallback(async () => {
    try {
      const liveState = (useAppState as any).getState() as any;
      const currentPillars: any[] = Array.isArray(liveState.pillars) ? liveState.pillars : [];
      if (currentPillars.length === 0) return;

      // Collect all habit/event titles from recurring rules + connected calendars
      const recurringTitles: string[] = Array.isArray(liveState.recurringRules)
        ? liveState.recurringRules.map((r: any) => r.title).filter(Boolean)
        : [];

      // Fetch recent connected calendar event titles.
      let calendarTitles: string[] = [];
      try {
        const start = new Date(); start.setDate(start.getDate() - 7);
        const end = new Date(); end.setDate(end.getDate() + 1);
        const events = await fetchConnectedCalendarEventsWindow({ startDate: start, endDate: end });
        const seen = new Set<string>();
        events.forEach((e: any) => {
          const t = (e.title ?? '').trim();
          if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); calendarTitles.push(t); }
        });
      } catch { /* silent */ }

      const allHabits = [...new Set([...recurringTitles, ...calendarTitles])];
      if (allHabits.length === 0) return;

      // Check if we already have mappings for all current goals — skip if so
      const existingMap: Record<string, string[]> = liveState.goalHabitMap ?? {};
      const unmappedGoals = currentPillars.filter((p: any) => {
        const alreadyMapped = Object.values(existingMap).some((ids: string[]) => ids.includes(p.id));
        return !alreadyMapped;
      });
      if (unmappedGoals.length === 0) return;

      const goalsText = unmappedGoals.map((p: any) => `- ID: ${p.id} | Title: ${p.title} | Category: ${p.category ?? 'BUSINESS'}`).join('\n');
      const habitsText = allHabits.map((h) => `- ${h}`).join('\n');

      const content = await chatCompletion(
        [{
          role: 'user',
          content: `You are mapping habits and calendar activities to life goals.

GOALS:
${goalsText}

HABITS / CALENDAR ACTIVITIES:
${habitsText}

Rules:
- Map a habit to a goal ONLY when the connection is direct, obvious, and would be apparent to a stranger reading both side by side. Examples of valid links: "Morning run" → "Stay strong (PERSONAL)"; "Read Mantra" → a spiritual or mental-clarity goal.
- Indirect or speculative connections do NOT count. "Yoga → better business decisions" is INVALID. "Clean eating → wealth" is INVALID. Do not infer second-order benefits.
- Most habits map to 0 or 1 goal. Rarely 2. Never more.
- When in doubt, map to NOTHING. Returning an empty goalIds array is preferable to a wrong link.

Return JSON: { "mappings": [{ "habit": "...", "goalIds": ["..."] }, ...] }
Use exact goal IDs from the list above.`
        }],
        { model: MODELS.QUICK_PARSE, response_format: { type: 'json_object' } }
      );
      if (!content) return;
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed.mappings)) return;

      // Apply mappings to state. NEX-76: cap each habit's auto-applied
      // goalIds at 1 — soft enforcement on top of the prompt rules
      // ("Most habits map to 0 or 1 goal"). If the LLM ignores the
      // cap and returns multiple, only the first is taken. Prevents
      // multi-mandate over-broadening like Yoga showing up under
      // both "Build Wealth" AND a wellness mandate from a single call.
      const newMap = { ...existingMap };
      parsed.mappings.forEach((m: any) => {
        if (!m.habit || !Array.isArray(m.goalIds)) return;
        const key = String(m.habit).trim().toLowerCase();
        const validIds = m.goalIds.filter((id: any) => typeof id === 'string');
        if (validIds.length === 0) return;
        const cappedIds = validIds.slice(0, 1);
        const existing = newMap[key] ?? [];
        const merged = [...new Set([...existing, ...cappedIds])];
        if (merged.length > 0) newMap[key] = merged;
      });
      (useAppState as any).setState({ goalHabitMap: newMap });
    } catch { /* silent — non-critical */ }
  }, []);


  const generateWeeklyReflection = async () => {
    try {
      const liveState = (useAppState as any).getState() as any;
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentLogs = Array.isArray(liveState.habitLog)
        ? liveState.habitLog.filter((e: any) => e.timestamp >= sevenDaysAgo) : [];
      const habitSummary = recentLogs.length > 0
        ? [...new Set(recentLogs.map((e: any) => e.habitTitle))].join(', ')
        : 'No habits logged this week.';
      const pillarsText = Array.isArray(liveState.pillars)
        ? liveState.pillars.map((p: any) => `${p.title} (${p.completed ? 'done' : 'active'})`).join(', ') : '';

      // Build data points for richer, more grounded reflection
      const weekScores = Object.entries(liveState.dailyScores ?? {})
        // NEX-207: exclude paused days from the AI reflection's score data.
        .filter(([k]) => new Date(k).getTime() >= sevenDaysAgo && !isPausedOn(k, liveState.pauseMode))
        .map(([, v]) => v as number);
      const avgScore = weekScores.length > 0 ? Math.round(weekScores.reduce((a, b) => a + b, 0) / weekScores.length) : null;
      // NEX-221: cumulative progress (lifetime reps), not a breakable streak (Law B).
      // Top 3 reps over the active set (non-excluded, non-archived — app-state.ts:1804/2532)
      // so the prompt's "cumulative progress by name" instruction is grounded in real data.
      // LIFETIME cumulative reps for the AI reflection — DELIBERATELY emoji-/rename-
      // tolerant (normalize+stripEmoji on both sides) so a title that gained or lost
      // its display emoji over time ("Meditate 🧘" rule vs older "Meditate" logs)
      // still sums its lifetime total instead of dropping to 0. This is intentionally
      // a LOOSER key than today's-completion (which keys on the canonical
      // emoji-SENSITIVE normalize(title) so "Run"/"Run 🏃" stay distinct — Greptile
      // #214). Different metric, different key: cross-time totals vs same-day done.
      const repKey = (t: any) => normalize(stripEmoji(String(t || '')));
      const repCounts: Record<string, number> = {};
      for (const e of (Array.isArray(liveState.habitLog) ? liveState.habitLog : [])) {
        const k = repKey(e?.habitTitle);
        if (k) repCounts[k] = (repCounts[k] || 0) + 1;
      }
      const activeRules = (liveState.recurringRules ?? []).filter((r: any) => !r?.excludedFromScore && !r?.archived);
      const topReps = activeRules
        .map((r: any) => ({ t: r.title, n: repCounts[repKey(r.title)] || 0 }))
        .filter((x: any) => x.n > 0)
        .sort((a: any, b: any) => b.n - a.n || a.t.localeCompare(b.t)) // deterministic tiebreak
        .slice(0, 3);

      setReflectionLoading(true);
      const rawContent = await chatCompletion([
        {
          role: 'system',
          content: AI_PERSONA + ` Return ONLY a JSON object, no markdown: {"work":8,"health":7,"mind":6,"family":8,"spirit":7,"well":"1-2 sentences what went well","hard":"1 sentence what was hard","focus":"1 sentence next week focus"} Scores 1-10 based on real data. Reference specific habit patterns, scores, and cumulative progress (lifetime reps) by name. If a habit clearly resumed after a gap, you may frame it as "back after a pause"; never as a lost streak, a broken streak, or a miss.`,
        },
        {
          role: 'user',
          content: `Name: ${liveState.userProfile?.name ?? 'Unknown'}
Habits this week: ${habitSummary}
${avgScore !== null ? `Avg score: ${avgScore}/100` : ''}
${topReps.length ? `Lifetime reps: ${topReps.map((x: any) => `${x.t} (${x.n})`).join(', ')}` : ''}
Weekly wins: ${Array.isArray(liveState.weeklyWins) ? liveState.weeklyWins.filter(Boolean).join(', ') : 'none'}
Mandates: ${pillarsText}

Return ONLY the JSON object. Reference the real data. Sound like a sharp friend.`,
        },
      ], { model: MODELS.WEEKLY_REVIEW });
      if (rawContent) {
        const cleaned = rawContent.replace(/```[a-z]*/g, '').replace(/```/g, '').trim();
        setWeeklyReflection(cleaned);
      }
    } catch { /* silent */ } finally { setReflectionLoading(false); }
  };

  useEffect(() => {
    fetchTodayAppleEvents();
    autoMapHabitsToGoals();
    // Check for due horizon review (delay slightly so app feels settled)
    setTimeout(() => {
      const liveState = (useAppState as any).getState();
      const due = getDueReview(liveState.lastReviewDates || {});
      if (due) setDueReview(due);
    }, 2000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        fetchTodayAppleEvents();
        autoMapHabitsToGoals();
      }
    });
    return () => sub.remove();
  }, []);

  // Merged today events. NEX-perf: memoize and sort a COPY. The old code rebuilt
  // this array every render (so `allTodayEvents` and the whole nextEvent /
  // widgetEvents chain recomputed every render) AND sorted `orbitDays[todayKey]`
  // — store state — in place during render. Sorting a copy is behavior-identical
  // (the store's write paths already persist sorted order) and removes both the
  // per-render churn and the render-phase mutation.
  const orbitTodayEvents: any[] = useMemo(() =>
    [...(orbitDays?.[todayKey] ?? [])].sort(compareByStartISO),
    [orbitDays, todayKey]
  );
  const allTodayEvents = useMemo(() =>
    [...orbitTodayEvents, ...appleEvents]
      .filter((e, idx, arr) =>
        arr.findIndex((x) =>
          x.title === e.title && Math.abs(new Date(x.startISO).getTime() - new Date(e.startISO).getTime()) < 60000
        ) === idx
      )
      .sort((a: any, b: any) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime()),
    [orbitTodayEvents, appleEvents]
  );

  // Consumed ONLY by returnOneThing (the collapsed return/pause CTA). Read the
  // clock at render time when collapsed so the first collapsed render can't name
  // an already-passed event (the gated interval re-renders this every 60s to
  // keep it fresh); in normal Home `now` is unused here and the value isn't shown.
  const nextEvent = useMemo(() =>
    allTodayEvents.find((e: any) => new Date(e.startISO).getTime() > (collapsedHome ? Date.now() : now)) ?? null,
    [allTodayEvents, now, collapsedHome]
  );
  // NEX-perf: events-left counts moved into the <EventsLeftCard> leaf (owns the
  // minute tick). `nextEvent` above stays for `returnOneThing` only.
  const pendingInbox = Array.isArray(inbox) ? inbox.filter((t: any) => t.status !== 'ARCHIVED' && !t.completed).length : 0;

  // NEX-191: the single highest-signal thing to surface on return, and the
  // mandate-continuity line. Oldest open inbox item ("most rotting") is the inbox
  // candidate. mandateText: anchor → first mandate → a calm continuity fallback.
  const returnOneThing = useMemo(() => {
    // Active inbox only: exclude archived, completed, AND triagedSkip (a skipped
    // item is intentionally absent from the active inbox — selectActiveInbox /
    // selectSkippedInbox — so it must never resurface as the return "one thing").
    const open = Array.isArray(inbox)
      ? inbox.filter((t: any) => t.status !== 'ARCHIVED' && !t.completed && !t.triagedSkip)
      : [];
    const oldest = [...open].sort((a: any, b: any) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0))[0];
    const inboxTop = oldest ? { title: String(oldest.title || '').trim(), id: oldest.id as string | undefined } : null;
    return pickOneThing({
      habits: incompleteHabitsToday,
      nextEvent: nextEvent ? { title: nextEvent.title, id: (nextEvent as any).id } : null,
      inboxTop,
    });
  }, [inbox, incompleteHabitsToday, nextEvent]);
  const returnMandateText =
    (userProfile?.anchor && String(userProfile.anchor).trim()) ||
    (Array.isArray(pillars) && pillars[0]?.title && String(pillars[0].title).trim()) ||
    RETURN_FALLBACK_MANDATE;

  // Today + tomorrow event window for the widget. Swift filters by
  // startISO > now() at render time, so writing tomorrow's events
  // alongside today's lets the widget surface the next morning's
  // first event at 12:01am without waiting for an app launch.
  // appleEvents is today-only (the fetch only queries today); orbitDays
  // for tomorrow is checked from the live store so user-created
  // tomorrow events flow through too.
  const widgetEvents = useMemo(() => {
    const tomorrowKeyLocal = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const tomorrowOrbit: any[] = (orbitDays?.[tomorrowKeyLocal] ?? []) as any[];
    return [...allTodayEvents, ...tomorrowOrbit].map((e: any) => ({
      title: e.title ?? '',
      startISO: e.startISO ?? '',
    })).filter((e) => e.title && e.startISO);
  }, [allTodayEvents, orbitDays, todayKey]);

  const widgetEventsSig = useMemo(
    () => widgetEvents.map((e) => `${e.title}|${e.startISO}`).join(','),
    [widgetEvents],
  );

  useEffect(() => {
    try {
      // Use reactive values from useAppState() — NOT liveState snapshots.
      // Guard: wait until the store is hydrated (Supabase sync done). Widened
      // for the widget daily-score: an intention-only (or wisdom-only) user
      // with zero habits still has renderable widget content — but an
      // un-hydrated store has neither, so the cold-launch protection holds.
      const activeRules = Array.isArray(recurringRules)
        ? recurringRules.filter((r: any) => !r.archived)
        : [];
      const intentionToday = morningIntentionDate === todayKey && !!morningIntention;
      const wisdomToday =
        dailyWisdomDate === todayKey &&
        Array.isArray(dailyWisdomQuotes) &&
        dailyWisdomQuotes.length > 0;
      if (activeRules.length === 0 && !intentionToday && !wisdomToday) return;
      // Pull orbit data from store for items not subscribed at component level
      const liveState = (useAppState as any).getState() as any;
      const widgetData = buildWidgetData({
        recurringRules,                          // reactive
        habitLog: Array.isArray(habitLog) ? habitLog : [],  // reactive array of entries
        habitStreaks: habitStreaks ?? {},         // reactive
        pinnedHabits: pinnedHabits ?? [],        // reactive
        totalXP: totalXP ?? 0,                  // reactive
        inbox: inbox ?? [],                      // reactive
        recurringToDos: liveState.recurringToDos ?? [],     // not subscribed — ok as snapshot
        dailyTasks: dailyTasks ?? {},                       // reactive
        events: widgetEvents,
        softMode,                                           // reactive (NEX-219)
        morningIntention: morningIntention ?? null,         // reactive (widget score)
        morningIntentionDate: morningIntentionDate ?? null, // reactive
        dailyWisdomQuotes: Array.isArray(dailyWisdomQuotes) ? dailyWisdomQuotes : [],
        dailyWisdomDate: dailyWisdomDate ?? '',
        wisdomQuoteCount: typeof wisdomQuoteCount === 'number' ? wisdomQuoteCount : 3,
      });
      updateWidgetData(widgetData);
    } catch {}
    // NEX-219: softMode in deps so toggling Soft Mode immediately re-writes the widget snapshot.
    // Widget daily-score: intention + wisdom in deps so setting today's win (ANY writer,
    // incl. consumePendingMondayIntention) or generating today's quotes re-writes too.
  }, [habitLog, totalXP, todayScore, recurringRules, pinnedHabits, habitStreaks, inbox, widgetEventsSig, dailyTasks, softMode, todayKey, morningIntention, morningIntentionDate, dailyWisdomQuotes, dailyWisdomDate, wisdomQuoteCount]);
  // Only count active goals (BUSINESS + PERSONAL) — exclude VISION which are long-horizon
  const activePillars = Array.isArray(pillars)
    ? pillars.filter((p: any) => (p.category ?? 'BUSINESS').toUpperCase() !== 'VISION')
    : [];
  const totalPillars = activePillars.length;
  const completedPillars = activePillars.filter((p: any) => p.completed).length;
  const name = userProfile?.name ?? '';
  // `anchor` derivation moved to align.tsx.

  const todayIntention = morningIntentionDate === todayKey ? morningIntention : null;
  const todayNightly = nightlyForwardDate === todayKey ? nightlyForward : null;

  // Score breakdown modal
  const [showScoreModal, setShowScoreModal] = useState(false);
  // Habit management lives next to the daily-checkbox row — both stay on Home.
  // Modal JSX is extracted into ManageHabitsModal (src/components/manage-habits-modal.tsx).
  const [showHabitsModal, setShowHabitsModal] = useState(false);
  const [dueReview, setDueReview] = useState<string | null>(null);

  // NEX-164: no-habit guided path. When an onboarding first-action intent is
  // pending but there is no habit to log today (Pulse-empty practice, or the
  // committed habits aren't actionable today), open the add-habit modal so the
  // user can create one, then log it to complete activation. Keyed on
  // "no actionable habit today" rather than the step-4 label guess, so a
  // mis-guessed 'complete_habit' with nothing to log still recovers here.
  // NEX-193: the guided first-habit flow (which set firstActionIntent and
  // opened the add-habit modal here) was replaced by the win-first onboarding.
  // A firstActionIntent can still be persisted/cloud-merged for existing
  // old-flow users; acting on it would resurface the removed add-habit CTA, so
  // clear the stale value once on mount instead of opening the modal.
  useEffect(() => {
    const s = (useAppState as any).getState();
    if (s.firstActionIntent) s.setFirstActionIntent?.(null);
  }, []);

  // Top streaks — show any habit with streak >= 2
  const topStreaks: { title: string; days: number }[] = Object.entries(habitStreaks ?? {})
    .filter(([, days]) => (days as number) >= 2)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 3)
    .map(([title, days]) => ({ title, days: days as number }));

  // Dead weight detection — inbox items not touched in 14+ days
  // NEX-201: the few oldest inbox items awaiting a decision, oldest-first and
  // capped (selector owns the 14-day threshold + display cap). Calm + scarce —
  // aging is conveyed by order, not a red day-counter (§1.5 Law C). Memoized so
  // an unrelated Zustand mutation doesn't re-run the map/filter/sort chain;
  // todayKey in deps refreshes it at the day boundary (matches leadTimeRollup).
  const deadWeightItems = useMemo(
    () => selectCutOrCommitItems(inbox, Date.now()),
    [inbox, todayKey],
  );

  // NEX-198 (N-1): timed inbox reminders whose due time has arrived and that
  // aren't resolved — pinned on Home until done (the app IS the persistent
  // reminder). Exclude the just-captured echo and the Cut-or-Commit dead-weight
  // items so one item never shows twice. deadWeightItems is a memoized selector
  // (stable ref); Date.now() is fine as a render-time input — the OS alert fires
  // independently and the list refreshes on the next inbox change.
  const dueReminders = useMemo(() => {
    const exclude = new Set<string>(deadWeightItems.map((t: any) => String(t.id)));
    if (showCaptureEcho && justCaptured?.id) exclude.add(String(justCaptured.id));
    return selectDueReminders(inbox, Date.now(), exclude);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox, deadWeightItems, showCaptureEcho, justCaptured]);

  // NEX-162: lead-time actions that are due/overdue surface as a Home card.
  const leadTimeRollup = useMemo(
    () => selectLeadTimeRollup(leadTimeActions, todayKey),
    [leadTimeActions, todayKey],
  );

  // Weekly wins for this week
  const thisSundayKey = getThisSundayKey();
  const currentWeeklyWins: string[] = weeklyWinsDate === thisSundayKey ? (weeklyWins ?? []) : [];

  // NEX-165: progressive disclosure for new users. Weekly Debrief is the one
  // always-on Home section that renders a dataless shell on day 1 (empty score
  // chart + 0% stat tiles). Hide it until daysSinceActivation === 6 — the
  // zero-indexed "Day 7" mark where the Getting Started nudge already promises
  // "your first Weekly Debrief is ready." Established users (activatedDate
  // older than 6 days, or null for pre-tracking/returning installs) are
  // unaffected: isNewUser is false, so the section renders exactly as before.
  // The flip happens only on a day boundary, so the section appears on a fresh
  // open and rides the existing once-per-day first-open fade — no new motion.
  // daysSinceActivation mirrors the Getting Started block's inline math.
  const daysSinceActivation = activatedDate
    ? Math.floor((Date.now() - new Date(activatedDate).getTime()) / 86400000)
    : null;
  // Guard against activateUser re-stamping activatedDate. A returning user
  // whose date the migration left null (no habit log to back-date from —
  // app-state.ts ~2508) gets activatedDate = now on their next Anchor edit
  // (align.tsx saveAnchor → activateUser, which stamps null dates). Without
  // this guard that established user would be misread as day 0 and lose the
  // Weekly Debrief for six days, regressing the "established Home unchanged"
  // contract. scoreHistory accrues ~1 entry per day the app is opened, so a
  // real track record (>7 days) is never a genuine first-week user, whose
  // history starts empty at activation. Reveal stays day-6-only; this only
  // prevents false-positive new-user classification.
  const hasTrackRecord = Object.keys(scoreHistory ?? {}).length > 7;
  const isNewUser =
    daysSinceActivation !== null && daysSinceActivation < 6 && !hasTrackRecord;
  const showWeeklyDebrief = !isNewUser;

  // Weekly debrief modal
  // NEX-48 Phase 4.1: showDebriefModal state retired — Weekly Debrief tap
  // now pushes /this-week instead of opening a modal.

  // THIS WEEK KPIs — restored per owner request (2026-06-24). NEX-217 had
  // replaced the backward 7-day debrief (per-day score bars + habit/score/task
  // KPIs) with a forward-led additive card, since a low week read as a "you
  // failed" verdict (Law B/C). The owner explicitly wants the at-a-glance
  // weekly trend back and is the sign-off. Kept as bounded as possible: the low
  // tier is textMuted ("quiet"), never state.error red; no breakable-streak
  // surface is reintroduced; the window is a rolling 7 days so the tiles are
  // stable day-to-day. The per-day CHART is no longer computed here — the
  // ScoreTrendChart windows the full score history itself. This memo now feeds
  // only the three KPI tiles under it, which are the route to /this-week.
  const weeklyStats = useMemo(() => {
    const now = new Date();
    // Rolling 7 days back from today (inclusive) — same shape every day, no
    // Sunday-AM reset to a single bar. Built in local calendar-day-key space via
    // addDaysToKey (NOT fixed 24h subtraction, which double-counts or skips a
    // local date across a DST boundary). Horizons uses its own Sun–Sat calendar
    // week (horizon-review.tsx getPeriodRange); two surfaces, two windows.
    const weekDayKeys: string[] = [];
    for (let i = 6; i >= 0; i--) {
      weekDayKeys.push(addDaysToKey(todayKey, -i));
    }

    // Schedule-aware habit completion across the window via the shared selector
    // (honors timesPerDay, schedule, createdAt clamp, and paused days). Period
    // ends at "now" so the current partial day only counts what has elapsed.
    // Exclude archived + excludedFromScore rules so the HABITS % agrees with the
    // visible habit list and the daily score (same predicate as the score path).
    const allRules = Array.isArray(recurringRules)
      ? recurringRules.filter((r: any) => !r?.archived && !r?.excludedFromScore)
      : [];
    const logs = Array.isArray(habitLog) ? habitLog : [];
    const periodStart = new Date(weekDayKeys[0] + 'T00:00:00');
    let totalPossible = 0;
    let totalCompleted = 0;
    allRules.forEach((rule: any) => {
      const p = computeHabitProgress(rule, { start: periodStart, end: now }, logs, pauseMode);
      totalPossible += p.expected;
      totalCompleted += p.completed;
    });
    // NEX-279: null (not 0) when nothing was expected this week (every scheduled
    // occurrence paused, or no scheduled habits) — a planned break must not read
    // as a "0% HABITS" failure (Law C; rendered "—"). computeHabitProgress
    // already drops paused occurrences from `expected`.
    const completionRate = totalPossible > 0 ? Math.round((totalCompleted / totalPossible) * 100) : null;

    // Per-day alignment scores → the AVG SCORE tile. The per-day render moved
    // to ScoreTrendChart (which does its own windowing over the full history),
    // so this only needs the week's values, not a labelled day array.
    // A PAUSED day is excluded (a planned break is not a low day) —
    // recordDailyScore already omits paused days, but filter defensively so this
    // matches /this-week's scoresExcludingPaused even if a day was paused after
    // its score was recorded (NEX-207).
    const scores: Record<string, number> = scoreHistory ?? {};
    const validScores = weekDayKeys
      .filter((k) => !isPausedOn(k, pauseMode))
      .map((k) => scores[k])
      .filter((v) => typeof v === 'number');
    // NEX-279: null (not 0) for an all-paused / no-data window — rendered "—",
    // never "0 AVG SCORE", so a break doesn't read as a failed week (Law C).
    const avgScore = validScores.length > 0
      ? Math.round(validScores.reduce((s, v) => s + v, 0) / validScores.length)
      : null;

    // Tasks per day via the shared rollup, so recurring to-dos DUE on a day count
    // even when not materialized into dailyTasks[k] — matches the live score's
    // selectTodayTaskRollup (a daily recurring todo with no one-offs would
    // otherwise show a 0 denominator and disagree with the daily score).
    const tasks: Record<string, any[]> = dailyTasks ?? {};
    let totalTasks = 0;
    let completedTasks = 0;
    weekDayKeys.forEach((k) => {
      // NEX-279: skip paused days — a paused day's undone tasks are not "missed"
      // (a planned break), matching how habits (computeHabitProgress) and the
      // score (validScores) already exclude paused days. Otherwise a partial
      // pause sank TASKS while HABITS/SCORE held steady.
      if (isPausedOn(k, pauseMode)) return;
      const rollup = selectTodayTaskRollup(recurringToDos, tasks[k], k);
      totalTasks += rollup.total;
      completedTasks += rollup.completed;
    });
    const taskRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null;

    return { completionRate, avgScore, taskRate };
  }, [todayKey, habitLog, recurringRules, scoreHistory, dailyTasks, recurringToDos, pauseMode]);

  // saveAnchor handler moved to align.tsx with the Anchor card.

  // NEX-48 Phase 4: leverageThisWeek useMemo moved to /this-week (the only
  // screen that renders THIS WEEK'S LEVERAGE now).


  return (
    <>
      {/* Score Breakdown Modal */}
      <Modal visible={showScoreModal} transparent animationType="slide">
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setShowScoreModal(false)}
          accessibilityRole="button"
          accessibilityLabel={`Today's execution score ${todayScore}. Intention ${scoreBreakdown.intention.pts}, habits ${scoreBreakdown.habits.pts}, tasks ${scoreBreakdown.tasks.pts}.`}
          accessibilityHint="Double tap to close"
        >
          <View style={[styles.modalCard, { marginTop: 'auto' as any, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }]}>
            <View style={{ alignItems: 'center', marginBottom: 8 }}>
              <Text style={[styles.scoreNum, { /* FIXME(nex-56): inline fontSize literal — design review */ color: scoreColor, fontSize: 48 }]} maxFontSizeMultiplier={DISPLAY_MAX_FONT_SCALE}>{todayScore}</Text>
              <Text style={[styles.scoreLabel, { marginTop: 4 }]}>TODAY&apos;S EXECUTION SCORE</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 10, marginTop: 8, letterSpacing: 0.5, textAlign: 'center' }}>
                Score = Intention (33) + Habits (33) + Tasks (34)
              </Text>
            </View>

            {/* Intention */}
            <View style={styles.breakdownRow}>
              <View style={styles.breakdownLeft}>
                <Text style={styles.breakdownTitle}>MORNING INTENTION  <Text style={{ color: MUTED, fontWeight: '400' }}>/ 33 pts</Text></Text>
                {scoreBreakdown.intention.text
                  ? <Text style={styles.breakdownDetail}>&quot;{scoreBreakdown.intention.text}&quot;</Text>
                  : <Text style={styles.breakdownMissed}>Not set today — open app before 1pm</Text>}
              </View>
              <Text style={[styles.breakdownPts, { color: scoreBreakdown.intention.pts > 0 ? SEMANTIC_SUCCESS : MUTED }]}>
                {scoreBreakdown.intention.pts}
              </Text>
            </View>

            {/* Habits */}
            <View style={styles.breakdownRow}>
              <View style={styles.breakdownLeft}>
                <Text style={styles.breakdownTitle}>HABITS  <Text style={{ color: MUTED, fontWeight: '400' }}>/ 33 pts</Text></Text>
                <Text style={styles.breakdownDetail}>
                  {scoreBreakdown.habits.total > 0
                    ? `${scoreBreakdown.habits.completed} of ${scoreBreakdown.habits.total} ${scoreBreakdown.habits.label} done`
                    : 'No habits pinned — tap Manage to select'}
                </Text>
              </View>
              <Text style={[styles.breakdownPts, { color: scoreBreakdown.habits.pts >= 20 ? SEMANTIC_SUCCESS : scoreBreakdown.habits.pts >= 10 ? GOLD : MUTED }]}>
                {scoreBreakdown.habits.pts}
              </Text>
            </View>

            {/* Tasks */}
            <View style={[styles.breakdownRow, { borderBottomWidth: 0 }]}>
              <View style={styles.breakdownLeft}>
                <Text style={styles.breakdownTitle}>TASKS  <Text style={{ color: MUTED, fontWeight: '400' }}>/ 34 pts</Text></Text>
                <Text style={styles.breakdownDetail}>
                  {scoreBreakdown.tasks.total > 0
                    ? `${scoreBreakdown.tasks.completed} of ${scoreBreakdown.tasks.total} tasks completed`
                    : 'No tasks scheduled today'}
                </Text>
              </View>
              <Text style={[styles.breakdownPts, { color: scoreBreakdown.tasks.pts >= 25 ? SEMANTIC_SUCCESS : scoreBreakdown.tasks.pts >= 15 ? GOLD : MUTED }]}>
                {scoreBreakdown.tasks.pts}
              </Text>
            </View>

            <Text style={styles.breakdownHint}>Tap anywhere to close</Text>
          </View>
        </Pressable>
      </Modal>

      {/* NEX-48 Phase 4.1: WeeklyDebriefModal retired. Tap on the Weekly
          Debrief card below now pushes /this-week, which is the canonical
          retrospective destination. Phase 4.1b (if needed) will fold the
          modal's deeper content (Highlights, Wins, full AI Analysis) into
          /this-week as its top section. */}
      {/* Modal block deleted — was ~190 lines covering score chart, stats
          grid, highlights, AI analysis, weekly wins. All glanceable content
          is preserved on Home (Weekly Debrief card) or accessible via
          /this-week. */}

      {/* Badges Detail Modal moved to /this-week (NEX-48 Phase 4) — its only
          trigger was the PROGRESS section which now lives on /this-week. */}

      {/* Habit management stays on Home — one tap from the daily checkbox row. */}
      <ManageHabitsModal visible={showHabitsModal} onDismiss={() => setShowHabitsModal(false)} />

      {/* Horizon Review — auto-triggered on review dates */}
      {dueReview && (
        <HorizonReviewModal
          initialCadence={dueReview as any}
          onDismiss={() => {
            try { setDueReview(null); } catch { /* ignore */ }
          }}
        />
      )}

      {/* Weekly Wins Modal — Sundays only */}
      <Modal visible={showWinsModal} transparent animationType="fade">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>THIS WEEK</Text>
            <Text style={styles.modalSubtitle}>3 things that would make this week a win</Text>
            {[0, 1, 2].map((i) => (
              <TextInput
                key={i}
                style={[styles.modalInput, { marginBottom: i === 2 ? 28 : 14 }]}
                value={winsDraft[i]}
                onChangeText={(t) => setWinsDraft((prev) => { const n = [...prev]; n[i] = t; return n; })}
                placeholder={`Win ${i + 1}...`}
                placeholderTextColor={MUTED}
                accessibilityLabel={`Win ${i + 1}`}
              />
            ))}
            <PrimaryPill
              fullWidth
              disabled={!winsDraft.some(w => w.trim())}
              accessibilityLabel="Set my wins"
              onPress={() => {
                setWeeklyWins(winsDraft.filter(w => w.trim()));
                setShowWinsModal(false);
              }}
            >
              SET MY WINS
            </PrimaryPill>
            <Pressable onPress={() => setShowWinsModal(false)} style={{ marginTop: 14, alignItems: 'center' }} hitSlop={tokens.icon.hitTarget.linkSlop} accessibilityRole="button" accessibilityLabel="Skip">
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 11, letterSpacing: 1 }}>SKIP</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Morning Intention Modal */}
      <Modal visible={showIntentionModal} transparent animationType="fade">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ONE THING</Text>
            <Text style={styles.modalSubtitle}>What would make today a win?</Text>
            <TextInput
              style={styles.modalInput}
              value={intentionDraft}
              onChangeText={setIntentionDraft}
              placeholder="e.g. Finish the COL episode draft"
              placeholderTextColor={MUTED}
              autoFocus
              multiline
              accessibilityLabel="Today's intention"
            />
            <PrimaryPill
              fullWidth
              disabled={!intentionDraft.trim()}
              accessibilityLabel="Set my intention"
              onPress={() => {
                setMorningIntention(intentionDraft.trim());
                setShowIntentionModal(false);
                // Pre-warm Today's Wisdom (Orbit) for the new win — fire-and-forget
                // so the quotes are ready (or in flight, single-flight-deduped) by the
                // time the user reaches Orbit, instead of paying full AI latency on
                // Orbit focus. Never blocks the Home UI; the service swallows errors.
                void generateWisdom();
                // Regenerate morning brief with the new intention
                setTimeout(() => {
                  (useAppState as any).setState({ morningBriefDate: null, morningBriefItems: null });
                  generateMorningBrief();
                }, 500);
              }}
            >
              SET MY INTENTION
            </PrimaryPill>
            <Pressable onPress={() => setShowIntentionModal(false)} style={{ marginTop: 14, alignItems: 'center' }} hitSlop={tokens.icon.hitTarget.linkSlop} accessibilityRole="button" accessibilityLabel="Skip for today">
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 11, letterSpacing: 1 }}>SKIP FOR TODAY</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <AdaptiveScreen>
      <ScrollView
        ref={scrollRef}
        onScroll={handleHomeScroll}
        scrollEventThrottle={400}
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        // NEX-200: keep taps (ADD / ledger undo·jump) working while the capture
        // keyboard is up, and let iOS inset the content so the mid-scroll input
        // isn't hidden behind the keyboard (no scroll-to-top — Home must never
        // yank the user out of place on capture, unlike Command).
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={tokens.color.teal}
            colors={[tokens.color.teal]}
          />
        }
      >
      {/* NEX-48 Phase 8: animated wrapper for the first-open ceremonial fade.
          On first open of the day, content fades in from opacity 0 + 8pt
          downward translate to (1, 0) over 800ms. On subsequent opens
          during the same day, the shared values are at (1, 0) from the
          start so content renders instantly. */}
      <ReAnimated.View style={firstOpenStyle}>

        {/* NEX-48 Phase 1: spec-aligned header per CLAUDE.md §11.1 */}
        {/* Greeting + date left; SHOWCASE dev link + settings IconButton right. */}
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.greeting}>{getGreeting()}{name ? `, ${name}` : ''}.</Text>
              <Text style={styles.date}>{formatDate(today)}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm }}>
              {__DEV__ && !Device.isDevice && (
                <Pressable
                  onPress={() => router.push('/redesign/showcase' as any)}
                  hitSlop={12}
                  style={{ opacity: 0.5, paddingVertical: tokens.spacing.xs, paddingHorizontal: tokens.spacing.md }}
                  accessibilityRole="button"
                  accessibilityLabel="Open design showcase"
                >
                  <Text style={{ ...tokens.type.labelTrackedSm, color: tokens.color.gold }}>
                    → SHOWCASE
                  </Text>
                </Pressable>
              )}
              <IconButton
                icon={
                  <SymbolView
                    name="gearshape"
                    size={tokens.icon.size.md}
                    tintColor={tokens.color.text}
                    weight={tokens.icon.weight.default}
                  />
                }
                onPress={() => setShowSettings(true)}
                size="md"
                accessibilityLabel="Open settings"
              />
            </View>
          </View>
        </View>

        {/* NEX-191: shame-free return mode — Home collapses to one calm card
            (mandate continuity + one thing), hiding the ring and everything below
            behind "Show what piled up." The ring is intentionally NOT rendered
            here (a low score on return reads as a verdict on the lapse — Law C). */}
        {pausedMode && (
          <PausedCard
            mandateText={returnMandateText}
            promptDue={isPausePromptDue(todayKey, pauseMode)}
            onResume={() => resumePauseMode?.()}
          />
        )}

        {resumeMode && (
          <ResumePauseCard
            mandateText={returnMandateText}
            oneThing={returnOneThing}
            onContinue={() => setResumingFromPause?.(false)}
          />
        )}

        {returnMode && (
          <ReturnLapseCard
            mandateText={returnMandateText}
            oneThing={returnOneThing}
            onActOneThing={exitReturnMode}
            onShowPiledUp={exitReturnMode}
          />
        )}

        {!collapsedHome && (<>
        {/* NEX-48 Phase 1: AlignmentScoreRing hero per CLAUDE.md §10.13.
            Replaces the old 72pt Inter score numeral + status line + separate
            <CosmicRing/>. The ring composes 180pt gold progress arc + 140pt
            Plex Mono numeral + Fraunces italic qualitative word + tracked-caps
            "TODAY'S ALIGNMENT" label, plus shader-driven star particulates.
            Tapping the ring opens the same score-breakdown modal as before. */}
        <View ref={scoreCardRef} style={styles.heroWrap}>
          <AlignmentScoreRing
            score={todayScore}
            size={264}
            onPress={() => setShowScoreModal(true)}
            testID="home-alignment-ring"
          />
        </View>

        {/* Today's Win — primary card. Replaces the old Today's Move CTA. */}
        {(() => {
          const hasPrefill =
            !!pendingMondayIntention &&
            pendingMondayIntention.targetDateKey === todayKey &&
            !!pendingMondayIntention.text &&
            !todayIntention;

          if (hasPrefill) {
            return (
              <View style={styles.intentionCard}>
                <Text style={styles.sectionLabel}>FROM SUNDAY&apos;S REVIEW</Text>
                <Text style={styles.intentionText}>{pendingMondayIntention.text}</Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                  <PrimaryPill
                    onPress={() => {
                      if (typeof consumePendingMondayIntention === 'function') {
                        consumePendingMondayIntention();
                      }
                      // Pre-warm Today's Wisdom for the adopted win too (the other
                      // win-set path besides the intention modal). Fire-and-forget.
                      void generateWisdom();
                    }}
                    fullWidth
                    style={{ flex: 1 }}
                    accessibilityLabel="Use this intention"
                  >
                    USE THIS
                  </PrimaryPill>
                  <Pressable
                    onPress={() => {
                      if (typeof clearPendingMondayIntention === 'function') {
                        clearPendingMondayIntention();
                      }
                      setIntentionDraft('');
                      setShowIntentionModal(true);
                    }}
                    style={{ flex: 1, backgroundColor: 'transparent', borderRadius: 10, borderWidth: 1, borderColor: GRAY_333, paddingVertical: 12, alignItems: 'center' }}
                    accessibilityRole="button"
                    accessibilityLabel="Write new intention"
                  >
                    <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 11, fontWeight: '900', letterSpacing: 2 }}>WRITE NEW</Text>
                  </Pressable>
                </View>
              </View>
            );
          }

          if (todayIntention) {
            const winCompleted = morningIntentionCompletedDate === todayKey;
            return (
              <Pressable
                style={[styles.intentionCard, winCompleted && styles.intentionCardCompleted]}
                accessibilityRole="checkbox"
                accessibilityLabel={`Today's win: ${todayIntention}`}
                accessibilityState={{ checked: winCompleted }}
                accessibilityHint={winCompleted ? 'Marks win as not done' : 'Marks win as complete'}
                // The checkbox role collapses descendants into one node, so the
                // nested EDIT button is unreachable by VoiceOver. Expose Edit as
                // a custom action (rotor) so the screen-reader path isn't lost;
                // the nested EDIT Pressable remains for sighted/touch users.
                accessibilityActions={[{ name: 'edit', label: 'Edit' }]}
                onAccessibilityAction={(e) => {
                  if (e.nativeEvent.actionName === 'edit') {
                    setIntentionDraft(todayIntention);
                    setShowIntentionModal(true);
                  }
                }}
                onPress={() => {
                  if (typeof toggleMorningIntentionComplete === 'function') {
                    toggleMorningIntentionComplete();
                  }
                  if (winCompleted) {
                    haptic('tabChange');
                  } else {
                    haptic('habitResolve');
                  }
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={[styles.sectionLabel, winCompleted && { opacity: 0.55 }]}>TODAY&apos;S WIN</Text>
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      setIntentionDraft(todayIntention);
                      setShowIntentionModal(true);
                    }}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Edit today's win"
                  >
                    <Text style={styles.editLink}>EDIT</Text>
                  </Pressable>
                </View>
                <Text
                  style={[
                    styles.intentionText,
                    winCompleted && { textDecorationLine: 'line-through', opacity: 0.55 },
                  ]}
                >
                  {winCompleted ? '✓  ' : ''}{todayIntention}
                </Text>
                <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: winCompleted ? GOLD : MUTED, fontSize: 9, marginTop: 6, letterSpacing: 1, fontWeight: winCompleted ? '900' : '400', opacity: winCompleted ? 0.7 : 1 }}>
                  {winCompleted ? 'COMPLETED · TAP TO UNDO' : 'TAP TO MARK COMPLETE'}
                </Text>
              </Pressable>
            );
          }

          return (
            <Pressable
              style={styles.intentionCard}
              onPress={() => { setIntentionDraft(''); setShowIntentionModal(true); }}
              accessibilityRole="button"
              accessibilityLabel="Today's win"
              accessibilityHint="Set your intention for today"
            >
              <Text style={styles.sectionLabel}>TODAY&apos;S WIN</Text>
              <Text style={styles.mutedText}>Tap to set your intention for today →</Text>
            </Pressable>
          );
        })()}

        {/* Getting Started — first-week guided nudges */}
        {(() => {
          const liveState = (useAppState as any).getState() as any;
          const activatedDate = liveState.activatedDate;
          if (!activatedDate) return null;
          const daysSinceActivation = Math.floor((Date.now() - new Date(activatedDate).getTime()) / 86400000);
          if (daysSinceActivation > 7) return null;
          const loggedAny = Array.isArray(liveState.habitLog) && liveState.habitLog.some((e: any) => e.dateKey === todayKey);
          const hasIntention = liveState.morningIntentionDate === todayKey;
          const nudges: Record<number, string> = {
            0: `Welcome to Nexus, ${name || 'friend'}. You've set your mandates and habits. Today, just log one habit and set your intention. That's all it takes to start.`,
            1: loggedAny ? `Day 2 — you logged a habit yesterday. Keep the momentum.` : `Day 2 — no habit logged yet today. Start with the easiest one.`,
            2: `Day 3 — keep it simple. Log one habit and continue.`,
            3: hasIntention ? `Day 4 — intention set. Continue.` : `Day 4 — no intention set yet. Tap "Today's Win" above.`,
            6: `Day 7 — your first Weekly Debrief is ready. Scroll down to see how your week went.`,
          };
          const nudge = nudges[daysSinceActivation];
          if (!nudge) return null;
          return (
            <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: SEMANTIC_INFO, paddingLeft: 16, marginBottom: 14 }]}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: SEMANTIC_INFO, fontSize: 8, fontWeight: '900', letterSpacing: 2, marginBottom: 6 }}>GETTING STARTED</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: TEXT, fontSize: 13, lineHeight: 20 }}>{nudge}</Text>
            </View>
          );
        })()}

        {/* NEX-48 Phase 6.2: Left/Inbox status pills — plain View, NOT Card.
            Card's ambient warm gold shadow is calibrated for major surfaces
            (Weekly Debrief, Today's Habits container) where the glow reads
            as atmospheric. On small compact pills it overwhelms — too much
            glow per square inch. Reverted to plain View with surface bg +
            gold hairline border for a flatter, more contained treatment
            (matches the pre-redesign visual that the user wants back). */}
        <View style={styles.statusRow}>
          <EventsLeftCard events={allTodayEvents} />
          <View style={styles.statusCard}>
            <Text style={styles.statusValue}>{pendingInbox}</Text>
            <Text style={styles.statusTitle}>INBOX</Text>
          </View>
        </View>

        {/* NEX-196: Home echo for a just-captured one-off. Object permanence
            (§1.5 Law A) — proof of the capture on Home, with a one-tap jump. */}
        {showCaptureEcho && (
          <Pressable
            onPress={() => {
              // NEX-215 (L-4): tapping the echo chip is a SURFACED first-reach
              // (home_echo). Record BEFORE clearJustCaptured unmounts the ref;
              // justCaptured.at is the capture time for age_bucket (race-free,
              // no inbox lookup). NEX-261: routed through the tracker so it emits
              // at most once per capture, true-first.
              if (justCaptured?.id) {
                void recordFirstReach(justCaptured.id, {
                  surface: justCaptured.surface,
                  accessMethod: 'home_echo',
                  capturedAtMs: justCaptured.at,
                });
              }
              clearJustCaptured?.();
              router.push('/(tabs)/inbox' as any);
            }}
            style={styles.captureEcho}
            accessibilityRole="button"
            accessibilityLabel="Just captured. In your Inbox. Tap to view."
          >
            <Text style={styles.captureEchoText}>Just captured. In your Inbox.</Text>
            <Text style={styles.captureEchoAction}>VIEW</Text>
          </Pressable>
        )}

        {/* NEX-198 (N-1): REMINDERS — timed inbox items whose moment has come,
            pinned here until resolved (the app is the persistent reminder, not
            the swiped banner). Tap the check to resolve; copy stays neutral —
            "still open", never an absence count (§1.5 Law C). */}
        {dueReminders.length > 0 && (
          <>
            <SectionHeader>REMINDERS</SectionHeader>
            <Card style={styles.cardSpacing}>
              {dueReminders.map((r: any, idx: number) => {
                // NEX-perf: same belowFoldReady gate as the below-fold
                // sections — reminders are unbounded, so only the first 3
                // mount in the initial above-the-fold commit; the rest mount
                // right after first paint. Render-gate ONLY: the array is
                // never sliced/filtered, so every live reminder still mounts
                // (nothing is ever hidden).
                if (idx >= 3 && !belowFoldReady) return null;
                return (
                <View key={r.id} style={styles.leadTimeRow}>
                  <Pressable
                    hitSlop={10}
                    onPress={() => { resolveInboxTask?.(r.id); haptic('habitResolve'); }}
                    style={styles.leadTimeCheck}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: false }}
                    accessibilityLabel={`Resolve ${r.title || 'reminder'}`}
                    accessibilityHint="Double tap to mark done"
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.leadTimeWhen} numberOfLines={2}>{r.title || 'Reminder'}</Text>
                    <Text style={styles.leadTimeAction}>Still open.</Text>
                  </View>
                </View>
                );
              })}
            </Card>
          </>
        )}

        {/* TODAY'S HABITS — NEX-48 §11.1 Phase 3: vertical HabitRow list with
            SectionHeader carrying MANAGE action. Replaces the horizontal habit
            chip scroll, the helper-text microcopy, and the standalone gold
            "MANAGE HABITS" pill that used to live below the chips.

            Multi-times-per-day habits keep their semantics: each tap on the
            ceremonial checkbox logs ONE occurrence. The row reads `completed`
            when completedCount >= required; meta shows "N/REQ TODAY" so users
            can see partial progress. Tapping a completed multi-times habit
            unlogs one occurrence (matches the old behavior of tapping a filled
            circle to clear it). */}
        <View
          ref={gettingStartedRef}
          onLayout={(e) => { habitsSectionY.current = e.nativeEvent.layout.y; }}
        >
          <SectionHeader
            action={
              Array.isArray(recurringRules) && recurringRules.length > 0
                ? { label: 'MANAGE', onPress: () => setShowHabitsModal(true) }
                : undefined
            }
          >
            {"TODAY'S HABITS"}
          </SectionHeader>
        </View>

        {(!Array.isArray(recurringRules) || recurringRules.length === 0) ? (
          /* Empty state — kept inline pending Phase 4 Card sweep. */
          <View style={{ backgroundColor: tokens.color.surface, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: 24, alignItems: 'center', marginBottom: 16, ...ambientGlowSoft }}>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 28, marginBottom: 12 }}>◇</Text>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: tokens.color.text, fontSize: 15, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>Start your system.</Text>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: tokens.color.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
              {"The discipline you build today becomes the person you are tomorrow. Add your first habit."}
            </Text>
          </View>
        ) : (() => {
          // NEX-199: the visible rows (capped, completed-overflow collapsed) are
          // computed at component top level (scheduledTodayHabits → selector).
          // `rowsToRenderHabits` = capped set, or all when expanded.

          // NEX-48 Phase 3.1: visible long-press affordance. The chip helper
          // text used to live below the chip row ("Tap a circle to log ·
          // long-press a habit to manage"). The new HabitRow has its tap
          // affordance baked in (ceremonial checkbox is self-evident), so we
          // only surface the long-press hint here. Renders ONCE above the
          // first row, not per-row.
          // NEX-48 Phase 3.3: shortened from "LONG-PRESS A HABIT TO PIN,
          // RENAME, OR DELETE" to fit on one line. The "A HABIT" subject is
          // already implied by context (the hint sits inside the habits card,
          // directly above the rows). `numberOfLines={1}` belt-and-suspenders
          // — if the copy ever expands beyond what fits, ellipsize instead of
          // wrapping with an orphan word.
          const longPressHint = (
            <Text style={styles.habitListHint} numberOfLines={1}>
              LONG-PRESS TO PIN, RENAME, OR DELETE
            </Text>
          );

          // Centralized side-effect helpers — keep onComplete callbacks compact.
          const syncWidgetDataDeferred = () => {
            setTimeout(() => {
              try {
                const s = (useAppState as any).getState() as any;
                if ((s.recurringRules ?? []).filter((r: any) => !r.archived).length > 0) {
                  updateWidgetData(buildWidgetData({
                    recurringRules: s.recurringRules ?? [],
                    habitLog: Array.isArray(s.habitLog) ? s.habitLog : [],
                    habitStreaks: s.habitStreaks ?? {},
                    pinnedHabits: s.pinnedHabits ?? [],
                    totalXP: s.totalXP ?? 0,
                    inbox: s.inbox ?? [],
                    recurringToDos: s.recurringToDos ?? [],
                    dailyTasks: s.dailyTasks ?? {},
                    events: widgetEvents,
                    softMode: s.softMode === true,
                    morningIntention: s.morningIntention ?? null,
                    morningIntentionDate: s.morningIntentionDate ?? null,
                    dailyWisdomQuotes: Array.isArray(s.dailyWisdomQuotes) ? s.dailyWisdomQuotes : [],
                    dailyWisdomDate: typeof s.dailyWisdomDate === 'string' ? s.dailyWisdomDate : '',
                    wisdomQuoteCount: typeof s.wisdomQuoteCount === 'number' ? s.wisdomQuoteCount : 3,
                  }));
                }
              } catch {}
            }, 300);
          };

          return (
            // NEX-? — habits are individual cards now (HabitRow owns its own
            // surface/radius/padding). Wrapper View just provides the 12pt
            // gap between rows. The long-press hint above the list is gone —
            // long-press feedback should be discoverable, not labeled.
            <View style={{ marginBottom: tokens.spacing.lg, gap: 12 }}>
              {rowsToRenderHabits.map((rule: any, idx: number) => {
                // NEX-perf: rows past the first 5 mount after first paint
                // (belowFoldReady) instead of in the initial commit — same
                // gate as the below-fold sections. Render-gate ONLY:
                // rowsToRenderHabits itself is untouched (it also feeds
                // habitRowDataRef and the getHabitRowHandlers cache), and
                // every live row still mounts once belowFoldReady flips —
                // deferral, never hiding (NEX-199).
                if (idx >= 5 && !belowFoldReady) return null;
                // O(1) lookup into the memoized per-day count map, keyed on the
                // canonical emoji-SENSITIVE normalize(title) (write path +
                // scoreBreakdown). The row's done/toggle therefore agrees with the
                // completion selector, incompleteHabitsToday, and the score; and
                // "Run"/"Run 🏃" never share a count (Greptile #214).
                const key = habitCompletionKey(rule?.title);
                const required = rule.timesPerDay || 1;
                const completedCount = todayCompletionCounts[key] || 0;
                const done = completedCount >= required;
                const streak = getStreak ? getStreak(rule.title) : 0;
                // NEXUS-5: O(1) read of the memoized chip label (was an inline
                // computeHabitProgress + computeLifetimeReps scan of the unbounded
                // habitLog, per row, every render). The Map is built over the full
                // scheduledTodayHabits and rowsToRenderHabits is always a subset,
                // so the lookup hits for every rendered row; `?? ''` is just the
                // type-level default and never re-scans habitLog.
                const progressLabel = habitProgressLabels.get(rule.id) ?? '';
                const graceStatus = getStreakGraceStatus({
                  currentStreak: (habitStreaks ?? {})[key] ?? 0,
                  lastUpdatedDateKey: (habitStreakUpdatedDate ?? {})[key],
                  daysOfWeek: rule.daysOfWeek,
                });
                // Grace-day meta is a Soft-Mode (breakable-streak) concept only.
                const meta = (softMode && graceStatus === 'held')
                  ? 'GRACE DAY HELD'
                  : required > 1 ? `${completedCount}/${required} TODAY` : 'DAILY';

                return (
                  // Keyed wrapper for the habit-row list (the NEX-164
                  // 'home.firstHabit' spotlight ref was removed in NEX-193).
                  <View key={rule.id}>
                  <HabitRow
                    title={rule.title}
                    meta={meta}
                    count={completedCount}
                    target={required}
                    streak={streak >= 2 ? streak : undefined}
                    progressLabel={progressLabel}
                    softMode={softMode}
                    completed={done}
                    testID={`habit-row-${rule.id}`}
                    onComplete={() => {
                      if (done) {
                        // Already at required — unlog one (matches old "tap filled circle to clear").
                        if (unlogHabit) unlogHabit(rule.title);
                        syncWidgetDataDeferred();
                        return;
                      }
                      // Add one log + run all side effects (cumulative milestone, XP toast, confetti).
                      const xpBefore = (useAppState as any).getState().totalXP || 0;
                      if (logHabit) logHabit(rule.title);
                      syncWidgetDataDeferred();

                      // NEX-164: Day-1 activation emit. is_first comes from the
                      // durable firstHabitCompletedAt flag (not habitLog) and is
                      // claimed synchronously before the async trackEvent; source
                      // from the onboarding first-action intent, consumed on use.
                      try {
                        const liveS = (useAppState as any).getState();
                        const isFirst = !liveS.firstHabitCompletedAt;
                        if (isFirst) liveS.setFirstHabitCompleted?.();
                        const intent = liveS.firstActionIntent;
                        if (intent) liveS.setFirstActionIntent?.(null);
                        void trackEvent('habit_completed', {
                          habit_id: rule.id,
                          source: intent ? 'onboarding' : 'home',
                          is_first: isFirst,
                        });
                      } catch { /* analytics must never break completion */ }

                      // NEX-190: rewards key off CUMULATIVE reps (Nth completion),
                      // not the breakable streak — a miss erases nothing. The
                      // milestone ceremony fires once when this completion crosses
                      // 7/30/66/365 lifetime reps (CLAUDE.md §10.14, positive-only).
                      const liveAfter = (useAppState as any).getState();
                      void maybeRequestStoreReviewAfterHabitCompletion();
                      const newReps = computeLifetimeReps(rule, liveAfter.habitLog);
                      const milestone = crossedRepMilestone(newReps);
                      // Fire ONCE per habit+threshold — a persisted record means an
                      // unlog-then-relog across the threshold can't re-fire the ceremony.
                      const alreadyShown = milestone != null && (liveAfter.milestonesShown?.[key] ?? []).includes(milestone);
                      if (milestone && !alreadyShown) {
                        liveAfter.markMilestoneShown?.(rule.title, milestone);
                        // NEX-192: honor the Milestone Alerts toggle. The push is
                        // scheduled here, not via scheduleAllNotifications, so it
                        // reads the setting directly (undefined = on).
                        const milestoneAlertsOn =
                          liveAfter.notificationSettings?.milestoneAlerts !== false;
                        if (milestoneAlertsOn) {
                          scheduleMilestoneNotification({ habitTitle: rule.title, habitId: rule.id, reps: milestone });
                        }
                        setShowConfetti(true);
                        setShareStreakData({ title: rule.title, reps: milestone });
                        setTimeout(() => setShowConfetti(false), 5000);
                      }
                      // XP toast = the real gain. XP is additive (a miss never
                      // removes earned XP), so showing the true delta can't punish.
                      const gain = Math.max(0, (liveAfter.totalXP || 0) - xpBefore);
                      setXpToast(`+${gain} XP`);
                      Animated.sequence([
                        Animated.timing(xpToastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
                        Animated.delay(1200),
                        Animated.timing(xpToastOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
                      ]).start(() => setXpToast(null));
                    }}
                    onLongPress={() => {
                      const excluded = rule.excludedFromScore === true;
                      Alert.alert(
                        rule.title,
                        undefined,
                        [
                          // Rename leads; the score-exclusion item sits below it so
                          // it isn't the easiest mistap target (resting a habit hides
                          // it from Today's Habits — see the one-tap undo toast).
                          {
                            text: 'Rename',
                            onPress: () => {
                              Alert.prompt(
                                'Rename habit',
                                undefined,
                                [
                                  { text: 'Cancel', style: 'cancel' },
                                  {
                                    text: 'Save',
                                    onPress: (newTitle?: string) => {
                                      const trimmed = (newTitle ?? '').trim();
                                      if (trimmed && renameRecurringRule) {
                                        renameRecurringRule(rule.id, trimmed);
                                      }
                                    },
                                  },
                                ],
                                'plain-text',
                                rule.title,
                              );
                            },
                          },
                          {
                            text: excluded ? 'Count toward today’s score' : 'Rest from today’s score',
                            onPress: () => {
                              setHabitExcludedFromScore?.(rule.id, !excluded);
                              // Resting removes it from Today's Habits — offer undo.
                              // Un-resting needs none; clear any lingering toast.
                              if (!excluded) showRestUndo(rule.id, stripEmoji(rule.title));
                              else hideRestUndo();
                            },
                          },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: () => {
                              Alert.alert(
                                'Delete habit?',
                                `Remove "${stripEmoji(rule.title)}" and its streak history?`,
                                [
                                  { text: 'Cancel', style: 'cancel' },
                                  {
                                    text: 'Delete',
                                    style: 'destructive',
                                    onPress: () => deleteRecurringRule && deleteRecurringRule(rule.id),
                                  },
                                ],
                              );
                            },
                          },
                          { text: 'Cancel', style: 'cancel' },
                        ],
                      );
                    }}
                  />
                  {/* NEX-208: optional pre-framed first step — a tappable teal
                      line below the row (above the mandate echo) when set and the
                      habit isn't done. Tapping it gives the ephemeral "started"
                      acknowledgment. Sibling, outside HabitRow's Pressable. */}
                  {shouldShowFirstStep(rule.firstStep, done) && (
                    <HabitFirstStep
                      firstStep={String(rule.firstStep)}
                      habitTitle={stripEmoji(rule.title)}
                    />
                  )}
                  {/* NEX-209: if-then cue rides BELOW the row (above the mandate
                      echo), directly under the named habit so it reads as that
                      habit's trigger. Shown while not started; not tappable. */}
                  {shouldShowCue(rule.cue, completedCount) && (
                    <View
                      style={styles.cueWrap}
                      accessibilityLabel={`Cue: ${String(rule.cue)}`}
                    >
                      <Text style={styles.cueMarker} importantForAccessibility="no">
                        {'↳'}
                      </Text>
                      <Text style={styles.cueText} numberOfLines={1} ellipsizeMode="tail">
                        {String(rule.cue)}
                      </Text>
                    </View>
                  )}
                  {/* NEX-202: user-confirmed mandate echo rides BELOW the row
                      (sibling, outside HabitRow's completion Pressable — the
                      sever tap can never toggle the habit). Floats on the cosmos
                      below the card, so it carries the §4.11 floating-text shadow.
                      Stale-guarded: a deleted/blank mandate renders nothing. */}
                  {(() => {
                    const echo = resolveMandateEcho(rule, pillars);
                    if (!echo) return null;
                    return (
                      <View style={styles.mandateEchoWrap}>
                        <Text
                          style={styles.mandateEchoText}
                          numberOfLines={2}
                          ellipsizeMode="tail"
                        >
                          {`You said this matters: “${echo.text}”`}
                        </Text>
                        <Pressable
                          onPress={() => {
                            updateRecurringRule?.(rule.id, { mandateEchoPillarId: null });
                            haptic('buttonSecondary');
                          }}
                          hitSlop={12}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove the mandate echo from ${stripEmoji(rule.title)}`}
                          style={styles.mandateEchoRemove}
                        >
                          <Text style={styles.mandateEchoRemoveText}>REMOVE ECHO</Text>
                        </Pressable>
                      </View>
                    );
                  })()}
                  </View>
                );
              })}
              {/* NEX-199: labeled "+N MORE" / "SHOW LESS" — never gesture-only
                  (H-1). Only completed overflow is ever collapsed (the selector
                  never hides a live row). Instant, no animation (§1.4). */}
              {hiddenHabitCount > 0 && (
                <Pressable
                  onPress={() => {
                    haptic('buttonSecondary');
                    setShowAllHabits((v) => !v);
                  }}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={
                    showAllHabits ? 'Show fewer habits' : `Show ${hiddenHabitCount} more habits`
                  }
                  style={styles.habitsMoreToggle}
                >
                  <Text style={styles.habitsMoreToggleText}>
                    {showAllHabits ? 'SHOW LESS' : `+${hiddenHabitCount} MORE`}
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })()}

        {/* NEX-200 (H-3): quiet one-off quick-capture. Sits BELOW the
            ceremonial fold (after Today's Habits), subordinate to the ring
            ritual — no gold accent, no autoFocus (§1.5 Law D / §1.7). Capture
            here is a synchronous Inbox write; the item surfaces in place via the
            reused execution ledger (one-tap undo) + the NEX-196 echo above. */}
        <View style={styles.captureBar}>
          <Text style={styles.capturePlus}>＋</Text>
          <TextInput
            style={styles.captureInput}
            value={captureText}
            onChangeText={(t) => {
              // Re-arm the double-submit latch: editing the input is the next
              // genuine capture intent (see handleHomeCapture).
              captureSubmittingRef.current = false;
              setCaptureText(t);
            }}
            placeholder="Capture a one-off…"
            placeholderTextColor={MUTED}
            returnKeyType="done"
            onSubmitEditing={handleHomeCapture}
            accessibilityLabel="Capture a one-off to your Inbox"
          />
          {captureText.trim().length > 0 && (
            <Pressable
              onPress={handleHomeCapture}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Add to Inbox"
            >
              <Text style={styles.captureAdd}>ADD</Text>
            </Pressable>
          )}
        </View>
        {/* AnimatePresence so the ledger's MotiView exit fade plays on dismiss,
            matching Command (index.tsx) and the §7 250ms-ease motion baseline. */}
        <AnimatePresence>
          {captureLedger && (
            <CommandExecutionLedger
              ledger={captureLedger}
              retryingLedgerKeys={[]}
              onRetryItem={() => {}}
              onUndoItem={handleCaptureUndo}
              onJumpItem={handleCaptureJump}
              onDismiss={() => setCaptureLedger(null)}
            />
          )}
        </AnimatePresence>

        {/* Today's Horizon — NEX-48 §11.1 Phase 6: SectionHeader is
            "TODAY'S HORIZON"; the card carries an "UP NEXT" tracked-caps
            eyebrow above the event title per the spec's two-level treatment
            (header introduces the section, eyebrow names the artifact
            inside). */}
        <HorizonUpNextCard events={allTodayEvents} />

        {/* NEX-perf: defer the HEAVY below-the-fold sections (Lead Time radar,
            wins, Cut or Commit, the THIS WEEK chart/weeklyStats, Carry Forward,
            Tip) until after first paint, so the initial main-thread commit is the
            above-the-fold ritual + the light capture/horizon strip — no single
            >2000ms block. The quick-capture bar (Law A) and the UP NEXT card
            (Law D) stay eager. Each section keeps its own gate, AND-ed here. */}
        {belowFoldReady && (<>

        {/* NEX-162: Lead-Time Radar — due/overdue advance actions. Gold accent
            for attention; drops to plain luminous edge when Cut or Commit is
            also visible so the screen holds the ≤5% gold budget (§4.4). */}
        {leadTimeRollup.hasSurfacing && (
          <>
            <SectionHeader>LEAD TIME</SectionHeader>
            <Card accentBar={deadWeightItems.length > 0 ? undefined : 'gold'} style={styles.cardSpacing}>
              {leadTimeRollup.surfacing.slice(0, 3).map((a) => {
                const days = Math.max(0, daysBetweenKeys(todayKey, a.eventDate));
                const actByLabel = formatKeyShortWithWeekday(a.actByDate);
                return (
                  <View key={a.id} style={styles.leadTimeRow}>
                    <Pressable
                      hitSlop={10}
                      onPress={() => {
                        toggleLeadTimeAction(a.id);
                        // Completing removes the row from `surfacing`, so the
                        // checked transition never renders — announce the result
                        // so VoiceOver confirms the action landed.
                        announce(`${a.title}, marked done`);
                      }}
                      style={styles.leadTimeCheck}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: false }}
                      accessibilityLabel={`${a.title} by ${actByLabel}, for ${a.eventTitle}`}
                      accessibilityHint="Double tap to mark done"
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.leadTimeWhen}>
                        {a.eventTitle} {days <= 0 ? 'is here' : `is in ${days} day${days === 1 ? '' : 's'}`}.
                      </Text>
                      <Text style={styles.leadTimeAction}>{a.title} by {actByLabel}.</Text>
                    </View>
                  </View>
                );
              })}
              {leadTimeRollup.surfacing.length > 3 && (
                <Pressable
                  onPress={() => router.push('/(tabs)/orbit' as any)}
                  hitSlop={tokens.icon.hitTarget.linkSlop}
                  accessibilityRole="button"
                  accessibilityLabel={`${leadTimeRollup.surfacing.length - 3} more in Orbit`}
                  accessibilityHint="Opens the Orbit tab"
                >
                  <Text style={styles.leadTimeMore}>+{leadTimeRollup.surfacing.length - 3} more in Orbit</Text>
                </Pressable>
              )}
            </Card>
          </>
        )}

        {/* This Week's Wins — NEX-48 Phase 5: Card primitive. */}
        {currentWeeklyWins.length > 0 && (
          <>
            <SectionHeader
              action={{
                label: 'EDIT',
                onPress: () => {
                  const padded = [...currentWeeklyWins];
                  while (padded.length < 3) padded.push('');
                  setWinsDraft(padded.slice(0, 3));
                  setShowWinsModal(true);
                },
              }}
            >
              THIS WEEK&apos;S WINS
            </SectionHeader>
            <Card style={styles.cardSpacing}>
              {currentWeeklyWins.filter(Boolean).map((win, i) => (
                <View key={i} style={styles.winRow}>
                  <Text style={styles.winDot}>◆</Text>
                  <Text style={styles.winText}>{win}</Text>
                </View>
              ))}
            </Card>
          </>
        )}

        {/* NEX-48 Phase 7: below-fold reorder per §11.1.
            New sequence: This Week's Wins → Cut or Commit → Weekly Debrief →
            Carry Forward → Day-1 Command nudge. Cut or Commit moved up from
            below Weekly Debrief (spec puts actionable-but-stale items closer
            to the wins they sit alongside); Day-1 nudge moved to the tail
            (spec's "Tip" slot — occasional/conditional, doesn't crowd the
            retrospective sequence). Today's Win and Getting Started stay
            above the fold per user preference (daily-active morning ritual +
            first-7-days onboarding both want prominent placement). */}

        {/* Cut or Commit — only appears after 14 days of inaction.
            v3 stellar: shifted from accentBar="amber" to accentBar="gold".
            Amber retires from default utility under v3; this is a daily-
            utility prompt (decide now), not a milestone ceremony. Gold
            gives it the right "attention-needed" register without
            burning the amber-only-for-milestones rule. */}
        {deadWeightItems.length > 0 && (
          <>
            <SectionHeader>CUT OR COMMIT</SectionHeader>
            <Card accentBar="gold" style={styles.cardSpacing}>
              {deadWeightItems.map((item: any) => (
                <View key={item.id} style={styles.deadWeightRow}>
                  <Text style={styles.deadWeightText} numberOfLines={1}>{item.title}</Text>
                </View>
              ))}
              <Text style={styles.deadWeightHint}>These are waiting on a decision. The Inbox is where you cut or commit.</Text>
            </Card>
          </>
        )}

        {/* THIS WEEK — the alignment-score ticker (owner request, see the
            weeklyStats memo for the Law-B/C note). The 7 static bars that used
            to live here were replaced by ScoreTrendChart: a scrubbable line
            over 1W / 1M / 6M / 1Y / ALL, so the card answers "which way is this
            going" and not only "how was this week". KPI tiles below still
            summarize the rolling 7 days. DETAILS › and the tiles open
            /this-week for depth. */}
        {showWeeklyDebrief && (
        <>
        <SectionHeader
          action={{
            label: 'DETAILS ›',
            onPress: () => router.push('/this-week' as any),
          }}
        >
          THIS WEEK
        </SectionHeader>
        {/* The Card is NOT pressable anymore — a card-wide onPress would fight
            the chart's horizontal scrub for the touch. Navigation moved to the
            KPI tiles row below (plus DETAILS › above), so the whole-card path
            to /this-week isn't lost. */}
        <Card accentBar="gold" style={styles.cardSpacing}>
          {/* Opens on 1W so the card still answers what the 7 bars answered and
              what the KPI tiles beside it measure; the longer ranges are one tap
              away. /this-week opens on 1M — that surface is the depth. */}
          <ScoreTrendChart
            scoreHistory={scoreHistory}
            pauseMode={pauseMode}
            todayKey={todayKey}
            initialRange="1W"
          />

          {/* Key stats — habit completion, average score, task completion.
              Each colored teal / gold / textMuted by tier (no red). Pressable
              as one row: this is Home's remaining whole-card route to depth. */}
          <Pressable
            onPress={() => router.push('/this-week' as any)}
            accessibilityRole="button"
            accessibilityLabel="This week's habits, average score and tasks. Opens the full week."
            style={({ pressed }) => [{ flexDirection: 'row', marginTop: 14, gap: 8 }, pressed ? { opacity: 0.72 } : null]}
          >
            <View style={{ flex: 1, backgroundColor: tokens.color.surfaceSunken, borderRadius: 10, padding: 10, alignItems: 'center' }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: kpiColorForRate(weeklyStats.completionRate), fontSize: 20, fontWeight: '900' }}>{weeklyStats.completionRate == null ? '—' : `${weeklyStats.completionRate}%`}</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_444, fontSize: 7, fontWeight: '900', letterSpacing: 1, marginTop: 2 }}>HABITS</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: tokens.color.surfaceSunken, borderRadius: 10, padding: 10, alignItems: 'center' }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: kpiColorForRate(weeklyStats.avgScore), fontSize: 20, fontWeight: '900' }}>{weeklyStats.avgScore == null ? '—' : weeklyStats.avgScore}</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_444, fontSize: 7, fontWeight: '900', letterSpacing: 1, marginTop: 2 }}>AVG SCORE</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: tokens.color.surfaceSunken, borderRadius: 10, padding: 10, alignItems: 'center' }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: kpiColorForRate(weeklyStats.taskRate), fontSize: 20, fontWeight: '900' }}>{weeklyStats.taskRate == null ? '—' : `${weeklyStats.taskRate}%`}</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_444, fontSize: 7, fontWeight: '900', letterSpacing: 1, marginTop: 2 }}>TASKS</Text>
            </View>
          </Pressable>
        </Card>
        </>
        )}

        {/* Carry Forward (nightly).
            FIXME(nex-56): old green-dark tint #080A08 + #1A2A1A border of the
            nightlyCard style is dropped — Card's standard stone-morphism is
            plenty. */}
        {todayNightly && (
          <>
            <SectionHeader>CARRY FORWARD</SectionHeader>
            <Card style={styles.cardSpacing}>
              <Text style={styles.nightlyText}>{todayNightly}</Text>
            </Card>
          </>
        )}

        {/* Day-1 Command nudge — §11.1's "Tip" slot at the tail of the
            below-fold sequence. Conditional, dismissable, and not a focal
            point — appears once early in the user's life with the app to
            point them at the Command tab voice surface. */}
        {showDay1Nudge && (
          <View>
            <Pressable
              onPress={() => { dismissDay1Nudge(); router.push('/' as any); }}
              style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: tokens.color.surface, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: 14, marginBottom: 14 }}
              accessibilityRole="button"
              accessibilityLabel="Tip: Speak to the orb in Command to add tasks hands-free"
              accessibilityHint="Opens the Command tab"
            >
              <View style={{ flex: 1 }}>
                <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 8, fontWeight: '900', letterSpacing: 2, marginBottom: 4 }}>TIP</Text>
                <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: TEXT, fontSize: 13, lineHeight: 18 }}>Speak to the orb in Command to add tasks hands-free.</Text>
              </View>
              <Pressable onPress={(e) => { e.stopPropagation(); dismissDay1Nudge(); }} hitSlop={10} style={{ marginLeft: 12, padding: 4 }} accessibilityRole="button" accessibilityLabel="Dismiss tip">
                <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_444, fontSize: 16 }} accessibilityElementsHidden importantForAccessibility="no">✕</Text>
              </Pressable>
            </Pressable>
          </View>
        )}
        </>)}{/* end belowFoldReady (NEX-perf below-the-fold deferral) */}
        </>)}

      </ReAnimated.View>
      </ScrollView>
      </AdaptiveScreen>

      {/* Settings */}
      <Modal visible={showSettings} animationType="slide" presentationStyle="formSheet">
        <SettingsScreen onSignOut={() => setShowSettings(false)} onClose={() => setShowSettings(false)} />
        <Pressable onPress={() => setShowSettings(false)} hitSlop={8} style={{ position: 'absolute', top: 16, right: 16, padding: 8 }} accessibilityRole="button" accessibilityLabel="Close settings">
          <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GRAY_555, fontSize: 18 }} accessibilityElementsHidden importantForAccessibility="no">✕</Text>
        </Pressable>
      </Modal>

      {showConfetti && (
        <ConfettiCannon
          count={150}
          origin={{ x: -10, y: 0 }}
          autoStart
          fadeOut
          explosionSpeed={350}
          fallSpeed={3000}
          // FIXME(nex-56): confetti celebration palette (decorative-only) — replace with milestone gradient tokens, design review
          colors={[LEGACY_GOLD, '#FFD700', '#F5F5DC', tokens.color.text, '#C0C0C0', '#8B5CF6']}
        />
      )}

      {xpToast && (
        <Animated.View
          style={{
            position: 'absolute', top: 140, alignSelf: 'center',
            backgroundColor: LEGACY_GOLD, paddingHorizontal: 20, paddingVertical: 10,
            borderRadius: 24, opacity: xpToastOpacity,
            shadowColor: LEGACY_GOLD, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12,
          }}
          pointerEvents="none"
        >
          <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: tokens.color.textInverse, fontWeight: '900', fontSize: 14, letterSpacing: 1.5 }}>{xpToast}</Text>
        </Animated.View>
      )}

      {/* Rest-from-score undo toast — location-bearing, one-tap undo (§1.5 Law A). */}
      {restUndo && (
        <Animated.View
          style={{
            position: 'absolute', bottom: 96, left: 20, right: 20,
            backgroundColor: tokens.color.surfaceElevated,
            borderWidth: 1, borderColor: tokens.color.luminousEdge,
            borderRadius: 16, paddingHorizontal: 18, paddingVertical: 14,
            flexDirection: 'row', alignItems: 'center', gap: 12,
            opacity: restUndoOpacity,
          }}
          // Only the UNDO button captures touches; the bar doesn't block taps
          // beneath it for its 6s lifetime.
          pointerEvents="box-none"
        >
          <Text style={{ flex: 1, color: tokens.color.textSecondary, fontSize: 14 }}>
            {`Resting ${restUndo.title}. It left Today’s Habits.`}
          </Text>
          <Pressable
            onPress={handleRestUndo}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Undo. Bring ${restUndo.title} back to Today's Habits.`}
          >
            <Text style={{ color: tokens.color.teal, fontSize: 13, fontWeight: '700', letterSpacing: 1.5 }}>UNDO</Text>
          </Pressable>
        </Animated.View>
      )}

      {/* Level Up Modal */}
      <Modal visible={showLevelUpModal} transparent animationType="none">
        <Pressable
          style={[styles.modalBackdrop, { justifyContent: 'center', alignItems: 'center' }]}
          onPress={() => setShowLevelUpModal(false)}
          accessibilityRole="button"
          accessibilityLabel={`Level up. You reached level ${levelUpLevel}.`}
          accessibilityHint="Double tap to close"
        >
          <Animated.View style={{ alignItems: 'center', opacity: levelUpOpacity, transform: [{ scale: levelUpScale }] }}>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 48, marginBottom: 16 }}>⚡</Text>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 48, fontWeight: '900', letterSpacing: 8, marginBottom: 8 }} maxFontSizeMultiplier={DISPLAY_MAX_FONT_SCALE}>LEVEL UP</Text>
            <View style={{ width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: GOLD, justifyContent: 'center', alignItems: 'center', marginBottom: 16, backgroundColor: tokens.color.void }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 56, fontWeight: '900' }} maxFontSizeMultiplier={DISPLAY_MAX_FONT_SCALE}>{levelUpLevel}</Text>
            </View>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: TEXT, fontSize: 16, fontWeight: '700', letterSpacing: 2, marginBottom: 8 }}>YOU REACHED LEVEL {levelUpLevel}</Text>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 13, letterSpacing: 1, marginBottom: 24 }}>Keep building. Keep earning.</Text>
            <PrimaryPill
              onPress={() => setShowLevelUpModal(false)}
              accessibilityLabel="Continue"
            >
              CONTINUE
            </PrimaryPill>
          </Animated.View>
        </Pressable>
      </Modal>

      {/* Badge Unlock Toast */}
      {showBadgeToast && badgeToastData && (
        <Animated.View
          style={{
            position: 'absolute', top: 80, alignSelf: 'center',
            backgroundColor: tokens.color.void, borderWidth: 2, borderColor: GOLD,
            borderRadius: 20, paddingHorizontal: 24, paddingVertical: 14,
            opacity: badgeToastOpacity, flexDirection: 'row', alignItems: 'center', gap: 12,
            shadowColor: GOLD, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 16,
          }}
          pointerEvents="none"
        >
          <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 28 }}>{badgeToastData.icon}</Text>
          <View>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2 }}>BADGE UNLOCKED</Text>
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: TEXT, fontSize: 14, fontWeight: '700', marginTop: 2 }}>{badgeToastData.title}</Text>
          </View>
        </Animated.View>
      )}

      {/* Streak Share Overlay */}
      {shareStreakData && (
        <View style={{ position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center' }}>
          <View style={{ backgroundColor: tokens.color.void, borderWidth: 1, borderColor: GOLD, borderRadius: 20, paddingHorizontal: 24, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2 }}>MILESTONE</Text>
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: TEXT, fontSize: 15, fontWeight: '700', marginTop: 2 }}>
                {shareStreakData.reps} reps of {stripEmoji(shareStreakData.title)}
              </Text>
            </View>
            <PrimaryPill
              onPress={async () => {
                try {
                  await Share.share({
                    message: `${shareStreakData.reps} reps of "${stripEmoji(shareStreakData.title)}" in Nexus. Cumulative, and a miss takes none of it away.`,
                  });
                } catch {}
                setShareStreakData(null);
              }}
              size="compact"
              accessibilityLabel="Share milestone"
            >
              SHARE
            </PrimaryPill>
            <Pressable onPress={() => setShareStreakData(null)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: MUTED, fontSize: 16 }} accessibilityElementsHidden importantForAccessibility="no">✕</Text>
            </Pressable>
          </View>
        </View>
      )}
      <StatusBarScrim />
    </>
  );
}

// FIXME(nex-56): home-screen.tsx Phase 2A — StyleSheet block. ~120 lines of styles with heavy off-scale fontSize (sizes 7-28 with weights 600-900), semantic color tints (gold-dark/green-dark/red-dark/yellow-dark for intention/nightly/reflection/streak/deadWeight cards), off-spec accent colors (#A0D4A0/#A0C4E8/#44AAFF/#FF5252) with no token equivalents. Surface-pass NEX-48 (Home tab visual pass) is the right place to resolve these. Inline JSX styles still pending in Phase 2B+.
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent'},
  // FIXME(nex-56): off-scale 70pt paddingTop + 22pt horiz + 120pt bottom — design review
  scroll: { paddingTop: 70, paddingHorizontal: 22, paddingBottom: 120 },
  header: { marginBottom: tokens.spacing.lg },
  // NEX-48 §11.1: greeting at titleScreen (28pt Inter SemiBold). Spec is 24pt but
  // existing 26pt reads fine; rounding to titleScreen keeps it on the type scale.
  greeting: { ...tokens.type.titleScreen, color: TEXT },
  // NEX-48 §11.1: date in caption + text.muted.
  date: { ...tokens.type.caption, color: MUTED, marginTop: tokens.spacing.xxs },
  // NEX-48 Phase 1: hero ring sits centered with breathing room above & below.
  heroWrap: {
    alignItems: 'center',
    marginTop: tokens.spacing.xl,
    marginBottom: tokens.spacing.xl,
  },
  // NEX-48 Phase 5: standard margin between stacked Card primitives.
  // FIXME(nex-56): off-scale 14pt — design review (nearest md 16 or lg 24)
  cardSpacing: { marginBottom: 14 },
  // NEX-48 Phase 6: "UP NEXT" eyebrow inside the Today's Horizon card.
  // Tracked-caps gold per §11.1 two-level section/eyebrow pattern.
  horizonEyebrow: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.gold,
    marginBottom: tokens.spacing.xs,
  },
  // NEX-48 Phase 6.2: Left/Inbox status pills, plain-View treatment.
  // NEX-161: translucent surface bg + 1px luminous edge + 16pt radius. No
  // ambient glow — these are compact functional indicators, not major surfaces.
  // FIXME(nex-56): off-scale 14pt margin — design review (nearest md 16 or lg 24)
  statusRow: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    marginBottom: 14,
  },
  // FIXME(nex-56): off-scale 14pt paddingVertical — design review
  statusCard: {
    flex: 1,
    backgroundColor: SURFACE,
    borderRadius: tokens.radii.lg,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    paddingVertical: 14,
    paddingHorizontal: tokens.spacing.md,
    alignItems: 'center',
  },
  // FIXME(nex-56): 22pt is between numericMd (18pt) and numericDisplay (36pt) —
  // pre-redesign size that reads cleanly in compact pills. Design review for
  // type-scale alignment in Phase 7+.
  statusValue: {
    fontFamily: tokens.font.plexMonoMedium,
    /* FIXME(nex-56): inline fontSize literal — design review */
    fontSize: 22,
    fontWeight: '500',
    letterSpacing: -0.5,
    color: tokens.color.gold,
  },
  // §5.1 labelTrackedSm: 11pt Inter SemiBold +0.18em uppercase muted.
  statusTitle: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.xs,
  },
  // NEX-196: Home echo chip. Frosted surface + luminous edge + ambient halo,
  // static (§1.4). Teal VIEW affordance = sacred-active jump.
  captureEcho: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: SURFACE,
    borderRadius: tokens.radii.lg,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    marginTop: tokens.spacing.sm,
    ...ambientGlowSoft,
  },
  captureEchoText: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
    flex: 1,
  },
  captureEchoAction: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.teal,
    marginLeft: tokens.spacing.sm,
  },
  // NEX-200: quiet one-off quick-add bar. Frosted/subordinate (mirrors the echo
  // chip), no gold accent — it must not compete with the alignment ring (§1.5
  // Law D). Teal ADD = the app's sacred-active CTA register (not gold).
  captureBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SURFACE,
    borderRadius: tokens.radii.lg,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    marginTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.lg,
    ...ambientGlowSoft,
  },
  capturePlus: {
    /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 20,
    color: MUTED,
    marginRight: tokens.spacing.sm,
  },
  captureInput: {
    flex: 1,
    ...tokens.type.bodyMd,
    color: TEXT,
    padding: 0,
  },
  captureAdd: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.teal,
    marginLeft: tokens.spacing.sm,
  },
  // §5.1 labelTrackedMicro: 9.5pt for the "23 TOTAL" footnote.
  statusSubtitle: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.xxs,
  },
  // NEX-48 Phase 4.1: dropped the standalone THIS WEEK entry card styles —
  // the Weekly Debrief card now doubles as the entry point.
  // NEX-48 Phase 3.1: long-press affordance hint at the top of the habit list.
  // Sits inside the habits card, above the first HabitRow. Tracked-caps to
  // match the section-label register, but at the smaller `Sm` size so it reads
  // as helper text not a section header.
  // NEX-48 Phase 3.2: centered. Previous left-aligned version wrapped "DELETE"
  // onto its own line which read as a typo. Centered keeps the second line
  // visually balanced when the copy is long.
  habitListHint: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
    marginBottom: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg, // align with HabitRow's row padding
    textAlign: 'center',
  },
  // NEX-199: the labeled "+N MORE" / "SHOW LESS" disclosure toggle for the
  // Today's Habits cap. ≥44pt tap target via paddingVertical + hitSlop.
  habitsMoreToggle: {
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    alignItems: 'center',
  },
  habitsMoreToggleText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
  },
  // FIXME(nex-56): off-scale 14pt margin + 12pt padding — design review
  xpBar: { marginTop: 14, backgroundColor: tokens.color.surfaceSunken, borderRadius: 12, padding: tokens.spacing.sm, borderWidth: 1, borderColor: tokens.color.goldHairline },
  xpTrack: { height: 4, backgroundColor: tokens.color.surfaceElevated, borderRadius: 2, overflow: 'hidden' },
  xpFill: { height: '100%', backgroundColor: GOLD, borderRadius: 2 },
  // v3 stellar: was #0A0A00 (gold-tinted dark) + #2A2500 (gold-tint border).
  // Retoned to translucent dark surface (lets cosmos show through behind)
  // + luminous white hairline. The intention card now reads as a cosmic
  // glass surface, not a gold-tinted paper note.
  intentionCard: { backgroundColor: tokens.color.surface, borderRadius: 18, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: 18, marginBottom: 14, ...ambientGlowSoft },
  // v3 stellar: completed-state used a slightly different gold-tint
  // (#1F1A00). Now uses surfaceSunken + the same luminous border for a
  // subtler "completed" feel without the warm-paper register.
  intentionCardCompleted: { backgroundColor: tokens.color.surfaceSunken, borderColor: tokens.color.goldHairline },
  // v3 stellar: intention text was GOLD — the user's daily statement of
  // intent is *theirs*, not an earned ornament. Shifted to TEXT (pure
  // white) per v3 thesis. Gold reserved for accents <5% per screen.
  intentionText: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 16, fontWeight: '600', lineHeight: 24 },
  // FIXME(nex-56): off-scale 14pt margin — design review
  // FIXME(nex-56): off-scale 14pt fontSize + 6pt margin — design review
  // FIXME(nex-56): off-scale 6pt margin — design review
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  // FIXME(nex-56): off-scale 11pt fontSize + 2pt margin — design review
  // FIXME(nex-56): off-scale 18pt fontSize — design review
  // FIXME(nex-56): off-scale gap 10 + 14pt margin — design review
  // FIXME(nex-56): off-scale 14pt padding — design review
  // FIXME(nex-56): off-scale 22pt fontSize — design review
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  // FIXME(nex-56): off-scale 8pt fontSize — design review
  // FIXME(nex-56): off-scale 8pt fontSize — design review
  // FIXME(nex-56): off-scale 14pt margin — design review
  card: { backgroundColor: SURFACE, borderRadius: 20, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: tokens.spacing.lg, marginBottom: 14, ...ambientGlowSoft },
  // FIXME(nex-56): green-dark tint bg #080A08 + border #1A2A1A (nightly card semantic), no tokens — design review
  // FIXME(nex-56): off-scale 9pt fontSize + 10pt margin — design review
  sectionLabel: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 9, fontWeight: '900', letterSpacing: 3, marginBottom: 10 },
  // FIXME(nex-56): off-scale 18pt fontSize — design review
  nextEventTitle: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 18, fontWeight: '600' },
  // FIXME(nex-56): off-scale 13pt fontSize + 6pt margin — design review
  nextEventTime: { color: GOLD, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, marginTop: 6, fontWeight: '600' },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  mutedText: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 14 },
  // v3 stellar: was generic mint #A0D4A0 (no token, off-palette green).
  // Nightly carry-forward = success/done semantic → teal in v3.
  nightlyText: { color: tokens.color.teal, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 14, lineHeight: 22 },
  // FIXME(nex-56): blue accent #A0C4E8 (reflection text), no token — design review
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  editLink: { color: GOLD, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 9, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): off-scale 10pt margin — design review
  anchorRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  // FIXME(nex-56): off-scale 15pt fontSize — design review
  anchorText: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 15, lineHeight: 22 },
  // FIXME(nex-56): off-scale 15pt fontSize — design review
  anchorInput: { color: GOLD, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 15, borderBottomWidth: 1, borderBottomColor: BORDER, paddingVertical: tokens.spacing.xs, lineHeight: 22 },
  // FIXME(nex-56): off-scale 14pt margin + 10pt gap — design review
  anchorActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14, gap: 10 },
  // FIXME(nex-56): off-scale 10pt radius — design review
  cancelBtn: { paddingVertical: tokens.spacing.xs, paddingHorizontal: tokens.spacing.md, borderRadius: 10, borderWidth: 1, borderColor: BORDER },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  cancelBtnText: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  // FIXME(nex-56): off-scale 10pt radius — design review
  saveBtn: { paddingVertical: tokens.spacing.xs, paddingHorizontal: tokens.spacing.md, borderRadius: 10, backgroundColor: GOLD },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  saveBtnText: { color: tokens.color.textInverse, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  // FIXME(nex-56): off-scale 18pt paddingVertical — design review
  ctaButton: { backgroundColor: GOLD, borderRadius: 30, paddingVertical: 18, alignItems: 'center', marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  ctaText: { color: tokens.color.textInverse, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, fontWeight: '900', letterSpacing: 3 },
  // Daily score
  // FIXME(nex-56): off-scale 14pt margin — design review
  // FIXME(nex-56): off-scale 28pt fontSize — design review
  scoreNum: { /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 28, fontWeight: '900', letterSpacing: -1 },
  // FIXME(nex-56): off-scale 7pt fontSize + 2pt margin — design review
  scoreLabel: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 7, fontWeight: '900', letterSpacing: 2, marginTop: 2 },
  // FIXME(nex-56): off-scale 3pt height + 6pt margin — design review
  // FIXME(nex-56): off-scale 8pt fontSize — design review
  // Score breakdown modal
  breakdownRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: tokens.spacing.md, borderBottomWidth: 1, borderBottomColor: BORDER },
  breakdownLeft: { flex: 1 },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  breakdownTitle: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  breakdownDetail: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, lineHeight: 18 },
  // FIXME(nex-56): off-scale gray #555 + 13pt fontSize — design review
  breakdownMissed: { color: GRAY_555, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, fontStyle: 'italic' },
  // FIXME(nex-56): off-scale 22pt fontSize — design review
  breakdownPts: { /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 22, fontWeight: '900', marginLeft: tokens.spacing.md, width: 50, textAlign: 'right' },
  // FIXME(nex-56): off-scale gray #333 + 10pt fontSize + 20pt margin — design review
  breakdownHint: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 10, textAlign: 'center', marginTop: 20, letterSpacing: 1 },
  // Habit-management modal styles live in manage-habits-modal.tsx; only the
  // launcher's link styling stays on Home.
  // FIXME(nex-56): off-scale 28pt paddingHorizontal + 10pt margin + 22pt marginBottom — design review
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  // FIXME(nex-56): off-scale 16pt fontSize — design review
  // FIXME(nex-56): off-scale 14pt padding — design review
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  // FIXME(nex-56): off-scale 12pt fontSize + 17pt lineHeight — design review
  // FIXME(nex-56): negative margin -20 (full-bleed override) — design review
  // FIXME(nex-56): off-scale 20pt paddingHorizontal — design review
  // FIXME(nex-56): off-scale 18pt padding — design review
  // FIXME(nex-56): neutral border #1E1E1E, no token (CLAUDE.md §6.2 wants gold hairline) — design review
  // FIXME(nex-56): off-scale 16pt fontSize + 6pt margin — design review
  // FIXME(nex-56): off-scale 12pt fontSize — design review
  // FIXME(nex-56): blue accent #44AAFF (done-state habit title), no token — design review
  // FIXME(nex-56): off-scale 10pt fontSize + 6pt margin — design review
  // FIXME(nex-56): off-scale gap 10 + 14pt margin — design review
  // FIXME(nex-56): yellow-dark tint bg #0A0800 + border #2A2000 (streak chip semantic), no tokens; off-scale 14pt padding — design review
  // FIXME(nex-56): off-scale 24pt fontSize — design review
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  // Weekly wins
  // FIXME(nex-56): off-scale gap 10 + 10pt margin — design review
  winRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  // FIXME(nex-56): off-scale 8pt fontSize — design review
  winDot: { color: GOLD, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 8, marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 14pt fontSize + 21pt lineHeight — design review
  winText: { flex: 1, color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 14, lineHeight: 21 },
  // THIS WEEK card uses the inline chart/KPI styles from the restored
  // weeklyStats render (no dedicated text styles — the card is the chart now).
  // Dead weight
  // FIXME(nex-56): red-dark tint bg #0A0808 + border #2A1A1A (dead-weight semantic card), no tokens — design review
  // FIXME(nex-56): red-dark tint divider #1A1010, no token — design review
  // v3 stellar: divider was #1A1010 (red-warmth tint, matching the
  // retired red-dark dead-weight card). Card is now gold-accented and
  // sits on frosted glass; divider follows the new luminous hairline.
  // NEX-201: single-child row now (title only; the age counter was removed), so
  // justifyContent:'space-between' was dropped as inert.
  deadWeightRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: tokens.spacing.xs, borderBottomWidth: 1, borderBottomColor: tokens.color.goldHairline },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  deadWeightText: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, flex: 1 },
  // NEX-201: red day-counter ("Nd") removed — a calm decision surface never
  // counts an absence (§1.5 Law C). Aging is conveyed by oldest-first order.
  // NEX-162 Lead-Time Radar (Home card)
  leadTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: tokens.spacing.xs },
  leadTimeCheck: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.25, borderColor: MUTED },
  leadTimeWhen: { color: tokens.color.text, fontSize: 15, fontWeight: '600' },
  leadTimeAction: { color: tokens.color.textSecondary, fontSize: 13, marginTop: 2 },
  leadTimeMore: { color: GOLD, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, paddingVertical: tokens.spacing.xs },
  // NEX-201: bumped from near-invisible GRAY_444/10pt to a legible muted tier —
  // a calm decision surface must stay readable (object permanence). FIXME(nex-56):
  // inline 12pt fontSize literal — design review.
  deadWeightHint: { color: tokens.color.textMuted, fontSize: 12, marginTop: 10, letterSpacing: 0.5 },

  // NEX-202: mandate echo beneath a habit. Sits on the cosmos below the card,
  // so the text carries the §4.11 floating-text shadow for contrast. Fraunces
  // italic (identity voice, §5.3). REMOVE ECHO is the one-tap sever.
  // NEX-209: the if-then cue line under a habit. Teal (initiation), matching the
  // echo's under-card containment; on the cosmos, so it carries the §4.11 shadow.
  cueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.sm,
    gap: tokens.spacing.xs,
  },
  cueMarker: {
    color: tokens.color.teal,
    fontSize: 13,
    fontWeight: '700',
    // §4.11 floating-text shadow (token) — the cue line floats on the cosmos.
    textShadowColor: tokens.color.floatingTextShadow,
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  cueText: {
    flex: 1,
    color: tokens.color.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    // §4.11 floating-text shadow (token) — the cue line floats on the cosmos.
    textShadowColor: tokens.color.floatingTextShadow,
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  mandateEchoWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  mandateEchoText: {
    ...tokens.type.poeticSm,
    color: tokens.color.textSecondary,
    flex: 1,
    // FIXME(nex-56): §4.11 floating-text shadow rgba(0,0,0,0.55) — the spec's
    // canonical literal (align.tsx hint/moreToggleText use the same); closest
    // token material.shadow.floating uses 0.45. Tokenize in the nex-56 pass.
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  mandateEchoRemove: {
    paddingVertical: tokens.spacing.xxs,
    paddingHorizontal: tokens.spacing.xxs,
  },
  mandateEchoRemoveText: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.textMuted,
    // FIXME(nex-56): §4.11 floating-text shadow rgba(0,0,0,0.55) — see mandateEchoText.
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  // FIXME(nex-56): black-alpha modal scrim + off-scale 28pt padding — design review
  // v3 stellar: modal scrim was pure black @ 85%. CLAUDE.md §4.8
  // gradient.vignette pattern uses voidDeep at 75%; slightly warmer-cool
  // than pure black and lets a faint cosmic halo bleed through at the
  // edges instead of a hard cold cut-out.
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(2,2,8,0.78)', justifyContent: 'center', padding: 28 },
  // FIXME(nex-56): off-scale 28pt padding — design review
  modalCard: { backgroundColor: tokens.color.surfaceElevated, borderRadius: 24, padding: 28, borderWidth: 1, borderColor: tokens.color.luminousEdge, ...ambientGlow },
  // FIXME(nex-56): off-scale 16pt fontSize — design review
  modalTitle: { color: GOLD, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 16, fontWeight: '900', letterSpacing: 6, textAlign: 'center', marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  modalSubtitle: { color: MUTED, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 13, textAlign: 'center', marginBottom: tokens.spacing.lg, letterSpacing: 0.3 },
  // FIXME(nex-56): off-scale 16pt fontSize + 28pt margin — design review
  modalInput: { color: TEXT, /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 16, borderBottomWidth: 1, borderBottomColor: BORDER, paddingVertical: tokens.spacing.sm, marginBottom: 28, lineHeight: 24 },
});
