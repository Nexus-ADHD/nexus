/**
 * Apple Reminders service — thin wrapper around the iOS reminders side
 * of expo-calendar. Phase 1 establishes permissions, list discovery,
 * and a "Nexus" list creator. The fetch + complete operations are
 * stubbed so consumers can wire up against the final shape; Phase 2
 * fills them in.
 *
 * iOS-only at the platform level. On non-iOS, every call returns a
 * deterministic "denied / empty" shape so callers never crash.
 */
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import { mergeReminderPatch, type ReminderShape } from './reminder-merge';
import tokens from '@/src/theme/tokens';

export type ReminderPermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface ReminderList {
  id: string;
  title: string;
  source: string; // e.g. "iCloud", "Default", "Local"
  color: string;  // hex
  /** True only when this list was created by Nexus via createNexusList(). */
  isNexus: boolean;
}

/**
 * Normalized shape produced by fetchIncompleteReminders. dueDate is
 * ISO 8601 when present. notes is the user's reminder body.
 */
export interface AppleReminderRecord {
  id: string;
  listId: string;
  title: string;
  dueDate?: string;
  notes?: string;
}

/**
 * Thrown by fetchIncompleteReminders / fetchCompletedReminders when
 * called without granted permission. Callers should handle and
 * surface a user-friendly message rather than crashing the sync flow.
 */
export class RemindersPermissionError extends Error {
  constructor() {
    super('Reminders permission not granted');
    this.name = 'RemindersPermissionError';
  }
}

export type RemindersWriteCause = 'not_found' | 'permission' | 'unknown';

/**
 * Thrown by markReminderComplete on EventKit write failures. The
 * `cause` discriminator lets the UI choose between a "deleted in
 * iOS" message and a generic retry prompt.
 */
export class RemindersWriteError extends Error {
  cause: RemindersWriteCause;
  constructor(cause: RemindersWriteCause, message?: string) {
    super(message ?? `Reminders write failed (${cause})`);
    this.name = 'RemindersWriteError';
    this.cause = cause;
  }
}

/**
 * Thrown by createNexusList when the device has no iCloud reminders
 * source. EventKit's default source picker can land on Exchange or
 * other CalDAV accounts (e.g. corporate LinkedIn) that don't support
 * reminder lists, producing cryptic create failures. Surfacing this
 * as a typed error lets the UI prompt the user to enable iCloud
 * reminders rather than reporting a generic EventKit message.
 */
export class RemindersNoICloudSourceError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'Nexus needs an iCloud account that supports reminders. ' +
          'Enable iCloud Reminders in iOS Settings → Apple ID → iCloud.',
    );
    this.name = 'RemindersNoICloudSourceError';
  }
}

function classifyWriteError(e: any): RemindersWriteCause {
  const msg = String(e?.message ?? '').toLowerCase();
  const code = String(e?.code ?? '').toLowerCase();
  if (
    msg.includes('not found') ||
    msg.includes('no such') ||
    code.includes('not_found') ||
    code.includes('not-found')
  ) return 'not_found';
  if (
    msg.includes('permission') ||
    msg.includes('not authorized') ||
    msg.includes('unauthorized') ||
    code.includes('permission') ||
    code.includes('auth')
  ) return 'permission';
  return 'unknown';
}

const NEXUS_LIST_TITLE = 'Nexus';

function isIOS(): boolean {
  return Platform.OS === 'ios';
}

function mapStatus(s: Calendar.PermissionStatus | undefined): ReminderPermissionStatus {
  if (s === 'granted') return 'granted';
  if (s === 'denied') return 'denied';
  return 'undetermined';
}

export async function getPermissionStatus(): Promise<ReminderPermissionStatus> {
  if (!isIOS()) return 'denied';
  try {
    const result = await Calendar.getRemindersPermissionsAsync();
    return mapStatus(result?.status);
  } catch {
    return 'undetermined';
  }
}

export async function requestPermission(): Promise<ReminderPermissionStatus> {
  if (!isIOS()) return 'denied';
  try {
    const result = await Calendar.requestRemindersPermissionsAsync();
    return mapStatus(result?.status);
  } catch {
    return 'denied';
  }
}

export async function listReminderLists(): Promise<ReminderList[]> {
  if (!isIOS()) return [];
  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
    return (calendars ?? []).map((c: any) => ({
      id: String(c.id),
      title: String(c.title ?? ''),
      source: String(c.source?.name ?? c.source ?? ''),
      // FIXME(nex-56): off-scale gray fallback for missing Apple Calendar list color (runtime user-controlled data) — design review can pick a neutral token
      color: String(c.color ?? '#999999'),
      isNexus: String(c.title ?? '').trim().toLowerCase() === NEXUS_LIST_TITLE.toLowerCase(),
    }));
  } catch {
    return [];
  }
}

