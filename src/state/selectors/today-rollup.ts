/**
 * Shared "what's actionable today" derivations.
 *
 * Two views (Home's Today's-Move CTA, Home's habit chip row, Home's score
 * breakdown, Orbit's Day's To-Do) historically rebuilt these answers
 * independently and drifted — see the Friday-2026-05-01 incident where
 * a pinned habit was scheduled but `pinnedHabits.includes(r.id)` silently
 * dropped it because the pin shape didn't match. One module, one set of
 * predicates, no drift.
 */

export interface TaskRollupItem {
  id: string;
  title: string;
  completed: boolean;
  isRecurring: boolean;
}

export interface TaskRollup {
  items: TaskRollupItem[];
  completed: number;
  total: number;
}

/**
 * Pinned-by-id-or-title. Tolerates legacy data where pinnedHabits stored
 * titles instead of rule IDs, stale IDs, or any other shape mismatch the
 * id-only check would silently reject.
 */
export function isPinned(
  rule: { id?: string; title?: string } | null | undefined,
  pinnedHabits: unknown,
): boolean {
  if (!rule) return false;
  if (!Array.isArray(pinnedHabits)) return false;
  return (
    (rule.id !== undefined && pinnedHabits.includes(rule.id)) ||
    (rule.title !== undefined && pinnedHabits.includes(rule.title))
  );
}

/** Scheduled on this day-of-week (0=Sun..6=Sat). */
export function isScheduledOn(
  rule: { daysOfWeek?: number[] } | null | undefined,
  dow: number,
): boolean {
  return !!rule && Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.includes(dow);
}

/** Pinned + scheduled today. The CTA's "candidate" predicate. */
export function isActionableToday(
  rule: { id?: string; title?: string; daysOfWeek?: number[] } | null | undefined,
  dow: number,
  pinnedHabits: unknown,
): boolean {
  return isPinned(rule, pinnedHabits) && isScheduledOn(rule, dow);
}

export function dowFromDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * Union of (a) `dailyTasks[dateKey]` specific entries and (b) `recurringToDos`
 * scheduled for today by `daysOfWeek` + `interval`. Specific entries override
 * the generated default — when a recurring is checked, Orbit writes a
 * specific entry with `id: ${r.id}-auto` and `completed: true`.
 *
 * Both Home's score breakdown (`scoreBreakdown.tasks`) and Orbit's
 * "DAY'S TO-DO" call this. Orbit may layer sortOrder on top of `items`.
 *
 * @param specificTasks Pre-resolved `dailyTasks` slice for this date —
 *   caller handles legacy key forms (Orbit reads `dailyTasks[dKey] ||
 *   dailyTasks[dayStr]`).
 */
/**
 * Does this recurring rule actually produce an occurrence on `dateKey`?
 *
 * Day-of-week AND per-day exception AND the biweekly interval, in one place.
 *
 * NEX-309 extracted this out of selectTodayTaskRollup's inline filter so the
 * "move just this day" planner can ask the SAME question the rollup answers.
 * Two copies of this predicate would drift, and a drifted occurrence rule is
 * exactly the class of bug that has cost this repo review rounds before
 * (see the app-vs-Swift dedup divergence noted below).
 */
export function occursOn(
  rule: {
    daysOfWeek?: number[];
    exceptions?: string[];
    interval?: number;
    intervalAnchorDate?: string | null;
  } | null | undefined,
  dateKey: string,
): boolean {
  if (!rule) return false;
  if (!isScheduledOn(rule, dowFromDateKey(dateKey))) return false;
  // Per-day skip exception (v15+). Empty/missing array = no skips.
  if (Array.isArray(rule.exceptions) && rule.exceptions.includes(dateKey)) return false;
  const interval = rule.interval || 1;
  if (interval <= 1) return true;
  try {
    const [y, m, d] = dateKey.split('-').map(Number);
    const thisDay = new Date(y, m - 1, d);
    // Date-only anchors ('YYYY-MM-DD') must parse as a LOCAL calendar date —
    // `new Date(str)` would read them as UTC midnight, which lands on the
    // previous local day west of UTC and shifts a Sunday anchor's week back
    // by one (Greptile P1 on #375: Home vs widget biweekly divergence in
    // America/Los_Angeles). The widget parses local (isoFromDateKey), and
    // dowFromDateKey above already splits the same way. ISO datetimes keep
    // the standard parser.
    const anchorRaw = rule.intervalAnchorDate;
    let anchor: Date;
    if (typeof anchorRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchorRaw)) {
      const [ay, am, ad] = anchorRaw.split('-').map(Number);
      anchor = new Date(ay, am - 1, ad);
    } else {
      anchor = anchorRaw ? new Date(anchorRaw) : new Date();
    }
    const anchorSunday = new Date(anchor);
    anchorSunday.setDate(anchor.getDate() - anchor.getDay());
    const targetSunday = new Date(thisDay);
    targetSunday.setDate(thisDay.getDate() - thisDay.getDay());
    const weeksDiff = Math.round(
      (targetSunday.getTime() - anchorSunday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    return weeksDiff % interval === 0;
  } catch {
    return true;
  }
}

export function selectTodayTaskRollup(
  recurringToDos: unknown,
  specificTasks: unknown,
  dateKey: string,
): TaskRollup {
  const specific: any[] = Array.isArray(specificTasks) ? specificTasks : [];

  const generated: TaskRollupItem[] = (Array.isArray(recurringToDos) ? recurringToDos : [])
    .filter((r: any) => occursOn(r, dateKey))
    .map((r: any) => ({
      id: `${r.id}-auto`,
      title: r.title,
      completed: false,
      isRecurring: true,
    }));

  // NEX-306 note: this dedups the generated `${id}-auto` entry against specific
  // entries by ID. The Swift widget (NexusWidget.swift deriveTodayView) dedups
  // by lowercased TITLE instead. The two can disagree for a moved/renamed
  // occurrence; the "move just this day" feature (Phase 1.2b) must reconcile
  // them — ideally by keying both on id.
  const specificIds = new Set(specific.map((t: any) => t?.id));
  const items: TaskRollupItem[] = [
    ...generated.filter((g) => !specificIds.has(g.id)),
    ...specific.map((t: any) => ({
      id: t.id,
      title: t.title,
      completed: !!t?.completed,
      isRecurring: !!t?.isRecurring,
    })),
  ];

  return {
    items,
    completed: items.filter((t) => t.completed).length,
    total: items.length,
  };
}
