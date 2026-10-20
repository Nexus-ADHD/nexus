import { describe, expect, it } from 'vitest';
import { isLapsedReturn, pickOneThing, LAPSE_THRESHOLD_DAYS } from '../return-lapse';

// Local-noon clock for a fixed "today" = 2026-06-17 (Wed).
const NOW = new Date(2026, 5, 17, 12, 0, 0);

describe('isLapsedReturn', () => {
  it('null / undefined prevOpenDate is not a return (first-ever open)', () => {
    expect(isLapsedReturn(null, NOW)).toBe(false);
    expect(isLapsedReturn(undefined, NOW)).toBe(false);
  });

  it('same local day is not a return', () => {
    expect(isLapsedReturn('2026-06-17', NOW)).toBe(false);
  });

  it('the 2-vs-3 day boundary (default threshold 3)', () => {
    expect(LAPSE_THRESHOLD_DAYS).toBe(3);
    expect(isLapsedReturn('2026-06-16', NOW)).toBe(false); // 1 day
    expect(isLapsedReturn('2026-06-15', NOW)).toBe(false); // 2 days
    expect(isLapsedReturn('2026-06-14', NOW)).toBe(true); // 3 days → fires
    expect(isLapsedReturn('2026-06-10', NOW)).toBe(true); // 7 days
  });

  it('crosses a DST boundary without an off-by-one (US spring-forward 2026-03-08)', () => {
    // 2026-03-05 → 2026-03-09 is 4 calendar days across the DST jump.
    const mar9 = new Date(2026, 2, 9, 12, 0, 0);
    expect(isLapsedReturn('2026-03-05', mar9)).toBe(true);
    expect(isLapsedReturn('2026-03-08', mar9)).toBe(false); // 1 day
  });

  it('crosses a month/year boundary correctly', () => {
    const jan2 = new Date(2027, 0, 2, 12, 0, 0);
    expect(isLapsedReturn('2026-12-30', jan2)).toBe(true); // 3 days across year end
    expect(isLapsedReturn('2027-01-01', jan2)).toBe(false); // 1 day
  });

  it('malformed prevOpenDate does not throw and does not fire (daysBetweenKeys→0)', () => {
    expect(isLapsedReturn('not-a-date', NOW)).toBe(false);
    expect(isLapsedReturn('', NOW)).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(isLapsedReturn('2026-06-15', NOW, 2)).toBe(true); // 2 days, threshold 2
    expect(isLapsedReturn('2026-06-11', NOW, 7)).toBe(false); // 6 days, threshold 7
  });
});

describe('pickOneThing', () => {
  it('prefers the first incomplete habit', () => {
    expect(
      pickOneThing({
        habits: [{ title: 'Meditate', id: 'h1' }, { title: 'Stretch', id: 'h2' }],
        nextEvent: { title: 'Standup' },
        inboxTop: { title: 'Call dentist' },
      }),
    ).toEqual({ kind: 'habit', title: 'Meditate', id: 'h1' });
  });

  it('falls through to the next event when no habits remain (already complete)', () => {
    expect(
      pickOneThing({ habits: [], nextEvent: { title: 'Standup', id: 'e1' }, inboxTop: { title: 'Call dentist' } }),
    ).toEqual({ kind: 'event', title: 'Standup', id: 'e1' });
  });

  it('falls through to the oldest inbox item when no habits or events', () => {
    expect(
      pickOneThing({ habits: [], nextEvent: null, inboxTop: { title: 'Call dentist', id: 'i1' } }),
    ).toEqual({ kind: 'inbox', title: 'Call dentist', id: 'i1' });
  });

  it('returns null when there is nothing — the card shows mandate continuity alone', () => {
    expect(pickOneThing({ habits: [], nextEvent: null, inboxTop: null })).toBeNull();
  });

  it('skips a habit with an empty title', () => {
    expect(
      pickOneThing({ habits: [{ title: '' }], nextEvent: { title: 'Standup' }, inboxTop: null }),
    ).toEqual({ kind: 'event', title: 'Standup', id: undefined });
  });
});
