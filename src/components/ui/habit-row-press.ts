// Pure long-press decision for HabitRow, extracted so it's unit-testable in the
// Node vitest suite (the RN component itself isn't importable there).
//
// The misfire this guards against (every-other-tap opened the action menu): the
// old implementation opened the menu from a free-running setTimeout that could
// fire after a quick tap when its clearTimeout lost a race / onPressOut didn't
// run promptly. Here the complete-vs-menu choice is made deterministically on
// release from the measured hold duration — a background timer can no longer
// open the menu on its own.

/** Hold duration (ms) at or above which a press is a long-press (open the menu)
 *  rather than a tap (complete / toggle). Matches the prior 550ms threshold. */
export const LONG_PRESS_MS = 550;

/**
 * True when a press held for `elapsedMs` should be treated as a long-press.
 * Pure function of the elapsed time so the gesture decision is testable and can
 * never depend on timer/clearTimeout ordering.
 */
export function isLongPress(elapsedMs: number, thresholdMs: number = LONG_PRESS_MS): boolean {
  // Guard against a bogus/negative elapsed (e.g. a press with no recorded start):
  // never treat an unmeasured press as a long-press, so a tap always completes.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return elapsedMs >= thresholdMs;
}
