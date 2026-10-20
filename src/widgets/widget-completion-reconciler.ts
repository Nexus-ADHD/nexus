// NEX-313 (roadmap 3.2): reconcile Home-Screen habit completions back into the app.
//
// The audit's deepest finding was C1: Nexus is an app you must open. The widget
// renders today's habits but cannot accept a tap, so Law A — "for an
// out-of-sight-out-of-mind brain a hidden item is functionally deleted" — is
// violated by the app itself several times a day. Interactive widgets (iOS 17)
// close that: a habit checks off from the Home Screen without opening the app.
//
// ─── The round-trip, and why this half is pure ───────────────────────────────
//
// A widget button runs an `AppIntent` in the WIDGET EXTENSION's process. It has
// no access to zustand, the React tree, or the app's memory at all. So the tap
// cannot mutate app state directly — it can only leave a message in the one
// place both processes share: the App Group (`group.com.jhuff.nexus`), the same
// channel the app already uses to hand the widget its snapshot.
//
//   tap  ->  CompleteHabitIntent appends an action to the App Group queue
//   app foreground  ->  read queue  ->  THIS reconciler  ->  logHabit calls  ->  clear queue
//
// This module is that reconciler: pure, RN-free, Node-testable. The Swift
// intent and the foreground wiring are the device-verified half (a widget
// button cannot be exercised on the simulator, and `ios/NexusWidget` is
// regenerated at build from `native-targets/`).
//
// ─── The decision that makes this safe ───────────────────────────────────────
//
// The widget action is COMPLETE (set-to-done), never toggle. That is not a UI
// preference; it is what dissolves the entire double-apply race class. Applying
// "complete habit X on day D" past the habit's daily target (timesPerDay)
// equals applying it exactly up to the target, so:
//
//   - the queue read twice (a foreground that races a second foreground),
//   - a crash after logHabit but before the queue clears,
//   - the same habit tapped more times than its daily target,
//
// all collapse to a no-op. Multi-rep habits (timesPerDay > 1, e.g. "Read
// Mantra" 2x/day) count each tap as ONE occurrence up to that target — the
// boolean collapse applies only past it. Foreground reconcilers are a known
// race cluster (LEARNINGS 2026-06-17); this one has no race to lose because
// its operation is idempotent by construction. Un-completing from the widget
// is deliberately not offered — the completion ceremony, and any undo, live
// in-app.

import { normalize } from '../utils/text';

/**
 * One completion the widget recorded. The Swift intent writes exactly this
 * shape into the App Group queue.
 */
export interface WidgetCompletionAction {
  /** Stable per-tap id. Its only job is deduping a queue read more than once. */
  id: string;
  /** The habit's RAW title, as the widget displays it (emoji included). */
  habitTitle: string;
  /** The day the tap happened, `YYYY-MM-DD`. NOT necessarily today. */
  dayKey: string;
  /** Unix ms of the tap. */
  at: number;
}

/** A completion to write via `logHabit`, already reconciled against state. */
export interface PlannedCompletion {
  /** Raw title — `logHabit` normalizes internally, matching how it stores. */
  habitTitle: string;
  dayKey: string;
}

export interface WidgetReconcilePlan {
  /** Completions to apply. Empty when everything was already done or invalid. */
  toApply: PlannedCompletion[];
  /**
   * True once the caller should clear the App Group queue. Always true after a
   * successful read: every action was either applied or intentionally dropped,
   * so nothing in the queue still needs doing. Kept explicit so the wiring
   * cannot forget that a fully-skipped queue must still be cleared (otherwise a
   * single stale action replays every foreground forever).
   */
  clearQueue: boolean;
}

