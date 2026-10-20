/**
 * receptivity.ts — NEX-212 (N-3)
 *
 * Receptivity-aware notification timing. Firing a reminder when the user is
 * non-receptive drops future response ~30% per ignored reminder, so the daily
 * morning/evening prompts are nudged toward the hours the user tends to launch
 * the app — within a tight, conservative window, and never when the user has
 * forced a fixed time ("Smart timing" off).
 *
 * RN-free so the histogram math + the nudge heuristic are unit-testable. The
 * passive signal (a 24-slot launch-hour histogram) is recorded device-locally
 * in app-state and read at schedule time; this module never touches the store.
 *
 * Conservatism is the whole point (§1.5 Law D — an ADHD user leans on
 * predictable reminders): the nudge only moves within ±WINDOW hours, never
 * wraps across midnight, needs MIN_SAMPLES of data and a clear MARGIN lead
 * before it moves at all, and falls back to the configured hour on any doubt.
 */

const HOURS = 24;

/** Once the histogram total exceeds this, halve every slot (rolling decay) so
 *  the signal stays recent-weighted and bounded. */
export const OPEN_HISTORY_CAP = 240;
/** Minimum total samples before the nudge will move off the configured hour. */
export const MIN_SAMPLES = 14;
/** Half-width of the nudge window, in hours (±WINDOW around the configured hour). */
export const WINDOW = 2;
/** A candidate hour must beat the configured hour's count by at least this much
 *  before the nudge moves to it. Conservative — ties never move. */
export const MARGIN = 3;

/**
 * Coerce any input into a clean HOURS-length array of finite non-negative ints.
 * A persisted/cloud-restored array could be the wrong length or carry
 * NaN/null/string slots; both public fns route through this so a malformed
 * input can never throw or skew the result.
 */
function normalizeCounts(counts: unknown): number[] {
  const out = new Array<number>(HOURS).fill(0);
  if (!Array.isArray(counts)) return out;
  for (let i = 0; i < HOURS; i++) {
    const v = Number(counts[i]);
    out[i] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

function total(counts: number[]): number {
  let sum = 0;
  for (let i = 0; i < HOURS; i++) sum += counts[i];
  return sum;
}

/**
 * Record one app launch at `hour` (0-23). Returns a fresh normalized 24-slot
 * array. An out-of-range hour is a no-op (returns the normalized counts). When
 * the total exceeds OPEN_HISTORY_CAP, every slot is halved first (rolling decay)
 * so old behavior fades and the array stays bounded — halving only ever fires
 * when total > CAP, and post-halve total drops to roughly CAP/2, so it can't
 * oscillate (halve-every-launch).
 */
export function recordOpenHour(counts: unknown, hour: number): number[] {
  let next = normalizeCounts(counts);
  if (total(next) > OPEN_HISTORY_CAP) {
    next = next.map((c) => Math.floor(c / 2));
  }
  if (Number.isInteger(hour) && hour >= 0 && hour < HOURS) {
    next[hour] += 1;
  }
  return next;
}

export interface ChooseReceptiveHourOptions {
  /** Smart timing is off — the user forced fixed times; never nudge. */
  forced?: boolean;
}

/**
 * Pick the hour to actually fire at, given the user's configured hour and the
 * launch-hour histogram. Conservative: returns `configuredHour` unless there is
 * clear, recent, nearby evidence the user is more receptive at another hour.
 *
 * - forced (Smart timing off) -> configuredHour.
 * - fewer than MIN_SAMPLES total -> configuredHour (not enough signal).
 * - otherwise search the inclusive, clamped window [h-WINDOW .. h+WINDOW]
 *   (no day-wrap — a morning prompt can never drift into the night) and move to
 *   the densest hour ONLY if it beats the configured hour's own count by MARGIN.
 *   Ties, a uniform/empty window, or an insufficient lead -> configuredHour.
 *
 * Always returns an integer hour in [0,23]; the caller keeps the configured minute.
 */
export function chooseReceptiveHour(
  configuredHour: number,
  counts: unknown,
  opts: ChooseReceptiveHourOptions = {},
): number {
  const h = Number.isInteger(configuredHour) ? configuredHour : 0;
  const safeConfigured = Math.min(HOURS - 1, Math.max(0, h));
  if (opts.forced) return safeConfigured;

  const c = normalizeCounts(counts);
  if (total(c) < MIN_SAMPLES) return safeConfigured;

  const lo = Math.max(0, safeConfigured - WINDOW);
  const hi = Math.min(HOURS - 1, safeConfigured + WINDOW);
  const configuredCount = c[safeConfigured];

  let bestHour = safeConfigured;
  let bestCount = configuredCount;
  for (let i = lo; i <= hi; i++) {
    if (c[i] > bestCount) {
      bestCount = c[i];
      bestHour = i;
    }
  }

  // Only move if the winner clearly beats the configured hour (conservative).
  if (bestHour !== safeConfigured && bestCount - configuredCount >= MARGIN) {
    return bestHour;
  }
  return safeConfigured;
}
