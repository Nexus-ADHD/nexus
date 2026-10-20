/**
 * Per-habit trend series — the "stock price" behind each habit ticker in the
 * Horizon review.
 *
 * The alignment score is the index: one number a day, already stored. A habit
 * has no such number, so one is derived here — a habit's price on day D is its
 * **trailing-7-day schedule-aware completion rate**, 0–100:
 *
 *     price(D) = capped completions in [D-6, D] / scheduled occurrences in [D-6, D]
 *
 * Trailing-7 rather than same-day because a same-day series for a M/W/F habit
 * would be a square wave between 0 and 100 that says nothing about direction,
 * and a week is the shortest window in which every cadence this app supports has
 * at least one occurrence.
 *
 * Three rules the series is bound by, each mirroring `habit-rollup.ts` so two
 * surfaces can't disagree about the same habit:
 *   - **Capped completions.** A day counts at most `timesPerDay`, and only logs
 *     on SCHEDULED days count. Off-schedule enthusiasm is not rate credit.
 *   - **A paused day is not a missed day.** Paused days leave the denominator
 *     entirely (§1.5 Law C) — same as `computeHabitProgress`.
 *   - **A habit has no price before its IPO.** Nothing is emitted before
 *     `createdAt`, and days before it never enter a trailing window.
 *
 * A window with zero scheduled occurrences (pause, or the createdAt clamp)
 * emits NOTHING — a gap, never a zero. Zero means "scheduled and not done";
 * writing it where nothing was owed is the shame reading the whole ADHD line
 * exists to avoid.
 *
 * Pure (no RN imports) so every bit of this is covered by the Node vitest suite,
 * exactly like its siblings in this drawer. Output is a plain
 * `Record<dateKey, number>` — the same shape `scoreHistory` has — so it drops
 * straight into `ScoreTrendChart` with no adapter.
 */
import { normalize } from '../../utils/text';
import { addDaysToKey } from '../lead-time-types';
import { isPausedOn, type PauseModeState } from '../pause-mode';
import { MAX_POINTS, type ScoreRangeKey } from '../../components/ui/score-trend-chart-helpers';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days in the trailing window that defines a habit's price. */
export const TREND_WINDOW_DAYS = 7;

interface RuleLike {
  id?: string;
  title?: string;
  daysOfWeek?: number[];
  timesPerDay?: number;
  createdAt?: number;
}

interface LogLike {
  dateKey?: string;
  habitTitle?: string;
}

/** normalized habit title → dateKey → number of logs that day. */
export type HabitLogIndex = Map<string, Map<string, number>>;

/**
 * One pass over the whole habit log, bucketed by normalized title and day.
 *
 * Built ONCE per modal render and shared by every rule's series. The naive shape
 * — each rule filtering the full log itself — is O(rules × logs) on a list that
 * can hold a year of entries, and it runs inside a modal the user is waiting on.
 *
 * `normalize` (emoji-SENSITIVE) is the canonical log↔rule key everywhere in this
 * app; do not swap in `stripEmoji` here, or "Run" and "Run 🏃" collide.
 */
export function buildHabitLogIndex(habitLog: LogLike[] | null | undefined): HabitLogIndex {
  const index: HabitLogIndex = new Map();
  if (!Array.isArray(habitLog)) return index;
  for (const log of habitLog) {
    const dateKey = log?.dateKey;
    if (typeof dateKey !== 'string' || !DAY_KEY_RE.test(dateKey)) continue;
    const key = normalize(log?.habitTitle);
    if (!key) continue;
    let byDay = index.get(key);
    if (!byDay) {
      byDay = new Map();
      index.set(key, byDay);
    }
    byDay.set(dateKey, (byDay.get(dateKey) ?? 0) + 1);
  }
  return index;
}

/**
 * Local day-of-week for a `YYYY-MM-DD` key. Parsed from the key's PARTS at local
 * noon — never `new Date(iso)`, which reads the key as UTC and lands on the
 * previous day (and therefore the previous weekday) in western time zones.
 */
