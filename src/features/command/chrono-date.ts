/**
 * chrono-date.ts — offline relative-date resolution for the Tier-1 grammar (NEX-316).
 *
 * Wraps `chrono-node` so the deterministic capture grammar (grammar-parser.ts)
 * can resolve relative dates it previously punted to the AI — most importantly
 * "next <weekday>" ("add flag football to the calendar for next Thursday").
 *
 * Pure, side-effect-free, RN-free — vitest-coverable outside React Native, and
 * Hermes-safe (chrono uses no `Intl`; verified under the RN Hermes VM, NEX-316).
 *
 * Two deliberate conservatism rules, because a resolved date can feed an
 * IRREVERSIBLE calendar write:
 *   1. A phrase that pins no calendar day (a time-only "at 5pm") returns null —
 *      we never invent a day. The signal is chrono's public `isCertain` API: at
 *      least one of day / weekday / month / year must be CERTAIN (explicitly
 *      named), not merely implied from the reference date.
 *   2. `ambiguous` is true for "next <weekday>" — colloquially this-coming vs the
 *      following week. chrono picks one (the coming one); callers must NOT
 *      silently auto-execute an irreversible write off an ambiguous date.
 */

import * as chrono from 'chrono-node';
import { dateKeyOf } from './date-tokens';

export interface ChronoDateResolution {
  /** Naive-local `YYYY-MM-DD` (via dateKeyOf — never toISOString, which shifts the UTC boundary). */
  dateStr: string;
  /** True iff the phrase is a "next <weekday>" form (this-coming vs following week). */
  ambiguous: boolean;
}

// The single source of truth for "next <weekday>" detection — grammar-parser
// imports `isAmbiguousNextWeekday` rather than keeping its own copy. Full + common
// short weekday spellings.
const NEXT_WEEKDAY_RE =
  /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)\b/i;

/** True iff `text` names a "next <weekday>" (colloquially ambiguous) date. */
export function isAmbiguousNextWeekday(text: string): boolean {
  return NEXT_WEEKDAY_RE.test(text ?? '');
}

// The date-defining components. If chrono marks NONE of these certain (each
// explicitly mentioned, not implied from `now`), the phrase pinned no day.
const DATE_COMPONENTS = ['day', 'weekday', 'month', 'year'] as const;

/**
 * Resolve a single relative/explicit date from `text` relative to `now`, or null.
 *
 * - `chrono.parse(text, now, { forwardDate: true })`, then takes the sole result.
 * - Returns null when: chrono throws, there is no result, there is MORE THAN ONE
 *   result (conflicting dates — stay conservative), or the result pins no calendar
 *   day (a time-only phrase). Never throws.
 */
export function resolveChronoDate(text: string, now: Date): ChronoDateResolution | null {
  const input = text ?? '';
  try {
    const results = chrono.parse(input, now, { forwardDate: true });
    if (results.length !== 1) return null; // 0 = no date; >1 = conflicting, defer

    const start = results[0].start;
    // `isCertain(c)` is chrono's public "was this component explicitly named"
    // check (true iff `c` is a known, non-implied value). A time-only phrase like
    // "at 5pm" makes no date component certain, so it returns null; "next
    // thursday" makes the weekday certain. Public API — survives minor upgrades.
    const pinsADay = DATE_COMPONENTS.some((c) => start.isCertain(c));
    if (!pinsADay) return null;

    return {
      dateStr: dateKeyOf(start.date()),
      ambiguous: isAmbiguousNextWeekday(input),
    };
  } catch {
    return null;
  }
}
