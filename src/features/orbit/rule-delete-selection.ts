/**
 * Which recurring rule(s) a "delete this block" action may remove.
 *
 * Pure so vitest (node-only, no RN runtime) covers it — orbit.tsx is
 * @ts-nocheck and cannot be imported by the test runner.
 *
 * WHY THIS IS NARROW. The delete used to remove the acted-on rule PLUS every
 * rule matching the rendered row by normalized title and ±5 minutes — a check
 * that defaults to "close enough" when either clock is unparseable. Two
 * genuinely distinct routines sharing a title ("Read" at 8:00 and "Read" at
 * 8:03, or two with no parseable time) were therefore both destroyed when the
 * user deleted one of them.
 *
 * The rendered row carries the authoritative rule id, so that wins outright.
 * Title/time matching survives only for rows that lack one, and only when it
 * resolves to exactly one rule. An ambiguous match deletes NOTHING: refusing
 * is recoverable, deleting someone's other routine is not.
 */

export type RuleDeleteOutcome = 'explicit' | 'unique-match' | 'ambiguous' | 'stale' | 'none';

export type RuleDeleteSelection = {
  ids: string[];
  outcome: RuleDeleteOutcome;
};

export function selectRuleIdsToDelete(args: {
  /** `recurringRuleId` from the rendered row, when it has one. */
  explicitId?: string | null;
  /** Ids of all rules currently in the store. */
  existingIds: readonly string[];
  /** Ids matching the row by title/time (the fuzzy fallback). */
  matchedIds: readonly string[];
}): RuleDeleteSelection {
  const existing = new Set(args.existingIds);

  // The row told us exactly which rule it is. Nothing else is considered —
  // in particular, other rules that merely LOOK like it are left alone.
  if (args.explicitId) {
    if (existing.has(args.explicitId)) {
      return { ids: [args.explicitId], outcome: 'explicit' };
    }
    // The row named a rule that no longer exists — a stale render. Delete
    // NOTHING. Falling through to title/time matching here would honour a
    // request to delete rule X by deleting some other live routine that merely
    // resembles it, which is the exact failure this module exists to prevent.
    // An identified-but-absent rule has already been deleted; there is nothing
    // left to do.
    return { ids: [], outcome: 'stale' };
  }

  const matches = Array.from(new Set(args.matchedIds.filter((id) => existing.has(id))));
  if (matches.length === 1) return { ids: matches, outcome: 'unique-match' };
  if (matches.length > 1) return { ids: [], outcome: 'ambiguous' };
  return { ids: [], outcome: 'none' };
}