function dayOfWeekForKey(key: string): number {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  return new Date(y, m - 1, d, 12, 0, 0, 0).getDay();
}

/** The local day-key a `createdAt` epoch falls on, or null for the v14 sentinel. */
function createdDayKey(createdAt: unknown): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The habit's daily price series, oldest day first, ending at `endKey`.
 *
 * The series starts at `max(createdAt-day, endKey − (maxDays − 1))`. The second
 * term is not just a performance cap: `createdAt === 0` is the v14 "dawn of
 * time" sentinel, and without the clamp a rule carrying it would walk from 1970.
 *
 * Returns `{}` — never throws — for a missing rule, a malformed `endKey`, or a
 * rule with no scheduled weekdays. Callers render the chart's own sparse state.
 */
export function habitDailySeries(
  rule: RuleLike | null | undefined,
  index: HabitLogIndex | null | undefined,
  pauseMode: PauseModeState | null | undefined,
  endKey: string,
  maxDays: number = MAX_POINTS,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!rule || typeof endKey !== 'string' || !DAY_KEY_RE.test(endKey)) return out;

  const ruleDays = Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek.filter((d) => Number.isInteger(d)) : [];
  if (ruleDays.length === 0) return out; // no schedule → no denominator → no price
  const scheduledDows = new Set(ruleDays);
  const timesPerDay = Math.max(1, Math.floor(rule.timesPerDay ?? 1) || 1);

  const span = Number.isFinite(maxDays) && maxDays > 0 ? Math.floor(maxDays) : MAX_POINTS;
  const born = createdDayKey(rule.createdAt);
  const capStart = addDaysToKey(endKey, -(span - 1));
  const emitStart = born && born > capStart ? born : capStart;
  if (emitStart > endKey) return out; // created after the period under review

  const byDay = index?.get(normalize(rule.title));

  // Scan starts one trailing window EARLIER than the first emitted day, so that
  // day's window is a full week rather than a stub. Days before `born` are still
  // excluded below, so a brand-new habit is not judged on the week before it
  // existed.
  const scanStart = addDaysToKey(emitStart, -(TREND_WINDOW_DAYS - 1));

  const expected: number[] = [];
  const completed: number[] = [];
  const keys: string[] = [];
  for (let cursor = scanStart; cursor <= endKey; cursor = addDaysToKey(cursor, 1)) {
    const scheduled =
      scheduledDows.has(dayOfWeekForKey(cursor)) &&
      (!born || cursor >= born) &&
      !isPausedOn(cursor, pauseMode);
    keys.push(cursor);
    expected.push(scheduled ? timesPerDay : 0);
    completed.push(scheduled ? Math.min(timesPerDay, byDay?.get(cursor) ?? 0) : 0);
    // Defensive: a malformed key would make addDaysToKey a fixed point and spin.
    if (addDaysToKey(cursor, 1) <= cursor) break;
  }

  let expSum = 0;
  let doneSum = 0;
  for (let i = 0; i < keys.length; i += 1) {
    expSum += expected[i];
    doneSum += completed[i];
    const drop = i - TREND_WINDOW_DAYS;
    if (drop >= 0) {
      expSum -= expected[drop];
      doneSum -= completed[drop];
    }
    if (keys[i] < emitStart) continue;
    // Nothing was owed in this window (a pause, or the createdAt clamp). That is
    // a gap in the line, not a day scored zero.
    if (expSum <= 0) continue;
    out[keys[i]] = Math.max(0, Math.min(100, Math.round((doneSum / expSum) * 100)));
  }
  return out;
}

/**
 * The range a review opens on, matched to the period it reviews: a weekly review
 * should not open on a year of history, and an annual one should not open on a
 * week. Unknown cadences fall back to 1M — the chart's own shipped default.
 */
export function defaultRangeForCadence(cadence: string | null | undefined): ScoreRangeKey {
  switch (cadence) {
    case 'weekly': return '1W';
    case 'monthly': return '1M';
    case 'quarterly': return '3M';
    case 'semiannual': return '6M';
    case 'annual': return '1Y';
    default: return '1M';
  }
}
