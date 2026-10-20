/**
 * Nexus Notification Service — Enhanced
 *
 * Notification types:
 * 1. Morning intention prompt      — 8am daily (configurable)
 * 2. Evening check-in reminder     — 8pm daily (configurable)
 * 3. Streak at risk                — 8pm, only when streak >= 5 and habit not logged today
 * 4. Weekly reflection ready       — Sunday 10am (configurable day/time)
 * 5. Milestone notifications       — 7-day, 30-day, 100-day streaks
 * 6. Weekly summary               — Sunday 10am (same trigger as reflection)
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import tokens from '@/src/theme/tokens';
import { stripEmoji } from '@/src/utils/text';
import { type LeadTimeAction, leadTimeFireAt } from '@/src/state/lead-time-types';
import { chooseReceptiveHour } from './receptivity';
import { selectReminderSchedules, nudgeCopy } from '@/src/state/reminder-schedule';
import { computeBillingReminder, billingReminderContent, type BillingReminder, type BillingReminderInfo } from '@/src/state/billing-reminder-types';
import { computeTrialNudgeCandidates, resolveTrialNudgeSchedule, trialNudgeContent, type TrialNudge, type TrialNudgeInfo } from '@/src/state/trial-nudge-types';
import { getBillingReminderInfo, getTrialNudgeInfo } from './revenuecat';
import { shiftOutOfQuietHours, type QuietWindow } from '@/src/utils/notification-quiet-hours';
import { trackEvent } from './analytics';
import { type QuotePool, emptyPool } from '@/src/ai/notification-quote-pool';
import {
  MORNING_PROMPT,
  EVENING_PROMPT,
  EVENING_CUE_TITLE,
  composeQuoteBody,
  composeWisdomBody,
  resolveNotificationLines,
  dayOfYearIndex,
  type ResolvedNotificationLine,
} from '@/src/ai/notification-quote-compose';

// NEX-198: ambient-reminder notification category + actions. Category/action
// identifiers avoid ':' and '-' (Expo SDK 54 guidance). Done is first (≤4
// actions, Done-first per the ticket); Open foregrounds, Done resolves in place.
export const REMINDER_CATEGORY = 'nexusReminder';
export const REMINDER_ACTION = { DONE: 'reminderDone', OPEN: 'reminderOpen' } as const;

// How notifications appear when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // NEX-198: a reminder firing while the app is foregrounded would double up
    // with its Home pin — suppress the banner (keep it in the notification
    // list/center). All other notifications present as before.
    const isReminder =
      notification?.request?.content?.categoryIdentifier === REMINDER_CATEGORY;
    return {
      shouldShowAlert: !isReminder, // deprecated but kept for older SDK compat
      shouldShowBanner: !isReminder, // SDK 51+
      shouldShowList: true, // SDK 51+
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

// Notification IDs — used to cancel/replace
export const IDS = {
  MORNING: 'nexus-morning-intention',
  EVENING: 'nexus-evening-checkin',
  WEEKLY:  'nexus-weekly-reflection',
  MILESTONE: 'nexus-milestone',
  // NEX-162: one one-shot per lead-time action — `${LEAD_TIME_PREFIX}${id}`.
  LEAD_TIME_PREFIX: 'nexus-leadtime-',
  // NEX-232: one pre-charge reminder — `${BILLING_PREFIX}${kind}` (trial XOR renewal).
  BILLING_PREFIX: 'nexus-billing-',
  // NEX-198: one one-shot per timed inbox reminder — `${REMINDER_PREFIX}${id}`.
  REMINDER_PREFIX: 'nexus-reminder-',
  // NEX-301: two fixed one-shots per trial — `${TRIAL_NUDGE_PREFIX}day0` / `day1`.
  TRIAL_NUDGE_PREFIX: 'nexus-trial-nudge-',
};

// NEX-192: retired notification identifiers. Pre-upgrade installs may still have
// a one-shot "streak at risk" notification queued — the scheduler that created it
// (`scheduleStreakAtRiskNotification` / `IDS.STREAK`) is gone, so nothing else
// would ever cancel it. We cancel it on every launch (idempotent and cheap) so no
// user receives the banned absence-counting / "don't break your streak" push after
// upgrading. Per ADHD-pivot §1.5 Law C (no shame, never count an absence).
const RETIRED_NOTIFICATION_IDS = ['nexus-streak-at-risk'];

/**
 * Data payload embedded in every notification.
 * Retrieved via getNotificationRoute() when the user taps.
 */
export interface NotificationRouteData {
  /** Expo Router path, e.g. '/(tabs)/home' */
  route: string;
  /** Screen-level action identifier, e.g. 'open_intention' */
  action: string;
}

/** Options for scheduleMilestoneNotification. */
export interface MilestoneOptions {
  habitTitle: string;
  /** Stable per-habit id for the notification identifier (preferred over the title). */
  habitId?: string;
  /** NEX-190: cumulative lifetime reps (Nth completion), not a breakable streak. */
  reps: number;
}

