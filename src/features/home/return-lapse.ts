/**
 * return-lapse.ts
 *
 * NEX-191 (ADHD pivot P2-b) — pure helpers for the shame-free return screen.
 *
 * Side-effect-free, RN-free (vitest-coverable). The two decisions a return
 * surface needs — "is this a return after a lapse?" and "what is the one thing
 * to show?" — live here so the date math and priority order are testable and
 * the screen/store stay thin.
 *
 * §1.5 Law C: we compute only a BOOLEAN ("lapsed or not"). The day count is
 * never returned, stored, or displayed — counting an absence is banned.
 */

import { getLocalDateKey } from '../../utils/recurrence';
import { daysBetweenKeys } from '../../state/lead-time-types';

/** Default gap (in days) that counts as a lapse. Reuses the old comeback threshold. */
export const LAPSE_THRESHOLD_DAYS = 3;

/**
 * True when the last open was at least `thresholdDays` ago. `prevOpenDate` is the
 * `lastOpenDate` value (a `YYYY-MM-DD` key) BEFORE it is overwritten for today.
 *
 * Uses `daysBetweenKeys` (DST-safe local-noon, malformed→0) — never the
 * `new Date('YYYY-MM-DD')` UTC trap. Returns a plain boolean; the gap size is
 * intentionally not exposed (Law C: never count an absence).
 */
export function isLapsedReturn(
  prevOpenDate: string | null | undefined,
  now: Date = new Date(),
  thresholdDays: number = LAPSE_THRESHOLD_DAYS,
): boolean {
  if (!prevOpenDate) return false; // first-ever open / no history → not a return
  const gap = daysBetweenKeys(prevOpenDate, getLocalDateKey(now));
  return gap >= thresholdDays;
}

export type OneThing =
  | { kind: 'habit' | 'event' | 'inbox'; title: string; id?: string }
  | null;

export interface OneThingInput {
  /** Today's INCOMPLETE scheduled habits, in display order (titles + stable ids). */
  habits: { title: string; id?: string }[];
  /** The next calendar event today, if any. */
  nextEvent: { title: string; id?: string } | null;
  /** The single most-rotting open inbox item, if any. */
  inboxTop: { title: string; id?: string } | null;
}

/**
 * Pick the single highest-signal thing to surface on return. Priority:
 *   1. first incomplete habit scheduled today (identity-building, time-relevant)
 *   2. the next calendar event today
 *   3. the oldest open inbox item
 *   4. nothing → null (the card shows mandate continuity alone)
 *
 * Callers pass already-filtered data (habits must be incomplete only, inbox must
 * be open/non-archived) — this function only decides priority.
 */
export function pickOneThing(input: OneThingInput): OneThing {
  const habit = input.habits?.[0];
  if (habit && habit.title) return { kind: 'habit', title: habit.title, id: habit.id };
  if (input.nextEvent && input.nextEvent.title)
    return { kind: 'event', title: input.nextEvent.title, id: input.nextEvent.id };
  if (input.inboxTop && input.inboxTop.title)
    return { kind: 'inbox', title: input.inboxTop.title, id: input.inboxTop.id };
  return null;
}
