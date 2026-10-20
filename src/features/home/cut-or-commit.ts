/**
 * cut-or-commit.ts — NEX-201 (H-7/I-3)
 *
 * Pure selection for Home's "Cut or Commit" section: the few oldest inbox items
 * still awaiting a decision. Kept RN-free (no Date.now() inside, no token/RN
 * imports) so the Node vitest suite can cover it directly, like return-lapse.ts.
 *
 * Design: this surface stays a CALM, scarce decision prompt (gold attention,
 * never a red day-counter / "overdue since"). Aging is conveyed by ORDER alone
 * (oldest rises to the top) — nothing here counts days of inaction (§1.5 Law C).
 */

/** Items older than this (still untriaged) become eligible to surface. */
export const CUT_OR_COMMIT_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Display cap — the signal stays scarce; only the few oldest show. */
export const CUT_OR_COMMIT_CAP = 3;

interface CutOrCommitItem {
  status?: string;
  completed?: boolean;
  triagedSkip?: boolean;
  createdAt?: number;
}

/**
 * The few oldest inbox items awaiting a decision, oldest-first, capped for
 * display. `now` is passed (not read inside) so the selection is deterministic
 * and unit-testable. `cap` is the DISPLAY cap — Home uses the default; it is not
 * meant to be 0.
 *
 * Total order: createdAt ascending, then original inbox index (preserves the
 * user-visible order for equal timestamps — a stable, deterministic tiebreak).
 * The createdAt-finite check lives in the FILTER, so the comparator never sees
 * a missing/NaN timestamp. Strict `>` means an item at exactly the threshold
 * does not surface yet.
 */
export function selectCutOrCommitItems<T extends CutOrCommitItem>(
  inbox: readonly T[] | null | undefined,
  now: number,
  cap: number = CUT_OR_COMMIT_CAP,
): T[] {
  if (!Array.isArray(inbox)) return [];
  return inbox
    .map((t, idx) => ({ t, idx }))
    .filter(
      ({ t }) =>
        t.status !== 'ARCHIVED' &&
        !t.completed &&
        !t.triagedSkip &&
        typeof t.createdAt === 'number' &&
        Number.isFinite(t.createdAt) &&
        now - (t.createdAt as number) > CUT_OR_COMMIT_MIN_AGE_MS,
    )
    .sort((a, b) => (a.t.createdAt as number) - (b.t.createdAt as number) || a.idx - b.idx)
    .slice(0, cap)
    .map(({ t }) => t);
}