export interface ScheduleOptions {
  morningHour?: number;    // default 8
  morningMinute?: number;  // default 0
  eveningHour?: number;    // default 20
  eveningMinute?: number;  // default 0
  weeklyDay?: number;      // 0=Sun..6=Sat, default 0 (Sun)
  weeklyHour?: number;     // default 10
  milestoneAlerts?: boolean; // default true
  // NEX-207: Pause Mode. When true, cancel the recurring morning/evening/weekly
  // nudges and do NOT reschedule them — a planned break silences nudges. The
  // caller passes areNudgesSilenced(state). Cancellation is permission-free, so
  // it runs even on a denied device (clears anything queued before the pause).
  silenced?: boolean;
  // NEX-212 (N-3): receptivity-aware timing. When smartTiming !== false (default
  // on), the daily morning/evening hours are nudged toward the user's launch-hour
  // histogram (openHourCounts) within a conservative ±2h window. When false the
  // exact configured hours are used. Weekly is never nudged. With no data the
  // nudge is a no-op, so omitting these is safe.
  smartTiming?: boolean;
  openHourCounts?: number[];
  // Notification quotes (opt-in). When includeQuotes is true, a short on-voice
  // quote is appended to the morning/evening bodies, chosen at schedule time from
  // `quotesPool` (defaults to the seed-only floor) by today's date index. Frozen
  // at schedule time; refreshes when the app reschedules (launch / settings edit).
  includeQuotes?: boolean;
  quotesPool?: QuotePool;
  // Today's-Wisdom lines for the LOCAL day (from the user's today's win, via
  // todayWisdomForNotification). With includeQuotes on, each slot leads with
  // its wisdom line when the text passes the NEX-277 safety filter; otherwise
  // the pool rotation covers that slot. Undefined ⇒ pool-only (prior behavior).
  todayWisdom?: { quote: string; author: string }[];
  // YESTERDAY's wisdom set (via wisdomForNotificationDate). The morning nudge
  // fires before today's win exists, so it leads with yesterday's win; see
  // wisdomForSlots for the fire-date dating.
  yesterdayWisdom?: { quote: string; author: string }[];
  // NEX-277 kill switch: when false, selection ignores AI lines and draws from the
  // curated seed floor only. Default (undefined) is personalized/auto-use ON.
  personalized?: boolean;
  // B2: called with the quote strings picked today + the day index, so the caller
  // can advance the no-repeat `shown` map atomically against the CURRENT store
  // (avoids clobbering a concurrent generation write). Omit for seed-only callers.
  onQuotesSelected?: (quotes: string[], dayIndex: number) => void;
}

/**
 * Create the Android `nexus` channel. No-op on iOS, never prompts — split out
 * so the test send (sendTestQuoteNotification) can ensure the channel without
 * triggering a permission request.
 */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('nexus', {
    name: 'Nexus',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 100, 250],
    lightColor: tokens.color.gold,
    sound: 'default',
  });
}

/**
 * Request notification permission and configure Android channel.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  await ensureAndroidChannel();

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

async function cancelNotification(id: string) {
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Already cancelled or doesn't exist — safe to ignore
  }
}

/** Compose the notification body for one resolved slot: Today's-Wisdom lines
 *  carry their author; pool lines use the plain quote wrap; null falls back to
 *  the seed floor inside composeQuoteBody (the body is never blank). */
function bodyForResolvedLine(line: ResolvedNotificationLine): string {
  return line.text != null && line.author !== undefined
    ? composeWisdomBody(line.text, line.author)
    : composeQuoteBody(line.text);
}

/**
 * Date the wisdom sets against each slot's NEXT fire time. Notification content
 * freezes at schedule time, so "yesterday's win" / "today's win" must be read
 * relative to when the nudge FIRES, not when it is scheduled:
 * - Morning fires before the user sets today's win → leads with YESTERDAY's
 *   set. Scheduled before today's morning trigger, that fire is TODAY (the real
 *   yesterday); scheduled after, the fire is TOMORROW, whose "yesterday" is
 *   today → today's set.
 * - Evening → TODAY's set while today's fire is still ahead; after it, the next
 *   fire is tomorrow evening, whose "today" has no win yet → no wisdom (the
 *   pool covers it until the next reschedule).
 */
function wisdomForSlots(
  opts: ScheduleOptions,
  now: Date,
  morningHour: number,
  morningMinute: number,
  eveningHour: number,
  eveningMinute: number,
): { morning?: { quote: string; author: string }[]; evening?: { quote: string; author: string }[] } {
  const firesToday = (h: number, m: number) => {
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    return now.getTime() < t.getTime();
  };
  return {
    morning: firesToday(morningHour, morningMinute) ? opts.yesterdayWisdom : opts.todayWisdom,
    evening: firesToday(eveningHour, eveningMinute) ? opts.todayWisdom : undefined,
  };
}

