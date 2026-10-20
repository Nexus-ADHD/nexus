import { describe, expect, it } from 'vitest';
import { shouldRenderStepForScreen } from '../screen-gate';
import type { OnboardingStep } from '../onboarding-flows';

// Build a minimal step fixture. We only care about the `screen` field
// here; the rest is filler that satisfies the type.
function step(overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    id: 'test-step',
    title: 'Test',
    body: 'Test body',
    cta: 'OK',
    placement: 'below',
    ...overrides,
  };
}

describe('shouldRenderStepForScreen', () => {
  it('renders on any route when step has no screen field (back-compat)', () => {
    const s = step(); // no screen
    expect(shouldRenderStepForScreen(s, 'home')).toBe(true);
    expect(shouldRenderStepForScreen(s, 'orbit')).toBe(true);
    expect(shouldRenderStepForScreen(s, null)).toBe(true);
    expect(shouldRenderStepForScreen(s, undefined)).toBe(true);
  });

  it('renders when step.screen matches activeRoute', () => {
    expect(shouldRenderStepForScreen(step({ screen: 'home' }), 'home')).toBe(true);
  });

  it('does NOT render when step.screen differs from activeRoute', () => {
    expect(shouldRenderStepForScreen(step({ screen: 'home' }), 'orbit')).toBe(false);
  });

  it('renders defensively when activeRoute is null (mid-navigation)', () => {
    expect(shouldRenderStepForScreen(step({ screen: 'home' }), null)).toBe(true);
  });

  it('renders defensively when activeRoute is undefined', () => {
    expect(shouldRenderStepForScreen(step({ screen: 'home' }), undefined)).toBe(true);
  });

  it('renders defensively when activeRoute is the empty string', () => {
    expect(shouldRenderStepForScreen(step({ screen: 'home' }), '')).toBe(true);
  });
});