/**
 * Creates a reminder list named "Nexus" on the user's iCloud account.
 *
 * Some Apple IDs expose multiple iCloud-named CALDAV sources in
 * EventKit — typically a legacy migration artifact where the
 * account was re-authenticated at some point. Both sources have
 * identical name + type, but only one accepts reminders writes.
 * There's no API to know which is current, so we walk all
 * candidates and use the first that accepts a list creation.
 *
 * Throws RemindersNoICloudSourceError if either:
 *   - no iCloud-named CALDAV source exists at all, or
 *   - every candidate iCloud source rejects the create call.
 */
export async function createNexusList(): Promise<string> {
  if (!isIOS()) {
    throw new Error('Reminders are iOS-only');
  }
  const sources = await Calendar.getSourcesAsync();
  const candidates = sources.filter(
    (s: any) =>
      String(s?.type ?? '').toUpperCase() === 'CALDAV' &&
      String(s?.name ?? '').toLowerCase().includes('icloud'),
  );
  if (candidates.length === 0) {
    throw new RemindersNoICloudSourceError();
  }
  for (const cand of candidates) {
    try {
      const id = await Calendar.createCalendarAsync({
        title: NEXUS_LIST_TITLE,
        color: tokens.color.gold,
        entityType: Calendar.EntityTypes.REMINDER,
        sourceId: (cand as any).id,
        source: { id: (cand as any).id, type: (cand as any).type, name: (cand as any).name } as any,
        name: NEXUS_LIST_TITLE,
        ownerAccount: 'personal',
        accessLevel: Calendar.CalendarAccessLevel.OWNER,
      } as any);
      return String(id);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.log(
        `[reminders] createNexusList: source ${(cand as any).id} rejected: ${e?.message ?? e}`,
      );
      // Try the next candidate.
    }
  }
  throw new RemindersNoICloudSourceError(
    'None of your iCloud accounts support reminder lists. ' +
      'Enable iCloud Reminders in iOS Settings → Apple ID → iCloud.',
  );
}

// ───────────────────────────────────────────────────────────────────────
// Phase 2 stubs — implemented in the next phase. Defined now so the
// store / UI can reference the final signature without needing to
// change shape later.
// ───────────────────────────────────────────────────────────────────────

/**
 * Fetches all incomplete reminders across the supplied list IDs.
 * Returns the normalized AppleReminderRecord shape. Items with
 * empty/whitespace-only titles are filtered out (EventKit allows
 * blank-titled reminders; they're not useful in our Inbox).
 *
 * Throws RemindersPermissionError if permission isn't 'granted' —
 * the caller is expected to handle and surface a reconnect prompt.
 *
 * Non-iOS callers receive an empty array (consistent with the rest
 * of this module's "deterministic empty / denied" non-iOS contract).
 */
export async function fetchIncompleteReminders(listIds: string[]): Promise<AppleReminderRecord[]> {
  if (!isIOS()) return [];
  if (!Array.isArray(listIds) || listIds.length === 0) return [];
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  // Why status=null instead of ReminderStatus.INCOMPLETE:
  // expo-calendar maps INCOMPLETE + date range to EventKit's
  // predicateForIncompleteRemindersWithDueDateStarting:ending:inCalendars:,
  // which filters reminders by *due date*. Reminders without a due
  // date are excluded entirely — and most user reminders don't have
  // due dates, so the incomplete predicate silently dropped almost
  // everything. Passing null falls through to the all-reminders
  // predicate, which returns every reminder regardless of due date;
  // we filter to incomplete in JS below.
  // The date range still has to be real Date instances even with
  // status=null — null start/end throws inside EventKit.
  const FAR_PAST = new Date(0); // 1970-01-01
  const FAR_FUTURE = new Date(Date.now() + 10 * 365 * 86_400_000); // ~10 years out
  const all = await Calendar.getRemindersAsync(
    listIds,
    null,
    FAR_PAST,
    FAR_FUTURE,
  );
  const reminders = (all ?? []).filter((r: any) => r?.completed === false);
  const out: AppleReminderRecord[] = [];
  for (const r of reminders ?? []) {
    const title = String((r as any).title ?? '').trim();
    if (!title) continue;
    const rawDue = (r as any).dueDate;
    let dueDate: string | undefined;
    if (rawDue) {
      // expo-calendar may return Date | string. Normalize to ISO.
      dueDate = typeof rawDue === 'string' ? rawDue : new Date(rawDue).toISOString();
    }
    out.push({
      id: String((r as any).id),
      listId: String((r as any).calendarId),
      title,
      dueDate,
      notes: (r as any).notes ? String((r as any).notes) : undefined,
    });
  }
  return out;
}

