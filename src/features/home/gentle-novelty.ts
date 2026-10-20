/**
 * gentle-novelty.ts — NEX-214 (L-3)
 *
 * Gentle novelty in COPY only (never new mechanics): the THIS WEEK / Focus
 * fallback line — shown when a user has no weekly reflection yet — rotates
 * weekly instead of repeating one fixed string, easing the two-week habituation
 * wall. RN-free so the rotation + §18 copy compliance are unit-testable.
 *
 * Even-cycling by whole-weeks-since-epoch (NOT a hash, which can cluster over
 * near-sequential date keys): stable within a week, advances one line each week.
 */

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole weeks from the Unix epoch to a YYYY-MM-DD key (UTC, DST-safe). -1 if unparseable. */
export function weeksSinceEpoch(sundayKey: string): number {
  const m = typeof sundayKey === 'string' ? sundayKey.match(DATE_KEY_RE) : null;
  if (!m) return -1;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  // Date.UTC silently rolls impossible parts over (2026-13-40 -> 2027-02-09),
  // so a corrupt key would return a rotated index instead of the options[0]
  // safety path. Round-trip the result and reject any key that did not survive.
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) {
    return -1;
  }
  return Math.floor(ms / MS_PER_WEEK);
}

/**
 * Even-cycling weekly pick. Stable within a week, rotates through every option
 * in order across weeks. Empty options -> ''. Unparseable key -> options[0].
 */
export function weeklyFallback(options: readonly string[], sundayKey: string): string {
  if (!Array.isArray(options) || options.length === 0) return '';
  const w = weeksSinceEpoch(sundayKey);
  if (w < 0) return options[0];
  return options[w % options.length];
}

/**
 * THIS WEEK / Focus fallback lines. DECLARATIVE forward framing — no leading
 * imperative verb, no second person (you/your), no em dash, no exclamation
 * (§18). Keeps the register of the original single fallback.
 */
export const FOCUS_FALLBACKS: readonly string[] = [
  'A fresh week to build on.',
  'A new week, freshly turned.',
  'The week ahead is open.',
  'Seven days, unspent.',
  'A quiet page, still blank.',
  'The start of another week.',
];
