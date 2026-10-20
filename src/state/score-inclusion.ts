/**
 * Habit score-inclusion logic (NEX-171).
 *
 * Replaces the confusing `pinnedHabits` opt-in scoring filter (empty-set means
 * ALL — an inversion) with a per-rule `excludedFromScore` flag: a paused habit
 * never counts toward the daily score, unconditionally.
 *
 * `pinnedHabits` is kept (derived = non-excluded rule ids) for one release so
 * the native widget + cross-version cloud sync keep working — see the bridges
 * and mergeCloudState. NEX-171b removes the legacy key natively.
 *
 * Pure — no RN imports; unit-tested in the pure-Node vitest suite.
 */
import { normalize, stripEmoji } from '../utils/text';

interface RuleLike {
  id?: string;
  title?: string;
  excludedFromScore?: boolean;
}

// Match key: lowercase/trim/NFC (normalize) AND emoji-stripped — pins from
// onboarding stored raw titles that may predate the v3 emoji-strip, so a bare
// normalize() would miss '🧘 Meditation' vs 'Meditation'.
const key = (x: unknown): string => normalize(stripEmoji(String(x ?? '')));

/** Emoji-/case-insensitive id-or-title pin match — robust to the onboarding
 *  title-pins + the rename re-key, where a raw match would miss. */
export function isPinnedNormalized(rule: RuleLike | null | undefined, pinnedHabits: unknown): boolean {
  if (!rule || !Array.isArray(pinnedHabits)) return false;
  const keys = new Set(pinnedHabits.filter((p): p is string => typeof p === 'string').map(key));
  if (keys.size === 0) return false;
  return (
    (rule.id !== undefined && keys.has(key(rule.id))) ||
    (rule.title !== undefined && keys.has(key(rule.title)))
  );
}

/**
 * Migration mapping: stamp `excludedFromScore` from the legacy `pinnedHabits`,
 * preserving each cohort's current scoring intent.
 * - ≥1 pinned → a rule is excluded iff it is NOT pinned.
 * - 0 pinned  → nothing excluded (everything counted — matches old behavior).
 * Idempotent: rules that already carry an explicit flag are left as-is.
 */
export function migratePinsToExcluded<T extends RuleLike>(
  rules: T[] | undefined,
  pinnedHabits: unknown,
): Array<T & { excludedFromScore: boolean }> {
  if (!Array.isArray(rules)) return [];
  const hasPins = Array.isArray(pinnedHabits) && pinnedHabits.some((p) => typeof p === 'string' && p.length > 0);
  return rules.map((r) => {
    if (typeof r.excludedFromScore === 'boolean') return r as T & { excludedFromScore: boolean };
    return { ...r, excludedFromScore: hasPins ? !isPinnedNormalized(r, pinnedHabits) : false };
  });
}

/** Derived legacy `pinnedHabits` payload = non-excluded rule ids (schedule-
 *  agnostic, so the native widget's own schedule filtering + rollover hold). */
export function deriveActiveHabitIds(rules: RuleLike[] | undefined): string[] {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => !r.excludedFromScore && typeof r.id === 'string')
    .map((r) => r.id as string);
}