// ── Test send (hidden long-press in Settings) ──────────────────────────────
// Fires a one-shot 10s out with EXACTLY the morning composition today's real
// schedule would use (wisdom → pool → bare prompt), so the whole pipeline —
// permission, schedule, delivery, quote body — is verifiable on a TestFlight
// build, where the daily 8am/8pm nudges give no on-demand feedback.
// Own identifier OUTSIDE every IDS.* family so no reconciler collects it.
export const TEST_QUOTE_NOTIFICATION_ID = 'nexus-test-quote';

/**
 * Schedule the test one-shot. Returns { ok: false } when permission is not
 * granted (caller shows the "enable notifications" Alert) — NEVER prompts;
 * scheduleAllNotifications owns the launch prompt.
 */
export async function sendTestQuoteNotification(opts: ScheduleOptions = {}): Promise<{ ok: boolean }> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return { ok: false };
  await ensureAndroidChannel();

  const now = new Date();
  // Morning-slot semantics (that's what the test replays). Use the CONFIGURED
  // schedule AND the NEX-212 smart-timing nudge, exactly as
  // scheduleAllNotificationsNow does — with defaults the wisdom dating
  // (yesterday vs today) can diverge from what production would pick
  // (Greptile PR #361).
  const forced = opts.smartTiming === false;
  const morningHour = chooseReceptiveHour(opts.morningHour ?? 8, opts.openHourCounts, { forced });
  const eveningHour = chooseReceptiveHour(opts.eveningHour ?? 20, opts.openHourCounts, { forced });
  const slots = wisdomForSlots(
    opts,
    now,
    morningHour,
    opts.morningMinute ?? 0,
    eveningHour,
    opts.eveningMinute ?? 0,
  );
  const lines = resolveNotificationLines({
    includeQuotes: opts.includeQuotes === true,
    wisdomBySlot: { morning: slots.morning },
    pool: opts.quotesPool ?? emptyPool(),
    now,
    personalized: opts.personalized !== false,
  });

  await cancelNotification(TEST_QUOTE_NOTIFICATION_ID);
  await Notifications.scheduleNotificationAsync({
    identifier: TEST_QUOTE_NOTIFICATION_ID,
    content: {
      title: opts.includeQuotes ? undefined : 'One thing.',
      body: opts.includeQuotes ? bodyForResolvedLine(lines.morning) : MORNING_PROMPT,
      data: { route: '/(tabs)/home', action: 'open_intention' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      repeats: false,
    },
  });
  return { ok: true };
}

/**
 * NEX-192: cancel any retired notification one-shots left queued on pre-upgrade
 * installs. The streak-at-risk push ("Don't break your streak tonight") was
 * scheduled by a now-deleted scheduler, so nothing else would ever cancel it —
 * an upgraded user would still receive the banned absence-counting push once.
 * Idempotent and permission-free; safe to call on every launch. §1.5 Law C.
 */
async function cancelRetiredNotifications(): Promise<void> {
  await Promise.all(RETIRED_NOTIFICATION_IDS.map(cancelNotification));
}

/**
 * Schedule all recurring notifications.
 * Safe to call multiple times — cancels and reschedules each time.
 *
 * NEX-207: callers go through the serialized `scheduleAllNotifications` wrapper
 * below, NOT this impl directly. Pause silencing and re-arming both run through
 * here (cancel-then-maybe-reschedule), so two interleaving calls (a rapid
 * pause→resume toggle, or a settings edit racing the pause effect) could
 * otherwise leave a cancel running after an arm. Serializing converges them.
 */
