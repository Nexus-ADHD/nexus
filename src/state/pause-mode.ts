/**
 * pause-mode.ts
 *
 * NEX-207 (ADHD pivot P3, L-2) — pure, RN-free helpers for Pause Mode.
 *
 * A *planned* break must never become a lapse. Pause Mode freezes expectations
 * (no score penalty, no streak break, no "return after lapse" framing) and
 * silences nudges. Repair of a streak is earned by returning, never bought.
 *
 * All logic that decides "is this day paused?", "how big is the ACTIVE gap?",
 * "should nudges be silenced?", and "which streak anchors should resume repair"
 * lives here so the date math is testable in the pure-Node vitest suite and the
 * store/UI stay thin. Day-keys are `YYYY-MM-DD` local keys (lexicographically
 * comparable, DST-safe) — never `new Date(iso)` UTC math.
 *
 * §1.5 Law C: nothing here returns or stores a day COUNT of an absence for
 * display. `activeGapDays` is an internal threshold input, never surfaced.
 */

import { getLocalDateKey, normalizeDaysOfWeek } from '../utils/recurrence';
import { addDaysToKey, daysBetweenKeys } from './lead-time-types';
import {
  DEFAULT_STREAK_GRACE_MISSES,
  previousScheduledDateKey,
  type StreakGraceStatus,
} from '../utils/streak-grace';

/** A CLOSED paused interval (inclusive day-keys). */
export interface PauseInterval {
  since: string;
  endedOn: string;
}

export interface PauseModeState {
  /** True while the user is currently paused. */
  active: boolean;
  /** Day-key the CURRENT (open) pause began, or null when not paused. */
  since: string | null;
  /**
   * Optional planned end day-key. Drives ONLY the gentle "still paused?" prompt
   * (B-Q2). It never drives the freeze math — the open interval is [since, today]
   * while active, regardless of plannedUntil.
   */
  plannedUntil: string | null;
  /** CLOSED paused intervals, pruned to the window consumers need. */
  history: PauseInterval[];
}

export const EMPTY_PAUSE_MODE: PauseModeState = {
  active: false,
  since: null,
  plannedUntil: null,
  history: [],
};

/**
 * How many days of closed pause history to keep. Must cover the LONGEST
 * pause-aware review window, not just the debrief/lapse window — Horizon
 * reviews run annual (365d) periods through computeHabitProgress, so a pause
 * pruned too early would let those long reviews count paused days as missed
 * again (Greptile #163). 400 = a year + buffer. Intervals are tiny ({since,
 * endedOn}), so the synced payload stays small even with many pauses.
 */
export const PAUSE_HISTORY_RETENTION_DAYS = 400;

/** Normalize an unknown persisted blob into a valid PauseModeState. */
export function normalizePauseMode(raw: unknown): PauseModeState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PAUSE_MODE };
  const r = raw as Partial<PauseModeState>;
  const history = Array.isArray(r.history)
    ? r.history.filter(
        (iv): iv is PauseInterval =>
          !!iv && typeof iv.since === 'string' && typeof iv.endedOn === 'string',
      )
    : [];
  return {
    // active REQUIRES a since day-key. A malformed { active:true, since:null }
    // would silence nudges and show the Settings Resume action, yet
    // resumePauseMode early-returns on a null `since` → the user could never
    // clear it. Tie the invariant here so it can't arise from persisted/cloud blobs.
    active: r.active === true && typeof r.since === 'string',
    since: typeof r.since === 'string' ? r.since : null,
    plannedUntil: typeof r.plannedUntil === 'string' ? r.plannedUntil : null,
    history,
  };
}

/**
 * Is `dateKey` a paused day? True when it falls in the open interval
 * [since, ∞) while active, or in any closed history interval. Callers pass
 * `dateKey <= today` (snapshot discipline); future days are not asked about.
 */
export function isPausedOn(dateKey: string, pm: PauseModeState | null | undefined): boolean {
  if (!pm || typeof dateKey !== 'string') return false;
  if (pm.active && pm.since && dateKey >= pm.since) return true;
  return (pm.history ?? []).some((iv) => dateKey >= iv.since && dateKey <= iv.endedOn);
}

/**
 * Close an active pause on the day the user resumes (`todayKey`). The resume day
 * is ACTIVE again — you came back — so the closed interval ends the day BEFORE
 * resume (`endedOn = resume − 1`), since `isPausedOn` treats `endedOn` as
 * inclusive. (NEX-279: the previous `endedOn: todayKey` left the resume day
 * flagged paused, which dropped that day's alignment score.)
 *
 * A same-day pause→resume (`since === todayKey`) covers ZERO full days, so it
 * returns `null` — the caller pushes no interval and the day stays fully active.
 * `since` may be a prior day for a multi-day pause: `[since .. resume−1]`.
 */
