import { describe, expect, it } from 'vitest';
import { mergeWeeklyEmailConsent, normalizeWeeklyEmailConsent } from '../weekly-email-consent';

describe('weekly email consent', () => {
  it('never turns a legacy boolean into consent', () => {
    expect(normalizeWeeklyEmailConsent(true)).toBe('unset');
    expect(normalizeWeeklyEmailConsent(undefined)).toBe('unset');
  });

  it('keeps an explicit local choice when cloud has no consent marker', () => {
    expect(mergeWeeklyEmailConsent('denied', 20, undefined, undefined)).toEqual({
      consent: 'denied', updatedAt: 20,
    });
  });

  it('uses the newer explicit account choice', () => {
    expect(mergeWeeklyEmailConsent('denied', 20, 'granted', 30)).toEqual({
      consent: 'granted', updatedAt: 30,
    });
  });

  it('fails closed when opposing choices have the same timestamp', () => {
    expect(mergeWeeklyEmailConsent('granted', 30, 'denied', 30)).toEqual({
      consent: 'denied', updatedAt: 30,
    });
  });
});
