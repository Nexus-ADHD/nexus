// Pure helpers for the Design-the-Week forward scan (NEX-163).
//
// RN-free by construction so the Node vitest suite can cover them: the only
// import is `getLocalDateKey` from `./recurrence` (also RN-free) plus a TYPE-ONLY
// import of `LeadTimeAction`. The WeekAheadStep component normalizes its calendar
// + manual events into `WeekAheadEvent[]` before calling these — keeping all the
// date/matching logic here, testable, and away from the @ts-nocheck modal.

import type { LeadTimeAction } from '../state/lead-time-types';
import { getLocalDateKey } from './recurrence';

/** Minimal normalized event the helpers operate on (built by the caller from
 *  ConnectedCalendarEvent + OrbitEvent). `dateKey` is a local YYYY-MM-DD. */
export interface WeekAheadEvent {
  id: string;
  title: string;
  dateKey: string;
  /** EventKit/external id — corroborator only; ids churn across sync (NEX-162). */
  eventId?: string | null;
}

/** A Sun–Sat bucket of FURTHER OUT events. */
export interface WeekBucket {
  weekStartKey: string; // Sunday, YYYY-MM-DD
  weekEndKey: string; // Saturday, YYYY-MM-DD
  events: WeekAheadEvent[];
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Project an event's start to the local calendar date it should display on.
 *  All-day events must land on their AUTHORED date regardless of device timezone:
 *  Google sends local midnight, but Outlook appends `Z` (external-calendars.ts),
 *  which `getLocalDateKey` would shift back a day in negative-offset zones. So for
 *  all-day we take the leading calendar date verbatim; timed events project locally. */
export function projectEventDateKey(startISO: string, allDay?: boolean): string {
  if (allDay) {
    const m = DATE_ONLY.exec(startISO);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return getLocalDateKey(startISO);
}

/** Parse a YYYY-MM-DD key into a local Date at midnight (no timezone shift). */
function keyToLocalDate(dateKey: string): Date {
  const m = DATE_ONLY.exec(dateKey);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Add `days` to a YYYY-MM-DD key, returning a YYYY-MM-DD key (DST/month-safe). */
export function addDaysKey(dateKey: string, days: number): string {
  const d = keyToLocalDate(dateKey);
  d.setDate(d.getDate() + days);
  return getLocalDateKey(d);
}

/** Sunday (week start) of the week containing `dateKey`, as a YYYY-MM-DD key. */
export function startOfWeekKey(dateKey: string): string {
  const d = keyToLocalDate(dateKey);
  return addDaysKey(dateKey, -d.getDay()); // getDay(): 0=Sun
}

/** Lexicographic compare is chronological for YYYY-MM-DD. */
function inRangeInclusive(dateKey: string, startKey: string, endKey: string): boolean {
  return dateKey >= startKey && dateKey <= endKey;
}

/** THIS WEEK = the rolling next 7 days from `todayKey`, inclusive. Sorted by date. */
export function thisWeekEvents(events: WeekAheadEvent[], todayKey: string): WeekAheadEvent[] {
  const endKey = addDaysKey(todayKey, 6);
  return events
    .filter((e) => inRangeInclusive(e.dateKey, todayKey, endKey))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/** FURTHER OUT = the next `weeks` Sun–Sat weeks AFTER the rolling 7-day window
 *  (i.e. weeks 2–6 with the default of 5), grouped by week. Empty weeks are
 *  omitted; buckets and the events inside them are date-sorted. */
export function groupEventsByWeek(
  events: WeekAheadEvent[],
  todayKey: string,
  weeks = 5,
): WeekBucket[] {
  const furtherStartKey = addDaysKey(todayKey, 7); // day after the rolling window
  const firstBucketStart = startOfWeekKey(furtherStartKey);
  const buckets: WeekBucket[] = [];
  for (let i = 0; i < weeks; i++) {
    const weekStartKey = addDaysKey(firstBucketStart, i * 7);
    const weekEndKey = addDaysKey(weekStartKey, 6);
    const inWeek = events
      .filter(
        (e) =>
          inRangeInclusive(e.dateKey, weekStartKey, weekEndKey) &&
          e.dateKey >= furtherStartKey, // don't double-count days still inside THIS WEEK
      )
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    if (inWeek.length) buckets.push({ weekStartKey, weekEndKey, events: inWeek });
  }
  return buckets;
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when `action` already covers `event` (so no lead time should be offered).
 *  Primary signal: normalized title + same eventDate. Corroborator: a matching
 *  non-empty eventId (helps when a title was lightly edited but the id is stable).
 *  Note: matches against ALL actions incl. COMPLETED — prep already done must not
 *  be re-offered. */
function actionCoversEvent(
  event: WeekAheadEvent,
  action: Pick<LeadTimeAction, 'eventTitle' | 'eventDate' | 'eventId'>,
): boolean {
  if (event.dateKey !== action.eventDate) return false;
  if (normalizeTitle(event.title) === normalizeTitle(action.eventTitle)) return true;
  // eventId is a weak corroborator only — never the sole signal (ids churn).
  return !!event.eventId && !!action.eventId && event.eventId === action.eventId;
}

/** Events in `events` that have NO matching LeadTimeAction (open OR completed).
 *  Known limitation (documented, NEX-163): two events sharing the same title and
 *  date are indistinguishable — one action marks both covered (`LeadTimeAction`
 *  carries no time). Accepted for this PR. */
export function eventsNeedingLeadTime(
  events: WeekAheadEvent[],
  actions: LeadTimeAction[],
): WeekAheadEvent[] {
  return events.filter((e) => !actions.some((a) => actionCoversEvent(e, a)));
}
