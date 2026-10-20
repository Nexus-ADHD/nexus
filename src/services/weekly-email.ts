/**
 * Nexus Weekly Email Service
 * ────────────────────────────────────────────────────────────────────
 * Manages the weekly email digest feature:
 *  - Determines if a summary email should be sent today
 *  - Builds the email payload from current app state
 *  - Calls the Supabase Edge Function to send the email
 *
 * Usage: Call checkAndSendWeeklySummary() on app open.
 * The function checks if today matches the configured day and if the
 * email hasn't been sent this week yet.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { computeHabitProgress } from '../state/selectors/habit-rollup';
import { isPausedOn, type PauseModeState } from '../state/pause-mode';
import type { WeeklyEmailConsent } from '../state/weekly-email-consent';
// Canonical weekly tips live in src/ai/prompts.js, shared with the eval harness.
import { WEEKLY_TIPS as TIPS } from '@/src/ai/prompts';

const LAST_EMAIL_KEY = '@nexus_last_weekly_email';

export interface WeeklyEmailPayload {
  userEmail: string;
  userName: string;
  weekLabel: string;
  habitsCompleted: number;
  habitsMissed: number;
  completionRate: number;  // 0–100
  topStreaks: { habit: string; days: number }[];
  longestStreakDays: number;
  longestStreakHabit: string;
  disciplineScoreAvg: number;
  motivationalTip: string;
  appUrl: string; // deep link
}

/**
 * Check if a weekly summary email should be sent.
 *
 * The server cron (weekly-summary-scheduler) is the primary, reliable path.
 * This client check drives only the in-app BACKSTOP, so it has a catch-up
 * window: it returns true when
 *  - weeklyEmailEnabled is true, AND
 *  - it's the configured day OR later in the same week, AND
 *  - no weekly email has gone out since the most recent configured day, AND
 *  - the 6-day guard passes (never two within ~a week).
 * This removes the old "miss the exact day → miss the whole week" failure:
 * the previous version required today === weeklyEmailDay with no catch-up.
 */
export async function shouldSendWeeklyEmail(opts: {
  weeklyEmailEnabled: boolean;
  weeklyEmailConsent: WeeklyEmailConsent;
  weeklyEmailDay: number;
}): Promise<boolean> {
  if (!opts.weeklyEmailEnabled || opts.weeklyEmailConsent !== 'granted') return false;

  // Most recent occurrence of the configured day (0 = today is that day).
  const now = new Date();
  const daysSinceConfigured = (now.getDay() - opts.weeklyEmailDay + 7) % 7;
  const configuredDay = new Date(now);
  configuredDay.setDate(now.getDate() - daysSinceConfigured);
  configuredDay.setHours(0, 0, 0, 0);

  // Check whether a weekly email already went out this week.
  try {
    const raw = await AsyncStorage.getItem(LAST_EMAIL_KEY);
    if (raw) {
      const lastSentMs = parseInt(raw, 10);
      // Already sent on/after this week's configured day → nothing to catch up.
      if (lastSentMs >= configuredDay.getTime()) return false;
      // 6-day guard (unchanged): never two within ~a week.
      const daysSinceLast = (Date.now() - lastSentMs) / (1000 * 60 * 60 * 24);
      if (daysSinceLast < 6) return false;
    }
  } catch {}

  return true;
}

/**
 * Mark that the email was sent today.
 */
export async function markWeeklyEmailSent(): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_EMAIL_KEY, String(Date.now()));
  } catch {}
}

function getWeeklyTip(): string {
  const weekNum = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));
  return TIPS[weekNum % TIPS.length];
}

/**
 * Build the email payload from app state.
 */