export function closePauseInterval(
  since: string,
  todayKey: string,
): PauseInterval | null {
  const lastPausedDay = addDaysToKey(todayKey, -1);
  if (lastPausedDay < since) return null; // same-day (or invalid) → no paused days
  return { since, endedOn: lastPausedDay };
}

/** Are recurring nudges currently silenced? (PR C reuses this; takes whole state.) */
export function areNudgesSilenced(input: { pauseMode?: PauseModeState | null } | null | undefined): boolean {
  return !!input?.pauseMode?.active;
}

/** Paused day-keys within [startKey, endKey] inclusive (endKey clamped to today by caller). */
export function pausedDayKeysIn(
  startKey: string,
  endKey: string,
  pm: PauseModeState | null | undefined,
): string[] {
  if (!pm || !startKey || !endKey || startKey > endKey) return [];
  const out: string[] = [];
  // Bound by the ACTUAL window span (not an arbitrary 400) so an arbitrarily
  // long pause is fully counted — else activeGapDays would leave the excess as
  // active missed time and trip the lapse surface (Greptile #163). The +2 slack
  // keeps it a malformed-date guard without truncating a valid range.
  const maxIters = daysBetweenKeys(startKey, endKey) + 2;
  for (let i = 0, cur = startKey; cur <= endKey && i <= maxIters; i += 1, cur = addDaysToKey(cur, 1)) {
    if (isPausedOn(cur, pm)) out.push(cur);
  }
  return out;
}

/**
 * Non-paused day count of the gap between `prevOpenDate` and `now` — the lapse
 * threshold input (§5.4). A 6-day gap with 4 paused days reads as 2, so a planned
 * pause does not trip the unplanned-lapse surface. Returns a plain number used as
 * a threshold; never surfaced as an absence count (Law C).
 */
export function activeGapDays(
  prevOpenDate: string | null | undefined,
  now: Date | string = new Date(),
  pm?: PauseModeState | null,
): number {
  if (!prevOpenDate) return 0;
  const todayKey = typeof now === 'string' ? now : getLocalDateKey(now);
  const total = daysBetweenKeys(prevOpenDate, todayKey);
  if (total <= 0) return 0;
  // Paused days strictly AFTER prevOpenDate, up to and including today.
  const pausedInGap = pausedDayKeysIn(addDaysToKey(prevOpenDate, 1), todayKey, pm).length;
  return Math.max(0, total - pausedInGap);
}

/** Count scheduled (by daysOfWeek) days strictly after `fromKey`, up to `toKey`. */
function scheduledDaysBetween(fromKey: string, toKey: string, daysOfWeek?: number[]): string[] {
  const days = normalizeDaysOfWeek(daysOfWeek);
  const scheduled = days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6];
  const out: string[] = [];
  if (!fromKey || !toKey || fromKey >= toKey) return out;
  // Bound by the actual span (+2 slack) so a long gap isn't truncated.
  const maxIters = daysBetweenKeys(fromKey, toKey) + 2;
  for (let i = 0, cur = addDaysToKey(fromKey, 1); cur <= toKey && i <= maxIters; i += 1, cur = addDaysToKey(cur, 1)) {
    const dow = new Date(`${cur}T00:00:00`).getDay();
    if (scheduled.includes(dow)) out.push(cur);
  }
  return out;
}

export interface RepairHabitInput {
  /** normalized habit key. */
  key: string;
  /** habitStreakUpdatedDate[key] — last completion day-key, or undefined. */
  lastUpdated: string | null | undefined;
  /** the rule's daysOfWeek (undefined = daily). */
  daysOfWeek?: number[];
  /** grace status captured when the pause STARTED (at since - 1). */
  prePauseStatus: StreakGraceStatus | undefined;
}

/**
 * Decide the repaired `habitStreakUpdatedDate` for each habit after a pause ends.
 * Returns ONLY the keys that change.
 *
 * Rules (Codex/plan-reviewer):
 *  - Repair only a run that was ALIVE entering the pause (prePauseStatus
 *    current|held) — never resurrect one that was already `expired`/`empty`
 *    (that would invent progress).
 *  - Repair only when the missed scheduled days in the gap that are NOT paused
 *    are within grace (the run would otherwise have survived) — a run that
 *    legitimately broke on ACTIVE days stays broken.
 *  - Advance the anchor to today's previous scheduled day so the run reads
 *    `current` and the next real log continues it; NEVER move it backward past a
 *    log made DURING the pause.
 *  - Idempotent: re-running with an already-repaired anchor changes nothing.
 */
