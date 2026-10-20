/**
 * todays-habits.ts — NEX-199 (H-1/H-2)
 *
 * The Today's Habits list contract: cap the visible rows, but the "+N more"
 * collapse may ONLY hide handled (completed) rows — never a live/incomplete one.
 * RN-free so the Node vitest suite covers it directly.
 *
 * Natural order is preserved (the Home list keeps recurringRules order, in which
 * a fresh capture is already prepended → slot 0). There is intentionally NO
 * completion-based re-sort, so checking a habit off never moves the list ("hold
 * position"). Stickiness keeps a row visible once it has been shown this session,
 * so completing a row in an all-live list can't make it vanish into "+N more";
 * the collapse re-applies on the next Home open (the caller resets `sticky`).
 */

import { normalize } from '@/src/utils/text';

export const TODAYS_HABITS_CAP = 5;

/**
 * NEX-199 / Greptile #214 — the canonical "is this habit done today" key.
 *
 * Every habit-completion surface keys on `normalize(title)`, emoji-SENSITIVE,
 * with NO emoji stripping. The write path (`logHabit`/`unlogHabit`) stores
 * habitLog entries as `normalize(rawTitle)`, and the score (`scoreBreakdown`)
 * matches a log to a rule with `normalize(e.habitTitle) === normalize(rule.title)`.
 * This helper is the single source of that convention so the row, the completion
 * check, the "+N more" cap, and the score can never drift apart.
 *
 * Emoji-sensitivity is deliberate: a user may keep "Run" and "Run 🏃" as two
 * distinct habits, and logging one must NOT mark the other complete. An earlier
 * NEX-199 revision keyed these read paths on `normalize(stripEmoji(title))`,
 * which collapsed "Run"/"Run 🏃" onto a shared `run` key (logging either marked
 * both done — Greptile #214) and disagreed with the emoji-sensitive score
 * selector. A legacy emoji-less log for a since-emojified rule is uncounted here
 * exactly as it is in the score — one consistent, accepted behavior, not a
 * per-surface special case.
 */
export function selectTodaysCompletionCounts(
  todayLogs: readonly { habitTitle?: string | null }[] | null | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const logs = Array.isArray(todayLogs) ? todayLogs : [];
  for (const e of logs) {
    const key = normalize(e?.habitTitle);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** Completion key for a rule/title — the SAME key the write path + score use. */
export function habitCompletionKey(title: string | null | undefined): string {
  return normalize(title);
}

/** True when today's logged reps for `rule` meet its `timesPerDay` requirement. */
export function isHabitCompleteToday(
  rule: { title?: string | null; timesPerDay?: number | null } | null | undefined,
  counts: Record<string, number>,
): boolean {
  const required = rule?.timesPerDay || 1;
  return (counts[normalize(rule?.title)] || 0) >= required;
}

export interface TodaysHabitsResult<T> {
  visible: T[];
  /** Count of handled (completed) rows collapsed behind "+N more". */
  hiddenCount: number;
}

export function selectTodaysHabits<T extends { id: string }>(
  scheduled: readonly T[] | null | undefined,
  opts: {
    isComplete: (rule: T) => boolean;
    /** Rule ids already shown this session — kept visible (hold position). */
    sticky?: ReadonlySet<string>;
    cap?: number;
  },
): TodaysHabitsResult<T> {
  const cap = opts.cap ?? TODAYS_HABITS_CAP;
  const list = Array.isArray(scheduled) ? scheduled : [];

  const visible: T[] = [];
  let hiddenCount = 0;
  for (const rule of list) {
    // Show when: incomplete (never hide a live one) OR already sticky-visible
    // (hold position) OR the cap isn't filled yet (fill the tail with completed
    // rows). Otherwise it's a completed overflow row — collapse it.
    if (!opts.isComplete(rule) || opts.sticky?.has(rule.id) || visible.length < cap) {
      visible.push(rule);
    } else {
      hiddenCount += 1;
    }
  }
  return { visible, hiddenCount };
}
