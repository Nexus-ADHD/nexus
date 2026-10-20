/**
 * NEX-217 — additive, forward-shaped "this week" summary for the de-shamed
 * weekly-review surface. Every figure here is CUMULATIVE / additive: a missed
 * day subtracts nothing, and there is no rate, denominator, or per-day score
 * (those read as a "you failed this week" verdict — CLAUDE.md Law B/C). This is
 * the shared SSOT for the Home "THIS WEEK" card; keep it pure (no RN imports) so
 * vitest covers it directly.
 *
 * Window note: callers pass an explicit calendar-week range (this Sunday →
 * today). The Home `weeklyStats` used a ROLLING 7-day window, which is fine for
 * a per-day chart but misleading under an additive "this week" label (a rep from
 * last Thursday would count on Tuesday). The range is the caller's contract.
 */

import { normalize } from '../../utils/text';

export interface WeeklyAdditiveSummary {
  /** Total completions logged in range. Additive — every rep counts, none subtract. */
  reps: number;
  /** Distinct active habits with ≥1 completion in range (rule-anchored, normalize-matched). */
  habitsHeld: number;
  /** Non-empty weekly wins (the forward intention). */
  wins: number;
}

interface RuleLike {
  title?: string;
  archived?: boolean;
  excludedFromScore?: boolean;
}

interface LogLike {
  habitTitle?: string;
  dateKey?: string;
}

/**
 * Inclusive "YYYY-MM-DD" range. Lexicographic compare is correct for ISO date
 * keys, so no Date parsing (and no DST/timezone hazard) is needed here.
 */
export interface WeekRange {
  startKey: string;
  endKey: string;
}

export function weeklyAdditiveSummary(params: {
  habitLog: LogLike[] | null | undefined;
  rules: RuleLike[] | null | undefined;
  weeklyWins: string[] | null | undefined;
  range: WeekRange;
}): WeeklyAdditiveSummary {
  const { habitLog, rules, weeklyWins, range } = params;

  const inRange = (k: unknown): k is string =>
    typeof k === 'string' && k >= range.startKey && k <= range.endKey;

  const logsInRange = (Array.isArray(habitLog) ? habitLog : []).filter((l) => inRange(l?.dateKey));

  // reps = every completion in range. Orphaned logs (no matching active rule)
  // still count — a rep is a rep — but they don't contribute to habitsHeld.
  const reps = logsInRange.length;

  // Match on normalize() — the SAME emoji-sensitive key the app's canonical
  // matcher (computeLifetimeReps, the home habit row, the widget/watch) uses, so
  // habitsHeld agrees with reps everywhere and two habits that differ only by
  // emoji ("🧘 Meditate" vs "🏃 Meditate") stay distinct. Logs store the rule's
  // exact title at log time, so real rule↔log pairs match.
  const activeKeys = new Set(
    (Array.isArray(rules) ? rules : [])
      .filter((r) => r && !r.archived && !r.excludedFromScore)
      .map((r) => normalize(r?.title)),
  );

  const heldKeys = new Set<string>();
  for (const l of logsInRange) {
    const key = normalize(l?.habitTitle);
    if (activeKeys.has(key)) heldKeys.add(key);
  }
  const habitsHeld = heldKeys.size;

  const wins = (Array.isArray(weeklyWins) ? weeklyWins : []).filter(
    (w) => typeof w === 'string' && w.trim().length > 0,
  ).length;

  return { reps, habitsHeld, wins };
}

/**
 * Pull the forward "focus" line out of the AI weekly-reflection JSON. Mirrors
 * the parse in app/(tabs)/align.tsx so Home and Align surface the same line.
 * Returns '' when absent/unparseable — the caller falls back to a static line.
 */
export function parseWeeklyReflectionFocus(weeklyReflection: unknown): string {
  if (!weeklyReflection || typeof weeklyReflection !== 'string') return '';
  try {
    const parsed = JSON.parse(weeklyReflection);
    return typeof parsed?.focus === 'string' ? parsed.focus.trim() : '';
  } catch {
    return '';
  }
}
