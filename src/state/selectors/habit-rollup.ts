/**
 * Shared habit-progress derivation. One helper, every consumer.
 *
 * Replaces six independent calcs that drifted on three axes:
 *   - timesPerDay: home Weekly Debrief used unique-day set, dropping
 *     2nd / 3rd logs same day; horizon review and leverage same.
 *   - denominator: leverage and horizon review used calendar days
 *     ("totalDays in period"), so a 3x/week habit capped at ~43%
 *     even if perfect.
 *   - createdAt: nothing clamped the period start, so a habit created
 *     today showed as missed for the prior 6 days.
 *
 * Same module pattern as today-rollup.ts — sibling in this drawer so
 * future-me looking for "where do habit calculations live" finds them
 * together.
 */

import { normalize } from '../../utils/text';
import { getLocalDateKey } from '../../utils/recurrence';
import { isPausedOn, type PauseModeState } from '../pause-mode';

export interface HabitProgress {
  /**
   * Scheduled occurrences in the effective period (= [max(createdAt,
   * periodStart), periodEnd]), multiplied by timesPerDay.
   *
   * Zero when the rule wasn't yet created at periodEnd, or has no
   * scheduled days in the effective period.
   */
  expected: number;
  /**
   * Total log entries inside the period, capped at timesPerDay per
   * scheduled day. Logs on unscheduled days don't contribute (a M/W/F
   * habit logged on Tuesday is ignored — we don't reward off-schedule
   * activity in the schedule-aware %).
   */
  completed: number;
  /**
   * 0–100 when status === 'ready' AND the period had expected occurrences.
   * Null when status === 'new', OR when 'ready' but nothing was expected this
   * period (a degenerate window — e.g. a once-weekly habit whose only weekday
   * is clamped out by createdAt). Consumers must check for null before
   * rendering — never coerce null to 0%.
   */
  pct: number | null;
  /**
   * 'new' ⇔ the habit has zero lifetime completion days (matched by
   * normalized title, bounded to the period end). Once any completion exists
   * — in this period or an earlier one — status is 'ready', even in a window
   * with no expected occurrences (a degenerate once-weekly schedule), in which
   * case `pct` is null. 'ready' never means "done"; it means "known habit, not
   * brand-new".
   */
  status: 'new' | 'ready';
  /**
   * Consecutive *scheduled* days fully completed, walking backward from
   * periodEnd. Days before createdAt do not count as breaking the
   * streak — a brand-new habit can have a fresh streak immediately.
   *
   * This is per-period; the rolling all-time streak in habitStreaks is
   * a separate concept and stays in its own cache.
   */
  streak: number;
}

interface RuleLike {
  id?: string;
  title?: string;
  daysOfWeek?: number[];
  timesPerDay?: number;
  createdAt?: number;
  anchor?: string | null;
}

interface LogLike {
  dateKey?: string;
  habitTitle?: string;
  timestamp?: number;
}

const DAY_MS = 86400000;

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function emptyProgress(): HabitProgress {
  return { expected: 0, completed: 0, pct: null, status: 'new', streak: 0 };
}

