/**
 * Schedule-aware habit progress — server port of
 * `src/state/selectors/habit-rollup.ts` `computeHabitProgress`, kept
 * behaviorally identical so the weekly-summary cron's numbers match the app.
 * `normalize` is inlined (port of `src/utils/text.ts`). Only `expected` and
 * `completed` are consumed by the digest, but the full result is ported so the
 * function stays a faithful mirror.
 *
 * TIMEZONE: this uses local Date methods exactly like the app. The scheduler
 * feeds it period boundaries built as ET-wall-clock-via-Date.UTC and the Deno
 * edge runtime is UTC, so "local" reads resolve to ET wall-clock. See
 * weekly-digest.ts for the construction and the documented assumption.
 */

export function normalize(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .normalize('NFC');
}

export interface HabitProgress {
  expected: number;
  completed: number;
  pct: number | null;
  status: 'new' | 'ready';
  streak: number;
}

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
  timestamp?: number;
}

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
): HabitProgress {
  if (!rule) return emptyProgress();

  const ruleDays: number[] = Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length
    ? rule.daysOfWeek
    : [];
  const timesPerDay = Math.max(1, rule.timesPerDay ?? 1);
  const ruleKey = normalize(rule.title);

  const periodStart = startOfDay(period.start);
  const periodEnd = startOfDay(period.end);
  // NEX-236: same future-dated-log guard as the client copy (src/state/selectors/
  // habit-rollup.ts) — a log after the period end must not flip a brand-new habit
  // to "ready" in the weekly email digest. YYYY-MM-DD compares lexicographically.
  const periodEndKey = dateKeyOf(period.end);
  const createdAtMs = typeof rule.createdAt === 'number' ? rule.createdAt : 0;
  const createdDay = createdAtMs > 0 ? startOfDay(new Date(createdAtMs)) : periodStart;
  const effectiveStart = createdDay > periodStart ? createdDay : periodStart;

  // Lifetime completion days — the SOLE signal for the "new" gate. Computed up
  // front so the degenerate early-returns below honor it (a habit with real
  // history is never "new", even in a window with no expected occurrences).
  // Kept in sync with src/state/selectors/habit-rollup.ts.
  const lifetimeCompletionDays = new Set(
    (Array.isArray(habitLog) ? habitLog : [])
      .filter((log) => log?.dateKey && log.dateKey <= periodEndKey && normalize(log?.habitTitle) === ruleKey)
      .map((log) => log!.dateKey),
  ).size;

  const degenerate = (): HabitProgress =>
    lifetimeCompletionDays > 0
      ? { expected: 0, completed: 0, pct: null, status: 'ready', streak: 0 }
      : emptyProgress();

  if (effectiveStart > periodEnd || ruleDays.length === 0) {
    return degenerate();
  }

  const scheduledKeys: string[] = [];
  const cursor = new Date(effectiveStart);
  while (cursor <= periodEnd) {
    if (ruleDays.includes(cursor.getDay())) {
      scheduledKeys.push(dateKeyOf(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (scheduledKeys.length === 0) {
    return degenerate();
  }

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

  let streak = 0;
  for (let i = scheduledKeys.length - 1; i >= 0; i -= 1) {
    const key = scheduledKeys[i];
    if ((perDayCount[key] ?? 0) >= timesPerDay) {
      streak += 1;
    } else {
      break;
    }
  }

  // NEW ⇔ zero lifetime completion days (a zero count implies streak === 0).
  if (lifetimeCompletionDays === 0) {
    return { expected, completed, pct: null, status: 'new', streak };
  }
  const pct = expected > 0 ? Math.round((completed / expected) * 100) : 0;
  return { expected, completed, pct, status: 'ready', streak };
}
