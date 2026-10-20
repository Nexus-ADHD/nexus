/**
 * voice-reflection.ts — NEX-211 (A-2)
 *
 * The one-time "whose voice is this?" reflection shown on the Align tab, to help
 * the user separate intrinsic values from inherited shoulds (introjection). Copy
 * + gating live here (RN-free) so the §18 compliance and the hydration gate are
 * unit-testable without a renderer.
 *
 * §18: no em dashes, no exclamation points, no second-person coaching. The body
 * is declarative third-person (a reflection to sit with, not an instruction).
 */

/** Device-local coachmark flag (per the nexus_hasSeen* convention). */
export const VOICE_REFLECTION_FLAG = 'nexus_hasSeenVoiceReflection';

export const VOICE_REFLECTION_QUESTION = 'Whose voice is this: yours, or one you inherited?';
export const VOICE_REFLECTION_BODY = 'Some voices are chosen. Some were inherited.';
export const VOICE_REFLECTION_DISMISS = 'NOTED';

/** Every on-screen string, for the §18 machine-check + the render. */
export const VOICE_REFLECTION_STRINGS = [
  VOICE_REFLECTION_QUESTION,
  VOICE_REFLECTION_BODY,
  VOICE_REFLECTION_DISMISS,
] as const;

/**
 * Whether to show the reflection. `seen` is the LOADED flag tri-state:
 *   null  — not read from storage yet → don't show (no flash before hydration)
 *   true  — already dismissed → don't show
 *   false — loaded and unseen → show once
 */
export function shouldShowVoiceReflection(seen: boolean | null): boolean {
  return seen === false;
}