export function computeHabitProgress(
  rule: RuleLike | null | undefined,
  period: { start: Date; end: Date },
  habitLog: LogLike[] | null | undefined,
  // NEX-207: when supplied, paused days are dropped from the scheduled-day walk
  // below, so a planned break never counts toward EXPECTED work (a paused day is
  // not a "missed" day in the debrief / weekly email). Optional → callers that
  // don't pass it keep the exact prior behavior.
  pauseMode?: PauseModeState | null,
): HabitProgress {
  if (!rule) return emptyProgress();

  const ruleDays: number[] = Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length
    ? rule.daysOfWeek
    : [];
  const timesPerDay = Math.max(1, rule.timesPerDay ?? 1);
  const ruleKey = normalize(rule.title);

  // Effective start = max(createdAt-day, periodStart). createdAt = 0
  // (sentinel from v14 migration) means no clamp.
  const periodStart = startOfDay(period.start);
  const periodEnd = startOfDay(period.end);
  // NEX-236: local day-key bound for the lifetime "NEW" gate below — a log dated
  // after the period end (e.g. a future-dated entry) must not flip a brand-new
  // habit to "ready". YYYY-MM-DD compares lexicographically.
  const periodEndKey = getLocalDateKey(period.end);
  const createdAtMs = typeof rule.createdAt === 'number' ? rule.createdAt : 0;
  const createdDay = createdAtMs > 0 ? startOfDay(new Date(createdAtMs)) : periodStart;
  const effectiveStart = createdDay > periodStart ? createdDay : periodStart;

  // Lifetime completion days for this rule — matched by normalized title,
  // bounded to the period end (NEX-236) so a future-dated log can't flip a
  // brand-new habit to "ready". This is the SOLE signal for the "new" gate, and
  // it's computed up front so the degenerate early-returns below honor it too.
  const lifetimeCompletionDays = new Set(
    (Array.isArray(habitLog) ? habitLog : [])
      .filter((log) => log?.dateKey && log.dateKey <= periodEndKey && normalize(log?.habitTitle) === ruleKey)
      .map((log) => log!.dateKey),
  ).size;

  // A habit with real completion history is never "new" — even in a period whose
  // schedule produces no expected occurrences (e.g. a once-weekly habit whose only
  // weekday is clamped out by createdAt, or a not-yet-scheduled window). Only a
  // habit with zero lifetime completions falls back to the "new" default. Returns
  // 'ready' with a null pct (nothing was expected, so there is no honest rate).
  const degenerate = (): HabitProgress =>
    lifetimeCompletionDays > 0
      ? { expected: 0, completed: 0, pct: null, status: 'ready', streak: 0 }
      : emptyProgress();

  if (effectiveStart > periodEnd || ruleDays.length === 0) {
    return degenerate();
  }

  // Walk effective period day-by-day; build the set of scheduled date keys.
  // Advance via setDate(getDate() + 1) rather than setTime(+DAY_MS).
  // Local-time midnight is what we want; +DAY_MS shifts time-of-day across
  // DST transitions and silently truncates the final day. A user opening
  // Horizons on March 9 with a period that begins before March 8 (US
  // spring-forward) would otherwise see "today" drop off the scheduled
  // list because the cursor lands at 01:00 PDT > endDay 00:00 PDT.
  const scheduledKeys: string[] = [];
  const cursor = new Date(effectiveStart);
  while (cursor <= periodEnd) {
    if (ruleDays.includes(cursor.getDay())) {
      const key = dateKeyOf(cursor);
      // NEX-207: a paused day is not an expected day — drop it so it can't read
      // as missed and can't break the period streak.
      if (!isPausedOn(key, pauseMode)) scheduledKeys.push(key);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (scheduledKeys.length === 0) {
    return degenerate();
  }

  // Tally logs per scheduled day, capped at timesPerDay. Off-schedule
  // logs are not counted toward expected (we already excluded them) and
  // also not counted toward completed.
  const scheduledSet = new Set(scheduledKeys);
  const perDayCount: Record<string, number> = {};
  for (const log of (Array.isArray(habitLog) ? habitLog : [])) {
    if (!log?.dateKey || !scheduledSet.has(log.dateKey)) continue;
    if (normalize(log.habitTitle) !== ruleKey) continue;
    perDayCount[log.dateKey] = (perDayCount[log.dateKey] ?? 0) + 1;
  }

  let completed = 0;
  for (const key of scheduledKeys) {
    completed += Math.min(timesPerDay, perDayCount[key] ?? 0);
  }
  const expected = scheduledKeys.length * timesPerDay;

  // Period streak — walk backward from the last scheduled day, counting
  // consecutive scheduled days where perDay >= timesPerDay. Stops at the
  // first incomplete scheduled day. Days before createdAt don't appear
  // in scheduledKeys at all, so they can't break the streak.
  let streak = 0;
  for (let i = scheduledKeys.length - 1; i >= 0; i -= 1) {
    const key = scheduledKeys[i];
    if ((perDayCount[key] ?? 0) >= timesPerDay) {
      streak += 1;
    } else {
      break;
    }
  }

  // NEX-82: NEW fires ONLY when the habit has zero lifetime completion days
  // (computed above). Once any completion exists — in this period or any earlier
  // one — NEW goes away and the rate/streak takes over. A zero lifetime count
  // implies streak === 0, so the streak term would be redundant here.
  if (lifetimeCompletionDays === 0) {
    return { expected, completed, pct: null, status: 'new', streak };
  }
  const pct = expected > 0 ? Math.round((completed / expected) * 100) : 0;
  return { expected, completed, pct, status: 'ready', streak };
}

// ───────────────────────────────────────────────────────────────────────
// Phase 0 — scoring redesign selectors. New metrics live alongside the
// existing computeHabitProgress. UI consumers don't read these yet
// (Phase 1+); they exist now so the data layer is ready.
// ───────────────────────────────────────────────────────────────────────

/**
 * Recovery state machine. Independent of the strength number — a habit
 * with strength=85 can still be 'at-risk' if today's scheduled occurrence
 * was missed. The state answers "what should I do next?", not "how am I
 * doing on average?".
 */
export type HabitStatus =
  | 'started'      // <7 scheduled occurrences ever — too soon to score
  | 'steady'       // no recent lapses
  | 'recovering'   // recent lapse but logged at least once since
  | 'at-risk'      // recent lapse, no completion since
  | 'faded';       // strength <40 with multi-day lapse pattern

export type HabitBand = 'strong' | 'building' | 'wobbling' | 'faded';

export interface HabitStrength {
  /**
   * 0–100 recency-weighted completion rate over the last 30 scheduled
   * days. Null when status === 'started' (insufficient history for an
   * honest number).
   */
  strength: number | null;
  status: HabitStatus;
  /** Null when status === 'started'. */
  band: HabitBand | null;
}

const STRENGTH_HALF_LIFE_DAYS = 14;
const STRENGTH_WINDOW_DAYS = 30;
const STARTED_THRESHOLD = 7;          // scheduled occurrences ever
const RECENT_LAPSE_WINDOW = 3;        // last N scheduled days for at-risk / recovering
const FADED_LAPSE_WINDOW = 5;         // last N scheduled days for faded test
const FADED_LAPSE_THRESHOLD = 2;      // ≥ this many lapses in FADED_LAPSE_WINDOW

function bandOf(strength: number): HabitBand {
  if (strength >= 80) return 'strong';
  if (strength >= 60) return 'building';
  if (strength >= 40) return 'wobbling';
  return 'faded';
}

/**
 * Walk every scheduled day from createdAt (or 30 days ago, whichever is
 * later for the strength window — but createdAt clamps at the lower
 * bound for the STARTED gate) up through `now`, returning each day's
 * key plus how many logs landed on it.
 *
 * Used by both computeHabitStrength and the recovery-state evaluation.
 */
function scheduledDaysWithLogs(
  rule: RuleLike,
  habitLog: LogLike[],
  start: Date,
  end: Date,
): Array<{ dateKey: string; daysAgo: number; completed: boolean }> {
  const ruleDays = Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek : [];
  const timesPerDay = Math.max(1, rule.timesPerDay ?? 1);
  const ruleKey = String(rule.title ?? '').toLowerCase();
  const startDay = startOfDay(start);
  const endDay = startOfDay(end);
  const endTime = endDay.getTime();

  const perDayCount: Record<string, number> = {};
  for (const log of habitLog) {
    if (!log?.dateKey) continue;
    if (String(log.habitTitle ?? '').toLowerCase() !== ruleKey) continue;
    perDayCount[log.dateKey] = (perDayCount[log.dateKey] ?? 0) + 1;
  }

  const out: Array<{ dateKey: string; daysAgo: number; completed: boolean }> = [];
  const cursor = new Date(startDay);
  while (cursor <= endDay) {
    if (ruleDays.includes(cursor.getDay())) {
      const dk = dateKeyOf(cursor);
      const daysAgo = Math.round((endTime - cursor.getTime()) / DAY_MS);
      out.push({
        dateKey: dk,
        daysAgo,
        completed: (perDayCount[dk] ?? 0) >= timesPerDay,
      });
    }
    // Advance via setDate(getDate() + 1) rather than setTime(+DAY_MS).
    // Local-time midnight is what we want; +DAY_MS shifts time-of-day
    // across DST transitions and silently truncates the final day.
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Recency-weighted completion rate over the last 30 scheduled days,
 * plus a recovery-state classification.
 *
 * weight(d) = exp(-d / 14)   // half-life ~10 days
 * S = Σ completed * weight(daysAgo) over scheduled days in last 30
 * W = Σ weight(daysAgo) over scheduled days in last 30
 * strength = round((S / W) * 100)
 *
 * Status precedence: started → faded → at-risk → recovering → steady.
 *
 * @param rule       The recurring rule.
 * @param habitLog   All habit log entries (filtering happens internally).
 * @param now        The reference "today" instant. Pass an explicit
 *                   value rather than calling Date.now() inside so this
 *                   stays a pure function — critical for unit tests and
 *                   for matching the rest of habit-rollup's contract.
 */
export function computeHabitStrength(
  rule: RuleLike | null | undefined,
  habitLog: LogLike[] | null | undefined,
  now: Date,
): HabitStrength {
  if (!rule || !Array.isArray(rule.daysOfWeek) || rule.daysOfWeek.length === 0) {
    return { strength: null, status: 'started', band: null };
  }
  const logs = Array.isArray(habitLog) ? habitLog : [];

  // STARTED gate: count *all* scheduled days from createdAt to now.
  const createdAtMs = typeof rule.createdAt === 'number' ? rule.createdAt : 0;
  const historyStart = createdAtMs > 0 ? new Date(createdAtMs) : new Date(0);
  const allScheduled = scheduledDaysWithLogs(rule, logs, historyStart, now);
  if (allScheduled.length < STARTED_THRESHOLD) {
    return { strength: null, status: 'started', band: null };
  }

  // Strength: same walk but clamped to the 30-day window.
  const windowStart = new Date(now.getTime() - STRENGTH_WINDOW_DAYS * DAY_MS);
  const windowed = scheduledDaysWithLogs(rule, logs, windowStart, now);

  let s = 0;
  let w = 0;
  for (const d of windowed) {
    const weight = Math.exp(-d.daysAgo / STRENGTH_HALF_LIFE_DAYS);
    w += weight;
    if (d.completed) s += weight;
  }
  // No scheduled days in the 30-day window even though history has ≥7
  // (e.g. a M/W/F habit in a freak schedule edit). Fall back to a
  // history-wide rate so we don't divide by zero or report 'started'
  // contradictorily.
  let strength: number;
  if (w === 0) {
    const completedInHistory = allScheduled.filter((d) => d.completed).length;
    strength = Math.round((completedInHistory / allScheduled.length) * 100);
  } else {
    strength = Math.round((s / w) * 100);
  }

  // Recovery state. Walk the most-recent N scheduled days in reverse
  // (so index 0 is the most recent scheduled day overall).
  const recent = [...allScheduled].reverse();
  const lastN = (n: number) => recent.slice(0, n);
  const last3 = lastN(RECENT_LAPSE_WINDOW);
  const last5 = lastN(FADED_LAPSE_WINDOW);

  const lapsedInLast3 = last3.some((d) => !d.completed);
  const lapsesInLast5 = last5.filter((d) => !d.completed).length;

  // 'faded' takes precedence over 'at-risk' / 'recovering': a habit
  // with strength <40 and a multi-day lapse pattern is faded regardless
  // of whether the most recent log was a recovery attempt.
  if (strength < 40 && lapsesInLast5 >= FADED_LAPSE_THRESHOLD) {
    return { strength, status: 'faded', band: bandOf(strength) };
  }

  if (lapsedInLast3) {
    // Find the most recent lapse in last3 (lowest index) and check
    // whether any completion occurred *after* that scheduled day.
    const firstLapseIdx = last3.findIndex((d) => !d.completed);
    const lapseDateKey = last3[firstLapseIdx].dateKey;
    const completionsSinceLapse = last3
      .slice(0, firstLapseIdx)
      .some((d) => d.completed);
    if (completionsSinceLapse) {
      return { strength, status: 'recovering', band: bandOf(strength) };
    }
    return { strength, status: 'at-risk', band: bandOf(strength) };
    // (lapseDateKey is intentionally unused here — kept as a local for
    // future "X days since lapse" UI surfacing.)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void lapseDateKey;
  }

  return { strength, status: 'steady', band: bandOf(strength) };
}

/**
 * Anchor adherence — the variance of completion timestamps in hours.
 * Anchored habits should fire at consistent times of day; high
 * variance means the cue isn't holding.
 *
 * Sample: up to 14 most recent log entries for this rule. If fewer
 * than 5 logs exist, returns drift: false regardless — too few data
 * points to make a claim.
 *
 * Threshold: σ > 2 hours = drift.
 */
export interface AnchorAdherence {
  /** Standard deviation of completion hour-of-day across the sample. */
  variance: number;
  /** True only when sampleSize >= 5 AND variance > 2.0. */
  drift: boolean;
  /** Number of logs used. Capped at 14 most recent. */
  sampleSize: number;
}

const ANCHOR_SAMPLE_CAP = 14;
const ANCHOR_MIN_SAMPLE = 5;
const ANCHOR_DRIFT_THRESHOLD_HOURS = 2.0;

export function computeAnchorAdherence(
  rule: RuleLike | null | undefined,
  habitLog: LogLike[] | null | undefined,
): AnchorAdherence {
  if (!rule) return { variance: 0, drift: false, sampleSize: 0 };
  const ruleKey = String(rule.title ?? '').toLowerCase();
  const logs = Array.isArray(habitLog) ? habitLog : [];

  // Filter to this rule's logs that have a usable timestamp, sort by
  // timestamp descending, take the most-recent ANCHOR_SAMPLE_CAP.
  const matched = logs
    .filter((l): l is Required<Pick<LogLike, 'timestamp'>> & LogLike =>
      String(l.habitTitle ?? '').toLowerCase() === ruleKey &&
      typeof l.timestamp === 'number' &&
      Number.isFinite(l.timestamp)
    )
    .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
    .slice(0, ANCHOR_SAMPLE_CAP);

  const sampleSize = matched.length;
  if (sampleSize === 0) return { variance: 0, drift: false, sampleSize: 0 };

  // Convert each timestamp to fractional hour-of-day (0–24). Use local
  // time — the user's anchor is "after morning coffee," not UTC.
  const hours = matched.map((l) => {
    const d = new Date(l.timestamp);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  });

  const mean = hours.reduce((a, b) => a + b, 0) / hours.length;
  const sumSq = hours.reduce((acc, h) => acc + (h - mean) * (h - mean), 0);
  // Population variance, then std dev. We're describing the sample
  // we have, not estimating a population, so n (not n-1).
  const variance = Math.sqrt(sumSq / hours.length);

  if (sampleSize < ANCHOR_MIN_SAMPLE) {
    return { variance, drift: false, sampleSize };
  }
  return {
    variance,
    drift: variance > ANCHOR_DRIFT_THRESHOLD_HOURS,
    sampleSize,
  };
}

// ───────────────────────────────────────────────────────────────────────
// NEX-190 De-streak — cumulative progress that a miss cannot erase. These
// replace the breakable consecutive-day streak on the default surface
// (CLAUDE.md Law B). Reps only ever go up; milestones key off them.
// ───────────────────────────────────────────────────────────────────────

/**
 * Lifetime completion count — total log entries for this rule (by normalized
 * title). Cumulative and non-resetting: a miss subtracts nothing. Pure.
 */
export function computeLifetimeReps(
  rule: RuleLike | null | undefined,
  habitLog: LogLike[] | null | undefined,
): number {
  if (!rule) return 0;
  const ruleKey = normalize(rule.title);
  return (Array.isArray(habitLog) ? habitLog : []).filter(
    (l) => normalize(l?.habitTitle) === ruleKey,
  ).length;
}

/**
 * Capped completions across all SCHEDULED days in the period, REGARDLESS of pause —
 * the additive numerator for the Home weekly chip ("N× this wk" / "N of T"). NEX §1.5
 * Law B: a completion logged on a paused day is still an earned rep and must never be
 * subtracted from a cumulative count. This is the ONE place pause is intentionally
 * ignored for a schedule-aware completion tally.
 *
 * Mirrors computeHabitProgress's `completed` math EXACTLY (effectiveStart =
 * max(createdAt-day, periodStart), local-day cursor walk, per-day cap at timesPerDay,
 * normalize(title) match, off-schedule logs excluded) — but omits the isPausedOn()
 * filter and takes no pauseMode arg. KEEP IN SYNC with computeHabitProgress: any change
 * to the schedule filter / normalize key / per-day cap / createdAt clamp there must land
 * here too (the cost of the separate selector seam).
 *
 * DO NOT use on percentage / debrief / horizon / weekly-email surfaces — those MUST keep
 * excluding paused days from the denominator (use computeHabitProgress). Unlike
 * computeLifetimeReps (which counts EVERY log), this is schedule-aware: a completion on a
 * paused but OFF-schedule day is ignored, so the numerator stays consistent with the
 * chip's cadencePerWeek (= daysOfWeek.length × timesPerDay) denominator. Pure.
 *
 * Returns 0 for a null rule, empty daysOfWeek, or a period that starts after it ends.
 */
export function computeWeeklyReps(
  rule: RuleLike | null | undefined,
  period: { start: Date; end: Date },
  habitLog: LogLike[] | null | undefined,
): number {
  if (!rule) return 0;

  const ruleDays: number[] = Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length
    ? rule.daysOfWeek
    : [];
  if (ruleDays.length === 0) return 0;
  const timesPerDay = Math.max(1, rule.timesPerDay ?? 1);
  const ruleKey = normalize(rule.title);

  const periodStart = startOfDay(period.start);
  const periodEnd = startOfDay(period.end);
  const createdAtMs = typeof rule.createdAt === 'number' ? rule.createdAt : 0;
  const createdDay = createdAtMs > 0 ? startOfDay(new Date(createdAtMs)) : periodStart;
  const effectiveStart = createdDay > periodStart ? createdDay : periodStart;

  if (effectiveStart > periodEnd) return 0;

  // Walk the effective period day-by-day, collecting scheduled date keys. Advance via
  // setDate(getDate()+1) (local midnight, DST-safe) — same cursor discipline as
  // computeHabitProgress. NO isPausedOn() filter: a paused scheduled day still counts.
  const scheduledKeys: string[] = [];
  const cursor = new Date(effectiveStart);
  while (cursor <= periodEnd) {
    if (ruleDays.includes(cursor.getDay())) {
      scheduledKeys.push(dateKeyOf(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (scheduledKeys.length === 0) return 0;

  // Tally logs per scheduled day, capped at timesPerDay. Off-schedule logs don't count.
  const scheduledSet = new Set(scheduledKeys);
  const perDayCount: Record<string, number> = {};
  for (const log of (Array.isArray(habitLog) ? habitLog : [])) {
    if (!log?.dateKey || !scheduledSet.has(log.dateKey)) continue;
    if (normalize(log.habitTitle) !== ruleKey) continue;
    perDayCount[log.dateKey] = (perDayCount[log.dateKey] ?? 0) + 1;
  }

  let completed = 0;
  for (const key of scheduledKeys) {
    completed += Math.min(timesPerDay, perDayCount[key] ?? 0);
  }
  return completed;
}

/**
 * Single-pass weekly + lifetime reps for a SET of rules — the Home habit-row
 * chip rollup. Results are identical to calling computeWeeklyReps(rule, period,
 * habitLog) AND computeLifetimeReps(rule, habitLog) per rule, but the
 * unbounded, append-only habitLog is traversed ONCE instead of twice per rule
 * (was O(rules × 2 × habitLog) on every Home memo recompute).
 *
 * The per-rule weekly math mirrors computeWeeklyReps EXACTLY (createdAt clamp,
 * local-day cursor walk, scheduledSet membership, per-day timesPerDay cap,
 * normalize(title) match, no pause filter) and the lifetime math mirrors
 * computeLifetimeReps EXACTLY (every title-matching log counts, dateKey
 * irrelevant). Rules sharing a normalized title each tally the same logs, just
 * as two independent per-rule calls would. KEEP IN SYNC with both selectors.
 *
 * Returns an array aligned with the input order: index i describes rules[i].
 * Null/undefined rules yield { weeklyReps: 0, lifetimeReps: 0 }, matching the
 * per-rule selectors' null-rule behavior. Pure.
 */
export function computeRowRollups(
  rules: readonly (RuleLike | null | undefined)[] | null | undefined,
  period: { start: Date; end: Date },
  habitLog: LogLike[] | null | undefined,
): { weeklyReps: number; lifetimeReps: number }[] {
  const list = Array.isArray(rules) ? rules : [];
  const logs = Array.isArray(habitLog) ? habitLog : [];

  // Per-rule statics — same derivation as computeWeeklyReps.
  const periodStart = startOfDay(period.start);
  const periodEnd = startOfDay(period.end);
  const statics = list.map((rule) => {
    if (!rule) return null;
    const ruleDays: number[] = Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length
      ? rule.daysOfWeek
      : [];
    const timesPerDay = Math.max(1, rule.timesPerDay ?? 1);
    const ruleKey = normalize(rule.title);
    const createdAtMs = typeof rule.createdAt === 'number' ? rule.createdAt : 0;
    const createdDay = createdAtMs > 0 ? startOfDay(new Date(createdAtMs)) : periodStart;
    const effectiveStart = createdDay > periodStart ? createdDay : periodStart;
    const scheduledKeys: string[] = [];
    if (ruleDays.length > 0 && effectiveStart <= periodEnd) {
      const cursor = new Date(effectiveStart);
      while (cursor <= periodEnd) {
        if (ruleDays.includes(cursor.getDay())) {
          scheduledKeys.push(dateKeyOf(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return { ruleKey, timesPerDay, scheduledKeys, scheduledSet: new Set(scheduledKeys) };
  });

  // Group rule indexes by normalized title so rules sharing a title each tally
  // the same logs (identical to independent per-rule scans).
  const byKey = new Map<string, number[]>();
  statics.forEach((st, i) => {
    if (!st) return;
    const group = byKey.get(st.ruleKey);
    if (group) group.push(i);
    else byKey.set(st.ruleKey, [i]);
  });

  // ONE traversal: lifetime reps for every same-titled rule, plus
  // per-scheduled-day counts when the log's day is in that rule's window.
  const lifetimeReps = new Array<number>(list.length).fill(0);
  const perDay: Record<string, number>[] = list.map(() => ({}));
  for (const log of logs) {
    const idxs = byKey.get(normalize(log?.habitTitle));
    if (!idxs) continue;
    for (const i of idxs) {
      lifetimeReps[i] += 1;
      const dk = log?.dateKey;
      if (dk && statics[i]!.scheduledSet.has(dk)) {
        perDay[i][dk] = (perDay[i][dk] ?? 0) + 1;
      }
    }
  }

  return list.map((rule, i) => {
    const st = statics[i];
    if (!rule || !st) return { weeklyReps: 0, lifetimeReps: 0 };
    let weeklyReps = 0;
    for (const key of st.scheduledKeys) {
      weeklyReps += Math.min(st.timesPerDay, perDay[i][key] ?? 0);
    }
    return { weeklyReps, lifetimeReps: lifetimeReps[i] };
  });
}

/**
 * The single habit with the most lifetime reps among the passed (already-filtered,
 * active) rules — the de-streaked "top habit" headline for the native widget + watch
 * (NEX-219, replacing "longest streak"). Total order: reps desc, then normalized
 * title asc, then id asc, so the pick is stable and never array-order-dependent.
 * Returns null when no rule has ≥1 rep (caller shows an empty state, not "0 reps").
 * Returns the RAW title for display (compares on the normalized key). Pure.
 */
export function topHabitByReps(
  rules: RuleLike[] | null | undefined,
  habitLog: LogLike[] | null | undefined,
): { title: string; reps: number } | null {
  let best: { title: string; reps: number; key: string; id: string } | null = null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const reps = computeLifetimeReps(rule, habitLog);
    if (reps < 1) continue;
    const key = normalize(rule?.title);
    const id = String(rule?.id ?? '');
    const wins =
      !best ||
      reps > best.reps ||
      (reps === best.reps && (key < best.key || (key === best.key && id < best.id)));
    if (wins) best = { title: String(rule?.title ?? ''), reps, key, id };
  }
  return best ? { title: best.title, reps: best.reps } : null;
}

/**
 * The positive-only milestone ceremony thresholds (CLAUDE.md §10.14 amendment:
 * a milestone is a *cumulative* achievement / Nth completion, NOT a
 * consecutive-day chain). 7 / 30 / 66 / 365 now count lifetime reps.
 */
export const REP_MILESTONES = [7, 30, 66, 365] as const;

/**
 * Returns the milestone this completion just crossed, or null. Because logHabit
 * adds exactly one rep, `newReps === threshold` fires the ceremony exactly once
 * at the crossing — an existing user already past a threshold never re-fires,
 * and (reps being monotonic) a miss can never un-fire a milestone. Pure.
 */
export function crossedRepMilestone(newReps: number): number | null {
  return (REP_MILESTONES as readonly number[]).includes(newReps) ? newReps : null;
}

/**
 * The cumulative chip label for the default `HabitRow` surface. Flexible-frequency
 * "N× this wk", or partial credit "N of T" for a few-times-a-week cadence. Never a
 * breakable count. Returns undefined for a truly-new habit (nothing logged ever) so
 * the row shows no chip rather than a deflating "0×". Pure.
 *
 * The "N of T" vs "N× this wk" split keys on the rule's INTRINSIC weekly cadence
 * (scheduled days × timesPerDay), NOT on days-elapsed-this-week — otherwise a daily
 * habit would show a denominator that grows through the week ("3 of 4" on Wed) and
 * flip format late-week. The denominator is stable; only the numerator climbs.
 *
 * @param weeklyCompleted  completions so far this week (capped, schedule-aware)
 * @param cadencePerWeek   intrinsic weekly target = daysOfWeek.length × timesPerDay
 * @param lifetimeReps     total completions ever (drives the new-habit suppression)
 */
export function weeklyProgressLabel(
  weeklyCompleted: number,
  cadencePerWeek: number,
  lifetimeReps: number,
): string | undefined {
  if (lifetimeReps === 0 && weeklyCompleted === 0) return undefined; // truly new → no chip
  // A small finite cadence (e.g. 3×/week) reads best as partial credit; a daily-ish
  // habit reads better as an open-ended weekly count.
  if (cadencePerWeek > 0 && cadencePerWeek <= 5) return `${weeklyCompleted} of ${cadencePerWeek}`;
  return `${weeklyCompleted}× this wk`;
}
