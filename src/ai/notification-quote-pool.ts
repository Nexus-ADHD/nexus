// Pure pool + rotation logic for notification quotes. No React Native imports
// (vitest-testable). Spec: docs/plans/notification-quotes.md (S8–S12, S22, S24)
// + the NEX-277 supersession note (auto-use, kill switch, tombstone).
//
// NEX-277 changed the model: AI lines AUTO-SCHEDULE once filter-safe — there is
// no human approval gate. Selection draws from (`live` ∪ `pending` ∪ seed),
// minus a `removed` tombstone, re-validated against the filter NOW. The
// `pending`/`live` split is retained only for persisted-shape compatibility:
// both arrays are schedulable. Generation still appends to `pending` (the merge
// path in app-state is unchanged). A `personalized:false` kill switch restricts
// selection to the curated seed floor. `mandateHash` lets the caller evict
// stale personalized lines when the user's mandates change.

import { isNotificationQuoteSafe } from './notification-quote-filter';
import { QUOTE_SEED } from './notification-quote-seed';

export type QuoteType = 'morning' | 'evening';

export interface QuotePool {
  live: string[]; // legacy approved lines — still schedulable (no new writes post-NEX-277)
  pending: string[]; // AI lines; schedulable as soon as filter-safe (name kept for persisted compat)
  shown: Record<string, number>; // quote -> last dayIndex it was shown (no-repeat)
  lastGenAtMs: number; // last generation ATTEMPT time (throttle)
  removed: string[]; // tombstone: lines the owner deleted — never selected, never re-added (NEX-277)
  mandateHash: string; // hash of the mandate context the AI lines were generated from (staleness, NEX-277)
}

export const NO_REPEAT_DAYS = 14;
/** Distinct per-type offset so Morning and Evening never collide on the same day (S8). */
const TYPE_OFFSET: Record<QuoteType, number> = { morning: 0, evening: 1 };

export function emptyPool(): QuotePool {
  return { live: [], pending: [], shown: {}, lastGenAtMs: 0, removed: [], mandateHash: '' };
}

/**
 * Coerce an untrusted persisted value into a valid QuotePool — a corrupted write
 * (e.g. non-array `live`/`pending`) must not pass through and crash selection.
 * `removed`/`mandateHash` are NEX-277 additions: a pre-NEX-277 persisted pool
 * lacks them, so they DEFAULT (never reject the whole pool for their absence).
 */
