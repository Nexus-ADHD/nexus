/**
 * Pure reducer for the Phase 3 external-state reconcile pass.
 * Extracted out of the Zustand store so it can be unit-tested
 * without spinning up persist middleware or AsyncStorage.
 *
 * Rules (per-item, applied in order; first match wins):
 *
 *   1. Manual items (source !== 'apple_reminders') → unchanged.
 *   2. Apple items already ARCHIVED → unchanged. Reconcile never
 *      resurrects user-triaged work.
 *   3. Apple items with no externalId → unchanged (defensive — a
 *      malformed import shouldn't be auto-orphaned on the next
 *      sync; let the user delete it manually).
 *   4. externalId in completedIds → set completed: true,
 *      status: 'ARCHIVED'. Don't set orphaned (it was completed
 *      externally, not removed).
 *   5. externalId in incompleteIds → unchanged (Apple still has
 *      the item live; nothing to do).
 *   6. externalId in neither → set orphaned: true,
 *      status: 'ARCHIVED' (deleted, moved to an unsynced list,
 *      or the user toggled the list off).
 *
 * Object identity is preserved on unchanged items so React.memo'd
 * row components downstream skip rendering.
 */

interface ReconcileInput {
  id: string;
  source?: string;
  externalId?: string;
  status?: string;
  completed?: boolean;
  orphaned?: boolean;
  [k: string]: any;
}

export interface ReconcileBuckets {
  incompleteIds: Set<string>;
  completedIds: Set<string>;
}

export function reconcileInboxAgainstExternal<T extends ReconcileInput>(
  inbox: T[],
  buckets: ReconcileBuckets,
  /**
   * NEX-26 phase F.5 ext: timestamp to stamp on items flipping to
   * completed via rule 4. Injected for testability; the Zustand
   * action passes Date.now(). Existing completedAt on the item is
   * preserved — first-completion stamp wins.
   */
  now: number = Date.now(),
): T[] {
  if (!Array.isArray(inbox) || inbox.length === 0) return inbox;
  return inbox.map((item) => {
    if (item.source !== 'apple_reminders') return item;          // rule 1
    if (item.status === 'ARCHIVED') return item;                  // rule 2
    if (!item.externalId) return item;                            // rule 3
    if (buckets.completedIds.has(item.externalId)) {              // rule 4
      // Stamp completedAt so the activation tracker credits this
      // clear on the day Apple-sync surfaced it. If the item already
      // had a completedAt (cleared in-app first, sync confirmed it
      // later), preserve the original — first stamp wins, matching
      // applyToggleInbox's invariant.
      const completedAt = (item as any).completedAt ?? now;
      return { ...item, completed: true, status: 'ARCHIVED', completedAt };
    }
    if (buckets.incompleteIds.has(item.externalId)) return item;  // rule 5
    return { ...item, orphaned: true, status: 'ARCHIVED' };       // rule 6
  });
}