async function scheduleAllNotificationsNow(opts: ScheduleOptions = {}) {
  // NEX-192: run the retired-notification cleanup BEFORE the permission gate.
  // A user could have granted permission (queuing the streak-at-risk one-shot),
  // then revoked it; the early-return below would otherwise leave that banned
  // push queued forever. Cancelling a scheduled notification needs no permission.
  await cancelRetiredNotifications();

  // NEX-207: Pause Mode silences nudges. Cancel the three recurring nudges and
  // return WITHOUT rescheduling (and before the permission prompt — cancelling is
  // permission-free, and a paused user must not be prompted just to be silenced).
  // Resuming calls this again with silenced=false, which re-arms them below.
  if (opts.silenced) {
    await Promise.all([
      cancelNotification(IDS.MORNING),
      cancelNotification(IDS.EVENING),
      cancelNotification(IDS.WEEKLY),
    ]);
    return;
  }

  const granted = await requestNotificationPermission();
  if (!granted) return;

  const morningMinute = opts.morningMinute ?? 0;
  const eveningMinute = opts.eveningMinute ?? 0;
  // NEX-212 (N-3): nudge the daily prompt HOURS toward the user's launch-hour
  // histogram (conservative ±2h, self-gating, no day-wrap). `forced` (Smart
  // timing off) returns the configured hour unchanged. Minutes are kept as
  // configured; weekly is never nudged.
  const forced = opts.smartTiming === false;
  const morningHour = chooseReceptiveHour(opts.morningHour ?? 8, opts.openHourCounts, { forced });
  const eveningHour = chooseReceptiveHour(opts.eveningHour ?? 20, opts.openHourCounts, { forced });
  // Notification quotes (opt-in): resolve today's lines at schedule time —
  // Today's-Wisdom (today's win) leads each slot when filter-safe, the pool
  // rotation (seed-only floor unless a persisted pool is passed) covers the
  // rest. Null text → the body stays the bare prompt, byte-identical to before
  // this feature.
  const now = new Date();
  const quotePool = opts.quotesPool ?? emptyPool();
  // NEX-277: `personalized` (kill switch) restricts selection to the seed floor when false.
  const personalized = opts.personalized !== false;
  const lines = resolveNotificationLines({
    includeQuotes: opts.includeQuotes === true,
    wisdomBySlot: wisdomForSlots(opts, now, morningHour, morningMinute, eveningHour, eveningMinute),
    pool: quotePool,
    now,
    personalized,
  });
  // (onQuotesSelected is called AFTER the morning/evening notifications are actually
  // scheduled — see below — so `shown` never advances for a quote that failed to schedule.)
  // Expo weekday: 1=Sun, 2=Mon, ... 7=Sat
  const weekday       = ((opts.weeklyDay ?? 0) + 1); // convert 0-based to Expo 1-based Sun=1
  const weeklyHour    = opts.weeklyHour    ?? 10;

  // Cancel existing to avoid duplicates
  await cancelNotification(IDS.MORNING);
  await cancelNotification(IDS.EVENING);
  await cancelNotification(IDS.WEEKLY);

  // 1. Morning intention — daily. NEX-277: with quotes on, the body is JUST the
  // personalized line (quote-wrapped) and there is no title (the quote stands
  // alone under the app name). With quotes off, the original prompt + title.
  await Notifications.scheduleNotificationAsync({
    identifier: IDS.MORNING,
    content: {
      title: opts.includeQuotes ? undefined : 'One thing.',
      body: opts.includeQuotes ? bodyForResolvedLine(lines.morning) : MORNING_PROMPT,
      data: { route: '/(tabs)/home', action: 'open_intention' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: morningHour,
      minute: morningMinute,
    },
  });

  // 2. Evening check-in — daily. NEX-277: with quotes on, the kept debrief cue
  // becomes the (motivational) title over the quoted line; with quotes off, the
  // original prompt + title.
  await Notifications.scheduleNotificationAsync({
    identifier: IDS.EVENING,
    content: {
      title: opts.includeQuotes ? EVENING_CUE_TITLE : 'Close the loop.',
      body: opts.includeQuotes ? bodyForResolvedLine(lines.evening) : EVENING_PROMPT,
      data: { route: '/(tabs)/', action: 'open_debrief' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: eveningHour,
      minute: eveningMinute,
    },
  });

  // Morning + evening are now actually scheduled — only NOW advance the no-repeat
  // `shown` map (atomically, against the current store) so a quote that failed to
  // schedule never gets marked shown. Only POOL lines count: wisdom-covered slots
  // consumed nothing from the pool (poolQuotesUsed is empty then — skip the call).
  if (opts.onQuotesSelected && lines.poolQuotesUsed.length > 0) {
    opts.onQuotesSelected(lines.poolQuotesUsed, dayOfYearIndex(now));
  }

  // 3. Weekly summary + reflection — configured weekday
  await Notifications.scheduleNotificationAsync({
    identifier: IDS.WEEKLY,
    content: {
      title: 'Your week in review.',
      body: 'See how you showed up this week. Your summary is ready.',
      data: { route: '/(tabs)/home', action: 'open_reflection' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday,
      hour: weeklyHour,
      minute: 0,
    },
  });
}

// NEX-207: serialize all recurring-notification (re)schedules so a pause→resume
// toggle (or a settings edit racing the pause effect) can't interleave a cancel
// after an arm. Mirrors reconcileLeadTimeNotifications' serialized chain.
let scheduleChain: Promise<void> = Promise.resolve();

/**
 * Public entry — serialized. Cancels-then-(maybe)reschedules the morning/evening/
 * weekly nudges; honors `opts.silenced` (Pause Mode). Overlapping calls run in order.
 */
export function scheduleAllNotifications(opts: ScheduleOptions = {}): Promise<void> {
  scheduleChain = scheduleChain.then(() => scheduleAllNotificationsNow(opts)).catch(() => {});
  return scheduleChain;
}

/**
 * Schedule a milestone notification for a streak achievement.
 * Call this from the habit logging logic when a milestone is hit.
 */
export async function scheduleMilestoneNotification(opts: MilestoneOptions) {
  const { habitTitle, habitId, reps } = opts;
  const displayTitle = stripEmoji(habitTitle);

  // NEX-190: cumulative-rep milestones, positive-only. No emoji (banned in
  // notifications, §19), no exclamation points, no broken-streak framing. The
  // 66-rep copy reframes Lally per Law B (a structure you lean on, not failure).
  const milestones: Record<number, { title: string; body: string }> = {
    7:   { title: '7 Reps',   body: `Seven completions of ${displayTitle}. A structure is taking shape.` },
    30:  { title: '30 Reps',  body: `Thirty completions of ${displayTitle}. This is yours now.` },
    66:  { title: '66 Reps',  body: `Sixty-six completions of ${displayTitle}. Per Lally et al. (2010), about where a structure starts to hold. Not automatic, a thing you lean on.` },
    365: { title: '365 Reps', body: `A year's worth of ${displayTitle}. Remarkable.` },
  };

  const msg = milestones[reps];
  if (!msg) return;

  const granted = await requestNotificationPermission();
  if (!granted) return;

  // Include a per-habit key so two habits crossing the same rep milestone close
  // together don't share an identifier (the second would otherwise replace the first).
  // Prefer the stable rule id — title-derived keys collide for habits that differ
  // only by emoji ("Read" vs "📖 Read" both strip to "read").
  const habitKey = habitId || (displayTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'habit');

  // Fire immediately (1 second delay so it feels deliberate)
  await Notifications.scheduleNotificationAsync({
    identifier: `${IDS.MILESTONE}-${habitKey}-${reps}`,
    content: {
      title: msg.title,
      body: msg.body,
      data: { route: '/(tabs)/home', action: 'open_habits' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 1,
      repeats: false,
    },
  });
}

/**
 * Handle notification tap — returns route and action to navigate to.
 */
export function getNotificationRoute(
  notification: Notifications.Notification
): NotificationRouteData | null {
  const data = notification?.request?.content?.data;
  if (!data || typeof data.route !== 'string' || !data.route) return null;
  return {
    route: data.route,
    action: typeof data.action === 'string' ? data.action : '',
  };
}

// ── Lead-Time Radar (NEX-162) ─────────────────────────────────────────────

function leadTimeNotifId(id: string): string {
  return `${IDS.LEAD_TIME_PREFIX}${id}`;
}

/**
 * Schedule (or, on edit, cancel-then-reschedule) the act-by-morning one-shot for
 * one lead-time action. Fires 9:00 local on the act-by date. Cancels its prior
 * notification FIRST so an edit-to-past correctly leaves nothing scheduled (the
 * `fireAt <= now` guard then early-returns). No permission check here — callers
 * gate via reconcileLeadTimeNotifications.
 */
// Module-private: all scheduling must go through reconcileLeadTimeNotifications
// so it stays on the serialized chain (a direct caller would reintroduce the
// cancel-then-reschedule race).
async function scheduleLeadTimeNotification(input: {
  id: string;
  title: string;
  eventTitle: string;
  actByDate: string;
}, quiet?: QuietWindow): Promise<void> {
  // Cancel the prior one-shot FIRST so an edit-to-past leaves nothing scheduled
  // (leadTimeFireAt then returns null and we early-return below).
  await cancelNotification(leadTimeNotifId(input.id));
  let fireMs = leadTimeFireAt(input.actByDate);
  if (fireMs == null) return;

  // NEX-236: keep one-shots out of quiet hours. Lead-time fires 09:00, so this is
  // a no-op today, but it's a real idempotent integration that protects against
  // future config/lead-time changes that could land off-hours.
  if (quiet) fireMs = shiftOutOfQuietHours(fireMs, quiet);

  await Notifications.scheduleNotificationAsync({
    identifier: leadTimeNotifId(input.id),
    content: {
      title: 'An advance action is due today.',
      body: `${stripEmoji(input.eventTitle)}: ${stripEmoji(input.title)}.`,
      data: { route: '/(tabs)/orbit', action: 'open_lead_time' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(fireMs),
    },
  });
}

/**
 * Reconcile all lead-time notifications against the current actions: cancel the
 * whole `nexus-leadtime-*` family (drops orphans from completed/deleted actions),
 * then reschedule every OPEN action whose act-by morning is still in the future.
 *
 * The single entry point — called from a `leadTimeActions`-keyed effect in
 * app/_layout.tsx, so it covers create / edit / complete / delete from anywhere,
 * plus the launch + permission-granted-after-create cases (first run on mount).
 */
let leadTimeReconcileChain: Promise<void> = Promise.resolve();

export function reconcileLeadTimeNotifications(actions: LeadTimeAction[], quiet?: QuietWindow): Promise<void> {
  // Serialize overlapping reconciles. Two interleaving runs could otherwise have
  // run B cancel-by-family an id that run A's loop already rescheduled (and not
  // yet re-passed), silently dropping that one-shot — the feature's whole point.
  leadTimeReconcileChain = leadTimeReconcileChain.then(() => reconcileLeadTimeNow(actions, quiet)).catch(() => {});
  return leadTimeReconcileChain;
}

async function reconcileLeadTimeNow(actions: LeadTimeAction[], quiet?: QuietWindow): Promise<void> {
  // Gate on permission — do NOT prompt here. scheduleAllNotifications owns the
  // launch prompt; a denied/undetermined device just no-ops.
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  // Cancel-by-family — never leave a one-shot for an action that's gone.
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((n) => typeof n.identifier === 'string' && n.identifier.startsWith(IDS.LEAD_TIME_PREFIX))
        .map((n) => cancelNotification(n.identifier)),
    );
  } catch {
    // Enumeration can fail on some platforms. Open actions are still (re)scheduled
    // below (each schedule cancels its own id first); only stale one-shots for
    // completed/deleted actions might linger until the next successful reconcile.
  }

  const open = Array.isArray(actions) ? actions.filter((a) => a && !a.completed) : [];
  for (const a of open) {
    await scheduleLeadTimeNotification({
      id: a.id,
      title: a.title,
      eventTitle: a.eventTitle,
      actByDate: a.actByDate,
    }, quiet);
  }
}

// ── Pre-charge reminder (NEX-232) ──────────────────────────────────────────
// One local DATE one-shot a set window before a trial→paid conversion or an
// annual renewal, with a one-tap manage/cancel on tap. Source of truth is
// RevenueCat (the real Apple charge instant), not the app-side trial estimate.
// Mirrors the lead-time reconciler: own `nexus-billing-*` id family + a
// serialized chain. Single entry point — called on launch + on customerInfo
// updates from app/_layout.tsx.

let billingReconcileChain: Promise<void> = Promise.resolve();

// `provided` threads an already-projected entitlement (from the onCustomerInfoUpdated
// listener, which holds the freshest CustomerInfo) so we skip a redundant
// getCustomerInfo() that could fail/bail on slow/offline. The wrapper object
// distinguishes "info provided (even if null)" from "not provided → fetch".
export function reconcileBillingReminders(provided?: { info: BillingReminderInfo | null }, quiet?: QuietWindow): Promise<void> {
  // Serialize overlapping reconciles (launch + customerInfo listener can race).
  billingReconcileChain = billingReconcileChain.then(() => reconcileBillingNow(provided, quiet)).catch(() => {});
  return billingReconcileChain;
}

async function reconcileBillingNow(provided?: { info: BillingReminderInfo | null }, quiet?: QuietWindow): Promise<void> {
  // Compute FIRST. When the caller supplies the in-hand info we use it directly;
  // otherwise we fetch. A transient getCustomerInfo failure must NOT drop a valid
  // pending reminder (we bail before cancelling). A real cancel/renewal-off still
  // resolves to null below and is cleared by the cancel-by-family step.
  let desired: BillingReminder | null = null;
  try {
    const info = provided ? provided.info : await getBillingReminderInfo();
    desired = computeBillingReminder(info, Date.now());
  } catch {
    return; // fetch failed — leave any existing reminder; retry next reconcile
  }

  // Cancel-by-family BEFORE the permission gate (cancelling needs no permission).
  // A stale "you'll be charged" reminder must clear even if the user cancelled
  // their sub and notification permission is later denied/undetermined.
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((n) => typeof n.identifier === 'string' && n.identifier.startsWith(IDS.BILLING_PREFIX))
        .map((n) => cancelNotification(n.identifier)),
    );
  } catch {
    // Enumeration can fail on some platforms; the id-stable reschedule below
    // still replaces the active reminder.
  }

  if (!desired) return;

  // Only the SCHEDULE step is permission-gated (no prompt; scheduleAllNotifications
  // owns the launch prompt). A denied/undetermined device just no-ops here.
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  // NEX-236: keep the pre-charge one-shot out of quiet hours. Unlike lead-time
  // (pinned to 09:00, so the shift is a no-op there), a billing fire time is
  // `charge − 24h / − 3d`, inheriting whatever minute-of-day the subscription
  // started at, so it really can land at 2am — this is the case the guard is for.
  // The shift only moves FORWARD by at most the quiet-window length (< 24h, since
  // a degenerate start===end window never shifts), which is ≤ the smallest
  // pre-charge window (WINDOW_TRIAL_MS = 24h, see billing-reminder-types), so it
  // can never cross the charge instant; and forward-from-a-future-time stays
  // strictly future. No extra guard needed (revisit if WINDOW_TRIAL_MS shrinks).
  let fireAtMs = desired.fireAtMs;
  if (quiet) fireAtMs = shiftOutOfQuietHours(fireAtMs, quiet);

  const { title, body } = billingReminderContent(desired.kind, desired.chargeMs);
  await Notifications.scheduleNotificationAsync({
    identifier: `${IDS.BILLING_PREFIX}${desired.kind}`,
    content: {
      title,
      body,
      // Tap routes Home and opens Apple's manage/cancel screen (handled in _layout).
      data: { route: '/(tabs)/home', action: 'manage_subscription' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(fireAtMs),
    },
  });
}

// ── In-trial Day-0/1 activation nudge (NEX-301) ────────────────────────────
// Up to two fixed local DATE one-shots (Day-0, Day-1) while `periodType ===
// 'trial'`, driving back to the core-value surface. Deliberately does NOT gate
// on `willRenew` (unlike the billing reminder above) — reaching a mid-trial
// canceller before/after they cancel is this feature's whole purpose. Mirrors
// the billing reconciler's shape: own `nexus-trial-nudge-*` id family, a
// serialized chain, compute/fetch first (bail before cancel on failure),
// cancel-by-family before the permission gate.
//
// NOTE: no `isActivated` gate anywhere in this path. For a purchase made
// through THIS app's own paywall, a RevenueCat trial can only exist post-
// onboarding (isActivated is set before the paywall renders —
// app/_layout.tsx), so there is nothing to check for that case. The one
// carve-out (review-caught): a family-shared member can inherit an active
// trial the moment RC identifies them, independent of this device's
// onboarding state — handled instead by `TrialNudgeInfo.familyShared`
// excluding them entirely (mirrors `BillingReminderInfo.familyShared`),
// rather than by an isActivated check here.

function trialNudgeNotifId(day: 0 | 1): string {
  return `${IDS.TRIAL_NUDGE_PREFIX}day${day}`;
}

let trialNudgeReconcileChain: Promise<void> = Promise.resolve();

export function reconcileTrialNudges(provided?: { info: TrialNudgeInfo | null }, quiet?: QuietWindow): Promise<void> {
  // Serialize overlapping reconciles (launch + customerInfo listener can race,
  // same as billing — this is the first time two independently-chained
  // reconcilers fire off the SAME onCustomerInfoUpdated trigger; disjoint id
  // prefixes keep them from interfering with each other).
  trialNudgeReconcileChain = trialNudgeReconcileChain.then(() => reconcileTrialNudgesNow(provided, quiet)).catch(() => {});
  return trialNudgeReconcileChain;
}

async function reconcileTrialNudgesNow(provided?: { info: TrialNudgeInfo | null }, quiet?: QuietWindow): Promise<void> {
  // Compute FIRST — a transient fetch failure must not drop an already-scheduled
  // nudge (bail before cancelling), same reasoning as billing.
  let schedule: TrialNudge[];
  try {
    const info = provided ? provided.info : await getTrialNudgeInfo();
    const nowMs = Date.now();
    const candidates = computeTrialNudgeCandidates(info, nowMs);
    schedule = resolveTrialNudgeSchedule(candidates, nowMs, quiet ?? null, info?.expirationMs ?? null);
  } catch {
    return; // fetch failed — leave any existing nudges; retry next reconcile
  }

  // Capture what's already pending BEFORE cancelling, so we can tell a genuinely
  // NEW schedule from a routine reschedule of an unchanged trial — emitting
  // trial_nudge_scheduled on every reconcile (this fires on every
  // onCustomerInfoUpdated event, not just once) would double-count. Coarse by
  // design: keyed on identifier only, not on whether fireAtMs actually changed
  // — a real reschedule (e.g. a quiet-hours settings edit shifting the fire
  // time) does NOT re-emit. Accepted tradeoff for a schedule-count signal, not
  // a per-reschedule audit log.
  let alreadyPending = new Set<string>();
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    alreadyPending = new Set(
      scheduled
        .filter((n) => typeof n.identifier === 'string' && n.identifier.startsWith(IDS.TRIAL_NUDGE_PREFIX))
        .map((n) => n.identifier),
    );
    // Cancel-by-family BEFORE the permission gate (cancelling needs no permission)
    // — a stale nudge must clear even if the user later denies notifications.
    await Promise.all([...alreadyPending].map((id) => cancelNotification(id)));
  } catch {
    // Enumeration can fail on some platforms; the id-stable reschedule below
    // still replaces the active nudges.
  }

  if (schedule.length === 0) return;

  // Only the SCHEDULE step is permission-gated (no prompt; scheduleAllNotifications
  // owns the launch prompt). A denied/undetermined device just no-ops here.
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  for (const nudge of schedule) {
    const identifier = trialNudgeNotifId(nudge.day);
    const { title, body } = trialNudgeContent(nudge.day);
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title,
        body,
        data: { route: '/(tabs)/home', action: 'open_trial_nudge', day: nudge.day },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(nudge.fireAtMs),
      },
    });
    if (!alreadyPending.has(identifier)) {
      void trackEvent('trial_nudge_scheduled', { day: nudge.day, identifier });
    }
  }
}

