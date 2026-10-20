// NEX-220 — cumulative achievement badges (de-streak the gamification layer).
// Pure predicates only (no RN / app-state imports) so vitest can cover them.
// The breakable-streak badge unlocks are replaced by these cumulative ones;
// badges stay ADDITIVE — a miss never revokes anything.

import { normalize } from '../utils/text';

/**
 * Rep-count thresholds for the cumulative milestone badges. "Rep" = one habit
 * completion (log entry), counted across a habit's lifetime — a miss subtracts
 * nothing. Replaces the old consecutive-day-streak thresholds.
 */
export const REP_BADGE_THRESHOLDS: Record<string, number> = {
  first_week: 7,
  iron_will: 30,
  centurion: 100,
};

/**
 * All rep-threshold badge ids a habit's lifetime rep count currently earns
 * (every threshold `<= reps`). Returning ALL eligible ids is safe because
 * `unlock()` is idempotent — it also self-heals a badge that's earned but still
 * locked (e.g. an existing user past a threshold from the old streak model). Pure.
 */
export function repBadgeUnlocks(reps: number): string[] {
  return Object.entries(REP_BADGE_THRESHOLDS)
    .filter(([, threshold]) => reps >= threshold)
    .map(([id]) => id);
}

function parseDateKey(key: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * "Back after a pause": this completion follows a real gap — at least one
 * SCHEDULED occurrence was missed since the previous log of this habit. Requires
 * a prior log, so a brand-new habit's first completion is never a comeback. An
 * empty `daysOfWeek` is treated as daily. Pure.
 */
export function isComebackReturn(args: {
  prevLogDateKey: string | null | undefined;
  todayKey: string;
  daysOfWeek?: number[];
}): boolean {
  const { prevLogDateKey, todayKey, daysOfWeek } = args;
  if (!prevLogDateKey) return false; // no prior log → not a comeback
  const prev = parseDateKey(prevLogDateKey);
  const today = parseDateKey(todayKey);
  if (!prev || !today || prev >= today) return false;
  const scheduled =
    Array.isArray(daysOfWeek) && daysOfWeek.length > 0
      ? new Set(daysOfWeek)
      : new Set([0, 1, 2, 3, 4, 5, 6]); // empty = daily
  // A scheduled day strictly between the previous log and today is a missed
  // occurrence (prev was the last log, so nothing was logged on it).
  const cursor = new Date(prev);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor < today) {
    if (scheduled.has(cursor.getDay())) return true;
    cursor.setDate(cursor.getDate() + 1);
  }
  return false;
}

/**
 * Count of distinct LIVE habits with at least one completion in the current
 * week [weekStartKey, todayKey] inclusive — the "Three On The Go" signal
 * (≥3), replacing "maintain 3 streaks at once". dateKeys are YYYY-MM-DD so
 * string comparison is chronological. Pure.
 */
export function tripleThreatCount(
  habitLog: { habitTitle?: string; dateKey?: string }[] | null | undefined,
  liveTitles: string[],
  weekStartKey: string,
  todayKey: string,
): number {
  const live = new Set(liveTitles.map((t) => normalize(t)));
  const active = new Set<string>();
  for (const log of Array.isArray(habitLog) ? habitLog : []) {
    const key = normalize(log?.habitTitle);
    if (!live.has(key)) continue;
    const dk = log?.dateKey;
    if (!dk || dk < weekStartKey || dk > todayKey) continue;
    active.add(key);
  }
  return active.size;
}

export interface PendingBadgeState<B> {
  pendingBadgeUnlock: B | null; // badge currently being toasted
  pendingBadgeUnlockQueue: B[]; // badges waiting their turn
}

/**
 * Fold this transaction's newly-unlocked badges into the in-flight toast state
 * WITHOUT ever clobbering a celebration that hasn't been shown yet. logHabit runs
 * on every completion, so a naive "set head + queue" would wipe a still-pending
 * toast on the next log (e.g. log to cross a threshold, then log again before the
 * toast dismisses). Rules:
 *   - nothing newly unlocked → preserve the current head + queue untouched
 *   - a toast is already showing → append the new badges to the queue
 *   - nothing showing → the first new badge becomes the head, the rest queue
 * Pure.
 */
export function foldPendingBadges<B>(
  current: PendingBadgeState<B>,
  newlyUnlocked: B[],
): PendingBadgeState<B> {
  if (newlyUnlocked.length === 0) return current;
  if (current.pendingBadgeUnlock) {
    return {
      pendingBadgeUnlock: current.pendingBadgeUnlock,
      pendingBadgeUnlockQueue: [...current.pendingBadgeUnlockQueue, ...newlyUnlocked],
    };
  }
  return {
    pendingBadgeUnlock: newlyUnlocked[0],
    pendingBadgeUnlockQueue: newlyUnlocked.slice(1),
  };
}
