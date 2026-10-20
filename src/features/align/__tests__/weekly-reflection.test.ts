import { describe, expect, it } from 'vitest';
import { isNewWeeklyReflection } from '../weekly-reflection';

describe('isNewWeeklyReflection', () => {
  it('is new only when a non-empty reflection date differs from the seen date', () => {
    expect(isNewWeeklyReflection('2026-09-06', null)).toBe(true);
    expect(isNewWeeklyReflection('2026-09-06', '2026-09-06')).toBe(false);
    expect(isNewWeeklyReflection(null, '2026-09-06')).toBe(false);
  });
});
