import { normalize, stripEmoji } from './text';

export interface ReconcileRuleLike {
  title?: string | null;
}

export interface ReconcileLogLike {
  habitTitle?: string | null;
}

interface RuleKeyIndex {
  /** normalize(title) for every live rule. */
  liveKeys: Set<string>;
  /** emoji-stripped key -> the single live key it maps to (ambiguous excluded). */
  strippedToLive: Map<string, string>;
  /** stripped keys two+ live rules collapse to — never auto-remapped. */
  ambiguous: Set<string>;
}

/**
 * Build the emoji-insensitive matching index used by both the log and the
 * scalar-map reconcilers, so the two can never drift apart. A stripped key
 * that maps to more than one live key is ambiguous and is excluded from the
 * index entirely (we leave such entries alone rather than guess).
 */
function buildRuleKeyIndex(rules: ReconcileRuleLike[]): RuleKeyIndex {
  const liveKeys = new Set<string>();
  const strippedToLive = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const rule of rules) {
    const liveKey = normalize(rule?.title);
    if (!liveKey) continue;
    liveKeys.add(liveKey);
    const strippedKey = normalize(stripEmoji(String(rule?.title ?? '')));
    if (!strippedKey) continue;
    const existing = strippedToLive.get(strippedKey);
    if (existing !== undefined && existing !== liveKey) {
      ambiguous.add(strippedKey);
      // Drop the stale first-seen mapping so the two structures stay
      // consistent by construction, not just by the ambiguous.has guard.
      strippedToLive.delete(strippedKey);
    } else {
      strippedToLive.set(strippedKey, liveKey);
    }
  }
  return { liveKeys, strippedToLive, ambiguous };
}

/**
 * Re-attach habit-log entries that were orphaned when a rule's title
 * changed in a way that differs only by emoji.
 *
 * Background: the v3 "Stellar" UI push stripped emoji out of habit
 * titles via `renameRecurringRule`. That path migrated `goalHabitMap`
 * (NEX-76) but NOT `habitLog`. Log entries store the *normalized title
 * captured at completion time* (e.g. emoji + "meditation"), and every
 * schedule-aware percentage matches a log to its rule by
 * `normalize(log.habitTitle) === normalize(rule.title)`. Once the rule
 * became "Meditation", every pre-rename completion stopped matching and
 * silently dropped out of the Weekly/Monthly/etc. debrief — a daily
 * habit could read ~29% despite an unbroken record.
 *
 * Matching here is emoji-insensitive. A log is only relabeled when:
 *   - it is NOT already on a live rule key (don't touch healthy logs), and
 *   - its emoji-stripped key matches exactly one current rule key.
 *
 * Ambiguous stripped keys are left alone. Pure and idempotent: a second
 * pass is a no-op, and the original array reference is returned when
 * nothing changed.
 */
export function reconcileHabitLogToRules<T extends ReconcileLogLike>(
  habitLog: T[] | null | undefined,
  recurringRules: ReconcileRuleLike[] | null | undefined,
): T[] {
  const log = Array.isArray(habitLog) ? habitLog : [];
  const rules = Array.isArray(recurringRules) ? recurringRules : [];
  if (log.length === 0 || rules.length === 0) return log;

  const { liveKeys, strippedToLive, ambiguous } = buildRuleKeyIndex(rules);

  let mutated = false;
  const next = log.map((entry) => {
    const currentKey = normalize(entry?.habitTitle);
    // Already attached to a live rule, or unkeyed — leave untouched.
    if (!currentKey || liveKeys.has(currentKey)) return entry;

    const strippedKey = normalize(stripEmoji(String(entry?.habitTitle ?? '')));
    if (!strippedKey || ambiguous.has(strippedKey)) return entry;

    const target = strippedToLive.get(strippedKey);
    if (!target || target === currentKey) return entry;

    mutated = true;
    // Cast: spreading a generic T and overriding one key widens to
    // Omit<T,'habitTitle'> & {habitTitle:string}, which strict TS won't
    // accept as T. All fields are structurally preserved, so this is safe.
    return { ...entry, habitTitle: target } as T;
  });

  return mutated ? next : log;
}

/**
 * Re-key a title-keyed scalar map (`habitStreaks`,
 * `habitStreakUpdatedDate`, `habitStrength`) the same way
 * `reconcileHabitLogToRules` re-keys the log, so the v25 one-time
 * migration repairs streak/strength history alongside completion %.
 *
 * These maps are keyed by `normalize(title)`, so the v3 emoji strip
 * orphaned them exactly like the log: after the rename the app reads
 * `habitStreaks["meditation"]`, finds nothing under the live key, and a
 * real streak silently resets to 0. This moves an orphaned entry onto its
 * live key when the emoji-stripped key matches exactly one rule.
 *
 * No-clobber: if the live key already holds a value (e.g. a streak that
 * rebuilt under the new title post-rename), that live value wins and the
 * stale orphan is dropped — mirroring `moveScalarKey` in
 * `renameRecurringRule`. Pure and idempotent; returns the original
 * reference when nothing changed.
 */
export function reconcileTitleKeyedMap<V>(
  map: Record<string, V> | null | undefined,
  recurringRules: ReconcileRuleLike[] | null | undefined,
): Record<string, V> {
  const src = map && typeof map === 'object' ? map : {};
  const rules = Array.isArray(recurringRules) ? recurringRules : [];
  const keys = Object.keys(src);
  if (keys.length === 0 || rules.length === 0) return src;

  const { liveKeys, strippedToLive, ambiguous } = buildRuleKeyIndex(rules);

  let mutated = false;
  const next: Record<string, V> = { ...src };
  for (const key of keys) {
    const currentKey = normalize(key);
    // Already on a live rule key, or unkeyed — leave untouched.
    if (!currentKey || liveKeys.has(currentKey)) continue;

    const strippedKey = normalize(stripEmoji(key));
    if (!strippedKey || ambiguous.has(strippedKey)) continue;

    const target = strippedToLive.get(strippedKey);
    if (!target || target === currentKey) continue;

    // No-clobber: a live value under the target key wins; just drop the
    // stale orphan. Otherwise move the orphaned value onto the live key.
    if (!(target in next)) next[target] = src[key];
    delete next[key];
    mutated = true;
  }

  return mutated ? next : src;
}
