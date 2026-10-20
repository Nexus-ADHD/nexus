// Composes a notification body from today's quote. Pure module (no RN imports)
// so the composition + rotation index are vitest-testable.
//
// NEX-277: the notification body is now JUST the line, wrapped in curly
// quotation marks so it reads as a quote (the owner's ask). The old
// "prompt question + aphorism" stack is gone. Morning shows no title (the quote
// stands alone under the app name); evening keeps a short motivational debrief
// cue as its title (EVENING_CUE_TITLE) over the quote.

import { QuotePool, QuoteType, selectQuote } from './notification-quote-pool';
import { QUOTE_SEED } from './notification-quote-seed';
import { isNotificationQuoteSafe } from './notification-quote-filter';
import { wisdomQuoteForSlot } from '../features/wisdom/wisdom-quotes';

/** Retained only as `knownPrompts` for the filter's duplicate-rejection — these
 *  strings no longer appear in any notification body. */
export const MORNING_PROMPT = 'What would make today a win?';
export const EVENING_PROMPT = 'How did today go? Debrief takes 60 seconds.';
export const NOTIFICATION_PROMPTS: readonly string[] = [MORNING_PROMPT, EVENING_PROMPT];

/** Evening notification title — the kept debrief cue, restyled to "grounded
 *  momentum" (NEX-277). Carries the 60-second affordance now that the body is a
 *  bare quote. Morning has no title (the quote stands alone). */
export const EVENING_CUE_TITLE = 'Close the day. 60 seconds.';

/** Day-of-year ordinal (local date; 1 on Jan 1) — drives the rotation slot. Only
 *  monotonicity within a year matters, so the exact base / DST lag / Jan-1 reset
 *  are cosmetic (they change which line shows, never correctness). */
export function dayOfYearIndex(d: Date): number {
  const startOfYear = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - startOfYear.getTime()) / 86_400_000);
}

/**
 * Wrap today's line in curly quotation marks for the notification body. A
 * null/empty line falls back to the first seed line so the body is NEVER blank
 * (in practice selection can only return null if every seed is tombstoned, which
 * the UI doesn't allow — the UI removes AI lines only).
 */
export function composeQuoteBody(line: string | null | undefined): string {
  const text = line && line.trim().length > 0 ? line.trim() : QUOTE_SEED[0];
  return `“${text}”`; // “text”
}

/** Today's quote for a notification type, or null to fall back inside composeQuoteBody.
 *  `personalized` is the kill switch: false ⇒ curated seed floor only. */
export function quoteForToday(
  pool: QuotePool,
  type: QuoteType,
  now: Date,
  personalized?: boolean,
): string | null {
  return selectQuote(pool, dayOfYearIndex(now), type, {
    knownPrompts: [...NOTIFICATION_PROMPTS],
    personalized,
  });
}

// ── Today's-Wisdom source (one quote from the Orbit set) ───────────────────
// The daily nudges lead with a Today's-Wisdom line (generated from the user's
// today's win, the same set Orbit renders) when it exists for the local day.
// The pool rotation below remains the fallback.

/**
 * Wrap a Today's-Wisdom line for the notification body, WITH attribution:
 * `“quote” · Author` (author omitted when empty). The separator is a MIDDLE
 * DOT, not an em dash — §18.1 bans em dashes in user-facing copy, and the
 * notification body is user-facing. It is appended AFTER the safety filter
 * has validated the bare quote text, same as the curly-quote wrap. Orbit
 * always shows the author; the notification does too.
 */
export function composeWisdomBody(quote: string, author?: string): string {
  const q = quote.trim();
  const a = (author ?? '').trim();
  return a ? `“${q}” · ${a}` : `“${q}”`;
}

export interface ResolvedNotificationLine {
  /** The line to wrap for the body; null ⇒ caller uses the original prompt. */
  text: string | null;
  /** Present only for Today's-Wisdom lines (render via composeWisdomBody). */
  author?: string;
}

export interface ResolvedNotificationLines {
  morning: ResolvedNotificationLine;
  evening: ResolvedNotificationLine;
  /** Pool quotes actually consumed — the ONLY lines onQuotesSelected may mark
   *  shown. Wisdom-covered slots consume no pool line, so the NEX-277
   *  no-repeat `shown` map never advances for a line that wasn't shown. */
  poolQuotesUsed: string[];
}

/**
 * Resolve what the morning/evening notifications should say, purely.
 *
 * - `includeQuotes` off → both slots null (original prompts), pool untouched.
 * - Each slot gets its OWN wisdom set via `wisdomBySlot` (the caller dates
 *   them: morning leads with YESTERDAY's win — it fires before today's win
 *   exists — evening with TODAY's). A slot uses its wisdom set only when a
 *   quote exists for the slot AND the text passes `isNotificationQuoteSafe` —
 *   the NEX-277 filter is the SOLE safety guard for the lock screen, so a
 *   wisdom line that fails it (em dash, `?`, >100 chars, banned framing)
 *   falls back to the pool for that slot only.
 * - No wisdom for a slot (including the lapsed-user case — no win ever set) →
 *   the pool rotation covers it: the curated seed floor is the always-there
 *   motivational fallback.
 * - Pool draws go through the existing rotation (`quoteForToday`).
 */
export function resolveNotificationLines(opts: {
  includeQuotes: boolean;
  wisdomBySlot?: {
    morning?: { quote: string; author: string }[];
    evening?: { quote: string; author: string }[];
  };
  pool: QuotePool;
  now: Date;
  personalized?: boolean;
}): ResolvedNotificationLines {
  const none: ResolvedNotificationLines = {
    morning: { text: null },
    evening: { text: null },
    poolQuotesUsed: [],
  };
  if (!opts.includeQuotes) return none;

  const slots: { type: QuoteType; slot: 0 | 1 }[] = [
    { type: 'morning', slot: 0 },
    { type: 'evening', slot: 1 },
  ];
  const out: ResolvedNotificationLines = { ...none, morning: { text: null }, evening: { text: null } };
  for (const { type, slot } of slots) {
    const wisdom = opts.wisdomBySlot?.[type];
    const w = wisdom ? wisdomQuoteForSlot(wisdom, slot) : undefined;
    if (w && isNotificationQuoteSafe(w.quote, [...NOTIFICATION_PROMPTS])) {
      out[type] = { text: w.quote, author: w.author };
      continue;
    }
    const poolLine = quoteForToday(opts.pool, type, opts.now, opts.personalized);
    out[type] = { text: poolLine };
    if (poolLine) out.poolQuotesUsed.push(poolLine);
  }
  return out;
}