export function repairStreakAnchors(
  habits: RepairHabitInput[],
  pm: PauseModeState | null | undefined,
  today: Date | string = new Date(),
): Record<string, string> {
  const todayKey = typeof today === 'string' ? today : getLocalDateKey(today);
  const patch: Record<string, string> = {};
  if (!pm) return patch;
  for (const h of habits) {
    if (h.prePauseStatus !== 'current' && h.prePauseStatus !== 'held') continue;
    if (!h.lastUpdated) continue;
    const newAnchor = previousScheduledDateKey(todayKey, h.daysOfWeek, 1);
    // Never move backward (don't stomp a mid-pause log or an already-current run).
    if (h.lastUpdated >= newAnchor) continue;
    // Missed scheduled days in the gap that are NOT paused must be within grace.
    const missedScheduled = scheduledDaysBetween(h.lastUpdated, newAnchor, h.daysOfWeek);
    const activeMissed = missedScheduled.filter((d) => !isPausedOn(d, pm)).length;
    if (activeMissed > DEFAULT_STREAK_GRACE_MISSES) continue; // broke on active days
    patch[h.key] = newAnchor;
  }
  return patch;
}

/** The N most recent calendar day-keys ending at `todayKey` (today first). */
export function lastNDayKeys(todayKey: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n && i < 400; i += 1) out.push(addDaysToKey(todayKey, -i));
  return out;
}

/**
 * Score values for the given day-keys that are PRESENT in history and NOT paused.
 * Use this for every score average / best / worst so a planned break never
 * counts (Law C), and a positional "last N recorded keys" can't reach back past
 * a pause into stale pre-pause days (build the window with lastNDayKeys).
 * Returns [] when the whole window is paused/empty — callers should render a
 * "Paused"/no-data state, never 0.
 */
export function scoresExcludingPaused(
  history: Record<string, number> | null | undefined,
  dayKeys: string[],
  pm: PauseModeState | null | undefined,
): number[] {
  if (!history || !Array.isArray(dayKeys)) return [];
  return dayKeys
    .filter((k) => typeof history[k] === 'number' && !isPausedOn(k, pm))
    .map((k) => history[k]);
}

export type HomeSurfaceMode = 'paused' | 'resume' | 'return' | 'normal';

/**
 * NEX-207 B2: which calm surface should Home show? Precedence (both reviewers):
 *   paused > resume > return > normal.
 * A forward resume MUST beat the lapse surface (Law C: never show "what piled up"
 * after a PLANNED break), and you can't be "returning from a lapse" while actively
 * paused. `showPiledUp` (user opted into the backlog) forces normal. Pure so the
 * precedence is vitest-covered, not buried in the screen.
 */
export function homeSurfaceMode(input: {
  pauseActive?: boolean;
  resumingFromPause?: boolean;
  returningFromLapse?: boolean;
  showPiledUp?: boolean;
}): HomeSurfaceMode {
  // `showPiledUp` is the user opting OUT of the *return* surface specifically.
  // It must not suppress a later paused/resume surface (a return-user who taps
  // "show what piled up" and then starts a Pause must still get the calm Paused
  // surface) — so it gates ONLY the return branch, not pause/resume.
  if (input.pauseActive) return 'paused';
  if (input.resumingFromPause) return 'resume';
  if (input.returningFromLapse && !input.showPiledUp) return 'return';
  return 'normal';
}

/**
 * Is the gentle "still on a break?" line due? Day-key LEXICAL compare (DST-safe,
 * per the module convention) — true on/after the planned return day. Prompt-only:
 * this NEVER changes `active`, resumes, or affects `isPausedOn`/the freeze.
 */
export function isPausePromptDue(todayKey: string, pm: PauseModeState | null | undefined): boolean {
  return !!(pm?.active && pm.plannedUntil && typeof todayKey === 'string' && todayKey >= pm.plannedUntil);
}

/** Prune closed history older than the retention window (relative to today). */
export function prunePauseHistory(
  history: PauseInterval[] | undefined,
  today: Date | string = new Date(),
): PauseInterval[] {
  if (!Array.isArray(history)) return [];
  const todayKey = typeof today === 'string' ? today : getLocalDateKey(today);
  const cutoff = addDaysToKey(todayKey, -PAUSE_HISTORY_RETENTION_DAYS);
  return history.filter((iv) => iv.endedOn >= cutoff);
}
