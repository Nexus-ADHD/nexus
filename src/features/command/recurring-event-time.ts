/**
 * recurring-event-time.ts — pure helpers for turning a recurring capture into
 * the first Apple Calendar occurrence. Extracted verbatim from the Command
 * screen (app/(tabs)/index.tsx) so both the Command tab and the coach thread
 * share one definition, and so the date arithmetic is vitest-coverable.
 *
 * No React Native or expo imports here.
 */

import type { ProposedAction } from './command-types';
import type { TimeBlock } from '../../utils/recurrence';

/** Duration of the Apple Calendar event created for a recurring habit. */
export const RECURRING_EVENT_DURATION_MINUTES = 60;

/**
 * Default clock time for each wide time block. Boundaries align with
 * `timeBlockForHour` in command-executor.ts (morning 09:00 / afternoon 13:00 /
 * evening 17:00 / night 20:00).
 */
export const TIME_BLOCK_DEFAULTS: Record<TimeBlock, string> = {
  morning: '09:00',
  afternoon: '13:00',
  evening: '17:00',
  night: '20:00',
};

/** The exact time on the action, else the block default, else null. */
export function resolveRecurringActionTime(action: ProposedAction): string | null {
  if (action.time?.trim()) return action.time.trim();
  if (action.preferredTimeBlock) return TIME_BLOCK_DEFAULTS[action.preferredTimeBlock];
  return null;
}

export function parse24HourTime(value: string): { hours: number; minutes: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid recurring time: ${value}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid recurring time: ${value}`);
  }
  return { hours, minutes };
}

/** Dedupe, drop out-of-range days, sort ascending. */
export function normalizeDaysOfWeek(daysOfWeek: readonly number[]): number[] {
  return [...new Set(daysOfWeek)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

/**
 * The next occurrence strictly after `now` on one of `daysOfWeek` at `time24h`,
 * searching the next 14 days. Falls back to today/tomorrow at that time if the
 * day list is empty or never matches.
 */
export function getNextOccurrenceForRecurringAction(
  daysOfWeek: readonly number[],
  time24h: string,
  now: Date = new Date(),
): Date {
  const normalizedDays = normalizeDaysOfWeek(daysOfWeek);
  const { hours, minutes } = parse24HourTime(time24h);
  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (normalizedDays.includes(candidate.getDay()) && candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }
  const fallback = new Date(now);
  fallback.setHours(hours, minutes, 0, 0);
  if (fallback.getTime() <= now.getTime()) {
    fallback.setDate(fallback.getDate() + 1);
  }
  return fallback;
}