// ── Ambient reminders (NEX-198 N-1) ────────────────────────────────────────
// One gentle one-shot per timed inbox item (an InboxTask carrying a dueDate).
// Mirrors the lead-time pattern: per-item DATE one-shot, cancel-then-reschedule,
// serialized reconcile chain, cancel-by-family, permission-gated (no prompt).
// The Home pin (selectDueReminders) is the persistence layer; this is just the
// single gentle alert. Notification ACTIONS (Done/Open) land in PR B.

// NEX-259: a reminder is a FAMILY of nudge one-shots, one per slot. The `__`
// delimiter never appears in createId() output, so `${idA}__n` can't collide
// with another item's family.
function reminderNotifId(id: string, slot: number): string {
  return `${IDS.REMINDER_PREFIX}${id}__${slot}`;
}

// Prefix shared by every nudge of one reminder — for family cancel/dismiss.
function reminderFamilyPrefix(id: string): string {
  return `${IDS.REMINDER_PREFIX}${id}__`;
}

/**
 * Register the ambient-reminder notification category (Done / Open actions).
 * Idempotent — safe to call on every launch. Call before scheduling so the
 * actions render. Done first, ≤4 actions (NEX-198).
 *
 * Both actions foreground the app: resolution (Done) lives in the JS response
 * handler, so a background action (`opensAppToForeground:false`) would accept
 * the Done tap but run no JS while terminated, leaving the item unresolved
 * until the next manual open. Foregrounding guarantees the handler resolves +
 * dismisses immediately. (A background TaskManager resolver is the N-2 option
 * if a quieter Done is wanted.)
 */
