// Pure staleness predicate for Today's Wisdom (Orbit tab).
//
// Extracted so it can be unit-tested in the pure-Node vitest suite (the RN
// screen and the zustand store can't be imported there). The Orbit screen
// derives the inputs from `useAppState.getState()` and feeds them here.
//
// Wisdom is a once-per-day cache that is ALSO re-rolled when "today's win"
// (morningIntention) changes — so a missed regen is what made it look stale
// until an app restart. The intention clause only applies when wisdom is
// enabled (expectedCount > 0); a disabled feature must never churn.

export interface WisdomStalenessInput {
  /** wisdomQuoteCount, clamped to >= 0. 0 means the feature is disabled. */
  expectedCount: number;
  /** The day the cached quotes were generated for (YYYY-MM-DD). */
  dailyWisdomDate: string;
  /** The today's-win the cached quotes were generated for ('' = no win). */
  dailyWisdomIntention: string | null;
  /** The cached quotes. Unknown shape tolerated — only length/quote checked. */
  quotes: unknown;
  /** Today's date key (YYYY-MM-DD). */
  todayKey: string;
  /** The current today's-win ('' = no win set today). */
  currentIntention: string;
}

export function wisdomIsStale(input: WisdomStalenessInput): boolean {
  const { expectedCount, dailyWisdomDate, dailyWisdomIntention, quotes, todayKey, currentIntention } = input;
  const q = quotes as Array<{ quote?: unknown } | null | undefined> | unknown;

  // Disabled: stale only if leftover quotes need clearing. Never consults the
  // win here — a changed win must not trigger work for a disabled feature.
  if (expectedCount === 0) {
    return Array.isArray(q) && q.length > 0;
  }

  // Normalize both sides: trim (writers are inconsistent — some trim, some
  // don't) and treat a legacy `null` cache marker as '' so existing users
  // with no win get zero spurious regen on upgrade.
  const storedWin = (dailyWisdomIntention ?? '').trim();
  const currentWin = (currentIntention ?? '').trim();

  return (
    dailyWisdomDate !== todayKey ||
    !Array.isArray(q) ||
    q.length !== expectedCount ||
    q.some((x) => !(x && typeof (x as { quote?: unknown }).quote === 'string' && (x as { quote?: unknown }).quote)) ||
    storedWin !== currentWin
  );
}
