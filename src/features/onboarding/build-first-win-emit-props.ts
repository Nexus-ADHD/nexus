// NEX-299: pure prop-building helpers for the onboarding time-to-first-value
// instrumentation. Extracted from first-win-capture.tsx's emit() specifically
// so the omit-don't-fabricate rule (no start timestamp yet → omit the
// duration/backgrounding props, never send 0/false) is unit-testable — this
// repo's vitest setup is pure-Node with no RN runtime, so anything living
// inside the RN component can't be exercised this way.

export type FirstWinKey = 'captured' | 'fallback_text' | 'voice_denied' | 'skipped';

export interface OnboardingTimingProps {
  seconds_since_onboarding_start?: number;
  backgrounded_during_onboarding?: boolean;
}

// Shared by both FirstWinCapture's emit() and onboarding_finished — a
// timing-only fragment so onboarding_finished's trackEvent call can spread
// it in without depending on anything first-win-shaped.
export function buildOnboardingTimingProps(
  startTimestampMs: number | null,
  backgroundedDuringOnboarding: boolean,
): OnboardingTimingProps {
  if (startTimestampMs === null) return {};
  return {
    seconds_since_onboarding_start: Math.round((Date.now() - startTimestampMs) / 1000),
    backgrounded_during_onboarding: backgroundedDuringOnboarding,
  };
}

export function buildFirstWinEmitProps(
  startTimestampMs: number | null,
  backgroundedDuringOnboarding: boolean,
  key: FirstWinKey,
): { phase: 'setup'; step: 'first_win'; key: FirstWinKey } & OnboardingTimingProps {
  return {
    phase: 'setup',
    step: 'first_win',
    key,
    ...buildOnboardingTimingProps(startTimestampMs, backgroundedDuringOnboarding),
  };
}
