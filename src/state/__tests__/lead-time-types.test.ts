import { describe, it, expect } from 'vitest';
import {
  computeActByDate,
  addDaysToKey,
  bucketLeadTimeAction,
  backfillLeadTimeActions,
  formatKeyShort,
  formatKeyShortWithWeekday,
  daysBetweenKeys,
  leadTimeFireAt,
  LeadTimeAction,
} from '../lead-time-types';

const TODAY = '2026-06-14';

describe('addDaysToKey', () => {
  it('shifts forward and backward', () => {
    expect(addDaysToKey('2026-06-14', 7)).toBe('2026-06-21');
    expect(addDaysToKey('2026-06-14', -7)).toBe('2026-06-07');
    expect(addDaysToKey('2026-06-14', 0)).toBe('2026-06-14');
  });
  it('crosses month/year boundaries', () => {
    expect(addDaysToKey('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDaysToKey('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('is calendar-based, so a US DST spring-forward boundary does not drift a day', () => {
    // March 8 2026 is the US DST change. setDate arithmetic is calendar-based,
    // so this holds in any timezone.
    expect(addDaysToKey('2026-03-10', -7)).toBe('2026-03-03');
  });
  it('returns a malformed key unchanged', () => {
    expect(addDaysToKey('not-a-date', 3)).toBe('not-a-date');
  });
});

describe('computeActByDate', () => {
  it('subtracts leadDays from a YYYY-MM-DD event date', () => {
    expect(computeActByDate('2026-06-21', 7)).toBe('2026-06-14');
    expect(computeActByDate('2026-07-04', 30)).toBe('2026-06-04');
  });
  it('projects a Date input through local fields (all-day-event safe)', () => {
    // Local midnight June 21 — projects to the same local day regardless of TZ.
    expect(computeActByDate(new Date(2026, 5, 21, 0, 0, 0), 7)).toBe('2026-06-14');
  });
  it('clamps a negative / non-finite leadDays to 0', () => {
    expect(computeActByDate('2026-06-21', -5)).toBe('2026-06-21');
    expect(computeActByDate('2026-06-21', Number.NaN)).toBe('2026-06-21');
  });
});

describe('formatKeyShort', () => {
  it('formats a key as "Mon D" with no weekday/year', () => {
    expect(formatKeyShort('2026-06-27')).toBe('Jun 27');
    expect(formatKeyShort('2026-01-05')).toBe('Jan 5');
    expect(formatKeyShort('2026-12-31')).toBe('Dec 31');
  });
  it('returns a malformed key unchanged', () => {
    expect(formatKeyShort('nope')).toBe('nope');
  });
});

describe('formatKeyShortWithWeekday', () => {
  it('prefixes the short weekday to "Mon D"', () => {
    expect(formatKeyShortWithWeekday('2026-06-27')).toBe('Sat, Jun 27'); // Saturday
    expect(formatKeyShortWithWeekday('2026-06-28')).toBe('Sun, Jun 28'); // Sunday (getDay 0)
    expect(formatKeyShortWithWeekday('2026-06-24')).toBe('Wed, Jun 24');
    expect(formatKeyShortWithWeekday('2026-01-05')).toBe('Mon, Jan 5');
    expect(formatKeyShortWithWeekday('2026-12-31')).toBe('Thu, Dec 31');
  });
  it('returns a malformed key unchanged', () => {
    expect(formatKeyShortWithWeekday('nope')).toBe('nope');
  });
});

describe('daysBetweenKeys', () => {
  it('counts whole days forward and back', () => {
    expect(daysBetweenKeys('2026-06-14', '2026-06-21')).toBe(7);
    expect(daysBetweenKeys('2026-06-21', '2026-06-14')).toBe(-7);
    expect(daysBetweenKeys('2026-06-14', '2026-06-14')).toBe(0);
  });
  it('is DST-safe across the US spring-forward', () => {
    expect(daysBetweenKeys('2026-03-03', '2026-03-10')).toBe(7);
  });
  it('malformed → 0', () => {
    expect(daysBetweenKeys('x', '2026-06-14')).toBe(0);
  });
});

describe('leadTimeFireAt', () => {
  // Build now + expected from LOCAL fields so the test is timezone-independent.
  const at = (y: number, mo: number, d: number, h: number) => new Date(y, mo - 1, d, h, 0, 0, 0).getTime();

  it('future act-by → 9am local on that date', () => {
    expect(leadTimeFireAt('2026-06-20', at(2026, 6, 14, 12))).toBe(at(2026, 6, 20, 9));
  });
  it('past act-by → null', () => {
    expect(leadTimeFireAt('2026-06-10', at(2026, 6, 14, 12))).toBeNull();
  });
  it('today before 9am → fires today 9am', () => {
    expect(leadTimeFireAt('2026-06-14', at(2026, 6, 14, 7))).toBe(at(2026, 6, 14, 9));
  });
  it('today after 9am → null (already past)', () => {
    expect(leadTimeFireAt('2026-06-14', at(2026, 6, 14, 10))).toBeNull();
  });
  it('malformed key → null', () => {
    expect(leadTimeFireAt('nope', at(2026, 6, 14, 12))).toBeNull();
  });
});

describe('bucketLeadTimeAction', () => {
  const at = (actByDate: string, completed = false) => ({ actByDate, completed });

  it('completed → done regardless of dates', () => {
    expect(bucketLeadTimeAction(at('2026-01-01', true), TODAY)).toBe('done');
  });
  it('act-by 8 days out → waiting (just past the 7-day window)', () => {
    expect(bucketLeadTimeAction(at('2026-06-22'), TODAY)).toBe('waiting');
  });
  it('act-by exactly 7 days out → due (window edge)', () => {
    expect(bucketLeadTimeAction(at('2026-06-21'), TODAY)).toBe('due');
  });
  it('act-by is today → due', () => {
    expect(bucketLeadTimeAction(at('2026-06-14'), TODAY)).toBe('due');
  });
  it('act-by yesterday → overdue', () => {
    expect(bucketLeadTimeAction(at('2026-06-13'), TODAY)).toBe('overdue');
  });
  it('leadDays=7 on an event one week out is born "due" today', () => {
    const actBy = computeActByDate('2026-06-21', 7); // = TODAY
    expect(bucketLeadTimeAction(at(actBy), TODAY)).toBe('due');
  });
});

describe('backfillLeadTimeActions', () => {
  const valid: LeadTimeAction = {
    id: 'a1', title: 'Request day off', eventTitle: 'Wedding',
    eventDate: '2026-07-04', eventId: null, actByDate: '2026-06-27',
    leadDays: 7, completed: false, createdAt: 100, source: 'manual',
  };

  it('undefined / non-array → []', () => {
    expect(backfillLeadTimeActions(undefined)).toEqual([]);
    expect(backfillLeadTimeActions(null)).toEqual([]);
    expect(backfillLeadTimeActions('nope' as any)).toEqual([]);
  });
  it('a well-formed array round-trips and is idempotent', () => {
    const once = backfillLeadTimeActions([valid]);
    expect(once).toEqual([valid]);
    expect(backfillLeadTimeActions(once)).toEqual(once);
  });
  it('drops rows missing required string fields', () => {
    const out = backfillLeadTimeActions([valid, { id: 'x' }, { title: 'no dates' }, 42, null]);
    expect(out.map((a) => a.id)).toEqual(['a1']);
  });
  it('drops rows whose eventDate/actByDate are not YYYY-MM-DD keys', () => {
    const out = backfillLeadTimeActions([
      valid,
      { ...valid, id: 'bad-event', eventDate: 'not-a-date' },
      { ...valid, id: 'bad-actby', actByDate: '2026/06/27' },
      { ...valid, id: 'iso', eventDate: '2026-07-04T00:00:00Z' },
    ]);
    expect(out.map((a) => a.id)).toEqual(['a1']);
  });
  it('coerces completed/eventId/leadDays defaults', () => {
    const [out] = backfillLeadTimeActions([
      { id: 'b', title: 't', eventDate: '2026-07-04', actByDate: '2026-06-27' },
    ]);
    expect(out.completed).toBe(false);
    expect(out.eventId).toBeNull();
    expect(out.leadDays).toBe(0);
    expect(out.source).toBe('manual');
  });
});
