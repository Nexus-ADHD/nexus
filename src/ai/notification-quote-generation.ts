// Thin app-side adapter: tops up the notification-quote pool with on-voice,
// PERSONALIZED AI lines, throttled. All the logic (throttle, filter, dedupe,
// never-throw) lives in the engine's generateInto — this only wires the RN
// chatCompletion into the engine's injected `chat` signature, so it stays
// decoupled + the engine stays vitest-testable. NEX-277: generated lines land in
// `pending` and auto-schedule once filter-safe (no human gate); the filter +
// curated floor + kill switch + tombstone are the guards. Spec:
// docs/plans/notification-quotes.md.

import { chatCompletion } from '../utils/ai-client';
// NEX-305: name the tier explicitly instead of riding the shared default.
import { MODELS } from '../utils/ai-models';
import { generateInto } from './notification-quote-generator';
import { type QuotePool } from './notification-quote-pool';
import { NOTIFICATION_PROMPTS } from './notification-quote-compose';

const GENERATE_OPTS = {
  targetPoolSize: 28, // ≥ 2 fires/day × the 14-day no-repeat window
  cooldownMs: 6 * 60 * 60 * 1000, // at most one batch every 6h, across launches
  count: 6, // lines requested per batch
  knownPrompts: [...NOTIFICATION_PROMPTS],
};

// Engine wants chat:(prompt)=>Promise<string>; ai-client takes a messages array.
async function chat(prompt: string): Promise<string> {
  return chatCompletion([{ role: 'user', content: prompt }], {
    model: MODELS.DAILY_PULSE,
  });
}

/**
 * Top up the pool when the throttle allows, personalizing from `mandates` (the
 * caller passes the capped/sanitized active mandate titles via mandateContext()).
 * Never throws (the engine swallows chat failures and advances lastGenAtMs).
 * Returns the (possibly unchanged) pool for the caller to fold via mergeGeneratedQuotes.
 */
export async function generateQuotesIntoPool(
  pool: QuotePool,
  mandates: string[] = [],
): Promise<QuotePool> {
  return generateInto(pool, { chat, nowMs: Date.now() }, { ...GENERATE_OPTS, mandates });
}