/**
 * Reconcile the App Group completion queue into `logHabit` calls.
 *
 * Multi-rep habits (timesPerDay > 1 — e.g. "Read Mantra" 2x/day): each tap is
 * ONE occurrence, applied while the habit's daily target is not yet reached
 * between the store and this batch. The second tap of a twice-daily habit
 * applies; a third does not. Passing a Set for `knownHabits` means every
 * habit's target is 1 — the original boolean set-to-done behavior.
 *
 * @param queue       actions the widget appended, oldest-first (tolerates garbage)
 * @param habitLog    the app's habit log; only `{ habitTitle, dateKey }` are read
 * @param knownHabits either a Set of `normalize(title)` for every habit that
 *                    currently EXISTS (target = 1 rep each), or a Map of
 *                    `normalize(title)` -> timesPerDay target
 * @param _todayKey   reserved; the plan intentionally does not gate on "today"
 *                    (an action carries the day it was tapped)
 */
export function planWidgetCompletions(
  queue: unknown,
  habitLog: unknown,
  knownHabits: ReadonlySet<string> | ReadonlyMap<string, number>,
  _todayKey?: string,
): WidgetReconcilePlan {
  const actions = Array.isArray(queue) ? queue : [];
  const requiredByKey: ReadonlyMap<string, number> | null =
    knownHabits instanceof Map ? knownHabits : null;
  const knownKeys: ReadonlySet<string> =
    knownHabits instanceof Set ? knownHabits : new Set<string>();
  const isKnown = (k: string): boolean =>
    requiredByKey ? requiredByKey.has(k) : knownKeys.has(k);
  const requiredFor = (k: string): number => Math.max(requiredByKey?.get(k) ?? 1, 1);

  // Index the existing log by day -> normalized title -> occurrence count
  // (multi-rep habits need counts, not boolean presence). Built once so a
  // long queue is O(queue + log), not O(queue * log).
  const loggedCountsByDay = new Map<string, Map<string, number>>();
  const logRows = Array.isArray(habitLog) ? habitLog : [];
  for (const e of logRows) {
    if (!e || typeof e.habitTitle !== 'string' || typeof e.dateKey !== 'string') continue;
    const k = normalize(e.habitTitle);
    if (!k) continue;
    let forDay = loggedCountsByDay.get(e.dateKey);
    if (!forDay) {
      forDay = new Map<string, number>();
      loggedCountsByDay.set(e.dateKey, forDay);
    }
    forDay.set(k, (forDay.get(k) ?? 0) + 1);
  }

  const toApply: PlannedCompletion[] = [];
  // Count planned occurrences WITHIN this batch by day+title (not action id):
  // occurrences past the habit's daily target are redundant, whether they come
  // from the same action read twice or from genuinely distinct extra taps.
  const plannedThisBatch = new Map<string, number>();

  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const action = a as Partial<WidgetCompletionAction>;
    const rawTitle = typeof action.habitTitle === 'string' ? action.habitTitle : '';
    const dayKey = typeof action.dayKey === 'string' ? action.dayKey : '';
    if (!rawTitle || !dayKey) continue;

    const key = normalize(rawTitle);
    if (!key) continue;

    // A stale widget can show a habit the user has since deleted. Completing it
    // would create an inert orphan log entry (it scores nothing and self-heals,
    // per LEARNINGS 2026-06-21) — but silently resurrecting a deleted habit is
    // worse than dropping the tap, so drop it.
    if (!isKnown(key)) continue;

    // Daily target reached — by the store plus earlier applies in this batch?
    // Then this tap is a no-op. Below the target, each tap is one more rep.
    const batchKey = `${dayKey} ${key}`;
    const existing = loggedCountsByDay.get(dayKey)?.get(key) ?? 0;
    const planned = plannedThisBatch.get(batchKey) ?? 0;
    if (existing + planned >= requiredFor(key)) continue;

    plannedThisBatch.set(batchKey, planned + 1);
    toApply.push({ habitTitle: rawTitle, dayKey });
  }

  // Always clear: every queued action was applied or deliberately dropped, so
  // nothing left in the queue still needs doing. A queue that is read but never
  // cleared replays its stale actions on every future foreground.
  return { toApply, clearQueue: true };
}
