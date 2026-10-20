import { describe, expect, it } from 'vitest';
import type { LeadTimeAction } from '../../state/lead-time-types';
import {
  addDaysKey,
  eventsNeedingLeadTime,
  groupEventsByWeek,
  projectEventDateKey,
  startOfWeekKey,
  thisWeekEvents,
  type WeekAheadEvent,
} from '../week-ahead';

const ev = (id: string, title: string, dateKey: string, eventId?: string | null): WeekAheadEvent => ({
  id,
  title,
  dateKey,
  eventId,
});

const action = (
  eventTitle: string,
  eventDate: string,
  extra: Partial<LeadTimeAction> = {},
): LeadTimeAction => ({
  id: `lt_${eventTitle}_${eventDate}`,
  title: `Prep for ${eventTitle}`,
  eventTitle,
  eventDate,
  eventId: null,
  actByDate: eventDate,
  leadDays: 7,
  completed: false,
  createdAt: 0,
  source: 'manual',
  ...extra,
});

describe('projectEventDateKey', () => {
  it('keeps an all-day event on its authored date even when the provider appends Z (Outlook drift)', () => {
    // The bug: getLocalDateKey('2026-06-15T00:00:00Z') is 2026-06-14 in US zones.
    // All-day must NOT shift, regardless of the runner timezone.
    expect(projectEventDateKey('2026-06-15T00:00:00Z', true)).toBe('2026-06-15');
  });

  it('keeps a Google-style local-midnight all-day event on its date', () => {
    expect(projectEventDateKey('2026-06-15T00:00:00', true)).toBe('2026-06-15');
    expect(projectEventDateKey('2026-06-15', true)).toBe('2026-06-15');
  });

  it('projects a timed event by its instant (midday UTC is tz-stable across US/EU)', () => {
    expect(projectEventDateKey('2026-06-15T18:00:00Z', false)).toBe('2026-06-15');
  });
});

