/**
 * Phase 5 — first-connect triage flow. Pure helpers extracted out
 * of the UI and the store so the date math and decision-to-patch
 * mapping can be unit-tested in isolation.
 *
 * The four user-visible decisions:
 *   - Today      → due today
 *   - This week  → due upcoming Sunday 23:59 (same day if today is Sunday)
 *   - Later      → no schedule change; item remains in Inbox as-is
 *   - Skip       → triagedSkip flag set; item is hidden from ACTIVE inbox
 *                  but Apple Reminders is left untouched
 *
 * Manual-source items must never reach this helper: triage only
 * applies to Apple-imported items on first connect. Calling with a
 * 'manual' item is a programmer error and throws.
 */

export type TriageDecision = 'today' | 'this_week' | 'later' | 'skip';

interface TriageItemMinimal {
  id: string;
  source?: 'manual' | 'apple_reminders';
  dueDate?: string;
  externalId?: string;
}

export interface TriagePatch {
  /** Partial patch to apply to the local InboxTask. Empty for 'later'. */
  local: Partial<{
    dueDate: string;
    triagedSkip: boolean;
  }>;
  /**
   * If present, the triage flow should also push a due-date change
   * to Apple Reminders for this externalId. `dueDate: null` would
   * clear it; we never need that on this surface (Later/Skip simply
   * skip the remote update).
   */
  remoteUpdate?: {
    dueDate: string;
  };
}

/**
 * Resolves "Today" to a time-of-day that feels intentional, not
 * "23:59 dump it on midnight." Three bands:
 *   - Before 9 AM       → today at 9 AM       (give a morning block)
 *   - After 9 PM        → today at 23:59      (preserve "today" semantics
 *                                              when it's genuinely late)
 *   - Otherwise (mid-day) → now + 2 hours,
 *                          rounded UP to the next 30-minute mark
 *                          (gives the user breathing room without
 *                           feeling thrown to the back of the day)
 */
export function humanTodayISO(now: Date): string {
  const d = new Date(now.getTime());
  const hour = d.getHours();
  if (hour < 9) {
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  if (hour >= 21) {
    d.setHours(23, 59, 59, 0);
    return d.toISOString();
  }
  // Mid-day: now + 2h, rounded up to next :00 or :30.
  d.setHours(d.getHours() + 2);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  if (m === 0 || m === 30) {
    // Already on the half-hour — leave it.
  } else if (m < 30) {
    d.setMinutes(30);
  } else {
    // > 30 → bump to the next hour at :00.
    d.setHours(d.getHours() + 1);
    d.setMinutes(0);
  }
  return d.toISOString();
}

/**
 * Returns ISO 8601 for the upcoming Sunday at 23:59:59 local time,
 * or the SAME day at 23:59:59 if `today` is already a Sunday. The
 * intent is "by end of this week" — for a user opening Nexus on
 * Sunday afternoon, "this week" should still mean today, not seven
 * days from now.
 *
 * Sunday is the safe default for end-of-week: locale-aware variants
 * (Saturday for Hebrew calendars, Friday for some Islamic ones) are
 * out of scope; the user can adjust dates manually after triage.
 */
export function endOfWeekISO(today: Date): string {
  const d = new Date(today.getTime());
  const dow = d.getDay(); // 0 = Sunday
  const daysUntilSunday = dow === 0 ? 0 : 7 - dow;
  d.setDate(d.getDate() + daysUntilSunday);
  d.setHours(23, 59, 59, 0);
  return d.toISOString();
}

/**
 * Maps a triage decision into a local-state patch and an optional
 * remote update for Apple Reminders.
 */
export function applyTriageDecision(
  item: TriageItemMinimal,
  decision: TriageDecision,
  today: Date,
): TriagePatch {
  if (item.source !== 'apple_reminders') {
    // Defensive: triage is only meaningful for imported items. A
    // manual item here would mean the trigger logic mis-batched
    // somewhere upstream; fail loud rather than silently mutate.
    throw new Error(
      `applyTriageDecision: refusing to triage non-apple_reminders item (source=${item.source ?? 'undefined'})`,
    );
  }
  switch (decision) {
    case 'today': {
      // Use a humane time-of-day rather than 23:59. See humanTodayISO
      // for the heuristic — pre-9am gets 9am, late-evening gets EOD,
      // mid-day gets now+2h rounded up to the next half hour.
      const dueDate = humanTodayISO(today);
      return {
        local: { dueDate },
        remoteUpdate: { dueDate },
      };
    }
    case 'this_week': {
      const dueDate = endOfWeekISO(today);
      return {
        local: { dueDate },
        remoteUpdate: { dueDate },
      };
    }
    case 'later': {
      // No-op locally and remotely. Item stays in inbox with whatever
      // dueDate it already had (likely none).
      return { local: {} };
    }
    case 'skip': {
      return { local: { triagedSkip: true } };
    }
    default: {
      // Exhaustiveness guard.
      const exhaust: never = decision;
      throw new Error(`applyTriageDecision: unknown decision ${String(exhaust)}`);
    }
  }
}

/**
 * Pure first-connect detection. Triage triggers exactly when:
 *   - The user has never completed triage (triageCompletedAt === null), AND
 *   - This is the very first sync (lastSyncedAt === null), AND
 *   - At least one item was added in the upsert tally.
 *
 * Disconnect/reconnect should NOT re-trigger because lastSyncedAt
 * persists across the disconnect path's reset (we keep it null only
 * on a true cold install). triageCompletedAt is the belt: once
 * stamped, no permutation of state revives the modal.
 */
export interface TriggerInputs {
  triageCompletedAt: number | null;
  lastSyncedAt: number | null;
  added: number;
}

export function shouldTriggerTriage(inputs: TriggerInputs): boolean {
  if (inputs.triageCompletedAt !== null) return false;
  if (inputs.lastSyncedAt !== null) return false;
  if (inputs.added <= 0) return false;
  return true;
}
