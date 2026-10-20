/**
 * Shared comparator for orbit/calendar events by start time (ascending).
 *
 * The same `(a, b) => new Date(a.startISO) - new Date(b.startISO)` comparator was
 * copy-pasted across several call sites (app-state write paths, Home, Today). A
 * single source means a future change to orbit ordering (all-day handling, a
 * stable tie-break, an endISO fallback) is made once. New/changed call sites use
 * this; the older app-state copies can adopt it incrementally.
 */
export function compareByStartISO(a: { startISO?: string }, b: { startISO?: string }): number {
  return new Date(a?.startISO ?? 0).getTime() - new Date(b?.startISO ?? 0).getTime();
}
