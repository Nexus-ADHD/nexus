import { describe, expect, it } from 'vitest';
import { buildFirstWinCapture } from '../build-first-win-capture';

// Local-constructed dates (year, monthIndex, day, ...) so the assertions read
// against local-tz date parts, matching getLocalDateKey's behavior.

describe('buildFirstWinCapture', () => {
  describe('dueDateKey is local-tz tomorrow', () => {
    it('rolls a mid-month day forward by one', () => {
      const now = new Date(2026, 5, 16, 10, 0, 0); // Tue 2026-06-16
      expect(buildFirstWinCapture('call the dentist', now).dueDateKey).toBe('2026-06-17');
    });

    it('rolls across a month boundary', () => {
      const now = new Date(2026, 5, 30, 9, 0, 0); // 2026-06-30
      expect(buildFirstWinCapture('x', now).dueDateKey).toBe('2026-07-01');
    });

    it('rolls across a year boundary', () => {
      const now = new Date(2026, 11, 31, 23, 0, 0); // 2026-12-31
      expect(buildFirstWinCapture('x', now).dueDateKey).toBe('2027-01-01');
    });

    it('handles a leap-day boundary', () => {
      const now = new Date(2028, 1, 28, 12, 0, 0); // 2028-02-28 (leap year)
      expect(buildFirstWinCapture('x', now).dueDateKey).toBe('2028-02-29');
    });

    it('does not shift a day for a near-midnight local time', () => {
      const now = new Date(2026, 5, 16, 23, 59, 0); // 23:59 local on 2026-06-16
      expect(buildFirstWinCapture('x', now).dueDateKey).toBe('2026-06-17');
    });

    it('survives a spring-forward DST day (setDate, not +24h)', () => {
      const now = new Date(2026, 2, 7, 10, 0, 0); // 2026-03-07, day before US DST
      expect(buildFirstWinCapture('x', now).dueDateKey).toBe('2026-03-08');
    });
  });

  describe('title', () => {
    const now = new Date(2026, 5, 16, 10, 0, 0);

    it('trims surrounding whitespace', () => {
      expect(buildFirstWinCapture('  finish the deck  ', now).title).toBe('finish the deck');
    });

    it('falls back to "Captured thought" on empty/whitespace input', () => {
      expect(buildFirstWinCapture('', now).title).toBe('Captured thought');
      expect(buildFirstWinCapture('   ', now).title).toBe('Captured thought');
    });

    it('caps long input at 60 chars with an ellipsis', () => {
      const long = 'a'.repeat(80);
      const { title } = buildFirstWinCapture(long, now);
      expect(title.length).toBe(60);
      expect(title.endsWith('...')).toBe(true);
    });

    it('keeps a title at the 60-char threshold intact', () => {
      const exact = 'b'.repeat(60);
      expect(buildFirstWinCapture(exact, now).title).toBe(exact);
    });
  });
});
