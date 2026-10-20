import { describe, expect, it } from 'vitest';
import { formatDaysOfWeek } from '../format-days-of-week';

describe('formatDaysOfWeek', () => {
  it('returns "Daily" for all seven days', () => {
    expect(formatDaysOfWeek([0, 1, 2, 3, 4, 5, 6])).toBe('Daily');
  });

  it('returns "Weekdays" for Mon–Fri', () => {
    expect(formatDaysOfWeek([1, 2, 3, 4, 5])).toBe('Weekdays');
  });

  it('returns "Weekends" for Sat + Sun', () => {
    expect(formatDaysOfWeek([0, 6])).toBe('Weekends');
  });

  it('returns short day list for arbitrary cadence', () => {
    expect(formatDaysOfWeek([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(formatDaysOfWeek([2, 4])).toBe('Tue, Thu');
  });

  it('sorts the output regardless of input order', () => {
    expect(formatDaysOfWeek([5, 1, 3])).toBe('Mon, Wed, Fri');
  });

  it('drops out-of-range integers', () => {
    expect(formatDaysOfWeek([1, 7, 3, -1])).toBe('Mon, Wed');
  });

  it('drops non-integers', () => {
    expect(formatDaysOfWeek([1, 2.5, 3])).toBe('Mon, Wed');
  });

  it('returns empty string for empty / invalid input', () => {
    expect(formatDaysOfWeek([])).toBe('');
    expect(formatDaysOfWeek(null as any)).toBe('');
    expect(formatDaysOfWeek(undefined as any)).toBe('');
  });
});
