/**
 * NEX-193 — deterministic builder for the win-first onboarding capture.
 *
 * The seed prompt ("Say one thing you want to do tomorrow") fixes the schedule,
 * so this path needs neither the AI command pipeline nor a freeform parser: the
 * title is the user's own words and the due date is always tomorrow. Pure and
 * Node-safe (imports only from the import-free `recurrence` + `command-parser`
 * modules) so the date math is unit-tested under vitest.
 */

import { fallbackTitle } from '../command/command-parser';
import { getLocalDateKey } from '../../utils/recurrence';

export interface FirstWinCapture {
  /** Inbox task title — the user's words, trimmed and length-capped. */
  title: string;
  /** Local-tz YYYY-MM-DD for tomorrow. The seed prompt promises "tomorrow". */
  dueDateKey: string;
}

/**
 * Build the {title, dueDateKey} for the first-win Inbox capture.
 *
 * `dueDateKey` is computed from local date parts (via getLocalDateKey), NOT
 * toISOString(), so a capture near midnight does not shift a day in UTC.
 */
export function buildFirstWinCapture(transcript: string, now: Date = new Date()): FirstWinCapture {
  const tomorrow = new Date(now);
  // setDate handles month/year/DST rollover via the Date arithmetic itself.
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    title: fallbackTitle(transcript),
    dueDateKey: getLocalDateKey(tomorrow),
  };
}
