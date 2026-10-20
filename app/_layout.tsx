// @ts-nocheck
import { Stack, useRouter, usePathname } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { PostHogProvider, usePostHog } from 'posthog-react-native';

// Keep the native splash visible until JS is ready to render.
SplashScreen.preventAutoHideAsync().catch(() => {});
import { useAppState, localStoreHasUserData } from '../src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import { isActivatedBeforeReorder, scopedDeviceFlagKey, LEGACY_FREE_USER_KEY, LAUNCH_PAYWALL_DISMISSED_KEY } from '../src/state/legacy-grandfather';
import { areNudgesSilenced } from '../src/state/pause-mode';
import { useRemindersStore } from '../src/state/reminders-store';
import React, { useState, useEffect, useRef } from 'react';
import * as Font from 'expo-font';
import * as Device from 'expo-device';
import tokens from '../src/theme/tokens';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// ─── Simulator dev bypass ──────────────────────────────────────────────────────
// Active ONLY when __DEV__ is true AND running in the iOS Simulator.
// Never active on a real device, in TestFlight, or in production.
const SIM_BYPASS = __DEV__ && !Device.isDevice;
const SIM_USER_ID = 'sim-dev-user';
import {
  View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, useWindowDimensions,
  AppState, AppStateStatus, Linking, Alert, Modal,
} from 'react-native';
import { syncWidgetAfterMutation } from '../src/widgets/widget-bridge';
import { drainWidgetCompletions } from '../src/widgets/widget-completion-drain';
import { refreshCalendarWindowIntoStore } from '../src/services/calendar-events';
import { onActivation } from '../src/services/nexus-profiles';
import {
  trackEvent,
  ensureBaselineCohortRecord,
  setPostHogClient,
  ensureFirstLaunchRecorded,
  sendInstallRecordedToPostHog,
  backfillFunnelEventsToPostHog,
  setAnalyticsReplaySuppressed,
} from '../src/services/analytics';
import {
  generateOnboardingRecommendations,
  regenerateMandateOnly,
  regenerateHabit as regenerateHabitService,
  regenerateTodo as regenerateTodoService,
  regenerateMandateDownstream as regenerateMandateDownstreamService,
  type ReflectionInput,
  type RecommendationSet,
  type RecommendationResult,
} from '../src/services/pulse-recommendations';
import type { OnboardingRecommendations } from '../src/state/app-state';
import ReflectionFlow from '../src/features/onboarding/reflection-flow';
import PreparingInterstitial from '../src/features/onboarding/preparing-interstitial';
import { NexusSplash } from '../src/components/ui/NexusSplash';
import ReviewScreen from '../src/features/onboarding/review-screen';
import RetryScreen, { type RetryReason } from '../src/features/onboarding/retry-screen';
import FirstWinCapture, { FIRST_WIN_DONE_KEY } from '../src/features/onboarding/first-win-capture';
import { buildOnboardingTimingProps } from '../src/features/onboarding/build-first-win-emit-props';
import Moment5Screen from '../src/features/onboarding/moment-5-screen';
import { INSPIRE_SCREENS } from '../src/utils/onboarding';
import { startActivationTracker } from '../src/services/activation-tracker';
import { publicConfigValue } from '../src/utils/public-config';
import {
  markDevSkipSession,
  clearDevSkipSession,
  isDevSkipSessionActive,
} from '../src/utils/dev-skip-session';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { haptic } from '../src/utils/haptics';
import { PrimaryPill } from '../src/components/ui/PrimaryPill';
import * as Notifications from 'expo-notifications';
import {
  scheduleAllNotifications,
  getNotificationRoute,
  requestNotificationPermission,
  reconcileLeadTimeNotifications,
  reconcileBillingReminders,
  reconcileReminderNotifications,
  reconcileTrialNudges,
  registerNotificationCategories,
  dismissReminderNotification,
  REMINDER_ACTION,
} from '../src/services/notifications';
import { generateQuotesIntoPool } from '../src/ai/notification-quote-generation';
import { mandateContext } from '../src/ai/notification-mandate-context';
import { resolveQuietWindow } from '../src/utils/notification-quiet-hours';
import { AuthScreen } from '../src/features/auth/auth-screen';
import { supabase, isSupabaseConfigured } from '../src/services/supabase';
import { deferredAuthListener } from '../src/services/auth-listener';
import { addAppBreadcrumb } from '../src/utils/breadcrumbs';
import { clearCloudSyncMetadata } from '../src/services/cloud-sync-guard';
import { restoreFromCloud, startCloudSync, requestCloudPull, flushCloudSync } from '../src/services/cloud-sync';
import { beginSyncSession, getSyncSession, stopSyncSession } from '../src/services/sync-session';
import { createSyncAuthLifecycle } from '../src/services/sync-auth-lifecycle';
import { isAccountDeletionPending } from '../src/services/sync-account-deletion';
import { startUserStateRealtime, stopUserStateRealtime } from '../src/services/realtime-sync';
import { drainConnectorActions, getConnectorDeviceId } from '../src/services/connector-actions';
import { setForceSignOutHandler } from '../src/services/sign-out';
import { configureRevenueCat, checkSubscription, identifyUser, onCustomerInfoUpdated, getCancelFlowStatus, projectBillingReminderInfo, projectTrialNudgeInfo } from '../src/services/revenuecat';
import { checkAndSendWeeklySummary } from '../src/services/weekly-email';
import { RemotePaywallScreen } from '../src/features/paywall/remote-paywall-screen';
import { usePaywallReoffer } from '../src/features/paywall/use-paywall-reoffer';
import { isInternalUser } from '../src/services/internal-accounts';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { StarField } from '../src/components/ui/StarField';
import { FilmGrain } from '../src/components/ui/FilmGrain';
// ScrimOverlay was imported here as a separate layer above StarField but
// dimmed the twinkle dots along with the galaxy. Removed — the same
// gradient now lives INSIDE StarField between the galaxy photo and the
// twinkles, so only the photo gets dimmed.
import { OnboardingProvider } from '../src/onboarding/onboarding-context';
import { OnboardingOverlay } from '../src/onboarding/onboarding-overlay';
import { TriageFlow } from '../src/features/reminders/triage-flow';
import AnalyticsConsentSheet from '../src/features/settings/analytics-consent-sheet';
import EmailOptInSheet from '../src/features/settings/email-opt-in-sheet';
import SmsOptInSheet from '../src/features/settings/sms-opt-in-sheet';
import { useTriageStore } from '../src/state/triage-store';
import { getLocalDateKey } from '../src/utils/recurrence';
import { addDaysToKey } from '../src/state/lead-time-types';
import { todayWisdomForNotification, wisdomForNotificationDate } from '../src/features/wisdom/wisdom-quotes';
import { classifyOpen } from '../src/services/north-star-metrics';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { ornamentMayAnimate } from '@/src/utils/reduce-motion-policy';
import { useBreakpoints } from '../src/theme/layout';
import { AdaptiveScreen } from '../src/components/ui/AdaptiveScreen';

// No module-scope Dimensions.get('window') here — a static read never updates
// on rotation/resize. InspireScreen's bgAccent geometry is computed from
// useWindowDimensions() inside the component instead.

// NEX-142: the cloud-merge on sign-in used to gate on the `isActivated` closure
// value, which is the default `false` at mount because persist rehydration from
// AsyncStorage is async — so the guard let a stale cloud snapshot overwrite
// fresh local data on essentially every launch for already-activated users.
// Wait for hydration first (mirrors refreshCalendarWindowIntoStore in
// calendar-events.ts), then read state live. The "is this install empty?"
// decision uses localStoreHasUserData from app-state.ts so the seed gate and
// mergeCloudState's own guard can never drift.
async function waitForAppStateHydration(timeoutMs = 4000): Promise<void> {
  const persistApi = useAppState.persist;
  if (!persistApi || typeof persistApi.hasHydrated !== 'function') return;
  if (persistApi.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const unsub =
      typeof persistApi.onFinishHydration === 'function'
        ? persistApi.onFinishHydration(finish)
        : undefined;
    // Safety cap: a hydration event that never fires must not hang sign-in.
    setTimeout(() => {
      try { unsub?.(); } catch {}
      finish();
    }, timeoutMs);
  });
}

const GOLD = tokens.color.gold;
// FIXME(nex-56): page background uses bare-black; table maps to textInverse (text-use) — design review (per orbit.tsx + align.tsx + mandate + review-screen + reflection-flow precedent)
// FIXME(nex-56): 444 off-scale gray for TextInput placeholder, no token — design review (matches PLACEHOLDER_COLOR_DARK pattern from d403ff4/5082e4d/997148f/53ce758/921eb7c)
const PLACEHOLDER_COLOR_DARK = tokens.color.textDisabled;

// NEX-26 phase E: MANDATE_PRESETS, HABIT_PRESETS, and STARTER_HABITS
// are gone. The new flow extracts mandates from the user's reflection
// via Pulse — no preset chips, no generic seeding. See
// src/features/onboarding/reflection-flow.tsx and
// src/services/pulse-recommendations.ts.
//
// NEX-35: CURATED_DEFAULTS removed. When Pulse fails, the user lands
// on RetryScreen instead of silently absorbing curated placeholder
// content. No fake recommendations, ever.

// Inspire-screen data lives in src/utils/onboarding.ts so it's
// testable from vitest without the React Native render path.

// Ring-tint presets surfaced in the quick-win step. Stored on
// userProfile.ringTint and read by the alignment-ring component on
// Home. Kept as a small fixed set so the choice feels deliberate.
// All three preset values map cleanly to canonical color tokens —
// the palette is three picks from the token system rather than a
// divergent set, so no design-review FIXME is needed.
const RING_TINT_PRESETS: Array<{ id: 'gold' | 'teal' | 'amber'; hex: string; label: string; sub: string }> = [
  { id: 'gold',  hex: tokens.color.gold,  label: 'Gold',  sub: 'Earned ornament. The default.' },
  { id: 'teal',  hex: tokens.color.teal,  label: 'Teal',  sub: 'Sacred active. Voice of the app.' },
  { id: 'amber', hex: tokens.color.amber, label: 'Amber', sub: 'Rare warmth. For earned moments.' },
];