/**
 * Fetches completed reminders within the last `sinceDays` (default
 * 30) across the supplied list IDs. Mirrors fetchIncompleteReminders
 * shape; date range is required by EventKit when status is COMPLETED.
 *
 * Throws RemindersPermissionError if permission isn't 'granted'.
 * Non-iOS callers receive an empty array.
 */
export async function fetchCompletedReminders(
  listIds: string[],
  sinceDays: number = 30,
): Promise<AppleReminderRecord[]> {
  if (!isIOS()) return [];
  if (!Array.isArray(listIds) || listIds.length === 0) return [];
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  const now = new Date();
  const startDate = new Date(now.getTime() - Math.max(1, sinceDays) * 86_400_000);
  const reminders = await Calendar.getRemindersAsync(
    listIds,
    Calendar.ReminderStatus.COMPLETED,
    startDate,
    now,
  );
  const out: AppleReminderRecord[] = [];
  for (const r of reminders ?? []) {
    const title = String((r as any).title ?? '').trim();
    if (!title) continue;
    const rawDue = (r as any).dueDate;
    let dueDate: string | undefined;
    if (rawDue) {
      dueDate = typeof rawDue === 'string' ? rawDue : new Date(rawDue).toISOString();
    }
    out.push({
      id: String((r as any).id),
      listId: String((r as any).calendarId),
      title,
      dueDate,
      notes: (r as any).notes ? String((r as any).notes) : undefined,
    });
  }
  return out;
}

/**
 * Creates a reminder in the supplied list. Used by Phase 4's voice
 * mirror flow. Returns the new EventKit id.
 *
 * Throws RemindersPermissionError if permission isn't granted.
 * Throws RemindersWriteError on EventKit failure with a best-effort
 * cause classification. Non-iOS callers fail loudly.
 */
export async function createReminder(input: {
  listId: string;
  title: string;
  dueDate?: string;
  notes?: string;
}): Promise<string> {
  if (!isIOS()) {
    throw new RemindersWriteError('unknown', 'Reminders are iOS-only');
  }
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  try {
    const dueDateObj = input.dueDate ? new Date(input.dueDate) : undefined;
    // Apple Reminders treats startDate and dueDate as a paired pair —
    // setting both ensures the due-date pill renders in the iOS UI.
    const details: any = {
      title: String(input.title).trim(),
      completed: false,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(dueDateObj && !isNaN(dueDateObj.getTime())
        ? { dueDate: dueDateObj, startDate: dueDateObj }
        : {}),
    };
    const id = await Calendar.createReminderAsync(input.listId, details);
    return String(id);
  } catch (e: any) {
    throw new RemindersWriteError(classifyWriteError(e), e?.message);
  }
}

/**
 * Deletes a reminder by its EventKit id. Used by NEX-195's one-tap
 * undo to remove a mirrored Apple Reminder when the user reverses a
 * just-made voice capture. Best-effort by contract: the caller swallows
 * failures (the local Nexus item is the source of truth).
 *
 * Throws RemindersPermissionError if permission isn't granted, and
 * RemindersWriteError on EventKit failure. Non-iOS callers fail loudly.
 */
export async function deleteReminder(externalId: string): Promise<void> {
  if (!isIOS()) {
    throw new RemindersWriteError('unknown', 'Reminders are iOS-only');
  }
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  try {
    await Calendar.deleteReminderAsync(String(externalId));
  } catch (e: any) {
    throw new RemindersWriteError(classifyWriteError(e), e?.message);
  }
}

/**
 * Read-merge-write helper for non-destructive EventKit writes.
 *
 * On iOS 26, Calendar.updateReminderAsync is DESTRUCTIVE on
 * partial payloads — any field omitted from the payload is wiped.
 * So `updateReminderAsync(id, { completed: true })` blanks the
 * title, notes, alarms, etc. The user's data goes to zero.
 *
 * This helper fetches the existing reminder, merges the intended
 * change via the pure mergeReminderPatch helper, and writes the
 * complete object back. Throws RemindersWriteError('not_found')
 * when the reminder doesn't exist (likely deleted in iOS).
 *
 * Internal — every public reminder-write must route through here.
 */
