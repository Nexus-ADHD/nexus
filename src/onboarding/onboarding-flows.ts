/**
 * Onboarding flow definitions.
 *
 * A flow is an ordered list of steps. Each step points at a target — a
 * named anchor registered via `useTarget(key)` somewhere in the app — and
 * carries the copy + CTA the overlay should render around that anchor.
 * Anchors should live on always-mounted, stable-layout elements whenever
 * possible. The overlay will auto-skip missing anchors, but stable anchors
 * keep flows deterministic and avoid dev-only misconfiguration warnings.
 *
 * Step content for the home flow lands in Phase 3. The empty `steps: []`
 * here is intentional: the engine builds + ships in Phase 2 with no
 * runtime impact (an empty flow short-circuits to `dismissFlow`).
 */

export type OnboardingPlacement = 'above' | 'below';

/**
 * Tab routes the overlay can gate against. NEX-36: matches the tab
 * names under `app/(tabs)/` — when a step declares `screen`, the
 * overlay renders nothing while a different tab is focused. Steps
 * without `screen` are back-compat and render on any route.
 */
export type TabRoute = 'home' | 'orbit' | 'inbox' | 'align' | 'command';

export interface OnboardingStep {
  /** Unique within the global completed-set. Persists in AsyncStorage. */
  id: string;
  /** Anchor key registered via useTarget(). Steps without one auto-skip. */
  targetKey?: string;
  /**
   * NEX-36: tab the step's anchor lives on. When set, the overlay
   * renders this step only while that tab is the focused tab. When
   * unset, the step renders on any route (back-compat).
   */
  screen?: TabRoute;
  title: string;
  body: string;
  cta: string;
  placement: OnboardingPlacement;
  /**
   * NEX-169: opt-in. When true, a target that measures off-viewport is NOT
   * immediately soft-failed (NEX-27) — the overlay retries measurement for a
   * bounded window so the host screen can scroll the target into view first.
   * Only set this on steps whose host scrolls the anchor into view; leaving it
   * unset preserves the immediate off-viewport skip for every other step.
   */
  scrollIntoView?: boolean;
}

export interface OnboardingFlow {
  id: string;
  steps: OnboardingStep[];
}

/**
 * Registry of named flows. Two contextual Home callouts.
 */
export const FLOWS: Record<string, OnboardingFlow> = {
  home: {
    id: 'home',
    // NEX-193: the guided first-habit step ('home-getting-started') was removed.
    // The win-first onboarding (a voice capture that materializes an item before
    // mandate capture) is now THE first action, so the Home "Your first win"
    // coachmark would be a redundant competing CTA. Home is now a single-step
    // flow; the hasSeenTutorial flip keys off 'home-score' (see home-screen.tsx).
    steps: [
      {
        id: 'home-score',
        targetKey: 'home.scoreCard',
        screen: 'home',
        title: "Today's score",
        body: 'This grows when your actions match your intentions. It resets each morning.',
        cta: 'Got it',
        placement: 'below',
      },
    ],
  },
};