export async function registerNotificationCategories(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY, [
      { identifier: REMINDER_ACTION.DONE, buttonTitle: 'Done', options: { opensAppToForeground: true } },
      { identifier: REMINDER_ACTION.OPEN, buttonTitle: 'Open', options: { opensAppToForeground: true } },
    ]);
  } catch {
    // Non-fatal — actions just won't render; tap still routes.
  }
}

/**
 * Dismiss the DELIVERED reminder notifications for an inbox id from the tray
 * (cancelling scheduled ones doesn't remove already-shown ones). NEX-259: a
 * keep-nudging reminder can have several delivered nudges (`${id}__0/1/2`), so
 * dismiss the whole delivered FAMILY, not just a base id.
 * Called after a reminder is resolved (DONE action / Home).
 */
export async function dismissReminderNotification(id: string): Promise<void> {
  const bare = `${IDS.REMINDER_PREFIX}${id}`; // pre-upgrade N-1 delivered id (no slot)
  const familyPrefix = reminderFamilyPrefix(id); // `${bare}__` — slotted nudges
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .map((n) => n.request?.identifier)
        .filter(
          (ident): ident is string =>
            typeof ident === 'string' && (ident === bare || ident.startsWith(familyPrefix)),
        )
        .map((ident) => Notifications.dismissNotificationAsync(ident).catch(() => {})),
    );
  } catch {
    // Enumeration unsupported / nothing delivered — safe to ignore.
  }
}

