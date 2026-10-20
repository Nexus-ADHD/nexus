// src/features/settings/settings-screen.tsx
// Settings — account management, notifications, weekly email, help, sign out
// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Alert, ScrollView,
  Linking, Modal, Switch, TextInput, Platform, Share, AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import { supabase } from '../../services/supabase';
import { hardSignOut, notifyForceSignOut } from '../../services/sign-out';
import { getSyncSession, stopSyncSession, settleSyncSessionsForUser } from '../../services/sync-session';
import { flushCloudSync, hasPendingCloudChanges } from '../../services/cloud-sync';
import { clearCloudSyncMetadata } from '../../services/cloud-sync-guard';
import { saveBeforeSignOut, stopBeforeAccountDeletion } from '../../services/sync-account-actions';
import { captureSyncAuthTransition } from '../../services/sync-auth-lifecycle';
import { markAccountDeletionPending, clearStorageAfterAccountDeletion } from '../../services/sync-account-deletion';
import { useAppState } from '../../state/app-state';
import { useShallow } from 'zustand/react/shallow';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { RemotePaywallScreen } from '../paywall/remote-paywall-screen';
import { SecondaryButton } from '../../components/ui/SecondaryButton';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { AdaptiveScreen } from '../../components/ui/AdaptiveScreen';
import { setAnalyticsReplaySuppressed } from '../../services/analytics';
import Purchases from 'react-native-purchases';
import { checkSubscription, checkSubscriptionStrict, getCancelFlowStatus } from '../../services/revenuecat';
import { subscriptionDateLabel } from '../../services/subscription-label';
import { scheduleAllNotifications, sendTestQuoteNotification } from '../../services/notifications';
import { areNudgesSilenced } from '../../state/pause-mode';
import { getLocalDateKey } from '../../utils/recurrence';
import { todayWisdomForNotification, wisdomForNotificationDate } from '../wisdom/wisdom-quotes';
import { syncWidgetAfterMutation } from '../../widgets/widget-bridge';
import { addDaysToKey } from '../../state/lead-time-types';
import { sendWeeklyEmail, buildWeeklyEmailPayload } from '../../services/weekly-email';
import { trackEvent } from '../../services/analytics';
import { HelpScreen } from './help-screen';
import { MotionDebugPanel } from './motion-debug-panel';
import { createDurabilityBackup, getDurabilityBackupStatus, restoreDurabilityBackup } from '../../services/data-durability';
import { ambientGlow, ambientGlowSoft } from '../../theme/glow';
import { StatusBarScrim } from '../../components/ui/StatusBarScrim';
import { ListRow, TRAILING_MAX_SCALE } from '../../components/ui/ListRow';
import { formatAppVersion, formatUpdateId } from '../../utils/app-version';
import { Toggle } from '../../components/ui/Toggle';
import { Stepper } from '../../components/ui/Stepper';
import { pad2, spokenTime, to12Hour } from '../../components/ui/stepper-metrics';
import { ListSection } from '../../components/ui/ListSection';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { SMS_CONSENT_VERSION, SMS_CONSENT_BODY, SMS_CONSENT_DISCLOSURE } from './sms-consent';
import { PLAUD_IMPORT_AVAILABLE } from '../plaud-import/runtime-access';

// FIXME(nex-56): runtime gold-alpha compositions (GOLD + '60') used in Switch
// trackColors below. Base token migrates via the GOLD const; the alpha suffix
// stays as-is. Surface-pass should propose a gold-alpha-track token.

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
// v3 stellar: border #1E1E1E → tokens.color.goldHairline (now luminous white).
const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
// v3 stellar: aliases retoned to v3 cool palette.
const MUTED = tokens.color.textMuted;          // was #555
const RED   = tokens.color.stateError;         // was #FF5252
const GREEN = tokens.color.teal;               // v3: success = teal, not green

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// NEX-235: billing/refund support. Single source for the SLA + channels so the
// subscription-card row sublabel and the help sheet can never drift.
const BILLING_SUPPORT_EMAIL = 'admin@thecircleoflight.net';
const BILLING_RESPONSE_SLA = '1 business day';
const APPLE_REFUND_URL = 'https://reportaproblem.apple.com';

interface Props {
  onSignOut: () => void;
  onClose?: () => void;
  /**
   * Optional intent passed in when settings is opened from a deep link
   * (e.g. NEX-106 trial-extension notification tap). On mount the screen
   * auto-runs the matching flow exactly once.
   */
  initialAction?: 'open_extend_trial' | null;
}

// ─── Time Picker Row ──────────────────────────────────────────────────────────
/**
 * Reminder time row — hour and minute, each a kit Stepper, on a kit ListRow.
 *
 * The minute was previously UNREACHABLE: `bumpMinute` was defined and never
 * called, so `morningMinute`/`eveningMinute` stayed pinned at 0 even though
 * both are persisted and consumed by the scheduler. Reminders could only ever
 * fire on the hour.
 */
function TimeRow({
  label, hour, minute, onChangeTime,
}: {
  label: string;
  hour: number;
  minute: number;
  /**
   * ONE atomic callback for both fields. Two separate callbacks cannot work
   * here: `applyNotifSettings` merges its patch against the RENDER-CAPTURED
   * settings snapshot, so two calls in the same tick each merge against the
   * same stale state — changing 08:00 to 09:05 persists 09:05 but schedules
   * 09:00 and then 08:05, leaving the scheduler on a time the user never
   * chose (Greptile #399 P1, reproduced).
   */
  onChangeTime: (hour: number, minute: number) => void;
}) {
  // Display follows the presses immediately; PERSISTING is debounced. Every
  // committed change reschedules all notifications, and a successful schedule
  // advances the notification-quote `shown` map (notifications.ts) — so a
  // 6-press trip to :30 would otherwise burn six curated lines and run six
  // full cancel/reschedule cycles. Local state keeps the control instant.
  const [draft, setDraft] = useState<{ hour: number; minute: number } | null>(null);
  const shown = draft ?? { hour, minute };
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ hour: number; minute: number } | null>(null);

  // Held in a ref, and deliberately NOT a useCallback dependency of the unmount
  // effect: the parent passes fresh inline callbacks every render, so an effect
  // keyed on them would tear down and re-run its cleanup on EVERY render —
  // flushing the same pending edit again and again, rescheduling notifications
  // and burning quote lines each time (Greptile #399 P1, reproduced).
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = pendingRef.current;
    pendingRef.current = null; // cleared FIRST, so a second flush is a no-op
    if (!next) return;
    onChangeTime(next.hour, next.minute);
    setDraft(null);
  };

  // Mirrors `shown` so `schedule` can read it without becoming render-keyed.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Takes a PATCH, not a whole time, and bases it on the PENDING value when
  // there is one.
  //
  // The row has two Steppers and they can both fire inside one React commit —
  // press hour, then minute, before a rerender. Callbacks that spread the
  // render-captured `shown` therefore built their update from a stale base, and
  // the second press silently discarded the first: 08:00 -> 09:00 -> 08:05,
  // losing the hour (Greptile #422 P1, reproduced). `pendingRef` already holds
  // the freshest intent between presses, so basing the patch on it makes the
  // two controls compose instead of race.
  //
  // Same family as the stale-state bug the header note above describes on the
  // SCHEDULER side; that one was fixed and this one, on the state side, was not.
  const schedule = useCallback((patch: Partial<{ hour: number; minute: number }>) => {
    const next = { ...(pendingRef.current ?? shownRef.current), ...patch };
    setDraft(next);
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flushRef.current(), TIME_COMMIT_DELAY_MS);
  }, []);

  // Empty deps: this runs its cleanup ONCE, on real unmount, so closing
  // settings mid-press still saves the edit.
  useEffect(() => () => flushRef.current(), []);

  const { meridiem } = to12Hour(shown.hour);

  return (
    <ListRow
      title={label}
      trailing="custom"
      interactiveAccessory
      // Two Steppers + separator + meridiem is ~168pt, past the 45% trailing
      // cap on a 393pt screen and worse at large text, where the controls
      // collided with the label. See trailingMaxWidth.
      trailingWide
      trailingAccessory={
        <View style={trStyles.controls}>
          <Stepper
            value={shown.hour}
            wrap={24}
            onChange={(h) => schedule({ hour: h })}
            format={(h) => String(to12Hour(h).hour12)}
            accessibilityLabel={`${label} hour`}
            accessibilityValueText={spokenTime(shown.hour, shown.minute)}
          />
          <Text style={trStyles.separator}>:</Text>
          <Stepper
            value={shown.minute}
            wrap={60}
            step={TIME_MINUTE_STEP}
            onChange={(m) => schedule({ minute: m })}
            format={pad2}
            accessibilityLabel={`${label} minute`}
            accessibilityValueText={spokenTime(shown.hour, shown.minute)}
          />
          <Text style={trStyles.meridiem}>{meridiem}</Text>
        </View>
      }
    />
  );
}

