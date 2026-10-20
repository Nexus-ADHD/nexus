/**
 * Server-side weekly digest builder — port of `buildWeeklyEmailPayload` from
 * `src/services/weekly-email.ts`, reusing the ported `computeHabitProgress` so
 * completion %, streaks, and avg score match what the app shows.
 *
 * TIMEZONE (documented decision): all date math is in America/New_York (ET),
 * matching `email-scheduler`'s 9am-ET cadence. ET wall-clock dates are built
 * via `Date.UTC(...)`; because the Supabase Edge (Deno) runtime is UTC, the
 * local Date methods inside `computeHabitProgress` resolve to ET wall-clock.
 * habitLog and daily-score keys are device-local 'YYYY-MM-DD'; this matches
 * exactly for ET users and is at most an edge-of-day skew for other zones —
 * acceptable and intentional per the brief. (Daily scores are read from
 * `scoreHistory`, the field recordDailyScore() actually writes; the legacy
 * `dailyScores` field ships empty and is only used if non-empty — see below.)
 */

import { computeHabitProgress } from './habit-progress.ts';
import type { WeeklySummaryPayload } from './weekly-summary-email.ts';
import { weeklyEmailConsentAllowsDelivery } from './weekly-email-consent.ts';

const APP_URL = 'https://apps.apple.com/app/id6761865566';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Verbatim from canonical WEEKLY_TIPS (src/ai/prompts.js). Inlined because the
// Deno edge bundle can't import RN-coupled app source. Keep in sync if tips
// change (low churn — they rotate, they don't get edited).
const WEEKLY_TIPS = [
  "Discipline is not about perfection. It is about consistency. One missed day doesn't break a system.",
  "The work is done on ordinary days. There is no other kind.",
  "Every habit you track is a vote for the identity you're building.",
  "Set the day's intention before the noise begins. What you choose first is what holds.",
  "Streaks are a byproduct of commitment, not the goal. Fall in love with the process.",
  "Small things done daily outlast large things done once.",
  "Your mandates are your compass. When in doubt, check: does this serve my north star?",
];

function getWeeklyTip(now: Date): string {
  const weekNum = Math.floor(now.getTime() / (1000 * 60 * 60 * 24 * 7));
  return WEEKLY_TIPS[weekNum % WEEKLY_TIPS.length];
}

/** ET calendar parts for an instant, via Intl (DST-correct). */
export function etParts(now: Date): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Day-of-week of that calendar date (TZ-independent once y/m/d are known).
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  return { year, month, day, weekday };
}

/** ET "today" anchored as a UTC date so local Date methods read ET wall-clock. */
function etTodayDate(now: Date): Date {
  const { year, month, day } = etParts(now);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKeyUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** ISO-8601 week key, e.g. "2026-W22", from the ET calendar date of `now`. */
export function isoWeekKey(now: Date): string {
  const { year, month, day } = etParts(now);
  const dt = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (dt.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3); // shift to the Thursday of this week
  const isoYear = dt.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((dt.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** ET day-of-week for `now`: 0=Sun..6=Sat (matches state.weeklyEmailDay). */
export function etWeekday(now: Date): number {
  return etParts(now).weekday;
}

/**
 * True when the user wants a weekly email today. Requires both the enabled
 * preference and an explicit granted-consent marker; legacy/missing consent
 * fails closed. `force` bypasses only the day-of-week gate for dry-run testing.
 */
export function weeklyEmailDueToday(stateData: any, now: Date, force = false): boolean {
  if (!weeklyEmailConsentAllowsDelivery(stateData)) return false;
  if (force) return true;
  const day = typeof stateData.weeklyEmailDay === 'number' ? stateData.weeklyEmailDay : 0;
  return etWeekday(now) === day;
}

/**
 * Build the weekly digest payload from a user's persisted app state. Returns
 * null if there's no email or no recurring rules to report on.
 */
export function buildWeeklyDigestPayload(opts: {
  stateData: any;
  email: string;
  name: string | null;
  now: Date;
}): WeeklySummaryPayload | null {
  const { stateData, email, name, now } = opts;
  if (!email) return null;

  const recurringRules: any[] = Array.isArray(stateData?.recurringRules) ? stateData.recurringRules : [];
  // No habits to report on → no email (matches this function's contract above).
  // Without this, a user with weeklyEmailEnabled:true but zero habits gets a
  // hollow "0% completion, 0 habits" digest.
  if (recurringRules.length === 0) return null;
  const habitLog: any[] = Array.isArray(stateData?.habitLog) ? stateData.habitLog : [];
  const habitStreaks: Record<string, number> = (stateData?.habitStreaks && typeof stateData.habitStreaks === 'object')
    ? stateData.habitStreaks : {};
  // Daily alignment scores: the app's recordDailyScore() writes to `scoreHistory`
  // (keyed local YYYY-MM-DD); `dailyScores` is a separate field that ships as an
  // empty {}. Prefer whichever actually has data — checking `dailyScores` first
  // by mere presence would let the empty {} shadow scoreHistory and force every
  // user's average to 0.
  const dailyScores: Record<string, number> =
    (stateData?.dailyScores && typeof stateData.dailyScores === 'object' && Object.keys(stateData.dailyScores).length > 0)
      ? stateData.dailyScores
      : (stateData?.scoreHistory && typeof stateData.scoreHistory === 'object' ? stateData.scoreHistory : {});

  // 7-day window [today-6 .. today], ET wall-clock anchored as UTC.
  const today = etTodayDate(now);
  const weekStart = new Date(today);
  weekStart.setUTCDate(today.getUTCDate() - 6);

  const weekLabel = `${MONTHS_SHORT[weekStart.getUTCMonth()]} ${weekStart.getUTCDate()} – ${MONTHS_SHORT[today.getUTCMonth()]} ${today.getUTCDate()}`;

  // Schedule-aware aggregate (same as the app's Weekly Debrief).
  let expected = 0;
  let completed = 0;
  for (const rule of recurringRules) {
    const p = computeHabitProgress(rule, { start: weekStart, end: today }, habitLog);
    expected += p.expected;
    completed += p.completed;
  }
  const missed = Math.max(0, expected - completed);
  const completionRate = expected > 0 ? Math.round((completed / expected) * 100) : 0;

  // Top streaks from the rolling all-time streak cache.
  const topStreaks = Object.entries(habitStreaks)
    .map(([habit, days]) => ({ habit, days: Number(days) || 0 }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3);
  const topStreak = topStreaks[0];

  // Avg discipline score over the last 7 ET days.
  const scores: number[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const v = dailyScores[dateKeyUTC(d)];
    if (typeof v === 'number') scores.push(v);
  }
  const disciplineScoreAvg = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    userEmail: email,
    userName: name || 'there',
    weekLabel,
    habitsCompleted: completed,
    habitsMissed: missed,
    completionRate,
    topStreaks,
    longestStreakDays: topStreak?.days ?? 0,
    longestStreakHabit: topStreak?.habit ?? '',
    disciplineScoreAvg,
    motivationalTip: getWeeklyTip(now),
    appUrl: APP_URL,
  };
}