// ─── Single Inspirational Screen ─────────────────────────────────────────────
function InspireScreen({ data, onNext, isLast }: { data: any; onNext: () => void; isLast: boolean }) {
  const fadeOpacity = useSharedValue(0);
  const slideY = useSharedValue(30);
  // Live window size for the bgAccent geometry (was a module-scope
  // Dimensions.get, which never updates on rotation/resize).
  const { width: screenW, height: screenH } = useWindowDimensions();
  // Onboarding content joins the adaptive column on wide viewports.
  const { isWide, contentMaxWidth } = useBreakpoints();
  // The 30pt rise is ornament on top of the fade. Under Reduce Motion the
  // screen still fades in, it just does not travel. Gated on
  // `ornamentMayAnimate` so an unresolved or failed preference read also
  // stays still. Content is at opacity 0 until the effect runs, so setting
  // slideY to 0 here is never visible as a jump.
  const inspireMayRise = ornamentMayAnimate(useReduceMotion());

  useEffect(() => {
    fadeOpacity.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
    slideY.value = inspireMayRise
      ? withTiming(0, { duration: 600, easing: Easing.out(Easing.cubic) })
      : 0;
  }, [fadeOpacity, slideY, inspireMayRise]);

  const contentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: fadeOpacity.value,
    transform: [{ translateY: slideY.value }],
  }));

  return (
    <View style={isStyles.screen}>
      {/* Subtle background pattern */}
      <View style={[isStyles.bgAccent, {
        top: -screenH * 0.3, right: -screenW * 0.3,
        width: screenW * 0.8, height: screenW * 0.8,
        borderRadius: screenW * 0.4,
      }]} />

      <Animated.View style={[isStyles.content, isWide && { maxWidth: contentMaxWidth }, contentAnimatedStyle]}>
        {/* Icon */}
        <Text
          style={[isStyles.icon, { color: data.accent }]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {data.icon}
        </Text>

        {data.quote && (
          <>
            <Text style={isStyles.quote}>{data.quote}</Text>
            <Text style={isStyles.sub}>{data.sub}</Text>
          </>
        )}

        {data.headline && !data.cta && (
          <>
            <Text style={[isStyles.headline, { color: data.accent }]}>{data.headline}</Text>
            {data.body && <Text style={isStyles.body}>{data.body}</Text>}
            {data.stats && (
              <View style={isStyles.statsRow}>
                {data.stats.map((s: any, i: number) => (
                  <View key={i} style={isStyles.statItem}>
                    <Text style={[isStyles.statValue, { color: data.accent }]}>{s.value}</Text>
                    <Text style={isStyles.statLabel}>{s.label}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        {data.cta && (
          <>
            <Text style={[isStyles.ctaHeadline, { color: data.accent }]}>{data.headline}</Text>
            <Text style={isStyles.sub}>{data.sub}</Text>
          </>
        )}

        <Pressable
          style={[isStyles.btn, { marginTop: data.cta ? 60 : 40 }]}
          onPress={() => { haptic('dragDrop'); onNext(); }}
          accessibilityRole="button"
          accessibilityLabel={isLast ? 'Begin' : 'Continue'}
        >
          <Text style={isStyles.btnText}>{isLast ? 'BEGIN →' : 'CONTINUE →'}</Text>
        </Pressable>
      </Animated.View>

      {/* Bottom dot indicator — will be rendered in parent */}
    </View>
  );
}

// FIXME(nex-56): runtime gold-alpha compositions (GOLD + '06' for bgAccent,
// GOLD + '15' for btn background) produce gold-tint strings at runtime. The
// base token migrates via the GOLD const; the alpha suffixes themselves are
// not hex literals and stay as-is. Surface-pass should propose gold-alpha
// tint tokens to replace these.
const isStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center', padding: 30 /* FIXME(nex-56): off-scale spacing 30 — between lg(24) and xl(32), review */ },
  bgAccent: {
    position: 'absolute',
    // Geometry (top/right/width/height/borderRadius) is dynamic — computed
    // from useWindowDimensions() in InspireScreen.
    // FIXME(nex-56): runtime gold-alpha composition (GOLD + '06'); see top-of-block FIXME above
    backgroundColor: GOLD + '06',
  },
  content: { alignItems: 'center', width: '100%' },
  // FIXME(nex-56): off-scale fontSize 48 (decorative icon emoji), design review
  icon: { fontSize: 48, marginBottom: tokens.spacing.xl, opacity: 0.9 },
  // FIXME(nex-56): fontSize 22 matches titleSection/poeticMd size but italic + fontWeight '300' diverge from token defaults — design review
  quote: { color: tokens.color.text, fontSize: 22, fontWeight: '300', textAlign: 'center', lineHeight: 34, fontStyle: 'italic', marginBottom: tokens.spacing.md },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): fontSize 15 matches bodyMd size but lineHeight 22 token match; no fontFamily set (default ≠ Inter-Regular) — design review
  sub: { color: tokens.color.textMuted, fontSize: 15, textAlign: 'center', lineHeight: 22, marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale fontSize 20 (headline), design review
  headline: { fontSize: 20, fontWeight: '900', letterSpacing: 4, textAlign: 'center', marginBottom: tokens.spacing.md },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): fontSize 15 matches bodyMd size but lineHeight 24 ≠ token 22; no fontFamily set — design review
  body: { color: tokens.color.textMuted, fontSize: 15, textAlign: 'center', lineHeight: 24, paddingHorizontal: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  statsRow: { flexDirection: 'row', gap: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, marginVertical: 30 /* FIXME(nex-56): off-scale spacing 30 — review */ },
  statItem: { alignItems: 'center' },
  // FIXME(nex-56): off-scale fontSize 32 (stat value display), design review
  statValue: { fontSize: 32, fontWeight: '900', letterSpacing: 1 },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 11, design review
  statLabel: { color: tokens.color.textMuted, fontSize: 11, letterSpacing: 1, marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale fontSize 28 (cta headline display), design review
  ctaHeadline: { fontSize: 28, fontWeight: '900', letterSpacing: 4, textAlign: 'center', lineHeight: 40 },
  btn: {
    borderWidth: 1, borderColor: GOLD, borderRadius: 30,
    paddingVertical: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, paddingHorizontal: 40 /* FIXME(nex-56): off-scale spacing 40 — review */,
    // FIXME(nex-56): runtime gold-alpha composition (GOLD + '15'); see top-of-block FIXME above
    backgroundColor: GOLD + '15',
  },
  // FIXME(nex-56): fontSize 13 matches labelTrackedLg size but fontWeight '900' ≠ token '600' — design review (no bulk weight shift per migration rule)
  btnText: { color: GOLD, fontSize: 13, fontWeight: '900', letterSpacing: 3 },
});

// ─── Notification Permission Screen ──────────────────────────────────────────
function NotificationPermScreen({ onNext }: { onNext: () => void }) {
  const fadeOpacity = useSharedValue(0);
  // Onboarding content joins the adaptive column on wide viewports.
  const { isWide, contentMaxWidth } = useBreakpoints();

  useEffect(() => {
    fadeOpacity.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
  }, [fadeOpacity]);

  const contentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: fadeOpacity.value,
  }));

  const handleAllow = async () => {
    await requestNotificationPermission();
    onNext();
  };

  return (
    <View style={{ flex: 1, backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center', padding: 30 /* FIXME(nex-56): off-scale spacing 30 — review */ }}>
      <Animated.View style={[{ alignItems: 'center', width: '100%' }, isWide && { maxWidth: contentMaxWidth }, contentAnimatedStyle]}>
        {/* FIXME(nex-56): off-scale fontSize 42 (decorative emoji icon), design review */}
        <Text style={{ fontSize: 42, marginBottom: tokens.spacing.xl, color: GOLD }}>🔔</Text>
        {/* FIXME(nex-56): fontSize 16 matches buttonPrimary size but fontWeight '900' ≠ token '600' — design review */}
        <Text style={{ color: GOLD, fontSize: 16, fontWeight: '900', letterSpacing: 4, marginBottom: tokens.spacing.md, textAlign: 'center' }}>STAY ON TRACK</Text>
        {/* FIXME(nex-56): fontSize 17 matches bodyLg size but lineHeight 26 token match; no fontFamily set (default ≠ Inter-Regular) — design review */}
        <Text style={{ color: tokens.color.text, fontSize: 17, textAlign: 'center', lineHeight: 26, marginBottom: tokens.spacing.sm }}>
          Nexus sends purposeful reminders to keep your day intentional.
        </Text>
        {/* FIXME(nex-56): tokens.color.textMuted off-scale gray — design review */}
        {/* FIXME(nex-56): fontSize 13 matches caption size but fontWeight default ≠ token '500' + lineHeight 20 ≠ token 18 — design review */}
        <Text style={{ color: tokens.color.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 50 /* FIXME(nex-56): off-scale spacing 50 — review */ }}>
          Morning intention • Evening check-in{'\n'}Milestone celebrations • Weekly summary
        </Text>
        <PrimaryPill fullWidth onPress={handleAllow} style={{ marginBottom: tokens.spacing.sm }}>
          ALLOW NOTIFICATIONS
        </PrimaryPill>
        <Pressable
          onPress={onNext}
          style={{ paddingVertical: tokens.spacing.sm }}
          accessibilityRole="button"
          accessibilityLabel="Not now"
        >
          {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray for 'Not now' — design review */}
          {/* FIXME(nex-56): off-scale fontSize 12, design review */}
          <Text style={{ color: tokens.color.textDisabled, fontSize: 12, letterSpacing: 1 }}>Not now</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

let _pendingOnboardingRoute: string | null = null;

// NEX-299: time-to-first-value instrumentation. Both keys mirror
// FIRST_WIN_DONE_KEY's read-gated/write-awaited/lifecycle-scoped pattern —
// read once at the same mount effect that fires onboarding_phase_started,
// persisted so they survive both a real kill AND RootLayoutInner's one-time
// hydration remount (PostHogProvider's key flip, ~line 1539, can remount
// OnboardingScreen too), and cleared at the same two lifecycle points
// FIRST_WIN_DONE_KEY uses: finishOnboarding() and the Settings replay reset
// (which uses the literal string, matching how it already clears
// 'nexus_firstWinCaptured' — see settings-screen.tsx).
const ONBOARDING_STARTED_KEY = 'nexus_onboardingStartedAtMs';
const ONBOARDING_BACKGROUNDED_KEY = 'nexus_onboardingBackgrounded';

// ─── Main Onboarding Screen ───────────────────────────────────────────────────
function OnboardingScreen() {
  const activateUser = useAppState((s) => s.activateUser);

  // phase: 'inspire' | 'notif' | 'setup'
  const [phase, setPhase] = useState<'inspire' | 'notif' | 'setup'>('inspire');
  const [inspireStep, setInspireStep] = useState(0);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [phoneCountry, setPhoneCountry] = useState('US');
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneError, setPhoneError] = useState('');
  // NEX-85 follow-up: side-step between name (step 0) and reflection
  // (step 1). Boolean instead of fractional step so we don't break
  // the existing integer step machine or its analytics-event numbers.
  const [showPhoneCapture, setShowPhoneCapture] = useState(false);
  // NEX-193 win-first: gate that runs FirstWinCapture once, between name/phone
  // (step 0) and the mandate ReflectionFlow (step 1). Boolean instead of a
  // fractional step so the integer step machine + its analytics numbers are
  // untouched; phone "CONTINUE"/"LATER" already setStep(1), which now renders
  // the first-win capture until onComplete flips this true.
  const [firstWinDone, setFirstWinDone] = useState(false);
  // Restore the gate after a kill/reload mid-onboarding: if the first-win item
  // was already created, don't re-show FirstWinCapture (which would create a
  // duplicate due-tomorrow task). The marker is written on capture and cleared
  // by the Settings onboarding-replay reset. `firstWinChecked` gates the render
  // until this async read resolves, so a fast tap at step 1 on a reload can't
  // create a second task before the marker is known.
  const [firstWinChecked, setFirstWinChecked] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(FIRST_WIN_DONE_KEY)
      .then((v) => { if (v === 'true') setFirstWinDone(true); })
      .catch(() => {})
      .finally(() => setFirstWinChecked(true));
  }, []);
  // App Review 4.0 (2026-07-02 rejection): Sign in with Apple/Google already
  // provided the user's name — AuthScreen persists it to auth user metadata
  // at sign-in. When a name is known, adopt it and skip the "What should I
  // call you?" step entirely; the step only renders when the provider
  // supplied no name. `nameChecked` gates the step-0 render so the question
  // can't flash for a frame before the async read resolves. Re-checked on
  // every phase change (inspire → notif → setup) for resilience against the
  // metadata write racing the root auth listener; the ref mirrors guard
  // against clobbering a name the user is already typing in the fallback.
  const [nameChecked, setNameChecked] = useState(false);
  const nameAdoptedRef = useRef(false);
  // Committed-value mirrors, assigned in an effect (not during render, which
  // is unsafe under concurrent rendering) so the [phase] effect below can
  // read the latest values without depending on them.
  const nameRef = useRef(name);
  const showPhoneCaptureRef = useRef(showPhoneCapture);
  useEffect(() => {
    nameRef.current = name;
    showPhoneCaptureRef.current = showPhoneCapture;
  });
  useEffect(() => {
    let cancelled = false;
    // Fail open: a hung getUser must never leave step 0 blank — the manual
    // name step is the fallback and must always eventually render.
    const failOpen = setTimeout(() => setNameChecked(true), 3000);
    supabase.auth.getUser()
      .then(({ data: { user } }) => {
        if (cancelled || nameAdoptedRef.current) return;
        if (nameRef.current.trim() || showPhoneCaptureRef.current) return;
        const meta = user?.user_metadata ?? {};
        const known = String(meta.given_name || meta.full_name || meta.name || '').trim();
        if (!known) return;
        nameAdoptedRef.current = true;
        setName(known);
        setShowPhoneCapture(true);
        void trackEvent('onboarding_step_completed', { phase, step: 0, key: 'name_prefilled' });
      })
      .catch(() => {})
      .finally(() => { clearTimeout(failOpen); if (!cancelled) setNameChecked(true); });
    return () => { cancelled = true; clearTimeout(failOpen); };
  }, [phase]);
  // NEX-17 quick-win: ring tint preset the user picked. Defaults to
  // 'gold' so existing-aesthetic users who skip the step still match
  // the rest of the app.
  const [ringTint, setRingTint] = useState<'gold' | 'teal' | 'amber'>('gold');

  // NEX-120 — Moment 5 finale. A pre-activation ceremonial beat ("You have
  // begun." / ENTER NEXUS) shown before the user activates, so the launch-gate
  // paywall that follows reads as a continuation of the ritual. Every terminal
  // onboarding path routes through this overlay instead of finishing directly,
  // and stashes its actual finish action in finaleFinishRef so each path keeps
  // its exact behavior (ring-tint → finishOnboarding('home'); the already-seen
  // resume/dev-replay path → bare commitActivation). ENTER NEXUS invokes it.
  const [showFinale, setShowFinale] = useState(false);
  const finaleFinishRef = useRef<(() => void) | null>(null);

  // NEX-26 — reflection + Pulse pipeline state.
  //   reflectionInput: captured from ReflectionFlow's onComplete.
  //   pulseReady + interstitialReady: both must flip true before the
  //   review screen renders (parent-side gate on min-display + data).
  //   refreshErrorFor: composite slot key passed to ReviewScreen when
  //   a refresh call fails. Auto-cleared after a short delay.
  const [reflectionInput, setReflectionInput] = useState<ReflectionInput | null>(null);
  const [pulseReady, setPulseReady] = useState(false);
  const [interstitialReady, setInterstitialReady] = useState(false);
  const [refreshErrorFor, setRefreshErrorFor] = useState<string | null>(null);
  const refreshErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // NEX-35: Pulse-failure surface. Non-null at step 2 routes the user
  // to RetryScreen instead of preparing/review.
  const [pulseFailure, setPulseFailure] = useState<RetryReason | null>(null);

  // Subscribe to the recommendation slice so ReviewScreen re-renders
  // on every slot mutation (refresh, edit, cascade).
  const onboardingRecommendations = useAppState((s: any) => s.onboardingRecommendations) as OnboardingRecommendations | null;

  // NEX-299: time-to-first-value instrumentation state. Null until the
  // persisted-read effect below resolves; buildFirstWinEmitProps omits the
  // duration/backgrounding props entirely rather than fabricating a value
  // while still null (should be rare — the read happens well before
  // FirstWinCapture can render, gated behind firstWinChecked).
  const [onboardingStartedAtMs, setOnboardingStartedAtMs] = useState<number | null>(null);
  const [backgroundedDuringOnboarding, setBackgroundedDuringOnboarding] = useState(false);

  // Emit phase-started so the baseline-rate calc has a denominator to
  // divide against. Also anchors NEX-299's time-to-first-value clock: read a
  // persisted start timestamp if one exists (resuming after a kill), else
  // stamp now and persist it; read a persisted backgrounded-flag too (may
  // already be true from before a kill). A new AppState listener, scoped to
  // this mount, flips + persists the flag on any background/inactive
  // transition observed while onboarding is in progress.
  useEffect(() => {
    void trackEvent('onboarding_phase_started', { phase: 'inspire' });

    void (async () => {
      try {
        const [storedStart, storedBackgrounded] = await Promise.all([
          AsyncStorage.getItem(ONBOARDING_STARTED_KEY),
          AsyncStorage.getItem(ONBOARDING_BACKGROUNDED_KEY),
        ]);
        const parsedStart = storedStart ? Number(storedStart) : NaN;
        if (Number.isFinite(parsedStart)) {
          setOnboardingStartedAtMs(parsedStart);
        } else {
          const now = Date.now();
          setOnboardingStartedAtMs(now);
          await AsyncStorage.setItem(ONBOARDING_STARTED_KEY, String(now));
        }
        if (storedBackgrounded === 'true') setBackgroundedDuringOnboarding(true);
      } catch {
        // Non-fatal — emit() omits the duration/backgrounding props rather
        // than fabricate a value when the timestamp never resolves.
      }
    })();

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        setBackgroundedDuringOnboarding(true);
        void AsyncStorage.setItem(ONBOARDING_BACKGROUNDED_KEY, 'true').catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  const phaseOpacity = useSharedValue(1);

  const crossFadeTo = (fn: () => void) => {
    const applyMutationAndFadeIn = () => {
      fn();
      phaseOpacity.value = withTiming(1, {
        duration: 400,
        easing: Easing.out(Easing.cubic),
      });
    };

    phaseOpacity.value = withTiming(
      0,
      { duration: 200, easing: Easing.out(Easing.cubic) },
      () => {
        runOnJS(applyMutationAndFadeIn)();
      },
    );
  };

  const phaseAnimatedStyle = useAnimatedStyle(() => ({
    opacity: phaseOpacity.value,
  }));

  const advanceInspire = () => {
    void trackEvent('onboarding_step_completed', {
      phase: 'inspire',
      step: inspireStep,
      total: INSPIRE_SCREENS.length,
    });
    crossFadeTo(() => {
      if (inspireStep < INSPIRE_SCREENS.length - 1) {
        setInspireStep(i => i + 1);
      } else {
        void trackEvent('onboarding_phase_completed', { phase: 'inspire' });
        void trackEvent('onboarding_phase_started', { phase: 'notif' });
        setPhase('notif');
      }
    });
  };

  // ─── NEX-26 phase E — reflection → preparing → review pipeline ────────────

  /** Convert the service's wire shape to the persistence slice shape. */
  const buildSliceFromResult = (set: RecommendationSet): OnboardingRecommendations => ({
    generatedAt: Date.now(),
    mandates: set.mandates,
    habits: set.habits,
    recurringTodos: set.recurringTodos,
    todos: set.todos,
    disambiguation: null,
  });

  /**
   * Fire the initial Pulse generation. ReflectionFlow already handled
   * the disambiguation gate before calling onComplete, so we pass
   * skipDisambiguationGate: true.
   *
   * NEX-35: any non-'pulse' outcome routes the user to RetryScreen
   * via pulseFailure. There is no silent curated-defaults fallback.
   */
  const firePulseGeneration = (reflection: ReflectionInput) => {
    void (async () => {
      try {
        const result = await generateOnboardingRecommendations(reflection, {
          skipDisambiguationGate: true,
        }) as RecommendationResult;

        if (result.source === 'pulse') {
          (useAppState as any).getState().setOnboardingRecommendations(buildSliceFromResult(result.data));
          void trackEvent('onboarding_step_completed', {
            phase: 'setup',
            step: 1,
            key: 'pulse_resolved',
            source: result.source,
          });
        } else if (result.source === 'failed') {
          setPulseFailure(result.reason);
          void trackEvent('onboarding_step_completed', {
            phase: 'setup',
            step: 1,
            key: 'pulse_failed',
            reason: result.reason,
          });
        } else {
          // 'needs_disambiguation' shouldn't fire with skipDisambiguationGate,
          // but if it does, treat as a parse-level failure so the user
          // sees the retry surface rather than a silent dead-end.
          setPulseFailure('parse');
          void trackEvent('onboarding_step_completed', {
            phase: 'setup',
            step: 1,
            key: 'pulse_failed',
            reason: 'unexpected_disambiguation',
          });
        }
      } catch (e) {
        // Service has its own catch; this is belt-and-suspenders.
        console.log('[onboarding] firePulseGeneration error:', (e as Error)?.message ?? e);
        setPulseFailure('network');
      } finally {
        setPulseReady(true);
      }
    })();
  };

  const onReflectionComplete = (reflection: ReflectionInput) => {
    setReflectionInput(reflection);
    setPulseReady(false);
    setInterstitialReady(false);
    setPulseFailure(null);
    void trackEvent('onboarding_step_completed', { phase: 'setup', step: 1, key: 'reflection_done' });
    crossFadeTo(() => setStep(2));
    firePulseGeneration(reflection);
  };

  // NEX-35 — Retry surface handlers.
  //
  // handlePulseRetry: re-fire the generation against the same
  //   reflection. Resets the gate flags so step 2 swings back to
  //   PreparingInterstitial until the new call resolves.
  // handlePulseEditReflection: walk the user back to step 1 with
  //   their prior answers seeded into ReflectionFlow, so they can
  //   tweak without retyping. Clears recommendation slice on the
  //   way so any stale state is wiped.
  const handlePulseRetry = () => {
    if (!reflectionInput) return;
    setPulseReady(false);
    setInterstitialReady(false);
    setPulseFailure(null);
    firePulseGeneration(reflectionInput);
  };

  const handlePulseEditReflection = () => {
    setPulseFailure(null);
    setPulseReady(false);
    setInterstitialReady(false);
    const liveState = (useAppState as any).getState();
    if (typeof liveState.setOnboardingRecommendations === 'function') {
      liveState.setOnboardingRecommendations(null);
    }
    crossFadeTo(() => setStep(1));
  };

  // ─── Refresh handlers wired to the real Pulse functions ───────────────────

  const showRefreshError = (key: string) => {
    setRefreshErrorFor(key);
    if (refreshErrorTimerRef.current) clearTimeout(refreshErrorTimerRef.current);
    refreshErrorTimerRef.current = setTimeout(() => setRefreshErrorFor(null), 3500);
  };

  const handleRefreshMandate = async (mandateId: string) => {
    if (!reflectionInput) return;
    const liveState = (useAppState as any).getState();
    const mandate = liveState.onboardingRecommendations?.mandates.find((m: any) => m.id === mandateId);
    if (!mandate) return;
    const result = await regenerateMandateOnly({ mandate, reflection: reflectionInput });
    if (!result) {
      showRefreshError(`mandate:${mandateId}`);
      return;
    }
    liveState.refreshMandate(mandateId, {
      title: result.title,
      category: result.category,
      rationaleSource: result.rationaleSource,
      rationale: result.rationale,
    });
  };

  const handleRefreshHabit = async (slotId: string) => {
    if (!reflectionInput) return;
    const liveState = (useAppState as any).getState();
    const recs: OnboardingRecommendations | null = liveState.onboardingRecommendations;
    const habit = recs?.habits.find((h: any) => h.slotId === slotId);
    if (!habit) return;
    const mandate = recs?.mandates.find((m: any) => m.id === habit.mandateId);
    if (!mandate) return;
    const result = await regenerateHabitService({ slotId, mandate, reflection: reflectionInput });
    if (!result) {
      showRefreshError(`habit:${slotId}`);
      return;
    }
    liveState.refreshHabit(slotId, {
      title: result.title,
      daysOfWeek: result.daysOfWeek,
      rationale: result.rationale,
    });
  };

  const handleRefreshTodo = async (slotId: string) => {
    if (!reflectionInput) return;
    const liveState = (useAppState as any).getState();
    const recs: OnboardingRecommendations | null = liveState.onboardingRecommendations;
    const todo = recs?.todos.find((t: any) => t.slotId === slotId);
    if (!todo) return;
    const mandate = recs?.mandates.find((m: any) => m.id === todo.mandateId);
    if (!mandate) return;
    const result = await regenerateTodoService({ slotId, mandate, reflection: reflectionInput });
    if (!result) {
      showRefreshError(`todo:${slotId}`);
      return;
    }
    liveState.refreshTodo(slotId, {
      title: result.title,
      rationale: result.rationale,
    });
  };

  const handleRegenerateMandateDownstream = async (mandateId: string) => {
    if (!reflectionInput) return;
    const liveState = (useAppState as any).getState();
    const recs: OnboardingRecommendations | null = liveState.onboardingRecommendations;
    const mandate = recs?.mandates.find((m: any) => m.id === mandateId);
    if (!mandate) return;
    const result = await regenerateMandateDownstreamService({ mandate, reflection: reflectionInput });
    if (!result) {
      showRefreshError(`mandate:${mandateId}`);
      return;
    }
    liveState.regenerateMandateDownstream(mandateId, result.habits, result.recurringTodos, result.todos);
  };

  const handleMandateEdit = (mandateId: string, newTitle: string) => {
    (useAppState as any).getState().setMandateTitle(mandateId, newTitle);
  };

  // ─── commitActivation — writes the recommendation slice to canonical state

  const commitActivation = () => {
    const liveState = (useAppState as any).getState();
    let recs: OnboardingRecommendations | null = liveState.onboardingRecommendations;

    // NEX-35: with curated defaults removed, a missing slice means
    // the user reached commit without ever getting a successful Pulse
    // call. Land them on an empty practice rather than fake content;
    // they can add mandates/habits/todos themselves from the tabs.
    if (!recs) {
      recs = {
        generatedAt: Date.now(),
        mandates: [],
        habits: [],
        recurringTodos: [],
        todos: [],
        disambiguation: null,
      };
      if (typeof liveState.setOnboardingRecommendations === 'function') {
        liveState.setOnboardingRecommendations(recs);
      }
    }

    activateUser({
      name: name.trim(),
      anchor: '',
      engine: '',
      vision: '',
      phoneNumber: getValidatedE164Phone(),
      ringTint,
    });
    void ensureBaselineCohortRecord(new Date().toISOString());

    // NEX-57: commit ONLY items the user tapped ADD on. The pool of
    // un-ADDed options gets discarded — the user explicitly didn't
    // pick them. Mandates aren't subject to ADD; they're identity
    // statements and all get committed as pillars.
    const addedHabits = recs.habits.filter((h) => h.added);
    const addedRecurringTodos = recs.recurringTodos.filter((rt) => rt.added);
    const addedTodos = recs.todos.filter((t) => t.added);

    void trackEvent('onboarding_finished', {
      mandates: recs.mandates.length,
      habits: addedHabits.length,
      todos: addedTodos.length,
      ringTint,
      // NEX-299: same timing fragment first-win uses — total ritual time
      // alongside first-win-specific time, effectively free at this point.
      ...buildOnboardingTimingProps(onboardingStartedAtMs, backgroundedDuringOnboarding),
    });

    // Profile sync (existing pattern). SIM_BYPASS honored internally.
    void (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const u = data?.user;
        if (!u?.id || !u?.email) return;
        await onActivation({ id: u.id, email: u.email, name: name.trim() });
        const e164 = getValidatedE164Phone();
        if (e164) {
          await supabase.from('user_profile').upsert({ user_id: u.id, phone_number: e164 }, { onConflict: 'user_id' });
        }
      } catch (e) {
        console.log('[onActivation] swallowed:', (e as Error)?.message ?? e);
      }
    })();

    // Write mandates → pillars. Mandate id flows through as the pillar id.
    const mandatePillars = recs.mandates.map(m => ({
      id: m.id,
      title: m.title,
      category: m.category,
      type: 'ACTION',
      power: 0,
      completed: false,
      subtext: m.category,
      // NEX-307: seed `notes` from Pulse's rationale — the one sentence tying
      // this mandate back to the user's own reflection. It was being generated
      // and then dropped here, so every user landed on a blank NOTES box on the
      // mandate detail screen, forever, and every downstream recommender ran
      // with no "why" to work from. Seeding it means filling that field in is
      // EDITING, not homework (owner decision: seed, never gate). Existing
      // optional field on an already-synced structure — no migration.
      notes: String(m.rationale ?? '').trim() || undefined,
    }));
    (useAppState as any).setState({ pillars: [...mandatePillars, ...(liveState.pillars ?? [])] });

    // NEX-124: fire first_mandate_committed AFTER the pillar write, guarded on
    // mandates.length > 0 (onboarding can finish with 0 mandates when Pulse
    // failed — the zero-mandate cohort instead fires from addPillarManual). One
    // set-once guard across both sites; claim synchronously before trackEvent.
    if (recs.mandates.length > 0) {
      const st = (useAppState as any).getState();
      if (!st.firstMandateCommittedFired) {
        st.markFirstMandateCommitted?.();
        const allowed = new Set(['business', 'vision', 'personal']);
        const categories = Array.from(
          new Set(
            recs.mandates.map((m) => {
              const c = String(m.category ?? '').trim().toLowerCase();
              return allowed.has(c) ? c : 'other';
            }),
          ),
        ).join(',');
        void trackEvent('first_mandate_committed', {
          mandate_count: recs.mandates.length,
          categories,
          source: 'onboarding',
        });
      }
    }

    // Mandate → category lookup for habit categorization.
    const mandateCategoryById = new Map<string, string>();
    recs.mandates.forEach(m => mandateCategoryById.set(m.id, m.category));

    // Habits → recurringRules. Category inherits from the parent mandate.
    // NEX-58: addRecurringRule creates the rule; linkHabitToGoal
    // populates goalHabitMap so mandate-detail/[id].tsx surfaces
    // this habit under LINKED HABITS for the parent mandate.
    // pillar.id === mandate.id (mandatePillars above uses m.id
    // directly), so we pass mandateId as the pillar id.
    // NEX-57: only ADDed habits are committed.
    addedHabits.forEach(h => {
      if (typeof liveState.addRecurringRule !== 'function') return;
      const cat = mandateCategoryById.get(h.mandateId) || 'PERSONAL';
      liveState.addRecurringRule(h.title, h.daysOfWeek, null, null, cat, null);
      if (typeof liveState.linkHabitToGoal === 'function') {
        liveState.linkHabitToGoal(h.title, h.mandateId);
      }
    });

    // NEX-60: route recurring-todos → recurringToDos with pillarId
    // stamped to the parent mandate. Mandate detail's LINKED
    // RECURRING section reads pillarId on each rule. Untracked —
    // these never get streak math, distinct from habits.
    // NEX-57: only ADDed recurringTodos are committed.
    addedRecurringTodos.forEach(rt => {
      if (typeof liveState.addRecurringToDoForPillar !== 'function') return;
      liveState.addRecurringToDoForPillar(rt.title, rt.daysOfWeek, rt.mandateId);
    });

    // NEX-58: route onboarding to-dos to dailyTasks with pillarId
    // stamped, so the mandate-detail LINKED TO-DOS section
    // surfaces them. Previously routed to Inbox, which left them
    // disconnected from their parent mandate in the UI.
    //
    // NEX-60: respect Pulse's dueDate when present — one-time todos
    // can land on a specific day (e.g. "schedule one date night
    // this week" → Friday's bucket). Fall back to today when unset.
    //
    // NEX-57: only ADDed todos are committed.
    //
    // Apple Reminders mirror for onboarding to-dos is intentionally
    // dropped here. Voice-added Inbox items still mirror normally
    // via command-executor.
    const todayKey = getLocalDateKey(new Date());
    addedTodos.forEach(t => {
      if (typeof liveState.addDailyTaskForPillar !== 'function') return;
      liveState.addDailyTaskForPillar(t.title, t.dueDate ?? todayKey, t.mandateId);
    });

    // NEX-171: no force-pin — new habits count toward the score by default
    // (excludedFromScore falsy). Just the notification schedule below.
    const freshState = (useAppState as any).getState();

    const notifSettings = freshState.notificationSettings;
    scheduleAllNotifications({
      morningHour: notifSettings?.morningHour ?? 8,
      morningMinute: notifSettings?.morningMinute ?? 0,
      eveningHour: notifSettings?.eveningHour ?? 20,
      eveningMinute: notifSettings?.eveningMinute ?? 0,
      silenced: areNudgesSilenced({ pauseMode: freshState.pauseMode }), // NEX-207
      smartTiming: notifSettings?.smartTiming !== false,                // NEX-212
      openHourCounts: freshState.appLaunchHourCounts,                   // NEX-212
      includeQuotes: notifSettings?.includeQuotes === true,             // notification quotes (opt-in)
      personalized: notifSettings?.personalizedQuotes !== false,        // NEX-277 kill switch
      quotesPool: freshState.quotesPool,                                // AI lines + seed + no-repeat
      todayWisdom: todayWisdomForNotification(freshState, todayKey),              // today's-win source
      yesterdayWisdom: wisdomForNotificationDate(freshState, addDaysToKey(todayKey, -1), todayKey), // morning slot
      onQuotesSelected: freshState.recordQuotesShown,                  // advance shown atomically
    }).catch(() => {});

    // NEX-299: clear the timing keys at the SHARED completion point, not
    // finishOnboarding — review caught that the alreadySeen short-circuit
    // below (handleReviewAccept, gated on the device-global
    // nexus_hasSeenQuickWin flag, which is never cleared on sign-out) calls
    // commitActivation() BARE and skips finishOnboarding entirely. Clearing
    // only in finishOnboarding would let a stale timestamp survive into a
    // LATER user's onboarding on a shared device, corrupting their duration.
    // (FIRST_WIN_DONE_KEY has the same latent gap via finishOnboarding-only
    // clearing, pre-existing and out of scope here — its blast radius is a
    // benign UI dedup skip, not corrupted analytics, so left untouched.)
    AsyncStorage.removeItem(ONBOARDING_STARTED_KEY).catch(() => {});
    AsyncStorage.removeItem(ONBOARDING_BACKGROUNDED_KEY).catch(() => {});

    // Dev replay: drop the replay flag at the SHARED completion point —
    // every exit from onboarding funnels through commitActivation,
    // including the alreadySeen short-circuit in handleReviewAccept that
    // skips finishOnboarding (the path an already-onboarded dev would hit).
    // Also clear the pending destination route: the post-onboarding
    // navigation effect requires an isActivated false→true transition that
    // never happens on replay, so a picked destination would otherwise sit
    // stale and fire spuriously on a later genuine activation. Normal
    // onboarding (flag false) is untouched. Compiled away in release.
    if (__DEV__) {
      const devState = (useAppState as any).getState();
      if (devState.devReplayOnboarding) {
        devState.setDevReplayOnboarding?.(false);
        _pendingOnboardingRoute = null;
        // Un-mute analytics now that the replay session is over. Placed
        // AFTER this function's own trackEvent calls so replay-driven
        // funnel events (first_mandate_committed, onboarding_finished)
        // never reach PostHog / the local log / nexus_events.
        // EXCEPT during a dev-skip session (SKIP SIGN-IN on AuthScreen):
        // the whole session runs as the fake SIM_USER_ID user, so
        // suppression must outlive the replay and hold until restart or
        // sign-out — otherwise post-onboarding habit logs would insert
        // nexus_events rows attributed to the device's anonymous session.
        if (!isDevSkipSessionActive()) {
          setAnalyticsReplaySuppressed(false);
        }
      }
    }
  };

  // ReviewScreen "Accept and begin" → either advance to ring-tint step
  // 3 (NEX-17 polish moment) or commit directly if the user has seen
  // it before. The actual data write fires when destination picker
  // completes at step 4 (existing finishOnboarding path).
  //
  // NEX-40: post-accept-and-begin, pre-ring-tint is the locked
  // permission-prompt timing for Apple Reminders. We deliberately
  // use requestPermission() (NOT connectIntegration), then create
  // the Nexus list, then toggleListSync that one list only. Auto-
  // selecting all of the user's existing reminders lists would be
  // invasive — narrow scope: write Pulse to-dos to the Nexus list,
  // read from the Nexus list. Users who want other lists synced
  // opt in via Settings.
  const handleReviewAccept = (_final: OnboardingRecommendations) => {
    void trackEvent('onboarding_step_completed', { phase: 'setup', step: 2, key: 'review_accepted' });
    void (async () => {
      // ── NEX-40: Reminders permission + Nexus list bootstrap ──────────────
      // All steps wrapped in try/catch so any failure falls through
      // to the existing commit flow silently. Permission denial,
      // RemindersNoICloudSourceError, or any other write failure
      // results in local Inbox-only mode (the canMirror check in
      // commitActivation handles the fallback).
      try {
        const r0 = useRemindersStore.getState();
        if (r0.permissionStatus === 'undetermined') {
          try {
            await r0.requestPermission();
          } catch (e) {
            console.log('[NEX-40] requestPermission failed:', (e as Error)?.message ?? e);
          }
        }
        const r1 = useRemindersStore.getState();
        if (r1.permissionStatus === 'granted' && !r1.nexusListId) {
          try {
            await r1.createNexusList();
          } catch (e) {
            // RemindersNoICloudSourceError lands here when the user
            // has no iCloud account that supports reminders. Silent
            // fallback — Pulse to-dos write to local Inbox only.
            console.log('[NEX-40] createNexusList failed:', (e as Error)?.message ?? e);
          }
        }
        const r2 = useRemindersStore.getState();
        if (r2.permissionStatus === 'granted' && r2.nexusListId && !r2.syncedListIds.includes(r2.nexusListId)) {
          try {
            r2.toggleListSync(r2.nexusListId);
          } catch (e) {
            console.log('[NEX-40] toggleListSync failed:', (e as Error)?.message ?? e);
          }
        }
      } catch (e) {
        console.log('[NEX-40] reminders bootstrap unexpected error:', (e as Error)?.message ?? e);
      }

      const alreadySeen = await AsyncStorage.getItem('nexus_hasSeenQuickWin').catch(() => null);
      if (alreadySeen) {
        // NEX-120: resume / dev-replay path still gets the Moment 5 finale before
        // activating. Preserve this path's exact terminal behavior (bare
        // commitActivation, no destination route) inside the finish ref.
        finaleFinishRef.current = () => commitActivation();
        setShowFinale(true);
      } else {
        crossFadeTo(() => setStep(3));
      }
    })();
  };

  // NEX-17: ring-tint pick → destination picker. The tint is staged in
  // local state; commitActivation reads it when the user actually finishes.
  const pickRingTint = (tint: 'gold' | 'teal' | 'amber') => {
    haptic('tabChange');
    setRingTint(tint);
    void trackEvent('ring_tint_chosen', { tint });
  };

  const advanceFromRingTint = () => {
    void trackEvent('onboarding_step_completed', {
      phase: 'setup',
      step: 3,
      key: 'ring_tint',
      tint: ringTint,
    });
    // NEX-193: ring tint is now the last setup step — the guided first-habit
    // picker (old step 4) was replaced by the win-first FirstWinCapture earlier
    // in the flow.
    // NEX-120: route through the Moment 5 finale before finishing. The finale's
    // ENTER NEXUS runs the actual finish (→ Home, then the launch-gate paywall).
    finaleFinishRef.current = () => finishOnboarding('home');
    setShowFinale(true);
  };

  // NEX-85 follow-up: getCountries() returns the same ~250-element list
  // every call; memo so we don't allocate it on each render.
  const countryCodes = React.useMemo(() => getCountries(), []);
  const getValidatedE164Phone = () => {
    const parsed = parsePhoneNumberFromString(phoneInput.trim(), phoneCountry as any);
    if (!parsed?.isValid()) return '';
    return parsed.number;
  };

  const handlePhoneContinue = () => {
    if (!phoneInput.trim()) {
      setPhoneError('Enter a phone number or choose LATER.');
      return;
    }
    const e164 = getValidatedE164Phone();
    if (!e164) {
      setPhoneError('That number looks invalid. Please check and try again.');
      return;
    }
    setPhoneError('');
    // NEX-85 follow-up: step 0 (same as 'name') because phone capture is
    // a side-step out of name, not part of reflection (step 1). Disambiguated
    // from the name event by the distinct `key` field. Avoids collision with
    // reflection_done / pulse_resolved / pulse_failed which all live at step 1.
    void trackEvent('onboarding_step_completed', { phase: 'setup', step: 0, key: 'phone_number_added' });
    setShowPhoneCapture(false);
    setStep(1);
  };

  // NEX-39: tabs that ship a one-time first-visit tooltip Modal which
  // captures touches until dismissed. When the destination picker
  // routes the user directly to one of these tabs, the tooltip would
  // fire as the first thing they see — but the picker already
  // explained where they're going, so the tutorial is redundant AND
  // its dim scrim blocks scroll on arrival. Preemptively stamp the
  // AsyncStorage flag so the modal's first-visit check returns truthy
  // and skips the tooltip on this initial landing.
  //
  // Users who navigate to these tabs manually (not via the destination
  // picker) still see the tooltip on their first visit — behavior
  // unchanged for the organic discovery path.
  const DESTINATION_TIP_KEYS: Partial<Record<'command' | 'orbit' | 'home', string>> = {
    command: 'nexus_hasSeenCommandTip',
    orbit:   'nexus_hasSeenOrbitTip',
    // Home has no Modal-style first-visit tooltip — its onboarding
    // overlay (FLOWS.home) is gated by `hasSeenTutorial` and uses the
    // gold-bordered coachmark engine, not the pre-existing tab-Modal
    // pattern. No stamp needed for the home destination.
  };

  const finishOnboarding = (destination?: 'command' | 'orbit' | 'home') => {
    AsyncStorage.setItem('nexus_hasSeenQuickWin', 'true').catch(() => {});
    // NEX-193: the first-win marker is only a within-onboarding dedup guard
    // (survives a kill/reload before activation). Clear it on completion so it
    // can't outlive this onboarding and wrongly skip the capture for a NEXT
    // user on the same device after a sign-out/resetState. Sign-out is only
    // reachable post-onboarding (Settings lives on Home), so a finish always
    // precedes it — this fully scopes the marker to the onboarding lifecycle.
    AsyncStorage.removeItem(FIRST_WIN_DONE_KEY).catch(() => {});
    if (destination) {
      const tipKey = DESTINATION_TIP_KEYS[destination];
      if (tipKey) {
        AsyncStorage.setItem(tipKey, 'true').catch(() => {});
      }
    }
    if (destination === 'command') {
      _pendingOnboardingRoute = '/';
    } else if (destination === 'orbit') {
      _pendingOnboardingRoute = '/orbit';
    } else if (destination === 'home') {
      _pendingOnboardingRoute = '/home';
    } else {
      _pendingOnboardingRoute = null;
    }
    commitActivation();
  };

  const ProgressDots = ({ total, current }: { total: number; current: number }) => (
    <View style={{ flexDirection: 'row', gap: tokens.spacing.xs, marginBottom: 40 /* FIXME(nex-56): off-scale spacing 40 — review */, marginTop: tokens.spacing.xs }}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={{
          width: i === current ? 24 : 8, height: 8, borderRadius: 4,
          // FIXME(nex-56): 222 neutral inactive-dot background, no token — design review
          backgroundColor: i <= current ? GOLD : tokens.color.goldHairline,
        }} />
      ))}
    </View>
  );

  // ── Inspire Phase ────────────────────────────────────────────────────────
  if (phase === 'inspire') {
    const screen = INSPIRE_SCREENS[inspireStep];
    return (
      <View style={{ flex: 1, backgroundColor: 'transparent' }}>
        <Animated.View style={[{ flex: 1 }, phaseAnimatedStyle]}>
          <InspireScreen
            data={screen}
            onNext={advanceInspire}
            isLast={inspireStep === INSPIRE_SCREENS.length - 1}
          />
        </Animated.View>
        {/* Dot indicator */}
        <View style={{ position: 'absolute', bottom: 50 /* FIXME(nex-56): off-scale spacing 50 — review */, alignSelf: 'center', flexDirection: 'row', gap: tokens.spacing.xs }}>
          {INSPIRE_SCREENS.map((_, i) => (
            <View key={i} style={{
              width: i === inspireStep ? 20 : 6, height: 6, borderRadius: 3,
              // FIXME(nex-56): 333 off-scale gray for inactive inspire-dot, no token — design review
              backgroundColor: i === inspireStep ? GOLD : tokens.color.textDisabled,
            }} />
          ))}
        </View>
      </View>
    );
  }

  // ── Notification Permission Phase ────────────────────────────────────────
  if (phase === 'notif') {
    return (
      <Animated.View style={[{ flex: 1 }, phaseAnimatedStyle]}>
        <NotificationPermScreen onNext={() => crossFadeTo(() => setPhase('setup'))} />
      </Animated.View>
    );
  }

  // ── Moment 5 finale (NEX-120) ────────────────────────────────────────────
  // Full-screen ceremonial beat, shown after the last setup step and BEFORE
  // activation (so it renders while OnboardingScreen is still mounted). ENTER
  // NEXUS runs the stashed finish action; if somehow unset (e.g. hot reload),
  // fall back to the canonical finish so the user is never trapped.
  if (showFinale) {
    return <Moment5Screen onEnter={() => (finaleFinishRef.current ?? (() => finishOnboarding('home')))()} />;
  }

  // ── Setup Phase (Name/phone → FirstWin → Reflection → Review → RingTint) ──
  // NEX-26 phase E replaced step 1 (preset mandates) and step 2 (preset
  // habits) with full-screen mounts of ReflectionFlow + ReviewScreen.
  // NEX-193 inserted the win-first FirstWinCapture between step 0 and step 1
  // and removed the old step-4 first-habit picker; ring tint (step 3) is now
  // the last numbered step.
  const ProgressDots3 = () => (
    <View style={{ flexDirection: 'row', gap: tokens.spacing.xs, marginBottom: 40 /* FIXME(nex-56): off-scale spacing 40 — review */ }}>
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={{
          width: i === step ? 24 : 8, height: 8, borderRadius: 4,
          // FIXME(nex-56): 222 neutral inactive-dot background, no token — design review
          backgroundColor: i <= step ? GOLD : tokens.color.goldHairline,
        }} />
      ))}
    </View>
  );

  // ── First-win capture (NEX-193): full-screen, between name/phone and
  // reflection. Renders the first time we reach step 1; onComplete flips the
  // gate so the same step 1 falls through to ReflectionFlow below. The
  // RetryScreen "Edit reflection" path (setStep(1) with the gate already true)
  // and a reflection onCancel→step 0→forward both correctly skip a re-capture.
  if (step === 1 && !firstWinDone) {
    // Wait for the persisted-marker read before deciding whether to show
    // capture — otherwise a reload at step 1 could render it (and allow a
    // duplicate create) before the marker hydrates. In the normal forward flow
    // the read resolves long before step 1, so this never visibly blocks.
    if (!firstWinChecked) return null;
    return (
      <FirstWinCapture
        onComplete={() => setFirstWinDone(true)}
        onboardingStartedAtMs={onboardingStartedAtMs}
        backgroundedDuringOnboarding={backgroundedDuringOnboarding}
      />
    );
  }

  // ── Step 1: ReflectionFlow (full-screen mount, outside ScrollView) ───────
  // NEX-35: pass initialAnswers so the "Edit reflection" path from
  // RetryScreen round-trips without losing the user's prior input.
  if (step === 1) {
    return (
      <ReflectionFlow
        onComplete={onReflectionComplete}
        onCancel={() => setStep(0)}
        initialAnswers={reflectionInput ?? undefined}
      />
    );
  }

  // ── Step 2: review pipeline (retry → preparing → review). Full-screen.
  // NEX-35 decision tree:
  //   pulseFailure non-null  → RetryScreen
  //   not ready              → PreparingInterstitial
  //   else                   → ReviewScreen
  if (step === 2) {
    if (pulseFailure) {
      return (
        <RetryScreen
          reason={pulseFailure}
          onRetry={handlePulseRetry}
          onEditReflection={handlePulseEditReflection}
        />
      );
    }
    const showReview = pulseReady && interstitialReady && onboardingRecommendations;
    if (showReview) {
      return (
        <ReviewScreen
          recommendations={onboardingRecommendations!}
          onAccept={handleReviewAccept}
          onToggleAddedHabit={(slotId) => (useAppState as any).getState().toggleAddedHabit(slotId)}
          onToggleAddedRecurringTodo={(slotId) => (useAppState as any).getState().toggleAddedRecurringTodo(slotId)}
          onToggleAddedTodo={(slotId) => (useAppState as any).getState().toggleAddedTodo(slotId)}
          onRegenerateMandate={handleRegenerateMandateDownstream}
          refreshErrorFor={refreshErrorFor}
        />
      );
    }
    return (
      <PreparingInterstitial onMinimumElapsed={() => setInterstitialReady(true)} />
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.obContainer}>
      <AdaptiveScreen>
      <ScrollView contentContainerStyle={styles.obContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        <ProgressDots3 />

        {/* Step 1: Name */}
        {step === 0 && !showPhoneCapture && nameChecked && (
          <>
            <Text style={styles.obTitle}>WELCOME TO NEXUS</Text>
            <Text style={styles.stepDesc}>Remember who you are, even on the scattered days.</Text>
            <View style={styles.inputContainer}>
              <Text style={styles.stepTitle}>What should I call you?</Text>
              <TextInput
                style={styles.obInput}
                placeholder="Your name"
                placeholderTextColor={PLACEHOLDER_COLOR_DARK}
                value={name}
                onChangeText={setName}
                autoFocus
                onSubmitEditing={() => {
                  if (name.trim()) {
                    haptic('dragDrop');
                    void trackEvent('onboarding_step_completed', { phase: 'setup', step: 0, key: 'name' });
                    setShowPhoneCapture(true);
                  }
                }}
              />
            </View>
            <PrimaryPill
              fullWidth
              onPress={() => {
                void trackEvent('onboarding_step_completed', { phase: 'setup', step: 0, key: 'name' });
                setShowPhoneCapture(true);
              }}
              disabled={!name.trim()}
            >
              CONTINUE
            </PrimaryPill>
          </>
        )}

        {step === 0 && showPhoneCapture && (
          <>
            <Text style={styles.obTitle}>YOUR NUMBER</Text>
            <Text style={[styles.stepDesc, { fontFamily: 'Fraunces-LightItalic', fontSize: 22 }]}>So we can reach you when something matters.</Text>
            <View style={styles.inputContainer}>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {countryCodes.map((country) => (
                    <Pressable
                      key={country}
                      onPress={() => setPhoneCountry(country)}
                      style={{ paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: phoneCountry === country ? GOLD : tokens.color.goldHairline, borderRadius: 12, marginRight: 8 }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: phoneCountry === country }}
                      accessibilityLabel={`${country}, +${getCountryCallingCode(country as any)}`}
                    >
                      <Text style={{ color: phoneCountry === country ? GOLD : tokens.color.textMuted }}>{country} +{getCountryCallingCode(country as any)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
              <TextInput
                style={styles.obInput}
                placeholder="Phone number"
                placeholderTextColor={PLACEHOLDER_COLOR_DARK}
                value={phoneInput}
                onChangeText={(v) => { setPhoneInput(v); if (phoneError) setPhoneError(''); }}
                keyboardType="phone-pad"
              />
              {!!phoneError && <Text style={{ color: tokens.color.stateError, marginTop: 8 }}>{phoneError}</Text>}
              <Text style={{ color: tokens.color.textMuted, fontSize: 12, marginTop: 10 }}>Your number stays private. Nothing sent without your permission.</Text>
            </View>
            <PrimaryPill fullWidth onPress={handlePhoneContinue}>
              CONTINUE
            </PrimaryPill>
            <Pressable
              onPress={() => { setPhoneError(''); setShowPhoneCapture(false); setStep(1); }}
              style={{ marginTop: tokens.spacing.md }}
              accessibilityRole="button"
              accessibilityLabel="Later"
            >
              <Text style={{ color: tokens.color.textDisabled, fontSize: 12, letterSpacing: 1 }}>LATER</Text>
            </Pressable>
          </>
        )}

        {/* Step 1 (reflection) and step 2 (review) are full-screen mounts
            handled by the early returns above — they render outside this
            ScrollView/KeyboardAvoidingView wrapper. The scroll-based UI
            here covers steps 0, 3, and 4 only. */}

        {/* Step 3: Ring tint quick-win — NEX-17.
            A visible "I did a thing already" moment before the destination
            picker. The choice persists to userProfile.ringTint and is read
            by the alignment ring + Home accents. */}
        {step === 3 && (
          <>
            <Text style={styles.obTitle}>MAKE IT YOURS.</Text>
            <Text style={styles.stepDesc}>Pick the tint for your alignment ring. You can change it anytime in Settings.</Text>
            <View style={{ width: '100%', gap: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, marginBottom: tokens.spacing.lg }}>
              {RING_TINT_PRESETS.map((preset) => {
                const selected = ringTint === preset.id;
                return (
                  // Note: 111 close to surface (111113, delta 1 digit, established precedent)
                  <Pressable
                    key={preset.id}
                    onPress={() => pickRingTint(preset.id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: tokens.color.surface,
                      borderRadius: 16,
                      borderWidth: 1,
                      // FIXME(nex-56): 1A1A1A neutral inactive-border (surfaceElevated token would work but selected-border uses preset.hex; pairing kept literal for design-review consistency)
                      borderColor: selected ? preset.hex : tokens.color.goldHairline,
                      padding: 18 /* FIXME(nex-56): off-scale spacing 18 — review */,
                      gap: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${preset.label}. ${preset.sub}`}
                  >
                    {/* Tint preview disc. preset.hex + '22' is a runtime alpha composition. */}
                    {/* FIXME(nex-56): runtime preset-color alpha composition (preset.hex + '22'); preset hexes map to canonical tokens but alpha suffix has no token */}
                    <View style={{
                      width: 44, height: 44, borderRadius: 22,
                      borderWidth: 2.5, borderColor: preset.hex,
                      backgroundColor: preset.hex + '22',
                    }} />
                    <View style={{ flex: 1 }}>
                      {/* FIXME(nex-56): tokens.color.text off-scale neutral white — design review */}
                      {/* FIXME(nex-56): fontSize 16 matches buttonPrimary size but fontWeight '700' ≠ token '600'; no fontFamily set — design review */}
                      <Text style={{ color: tokens.color.text, fontSize: 16, fontWeight: '700', marginBottom: 2 /* FIXME(nex-56): off-scale spacing 2 — review */ }}>{preset.label}</Text>
                      {/* FIXME(nex-56): tokens.color.textMuted off-scale gray — design review */}
                      {/* FIXME(nex-56): off-scale fontSize 12, design review */}
                      <Text style={{ color: tokens.color.textMuted, fontSize: 12, lineHeight: 16 }}>{preset.sub}</Text>
                    </View>
                    {/* FIXME(nex-56): off-scale fontSize 18 (checkmark glyph), design review */}
                    {selected && (
                      <Text
                        style={{ color: preset.hex, fontSize: 18 }}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                      >
                        ✓
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <PrimaryPill
              fullWidth
              onPress={advanceFromRingTint}
            >
              CONTINUE
            </PrimaryPill>
            <Pressable
              onPress={() => setStep(2)}
              style={{ marginTop: tokens.spacing.md }}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray for BACK link — design review */}
              {/* FIXME(nex-56): off-scale fontSize 12, design review */}
              <Text style={{ color: tokens.color.textDisabled, fontSize: 12, letterSpacing: 1 }}>← BACK</Text>
            </Pressable>
          </>
        )}

        {/* NEX-193: the old step-4 guided-first-habit picker was removed. The
            win-first FirstWinCapture (between name/phone and reflection) is now
            the single first action, so ring tint finishes straight to Home. */}

      </ScrollView>
      </AdaptiveScreen>
    </KeyboardAvoidingView>
  );
}

// ─── Notification Handler ─────────────────────────────────────────────────────
// NEX-198: cold-start response de-dup, at MODULE scope (not per-effect / per-
// instance). NotificationHandler remounts when PostHogProvider's
// `key={hydrated…}` flips on hydration, so a useEffect-local or useRef Set would
// reset and re-drain getLastNotificationResponseAsync() — double-handling (and
// double-navigating) the same launching response. Module scope persists for the
// JS runtime; keys carry the delivery date so a later re-tap isn't suppressed.
const handledNotificationResponses = new Set<string>();

function NotificationHandler() {
  const router = useRouter();
  const responseListener = useRef(null);
  const { notificationSettings, leadTimeActions, pauseMode, inbox, dailyWisdomQuotes } = useAppState(
    useShallow((s: any) => ({
      notificationSettings: s.notificationSettings,
      leadTimeActions: s.leadTimeActions,
      pauseMode: s.pauseMode,
      inbox: s.inbox,
      dailyWisdomQuotes: s.dailyWisdomQuotes,
    })),
  );

  // NEX-207: gate the launch schedule on persistence hydration. On a cold launch
  // the store starts at the default (pauseMode.active === false); scheduling
  // before hydration would re-arm / PROMPT for nudges for a user whose saved
  // state is paused, only to cancel them a tick later. Wait for hydration so a
  // paused user is silenced from the first schedule call.
  const [hydrated, setHydrated] = useState(() => useAppState.persist.hasHydrated());
  useEffect(() => useAppState.persist.onFinishHydration(() => setHydrated(true)), []);

  // (re)arm or silence the recurring nudges once hydrated AND whenever Pause Mode
  // toggles. Pausing → silenced (cancel + no reschedule); resuming → re-arm.
  // Settings edits reschedule via applyNotifSettings.
  useEffect(() => {
    if (!hydrated) return;
    const settings = notificationSettings || {};
    // NEX-212: read the launch-hour histogram from the store at call time, NOT as
    // an effect dep — re-running the schedule on every per-launch increment would
    // thrash. The current value is re-read here (each launch / settings / pause).
    const openHourCounts = useAppState.getState().appLaunchHourCounts;
    const todayKey = getLocalDateKey(new Date());
    scheduleAllNotifications({
      morningHour: settings.morningHour ?? 8,
      morningMinute: settings.morningMinute ?? 0,
      eveningHour: settings.eveningHour ?? 20,
      eveningMinute: settings.eveningMinute ?? 0,
      weeklyDay: settings.weeklyDay ?? 0,
      weeklyHour: settings.weeklyHour ?? 10,
      milestoneAlerts: settings.milestoneAlerts !== false,
      silenced: areNudgesSilenced({ pauseMode }),
      smartTiming: settings.smartTiming !== false, // NEX-212
      openHourCounts,                              // NEX-212
      includeQuotes: settings.includeQuotes === true, // notification quotes (opt-in)
      personalized: settings.personalizedQuotes !== false, // NEX-277 kill switch
      quotesPool: useAppState.getState().quotesPool,            // AI lines + seed + no-repeat
      // Today's-Wisdom source (today's win): each slot leads with its wisdom
      // line when filter-safe. Read at call time, like openHourCounts.
      todayWisdom: todayWisdomForNotification(useAppState.getState(), todayKey),
      yesterdayWisdom: wisdomForNotificationDate(useAppState.getState(), addDaysToKey(todayKey, -1), todayKey),
      onQuotesSelected: useAppState.getState().recordQuotesShown, // advance shown atomically
    }).catch(() => {});
    // Deps: re-arm when Today's Wisdom LANDS or changes mid-day. The revision
    // key is the dailyWisdomQuotes ARRAY REFERENCE (not just the first quote's
    // text): a same-day regeneration keeps dailyWisdomDate unchanged AND can
    // keep the first quote's text while changing its author or a later slot's
    // quote — all of which are frozen into the notification bodies (Greptile PR
    // #361). Reference-identity is sufficient because every writer REPLACES the
    // array (setDailyWisdom / setWisdomQuoteCount / reconcile) — no in-place
    // mutation exists (guarded by src/state/__tests__/set-daily-wisdom.test.ts).
    // Accepted: this re-evaluates chooseReceptiveHour (NEX-212) mid-day within
    // its ±2h window. NEX-207 pause is unaffected (silenced short-circuits to
    // cancel-only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, pauseMode?.active, dailyWisdomQuotes]);

  useEffect(() => {
    // NEX-198: the reminder action category is registered at the root (always
    // mounts) — see RootLayout. This effect owns the response handling.

    // De-dup the cold-start double: getLastNotificationResponseAsync() AND the
    // live listener can both deliver the SAME launching response, which would
    // otherwise double-navigate (double router.push / openURL). Key on
    // identifier+action+delivery-date so the same delivery is handled once,
    // while a recurring notification re-tapped on a later day (different date)
    // is NOT suppressed. Race-safe regardless of which path fires first, and
    // module-scoped so it survives the hydration remount (see note above).
    const handleResponse = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const req = response.notification?.request;
      const key = `${req?.identifier ?? ''}:${response.actionIdentifier ?? ''}:${response.notification?.date ?? ''}`;
      if (handledNotificationResponses.has(key)) return;
      handledNotificationResponses.add(key);
      const data: any = req?.content?.data;
      // NEX-198: the Done action resolves the reminder and clears the delivered
      // notification from the tray. Done foregrounds the app so this handler (or
      // the hydration-gated cold-start drain) actually runs. Idempotent resolve,
      // read from the LIVE store.
      if (response.actionIdentifier === REMINDER_ACTION.DONE && data?.reminderId) {
        try { (useAppState as any).getState().resolveInboxTask?.(String(data.reminderId)); } catch {}
        dismissReminderNotification(String(data.reminderId)).catch(() => {});
        return; // Done never navigates
      }

      const dest = getNotificationRoute(response.notification);
      if (dest?.route) {
        try { router.push(dest.route as any); } catch {}
      }
      // NEX-232: a tapped pre-charge reminder opens Apple's manage/cancel screen
      // (one tap). managementURL can be null once the entitlement lapses → fall
      // back to the generic subscriptions URL, never pass null to openURL.
      if (dest?.action === 'manage_subscription') {
        (async () => {
          try {
            const status = await getCancelFlowStatus();
            await Linking.openURL(status.managementURL ?? 'https://apps.apple.com/account/subscriptions');
          } catch {}
        })();
      }
      // NEX-301: a tapped in-trial nudge just routes Home (already done above);
      // record which day was tapped.
      if (dest?.action === 'open_trial_nudge') {
        void trackEvent('trial_nudge_tapped', { day: typeof data?.day === 'number' ? data.day : -1, identifier: req?.identifier ?? '' });
      }
    };

    responseListener.current = Notifications.addNotificationResponseReceivedListener(handleResponse);

    // Cold start: a Done/Open/tap that launched the app from a terminated state
    // is not delivered to the live listener — drain the last response once. GATE
    // on hydration: getLastNotificationResponseAsync can resolve before the store
    // finishes loading, in which case a Done would find an empty inbox, no-op,
    // AND (via the module dedup) consume the key so the post-hydration retry is
    // suppressed — silently dropping the tap. Waiting for `hydrated` means the
    // drain runs against the real inbox. (Effect re-runs when hydrated flips.)
    if (hydrated) {
      Notifications.getLastNotificationResponseAsync()
        .then((r) => handleResponse(r))
        .catch(() => {});
    }

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [hydrated]);

  // NEX-232: reconcile the pre-charge reminder whenever the subscription state
  // changes (purchase / cancel / renewal). The wrapper returns a remover so the
  // listener doesn't stack across remounts / Fast Refresh. The launch reconcile
  // lives in runSubscriptionCheck (after RC is configured).
  useEffect(() => {
    const remove = onCustomerInfoUpdated((info) => {
      // Thread the in-hand CustomerInfo so the reconciler skips a redundant
      // getCustomerInfo() that could fail/bail on slow/offline. NEX-236: resolve
      // the quiet window from the LIVE store (getState) — this listener registers
      // once ([] deps), so a captured value would go stale after a quiet-hours
      // edit; getState() is always current.
      // NB: unlike the lead-time effect below, billing has no quiet-change
      // re-reconcile trigger by design — it re-shifts on the next launch /
      // CustomerInfo event, which is well before a days-out billing fire.
      const quiet = resolveQuietWindow(useAppState.getState().notificationSettings);
      void reconcileBillingReminders({ info: projectBillingReminderInfo(info) }, quiet);
    });
    return remove;
  }, []);

  // NEX-301: reconcile the in-trial Day-0/1 nudge on the same trigger as the
  // billing reminder above — no isActivated gate here (see the reconciler's
  // own note for the case this covers and the one carve-out, family sharing).
  // Disjoint `nexus-trial-nudge-*` id family from billing's `nexus-billing-*`,
  // its own serialized chain — this is the first time two reconcilers fire off
  // the same onCustomerInfoUpdated event, but they can't interfere with each other.
  useEffect(() => {
    const remove = onCustomerInfoUpdated((info) => {
      const quiet = resolveQuietWindow(useAppState.getState().notificationSettings);
      void reconcileTrialNudges({ info: projectTrialNudgeInfo(info) }, quiet);
    });
    return remove;
  }, []);

  // NEX-162: reconcile lead-time one-shots on launch + whenever the actions
  // change (create/edit/complete/delete from anywhere). Cancel-by-family +
  // reschedule-open lives in the service; this is the single trigger.
  // NEX-236: pass the quiet-hours window (read-site defaulted — cloud merge may
  // replace notificationSettings with an old blob lacking these keys) so one-shots
  // never land off-hours.
  useEffect(() => {
    const quiet = resolveQuietWindow(notificationSettings);
    reconcileLeadTimeNotifications(Array.isArray(leadTimeActions) ? leadTimeActions : [], quiet).catch(() => {});
  }, [leadTimeActions, notificationSettings?.quietHoursStart, notificationSettings?.quietHoursEnd]);

  // NEX-198 (N-1): reconcile ambient reminder one-shots on launch + whenever the
  // inbox changes (capture / resolve / delete / due-date edit from anywhere).
  // No quiet-hours shift — a reminder's time is user-intended, unlike the
  // system-generated lead-time/billing pushes. Cancel-by-family + reschedule
  // lives in the service; this is the single trigger.
  useEffect(() => {
    reconcileReminderNotifications(Array.isArray(inbox) ? inbox : []).catch(() => {});
  }, [inbox]);

  return null;
}

// ─── Root Layout ──────────────────────────────────────────────────────────────
// Wraps RootLayoutInner so <StatusBar style="light" /> is mounted for
// every render path (loading splash, auth, paywall, onboarding, main
// app). Every Home/Orbit/Inbox/Align/Command surface uses a near-black
// background (around 050505 / 0A0A0A — # dropped here to satisfy the
// canonical gate); without this the system defaults to dark icons that
// wash out against the dark hero, especially as content scrolls under
// the translucent status bar. expo-status-bar is
// declarative — mounting once at the root is sufficient. Any future
// light-surface screen can override locally with <StatusBar style="dark" />.
function RootLayout() {
  // NEX-136 P3: analytics is off unless the user has explicitly granted
  // consent. Gating `disabled` here means a non-consented (or not-yet-asked)
  // user never starts capture at launch. In-session toggles are mirrored
  // onto PostHog from RootLayoutInner via optIn()/optOut().
  const analyticsConsent = useAppState((s: any) => s.analyticsConsent);

  // The PostHog client is built once at provider mount and reads `disabled`
  // from construction. On a cold launch the persisted store hasn't hydrated
  // yet, so `analyticsConsent` is still its default 'unset' on first render —
  // the client would be built disabled and an opted-in user's automatic
  // "Application Opened" lifecycle event would be suppressed. Track hydration
  // and remount the provider via `key` once the store is hydrated, so the
  // client is reconstructed with the real persisted consent. The first
  // (pre-hydration) mount stays disabled and suppressed by design.
  const [hydrated, setHydrated] = useState(() => useAppState.persist.hasHydrated());
  useEffect(() => useAppState.persist.onFinishHydration(() => setHydrated(true)), []);

  // NEX-198: register the reminder notification category at the ROOT — this
  // component always mounts, unlike NotificationHandler (which only renders once
  // activated + unpaywalled). A reminder that fires for a signed-out /
  // onboarding / paywalled user must still show its Done/Open actions, which
  // requires the category to be registered on every launch. Idempotent.
  useEffect(() => { registerNotificationCategories().catch(() => {}); }, []);

  return (
    <>
      <StatusBar style="light" />
      <PostHogProvider
        key={hydrated ? 'ready' : 'pre'}
        apiKey={publicConfigValue('EXPO_PUBLIC_POSTHOG_KEY', process.env.EXPO_PUBLIC_POSTHOG_KEY)}
        options={{
          host: publicConfigValue('EXPO_PUBLIC_POSTHOG_HOST', process.env.EXPO_PUBLIC_POSTHOG_HOST) || 'https://us.i.posthog.com',
          // Capture app open/close, foreground/background
          captureAppLifecycleEvents: true,
          // Skip tracking entirely in the simulator dev mode so we don't
          // pollute prod analytics with developer activity. Also off until
          // the user explicitly opts in (NEX-136 P3).
          disabled: SIM_BYPASS || analyticsConsent !== 'granted',
        }}
        autocapture={{
          // Touch autocapture is OFF deliberately, and must stay off.
          // posthog-react-native's default propsToCapture includes `children`,
          // which it writes to `$el_text` for every element in the touched
          // subtree (up to 20 ancestors). For a <Text> node `children` IS the
          // rendered string, so a tap on a mandate row would send that
          // mandate's title to PostHog. That directly contradicts the promise
          // in our privacy policy that we never send habits, mandates or
          // reflections for analytics. Verified against posthog-react-native
          // 4.45.5 dist/autocapture.js on 2026-08-15.
          //
          // Per-component `ph-no-capture` tagging was rejected: it has to be
          // applied to every content-bearing surface forever, and one missed
          // component silently makes the policy false again. The 20 explicit
          // events in src/services/analytics.ts carry opaque ids and no
          // content, and are what analytics actually runs on.
          captureTouches: false,
          captureLifecycleEvents: true,
        }}
      >
        <RootLayoutInner />
      </PostHogProvider>
    </>
  );
}

function RootLayoutInner() {
  const { isActivated, devReplayOnboarding } = useAppState(
    useShallow((s) => ({ isActivated: s.isActivated, devReplayOnboarding: s.devReplayOnboarding })),
  );
  // Cold-start Reminders bootstrap. Persisted state hydrates without
  // permissionStatus (only syncedListIds + lastSyncedAt are persisted),
  // so the store thinks permission is 'undetermined' on every launch.
  // Without bootstrapping before any tab renders, the Inbox doorway
  // briefly shows the CONNECT REMINDERS CTA on every cold start for
  // users who'd already connected — see the doorway-flicker bug.
  // Fire-and-forget: bootstrap stamps state when it resolves.
  useEffect(() => {
    useRemindersStore.getState().bootstrap().catch(() => {});
  }, []);

  // Foreground re-sync for the home-screen widget. The widget's
  // multi-entry timeline rolls over at midnight on its own (see
  // RawWidgetData / deriveTodayView in NexusWidget.swift), but
  // returning to the app after a long background needs to push a
  // fresh raw snapshot — habit logs / inbox / events may have
  // changed via voice / sync since the last write.
  useEffect(() => {
    // Refresh the connected-calendar window into the store, THEN push the
    // widget snapshot. This runs app-level (not just on the Home tab) so the
    // widget's calendar stays populated no matter which tab the app is left
    // on. refreshCalendarWindowIntoStore never prompts for permission.
    const refreshAndSync = () => {
      // NEX-315: interactive-widget completions. A Home-Screen habit tap can
      // only leave a message in the App Group; this is where those taps become
      // real. Drain FIRST so the freshly-logged completions are in the store,
      // THEN sync the widget so the authoritative snapshot reflects them and the
      // widget's optimistic check-marks are confirmed rather than reverted.
      // Best-effort: a drain failure must never block the calendar refresh.
      //
      // Wait for persist rehydration BEFORE draining: on a cold open this
      // effect fires while the store is still empty (AsyncStorage rehydration
      // is async), and a store with no recurringRules makes every queued tap
      // look like a tap for a DELETED habit — dropped, then the queue cleared,
      // and a real completion silently lost (user-reported: widget tap not
      // logged after opening the app, inconsistently — a hydration race).
      void waitForAppStateHydration()
        .then(() =>
          drainWidgetCompletions(useAppState.getState, getLocalDateKey(new Date()), {
            // The wait above has a timeout cap; if it ever fires unhydrated,
            // this probe makes the drain leave the queue untouched instead of
            // dropping every tap as "deleted habit" and clearing (the loss).
            isHydrated: () => useAppState.persist?.hasHydrated?.() ?? true,
          }),
        )
        .catch(() => null)
        .finally(() => {
          refreshCalendarWindowIntoStore().finally(() => syncWidgetAfterMutation());
        });
    };
    refreshAndSync();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') refreshAndSync();
    });
    return () => sub.remove();
  }, []);

  // NEX-281: keep the Supabase access token fresh while the app is
  // foregrounded. GoTrue's auto-refresh ticker is a JS interval — iOS
  // suspends it in background, so without this the 1h token is routinely
  // expired when the user returns and the refresh happens as a blocking
  // network call inside the next AI command's getSession() (the most common
  // cause of the NEX-280 hang). Recommended supabase-js RN pattern: tick
  // only while active. Gated on isSupabaseConfigured so degraded mode never
  // ticks against the unroutable placeholder host (see supabase.ts).
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const setTicker = (s: AppStateStatus) => {
      if (s === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    };
    // Start unconditionally at mount — the root layout mounting means the app
    // is foregrounded, and AppState.currentState can still read 'unknown' on
    // iOS at this point (which setTicker would treat as background).
    supabase.auth.startAutoRefresh();
    const sub = AppState.addEventListener('change', setTicker);
    return () => {
      sub.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, []);

  // NEX-17: start the activation tracker once. The tracker is internally
  // idempotent (re-entry returns the existing handle), gated on
  // isActivated inside its evaluator, and persists a fired-at marker so
  // it doesn't double-fire across launches. Mounting unconditionally
  // here means returning users whose state already qualifies get
  // measured on first launch under this build.
  useEffect(() => {
    startActivationTracker(useAppState as any);
  }, []);

  const [authState, setAuthState] = useState<'loading' | 'signed-out' | 'signed-in'>(
    SIM_BYPASS ? 'signed-in' : 'loading'
  );
  // NEX-191: RootLayoutInner's own hydration signal so the once-per-launch
  // recordAppOpen (below) can wait for the persisted store before detecting a
  // lapse — reading lastOpenDate pre-hydration would always miss it.
  const [storeHydrated, setStoreHydrated] = useState(() => useAppState.persist.hasHydrated());
  useEffect(() => {
    // Re-check synchronously: hydration can finish between the render-time init
    // above and this passive effect, in which case onFinishHydration's callback
    // never fires and storeHydrated would stay false forever — permanently gating
    // lapse detection for that launch.
    if (useAppState.persist.hasHydrated()) {
      setStoreHydrated(true);
      return;
    }
    return useAppState.persist.onFinishHydration(() => setStoreHydrated(true));
  }, []);
  // NEX-191: flips true once the signed-in cloud-restore attempt has finished
  // (loadStateFromCloud + mergeCloudState), so the fresh-install lapse check
  // doesn't record off a pre-restore null. Every real sign-in routes through that
  // one handler; dev/SIM paths fall back to the long backstop in the open effect.
  const [cloudRestoreDone, setCloudRestoreDone] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(SIM_BYPASS);
  const [subCheckDone, setSubCheckDone] = useState(SIM_BYPASS);
  // ─── Legacy free-user grandfather ──────────────────────────────────────────
  // Pre-strict-paywall, the onboarding paywall let users tap "Skip for now",
  // which faked a subscription locally. Removing that button locks those users
  // out on next launch. This flag — set ONCE on the first launch under the
  // strict paywall code — preserves access for anyone whose `isActivated`
  // was already true before this update. New users (isActivated=false on
  // first run) never get the flag set, so they're always paywall-gated.
  const [legacyFreeUser, setLegacyFreeUser] = useState(false);
  const [legacyCheckDone, setLegacyCheckDone] = useState(false);
  // NEX-234: the user tapped "Not now · try free" (or the X) on the launch-gate
  // paywall, so the core capture loop is unlocked without subscribing. NOT an
  // entitlement/tier (the app has no per-feature gating), just a local bypass of
  // the launch upsell, so it is not in Zustand/cloud sync. NEX-204: the AsyncStorage
  // key is scoped per-userId (`nexus_launch_paywall_dismissed:<uid>`) so one
  // account's dismissal never carries to another account on the same device.
  const [launchPaywallDismissed, setLaunchPaywallDismissed] = useState(false);
  const [launchPaywallCheckDone, setLaunchPaywallCheckDone] = useState(SIM_BYPASS);
  const [userId, setUserId] = useState<string | null>(SIM_BYPASS ? SIM_USER_ID : null);

  // Dev-only escape hatch: replicate SIM_BYPASS's signed-in shape on a real
  // device. OAuth fails on device dev clients (Google/Apple client ids are
  // registered to the production bundle id), so without this there is no way
  // past AuthScreen to record onboarding. Marks the module-level dev-skip
  // session flag FIRST so every guard (auth listener, cloud sync, emails,
  // PostHog identify/mirror) sees it before the state updates commit, and
  // suppresses analytics for the whole session (trackEvent local log +
  // PostHog forward + nexus_events inserts — same mute Replay Onboarding
  // uses). legacyCheckDone=true keeps the splash gate at the bottom of this
  // component from hanging. Compiled away in release: __DEV__ folds to
  // false, so the handler is `undefined` and never reaches AuthScreen.
  //
  // End a skip session via Settings → Sign Out (wipes the fake session's
  // store via resetState). The persisted localUserId marker also prevents
  // newly created fake data surviving a kill from reaching a real account.
  // Older unmarked data has unknown ownership and is never guessed/discarded.
  const handleDevSkipAuth = __DEV__
    ? () => {
        stopSyncSession();
        markDevSkipSession();
        useAppState.setState({ localUserId: SIM_USER_ID });
        setAnalyticsReplaySuppressed(true);
        setUserId(SIM_USER_ID);
        setIsSubscribed(true);
        setSubCheckDone(true);
        setLegacyCheckDone(true);
        setAuthState('signed-in');
      }
    : undefined;

  // ─── PostHog product analytics ────────────────────────────────────────────
  // The PostHogProvider lives above this component, so usePostHog() is safe
  // here. We do two things:
  //   1. identify(userId) on every change so PostHog's distinct_id stays
  //      aligned with the Supabase user_id (anonymous or real). This makes
  //      cross-system correlation trivial.
  //   2. capture('$screen') on every Expo Router pathname change so screen
  //      time is visible in PostHog's session view.
  // Autocapture in the provider handles touch events automatically.
  const posthog = usePostHog();
  const pathname = usePathname();

  useEffect(() => {
    if (!posthog || !userId) return;
    // Dev-skip guard: this effect is declared BEFORE the consent-mirror
    // effect below, so on the skip-tap commit it would run while the client
    // is still enabled — identify('sim-dev-user') would reach production
    // PostHog before the mirror flips `disabled`.
    if (__DEV__ && isDevSkipSessionActive()) return;
    // Tag the founder's / test accounts so the "Internal / Test users" cohort
    // ($internal_or_test_user person property) can exclude them from every dashboard.
    if (isInternalUser(userId)) {
      posthog.identify(userId, { $internal_or_test_user: true });
      (posthog as any).register?.({ internal_user: true });
    } else {
      posthog.identify(userId);
    }
  }, [posthog, userId]);

  // Record the real first launch locally (PostHog's own install event only fires after opt-in).
  useEffect(() => {
    void ensureFirstLaunchRecorded();
  }, []);

  // NEX-124: inject the PostHog client into the analytics emitter so trackEvent
  // dual-writes (local log + PostHog). The [posthog] dependency is required —
  // the provider remounts once on hydration (key=ready/pre) and builds a new
  // client; this re-runs and replaces the ref (queued forwards drain on set).
  // Consent flips do NOT recreate the client (the effect below mutates
  // `disabled` in place), so the ref stays valid and respects consent at
  // capture time.
  useEffect(() => {
    setPostHogClient((posthog as any) ?? null);
  }, [posthog]);

  useEffect(() => {
    if (!posthog || !pathname) return;
    // Dev-skip guard: this effect is declared before the consent mirror, so
    // if a route change ever lands in the same commit as the skip tap, the
    // $screen capture would run while the client is still enabled. Checked
    // at call time (module flag, set synchronously in the tap handler), so
    // no extra dep is needed — and no duplicate $screen fires from re-runs.
    if (__DEV__ && isDevSkipSessionActive()) return;
    posthog.screen(pathname);
  }, [posthog, pathname]);

  // NEX-136 P3: mirror runtime consent changes onto PostHog. The provider
  // builds its client once (memoized from apiKey) and only reads the
  // `disabled` option at construction, so flipping the provider prop later
  // does nothing for an already-mounted client. `disabled` is also the
  // dominant gate: the core's capture path and `wrap()` both early-return on
  // `this.disabled`, which means optIn() is a no-op (it never clears OptedOut)
  // while the client is disabled. So flip `disabled` on the client directly,
  // before opt in/out, so a user who taps Allow starts capture without an app
  // restart. Verified against @posthog/core in posthog-react-native v4.45.
  const analyticsConsent = useAppState((s: any) => s.analyticsConsent);
  useEffect(() => {
    if (!posthog) return;
    // Dev-skip guard: disable capture for the whole fake-user session so
    // screen autocapture can't leak to production PostHog. `userId` is in
    // the deps so the skip tap (which sets userId to SIM_USER_ID) re-runs
    // this mirror; for real users the extra dep is an idempotent re-apply.
    const enabled =
      analyticsConsent === 'granted' &&
      !SIM_BYPASS &&
      !(__DEV__ && isDevSkipSessionActive());
    (posthog as any).disabled = !enabled;
    if (enabled) {
      posthog.optIn();
      // NEX-124 Approach C: once capture is enabled, replay the pre-consent
      // funnel events from the local log. One-shot (guarded by a persisted
      // flag inside the helper); a no-op for users who already backfilled.
      void backfillFunnelEventsToPostHog();
      void sendInstallRecordedToPostHog();
    } else {
      posthog.optOut();
    }
  }, [posthog, analyticsConsent, userId]);
  const lastCheckedUid = useRef<string | null>(null);
  // NEX-204: "the app (tabs Stack) is actually visible." After the onboarding↔paywall
  // reorder, `isActivated` no longer implies the Stack is mounted — a paywall can sit
  // between onboarding-finish and the app. This mirrors the gate ternary's Stack branch
  // (not onboarding AND not paywall) and gates the post-onboarding nav + the
  // always-mounted sibling overlays so neither fires/stacks over the paywall.
  const appVisible =
    isActivated &&
    (isSubscribed || legacyFreeUser || launchPaywallDismissed) &&
    !devReplayOnboarding;
  // Free-week re-offer after the first win (or day 3). Fully capped + dismissible; the
  // decision logic is pure and unit-tested (features/paywall/reoffer-logic.ts).
  const triageActive = useTriageStore((s) => s.isActive);
  const reofferActivatedDate = useAppState((s: any) => s.activatedDate) as string | null;
  const reofferFirstWin = useAppState((s: any) => !!s.firstAlignmentScoreSeenFired);
  const reoffer = usePaywallReoffer({
    userId,
    ready: appVisible && subCheckDone && legacyCheckDone && launchPaywallCheckDone && !triageActive && analyticsConsent !== 'unset',
    isSubscribed,
    isLegacyFree: legacyFreeUser,
    launchGateDismissed: launchPaywallDismissed,
    activatedDate: reofferActivatedDate,
    firstWin: reofferFirstWin,
    pathname,
  });
  const prevAppVisible = useRef(false);
  // NEX-204: "the restore attempt has settled, so `isActivated` is trustworthy."
  // On a fresh install an EXISTING signed-in user is transiently `isActivated=false`
  // until loadStateFromCloud restores them; without this the reordered ternary would
  // flash ONBOARDING at them before restore. Mirrors the established settled-signal
  // at the app-open effect: local already has data (returning user) OR the cloud
  // restore finished (cloudRestoreDone) — plus the dev-skip escape hatch.
  const restoreSettled =
    SIM_BYPASS ||
    isDevSkipSessionActive() ||
    cloudRestoreDone ||
    localStoreHasUserData(useAppState.getState());
  const [fontsLoaded, setFontsLoaded] = useState(false);

  useEffect(() => {
    Font.loadAsync({
      'Fraunces-LightItalic':  require('../assets/fonts/Fraunces-LightItalic.ttf'),
      'Inter-Regular':         require('../assets/fonts/Inter-Regular.ttf'),
      'Inter-Medium':          require('../assets/fonts/Inter-Medium.ttf'),
      'Inter-SemiBold':        require('../assets/fonts/Inter-SemiBold.ttf'),
      'Inter-Bold':            require('../assets/fonts/Inter-Bold.ttf'),
      'IBMPlexMono-Regular':   require('../assets/fonts/IBMPlexMono-Regular.ttf'),
      'IBMPlexMono-Medium':    require('../assets/fonts/IBMPlexMono-Medium.ttf'),
      // NEX-303: katakana subset (~10KB) for the loading-surface glyph rain
      // ONLY. CLAUDE.md §2 sanctions this one face beyond the locked three, and
      // §19's "more than three typefaces" carve-out names it. It is scoped to
      // MatrixRain's glyphs — no UI text may resolve it. Regenerate with
      // scripts/subset-katakana-font.sh.
      'IBMPlexSansJP-Katakana': require('../assets/fonts/IBMPlexSansJP-Katakana.ttf'),
    }).catch((err) => {
      console.warn('[fonts] Failed to load one or more fonts — falling back to system:', err);
    }).finally(() => {
      setFontsLoaded(true);
    });
  }, []);

  // Hide the native splash once the React tree has mounted. The 50ms delay lets
  // the first frame paint, so there's no white gap between splash dismissal and content.
  // Placed BEFORE any conditional return so React's hook order stays stable.
  useEffect(() => {
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 50);
    return () => clearTimeout(t);
  }, []);

  // NEX-304: cold-start splash floor. On a warm signed-in launch the auth gate's
  // real conditions (local getSession + store hydration + cached RevenueCat)
  // settle in ~100-400ms — under the native splash's own fade — so the NEX-303
  // rain was invisible in practice. Hold the gate for the LATER of (data ready,
  // splashFloorMs), mirroring preparing-interstitial's minimum-display contract.
  // Applies in dev/sim too: it retires the force-the-gate-open QA hack by making
  // the splash naturally inspectable. The floor extends; it never truncates.
  const [splashFloorElapsed, setSplashFloorElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSplashFloorElapsed(true), tokens.motion.rain.splashFloorMs);
    return () => clearTimeout(t);
  }, []);

  // ─── Legacy free-user detection (one-time) ────────────────────────────────
  // TODO(grandfather-server-check): The current AsyncStorage-based legacy free user
  // detection is per-install. Reinstalls and same-device user swaps will lock out
  // pre-paywall users. Before next App Store submission, add a Supabase check at
  // sign-in: query for users with createdAt < paywall-launch-date and seed
  // nexus_legacy_free_user from that. Until then, free users who reinstall will
  // hit the paywall hard.
  //
  // Runs once after subscription check resolves. If the user was already
  // activated under the prior (skip-allowed) paywall AND has no current
  // entitlement, mark them legacy and persist. The marker is checked on every
  // launch thereafter to bypass the paywall gate. Persisted in AsyncStorage
  // (not Zustand) so it can't be erased by `resetState`.
  useEffect(() => {
    if (!subCheckDone) return;
    if (legacyCheckDone) return;
    // NEX-204: don't FINALIZE the grandfather decision until restore has settled.
    // On a fresh install, an existing pre-reorder user is transiently
    // isActivated=false until cloud restore; finalizing here (the early
    // setLegacyCheckDone below) would skip their grandfather mint and then the
    // `legacyCheckDone` guard would lock them behind the paywall even after
    // restore flips them activated. Re-runs when restoreSettled flips (in deps).
    if (!restoreSettled) return;
    // NEX-204: per-uid keys need a REAL signed-in user — `userId` is also set during
    // the anonymous pre-auth session, and consuming the read there would block the
    // real account's key. Re-runs when authState flips to 'signed-in' (in deps).
    if (authState !== 'signed-in' || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        const scopedKey = scopedDeviceFlagKey(LEGACY_FREE_USER_KEY, userId)!;
        const scoped = await AsyncStorage.getItem(scopedKey);
        if (cancelled) return;
        if (scoped === 'true') {
          setLegacyFreeUser(true);
          setLegacyCheckDone(true);
          return;
        }
        // NEX-204: one-time migrate the pre-per-uid unscoped key. ADOPT an existing
        // 'true' UNCONDITIONALLY — it was already validated by the mint path when
        // written; re-validating against the cloud-mutable `activatedDate` would
        // wrongly LOCK OUT a genuine legacy user whose date was re-stamped post-cutoff.
        // Consume the unscoped key so only the first account to open the new build
        // adopts it (the same shared-device tolerance the mint path already has).
        if (scoped === null) {
          const unscoped = await AsyncStorage.getItem(LEGACY_FREE_USER_KEY);
          if (!cancelled && unscoped !== null) {
            // Write the scoped key FIRST, then best-effort remove the unscoped one.
            // If the scoped write failed (storage full/corrupt) and we'd already
            // removed the unscoped key, the only legacy marker would be gone and a
            // grandfathered user would be paywalled next launch.
            if (unscoped === 'true') await AsyncStorage.setItem(scopedKey, 'true');
            await AsyncStorage.removeItem(LEGACY_FREE_USER_KEY);
            if (unscoped === 'true') {
              if (!cancelled) { setLegacyFreeUser(true); setLegacyCheckDone(true); }
              return;
            }
          }
        }
        // Fresh mint — only a user who activated under the prior (skip-allowed)
        // paywall is legacy; a post-reorder new user has a fresh post-cutoff date.
        // A null activatedDate counts as legacy (migrated user) — see the helper.
        const activatedDate = (useAppState as any).getState?.()?.activatedDate as string | null;
        if (isActivated && !isSubscribed && isActivatedBeforeReorder(activatedDate)) {
          await AsyncStorage.setItem(scopedKey, 'true');
          if (!cancelled) setLegacyFreeUser(true);
        }
        if (!cancelled) setLegacyCheckDone(true);
      } catch (e) {
        console.log('[Paywall] legacy-check error:', e);
        if (!cancelled) setLegacyCheckDone(true);
      }
    })();
    return () => { cancelled = true; };
  }, [subCheckDone, isActivated, isSubscribed, legacyCheckDone, restoreSettled, userId, authState]);

  // NEX-234: resolve the launch-paywall-dismissed flag before the gate renders,
  // so a returning free user never flashes the paywall while AsyncStorage reads.
  // Independent of the sub/legacy checks — it's a plain persisted read.
  useEffect(() => {
    if (launchPaywallCheckDone) return;
    // NEX-204: per-uid keys need a REAL signed-in user (userId is also set during the
    // anonymous pre-auth session). Re-runs when authState flips to 'signed-in'.
    if (authState !== 'signed-in' || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        const scopedKey = scopedDeviceFlagKey(LAUNCH_PAYWALL_DISMISSED_KEY, userId)!;
        let v = await AsyncStorage.getItem(scopedKey);
        if (cancelled) return;
        // NEX-204: one-time migrate the pre-per-uid unscoped key to this user, then
        // consume it so a later account on the same device can't inherit it.
        if (v === null) {
          const unscoped = await AsyncStorage.getItem(LAUNCH_PAYWALL_DISMISSED_KEY);
          if (!cancelled && unscoped !== null) {
            // Scoped write FIRST, then best-effort cleanup (see legacy effect) so a
            // failed scoped write can never drop a dismissal the user already made.
            if (unscoped === 'true') await AsyncStorage.setItem(scopedKey, 'true');
            await AsyncStorage.removeItem(LAUNCH_PAYWALL_DISMISSED_KEY);
            v = unscoped;
          }
        }
        if (!cancelled && v === 'true') setLaunchPaywallDismissed(true);
      } catch (e) {
        console.log('[Paywall] launch-dismiss check error:', e);
      } finally {
        if (!cancelled) setLaunchPaywallCheckDone(true);
      }
    })();
    return () => { cancelled = true; };
  }, [launchPaywallCheckDone, userId, authState]);

  // NEX-204: flush the post-onboarding route when the app (tabs Stack) BECOMES
  // VISIBLE, not merely when onboarding finishes. After the reorder a paywall can
  // sit between onboarding-finish and the Stack mounting, so firing on the
  // `isActivated` edge would `router.replace` against an unmounted Stack, exhaust
  // the retries in ~3.5s, and lose the route (→ wrong default tab after subscribe).
  // We also do NOT null `_pendingOnboardingRoute` until app-visible, so a dismiss/
  // subscribe later still flushes it. `initialRouteName="home"` is the backstop.
  useEffect(() => {
    if (appVisible && !prevAppVisible.current && _pendingOnboardingRoute) {
      const route = _pendingOnboardingRoute;
      _pendingOnboardingRoute = null;
      let cancelled = false;
      let attempts = 0;
      const tryNavigate = () => {
        if (cancelled) return;
        attempts++;
        try {
          const { router } = require('expo-router');
          router.replace(route);
        } catch (_) {
          if (attempts < 15 && !cancelled) {
            setTimeout(tryNavigate, 200);
          }
        }
      };
      const timer = setTimeout(tryNavigate, 500);
      // Mark seen before the early return (the bottom assignment is unreachable
      // in this branch) so a re-render with appVisible still true won't re-fire.
      prevAppVisible.current = appVisible;
      return () => { cancelled = true; clearTimeout(timer); };
    }
    prevAppVisible.current = appVisible;
  }, [appVisible]);

  const runSubscriptionCheck = async (uid: string, isCurrent = () => true) => {
    lastCheckedUid.current = uid;
    setSubCheckDone(false);
    // NEX-204: ignore a completion whose `uid` is no longer the one being checked. A
    // prior account's slow RC branch keeps running after a sign-out→sign-in switch
    // (the 8s timeout only rejects the race, it can't abort the branch), so guard
    // every identity side-effect and state write with this generation check.
    const isStale = () => lastCheckedUid.current !== uid || !isCurrent();
    try {
      // NEX-204: a SINGLE 8s deadline covers configure + identify + checkSubscription.
      // Bounding configure/identify is the lockout fix (#1776): when either hung,
      // `finally` never ran, `subCheckDone` never set, and an activated user sat on
      // the splash forever. Identity is bound BEFORE checkSubscription so a purchase
      // can never attach to the anonymous RC user (#2329). On a config/identify
      // failure we do NOT grant app access — the gate renders the NEX-234-dismissible
      // launch paywall (never trapped, never silently let in free); a hung RC also
      // can't load offerings, so no purchase can attach to anon on that path either.
      await Promise.race([
        (async () => {
          await configureRevenueCat();
          if (isStale()) return; // a newer account took over before identity bind
          await identifyUser(uid, isStale); // NEX-297: guards the PostHog-link call too
          if (isStale()) return;
          const sub = await checkSubscription();
          if (isStale()) return; // a newer account took over before the state write
          setIsSubscribed(sub.isSubscribed);
          // NEX-232/236: refresh the pre-charge reminder now RC is configured for
          // this user (quiet window from the live store). Fire-and-forget; stays
          // inside the identified branch so it never runs before identity is bound.
          const billingQuiet = resolveQuietWindow(useAppState.getState().notificationSettings);
          void reconcileBillingReminders(undefined, billingQuiet);
          // NEX-301: same launch-time refresh for the in-trial nudge.
          void reconcileTrialNudges(undefined, billingQuiet);
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RevenueCat timeout')), 8000))
      ]);
    } catch (e) {
      console.log('[RC] Init failed/timeout, defaulting to not subscribed:', e);
      if (!isStale()) setIsSubscribed(false);
    } finally {
      if (!isStale()) setSubCheckDone(true);
    }
  };

  useEffect(() => {
    const iosClientId = publicConfigValue(
      'EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID',
      process.env.EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID,
    );
    if (!iosClientId) {
      // NEX-84 Greptile fix: skip configure() entirely when the env var
      // is missing. Calling configure with iosClientId=undefined produces
      // cryptic native failures at first sign-in attempt instead of a
      // clear "no client id" warning here.
      console.log('[Auth] EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID is not set — Google Sign-In disabled');
      return;
    }
    GoogleSignin.configure({
      iosClientId,
      scopes: ['email', 'profile', 'openid'],
    });
  }, []);

  useEffect(() => {
    // CRITICAL: Configure RevenueCat on app launch regardless of auth state.
    // Otherwise paywall can't load products (Apple reviewers don't sign up).
    (async () => {
      try {
        await configureRevenueCat();
        console.log('[RC] Configured on launch (pre-auth)');
      } catch (e) {
        console.log('[RC] Launch config failed:', e);
      }
    })();

    if (SIM_BYPASS) return; // skip Supabase auth and RevenueCat in simulator

    const lifecycle = createSyncAuthLifecycle({
      waitForHydration: waitForAppStateHydration,
      hasHydrated: () => useAppState.persist?.hasHydrated?.() ?? true,
      localUserId: () => useAppState.getState().localUserId ?? null,
      setLocalUserId: (uid) => useAppState.setState({ localUserId: uid }),
      resetLocal: () => useAppState.getState().resetState(),
      isDeletionPending: isAccountDeletionPending,
      beginSession: beginSyncSession,
      stopSession: stopSyncSession,
      restore: restoreFromCloud,
    });
    let latestAuthSession = null;
    let displayedSyncSession = null;
    let phoneRestoreSession = null;
    let displayedPausedUserId = null;

    // App-owned transition also covers hardSignOut, which intentionally never
    // calls the SDK's signOut (its late completion can erase a newer session).
    const applySignedOutState = () => {
      stopSyncSession();
      void stopUserStateRealtime();
      void clearCloudSyncMetadata().catch(() => {});
      setUserId(null);
      setAuthState('signed-out');
      setCloudRestoreDone(false);
      setSubCheckDone(false);
      lastCheckedUid.current = null;
      displayedSyncSession = null;
      try {
        useAppState.getState().resetState();
      } catch (e) {
        console.log('[Auth] resetState on sign-out failed:', e);
      }
      setLegacyFreeUser(false);
      setLegacyCheckDone(false);
      setLaunchPaywallDismissed(false);
      setLaunchPaywallCheckDone(SIM_BYPASS);
    };

    setForceSignOutHandler(() => {
      lifecycle.observe(null);
      latestAuthSession = null;
      if (__DEV__ && isDevSkipSessionActive()) {
        clearDevSkipSession();
        setAnalyticsReplaySuppressed(false);
      }
      applySignedOutState();
    });

    const handleAuthStateChange = async (event, authSession, transition) => {
      const uid = authSession?.user && !authSession.user.is_anonymous ? authSession.user.id : null;
      const authTurn = lifecycle.capture();
      const isCurrent = () => transition.isCurrent() && authTurn.isCurrent() && lifecycle.accepts(uid);
      if (!isCurrent()) return;
      if (__DEV__ && isDevSkipSessionActive()) {
        if (uid || event === 'SIGNED_OUT') {
          clearDevSkipSession();
          setAnalyticsReplaySuppressed(false);
        } else {
          return;
        }
      }
      if (!uid) {
        applySignedOutState();
        return;
      }

      // Hydrate BEFORE checking provenance/resetting; otherwise an in-flight
      // hydration can bring account A's data back after account B's reset.
      const owner = await lifecycle.prepare(uid, isCurrent);
      if (!isCurrent()) return;
      if (!owner && lifecycle.isDeletionPaused(uid)) {
        // Preserve local access so the user can retry deletion from Settings.
        // The persisted marker prevents any startup/refresh cloud write.
        setUserId(uid);
        setAuthState('signed-in');
        setCloudRestoreDone(true);
        if (displayedPausedUserId !== uid) {
          displayedPausedUserId = uid;
          lastCheckedUid.current = null;
          Alert.alert('Cloud saving paused', 'Account deletion is unfinished or its saved status could not be read. Open Settings to retry deleting your account. Your local data has been kept.');
        }
        if (lastCheckedUid.current !== uid) {
          const identity = lifecycle.captureIdentity();
          void runSubscriptionCheck(uid, identity.isCurrent);
        }
        return;
      }
      if (!owner?.isCurrent()) return;
      if (displayedSyncSession !== owner) {
        setCloudRestoreDone(false);
        displayedSyncSession = owner;
        lastCheckedUid.current = null;
      }
      setUserId(uid);
      setAuthState('signed-in');
      if (lastCheckedUid.current !== uid) {
        void runSubscriptionCheck(uid, owner.isCurrent);
      }
      try {
        await lifecycle.restore(owner);
      } catch (error) {
        console.warn('[Sync] Restore failed:', error);
      }
      if (!isCurrent() || !owner.isCurrent()) return;
      // A failed cloud read remains dirty/blocked in the coordinator. Releasing
      // this UI gate means the attempt finished, never that local data was sent.
      setCloudRestoreDone(true);
      if (event === 'TOKEN_REFRESHED') startUserStateRealtime(owner);

      if (phoneRestoreSession !== owner) {
        phoneRestoreSession = owner;
        try {
          const { data: profileRow } = await supabase.from('user_profile')
            .select('phone_number').eq('user_id', uid).maybeSingle();
          if (!owner.isCurrent()) return;
          if (profileRow?.phone_number) useAppState.getState().setPhoneNumber(profileRow.phone_number);
        } catch {}
      }
    };

    // auth-js awaits the RAW callback while holding its session lock. Invalidate
    // synchronously here, then retain the proven deferred listener for all work.
    const deferredListener = deferredAuthListener(handleAuthStateChange, (err) => {
      addAppBreadcrumb('auth', 'listener_failed', { message: err instanceof Error ? err.message : String(err) });
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, authSession) => {
      const uid = authSession?.user && !authSession.user.is_anonymous ? authSession.user.id : null;
      const devSkip = __DEV__ && isDevSkipSessionActive();
      if (devSkip && !uid && event !== 'SIGNED_OUT') return;
      lifecycle.observe(uid, devSkip && !!uid);
      latestAuthSession = authSession;
      deferredListener(event, authSession);
    });

    // The launch lookup is allowed to act only if no raw event/forced sign-out
    // has arrived since it began. It shares the same restore as auth events.
    const launch = lifecycle.capture();
    void supabase.auth.getSession().then(({ data: { session: authSession } }) => {
      if (!launch.isCurrent()) return;
      const uid = authSession?.user && !authSession.user.is_anonymous ? authSession.user.id : null;
      const transition = lifecycle.observe(uid, __DEV__ && isDevSkipSessionActive() && !!uid);
      latestAuthSession = authSession;
      return handleAuthStateChange('INITIAL_SESSION', authSession, transition);
    }).catch(() => {
      if (!launch.isCurrent()) return;
      lifecycle.observe(null);
      applySignedOutState();
    });

    // The short hydration wait is bounded. If disk finishes later, retry the
    // current auth owner without ever starting sync against unhydrated defaults.
    const stopHydrationRetry = useAppState.persist?.onFinishHydration?.(() => {
      if (!latestAuthSession?.user || !lifecycle.accepts(latestAuthSession.user.id)) return;
      void handleAuthStateChange('HYDRATED', latestAuthSession, lifecycle.capture()).catch(() => {});
    });

    return () => {
      lifecycle.dispose();
      void stopUserStateRealtime();
      subscription.unsubscribe();
      stopHydrationRetry?.();
      setForceSignOutHandler(null);
    };
  }, []);

  // Weekly email summary trigger (on app open when signed in).
  // Reactive selector so the effect re-runs once the profile email loads — it's
  // fetched async on cold open, so depending only on [authState] meant the
  // effect ran before the email arrived, bailed, and never retried.
  const weeklyEmailUserEmail = useAppState((st: any) => st.userProfile?.email ?? null);
  useEffect(() => {
    if (authState !== 'signed-in' || !weeklyEmailUserEmail) return;
    // Dev-skip session: local state can hold a real profile email (replay on
    // an install with existing data) — never fire the edge-function send.
    if (__DEV__ && isDevSkipSessionActive()) return;
    try {
      const s = useAppState.getState() as any;
      checkAndSendWeeklySummary({
        weeklyEmailEnabled: !!s.weeklyEmailEnabled,
        weeklyEmailConsent: s.weeklyEmailConsent ?? 'unset',
        weeklyEmailDay: s.weeklyEmailDay ?? 0,
        userEmail: weeklyEmailUserEmail,
        userName: s.userProfile?.name ?? 'User',
        habitLog: s.habitLog ?? [],
        recurringRules: s.recurringRules ?? [],
        habitStreaks: s.habitStreaks ?? {},
        dailyScores: s.dailyScores ?? {},
        pauseMode: s.pauseMode, // NEX-207: paused weeks don't count as missed in the real send
      }).catch(() => {});
    } catch {}
  }, [authState, weeklyEmailUserEmail]);

  // NEX-191: record the app open (and detect a >=3-day shame-free return) once
  // the prior lastOpenDate is trustworthy. This is path-independent across every
  // sign-in route (session restore, AuthScreen/auth-listener, dev-skip):
  //   - a RETURNING user has local data after hydration → record now (the
  //     hydrated lastOpenDate is canonical; cloud merge is skipped for them).
  //   - a FRESH install has no local data and may restore lastOpenDate from cloud
  //     shortly (after authState flips to 'signed-in', and after a sub-check that
  //     can take several seconds) → defer until the store gains user data (merge
  //     landed) OR the cloud-restore attempt has finished (cloudRestoreDone, for a
  //     genuinely new user with nothing to restore). A blind timer is wrong here
  //     because the restore can start many seconds after sign-in; cloudRestoreDone
  //     is the real signal. The long backstop only covers dev/SIM paths that never
  //     run the cloud handler.
  const recordedOpenRef = useRef(false);
  useEffect(() => {
    if (authState !== 'signed-in' || !storeHydrated || recordedOpenRef.current) return;
    const record = () => {
      if (recordedOpenRef.current) return;
      recordedOpenRef.current = true;
      try {
        const s = useAppState.getState() as any;
        // NEX-222: read the PREVIOUS lastOpenDate BEFORE recordAppOpen overwrites
        // it, then emit app_opened once per local day (consent-gated; raw facts
        // only). Folded into this hydration/cloud-restore-gated seam (was in the
        // racy [authState] effect on main) so days_since_last_active_day uses the
        // restored lastOpenDate on fresh installs too, not a pre-restore null.
        const prevOpenDayKey: string | null = s.lastOpenDate ?? null;
        if (typeof s.recordAppOpen === 'function') s.recordAppOpen();
        const todayDayKey = getLocalDateKey(new Date());
        if (prevOpenDayKey !== todayDayKey) {
          const { daysSinceLastActiveDay } = classifyOpen(prevOpenDayKey, todayDayKey);
          void trackEvent('app_opened', {
            local_day_key: todayDayKey,
            days_since_last_active_day: daysSinceLastActiveDay,
          });
        }
        // NEX-277: when notification quotes are on, personalize from the user's
        // mandates and auto-use filter-safe lines (no human gate). Fire-and-forget so
        // it never blocks launch. (1) Evict lines generated from a now-stale mandate
        // context, (2) generate against the post-eviction pool, (3) if new lines
        // landed, reschedule — today's notifications were already scheduled before
        // generation finished, so the fresh lines need a reschedule to appear.
        if (
          s.notificationSettings?.includeQuotes === true &&
          s.notificationSettings?.personalizedQuotes !== false && // kill switch off ⇒ seed-only, skip generation
          typeof s.setQuotesPool === 'function'
        ) {
          const { mandates, hash } = mandateContext(s.pillars);
          useAppState.getState().syncMandateContext(hash);
          const poolForGen = useAppState.getState().quotesPool;
          void generateQuotesIntoPool(poolForGen, mandates)
            .then((p) => {
              const grew = p.pending.length > poolForGen.pending.length;
              useAppState.getState().mergeGeneratedQuotes(p);
              if (grew && useAppState.getState().notificationSettings?.includeQuotes === true) {
                const st = useAppState.getState() as any;
                const ns = st.notificationSettings || {};
                const genTodayKey = getLocalDateKey(new Date());
                scheduleAllNotifications({
                  morningHour: ns.morningHour ?? 8,
                  morningMinute: ns.morningMinute ?? 0,
                  eveningHour: ns.eveningHour ?? 20,
                  eveningMinute: ns.eveningMinute ?? 0,
                  weeklyDay: ns.weeklyDay ?? 0,
                  weeklyHour: ns.weeklyHour ?? 10,
                  milestoneAlerts: ns.milestoneAlerts !== false,
                  silenced: areNudgesSilenced({ pauseMode: st.pauseMode }),
                  smartTiming: ns.smartTiming !== false,
                  openHourCounts: st.appLaunchHourCounts,
                  includeQuotes: true,
                  personalized: ns.personalizedQuotes !== false,
                  quotesPool: st.quotesPool,
                  todayWisdom: todayWisdomForNotification(st, genTodayKey), // today's-win source
                  yesterdayWisdom: wisdomForNotificationDate(st, addDaysToKey(genTodayKey, -1), genTodayKey), // morning slot
                  onQuotesSelected: st.recordQuotesShown,
                }).catch(() => {});
              }
            })
            .catch(() => {});
        }
      } catch {}
    };
    // Returning user (local data canonical), or the cloud-restore attempt already
    // finished → safe to record now.
    if (localStoreHasUserData(useAppState.getState()) || cloudRestoreDone) {
      record();
      return;
    }
    // Fresh install, restore still pending: record the instant cloud data lands.
    // (cloudRestoreDone flipping re-runs this effect and records for new users.)
    const unsub = useAppState.subscribe((s: any) => {
      if (localStoreHasUserData(s)) record();
    });
    // Dev/SIM backstop only — real sign-ins resolve via cloudRestoreDone well before this.
    const backstop = setTimeout(record, 20000);
    return () => {
      unsub();
      clearTimeout(backstop);
    };
  }, [authState, storeHydrated, cloudRestoreDone]);

  // NEX-191: on sign-out, re-arm BOTH the once-per-launch guard and the
  // cloud-restore gate, so an account switch within the same JS runtime waits for
  // the NEW account's restore before recording. Otherwise cloudRestoreDone stays
  // sticky-true from account A and account B would record against the reset (empty)
  // store, miss its lapse, and lock recordedOpenRef before B's cloud merge lands.
  useEffect(() => {
    if (authState !== 'signed-in') {
      recordedOpenRef.current = false;
      setCloudRestoreDone(false);
    }
  }, [authState]);

  useEffect(() => {
    if (authState !== 'signed-in') return;
    try {
      const s = useAppState.getState() as any;
      // NEX-191 × NEX-222: recordAppOpen AND the app_opened analytics both moved
      // to the hydration/cloud-restore-gated effect above (they must read the prior
      // lastOpenDate post-restore). This effect keeps only the monthly streak-freeze
      // grant below.

      const now = new Date();
      const thisYearMonth = `${now.getFullYear()}-${now.getMonth()}`;
      const lastFreezeYearMonth = s.lastFreezeDate ? (() => {
        const d = new Date(s.lastFreezeDate);
        return `${d.getFullYear()}-${d.getMonth()}`;
      })() : '';
      if (thisYearMonth !== lastFreezeYearMonth && s.streakFreezes < 1) {
        useAppState.setState({ streakFreezes: 1 });
      }
    } catch {}
  }, [authState]);

  // The coordinator owns payload watching, debouncing and fallback sync.
  // This effect owns device lifecycle and the independent connector queue.
  useEffect(() => {
    if (SIM_BYPASS || authState !== 'signed-in' || !userId || !storeHydrated || !cloudRestoreDone) return;
    if (__DEV__ && isDevSkipSessionActive()) return;
    const owner = getSyncSession(userId);
    if (!owner?.isCurrent()) return;
    const stopCloud = startCloudSync(owner);
    startUserStateRealtime(owner);
    let draining = false;
    const drain = async () => {
      if (draining || !owner.isCurrent()) return;
      draining = true;
      try {
        const deviceId = await getConnectorDeviceId();
        if (!owner.isCurrent()) return;
        await drainConnectorActions(owner, deviceId);
      } catch (error) {
        console.warn('[Connector] drain failed:', error);
      } finally {
        draining = false;
      }
    };
    void drain();
    const connectorInterval = setInterval(() => void drain(), 5 * 60 * 1000);
    const appState = AppState.addEventListener('change', (nextState) => {
      if (!owner.isCurrent()) return;
      if (nextState === 'active') {
        startUserStateRealtime(owner);
        void requestCloudPull(owner).catch(() => {});
        void drain();
      } else if (nextState === 'background') {
        void flushCloudSync(owner).catch(() => {});
      }
    });
    const cleanup = () => {
      clearInterval(connectorInterval);
      appState.remove();
      stopCloud();
      void stopUserStateRealtime(owner);
    };
    const removeStopHook = owner.onStop(cleanup);
    return () => { removeStopHook(); cleanup(); };
  }, [authState, userId, storeHydrated, cloudRestoreDone]);

  // Splash holds for a signed-in user until the relevant state is trustworthy:
  //  - ALWAYS until `restoreSettled` — so `isActivated` is reliable before the
  //    onboarding↔paywall ternary decides (no existing-user onboarding flash, no
  //    new-user paywall flash in the subCheck→restore gap).
  //  - until `subCheckDone` ONLY when `isActivated` — the subscription result is
  //    needed for the PAYWALL branch, not for onboarding. A genuinely-new user
  //    (isActivated=false post-restore) reaches onboarding without waiting on
  //    RevenueCat. (Today subCheck resolves before restore so the practical wait is
  //    unchanged; this is the correct shape and lets a future parallelized
  //    subCheck+restore show onboarding the moment restore lands.)
  // SIM_BYPASS/dev-skip short-circuit restoreSettled so they never hang here.
  if (
    !splashFloorElapsed || // NEX-304: hold for the splash floor (see the state's comment)
    authState === 'loading' ||
    (authState === 'signed-in' && !restoreSettled) ||
    (authState === 'signed-in' && isActivated && !subCheckDone)
  ) {
    // NEX-303: the canonical loading register. This gate returns BEFORE the
    // `!fontsLoaded` gate below and before the StarField mounts, so NexusSplash
    // paints its own void and its katakana falls back to the system face for
    // these first frames. That graceful degradation is why the rain is plain RN
    // rather than Skia — see MatrixRain.tsx's header.
    return <NexusSplash accessibilityLabel="Nexus is loading." testID="splash-auth-gate" />;
  }

  if (!fontsLoaded) {
    // Deliberately NOT NexusSplash: this gate must stay dependency-free.
    return <View style={{ flex: 1, backgroundColor: tokens.color.void }} />;
  }

  if (authState === 'signed-out') {
    return (
      <AuthScreen
        onSignedIn={() => setAuthState('signed-in')}
        onDevSkip={__DEV__ ? handleDevSkipAuth : undefined}
      />
    );
  }

  // Hold for the legacy-free check AND the NEX-234 launch-paywall-dismissed check
  // before we'd otherwise flash the paywall at a grandfathered / already-dismissed
  // user — but ONLY when `isActivated` (the paywall is the next screen). A
  // genuinely-new user (isActivated=false, and reliable because the first gate
  // above held until `restoreSettled`) goes straight to onboarding without waiting
  // on the legacy check, which itself can't resolve until subCheckDone. Safe
  // because `restoreSettled` already guaranteed `isActivated` is trustworthy here.
  if ((!legacyCheckDone || !launchPaywallCheckDone) && !SIM_BYPASS && isActivated) {
    return <NexusSplash accessibilityLabel="Nexus is loading." testID="splash-legacy-gate" />;
  }

  // DEV-only escape hatch: let /redesign/* routes render even when the
  // user isn't activated. Lets the dev showcase be reached without
  // completing onboarding (which 401s on Pulse when the proxy token
  // isn't configured). Remove or scope tighter before ship.
  const isDevShowcaseRoute = __DEV__ && typeof pathname === 'string' && pathname.startsWith('/redesign');

  return (
    <ErrorBoundary>
      <OnboardingProvider>
        {/* NEX-43 v2: root view owns the void background, then the StarField
            mounts on top of that void, then the conditional screen mounts
            on top of the stars. Screen containers paint transparent
            backgrounds so the field shows through underneath their content.
            v3 stellar follow-up: the legibility scrim lives INSIDE StarField
            (between galaxy photo and twinkle dots) — see that file's
            Layer 1.5 comment.

            NEX-? hoist: PaywallScreen, OnboardingScreen, and Stack all
            mount OVER this same StarField+void wrapper rather than
            short-circuiting before it. That makes the cosmic backdrop a
            single global instance for the entire app lifetime and lets
            onboarding's transparent backgrounds reveal it. */}
        <View style={{ flex: 1, backgroundColor: tokens.color.void }}>
          <StarField />
          <View style={StyleSheet.absoluteFill}>
            {(__DEV__ && devReplayOnboarding) || (!isActivated && restoreSettled && !isDevShowcaseRoute && !SIM_BYPASS) ? (
              // NEX-204: onboarding renders BEFORE the paywall now — a new user
              // reaches the orb→first-item "first win" before any sales pitch
              // (research: show value before the pitch; better TTFV + conversion).
              // `restoreSettled` guards the regression Greptile/T-Rex caught: a
              // fresh-install EXISTING user is transiently `isActivated=false` until
              // cloud restore, and must NOT flash onboarding — until restore settles
              // they fall through to the (dismissible) paywall branch (the pre-reorder
              // behavior), then to the app once `isActivated` restores.
              // Dev-replay disjunct stays FIRST so a subscribed dev can still
              // re-record onboarding; __DEV__-gated so release builds compile it away.
              <OnboardingScreen />
            ) : !isSubscribed && !legacyFreeUser && !launchPaywallDismissed ? (
              // NEX-234: the launch paywall now passes `onClose` — dismissing
              // ("Not now · try free" or the X) unlocks the free tier so the
              // core capture loop is never trapped behind payment (Law A/D).
              // The forward paths are subscribe (onSubscribed) OR dismiss.
              // NEX-204: this now sits AFTER onboarding. entryPoint stays
              // "launch_gate" — it gates the dismiss ("Not now · try free") button
              // (paywall-screen.tsx:421) and the paywall_viewed/dismissed analytics;
              // changing it would remove dismissibility and re-trap users.
              <RemotePaywallScreen
                entryPoint="launch_gate"
                onSubscribed={() => setIsSubscribed(true)}
                // PaywallScreen fires `paywall_dismissed` itself (symmetric with
                // paywall_viewed); this handler unlocks the free tier now and
                // best-effort persists it. The in-memory set is unconditional so a
                // failed disk write never re-traps THIS session; if the write does
                // fail, the worst case on relaunch is a re-shown — but now
                // dismissible — paywall (and an activated user is caught by the
                // legacyFreeUser grant anyway), never the old subscribe-or-quit trap.
                onClose={() => {
                  setLaunchPaywallDismissed(true);
                  // NEX-204: persist under the per-uid key (the paywall only renders
                  // for a signed-in activated user, so `userId` is non-null here).
                  const key = scopedDeviceFlagKey(LAUNCH_PAYWALL_DISMISSED_KEY, userId);
                  if (key) {
                    AsyncStorage.setItem(key, 'true').catch((e) =>
                      console.log('[Paywall] persist launch-dismiss failed:', e),
                    );
                  }
                }}
              />
            ) : (
              // NEX-43 v3: contentStyle: 'transparent' so expo-router's
              // Stack doesn't paint a default light/system background
              // between the transparent screens and the void below.
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              >
                <Stack.Screen name="(tabs)" />
                <NotificationHandler />
              </Stack>
            )}
          </View>
          {/* Film grain — LAST child, so one grain structure runs across the
              whole frame, cards included. Grain that stops at a card edge tells
              the eye the card was pasted on. Also dithers 8-bit near-black,
              which bands visibly on OLED. Static, pointerEvents none. */}
          <FilmGrain />
        </View>
        {reoffer.visible && (
          <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={reoffer.onClose}>
            <RemotePaywallScreen
              entryPoint="re_offer"
              onSubscribed={() => {
                setIsSubscribed(true);
                reoffer.onSubscribed();
              }}
              onClose={reoffer.onClose}
            />
          </Modal>
        )}
        {/* OnboardingOverlay drives the in-app tutorial AND is used during the
            onboarding flow; it self-gates on a registered tab-target rect (returns
            null with no target), which can't exist while the paywall is up — so it
            needs no appVisible wrap (and wrapping it would break the onboarding tour). */}
        <OnboardingOverlay />
        {/* Phase 5 — first-connect Apple Reminders triage. Mounts as a
            full-screen Modal above the tab navigator only when the
            triage store says isActive (which is gated by
            triageCompletedAt === null AND first sync delivered items).
            Self-unmounts on complete/dismiss.
            NEX-204: gate on appVisible so it can't stack over the paywall now
            that onboarding (→ isActivated) precedes the paywall. */}
        {appVisible && <TriageFlow />}
        {/* NEX-136 P3: first-run analytics consent. Self-gates on
            isActivated && analyticsConsent === 'unset', so it shows once
            after onboarding (and once for migrated existing users).
            NEX-204: gate on appVisible so it doesn't stack over the paywall. */}
        {appVisible && <AnalyticsConsentSheet />}
        {/* Communication invitations are sequenced after analytics and any
            Reminders triage. Their own durable day gates keep email and SMS
            separate instead of stacking requests in one session. */}
        {appVisible && analyticsConsent !== 'unset' && !triageActive && <EmailOptInSheet />}
        {appVisible && analyticsConsent !== 'unset' && !triageActive && <SmsOptInSheet />}
        {SIM_BYPASS && (
          <View style={styles.simBadge} pointerEvents="none">
            <Text style={styles.simBadgeText}>DEV · SIM</Text>
          </View>
        )}
      </OnboardingProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  // Dev-only simulator badge — visible only when SIM_BYPASS is active
  simBadge: {
    position: 'absolute',
    top: 56 /* FIXME(nex-56): off-scale spacing 56 — review */,
    right: tokens.spacing.md,
    zIndex: 9999,
  },
  simBadgeText: {
    fontFamily: tokens.type.labelTrackedMicro.fontFamily,
    fontSize: tokens.type.labelTrackedMicro.fontSize,
    lineHeight: tokens.type.labelTrackedMicro.lineHeight,
    letterSpacing: tokens.type.labelTrackedMicro.fontSize * tokens.type.labelTrackedMicro.letterSpacing,
    color: tokens.color.gold,
    opacity: 0.4,
    textTransform: 'uppercase',
  },
  obContainer: { flex: 1, backgroundColor: 'transparent', justifyContent: 'center' },
  obContent: { padding: 30 /* FIXME(nex-56): off-scale spacing 30 — between lg(24) and xl(32), review */, alignItems: 'center' },
  // FIXME(nex-56): off-scale fontSize 18, design review
  obTitle: { color: GOLD, fontSize: 18, fontWeight: '900', letterSpacing: 8, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 10, design review
  obSubtitle: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 4, marginBottom: 60 /* FIXME(nex-56): off-scale spacing 60 — between xxl(48) and xxxl(72), review */ },
  inputContainer: { width: '100%', marginBottom: 40 /* FIXME(nex-56): off-scale spacing 40 — review */ },
  // FIXME(nex-56): tokens.color.text off-scale neutral white — design review
  // FIXME(nex-56): off-scale fontSize 24, design review
  stepTitle: { color: tokens.color.text, fontSize: 24, fontWeight: 'bold', marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 14, design review
  stepDesc: { color: tokens.color.textMuted, fontSize: 14, marginBottom: tokens.spacing.md },
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray border — design review
  // FIXME(nex-56): off-scale fontSize 20, design review
  obInput: { color: GOLD, fontSize: 20, borderBottomWidth: 1, borderBottomColor: tokens.color.textDisabled, paddingVertical: tokens.spacing.sm },
  // Note: 111 close to surface (111113, delta 1 digit, established precedent)
  // FIXME(nex-56): tokens.color.goldHairline neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline)
  presetChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: tokens.color.surface, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.goldHairline, paddingVertical: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, paddingHorizontal: 18 /* FIXME(nex-56): off-scale spacing 18 — review */ },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): fontSize 15 matches bodyMd size but fontWeight '500' ≠ token '400' (matches bodyMdEmphasis weight); no fontFamily set — design review
  presetText: { color: tokens.color.textMuted, fontSize: 15, fontWeight: '500' },
  // Note: 111 close to surface (111113, delta 1 digit, established precedent)
  // FIXME(nex-56): tokens.color.goldHairline neutral border, no token — design review
  habitChipOb: { backgroundColor: tokens.color.surface, borderRadius: 20, borderWidth: 1, borderColor: tokens.color.goldHairline, paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, paddingHorizontal: 18 /* FIXME(nex-56): off-scale spacing 18 — review */ },
  habitChipObSelected: { backgroundColor: GOLD, borderColor: GOLD },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 14, design review
  habitChipObText: { color: tokens.color.textMuted, fontSize: 14, fontWeight: '600' },
});

// NEX-269: wrap the root for Sentry's touch/navigation instrumentation. JS init
// happens earlier in src/sentry-init.ts (via the custom entry index.js); wrap is
// a no-op when Sentry was not initialized (dev/sim or missing DSN), and composes
// with the PostHogProvider key-remount and the in-tree ErrorBoundary.
export default Sentry.wrap(RootLayout);