export function buildWeeklyEmailPayload(opts: {
  userEmail: string;
  userName: string;
  habitLog: any[];
  recurringRules: any[];
  habitStreaks: Record<string, number>;
  dailyScores: Record<string, number>;
  // NEX-207: paused days are excluded from the schedule-aware expected/missed
  // tally below. Optional — the SERVER digest path has its own (not-yet
  // pause-aware) copy in supabase/functions/_shared/habit-progress.ts (follow-up).
  pauseMode?: PauseModeState | null;
}): WeeklyEmailPayload {
  const { userEmail, userName, habitLog, recurringRules, habitStreaks, dailyScores, pauseMode } = opts;

  // Calculate week range (last 7 days)
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${today.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  // Count habits completed vs missed over the last 7 days.
  // NEX-207: build LOCAL day-keys (not toISOString/UTC) so they match how scores
  // are keyed AND how pauseMode.since is stored — otherwise the isPausedOn filter
  // (and the dailyScores lookup) is off-by-one in non-UTC timezones.
  const localKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dateKeys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dateKeys.push(localKey(d));
  }

  // Schedule-aware aggregate via shared selector. Per-rule expected
  // and completed (with timesPerDay caps and createdAt clamp), summed
  // across all rules. Replaces the prior "rules × 7" denominator
  // which treated every habit as daily and ignored timesPerDay.
  const periodStart = new Date(weekStart);
  periodStart.setHours(0, 0, 0, 0);
  const periodEnd = new Date(today);
  periodEnd.setHours(23, 59, 59, 999);
  let expected = 0;
  let completed = 0;
  for (const rule of recurringRules) {
    const p = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, habitLog, pauseMode);
    expected += p.expected;
    completed += p.completed;
  }
  const missed = Math.max(0, expected - completed);
  const completionRate = expected > 0 ? Math.round((completed / expected) * 100) : 0;

  // Top streaks
  const topStreaks = Object.entries(habitStreaks)
    .map(([habit, days]) => ({ habit, days: days as number }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3);

  const topStreak = topStreaks[0];

  // Avg discipline score. NEX-207: exclude paused days (a planned break is not a
  // low-scoring day). Empty/all-paused windows fall to 0 here — acceptable for the
  // email body (no shame copy is keyed off it).
  const scores = dateKeys
    .filter(dk => !isPausedOn(dk, pauseMode))
    .map(dk => dailyScores[dk])
    .filter(s => typeof s === 'number') as number[];
  const disciplineScoreAvg = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    userEmail,
    userName,
    weekLabel,
    habitsCompleted: completed,
    habitsMissed: missed,
    completionRate,
    topStreaks,
    longestStreakDays: topStreak?.days ?? 0,
    longestStreakHabit: topStreak?.habit ?? '',
    disciplineScoreAvg,
    motivationalTip: getWeeklyTip(),
    appUrl: 'https://apps.apple.com/app/id6761865566',
  };
}

/**
 * Send the weekly summary email via Supabase Edge Function.
 */
export async function sendWeeklyEmail(payload: WeeklyEmailPayload): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('weekly-summary', {
      body: payload,
    });

    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Full flow: check, build, send.
 * Call on app open with current app state.
 */
export async function checkAndSendWeeklySummary(opts: {
  weeklyEmailEnabled: boolean;
  weeklyEmailConsent: WeeklyEmailConsent;
  weeklyEmailDay: number;
  userEmail: string | null;
  userName: string;
  habitLog: any[];
  recurringRules: any[];
  habitStreaks: Record<string, number>;
  dailyScores: Record<string, number>;
  pauseMode?: PauseModeState | null; // NEX-207: thread through to the payload
}): Promise<void> {
  if (!opts.userEmail) return;

  const should = await shouldSendWeeklyEmail({
    weeklyEmailEnabled: opts.weeklyEmailEnabled,
    weeklyEmailConsent: opts.weeklyEmailConsent,
    weeklyEmailDay: opts.weeklyEmailDay,
  });

  if (!should) return;

  const payload = buildWeeklyEmailPayload({
    userEmail: opts.userEmail,
    userName: opts.userName,
    habitLog: opts.habitLog,
    recurringRules: opts.recurringRules,
    habitStreaks: opts.habitStreaks,
    dailyScores: opts.dailyScores,
    pauseMode: opts.pauseMode, // NEX-207: real send matches the Settings preview
  });

  const result = await sendWeeklyEmail(payload);

  if (result.success) {
    await markWeeklyEmailSent();
    console.log('[WeeklyEmail] Summary sent successfully');
  } else {
    console.warn('[WeeklyEmail] Failed to send:', result.error);
  }
}

// ─── Welcome Email ────────────────────────────────────────────────────────────

const WELCOME_EMAIL_KEY = '@nexus_welcome_email_sent';

/**
 * Call once after activatedDate is first set.
 * Guards with AsyncStorage so it only ever fires one time per install.
 */
export async function sendWelcomeEmailIfNeeded(opts: {
  userEmail: string;
  userName: string;
}): Promise<void> {
  if (!opts.userEmail) return;

  try {
    const alreadySent = await AsyncStorage.getItem(WELCOME_EMAIL_KEY);
    if (alreadySent) return;

    const { data, error } = await supabase.functions.invoke('welcome-email', {
      body: {
        userEmail: opts.userEmail,
        userName: opts.userName || 'friend',
        appUrl: 'https://apps.apple.com/app/id6761865566',
      },
    });

    if (!error && data?.success) {
      await AsyncStorage.setItem(WELCOME_EMAIL_KEY, new Date().toISOString());
      console.log('[WelcomeEmail] Sent successfully');
    } else {
      console.warn('[WelcomeEmail] Failed to send:', error ?? data?.error);
    }
  } catch (err) {
    console.warn('[WelcomeEmail] Unexpected error:', err);
  }
}
