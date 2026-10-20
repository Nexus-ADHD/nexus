/**
 * Pure reducer for the Phase 2 / Phase 4 read-path upsert.
 * Extracted out of the Zustand store so the branch-heavy logic
 * (including the Phase 4 race-window dedup) is unit-testable.
 *
 * Phase 4 dedup window: when voice mirrors to Apple Reminders, the
 * local inbox item is created BEFORE the EventKit write resolves.
 * Until updateInboxTask stamps the externalId, the item lives in
 * the inbox with source='apple_reminders' and externalId=undefined.
 * If a sync runs in that window (~hundreds of ms), the fetched
 * record won't match by externalId and the upsert would create a
 * duplicate. Mitigation: when no externalId match exists, also
 * search for a recent (<10s) unstamped local item with matching
 * normalized title. If found, stamp the externalId in place rather
 * than inserting.
 */

import type { ReconcileBuckets } from './reconcile-external-state';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _UnusedRebuckets = ReconcileBuckets; // re-exported indirectly; keeps the cross-file API surface visible

interface InboxItem {
  id: string;
  title: string;
  completed: boolean;
  status?: string;
  createdAt?: number;
  source?: string;
  externalId?: string;
  dueDate?: string;
  [k: string]: any;
}

interface FetchRecord {
  id: string;
  title: string;
  dueDate?: string;
  notes?: string;
  listId: string;
}

export interface UpsertResult<T extends InboxItem> {
  /** New inbox array. New items are at the front. */
  inbox: T[];
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Race-window in ms. Shorter than the throttle so the dedup window
 * naturally expires before the next focus-driven sync.
 */
export const VOICE_MIRROR_DEDUP_WINDOW_MS = 10_000;

function normalizeTitle(s: string | undefined | null): string {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Find a recent local item that's claiming the same title and was
 * created in the dedup window with no externalId stamped yet.
 * Returns the item's index in the inbox, or -1.
 */
export function findRecentUnstampedLocalMatch<T extends InboxItem>(
  inbox: T[],
  record: FetchRecord,
  nowMs: number,
): number {
  const recordTitle = normalizeTitle(record.title);
  if (!recordTitle) return -1;
  const cutoff = nowMs - VOICE_MIRROR_DEDUP_WINDOW_MS;
  for (let i = 0; i < inbox.length; i++) {
    const item = inbox[i];
    if (item.source !== 'apple_reminders') continue;
    if (item.externalId) continue; // already stamped, would have hit the externalId index
    if (typeof item.createdAt !== 'number') continue;
    if (item.createdAt < cutoff) continue;
    if (normalizeTitle(item.title) !== recordTitle) continue;
    return i;
  }
  return -1;
}

/**
 * Phase 2/4 upsert. For each record:
 *   - existing item with matching externalId, status !== 'ARCHIVED' →
 *     update title/dueDate in place if drifted; otherwise skip.
 *   - existing item with matching externalId, status === 'ARCHIVED' →
 *     skip (don't resurrect user-triaged work).
 *   - no externalId match BUT recent (<10s) unstamped local with
 *     matching title (Phase 4 voice-mirror race) → stamp externalId
 *     in place; counted as 'updated'.
 *   - else → prepend new inbox entry with source='apple_reminders'.
 *
 * Object identity is preserved on unchanged items so React.memo'd
 * row components downstream skip rendering.
 */
export function upsertRemindersIntoInbox<T extends InboxItem>(
  inbox: T[],
  records: FetchRecord[],
  createId: () => string,
  nowMs: number,
): UpsertResult<T> {
  const tally = { added: 0, updated: 0, skipped: 0 };
  if (!Array.isArray(records) || records.length === 0) {
    return { inbox, ...tally };
  }
  const working: T[] = [...inbox];
  const byExternal: Record<string, number> = {};
  working.forEach((t, i) => {
    if (t.externalId) byExternal[t.externalId] = i;
  });
  const newItems: T[] = [];
  for (const r of records) {
    const idx = byExternal[r.id];
    if (idx !== undefined) {
      const existing = working[idx];
      if (existing.status === 'ARCHIVED') {
        tally.skipped += 1;
        continue;
      }
      const titleChanged = existing.title !== r.title;
      const dueDateChanged = (existing.dueDate ?? null) !== (r.dueDate ?? null);
      if (titleChanged || dueDateChanged) {
        working[idx] = { ...existing, title: r.title, dueDate: r.dueDate } as T;
        tally.updated += 1;
      } else {
        tally.skipped += 1;
      }
      continue;
    }
    // Phase 4 race-window dedup: stamp externalId on a recent
    // unstamped local rather than insert a duplicate.
    const raceIdx = findRecentUnstampedLocalMatch(working, r, nowMs);
    if (raceIdx !== -1) {
      const existing = working[raceIdx];
      working[raceIdx] = {
        ...existing,
        externalId: r.id,
        // Title might have minor whitespace differences; normalize
        // to the EventKit version so Apple is the source of truth.
        title: r.title,
        ...(r.dueDate !== undefined ? { dueDate: r.dueDate } : {}),
      } as T;
      // Also update the byExternal index in case a later record in
      // the same batch tries to match the now-stamped id.
      byExternal[r.id] = raceIdx;
      tally.updated += 1;
      continue;
    }
    newItems.push({
      id: createId(),
      title: r.title,
      completed: false,
      status: 'NEW',
      createdAt: nowMs,
      source: 'apple_reminders',
      externalId: r.id,
      ...(r.dueDate !== undefined ? { dueDate: r.dueDate } : {}),
    } as unknown as T);
    tally.added += 1;
  }
  return { inbox: [...newItems, ...working], ...tally };
}
