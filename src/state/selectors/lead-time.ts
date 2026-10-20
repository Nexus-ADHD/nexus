/**
 * Lead-Time Radar rollup selector (NEX-162).
 *
 * Pure: takes the actions array + today's key (callers pass `getLocalDateKey(new
 * Date())` and refresh it on a day boundary). No `Date.now()` inside, no imports
 * from app-state — so it's unit-testable and so a stale render never bakes a
 * wrong "today" into the buckets.
 */
import {
  LeadTimeAction,
  LeadTimeStatus,
  bucketLeadTimeAction,
  LEAD_TIME_DUE_WINDOW_DAYS,
} from '../lead-time-types';

export interface LeadTimeActionView extends LeadTimeAction {
  status: LeadTimeStatus;
}

export interface LeadTimeRollup {
  /** All OPEN actions (not done), sorted by act-by date ascending. Orbit's LEAD TIME list. */
  open: LeadTimeActionView[];
  /** Open actions that should surface on Home — overdue first, then due — each sorted by act-by. */
  surfacing: LeadTimeActionView[];
  counts: { waiting: number; due: number; overdue: number };
  /** True when at least one due/overdue action exists (gates the Home card). */
  hasSurfacing: boolean;
}

const STATUS_RANK: Record<LeadTimeStatus, number> = { overdue: 0, due: 1, waiting: 2, done: 3 };

export function selectLeadTimeRollup(
  actions: LeadTimeAction[] | undefined,
  todayKey: string,
  dueWindowDays: number = LEAD_TIME_DUE_WINDOW_DAYS,
): LeadTimeRollup {
  const list = Array.isArray(actions) ? actions : [];
  const open: LeadTimeActionView[] = [];
  const counts = { waiting: 0, due: 0, overdue: 0 };

  for (const a of list) {
    const status = bucketLeadTimeAction(a, todayKey, dueWindowDays);
    if (status === 'done') continue;
    open.push({ ...a, status });
    counts[status] += 1;
  }

  // Orbit list: act-by ascending (soonest deadline first), stable on id.
  open.sort((x, y) => (x.actByDate < y.actByDate ? -1 : x.actByDate > y.actByDate ? 1 : x.id < y.id ? -1 : 1));

  // Home: overdue before due, each by act-by ascending.
  const surfacing = open
    .filter((a) => a.status === 'overdue' || a.status === 'due')
    .sort((x, y) =>
      STATUS_RANK[x.status] - STATUS_RANK[y.status] ||
      (x.actByDate < y.actByDate ? -1 : x.actByDate > y.actByDate ? 1 : 0),
    );

  return { open, surfacing, counts, hasSurfacing: surfacing.length > 0 };
}