// Module-private — all scheduling goes through reconcileReminderNotifications so
// it stays on the serialized chain (a direct caller would reintroduce the
// cancel-then-reschedule race).
async function scheduleReminderNotification(input: {
  id: string;
  title: string;
  fireAtMs: number;
  slot: number;
}): Promise<void> {
  // Cancel own slot id FIRST so an edit-to-past leaves nothing scheduled. (The
  // reconcile also cancels the whole family before this loop runs.)
  await cancelNotification(reminderNotifId(input.id, input.slot));
  if (input.fireAtMs <= Date.now()) return;
  await Notifications.scheduleNotificationAsync({
    identifier: reminderNotifId(input.id, input.slot),
    content: {
      // NEX-259: the title line varies per nudge slot; the body stays the task.
      title: nudgeCopy(input.slot),
      body: stripEmoji(input.title) || 'On your list.',
      data: { route: '/(tabs)/inbox', action: 'open_reminder', reminderId: input.id },
      categoryIdentifier: REMINDER_CATEGORY,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(input.fireAtMs),
    },
  });
}

/**
 * Reconcile all ambient reminder one-shots against the current inbox: cancel the
 * whole `nexus-reminder-*` family (drops orphans from resolved/deleted items),
 * then reschedule every unresolved, future-dated timed inbox item.
 *
 * The single entry point — called from an `inbox`-keyed effect in app/_layout.tsx,
 * so it covers create / resolve / delete / due-date edit from anywhere, plus the
 * launch + permission-granted-after-create cases. `inbox` is the raw InboxTask[].
 */