describe('addDaysKey', () => {
  it('crosses a month boundary', () => {
    expect(addDaysKey('2026-01-31', 1)).toBe('2026-02-01');
  });
  it('crosses a year boundary backward', () => {
    expect(addDaysKey('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('crosses the DST spring-forward boundary by whole days', () => {
    // US DST 2026 begins Sun Mar 8. Day arithmetic must stay calendar-correct.
    expect(addDaysKey('2026-03-07', 2)).toBe('2026-03-09');
  });
});

describe('startOfWeekKey', () => {
  it('returns the Sunday of the containing week', () => {
    // 2026-06-15 is a Monday → Sunday is 2026-06-14.
    expect(startOfWeekKey('2026-06-15')).toBe('2026-06-14');
    // A Sunday maps to itself.
    expect(startOfWeekKey('2026-06-14')).toBe('2026-06-14');
  });
});

describe('thisWeekEvents', () => {
  const today = '2026-06-15';
  it('includes today through today+6 and excludes day 7', () => {
    const events = [
      ev('a', 'A', '2026-06-15'),
      ev('b', 'B', '2026-06-21'), // today+6, included
      ev('c', 'C', '2026-06-22'), // today+7, excluded
      ev('d', 'D', '2026-06-14'), // yesterday, excluded
    ];
    expect(thisWeekEvents(events, today).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('sorts by date', () => {
    const events = [ev('b', 'B', '2026-06-18'), ev('a', 'A', '2026-06-16')];
    expect(thisWeekEvents(events, today).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('groupEventsByWeek (FURTHER OUT, weeks 2-6)', () => {
  const today = '2026-06-15'; // Monday; rolling window ends 2026-06-21 (Sun)
  it('buckets events after the rolling window into Sun-Sat weeks and omits empty weeks', () => {
    const events = [
      ev('inWindow', 'X', '2026-06-20'), // still in THIS WEEK → excluded
      ev('w2', 'Y', '2026-06-23'), // week of Jun 21-27
      ev('w4', 'Z', '2026-07-09'), // a few weeks out
    ];
    const buckets = groupEventsByWeek(events, today);
    const ids = buckets.flatMap((b) => b.events.map((e) => e.id));
    expect(ids).toEqual(['w2', 'w4']); // inWindow excluded
    // buckets are Sun-Sat and ordered
    expect(buckets[0].weekStartKey <= buckets[0].events[0].dateKey).toBe(true);
    expect(buckets[0].weekEndKey).toBe(addDaysKey(buckets[0].weekStartKey, 6));
    expect(buckets.every((b, i) => i === 0 || b.weekStartKey > buckets[i - 1].weekStartKey)).toBe(true);
  });
  it('respects the weeks count (default 5 → ~35 days out)', () => {
    const farEvent = ev('far', 'Far', addDaysKey(today, 60));
    expect(groupEventsByWeek([farEvent], today)).toHaveLength(0);
  });

  // The startOfWeekKey-vs-furtherStart guard only behaves like a no-op when today
  // is a Sunday/Monday; exercise the other weekdays so the boundary can't silently
  // drop or double-count (code-review WARN).
  it('does not drop or double-count when today is a Saturday', () => {
    const sat = '2026-06-20'; // Saturday; rolling window 06-20..06-26
    const events = [
      ev('inWk', 'A', '2026-06-26'), // last rolling day → THIS WEEK only
      ev('d7', 'B', '2026-06-27'), // today+7 → first FURTHER bucket
      ev('w3', 'C', '2026-07-05'),
    ];
    const ids = groupEventsByWeek(events, sat).flatMap((b) => b.events.map((e) => e.id));
    expect(ids).toEqual(['d7', 'w3']);
    expect(thisWeekEvents(events, sat).map((e) => e.id)).toContain('inWk');
    expect(ids).not.toContain('inWk');
  });

  it('has no gap at the bucket boundary when today is a Sunday', () => {
    const sun = '2026-06-14'; // Sunday; rolling window 06-14..06-20
    const events = [ev('d7', 'X', '2026-06-21')]; // today+7, a Sunday → first bucket
    expect(groupEventsByWeek(events, sun).flatMap((b) => b.events.map((e) => e.id))).toEqual(['d7']);
  });
});

describe('eventsNeedingLeadTime', () => {
  it('flags an event with no matching action', () => {
    const events = [ev('a', 'Sean wedding', '2026-07-18')];
    expect(eventsNeedingLeadTime(events, []).map((e) => e.id)).toEqual(['a']);
  });

  it('covers by normalized title + date (case/whitespace-insensitive)', () => {
    const events = [ev('a', '  Sean   Wedding ', '2026-07-18')];
    expect(eventsNeedingLeadTime(events, [action('sean wedding', '2026-07-18')])).toEqual([]);
  });

  it('still matches by title+date when the eventId has churned (different/absent id)', () => {
    const events = [ev('a', 'Sean wedding', '2026-07-18', 'NEW-EVENTKIT-ID')];
    const a = action('Sean wedding', '2026-07-18', { eventId: 'OLD-CHURNED-ID' });
    expect(eventsNeedingLeadTime(events, [a])).toEqual([]);
  });

  it('uses eventId as a corroborator when the title was edited but the date matches', () => {
    const events = [ev('a', 'Sean & Mia wedding', '2026-07-18', 'STABLE-ID')];
    const a = action('Sean wedding', '2026-07-18', { eventId: 'STABLE-ID' });
    expect(eventsNeedingLeadTime(events, [a])).toEqual([]);
  });

  it('does NOT match on title alone when the date differs', () => {
    const events = [ev('a', 'Sean wedding', '2026-07-19')];
    expect(eventsNeedingLeadTime(events, [action('Sean wedding', '2026-07-18')]).map((e) => e.id)).toEqual(['a']);
  });

  it('counts COMPLETED actions as covered (prep already done is not re-offered)', () => {
    const events = [ev('a', 'Sean wedding', '2026-07-18')];
    const done = action('Sean wedding', '2026-07-18', { completed: true, completedAt: 123 });
    expect(eventsNeedingLeadTime(events, [done])).toEqual([]);
  });

  it('documented limitation: two same-title same-date events are both covered by one action', () => {
    const events = [ev('a', 'Standup', '2026-07-18'), ev('b', 'Standup', '2026-07-18')];
    expect(eventsNeedingLeadTime(events, [action('Standup', '2026-07-18')])).toEqual([]);
  });
});
