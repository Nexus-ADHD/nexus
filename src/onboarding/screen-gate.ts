// NEX-36 — render-gate the overlay against the active tab.
//
// The onboarding flow auto-starts via a 600ms setTimeout in home-screen.tsx.
// If the user routes away from Home (post-onboarding destination picker,
// for example) within that window, the timer still fires from Home's
// still-mounted useEffect closure and the overlay was previously
// rendering its scrim + tooltip on top of whatever tab the user landed
// on. This helper is the engine-level safety net: when a step declares
// `screen`, render only while that tab is focused.
//
// Pure, no React, no navigation imports — kept testable from vitest.

import type { OnboardingStep } from './onboarding-flows';

/**
 * Returns true when the step is safe to render given the currently-
 * focused tab.
 *
 * Rules:
 *   - `step.screen` undefined → render on any route (back-compat for
 *     pre-NEX-36 steps without the field).
 *   - `activeRoute` null / undefined / empty → render (defensive:
 *     mid-navigation transitions can briefly report no active route,
 *     and flickering the overlay off during a transition is worse
 *     than rendering it for a frame on the right screen).
 *   - `step.screen === activeRoute` → render.
 *   - else → do NOT render.
 */
export function shouldRenderStepForScreen(
  step: OnboardingStep,
  activeRoute: string | null | undefined,
): boolean {
  if (!step.screen) return true;
  if (activeRoute == null || activeRoute === '') return true;
  return step.screen === activeRoute;
}
