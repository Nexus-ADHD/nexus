/**
 * habit-first-step.ts — NEX-208 (H-6)
 *
 * Pure helpers for the "first step" / ephemeral "started" acknowledgment. RN-free
 * so the gate + the app-owned copy are unit-testable.
 *
 * §18: no em dashes, no exclamation points, no second-person coaching. "Started."
 * is a declarative acknowledgment. (User-authored firstStep text is NOT subject
 * to these rules and is never asserted here.)
 */

/** The momentary, flat acknowledgment shown when a first step is tapped. */
export const STARTED_ACK = 'Started.';

/**
 * Show the first-step line for a habit on Home only when a non-blank first step
 * is set AND the habit is not yet done. Once done, the row's gold ceremonial
 * check is the reward and the start prompt is gone.
 */
export function shouldShowFirstStep(
  firstStep: string | null | undefined,
  done: boolean,
): boolean {
  return typeof firstStep === 'string' && firstStep.trim().length > 0 && !done;
}