// 5-minute granularity — the step the dead `bumpMinute` already intended, and
// enough to keep a trip across the hour to 11 presses rather than 59.
const TIME_MINUTE_STEP = 5;
const TIME_COMMIT_DELAY_MS = 600;

const trStyles = StyleSheet.create({
  controls:  { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.xxs },
  separator: { ...tokens.type.numericSm, color: tokens.color.textMuted },
  meridiem:  { ...tokens.type.numericSm, color: tokens.color.textMuted, marginLeft: tokens.spacing.xxs },
});

// 2-letter ISO code -> flag emoji (regional-indicator pair) for the phone picker.
const countryFlag = (cc: string) =>
  cc.replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));

// NEX-321: the SMS_CONSENT_* legal constants moved to ./sms-consent so the
// in-app ask sheet (sms-opt-in-sheet.tsx) and this screen share one source.

// ─── Main Settings Screen ─────────────────────────────────────────────────────
export function SettingsScreen({ onSignOut, onClose, initialAction }: Props) {
  const [loading, setLoading] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Embedded bundle / dev: no OTA id, so the row is omitted rather than blank.
  const updateIdLabel = formatUpdateId(Updates.updateId);
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [phoneCountry, setPhoneCountry] = useState('US');
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneError, setPhoneError] = useState('');

  // NEX-86: SMS opt-in. State is server-authoritative — the client never
  // writes sms_opt_in directly; all transitions go through the sms-opt-in
  // edge function and the YES confirmation arrives via Twilio webhook.
  // NEX-319 adds 'expired' (a pending opt-in whose confirmation text never
  // arrived). It intentionally renders like 'stopped' — switch off, default
  // sub-label — so the user can simply turn it back on.
  const [smsStatus, setSmsStatus] =
    useState<'none' | 'pending' | 'confirmed' | 'stopped' | 'expired'>('none');
  const [smsBusy, setSmsBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.functions.invoke('sms-opt-in', {
          body: { action: 'status' },
        });
        if (!cancelled && data?.optIn?.opt_in_status) setSmsStatus(data.optIn.opt_in_status);
      } catch {
        // Leave as 'none'; the toggle still works on demand.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleSms = async (enable: boolean) => {
    if (smsBusy) return;
    const phone = useAppState.getState().userProfile?.phoneNumber;
    if (enable && !phone) {
      Alert.alert('Phone number needed', 'Add your phone number first, then turn on SMS updates.');
      openPhoneModal();
      return;
    }
    setSmsBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('sms-opt-in', {
        // NEX-181: report the exact disclosure the user saw so the server can record
        // the consent audit trail (version is server-validated; text stored verbatim).
        body: enable
          ? { action: 'enable', consentVersion: SMS_CONSENT_VERSION, consentText: SMS_CONSENT_DISCLOSURE }
          : { action: 'disable' },
      });
      if (error) throw error;
      const status = data?.optIn?.opt_in_status;
      if (status) setSmsStatus(status);
      if (enable && status === 'pending') {
        Alert.alert('Check your texts', 'We sent a confirmation. Reply YES to finish signing up.');
      }
    } catch (e: any) {
      // NEX-321: a 409 phone_in_use means another account holds the live
      // subscription on this number. The generic e.message ("Edge Function
      // returned a non-2xx status code") would leave the user stuck, so read
      // the response body for the specific case and say how to resolve it.
      let message = e?.message || 'Could not update SMS settings. Try again.';
      try {
        const body = await e?.context?.json();
        if (body?.error === 'phone_in_use') {
          message =
            'This number is subscribed from another account. If the number is yours, text STOP from that phone first, then try again.';
        }
      } catch { /* keep the generic message */ }
      Alert.alert('SMS Updates', message);
    } finally {
      setSmsBusy(false);
    }
  };

  // NEX-85 follow-up: re-derive country + national-format input from the
  // stored E.164 every time the user opens the modal. useState initialisers
  // only fire at mount, so if cloud hydration lands AFTER SettingsScreen
  // mounts (returning user on a fresh install), the modal would otherwise
  // open with the pre-hydration empty values. Recomputing on open keeps
  // the modal in sync with whatever userProfile.phoneNumber currently is.
  const openPhoneModal = () => {
    const stored = useAppState.getState().userProfile?.phoneNumber;
    if (!stored) {
      setPhoneCountry('US');
      setPhoneInput('');
    } else {
      const parsed = parsePhoneNumberFromString(stored);
      setPhoneCountry((parsed?.country as string) ?? 'US');
      setPhoneInput(parsed?.nationalNumber || stored);
    }
    setPhoneError('');
    setShowPhoneModal(true);
  };
  // NEX-85 follow-up: getCountries() returns the same ~250-element list
  // every call; memo so we don't reallocate on each modal re-render.
  // NEX-85 follow-up: surface common countries first so the picker opens on
  // US (+1) by default, not Ascension Island (+247) at the top of the A-Z list.
  const countryCodes = useMemo(() => {
    const COMMON = ['US', 'CA', 'GB', 'AU', 'IE', 'NZ', 'IN'];
    const all = getCountries();
    const common = COMMON.filter((c) => all.includes(c));
    return [...common, ...all.filter((c) => !common.includes(c))];
  }, []);
  // NEX-231: type derived from checkSubscription so the shape can't drift.
  const [subStatus, setSubStatus] = useState<Awaited<ReturnType<typeof checkSubscription>>>({
    isSubscribed: false, plan: null, expiresAt: null,
    willRenew: false, unsubscribeDetectedAt: null, billingIssueDetectedAt: null, isTrial: false,
  });
  // NEX-231: set when we send the user to Apple's subscription page; the next
  // foreground refreshes subStatus so a just-cancelled sub stops showing "Renews".
  const pendingSubRefreshRef = useRef(false);
  // Guards re-entrancy so two foreground events don't run the refresh twice.
  const subRefreshInFlightRef = useRef(false);
  const [showTrialExtensionOffer, setShowTrialExtensionOffer] = useState(false);
  const [cancelFlowBusy, setCancelFlowBusy] = useState(false);
  const [cancelManagementUrl, setCancelManagementUrl] = useState('https://apps.apple.com/account/subscriptions');
  const [backupStatus, setBackupStatus] = useState({
    isBackedUp: false,
    createdAt: null,
    reason: null,
    persistVersion: null,
    bytes: 0,
    hasPreMigrationBackup: false,
    preMigrationVersion: null,
  });
  const [backupBusy, setBackupBusy] = useState(false);

  const refreshBackupStatus = React.useCallback(() => {
    getDurabilityBackupStatus().then(setBackupStatus).catch(() => {});
  }, []);

  React.useEffect(() => {
    refreshBackupStatus();
  }, [refreshBackupStatus]);

  React.useEffect(() => {
    checkSubscription().then(setSubStatus).catch(() => {});
  }, []);

  // NEX-231: refresh subscription status when returning to the foreground after
  // being sent to Apple's subscription page, so a just-cancelled sub immediately
  // reads "Access until <date>" instead of a stale "Renews". Invalidate the RC
  // cache first (the change happened externally) so getCustomerInfo refetches.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active' || !pendingSubRefreshRef.current || subRefreshInFlightRef.current) return;
      subRefreshInFlightRef.current = true;
      try {
        // Strict read: if invalidate OR the refetch throws (transient/offline),
        // DON'T clear the pending flag and DON'T downgrade subStatus — a transient
        // failure must not masquerade as "free" (a cancel keeps the entitlement
        // active until expiry, so this refresh should never flip subscribed→free).
        // The flag clears only after a clean invalidate + successful read.
        await Purchases.invalidateCustomerInfoCache();
        const fresh = await checkSubscriptionStrict();
        setSubStatus(fresh);
        pendingSubRefreshRef.current = false;
      } catch {
        /* keep pendingSubRefreshRef set → retry on the next foreground */
      } finally {
        subRefreshInFlightRef.current = false;
      }
    });
    return () => sub.remove();
  }, []);

  // NEX-106: when opened via the trial-extension notification deep link,
  // auto-run the same flow as tapping "Manage Subscription". Fires once.
  const handledInitialAction = React.useRef(false);
  React.useEffect(() => {
    if (handledInitialAction.current) return;
    if (initialAction === 'open_extend_trial') {
      handledInitialAction.current = true;
      // Defer a tick so the screen renders before the modal animates in.
      const t = setTimeout(() => { void openManageSubscription(); }, 250);
      return () => clearTimeout(t);
    }
    // openManageSubscription intentionally omitted — this effect is
    // one-shot guarded by handledInitialAction.current, so capturing
    // the first-render closure is the desired behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction]);

  const router = useRouter();
  // NEX-277: AI lines auto-schedule (live ∪ pending are both schedulable), so the
  // settings link counts both — it's a review/remove surface, not an approval queue.
  const aiQuoteCount = useAppState(
    (s: any) => (s.quotesPool?.live?.length ?? 0) + (s.quotesPool?.pending?.length ?? 0),
  );
  const {
    userProfile,
    notificationSettings,
    setNotificationSettings,
    softMode,
    setSoftMode,
    pauseMode,
    startPauseMode,
    resumePauseMode,
    wisdomQuoteCount,
    setWisdomQuoteCount,
    weeklyEmailEnabled,
    weeklyEmailConsent,
    weeklyEmailDay,
    setWeeklyEmail,
    analyticsConsent,
    setAnalyticsConsent,
  } = useAppState(
    useShallow((s: any) => ({
      userProfile: s.userProfile,
      notificationSettings: s.notificationSettings,
      setNotificationSettings: s.setNotificationSettings,
      softMode: s.softMode,
      setSoftMode: s.setSoftMode,
      pauseMode: s.pauseMode,
      startPauseMode: s.startPauseMode,
      resumePauseMode: s.resumePauseMode,
      wisdomQuoteCount: s.wisdomQuoteCount,
      setWisdomQuoteCount: s.setWisdomQuoteCount,
      weeklyEmailEnabled: s.weeklyEmailEnabled,
      weeklyEmailConsent: s.weeklyEmailConsent,
      weeklyEmailDay: s.weeklyEmailDay,
      setWeeklyEmail: s.setWeeklyEmail,
      analyticsConsent: s.analyticsConsent,
      setAnalyticsConsent: s.setAnalyticsConsent,
    })),
  );

  const ns = notificationSettings || {
    morningHour: 8, morningMinute: 0,
    eveningHour: 20, eveningMinute: 0,
    weeklyDay: 0, weeklyHour: 10,
    milestoneAlerts: true,
    smartTiming: true,
  };

  const applyNotifSettings = (patch: Record<string, any>) => {
    setNotificationSettings(patch);
    // Re-schedule from the LIVE store, never from the render-captured `ns`.
    //
    // `ns` is a snapshot taken when this render ran. Any two commits landing in
    // the same render window therefore each merged the OTHER's field out of
    // their payload: scheduling is serialized, so the later call won and reset
    // the earlier reminder to its old time — persisted state and scheduled
    // state silently diverged. That bit twice (hour+minute in one commit, then
    // Morning+Evening in one window) before the root cause was addressed here
    // rather than at each call site (Greptile #399, reproduced both times).
    //
    // The store write above is a synchronous zustand `set`, so reading it back
    // here always reflects `patch` plus anything else already committed.
    const merged = useAppState.getState().notificationSettings ?? { ...ns, ...patch };
    const todayKey = getLocalDateKey(new Date());
    scheduleAllNotifications({
      morningHour: merged.morningHour,
      morningMinute: merged.morningMinute,
      eveningHour: merged.eveningHour,
      eveningMinute: merged.eveningMinute,
      weeklyDay: merged.weeklyDay,
      weeklyHour: merged.weeklyHour,
      milestoneAlerts: merged.milestoneAlerts,
      // NEX-207: don't re-arm nudges while paused (a settings edit mid-pause must
      // not break the silence). areNudgesSilenced reads the live pause state.
      silenced: areNudgesSilenced(useAppState.getState()),
      // NEX-212: carry BOTH the toggle and the histogram, or turning Smart timing
      // off from Settings would be ignored here while the launch path honors it
      // (split-brain). Toggling off snaps the daily hours back to exact.
      smartTiming: merged.smartTiming !== false,
      openHourCounts: useAppState.getState().appLaunchHourCounts,
      includeQuotes: merged.includeQuotes === true, // notification quotes (opt-in)
      personalized: merged.personalizedQuotes !== false, // NEX-277 kill switch
      quotesPool: useAppState.getState().quotesPool,          // AI lines + seed + no-repeat
      todayWisdom: todayWisdomForNotification(useAppState.getState(), todayKey), // today's-win source
      yesterdayWisdom: wisdomForNotificationDate(useAppState.getState(), addDaysToKey(todayKey, -1), todayKey), // morning slot
      onQuotesSelected: useAppState.getState().recordQuotesShown, // advance shown atomically
    }).catch(() => {});
  };

  // Hidden test trigger (long-press the "Quotes in Notifications" row): fires a
  // one-shot 10s out with EXACTLY the morning composition today's real schedule
  // would use — the only on-demand way to verify the pipeline on a TestFlight
  // build, where the daily 8am/8pm nudges give no immediate feedback. The
  // notification handler shows a foreground banner for non-reminder
  // notifications, so it arrives even with the app open.
  const handleTestQuoteNotification = async () => {
    haptic('buttonSecondary');
    const st = useAppState.getState() as any;
    const s = st.notificationSettings || {};
    const todayKey = getLocalDateKey(new Date());
    const result = await sendTestQuoteNotification({
      // Pass the stored schedule + smart-timing inputs so the test picks the
      // same wisdom (yesterday vs today) the production scheduler would
      // (Greptile PR #361); omitting them silently used the 08:00/20:00 defaults.
      morningHour: s.morningHour ?? 8,
      morningMinute: s.morningMinute ?? 0,
      eveningHour: s.eveningHour ?? 20,
      eveningMinute: s.eveningMinute ?? 0,
      smartTiming: s.smartTiming !== false,
      openHourCounts: st.appLaunchHourCounts,
      includeQuotes: s.includeQuotes === true,
      personalized: s.personalizedQuotes !== false,
      quotesPool: st.quotesPool,
      todayWisdom: todayWisdomForNotification(st, todayKey),
      yesterdayWisdom: wisdomForNotificationDate(st, addDaysToKey(todayKey, -1), todayKey),
    }).catch(() => ({ ok: false }));
    if (result.ok) {
      Alert.alert('Test notification scheduled', 'It arrives in about 10 seconds, even with the app open.');
    } else {
      Alert.alert('Notifications are off', 'Enable notifications for Nexus in your device Settings, then try again.');
    }
  };

  const savePhoneNumber = async () => {
    const parsed = parsePhoneNumberFromString(phoneInput.trim(), phoneCountry as any);
    if (!parsed?.isValid()) {
      setPhoneError('That number looks invalid.');
      return;
    }
    const e164 = parsed.number;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) return;
      await supabase.from('user_profile').upsert({ user_id: user.id, phone_number: e164 }, { onConflict: 'user_id' });
      // NEX-85 follow-up: use the focused setPhoneNumber setter rather
      // than activateUser. activateUser replaces userProfile wholesale,
      // so the previous `...(userProfile || {})` spread risked rebuilding
      // an empty profile if a settings edit ever fired before activation
      // completed (and silently stamps activatedDate as a side effect on
      // first call). setPhoneNumber only touches phoneNumber, which is
      // the actual intent here.
      const state = (useAppState as any).getState();
      if (typeof state.setPhoneNumber === 'function') {
        state.setPhoneNumber(e164);
      }
      setShowPhoneModal(false);
      setPhoneError('');
      haptic('buttonSecondary');
    } catch {
      setPhoneError('Could not save right now.');
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'We’ll save your latest changes before signing you out. You can sign back in anytime.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out', style: 'destructive',
        onPress: async () => {
          setLoading(true);
          try {
            // NEX-328: the SDK's own signOut can't be trusted — it resolves
            // { error } instead of throwing, early-returns before
            // _removeSession on a retryable refresh failure, and any
            // raced-and-abandoned SDK call completes late and deletes
            // whatever session is current (four Greptile rounds on #386).
            // hardSignOut never touches the SDK: bounded server revoke via a
            // plain fetch, then direct removal of the persisted session keys
            // (auth-js 2.102 keeps no in-memory session — storage IS the
            // session); notifyForceSignOut drives the signed-out UI
            // transition app-side.
            const syncSession = getSyncSession();
            const localOwner = useAppState.getState().localUserId;
            if (!syncSession && localOwner && localOwner !== 'sim-dev-user') {
              Alert.alert('Changes not saved', 'Saving is paused, so your latest changes cannot be confirmed saved. Your local data has been kept.');
              return;
            }
            if (syncSession) {
              const saved = await saveBeforeSignOut(syncSession, flushCloudSync, hasPendingCloudChanges);
              if (!saved || !syncSession.isCurrent() || hasPendingCloudChanges(syncSession)) {
                Alert.alert('Changes not saved', 'Your latest changes could not be saved. Reconnect and try signing out again.');
                return;
              }
            }
            const { persistedSessionCleared } = await hardSignOut();
            if (!persistedSessionCleared) {
              Alert.alert('Error', 'Could not sign out. Try again.');
              return;
            }
            // Zustand state must be cleared too — otherwise isActivated stays
            // true, the routing gate keeps rendering Home, and the modal
            // closing just lands the user back where they were. The
            // nexus_legacy_free_user AsyncStorage flag is keyed per-userId
            // (NEX-204) outside Zustand, so it survives this reset for the SAME
            // account (grandfathered users keep their bypass when they sign back
            // in) without leaking to a different account on the same device.
            const store = (useAppState as any).getState();
            if (typeof store.resetState === 'function') store.resetState();
            notifyForceSignOut();
            haptic('voiceSuccess');
            onSignOut();
          } finally {
            setLoading(false);
          }
        },
      },
    ]);
  };

  // NEX-155: real, server-side account deletion. The delete-account edge
  // function (derives the user from the JWT) removes every user-scoped row,
  // the auth identity, and best-effort vendor data. We then wipe the local
  // persisted blob so a relaunch starts clean at onboarding, not on a
  // half-deleted session.
  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete your account',
      'This removes everything. Your profile, your phone number, your habits, mandates, reviews, and usage data. Gone from this device and from the cloud. It cannot be undone.',
      [
        { text: 'Keep my account', style: 'cancel' },
        {
          text: 'Delete everything', style: 'destructive',
          onPress: async () => {
            try {
              setLoading(true);
              const deletingUserId = getSyncSession()?.userId ?? useAppState.getState().localUserId;
              const authTransition = captureSyncAuthTransition();
              stopSyncSession();
              if (!deletingUserId) return;
              // Explicit durable barrier: Zustand persistence is fire-and-forget
              // and alone cannot prove the pause survives a crash during deletion.
              await markAccountDeletionPending(deletingUserId);
              if (!authTransition.isCurrent()) return;
              // Stop before the first await. Include older stopped generations
              // on retries, so a timed-out writer can never recreate a deleted row.
              const settled = deletingUserId && await stopBeforeAccountDeletion(
                deletingUserId, () => stopSyncSession(), settleSyncSessionsForUser,
              );
              if (!settled || !authTransition.isCurrent()) {
                Alert.alert('Please try again', 'Could not safely finish the current save. Wait a moment and try deleting your account again.');
                return;
              }
              const { data: { session: authSession } } = await supabase.auth.getSession();
              if (!authTransition.isCurrent() || authSession?.user.id !== deletingUserId) return;
              // Bind deletion to the account that requested it even if another
              // authentication event arrives during the network request.
              const { data, error } = await supabase.functions.invoke('delete-account', {
                headers: { Authorization: `Bearer ${authSession.access_token}` },
              });
              if (!authTransition.isCurrent()) return;
              if (error) {
                Alert.alert('Error', 'Could not delete your account. Contact admin@thecircleoflight.net.');
                return;
              }
              // Only treat deletion as successful if every CORE step is 'ok' —
              // the nine user tables plus the auth identity. Vendor steps
              // (posthog/revenuecat/braintrust) stay non-fatal. Fail closed: a
              // missing/undefined step counts as a failure. Note the PII tables
              // (nexus_profiles=email, user_profile=phone, sms_opt_in/sms_send_log/
              // sms_send_attempt_log=phone+consent, user_state, nexus_email_log)
              // are deleted explicitly and do NOT cascade from auth.users, so a
              // successful auth delete alone does not prove the email/phone are
              // gone — hence we require all nine tables too. On
              // failure we leave the user logged in with sync STOPPED; the
              // deletes are idempotent so a retry re-runs cleanly. A token
              // refresh must not upload local data into partially deleted rows.
              const steps = (data as any)?.steps;
              const CORE_STEPS = [
                'nexus_profiles', 'user_profile',
                'sms_opt_in', 'sms_send_log', 'sms_send_attempt_log',
                'user_state', 'nexus_email_log', 'nexus_events', 'nexus_activation_daily',
                'auth_user',
              ];
              const stepsOk = steps && typeof steps === 'object';
              const failedSteps = stepsOk
                ? CORE_STEPS.filter((k) => steps[k] !== 'ok')
                : CORE_STEPS;
              console.log('[delete-account] steps', steps);
              if (failedSteps.length > 0) {
                console.warn('[delete-account] core steps failed', failedSteps);
                Alert.alert('Error', "Some of your data couldn't be removed. Contact admin@thecircleoflight.net.");
                return; // do NOT wipe local / sign out on a partial failure
              }
              // Wipe local: store reset + nuke the persisted blob.
              const store = (useAppState as any).getState();
              if (typeof store.resetState === 'function') store.resetState();
              await clearCloudSyncMetadata();
              if (!authTransition.isCurrent()) return;
              const storageCleared = await clearStorageAfterAccountDeletion(deletingUserId, authTransition.isCurrent);
              if (!storageCleared) return;
              // NEX-328: no SDK signOut call here at all. Storage is already
              // wiped (scoped cleanup above) and auth-js 2.102 keeps no
              // in-memory session, so the session is gone; the app's only
              // SIGNED_OUT subscriber is _layout, covered by the app-owned
              // transition below. An SDK call would only queue on the auth
              // lock and — if it executed after a re-sign-in — delete the
              // NEW session (Greptile round 7).
              notifyForceSignOut();
              haptic('voiceAmbiguous');
              onSignOut();
            } catch {
              Alert.alert('Error', 'Could not delete your account. Contact admin@thecircleoflight.net.');
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  // NEX-155: GDPR/CCPA data export. The export-account edge function returns
  // every row Nexus holds for the user; we write it to a cache file and open
  // the share sheet. Uses RN's built-in Share + expo-file-system (no new
  // native module), so it stays OTA-deliverable on the bare project.
  const [exporting, setExporting] = useState(false);
  const handleExportData = async () => {
    if (exporting) return;
    let exportFile: File | undefined;
    try {
      setExporting(true);
      haptic('buttonSecondary');
      const { data, error } = await supabase.functions.invoke('export-account');
      if (error || !data) {
        Alert.alert('Error', 'Could not prepare your export. Contact admin@thecircleoflight.net.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const payload = JSON.stringify(data, null, 2);
      if (Platform.OS === 'ios') {
        // iOS supports sharing a file URL — write to cache and share the file.
        const file = new File(Paths.cache, `nexus-export-${stamp}.json`);
        exportFile = file;
        if (file.exists) file.delete();
        file.create();
        file.write(payload);
        await Share.share({ url: file.uri, title: 'Nexus data export' });
      } else {
        // Android: RN's Share `url` is iOS-only and would present an empty
        // sheet. Without expo-sharing (avoids a native rebuild), share the JSON
        // as text when it is small enough for the OS Binder transaction limit
        // (~1MB), otherwise tell the user the file export is iOS-only.
        const SHARE_BYTE_LIMIT = 100 * 1024; // 100 KiB, conservative vs Binder
        const bytes = typeof TextEncoder !== 'undefined'
          ? new TextEncoder().encode(payload).length
          : payload.length;
        if (bytes <= SHARE_BYTE_LIMIT) {
          await Share.share({ message: payload, title: 'Nexus data export' });
        } else {
          Alert.alert('Export', 'Export is available on iOS.');
        }
      }
    } catch {
      Alert.alert('Error', 'Could not prepare your export. Contact admin@thecircleoflight.net.');
    } finally {
      // Remove the cache copy once the share sheet has resolved (iOS only —
      // Android shares text, no file). Runs on the early-return paths too.
      if (exportFile?.exists) {
        try { exportFile.delete(); } catch {}
      }
      setExporting(false);
    }
  };

  // NEX-218: extracted from the inline Weekly-Email onPress for readability.
  // Stays inside the weeklyEmailEnabled card (digest-off still suppresses every
  // weekly-summary send) and requires a real signed-in/profile recipient — no
  // hardcoded fallback (Greptile #157: the summary carries private habit data).
  const handleSendTestEmail = async () => {
    haptic('dragDrop');
    try {
      const state = useAppState.getState() as any;
      // Get email from Supabase session. NEX-218: require a REAL recipient —
      // no hardcoded fallback. The summary payload carries private habit data,
      // so without a signed-in/profile email we must not send (it would have
      // mailed another user's data to a baked-in address).
      const { data: { session: emailSession } } = await supabase.auth.getSession();
      const userEmail = emailSession?.user?.email || state.userProfile?.email;
      if (!userEmail) {
        Alert.alert('No email on file', 'Add an email to your account before sending a test summary.');
        return;
      }
      const payload = buildWeeklyEmailPayload({
        userEmail,
        userName: state.userProfile?.name || 'there',
        habitLog: state.habitLog || [],
        recurringRules: state.recurringRules || [],
        habitStreaks: state.habitStreaks || {},
        dailyScores: state.dailyScores || {},
        pauseMode: state.pauseMode, // NEX-207: exclude paused days from the preview tally
      });
      await sendWeeklyEmail(payload);
      Alert.alert('Test summary sent', 'Check your inbox for the weekly summary preview.');
    } catch (e: any) {
      Alert.alert('Send Failed', e.message || 'Could not send test email. Check Supabase edge function.');
    }
  };

  const backupStateLabel = backupStatus.isBackedUp && backupStatus.createdAt
    ? `Backed up ${new Date(backupStatus.createdAt).toLocaleString()}`
    : 'No backup yet';

  const handleManualBackup = async () => {
    if (backupBusy) return;
    try {
      setBackupBusy(true);
      const backup = await createDurabilityBackup('manual');
      refreshBackupStatus();
      haptic('voiceSuccess');
      Alert.alert(
        backup ? 'Backup updated' : 'Nothing to back up yet',
        backup ? 'Your habit history, streaks, reviews, and settings are saved on this device.' : 'Open Nexus after setup and we will create a backup automatically.',
      );
    } catch {
      Alert.alert('Backup failed', 'Could not write the local backup. Please try again.');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackup = (source: 'latest' | 'premigration') => {
    if (backupBusy) return;
    const isPre = source === 'premigration';
    if (isPre ? !backupStatus.hasPreMigrationBackup : !backupStatus.isBackedUp) return;
    Alert.alert(
      isPre ? 'Roll back to before your last update?' : 'Restore Nexus backup?',
      isPre
        ? 'This brings back the snapshot taken before the most recent app update, then restarts Nexus. Anything saved since the update is replaced.'
        : 'This replaces the current on-device state with your latest backup, then restarts Nexus.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          style: 'destructive',
          onPress: async () => {
            try {
              setBackupBusy(true);
              try {
                await restoreDurabilityBackup(source);
              } catch {
                Alert.alert('Restore failed', 'Could not restore the backup on this device.');
                return;
              }
              haptic('voiceSuccess');
              if (Platform.OS === 'web' && typeof window !== 'undefined') {
                window.location.reload();
                return;
              }
              try {
                await Updates.reloadAsync();
              } catch {
                Alert.alert('Restart required', 'Your data has been restored. Please close and reopen Nexus to apply the backup.');
              }
            } finally {
              setBackupBusy(false);
            }
          },
        },
      ],
    );
  };

  const openManageSubscription = async () => {
    if (cancelFlowBusy) return;
    // NEX-231: anything reached from here (the direct Apple deep-link, or the
    // trial offer's "Continue to cancel") sends the user to Apple's subscription
    // page; mark a pending refresh so the next foreground re-reads the status.
    pendingSubRefreshRef.current = true;
    try {
      setCancelFlowBusy(true);
      const status = await getCancelFlowStatus();
      if (status.managementURL) setCancelManagementUrl(status.managementURL);
      if (status.isTrialUser) {
        setShowTrialExtensionOffer(true);
        void trackEvent('trial_extension_offer_shown', { surface: 'settings_cancel_flow' });
        return;
      }
      await Linking.openURL(status.managementURL || 'https://apps.apple.com/account/subscriptions');
    } catch {
      await Linking.openURL('https://apps.apple.com/account/subscriptions');
    } finally {
      setCancelFlowBusy(false);
    }
  };

  // NEX-235: billing/refund support. App Store payments + refunds are Apple's to
  // process, but slow/no support is the competitor failure this counters, so we
  // state a response SLA and offer both a direct email and Apple's refund form.
  const openBillingHelp = () => {
    Alert.alert(
      'Help with billing',
      `We reply to billing emails within ${BILLING_RESPONSE_SLA}. App Store subscriptions and refunds are processed by Apple. To request a refund, open Apple's refund form, or email us and we will guide you through it.`,
      [
        {
          text: 'Email us',
          onPress: () => { Linking.openURL(`mailto:${BILLING_SUPPORT_EMAIL}?subject=Billing%20help%20(Nexus)`).catch(() => {}); },
        },
        { text: 'Request a refund', onPress: () => { Linking.openURL(APPLE_REFUND_URL).catch(() => {}); } },
        { text: 'Close', style: 'cancel' },
      ],
    );
  };

  if (showHelp) {
    return <HelpScreen onBack={() => setShowHelp(false)} />;
  }

  return (
    <View style={{ flex: 1 }}>
    <AdaptiveScreen>
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <Text style={styles.title}>SETTINGS</Text>

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ACCOUNT</Text>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Signed in as</Text>
          <Text style={styles.cardValue}>{userProfile?.name || 'User'}</Text>
        </View>

        <ListSection style={{ marginTop: 10 }}>
          <ListRow
            title="Phone Number"
            trailing="value"
            value={userProfile?.phoneNumber || 'Add'}
            onPress={openPhoneModal}
          />
          {/* Teal "Active/plan" signal preserved via a custom static accessory;
              ListRow's built-in value kind only renders muted/gold. */}
          <ListRow
            title="Subscription"
            trailing="custom"
            // A static custom accessory is NOT auto-announced (only the 'value'
            // kinds feed the derived label), and this row reads as one element
            // — so the plan status has to be named or it is silent.
            accessoryLabel={subStatus.isSubscribed ? subStatus.plan || 'Active' : 'Free'}
            trailingAccessory={
              <Text style={{ ...tokens.type.bodyMd, color: subStatus.isSubscribed ? GREEN : MUTED }} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>
                {subStatus.isSubscribed ? `${subStatus.plan || 'Active'}` : 'Free'}
              </Text>
            }
          />
          {subStatus.expiresAt && (
            // NEX-231: honest label — "Access until" after a cancel, "Renewal
            // pending" during a billing retry, "Free until" on trial, else
            // "Renews". Never claims a renewal once the user has cancelled.
            <ListRow
              title={subscriptionDateLabel(subStatus)}
              trailing="value"
              value={new Date(subStatus.expiresAt).toLocaleDateString()}
            />
          )}
          {/* NEX-231: plain-label the cancel path. Subscribers see that cancel
              lives here; free users get neutral copy (nothing to cancel). */}
          <ListRow
            title="Manage Subscription"
            trailing="external"
            subtitle={subStatus.isSubscribed ? 'Cancel or change your plan' : 'View App Store subscriptions'}
            busy={cancelFlowBusy}
            disabled={cancelFlowBusy}
            onPress={openManageSubscription}
          />
          {/* NEX-235: billing/refund support, deliberately INSIDE the subscription
              card (near subscription settings) with a documented response SLA. */}
          <ListRow
            title="Help with billing"
            trailing="none"
            subtitle={`Billing or refund question? We reply within ${BILLING_RESPONSE_SLA}.`}
            onPress={openBillingHelp}
          />
        </ListSection>

        {/* Connect AI (nexus-mcp): one-time codes link ChatGPT/Claude to this
            account; the screen also lists + revokes live connections. */}
        <ListSection style={{ marginTop: 10 }}>
          <ListRow
            title="Connect AI"
            subtitle="Link ChatGPT or Claude as your coach. They can read your journal, habits, and mandates"
            onPress={() => router.push('/settings/connect-ai')}
          />
          {/* PLAUD sits here rather than under Integrations because it is the
              same idea as the row above: an outside brain reading your Nexus.
              Calendars and Apple Reminders only move data; this turns a
              recording into proposals you review. */}
          {PLAUD_IMPORT_AVAILABLE && (
            <ListRow
              title="PLAUD Import"
              subtitle="Turn a PLAUD recording into tasks you approve. Nothing is added without your review"
              onPress={() => {
                onClose?.();
                setTimeout(() => router.push('/settings/plaud-import'), 350);
              }}
            />
          )}
        </ListSection>
      </View>

      {/* ── Notifications ─────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
        <ListSection>
          <TimeRow
            label="Morning Reminder"
            hour={ns.morningHour}
            minute={ns.morningMinute}
            // ONE patch, so the scheduler sees both fields together.
            onChangeTime={(h, m) => applyNotifSettings({ morningHour: h, morningMinute: m })}
          />
          <TimeRow
            label="Evening Check-in"
            hour={ns.eveningHour}
            minute={ns.eveningMinute}
            onChangeTime={(h, m) => applyNotifSettings({ eveningHour: h, eveningMinute: m })}
          />

          {/* Weekly summary day — the gold trailing text IS the action
              (day-cycler), so it keeps its own haptic + gold (§19). */}
          <ListRow
            title="Weekly Summary"
            trailing="custom"
            interactiveAccessory
            trailingAccessory={
              <Pressable
                onPress={() => {
                  haptic('tabChange');
                  applyNotifSettings({ weeklyDay: (ns.weeklyDay + 1) % 7 });
                }}
                accessibilityRole="button"
                accessibilityLabel={`Weekly summary on ${DAYS[ns.weeklyDay]}`}
                accessibilityHint="Cycles to the next day"
              >
                <Text style={styles.goldAction} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>{DAYS[ns.weeklyDay]} ↻</Text>
              </Pressable>
            }
          />

          {/* Milestone alerts toggle */}
          <ListRow
            title="Milestone Alerts"
            trailing="toggle"
            trailingAccessory={
              <Toggle
                value={ns.milestoneAlerts}
                onValueChange={(v) => { applyNotifSettings({ milestoneAlerts: v }); }}
                accessibilityLabel="Milestone Alerts"
              />
            }
          />

          {/* NEX-212: Smart timing toggle (default on) */}
          <ListRow
            title="Smart Timing"
            subtitle="Lets reminders settle into the rhythm of your day. Off keeps exact times."
            trailing="toggle"
            trailingAccessory={
              <Toggle
                value={ns.smartTiming !== false}
                onValueChange={(v) => { applyNotifSettings({ smartTiming: v }); }}
                accessibilityLabel="Smart Timing"
              />
            }
          />

          {/* Notification quotes toggle (opt-in, default off). Long-press =
              hidden test send (see handleTestQuoteNotification) — no visible
              affordance; works on TestFlight where there is no dev menu. */}
          <ListRow
            title="Quotes in Notifications"
            subtitle={(wisdomQuoteCount ?? 3) > 0
              ? 'Turns your reminders into quotes from the wins you set: yesterday\u2019s win in the morning, today\u2019s at night. Personalized lines are the backup.'
              : 'Turns your morning and evening reminders into a short quote. With personalization on, lines are drawn from your mandates and shown on your lock screen.'}
            trailing="toggle"
            onLongPress={handleTestQuoteNotification}
            delayLongPress={800}
            trailingAccessory={
              <Toggle
                value={ns.includeQuotes === true}
                onValueChange={(v) => { applyNotifSettings({ includeQuotes: v }); }}
                accessibilityLabel="Quotes in Notifications"
              />
            }
          />

          {/* NEX-277: personalization kill switch — off reverts to curated lines only */}
          {ns.includeQuotes === true && (
            <ListRow
              title="Personalize from Mandates"
              subtitle="Lines reflect who you are becoming. Turn off to use curated lines only."
              trailing="toggle"
              trailingAccessory={
                <Toggle
                value={ns.personalizedQuotes !== false}
                onValueChange={(v) => { applyNotifSettings({ personalizedQuotes: v }); }}
                accessibilityLabel="Personalize from Mandates"
              />
              }
            />
          )}

          {/* NEX-277: review / remove the AI lines currently in rotation (no approval gate) */}
          {ns.includeQuotes === true && aiQuoteCount > 0 && (
            <ListRow
              title="Active Notification Lines"
              subtitle={`${aiQuoteCount} personalized ${aiQuoteCount === 1 ? 'line' : 'lines'} in rotation. Tap to review or remove.`}
              onPress={() => router.push('/settings/pending-quotes')}
            />
          )}
        </ListSection>
      </View>

      {/* ── Habits ───────────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>HABITS</Text>
        <ListSection>
          <ListRow
            title="Soft Mode"
            subtitle="Show a day streak with one free miss. Off by default, your progress is cumulative and a miss takes nothing away."
            trailing="toggle"
            trailingAccessory={
              <Toggle
                value={!!softMode}
                onValueChange={(v) => { setSoftMode(v); }}
                accessibilityLabel="Soft Mode"
              />
            }
          />
        </ListSection>
      </View>

      {/* ── Pause Mode (NEX-207) ──────────────────────────────────────────── */}
      {/* Canonical management home (NEX-218). Forward-looking, no shame, no day
          count of the break (Law C). The engine (freeze + silence + repair) is
          driven by start/resumePauseMode; richer surfaces (Home collapse, the
          resume card, the per-habit "Pause"->"Resting" rename) land in B2. */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>PAUSE MODE</Text>
        <ListSection>
          {pauseMode?.active ? (
            // The gold "Resume" trailing text IS the action (its own Pressable),
            // so it keeps gold + its own haptic (§19 trailing-action rule).
            <ListRow
              title="Paused"
              subtitle="Expectations are paused and nudges are off. Your progress is held. Resume whenever you return."
              trailing="custom"
              interactiveAccessory
              trailingAccessory={
                <Pressable
                  onPress={() => { haptic('buttonSecondary'); resumePauseMode?.(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Resume"
                >
                  <Text style={styles.goldAction} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>Resume</Text>
                </Pressable>
              }
            />
          ) : (
            <View style={{ paddingVertical: 14, paddingHorizontal: tokens.spacing.md }}>
              <Text style={styles.blockTitle}>Take a planned break</Text>
              <Text style={styles.blockSub}>Pause expectations and quiet the nudges. A planned break is never a lapse, and your progress is held, not lost.</Text>
              {/* NEX-207 B2: inline duration pills (mirrors Daily Quotes) instead of a
                  4-button Alert (Android caps alerts at 3 buttons — Greptile #167).
                  plannedUntil is prompt-only and open-ended is the calm default. */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                {[{ label: '1 week', days: 7 }, { label: '2 weeks', days: 14 }, { label: 'Open-ended', days: 0 }].map((opt) => (
                  <Pressable
                    key={opt.label}
                    onPress={() => {
                      haptic('buttonSecondary');
                      startPauseMode?.(opt.days > 0 ? addDaysToKey(getLocalDateKey(new Date()), opt.days) : undefined);
                    }}
                    style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: GOLD, backgroundColor: GOLD + '20' }}
                    accessibilityRole="button"
                    accessibilityLabel={`Start a ${opt.label.toLowerCase()} pause`}
                  >
                    <Text style={[styles.pillText, { color: GOLD, fontWeight: '700' }]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </ListSection>
      </View>

      {/* ── Weekly Email ──────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>WEEKLY EMAIL DIGEST</Text>
        <ListSection>
          <ListRow
            title="Weekly Summary Email"
            subtitle={`Habits, reps & tips every ${DAYS[weeklyEmailDay ?? 0]}`}
            trailing="toggle"
            trailingAccessory={
              <Toggle
                value={weeklyEmailConsent === 'granted' && weeklyEmailEnabled}
                onValueChange={(v) => { setWeeklyEmail(v); }}
                accessibilityLabel="Weekly Summary Email"
              />
            }
          />
          {weeklyEmailConsent === 'granted' && weeklyEmailEnabled && (
            <>
              {/* Day-cycler: the gold trailing text IS the action (§19). */}
              <ListRow
                title="Send on"
                trailing="custom"
                interactiveAccessory
                trailingAccessory={
                  <Pressable
                    onPress={() => {
                      haptic('tabChange');
                      setWeeklyEmail(true, ((weeklyEmailDay ?? 0) + 1) % 7);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Weekly email on ${DAYS[weeklyEmailDay ?? 0]}`}
                    accessibilityHint="Cycles to the next day"
                  >
                    <Text style={styles.goldAction} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>{DAYS[weeklyEmailDay ?? 0]} ↻</Text>
                  </Pressable>
                }
              />
              {/* NEX-218: test send stays GATED behind weeklyEmailEnabled so the
                  digest-off preference still controls every weekly-summary send.
                  Relabeled for plain language; sends only to the signed-in user.
                  Row is the action → muted chevron, not a gold trailing (§19). */}
              <ListRow
                title="Send myself a test summary"
                trailing="none"
                onPress={handleSendTestEmail}
              />
            </>
          )}
        </ListSection>
      </View>

      {/* ── SMS Updates (NEX-86) ──────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>SMS UPDATES</Text>
        <ListSection>
          <ListRow
            title="Content updates by text"
            subtitle={smsStatus === 'confirmed'
              ? 'Confirmed. Updates arrive by text.'
              : smsStatus === 'pending'
                ? 'Reply YES to the text we sent to confirm.'
                : 'Occasional content updates and reflections.'}
            trailing="toggle"
            trailingAccessory={
              <Toggle
                value={smsStatus === 'pending' || smsStatus === 'confirmed'}
                onValueChange={(v) => { toggleSms(v); }}
                disabled={smsBusy}
                accessibilityLabel="Content updates by text"
              />
            }
          />
          <View style={{ paddingHorizontal: tokens.spacing.md, paddingVertical: tokens.spacing.sm }}>
            {/* TCPA consent disclosure (NEX-86 / NEX-181). Rendered from the
                SMS_CONSENT_* constants that are also sent to the server verbatim as
                the consent audit-of-record. Legal copy — do not rewrite for voice.
                NEX-181 adds the tappable Privacy Policy / Terms links (CTIA). */}
            {/* FIXME(nex-56): off-scale fontSize 11 (legal caption), design review */}
            <Text style={styles.legalText}>
              {SMS_CONSENT_BODY} See our{' '}
              <Text
                style={{ color: GOLD, textDecorationLine: 'underline' }}
                onPress={() => { onClose?.(); setTimeout(() => router.push('/legal?type=privacy'), 350); }}
              >
                Privacy Policy
              </Text>
              {' '}and{' '}
              <Text
                style={{ color: GOLD, textDecorationLine: 'underline' }}
                onPress={() => { onClose?.(); setTimeout(() => router.push('/legal?type=terms'), 350); }}
              >
                Terms
              </Text>
              .
            </Text>
          </View>
        </ListSection>
      </View>

      {/* ── Privacy ───────────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>PRIVACY</Text>
        <ListSection>
          <ListRow
            title="Share usage data"
            subtitle={analyticsConsent === 'granted'
              ? 'Usage events tied to your account. Never your content.'
              : 'Usage data is off. Nothing is collected.'}
            trailing="toggle"
            trailingAccessory={
              <Toggle
                value={analyticsConsent === 'granted'}
                onValueChange={(v) => { setAnalyticsConsent(v ? 'granted' : 'denied'); }}
                accessibilityLabel="Share usage data"
              />
            }
          />
        </ListSection>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>DAILY QUOTES</Text>
        <ListSection>
          <View style={{ paddingVertical: 14, paddingHorizontal: tokens.spacing.md }}>
            <Text style={styles.blockTitle}>Quotes per day</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }} accessibilityRole="radiogroup">
              {[0, 1, 3, 5].map((count) => {
              const selected = (wisdomQuoteCount ?? 3) === count;
              return (
                <Pressable
                  key={count}
                  onPress={() => {
                    haptic('tabChange');
                    setWisdomQuoteCount(count as 0 | 1 | 3 | 5);
                    // Widget: re-write the snapshot so disabling Today's Wisdom
                    // (count 0 clears dailyWisdomQuotes) also clears the
                    // widget's quote of the day.
                    syncWidgetAfterMutation();
                  }}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: selected ? GOLD : BORDER,
                    backgroundColor: selected ? GOLD + '20' : 'transparent',
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={count === 0 ? 'Quotes off' : `${count} quotes per day`}
                >
                  <Text style={[styles.pillText, selected && { color: GOLD, fontWeight: '700' }]}>
                    {count === 0 ? 'Off' : count}
                  </Text>
                </Pressable>
              );
            })}
            </View>
          </View>
        </ListSection>
      </View>

      {/* ── Data Durability ───────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>BACKUP & RESTORE</Text>
        <ListSection>
          <View style={styles.backupHero}>
            <Text style={styles.backupStatus}>{backupStatus.isBackedUp ? '✓ Protected' : 'Needs backup'}</Text>
            <Text style={styles.backupDetail}>{backupStateLabel}</Text>
            <Text style={styles.backupCopy}>Habit history, streaks, reviews, and settings are snapshotted before app migrations and after local saves.</Text>
          </View>
          {/* Rows are the action → muted chevrons, not gold trailings (§19). */}
          <ListRow
            title="Back Up Now"
            trailing="none"
            busy={backupBusy}
            disabled={backupBusy}
            onPress={handleManualBackup}
          />
          <ListRow
            title="Restore From Backup"
            trailing="none"
            disabled={!backupStatus.isBackedUp || backupBusy}
            onPress={() => handleRestoreBackup('latest')}
          />
          {backupStatus.hasPreMigrationBackup && (
            <ListRow
              title="Roll Back Last Update"
              trailing="none"
              disabled={backupBusy}
              onPress={() => handleRestoreBackup('premigration')}
            />
          )}
        </ListSection>
      </View>

      {/* ── Integrations ──────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>INTEGRATIONS</Text>
        <ListSection>
          {/* ListRow owns the press haptic now — call-site haptic() stripped. */}
          <ListRow
            title="Calendars"
            onPress={() => {
              onClose?.();
              setTimeout(() => router.push('/settings/calendars'), 350);
            }}
          />
          <ListRow
            title="Apple Reminders"
            onPress={() => {
              onClose?.();
              setTimeout(() => router.push('/settings/apple-reminders'), 350);
            }}
          />
        </ListSection>
      </View>

      {/* ── App Info ──────────────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>APP</Text>
        <ListSection>
          {/* Title stays white (kit row has no gold title; §19 budget belongs
              to the trailing-action cyclers). Haptic stripped — ListRow owns it. */}
          <ListRow title="Help & Guides" onPress={() => setShowHelp(true)} />
          <ListRow
            title="Version"
            trailing="value"
            value={formatAppVersion(Application.nativeApplicationVersion, Application.nativeBuildVersion)}
          />
          {updateIdLabel ? <ListRow title="Update" trailing="value" value={updateIdLabel} /> : null}
          <ListRow title="Privacy Policy" onPress={() => { onClose?.(); setTimeout(() => router.push('/legal?type=privacy'), 350); }} />
          <ListRow title="Terms of Service" onPress={() => { onClose?.(); setTimeout(() => router.push('/legal?type=terms'), 350); }} />
          <ListRow title="Contact Support" trailing="external" onPress={() => Linking.openURL('mailto:admin@thecircleoflight.net')} />
        </ListSection>
      </View>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <View style={styles.section}>
        {!subStatus.isSubscribed && (
          <PrimaryPill
            fullWidth
            style={{ marginBottom: tokens.spacing.sm }}
            onPress={() => setShowPaywall(true)}
          >
            Upgrade to Nexus Pro
          </PrimaryPill>
        )}
        <Pressable
          style={styles.actionBtn}
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.actionText}>Sign Out</Text>
        </Pressable>
        <Pressable
          style={styles.actionBtn}
          onPress={handleExportData}
          disabled={exporting}
          accessibilityRole="button"
          accessibilityLabel="Export my data"
        >
          <Text style={styles.actionText}>{exporting ? 'Preparing…' : 'Export my data'}</Text>
        </Pressable>
        <Pressable
          style={styles.deleteBtn}
          onPress={handleDeleteAccount}
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          accessibilityHint="Permanently deletes your account and all your data. This cannot be undone."
        >
          <Text style={styles.deleteText}>Delete Account</Text>
        </Pressable>
      </View>

      {__DEV__ && (
        // Dev-only: replay the onboarding flow for App Store Connect
        // recordings. Clears the Pulse recommendations + the quick-win
        // stamp so the FULL flow replays from the first inspire screen
        // (the stamp would otherwise short-circuit handleReviewAccept past
        // steps 3-4), then flips the session-only replay flag —
        // RootLayoutInner mounts OnboardingScreen over the tabs until
        // commitActivation drops the flag. NOTE: completing a replay
        // re-commits whatever is entered (mandate pillars prepend, habits/
        // todos append, userProfile name overwrites) — acceptable on a
        // recording device, not a data-safe rehearsal.
        <SecondaryButton
          style={{ marginBottom: tokens.spacing.sm }}
          onPress={() => {
            AsyncStorage.removeItem('nexus_hasSeenQuickWin').catch(() => {});
            // NEX-193: clear the first-win marker so a replay re-asks for the
            // win-first capture (FIRST_WIN_DONE_KEY in first-win-capture.tsx).
            AsyncStorage.removeItem('nexus_firstWinCaptured').catch(() => {});
            // NEX-299: same lifecycle scope — clear the onboarding-start
            // timestamp + backgrounding flag (ONBOARDING_STARTED_KEY /
            // ONBOARDING_BACKGROUNDED_KEY in app/_layout.tsx) so a replay
            // times itself fresh instead of inheriting the prior attempt's.
            AsyncStorage.removeItem('nexus_onboardingStartedAtMs').catch(() => {});
            AsyncStorage.removeItem('nexus_onboardingBackgrounded').catch(() => {});
            // Mute every analytics path for the replay session — a replay
            // on a consented device would otherwise re-fire the onboarding
            // funnel into production PostHog. Unmuted when commitActivation
            // drops the replay flag.
            setAnalyticsReplaySuppressed(true);
            const s = useAppState.getState();
            s.setOnboardingRecommendations(null);
            s.setDevReplayOnboarding(true);
          }}
        >
          REPLAY ONBOARDING
        </SecondaryButton>
      )}
      {__DEV__ && <MotionDebugPanel />}

      <Text style={styles.footer}>Nexus · Built for the intentional</Text>

      {showPaywall && (
        <Modal visible animationType="slide" presentationStyle="fullScreen">
          <RemotePaywallScreen
            entryPoint="settings"
            onSubscribed={() => { setShowPaywall(false); checkSubscription().then(setSubStatus); }}
            onClose={() => setShowPaywall(false)}
          />
        </Modal>
      )}
      {showPhoneModal && (
        <Modal visible transparent animationType="fade">
          <View style={{ flex: 1, backgroundColor: tokens.color.scrim, justifyContent: 'center', padding: tokens.spacing.lg }}>
            <View style={{ backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: 16 }}>
              <Text style={[styles.modalTitle, { marginBottom: 10 }]}>Edit phone number</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                {countryCodes.map((country) => (
                  <Pressable
                    key={country}
                    onPress={() => setPhoneCountry(country)}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: phoneCountry === country ? GOLD : BORDER, borderRadius: 10, marginRight: 8 }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: phoneCountry === country }}
                    accessibilityLabel={`${country} +${getCountryCallingCode(country as any)}`}
                  >
                    <Text style={{ color: phoneCountry === country ? GOLD : TEXT }}>{countryFlag(country)} {country} +{getCountryCallingCode(country as any)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <TextInput value={phoneInput} onChangeText={(v) => { setPhoneInput(v); setPhoneError(''); }} style={[styles.modalInput, { borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 10, color: TEXT }]} placeholder="Phone number" placeholderTextColor={MUTED} keyboardType="phone-pad" />
              {!!phoneError && <Text style={{ color: RED, marginTop: 8 }}>{phoneError}</Text>}
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <Pressable onPress={() => setShowPhoneModal(false)} hitSlop={tokens.icon.hitTarget.linkSlopTight} accessibilityRole="button" accessibilityLabel="Cancel phone number edit"><Text style={styles.modalAction}>Cancel</Text></Pressable>
                <Pressable onPress={savePhoneNumber} hitSlop={tokens.icon.hitTarget.linkSlopTight} accessibilityRole="button" accessibilityLabel="Save phone number"><Text style={[styles.modalAction, { color: GOLD }]}>Save</Text></Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </ScrollView>
    </AdaptiveScreen>
    <Modal
      visible={showTrialExtensionOffer}
      transparent
      animationType="fade"
      onRequestClose={() => { if (!cancelFlowBusy) setShowTrialExtensionOffer(false); }}
    >
      <View style={styles.offerBackdrop}>
        <View style={styles.offerCard}>
          <Text style={styles.offerTitle}>Take another week. No pressure.</Text>
          <Text style={styles.offerBody}>Seven more days, no charge. Decide at the end of it.</Text>
          <PrimaryPill
            fullWidth
            disabled={cancelFlowBusy}
            style={{ marginBottom: tokens.spacing.xs }}
            onPress={async () => {
              if (cancelFlowBusy) return;
              try {
                setCancelFlowBusy(true);
                void trackEvent('trial_extension_offer_accepted', { surface: 'settings_cancel_flow' });
                const appUserId = await Purchases.getAppUserID();
                const { data, error } = await supabase.functions.invoke('extend-trial', {
                  body: { appUserId },
                });
                if (error || !data?.ok) {
                  console.log('[extend-trial] failed', error, data);
                  void trackEvent('trial_extension_grant_failed', { surface: 'settings_cancel_flow' });
                  setShowTrialExtensionOffer(false);
                  Alert.alert(
                    'Could not extend.',
                    'Opening Apple subscription management.',
                    [{ text: 'OK', onPress: () => Linking.openURL(cancelManagementUrl) }],
                  );
                  return;
                }
                void trackEvent('trial_extension_granted', { surface: 'settings_cancel_flow' });
                setShowTrialExtensionOffer(false);
                // NEX-231: extend-success stays in-app (never opens Apple), and we
                // refresh inline right here — so clear the pending-refresh flag set
                // by openManageSubscription, or the next unrelated foreground would
                // do a spurious cache-invalidate + refetch.
                pendingSubRefreshRef.current = false;
                // Greptile P3: refresh subStatus so the trial-expiry date
                // in the settings header reflects the newly granted +7 days
                // immediately, not on next screen re-entry.
                checkSubscription().then(setSubStatus).catch(() => {});
                Alert.alert('Seven more days.', 'Your trial has been extended.');
              } catch (e) {
                console.log('[extend-trial] exception', e);
                void trackEvent('trial_extension_grant_failed', { surface: 'settings_cancel_flow' });
                setShowTrialExtensionOffer(false);
                Alert.alert(
                  'Something went sideways',
                  'We could not extend the trial just now. Opening Apple subscription management instead.',
                  [{ text: 'OK', onPress: () => Linking.openURL(cancelManagementUrl) }],
                );
              } finally {
                setCancelFlowBusy(false);
              }
            }}
          >
            {cancelFlowBusy ? 'Extending…' : 'Extend trial 7 days'}
          </PrimaryPill>
          <Pressable
            style={[styles.offerSecondary, cancelFlowBusy && { opacity: 0.6 }]}
            disabled={cancelFlowBusy}
            onPress={async () => {
              if (cancelFlowBusy) return;
              setShowTrialExtensionOffer(false);
              void trackEvent('trial_extension_offer_declined', { surface: 'settings_cancel_flow' });
              await Linking.openURL(cancelManagementUrl);
            }}
            accessibilityRole="button"
            accessibilityLabel="Continue to cancel"
          >
            <Text style={styles.offerSecondaryText}>Continue to cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
    <StatusBarScrim />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: tokens.spacing.lg, paddingTop: 70 /* FIXME(nex-56): off-scale spacing 70 — review */, paddingBottom: 120 /* FIXME(nex-56): off-scale spacing 120 — review */ },
  // FIXME(nex-56): off-scale fontSize 12, design review
  title: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4, marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, textAlign: 'center' },
  section: { marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale fontSize 9, design review
  sectionLabel: { color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 2, marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, marginLeft: tokens.spacing.xxs },
  card: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, overflow: 'hidden', ...ambientGlowSoft },
  // FIXME(nex-56): off-scale fontSize 11, design review
  cardLabel: { color: MUTED, fontSize: 11, padding: tokens.spacing.md, paddingBottom: tokens.spacing.xxs },
  // FIXME(nex-56): fontSize 17 matches bodyLg size but fontWeight '600' ≠ token '400' — design review
  cardValue: { color: TEXT, fontSize: 17, fontWeight: '600', paddingHorizontal: tokens.spacing.md, paddingBottom: tokens.spacing.md },
  backupHero: { paddingVertical: tokens.spacing.md, paddingHorizontal: tokens.spacing.md },
  backupStatus: { color: GREEN, fontSize: 17, fontWeight: '800', marginBottom: tokens.spacing.xxs },
  backupDetail: { color: TEXT, fontSize: 13, fontWeight: '600', marginBottom: tokens.spacing.xs },
  backupCopy: { color: MUTED, fontSize: 12, lineHeight: 17 },
  // Generic rows migrated to kit ListRow/ListSection (docs/plans/generic-list-row.md
  // PR 2) — the row*/divider styles are gone. What remains serves the custom
  // blocks (pause pills, quote-count pills, consent caption, phone modal) and
  // the trailing-action gold text (day-cyclers, Resume).
  blockTitle: { color: TEXT, fontSize: 15 }, // custom-block title (was the row label style)
  blockSub: { color: MUTED, fontSize: 12, marginTop: 4, lineHeight: 16 }, // matches old rowSub
  // FIXME(nex-56): fontSize 15 matches bodyMd size but no fontFamily set — design review
  pillText: { color: MUTED, fontSize: 15 },
  // FIXME(nex-56): off-scale fontSize 14, design review
  goldAction: { color: GOLD, fontSize: 14, fontWeight: '600' }, // trailing-text-IS-action (§19)
  // FIXME(nex-56): off-scale fontSize 11 (legal caption), design review
  legalText: { color: MUTED, fontSize: 11, lineHeight: 16 },
  // FIXME(nex-56): fontSize 15 matches bodyMd size but no fontFamily set — design review
  modalTitle: { color: TEXT, fontSize: 15 },
  // FIXME(nex-56): fontSize 15 matches bodyMd size but no fontFamily set — design review
  modalInput: { color: MUTED, fontSize: 15 },
  // FIXME(nex-56): fontSize 15 matches bodyMd size but no fontFamily set — design review
  modalAction: { color: MUTED, fontSize: 15 },
  offerBackdrop: { flex: 1, backgroundColor: tokens.color.scrim, alignItems: 'center', justifyContent: 'center', padding: tokens.spacing.lg },
  offerCard: { width: '100%', maxWidth: 360, borderRadius: tokens.radii.lg, borderWidth: 1, borderColor: tokens.color.luminousEdge, backgroundColor: SURFACE, padding: tokens.spacing.md, ...ambientGlow },
  offerTitle: { ...tokens.type.titleSection, color: TEXT, marginBottom: tokens.spacing.xs },
  offerBody: { ...tokens.type.bodyMd, color: MUTED, marginBottom: tokens.spacing.md },
  offerSecondary: { borderWidth: 1, borderColor: BORDER, borderRadius: tokens.radii.md, paddingVertical: tokens.spacing.sm, alignItems: 'center' },
  offerSecondaryText: { ...tokens.type.buttonPrimary, color: MUTED },
  actionBtn: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, paddingVertical: tokens.spacing.md, alignItems: 'center', marginBottom: tokens.spacing.sm, ...ambientGlowSoft },
  // FIXME(nex-56): fontSize 15 matches bodyMd size but fontWeight '600' ≠ token '400' — design review
  actionText: { color: TEXT, fontSize: 15, fontWeight: '600' },
  deleteBtn: { paddingVertical: tokens.spacing.md, alignItems: 'center' },
  // FIXME(nex-56): off-scale fontSize 14, design review
  deleteText: { color: RED, fontSize: 14, fontWeight: '600' },
  // FIXME(nex-56): tokens.color.goldHairline off-scale near-black footer text, no token — design review
  // FIXME(nex-56): off-scale fontSize 11, design review
  footer: { color: tokens.color.textDisabled, fontSize: 11, textAlign: 'center', marginTop: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, letterSpacing: 1 },
});
