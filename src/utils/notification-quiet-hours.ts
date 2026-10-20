/**
 * Quiet-hours guard for arbitrary-time one-shot notifications (NEX-236).
 *
 * A scheduled one-shot whose fire time lands inside the user's quiet-hours
 * window is shifted forward to the window's end, so the app never fires an
 * off-hours "2:27am" notification. Recurring morning/evening notifications fire
 * at user-configured daytime hours and are NOT routed through this; only
 * arbitrary-time one-shots are (today: lead-time; NEX-232 billing reminders when
 * they land).
 *
 * Quiet hours are LOCAL minutes-since-midnight. Default window 22:00–08:00.
 *
 * The wrap-window math lives in the pure integer core `computeQuietShift`
 * (no Date, TZ-independent → exhaustively unit-testable); the thin
 * `shiftOutOfQuietHours` wrapper does the local-time extraction + rebuild.
 */

/** Default quiet window: 22:00 (1320) local. */
export const DEFAULT_QUIET_START_MINUTE = 22 * 60;
/** Default quiet window end: 08:00 (480) local. */
export const DEFAULT_QUIET_END_MINUTE = 8 * 60;

export interface QuietWindow {
  /** Local minutes since midnight the window opens (e.g. 1320 = 22:00). */
  startMinute: number;
  /** Local minutes since midnight the window closes (e.g. 480 = 08:00). */
  endMinute: number;
}

/**
 * Resolve a QuietWindow from (possibly stale / partial) notificationSettings,
 * defaulting each edge to the 22:00–08:00 window. Read-site defaulted because a
 * cloud merge can replace notificationSettings with an older blob that lacks
 * these keys. Pure → unit-testable, and the single source of the default window
 * for every one-shot reconcile call site (lead-time + billing).
 */
export function resolveQuietWindow(
  settings?: { quietHoursStart?: number | null; quietHoursEnd?: number | null } | null,
): QuietWindow {
  return {
    startMinute: settings?.quietHoursStart ?? DEFAULT_QUIET_START_MINUTE,
    endMinute: settings?.quietHoursEnd ?? DEFAULT_QUIET_END_MINUTE,
  };
}

export interface QuietShift {
  /** True when the fire time is inside the window and must move. */
  shift: boolean;
  /** Local minute-of-day to move to (the window end). Only meaningful when shift. */
  targetMinute: number;
  /** 0 = same local day, 1 = next local day. Only meaningful when shift. */
  dayDelta: 0 | 1;
}

const NO_SHIFT: QuietShift = { shift: false, targetMinute: 0, dayDelta: 0 };

/**
 * Pure: given a fire time as a local minute-of-day and the quiet window, decide
 * whether to shift and to where. No Date — TZ-independent.
 *
 * Boundary is half-open `[start, end)`: a fire exactly at `start` shifts, a fire
 * exactly at `end` is allowed (so the result is idempotent — re-running on an
 * already-shifted time returns no-shift).
 *
 * Wrap window (start > end, e.g. 22:00→08:00): inside = `t >= start || t < end`.
 *   - evening side (t >= start): window ends at `end` on the NEXT day → dayDelta 1.
 *   - morning side (t < end): window ends at `end` on the SAME day → dayDelta 0.
 * Same-day window (start < end): inside = `start <= t < end` → dayDelta 0.
 * Degenerate (start === end): no window, never shift.
 */
export function computeQuietShift(fireMinute: number, startMinute: number, endMinute: number): QuietShift {
  // Normalize to [0, 1440); guard NaN.
  const t = ((Math.trunc(fireMinute) % 1440) + 1440) % 1440;
  const start = ((Math.trunc(startMinute) % 1440) + 1440) % 1440;
  const end = ((Math.trunc(endMinute) % 1440) + 1440) % 1440;
  if (!Number.isFinite(fireMinute) || !Number.isFinite(startMinute) || !Number.isFinite(endMinute)) return NO_SHIFT;
  if (start === end) return NO_SHIFT; // no window

  if (start > end) {
    // Wrap across midnight.
    if (t >= start) return { shift: true, targetMinute: end, dayDelta: 1 }; // evening → next-day end
    if (t < end) return { shift: true, targetMinute: end, dayDelta: 0 };    // early morning → same-day end
    return NO_SHIFT;
  }
  // Same-day window.
  if (t >= start && t < end) return { shift: true, targetMinute: end, dayDelta: 0 };
  return NO_SHIFT;
}

/**
 * Shift `fireMs` out of the quiet window if it lands inside, else return it
 * unchanged. Idempotent per `(fireMs, quiet)`. Uses local time and rebuilds the
 * target via `new Date(y, mo, d, h, mi)` (never `+ 86400000`, which is DST-unsafe).
 */
export function shiftOutOfQuietHours(fireMs: number, quiet: QuietWindow): number {
  if (!Number.isFinite(fireMs)) return fireMs;
  const d = new Date(fireMs);
  const fireMinute = d.getHours() * 60 + d.getMinutes();
  const plan = computeQuietShift(fireMinute, quiet.startMinute, quiet.endMinute);
  if (!plan.shift) return fireMs;
  const targetH = Math.floor(plan.targetMinute / 60);
  const targetM = plan.targetMinute % 60;
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + plan.dayDelta, targetH, targetM, 0, 0);
  return target.getTime();
}
