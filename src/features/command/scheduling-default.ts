/**
 * scheduling-default.ts
 *
 * NEX-194 (save-and-surface): a habit created by voice via the Eye must
 * render on Home's "Today's Habits" the SAME day, with zero hunting.
 *
 * Home filters Today's Habits with `isScheduledOn(rule, dow)`
 * (src/state/selectors/today-rollup.ts) — which is FALSE for an empty
 * `daysOfWeek`. So when the parse omits the days, the rule is written but
 * never surfaces today. The user "saved" something and finds nothing.
 *
 * The fix is a TODAY-ONLY default — NOT every-day. Defaulting to every-day
 * would make the habit a missed obligation 6/7 days, dragging the alignment
 * score (home-screen `scoredHabits` + the 7-day Weekly Debrief math) and
 * preventing the per-dateKey streak from ever building, for months. Today-
 * only renders it now and counts it exactly once. It also matches the Apple
 * Calendar empty-days fallback (`app/(tabs)/index.tsx`, `[new Date().getDay()]`).
 *
 * The real cadence is confirmed later via the NEX-195 clarifying question.
 *
 * Pure logic, no React Native / Expo imports — covered by vitest.
 */

/**
 * Resolve the `daysOfWeek` to write for a `recurring_add` action.
 *
 * - Empty or missing → `[todayDow]` (today only, so it surfaces today).
 * - Explicit days → preserved as-is (the parse knew the cadence).
 *
 * @param daysOfWeek the parsed days (0=Sun..6=Sat), possibly empty/undefined
 * @param todayDow   the current day-of-week; defaults to `new Date().getDay()`
 */
export function defaultDaysOfWeek(
  daysOfWeek: number[] | null | undefined,
  todayDow: number = new Date().getDay(),
): number[] {
  if (Array.isArray(daysOfWeek) && daysOfWeek.length > 0) {
    return daysOfWeek;
  }
  return [todayDow];
}

/**
 * The user-facing note appended to a recurring_add confirmation when the
 * cadence was ambiguous and we defaulted to today-only. Surfacing the default
 * (never silent, §1.5 Law A) and how to change it. Exported as one constant so
 * the executor AND the Apple-sync retry-success update (app/(tabs)/index.tsx)
 * speak with one voice and the note survives a retry that rewrites the detail.
 * No em dash / exclamation per §18.1.
 */
export const SCHEDULE_DEFAULTED_NOTE =
  ' Set to today for now. Say the days (like "every day") to change the schedule.';

/** True when an ambiguous (empty/missing) `daysOfWeek` was defaulted. */
export function isScheduleDefaulted(daysOfWeek: number[] | null | undefined): boolean {
  return !(Array.isArray(daysOfWeek) && daysOfWeek.length > 0);
}
