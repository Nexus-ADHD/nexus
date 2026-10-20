import { getLocalDateKey, normalizeDaysOfWeek } from './recurrence';

export const DEFAULT_STREAK_GRACE_MISSES = 1;

export type StreakGraceStatus = 'current' | 'held' | 'empty' | 'expired';

function dateFromKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function scheduledDays(daysOfWeek?: number[]): number[] {
  const days = normalizeDaysOfWeek(daysOfWeek);
  return days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6];
}

export function previousScheduledDateKey(
  reference: Date | string,
  daysOfWeek?: number[],
  nth = 1,
): string {
  const referenceDate = typeof reference === 'string' ? dateFromKey(reference) : new Date(reference);
  const cursor = referenceDate ? new Date(referenceDate) : new Date();
  cursor.setHours(0, 0, 0, 0);

  const scheduled = scheduledDays(daysOfWeek);
  let seen = 0;
  for (let i = 1; i <= 90; i += 1) {
    cursor.setDate(cursor.getDate() - 1);
    if (scheduled.includes(cursor.getDay())) {
      seen += 1;
      if (seen === nth) return getLocalDateKey(cursor);
    }
  }

  return getLocalDateKey(cursor);
}

export function getStreakGraceStatus(input: {
  currentStreak?: number | null;
  lastUpdatedDateKey?: string | null;
  today?: Date | string;
  daysOfWeek?: number[];
}): StreakGraceStatus {
  const currentStreak = Math.max(0, Number(input.currentStreak ?? 0) || 0);
  const lastUpdatedDateKey = input.lastUpdatedDateKey ?? null;
  if (currentStreak <= 0 || !lastUpdatedDateKey) return 'empty';

  const todayKey = input.today ? getLocalDateKey(input.today) : getLocalDateKey(new Date());
  if (lastUpdatedDateKey === todayKey) return 'current';

  const previousScheduled = previousScheduledDateKey(todayKey, input.daysOfWeek, 1);
  if (lastUpdatedDateKey === previousScheduled) return 'current';

  const graceAnchor = previousScheduledDateKey(todayKey, input.daysOfWeek, DEFAULT_STREAK_GRACE_MISSES + 1);
  if (lastUpdatedDateKey === graceAnchor) return 'held';

  return 'expired';
}

export function isStreakGraceHeld(input: Parameters<typeof getStreakGraceStatus>[0]): boolean {
  return getStreakGraceStatus(input) === 'held';
}
