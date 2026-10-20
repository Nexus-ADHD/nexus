/**
 * Shared retry policy for outbound HTTP.
 *
 * These constants and predicates lived privately inside `ai-client.ts`. PLAUD's
 * integration guidance asks for "appropriate retry and backoff behavior" on
 * rate-limit and transient errors, and the PLAUD MCP client needed the same
 * rules — so they are extracted here rather than copied, and both callers point
 * at one definition. A retry policy that exists twice drifts.
 *
 * Pure and RN-free on purpose, so vitest can cover it directly.
 */

/** Total attempts including the first. Two retries after the initial try. */
export const MAX_RETRY_ATTEMPTS = 3;

/** Base delay before attempt N+1, in ms. The last value repeats if attempts grow. */
export const RETRY_BACKOFF_MS = [300, 800, 1800];

/** Fraction of the base delay applied as +/- random jitter. */
export const RETRY_JITTER = 0.2;

/**
 * Statuses worth retrying: the request may succeed unchanged if repeated.
 *
 * Deliberately EXCLUDES 401. PLAUD's 401 means the access token expired, and
 * `plaud-client.ts` handles it a layer up by refreshing the token and reissuing
 * the call. Retrying here with the same stale token would burn the budget and
 * delay that refresh. Other 4xx are caller errors and will fail identically on
 * a retry, so they fail fast.
 */
export const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay before the attempt after `attemptIndex` (0-based).
 *
 * `rand` is injectable so the jitter is testable; production passes nothing.
 */
export function retryDelayMs(attemptIndex: number, rand: () => number = Math.random): number {
  const base = RETRY_BACKOFF_MS[Math.min(attemptIndex, RETRY_BACKOFF_MS.length - 1)];
  const jitter = base * RETRY_JITTER * (rand() * 2 - 1);
  return Math.max(0, base + jitter);
}

/**
 * Whether a thrown fetch error is worth retrying.
 *
 * React Native's fetch throws on network failure, which is retryable. An
 * `AbortError` is NOT: it means our own timeout or a user cancellation fired,
 * and retrying would ignore the deadline the caller set.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  return err instanceof Error;
}
