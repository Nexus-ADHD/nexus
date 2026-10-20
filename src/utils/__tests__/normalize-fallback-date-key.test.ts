import { describe, expect, it } from 'vitest';
import { normalizeFallbackDateKey } from '../recurrence';

// Orbit's sort/display helpers receive their date fallback as either a
// YYYY-MM-DD key or a Date (`selectedDate`/`baseDate`). Before normalization,
// a raw Date passed through as a "key" built `new Date("Mon Jul 02...T00:00:00")`
// → NaN, silently breaking routine↔Apple matching and time sorting. Contract:
// missing/invalid stays null (callers keep their own default paths — never
// default to "now" here).

describe('normalizeFallbackDateKey', () => {
  it('converts a Date to its LOCAL YYYY-MM-DD key', () => {
    expect(normalizeFallbackDateKey(new Date(2026, 6, 2, 23, 30))).toBe('2026-07-02');
  });

  it('passes a YYYY-MM-DD key through untouched', () => {
    expect(normalizeFallbackDateKey('2026-07-02')).toBe('2026-07-02');
  });

  it('parses a toDateString()-format day string (the daysArray format)', () => {
    expect(normalizeFallbackDateKey(new Date(2026, 6, 2).toDateString())).toBe('2026-07-02');
  });

  it('returns null for null and undefined (never defaults to now)', () => {
    expect(normalizeFallbackDateKey(null)).toBeNull();
    expect(normalizeFallbackDateKey(undefined)).toBeNull();
  });

  it('returns null for an empty string and unparseable garbage', () => {
    expect(normalizeFallbackDateKey('')).toBeNull();
    expect(normalizeFallbackDateKey('not a date')).toBeNull();
  });

  it('returns null for an Invalid Date instance', () => {
    expect(normalizeFallbackDateKey(new Date('garbage'))).toBeNull();
  });
});
