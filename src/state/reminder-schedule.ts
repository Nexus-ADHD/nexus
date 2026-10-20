// NEX-198 (N-1) — pure, RN-free helpers for ambient reminder scheduling +
// Home-pin selection. Kept out of app-state.ts so the date/selection logic is
// vitest-coverable in Node (app-state.ts pulls the RN bundle).
//
// A "reminder" in N-1 is an inbox item (InboxTask) carrying a `dueDate`.
// Resolved === status 'ARCHIVED' (matches the Inbox complete/restore path in
// app/(tabs)/inbox.tsx; `completed` alone is NOT resolution here).

export interface ReminderItem {
  id: string;
  title?: string;
  status?: string;
  triagedSkip?: boolean;
  dueDate?: string;
  // NEX-259 (N-2): opt-in "keep nudging" — re-nudge until resolved, capped.
  keepNudging?: boolean;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Validate the clock RANGE (00-23:00-59), not just the shape — a loose
// /^\d{2}:\d{2}$/ would accept "99:99" and build a `T99:99:00` dueDate that
// reminderFireAt can't parse (→ null → the reminder never fires AND never
// pins). An out-of-range time degrades to a date-only reminder instead.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Date-only dueDate (no time) fires at 9:00 local — the lead-time precedent,
// and out of quiet hours (cf. NEX-236).
export const REMINDER_DEFAULT_HOUR = 9;

/**
 * Build the inbox `dueDate` for a dated capture: a local datetime ISO
 * ("YYYY-MM-DDTHH:mm:00") when a valid HH:mm `time` is present, else the
 * date-only key ("YYYY-MM-DD"). This is the PRODUCER side of the N-1 reminder
 * contract — `reminderFireAt` (the consumer) parses exactly these two shapes,
 * so they must stay in lockstep. Used by the capture executor's todo_add path.
 */
export function buildReminderDueIso(dateStr: string, time?: string | null): string {
  return time && HHMM_RE.test(time) ? `${dateStr}T${time}:00` : dateStr;
}

/** A reminder is resolved (off Home, no alert) when archived. */
export function isReminderResolved(item: ReminderItem): boolean {
  return item?.status === 'ARCHIVED';
}

/**
 * Intended fire time (ms, LOCAL) for a dueDate, or null if absent/unparseable.
 * - datetime ISO ("2026-06-20T22:00:00") → that instant
 * - date-only ("2026-06-20") → `defaultHour`:00 local that day, parsed from
 *   local parts (NOT `new Date(iso)`, which is UTC and renders the prior day in
 *   negative-offset zones — the NEX-193 trap)
 * Callers decide past-vs-future; this only computes the intended time.
 */
export function reminderFireAt(
  dueDate?: string | null,
  defaultHour: number = REMINDER_DEFAULT_HOUR,
): number | null {
  if (!dueDate || typeof dueDate !== 'string') return null;
  const dateOnly = DATE_ONLY_RE.exec(dueDate);
  if (dateOnly) {
    const dt = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      defaultHour,
      0,
      0,
      0,
    );
    const ms = dt.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = new Date(dueDate).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// NEX-259: "keep nudging" cadence — the due alert, then every 2h, max 3/day.
// The 3 fixed offsets ARE the hard daily cap (no persisted counter).
const NUDGE_OFFSETS_MS = [0, 2 * 3_600_000, 4 * 3_600_000];
// Global ceiling on scheduled reminder one-shots across ALL items, well under
// the iOS 64-pending cap (shared with morning/evening/weekly/lead-time/billing).
export const REMINDER_PENDING_CAP = 32;

// Varied notification TITLE line per nudge slot (the BODY stays the task title).
// Slot 0 matches the N-1 single alert. §18/§19: declarative, no "!"/em dash/emoji.
const NUDGE_TITLES = ['A gentle reminder.', 'Still on your list.', 'When you are ready.'];
export function nudgeCopy(slot: number): string {
  return NUDGE_TITLES[slot] ?? NUDGE_TITLES[NUDGE_TITLES.length - 1];
}

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const nineAmLocal = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), REMINDER_DEFAULT_HOUR, 0, 0, 0).getTime();
};