let reminderReconcileChain: Promise<void> = Promise.resolve();

export function reconcileReminderNotifications(inbox: unknown[]): Promise<void> {
  // Serialize overlapping reconciles (same rationale as lead-time): two
  // interleaving runs could otherwise cancel-by-family an id the other just
  // rescheduled, silently dropping that one-shot.
  reminderReconcileChain = reminderReconcileChain
    .then(() => reconcileRemindersNow(inbox))
    .catch(() => {});
  return reminderReconcileChain;
}

async function reconcileRemindersNow(inbox: unknown[]): Promise<void> {
  // Cancel-by-family FIRST, BEFORE the permission gate — a resolve / toggle-off
  // / due-date edit must clear stale one-shots even if notification permission
  // was later revoked (cancelling needs no permission). Only the (re)schedule
  // step below is permission-gated. (Mirrors the billing reconciler; also fixes
  // the N-1 case where a denied-permission user couldn't clear a stale reminder.)
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((n) => typeof n.identifier === 'string' && n.identifier.startsWith(IDS.REMINDER_PREFIX))
        .map((n) => cancelNotification(n.identifier)),
    );
  } catch {
    // Enumeration can fail on some platforms; each schedule cancels its own id
    // first, so only stale one-shots for resolved items might linger until the
    // next successful reconcile.
  }

  // Never prompt here (scheduleAllNotifications owns the launch prompt). A
  // denied/undetermined device just doesn't (re)schedule.
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  const schedules = selectReminderSchedules(
    Array.isArray(inbox) ? (inbox as any[]) : [],
    Date.now(),
  );
  for (const r of schedules) {
    await scheduleReminderNotification(r);
  }
}