export function sanitizeQuotePool(raw: unknown): QuotePool {
  const p = raw as Partial<QuotePool> | null | undefined;
  if (
    !p ||
    typeof p !== 'object' ||
    !Array.isArray(p.live) ||
    !Array.isArray(p.pending) ||
    !p.shown ||
    typeof p.shown !== 'object' ||
    Array.isArray(p.shown) ||
    typeof p.lastGenAtMs !== 'number' ||
    !Number.isFinite(p.lastGenAtMs)
  ) {
    return emptyPool();
  }
  return {
    live: p.live.filter((x): x is string => typeof x === 'string'),
    pending: p.pending.filter((x): x is string => typeof x === 'string'),
    shown: Object.fromEntries(
      Object.entries(p.shown).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
    ) as Record<string, number>,
    lastGenAtMs: p.lastGenAtMs,
    removed: Array.isArray(p.removed) ? p.removed.filter((x): x is string => typeof x === 'string') : [],
    mandateHash: typeof p.mandateHash === 'string' ? p.mandateHash : '',
  };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/** Canonical form of any stored / compared quote string: trimmed. The pool keys
 *  everything (shown map, dedupe, removal matching) on this so a stray-whitespace
 *  variant never desyncs from its trimmed twin. */
const canon = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');

export interface SelectOpts {
  /** Notification prompt strings, rejected so a quote can't duplicate the line it sits under. */
  knownPrompts?: string[];
  /** Kill switch (NEX-277): false ⇒ curated seed floor only; true/undefined ⇒ AI lines + seed. */
  personalized?: boolean;
}

/**
 * Currently-safe candidate set, canonicalized + re-validated against the filter
 * NOW (S22), minus the `removed` tombstone. With `personalized:false` only the
 * curated seed is eligible (the kill switch). May be empty — caller treats empty
 * as "no quote available".
 */
function safeCandidates(pool: QuotePool, opts?: SelectOpts): string[] {
  const removed = new Set(pool.removed.map(canon));
  const personalized = opts?.personalized !== false; // default ON (auto-use)
  // Both `live` and `pending` are schedulable post-NEX-277; seed is the floor.
  const sources = personalized ? [...pool.live, ...pool.pending, ...QUOTE_SEED] : [...QUOTE_SEED];
  const merged = dedupe(sources.map(canon)).filter((q) => q.length > 0 && !removed.has(q));
  return merged.filter((q) => isNotificationQuoteSafe(q, opts?.knownPrompts));
}

/**
 * Deterministic selection per (dayIndex, type). Prefers lines not shown within
 * the no-repeat window; returns a safe trimmed string, or null if no safe
 * non-duplicate line exists (caller then omits the quote) (S8, S9, S10, S22).
 */
export function selectQuote(
  pool: QuotePool,
  dayIndex: number,
  type: QuoteType,
  opts?: SelectOpts,
): string | null {
  const safe = safeCandidates(pool, opts);
  if (!safe.length) return null;
  const notRecent = safe.filter(
    (q) => dayIndex - (pool.shown[q] ?? Number.NEGATIVE_INFINITY) >= NO_REPEAT_DAYS,
  );
  // Need ≥2 choices so morning/evening (adjacent slots) can't collide on the same
  // day (S8). The no-repeat window can shrink `notRecent` to 1 even when `safe`
  // still has ≥2 — so fall back to the full safe set rather than let the day repeat.
  // GRACEFUL DEGRADATION: a full 14-day no-repeat at 2 fires/day needs ≥28 lines;
  // the seed floor alone can't reach that, so a small pool repeats sooner (never
  // blocks). Once the auto-used AI pool grows past ~28 the full window is honored.
  const choices = notRecent.length >= 2 ? notRecent : safe; // safe is non-empty here
  const slot = dayIndex * 2 + TYPE_OFFSET[type];
  return choices[((slot % choices.length) + choices.length) % choices.length];
}

/** Record that `quote` was shown on `dayIndex` (drives the no-repeat window). Pure. */
export function markShown(pool: QuotePool, quote: string, dayIndex: number): QuotePool {
  return { ...pool, shown: { ...pool.shown, [canon(quote)]: dayIndex } };
}

/**
 * Add AI candidates: filter pre-screen → `pending` (deduped against existing
 * live+pending+seed AND the `removed` tombstone, so a line the owner deleted can
 * never be re-added by the next generation cycle). Rejected candidates are dropped.
 */
export function addCandidates(
  pool: QuotePool,
  candidates: string[],
  knownPrompts?: string[],
): QuotePool {
  // Existing = live + pending + the always-selectable SEED + tombstone, all
  // canonicalized, so a candidate already present (even untrimmed, even a seed
  // line, even a previously-removed one) isn't re-added.
  const existing = new Set([...pool.live, ...pool.pending, ...QUOTE_SEED, ...pool.removed].map(canon));
  // Canon BEFORE dedupe so "line." and " line. " collapse to one entry.
  const fresh = dedupe(candidates.map(canon)).filter(
    (c) => c.length > 0 && isNotificationQuoteSafe(c, knownPrompts) && !existing.has(c),
  );
  return { ...pool, pending: [...pool.pending, ...fresh] };
}

/**
 * Remove a line the owner deleted (NEX-277): tombstone it (so the next generation
 * cycle can't resurrect it via addCandidates) AND drop it from both schedulable
 * arrays. Works on seed lines too (a tombstoned seed line stops appearing).
 */
export function removeQuote(pool: QuotePool, lines: string[]): QuotePool {
  const drop = new Set(lines.map(canon));
  return {
    ...pool,
    live: pool.live.filter((q) => !drop.has(canon(q))),
    pending: pool.pending.filter((q) => !drop.has(canon(q))),
    removed: dedupe([...pool.removed.map(canon), ...lines.map(canon)].filter((x) => x.length > 0)),
  };
}

/**
 * Evict stale personalized AI lines when the mandate context changes (NEX-277).
 * If `newHash` differs from the stored one, clear the AI arrays (`live`+`pending`)
 * so lines generated from old/edited/deleted mandates stop firing; `shown`,
 * `removed`, and the seed floor are preserved. Generation refills under the new
 * context. A no-op when the hash is unchanged.
 */
export function evictForMandateChange(pool: QuotePool, newHash: string): QuotePool {
  if (newHash === pool.mandateHash) return pool;
  return { ...pool, live: [], pending: [], mandateHash: newHash };
}

export interface ThrottleOpts {
  /** Don't generate while at least this many schedulable lines exist. */
  targetPoolSize: number;
  /** Minimum ms between generation attempts (cooldown across launches). */
  cooldownMs: number;
}

/**
 * Pure throttle decision (S24): generate only when the pool is low AND the
 * cooldown has elapsed. The impure caller does the actual chatCompletion +
 * persistence and records `lastGenAtMs`.
 */
export function shouldGenerate(
  pool: QuotePool,
  nowMs: number,
  opts: ThrottleOpts,
  knownPrompts?: string[],
): boolean {
  // Count USABLE UNIQUE lines (trimmed + filter-passing, minus the tombstone):
  // a pool of now-invalid persisted lines must still refill (they're skipped at
  // selection), and 20 copies of one valid quote is effectively ONE usable line.
  const removed = new Set(pool.removed.map(canon));
  const usable = new Set(
    [...pool.live, ...pool.pending]
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter((q) => q.length > 0 && !removed.has(q) && isNotificationQuoteSafe(q, knownPrompts)),
  ).size;
  if (usable >= opts.targetPoolSize) return false;
  if (nowMs - pool.lastGenAtMs < opts.cooldownMs) return false;
  return true;
}
