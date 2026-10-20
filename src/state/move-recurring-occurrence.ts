// NEX-309: move ONE occurrence of a recurring to-do to another day.
//
// The app already had Apple Calendar's per-day exception model — but only the
// DELETING half (Delete → "This Day Only" writes a dateKey into
// RecurringToDo.exceptions). The DETACHING half was missing, so "I'm not
// preparing for the office today, but I am tomorrow" had no one-tap answer: a
// one-off got "Move to Different Day", a recurring item got only "Edit
// Schedule", which rewrites the whole series.
//
// A move is three writes that must land together:
//   1. an exception on the source day (the occurrence stops materializing),
//   2. a detached one-off on the target day (carrying provenance),
//   3. removal of any materialized `${ruleId}-auto` record on the source day.
//
// This module is the PURE planner for that: it decides whether the move is
// allowed and returns the next slices. The store action applies the result in
// one `set`, so the three writes are atomic and undo is a single inverse.
// Pure + RN-free, so every state below is covered by the Node vitest suite
// rather than discovered one review round at a time.

import { occursOn } from './selectors/today-rollup';

export interface MovableRule {
  id: string;
  title?: string;
  daysOfWeek?: number[];
  exceptions?: string[];
  interval?: number;
  intervalAnchorDate?: string | null;
  pillarId?: string;
}

export interface MovableTask {
  id: string;
  title: string;
  completed?: boolean;
  pillarId?: string;
  /** NEX-309 provenance — set only on a detached occurrence. */
  movedFromRuleId?: string;
  movedFromDateKey?: string;
}

export type DailyTasksMap = Record<string, MovableTask[]>;

/** Why a move was declined. Each maps to one quiet line in the UI. */
export type MoveRefusal =
  | 'same-day'
  | 'completed'
  | 'already-scheduled'
  | 'rule-not-found';

export type MovePlan =
  | {
      ok: true;
      recurringToDos: MovableRule[];
      dailyTasks: DailyTasksMap;
      /** id of the created detached task, so the caller can offer undo. */
      detachedId: string;
    }
  | { ok: false; reason: MoveRefusal };

function materializedId(ruleId: string): string {
  return `${ruleId}-auto`;
}

/**
 * Plan a one-day move.
 *
 * Refusals (all deliberate; each is smaller than the mechanism it avoids):
 *
 *  - `same-day`          nothing to do.
 *  - `completed`         the occurrence is already checked off. The sibling
 *                        one-off move path resets `completed: false`, but a
 *                        completed RECURRING occurrence carries daily-score
 *                        credit (selectTodayTaskRollup counts completed items),
 *                        so silently resetting would revoke something earned —
 *                        a §1.5 Law B violation. Refusing loses nothing.
 *  - `already-scheduled` the rule already produces an occurrence on the target
 *                        day. Moving onto a day it already happens is not a
 *                        move. This also avoids the app-vs-widget dedup
 *                        divergence documented in NEX-306: the app dedups
 *                        generated-vs-specific by ID and Swift by lowercased
 *                        TITLE, so a detached copy landing on a day the rule
 *                        also fires would render twice in the app and once on
 *                        the widget.
 *
 * @param makeId injected so tests are deterministic and the store can supply
 *   its own id factory.
 */
