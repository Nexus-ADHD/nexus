/**
 * Persisted Inbox status -> the word shown to the user.
 *
 * These were two different vocabularies that nobody had to reconcile while a
 * coloured left border was the only carrier of status. Rendering the status as
 * TEXT (so it stops being conveyed by colour alone, and so VoiceOver announces
 * it) made the gap user-visible: the screen printed the internal identifier
 * `UNPROCESSED` verbatim.
 *
 * `UNPROCESSED` is not an edge case. It is what the three most common capture
 * paths write:
 *   - voice capture            `command-executor.ts:373,644`
 *   - onboarding first win     `first-win-capture.tsx:137`
 *   - the Inbox composer       `app/(tabs)/inbox.tsx`
 *
 * Semantically it means exactly what `NEW` means: nobody has triaged this yet.
 * So it maps to NEW and ages to OPEN on the same 24h rule, which also makes the
 * border colour and the label agree — before this, an UNPROCESSED item fell to
 * the default gold while reading as untriaged.
 *
 * Unknown values map to NEW rather than passing through. An internal
 * identifier must never reach the screen again just because someone adds a
 * status somewhere else in the app.
 *
 * Pure and RN-free so vitest can cover it; the screen itself is not importable
 * in the Node suite.
 */

export type InboxDisplayStatus = 'NEW' | 'OPEN' | 'SCHEDULED' | 'ARCHIVED';

/** How long an untriaged item stays "NEW" before it reads as "OPEN". */
export const INBOX_OPEN_AFTER_MS = 24 * 60 * 60 * 1000;

export interface InboxStatusInput {
  status?: string | null;
  createdAt?: number | null;
}

export function displayInboxStatus(
  task: InboxStatusInput,
  now: number = Date.now(),
): InboxDisplayStatus {
  const raw = typeof task.status === 'string' ? task.status.trim().toUpperCase() : '';

  // Terminal states are reported as-is; neither ages.
  if (raw === 'ARCHIVED') return 'ARCHIVED';
  if (raw === 'SCHEDULED') return 'SCHEDULED';

  // Already-aged items keep reading as OPEN even if createdAt is missing.
  if (raw === 'OPEN') return 'OPEN';

  // NEW, UNPROCESSED, empty, and anything unrecognised are all "untriaged",
  // and all age the same way.
  const createdAt = typeof task.createdAt === 'number' && Number.isFinite(task.createdAt)
    ? task.createdAt
    : null;
  if (createdAt !== null && now - createdAt > INBOX_OPEN_AFTER_MS) return 'OPEN';
  return 'NEW';
}