/**
 * Nudge times (with their absolute slot index) for a keep-nudging item:
 *  - base on a PRIOR day (overdue) → anchor at 9:00 local today
 *  - base today (past or future)   → anchor at the due instant
 * Then [anchor, +2h, +4h] filtered to the FUTURE. If all of today's slots are
 * past, fall to tomorrow 9:00 (slot 0) — it re-arms on the next reconcile (the
 * cross-day caveat: nudges only re-arm on app open; the Home pin is visual-only).
 */
export function reminderNudgeTimes(baseMs: number, nowMs: number): { ms: number; slot: number }[] {
  const anchor = baseMs < startOfLocalDay(nowMs) ? nineAmLocal(nowMs) : baseMs;
  const future = NUDGE_OFFSETS_MS.map((off, slot) => ({ ms: anchor + off, slot })).filter(
    (s) => s.ms > nowMs,
  );
  if (future.length > 0) return future;
  return [{ ms: nineAmLocal(nowMs + 86_400_000), slot: 0 }];
}

/**
 * Reminder one-shots to schedule. A non-keepNudging item → one future entry
 * (slot 0, the N-1 alert). A keepNudging item → its nudge family (slot per
 * offset) INSTEAD of the single entry. All entries are then sorted soonest-first
 * and globally capped at REMINDER_PENDING_CAP (iOS 64-pending headroom).
 */
export function selectReminderSchedules(
  inbox: ReminderItem[] | null | undefined,
  nowMs: number,
): { id: string; title: string; fireAtMs: number; slot: number }[] {
  if (!Array.isArray(inbox)) return [];
  const out: { id: string; title: string; fireAtMs: number; slot: number }[] = [];
  for (const t of inbox) {
    // triaged-skip items are hidden from active Home surfaces (cf. selectDueReminders
    // / selectActiveInbox), so they must not fire a notification either —
    // intentional alignment, not just an N-1-parity oversight.
    if (!t || isReminderResolved(t) || t.triagedSkip) continue;
    const baseMs = reminderFireAt(t.dueDate);
    if (baseMs == null) continue;
    const id = String(t.id);
    const title = String(t.title ?? '');
    if (t.keepNudging) {
      for (const n of reminderNudgeTimes(baseMs, nowMs)) {
        out.push({ id, title, fireAtMs: n.ms, slot: n.slot });
      }
    } else if (baseMs > nowMs) {
      out.push({ id, title, fireAtMs: baseMs, slot: 0 });
    }
  }
  out.sort(
    (a, b) =>
      a.fireAtMs - b.fireAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      a.slot - b.slot,
  );
  return out.slice(0, REMINDER_PENDING_CAP);
}

/**
 * Reminders to PIN on Home: unresolved, dueDate present, fire time has arrived
 * (<= now). Total-ordered by (fireAtMs, id) so render order is stable.
 * `excludeIds` drops items already surfaced elsewhere (e.g. the justCaptured
 * Home echo, Cut-or-Commit) so one item is never shown twice.
 */
export function selectDueReminders(
  inbox: ReminderItem[] | null | undefined,
  nowMs: number,
  excludeIds: Set<string> = new Set(),
): ReminderItem[] {
  if (!Array.isArray(inbox)) return [];
  return inbox
    // A triaged-skip item is intentionally absent from active Home surfaces
    // (cf. selectActiveInbox / Cut-or-Commit), so it never fires as a due
    // reminder either — independent of the caller's excludeIds set.
    .filter((t) => t && !isReminderResolved(t) && !t.triagedSkip && !excludeIds.has(String(t.id)))
    .map((t) => ({ t, fireAtMs: reminderFireAt(t.dueDate) }))
    .filter(
      (x): x is { t: ReminderItem; fireAtMs: number } =>
        x.fireAtMs != null && x.fireAtMs <= nowMs,
    )
    .sort(
      (a, b) =>
        a.fireAtMs - b.fireAtMs ||
        (String(a.t.id) < String(b.t.id) ? -1 : String(a.t.id) > String(b.t.id) ? 1 : 0),
    )
    .map((x) => x.t);
}