export function planMoveOccurrence(
  input: {
    recurringToDos: unknown;
    dailyTasks: unknown;
    ruleId: string;
    fromDateKey: string;
    toDateKey: string;
  },
  makeId: () => string,
): MovePlan {
  const { ruleId, fromDateKey, toDateKey } = input;
  if (!ruleId || !fromDateKey || !toDateKey) return { ok: false, reason: 'rule-not-found' };
  if (fromDateKey === toDateKey) return { ok: false, reason: 'same-day' };

  const rules: MovableRule[] = Array.isArray(input.recurringToDos)
    ? (input.recurringToDos as MovableRule[])
    : [];
  const rule = rules.find((r) => r && String(r.id) === String(ruleId));
  if (!rule) return { ok: false, reason: 'rule-not-found' };

  const daily: DailyTasksMap =
    input.dailyTasks && typeof input.dailyTasks === 'object' && !Array.isArray(input.dailyTasks)
      ? ({ ...(input.dailyTasks as DailyTasksMap) })
      : {};

  // Already checked off on the source day? Refuse rather than revoke credit.
  const sourceList = Array.isArray(daily[fromDateKey]) ? daily[fromDateKey] : [];
  const autoId = materializedId(ruleId);
  const materialized = sourceList.find((t) => t && t.id === autoId);
  if (materialized?.completed) return { ok: false, reason: 'completed' };

  // Does the rule already fire on the target day? occursOn is the SAME
  // predicate the rollup uses, so this can't drift from what the user sees.
  if (occursOn(rule, toDateKey)) return { ok: false, reason: 'already-scheduled' };

  // 1. exception on the source day (idempotent — never double-add)
  const existingExceptions = Array.isArray(rule.exceptions) ? rule.exceptions : [];
  const nextRules = rules.map((r) =>
    r && String(r.id) === String(ruleId)
      ? {
          ...r,
          exceptions: existingExceptions.includes(fromDateKey)
            ? existingExceptions
            : [...existingExceptions, fromDateKey],
        }
      : r,
  );

  // 2. detached one-off on the target day, carrying provenance + the rule's
  //    pillar link so the mandate detail screen still sees it.
  const detachedId = makeId();
  const detached: MovableTask = {
    id: detachedId,
    title: String(rule.title ?? ''),
    completed: false,
    ...(rule.pillarId ? { pillarId: rule.pillarId } : {}),
    movedFromRuleId: String(ruleId),
    movedFromDateKey: fromDateKey,
  };
  const targetList = Array.isArray(daily[toDateKey]) ? daily[toDateKey] : [];
  daily[toDateKey] = [...targetList, detached];

  // 3. drop any materialized (un-completed) record on the source day, so the
  //    row doesn't linger after the exception hides its generated twin.
  daily[fromDateKey] = sourceList.filter((t) => !t || t.id !== autoId);

  return { ok: true, recurringToDos: nextRules, dailyTasks: daily, detachedId };
}

/**
 * Exact inverse of a successful move: drop the exception, delete the detached
 * task. Idempotent — running it twice is a no-op, so a double-tapped undo
 * cannot corrupt state or resurrect anything.
 *
 * Deliberately restores nothing else: the materialized `${ruleId}-auto` record
 * removed by step 3 was un-completed (a completed one refuses the move), so the
 * generated occurrence simply reappears once the exception is gone.
 */
export function planUndoMoveOccurrence(input: {
  recurringToDos: unknown;
  dailyTasks: unknown;
  ruleId: string;
  fromDateKey: string;
  toDateKey: string;
  detachedId: string;
}): { recurringToDos: MovableRule[]; dailyTasks: DailyTasksMap } {
  const { ruleId, fromDateKey, toDateKey, detachedId } = input;
  const rules: MovableRule[] = Array.isArray(input.recurringToDos)
    ? (input.recurringToDos as MovableRule[])
    : [];
  const daily: DailyTasksMap =
    input.dailyTasks && typeof input.dailyTasks === 'object' && !Array.isArray(input.dailyTasks)
      ? ({ ...(input.dailyTasks as DailyTasksMap) })
      : {};

  const nextRules = rules.map((r) =>
    r && String(r.id) === String(ruleId) && Array.isArray(r.exceptions)
      ? { ...r, exceptions: r.exceptions.filter((k) => k !== fromDateKey) }
      : r,
  );

  const targetList = Array.isArray(daily[toDateKey]) ? daily[toDateKey] : [];
  daily[toDateKey] = targetList.filter((t) => !t || t.id !== detachedId);

  return { recurringToDos: nextRules, dailyTasks: daily };
}

/**
 * Human label for the day an occurrence landed on, for the §1.5 Law A
 * location-bearing confirmation ("Moved to Tomorrow. On your Orbit.").
 *
 * Declarative, no imperative, no exclamation (§18.1). Pure + injected `today`
 * so the copy is testable rather than clock-dependent.
 */
export function describeMoveTarget(toDateKey: string, todayKey: string): string {
  if (!toDateKey) return 'that day';
  if (toDateKey === todayKey) return 'Today';

  const parse = (k: string): Date | null => {
    const [y, m, d] = k.split('-').map(Number);
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  };
  const target = parse(toDateKey);
  const today = parse(todayKey);
  if (!target || !today) return toDateKey;

  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((target.getTime() - today.getTime()) / dayMs);
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // Inside the coming week, the weekday name is the most locatable thing.
  if (diffDays > 1 && diffDays < 7) return WEEKDAYS[target.getDay()];

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[target.getMonth()]} ${target.getDate()}`;
}
