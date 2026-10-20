import { describe, expect, it, vi } from 'vitest';
import {
  defaultDaysOfWeek,
  isScheduleDefaulted,
  SCHEDULE_DEFAULTED_NOTE,
} from '../scheduling-default';

describe('defaultDaysOfWeek (NEX-194 save-and-surface invariant)', () => {
  it('defaults an empty array to today-only (not every-day)', () => {
    // The core bug: Home filters Today's Habits with isScheduledOn(rule, dow),
    // which is false for empty days. Today-only makes it surface today and
    // count exactly once — every-day would corrupt the score/streaks.
    expect(defaultDaysOfWeek([], 3)).toEqual([3]);
  });

  it('defaults missing days (undefined) to today-only', () => {
    expect(defaultDaysOfWeek(undefined, 0)).toEqual([0]);
  });

  it('defaults null days to today-only', () => {
    expect(defaultDaysOfWeek(null, 6)).toEqual([6]);
  });

  it('preserves explicit days as-is', () => {
    // The parse knew the cadence — do not override it.
    expect(defaultDaysOfWeek([1, 3, 5], 0)).toEqual([1, 3, 5]);
  });

  it('preserves a single explicit day even if it is not today', () => {
    expect(defaultDaysOfWeek([2], 5)).toEqual([2]);
  });

  it('uses new Date().getDay() when todayDow is omitted', () => {
    // Freeze the clock so the default-param read and the expectation come from
    // the same instant — no flake if the run straddles local midnight.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 17, 12, 0, 0)); // Wed → getDay() === 3
    try {
      const result = defaultDaysOfWeek([]);
      expect(result).toEqual([3]);
      expect(result).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isScheduleDefaulted', () => {
  it('is true for empty / missing / null days', () => {
    expect(isScheduleDefaulted([])).toBe(true);
    expect(isScheduleDefaulted(undefined)).toBe(true);
    expect(isScheduleDefaulted(null)).toBe(true);
  });

  it('is false for explicit days', () => {
    expect(isScheduleDefaulted([2])).toBe(false);
    expect(isScheduleDefaulted([1, 3, 5])).toBe(false);
  });
});

describe('SCHEDULE_DEFAULTED_NOTE (§18.1 copy rules)', () => {
  it('contains no em dash and no exclamation point', () => {
    expect(SCHEDULE_DEFAULTED_NOTE).not.toContain('—'); // em dash
    expect(SCHEDULE_DEFAULTED_NOTE).not.toContain('!');
  });

  it('explains the default and how to change it', () => {
    expect(SCHEDULE_DEFAULTED_NOTE).toContain('today');
    expect(SCHEDULE_DEFAULTED_NOTE).toContain('change the schedule');
  });
});
