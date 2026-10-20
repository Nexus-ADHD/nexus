import { describe, expect, it } from 'vitest';
import { getStreakGraceStatus, previousScheduledDateKey } from '../streak-grace';

describe('streak grace', () => {
  it('holds a daily streak after one missed scheduled day', () => {
    expect(getStreakGraceStatus({
      currentStreak: 12,
      lastUpdatedDateKey: '2026-05-28',
      today: '2026-05-30',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    })).toBe('held');
  });

  it('expires after more than one missed scheduled day', () => {
    expect(getStreakGraceStatus({
      currentStreak: 12,
      lastUpdatedDateKey: '2026-05-27',
      today: '2026-05-30',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    })).toBe('expired');
  });

  it('uses the habit schedule when finding the grace anchor', () => {
    // Saturday 2026-05-30. For a M/W/F habit, the previous scheduled day
    // is Friday and the one protected by Grace Day is Wednesday.
    expect(previousScheduledDateKey('2026-05-30', [1, 3, 5], 1)).toBe('2026-05-29');
    expect(previousScheduledDateKey('2026-05-30', [1, 3, 5], 2)).toBe('2026-05-27');
    expect(getStreakGraceStatus({
      currentStreak: 8,
      lastUpdatedDateKey: '2026-05-27',
      today: '2026-05-30',
      daysOfWeek: [1, 3, 5],
    })).toBe('held');
  });

  it('reports current when the habit was logged today', () => {
    expect(getStreakGraceStatus({
      currentStreak: 5,
      lastUpdatedDateKey: '2026-05-30',
      today: '2026-05-30',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    })).toBe('current');
  });

  it('reports current when the last log is the most recent scheduled day', () => {
    expect(getStreakGraceStatus({
      currentStreak: 5,
      lastUpdatedDateKey: '2026-05-29',
      today: '2026-05-30',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    })).toBe('current');
  });

  it('reports empty when the streak is zero', () => {
    expect(getStreakGraceStatus({
      currentStreak: 0,
      lastUpdatedDateKey: '2026-05-29',
      today: '2026-05-30',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    })).toBe('empty');
  });
});