async function patchReminder(
  externalId: string,
  patch: Partial<ReminderShape>,
): Promise<void> {
  // Try the by-id getter first if the binding exposes it; fall
  // back to a scan across the user's reminder lists. The fallback
  // is acceptable for a per-write op (writes are infrequent vs
  // reads) but we prefer the direct path when available.
  let existing: ReminderShape | null = null;
  const directGetter = (Calendar as any).getReminderAsync;
  if (typeof directGetter === 'function') {
    try {
      existing = (await directGetter(externalId)) ?? null;
    } catch {
      existing = null;
    }
  }
  if (!existing) {
    try {
      const lists = await listReminderLists();
      const all = await Calendar.getRemindersAsync(
        lists.map((l) => l.id),
        null,
        new Date(0),
        new Date(Date.now() + 10 * 365 * 86_400_000),
      );
      existing = (all ?? []).find((r: any) => String(r.id) === String(externalId)) ?? null;
    } catch {
      existing = null;
    }
  }
  if (!existing) {
    throw new RemindersWriteError('not_found', `Reminder ${externalId} not found`);
  }
  const merged = mergeReminderPatch(existing, patch);
  await Calendar.updateReminderAsync(externalId, merged as any);
}

/**
 * Marks an Apple Reminder complete (or un-complete) by externalId.
 * Throws RemindersPermissionError when permission isn't granted.
 * Throws RemindersWriteError on EventKit failures with a best-effort
 * `cause` classification (not_found / permission / unknown).
 *
 * Non-iOS callers fail loudly with a write error so calling code
 * doesn't silently lose user actions.
 *
 * NON-DESTRUCTIVE: routes through patchReminder so the title,
 * notes, alarms, etc. are preserved across the toggle. Sending a
 * raw `{ completed }` payload to updateReminderAsync wipes
 * everything else on iOS 26. See reminder-merge.ts for context.
 */
export async function markReminderComplete(externalId: string, completed: boolean): Promise<void> {
  if (!isIOS()) {
    throw new RemindersWriteError('unknown', 'Reminders are iOS-only');
  }
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  try {
    await patchReminder(externalId, {
      completed,
      completionDate: completed ? new Date() : null,
    });
  } catch (e: any) {
    if (e instanceof RemindersWriteError) throw e;
    throw new RemindersWriteError(classifyWriteError(e), e?.message);
  }
}

/**
 * Phase 5 — push a due-date change to an Apple Reminder. Used by the
 * triage flow when the user picks Today or This week. Pass null to
 * clear the due date (not currently used by triage; reserved).
 *
 * Both `dueDate` and `startDate` are written so the reminder shows
 * up correctly in iOS lists like "Today" and "Scheduled" — EventKit
 * uses `startDate` for some surfaces and `dueDate` for others, and
 * setting only one leaves the reminder in an inconsistent state.
 *
 * Same error contract as markReminderComplete.
 *
 * NON-DESTRUCTIVE: routes through patchReminder so title, notes,
 * alarms, completion state, etc. are preserved across the due-date
 * change. Sending a raw `{ dueDate, startDate }` payload to
 * updateReminderAsync wipes everything else on iOS 26. See
 * reminder-merge.ts for context.
 */
export async function updateReminderDueDate(
  externalId: string,
  dueDate: string | null,
): Promise<void> {
  if (!isIOS()) {
    throw new RemindersWriteError('unknown', 'Reminders are iOS-only');
  }
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  try {
    const d = dueDate ? new Date(dueDate) : null;
    await patchReminder(externalId, {
      dueDate: d,
      startDate: d,
    });
  } catch (e: any) {
    if (e instanceof RemindersWriteError) throw e;
    throw new RemindersWriteError(classifyWriteError(e), e?.message);
  }
}

/**
 * Phase 6 — push a title change to an Apple Reminder. Used when
 * the user edits an Apple-sourced inbox item's title via the
 * long-press edit modal.
 *
 * Same non-destructive contract as updateReminderDueDate /
 * markReminderComplete: routes through patchReminder so notes,
 * alarms, completion state, due date, etc. are preserved.
 *
 * Same error contract as the others.
 */
export async function updateReminderTitle(
  externalId: string,
  title: string,
): Promise<void> {
  if (!isIOS()) {
    throw new RemindersWriteError('unknown', 'Reminders are iOS-only');
  }
  const status = await getPermissionStatus();
  if (status !== 'granted') {
    throw new RemindersPermissionError();
  }
  try {
    await patchReminder(externalId, { title });
  } catch (e: any) {
    if (e instanceof RemindersWriteError) throw e;
    throw new RemindersWriteError(classifyWriteError(e), e?.message);
  }
}
