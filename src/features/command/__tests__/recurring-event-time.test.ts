import { describe, expect, it } from 'vitest';
import {
  getNextOccurrenceForRecurringAction,
  normalizeDaysOfWeek,
  parse24HourTime,
  resolveRecurringActionTime,
  TIME_BLOCK_DEFAULTS,
} from '../recurring-event-time';

describe('resolveRecurringActionTime', () => {
  it('prefers an explicit time, trimmed', () => {
    expect(
      resolveRecurringActionTime({ type: 'recurring_add', title: 'Yoga', time: ' 06:00 ' }),
    ).toBe('06:00');
  });

  it('falls back to the block default', () => {
    expect(
      resolveRecurringActionTime({
        type: 'recurring_add',
        title: 'Yoga',
        preferredTimeBlock: 'evening',
      }),
    ).toBe(TIME_BLOCK_DEFAULTS.evening);
  });

  it('is null with neither', () => {
    expect(resolveRecurringActionTime({ type: 'recurring_add', title: 'Yoga' })).toBeNull();
  });
});

describe('parse24HourTime', () => {
  it('parses H:MM and HH:MM', () => {
    expect(parse24HourTime('6:05')).toEqual({ hours: 6, minutes: 5 });
    expect(parse24HourTime('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('rejects out-of-range and malformed values', () => {
    expect(() => parse24HourTime('24:00')).toThrow(/Invalid recurring time/);
    expect(() => parse24HourTime('09:60')).toThrow(/Invalid recurring time/);
    expect(() => parse24HourTime('9am')).toThrow(/Invalid recurring time/);
  });
});

describe('normalizeDaysOfWeek', () => {
  it('dedupes, drops out-of-range, sorts', () => {
    expect(normalizeDaysOfWeek([5, 1, 1, 7, -1, 3.5, 0])).toEqual([0, 1, 5]);
  });
});

describe('getNextOccurrenceForRecurringAction', () => {
  // Wednesday 2026-09-02 10:00 local.
  const now = new Date(2026, 8, 2, 10, 0, 0, 0);

  it('returns today when the time is still ahead', () => {
    const next = getNextOccurrenceForRecurringAction([3], '18:00', now);
    expect(next.getDay()).toBe(3);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(18);
  });

  it('skips to the next listed day when today is already past', () => {
    const next = getNextOccurrenceForRecurringAction([3, 5], '06:00', now);
    expect(next.getDay()).toBe(5);
    expect(next.getDate()).toBe(4);
    expect(next.getHours()).toBe(6);
    expect(next.getMinutes()).toBe(0);
  });

  it('wraps to next week when the only day is today and the time is past', () => {
    const next = getNextOccurrenceForRecurringAction([3], '06:00', now);
    expect(next.getDay()).toBe(3);
    expect(next.getDate()).toBe(9);
  });

  it('falls back to tomorrow at that time when no day matches', () => {
    const next = getNextOccurrenceForRecurringAction([], '06:00', now);
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(6);
  });

  it('falls back to today at that time when no day matches and the time is ahead', () => {
    const next = getNextOccurrenceForRecurringAction([], '18:00', now);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(18);
  });
});
