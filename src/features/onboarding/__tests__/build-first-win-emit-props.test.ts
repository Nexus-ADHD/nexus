import { describe, expect, it, vi } from 'vitest';
import { buildFirstWinEmitProps, buildOnboardingTimingProps } from '../build-first-win-emit-props';

describe('buildOnboardingTimingProps', () => {
  it('omits both props (not 0/false) when the start timestamp is null', () => {
    expect(buildOnboardingTimingProps(null, true)).toEqual({});
  });

  it('computes seconds_since_onboarding_start and passes through the backgrounding flag', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      expect(buildOnboardingTimingProps(5_000, false)).toEqual({
        seconds_since_onboarding_start: 5,
        backgrounded_during_onboarding: false,
      });
      expect(buildOnboardingTimingProps(5_000, true)).toEqual({
        seconds_since_onboarding_start: 5,
        backgrounded_during_onboarding: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rounds to the nearest second', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_749); // 1.749s elapsed
    try {
      expect(buildOnboardingTimingProps(0, false).seconds_since_onboarding_start).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// NEX-299 S13: the omit-don't-fabricate rule, specifically for FirstWinCapture's
// emit() shape (phase/step/key + the timing fragment).
describe('buildFirstWinEmitProps', () => {
  it('omits seconds_since_onboarding_start / backgrounded_during_onboarding when startTimestampMs is null', () => {
    const props = buildFirstWinEmitProps(null, true, 'skipped');
    expect(props).toEqual({ phase: 'setup', step: 'first_win', key: 'skipped' });
    expect(props).not.toHaveProperty('seconds_since_onboarding_start');
    expect(props).not.toHaveProperty('backgrounded_during_onboarding');
  });

  it('includes both timing props alongside phase/step/key when startTimestampMs is known', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(120_000);
    try {
      expect(buildFirstWinEmitProps(60_000, true, 'captured')).toEqual({
        phase: 'setup',
        step: 'first_win',
        key: 'captured',
        seconds_since_onboarding_start: 60,
        backgrounded_during_onboarding: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('is uniform across all four FirstWinKey outcomes', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      for (const key of ['captured', 'fallback_text', 'voice_denied', 'skipped'] as const) {
        const props = buildFirstWinEmitProps(0, false, key);
        expect(props.key).toBe(key);
        expect(props.seconds_since_onboarding_start).toBe(10);
        expect(props.backgrounded_during_onboarding).toBe(false);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });
});
