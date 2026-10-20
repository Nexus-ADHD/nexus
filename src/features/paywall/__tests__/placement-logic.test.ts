// NEX-123 — pure-Node tests for the value-moment placement decision logic.
import { describe, it, expect } from 'vitest';
import {
  resolveFlagVariant,
  decidePlacement,
  CAPS,
  DAY_MS,
  type PlacementDecisionInput,
} from '../placement-logic';

describe('resolveFlagVariant (fail-safe)', () => {
  const ok = { consentGranted: true, clientDisabled: false };

  it('returns the variant only when consent granted + client enabled + known variant', () => {
    expect(resolveFlagVariant({ ...ok, rawVariant: 'control' })).toBe('control');
    expect(resolveFlagVariant({ ...ok, rawVariant: 'annual_focus' })).toBe('annual_focus');
  });

  it('returns null when consent is NOT granted, even with a cached known variant', () => {
    // The core fail-safe: a cached/bootstrapped flag is readable while opted-out, so consent
    // is the independent gate. control variant + no consent must NOT present.
    expect(resolveFlagVariant({ consentGranted: false, clientDisabled: false, rawVariant: 'control' })).toBeNull();
    expect(resolveFlagVariant({ consentGranted: false, clientDisabled: false, rawVariant: 'annual_focus' })).toBeNull();
  });

  it('returns null when the client is disabled', () => {
    expect(resolveFlagVariant({ consentGranted: true, clientDisabled: true, rawVariant: 'control' })).toBeNull();
  });

  it('returns null for off / boolean / undefined / unknown raw values', () => {
    for (const rawVariant of ['off', true, false, undefined, 'annual', 'ANNUAL_FOCUS', '', 'experiment'] as const) {
      expect(resolveFlagVariant({ ...ok, rawVariant })).toBeNull();
    }
  });
});

describe('decidePlacement', () => {
  const base: PlacementDecisionInput = {
    placementId: 'first_alignment',
    variant: 'control',
    isSubscribed: false,
    isLegacyFree: false,
    now: 10 * DAY_MS,
    lastShownAt: null,
    lastAnyShownAt: null,
    lastDismissedAt: null,
    shownThisSession: false,
    ceremonyActive: false,
  };

  it('shows on the happy path and passes the variant through', () => {
    expect(decidePlacement(base)).toEqual({ show: true, variant: 'control', reason: 'show' });
    expect(decidePlacement({ ...base, variant: 'annual_focus' })).toEqual({
      show: true,
      variant: 'annual_focus',
      reason: 'show',
    });
  });

  it('never shows to a subscriber or a legacy-free user (distinct reasons for analytics)', () => {
    expect(decidePlacement({ ...base, isSubscribed: true }).show).toBe(false);
    expect(decidePlacement({ ...base, isSubscribed: true }).reason).toBe('subscribed');
    expect(decidePlacement({ ...base, isLegacyFree: true }).show).toBe(false);
    expect(decidePlacement({ ...base, isLegacyFree: true }).reason).toBe('legacy-free');
  });

  it('never shows when the variant is null (fail-safe flag)', () => {
    const d = decidePlacement({ ...base, variant: null });
    expect(d.show).toBe(false);
    expect(d.reason).toBe('flag-off-or-unresolved');
  });

  it('never shows while a ceremony is active (structural guardrail, fail-closed)', () => {
    const d = decidePlacement({ ...base, ceremonyActive: true });
    expect(d.show).toBe(false);
    expect(d.reason).toBe('ceremony-active');
  });

  it('the guardrail outranks the frequency caps (sacred moment can never be overridden)', () => {
    // Even with every cap satisfied, an active ceremony blocks — and even a subscriber+ceremony
    // resolves to the earlier (subscribed) reason, proving order.
    expect(decidePlacement({ ...base, ceremonyActive: true }).show).toBe(false);
    expect(decidePlacement({ ...base, isSubscribed: true, ceremonyActive: true }).reason).toBe('subscribed');
  });

  it('never shows two paywalls in one session', () => {
    expect(decidePlacement({ ...base, shownThisSession: true }).reason).toBe('already-shown-this-session');
  });

  describe('post-dismissal suppression (7 days)', () => {
    it('suppresses within the window', () => {
      const lastDismissedAt = base.now - (CAPS.postDismissSuppressionMs - 1);
      expect(decidePlacement({ ...base, lastDismissedAt }).reason).toBe('post-dismiss-suppression');
    });
    it('allows once the window has fully elapsed', () => {
      const lastDismissedAt = base.now - CAPS.postDismissSuppressionMs;
      expect(decidePlacement({ ...base, lastDismissedAt }).show).toBe(true);
    });
  });

  describe('global 48h floor across all placements', () => {
    it('suppresses within 48h of ANY paywall', () => {
      const lastAnyShownAt = base.now - (CAPS.globalFloorMs - 1);
      expect(decidePlacement({ ...base, lastAnyShownAt }).reason).toBe('global-floor');
    });
    it('allows after 48h', () => {
      const lastAnyShownAt = base.now - CAPS.globalFloorMs;
      expect(decidePlacement({ ...base, lastAnyShownAt }).show).toBe(true);
    });
  });

  describe('per-placement 24h cooldown', () => {
    it('suppresses within 24h of THIS placement (with the global floor already clear)', () => {
      const lastShownAt = base.now - (CAPS.perPlacementCooldownMs - 1);
      // lastAnyShownAt set far enough back that only the per-placement cooldown is in play.
      const lastAnyShownAt = base.now - (CAPS.globalFloorMs + DAY_MS);
      expect(decidePlacement({ ...base, lastShownAt, lastAnyShownAt }).reason).toBe('per-placement-cooldown');
    });
    it('allows after 24h (global floor clear)', () => {
      const lastShownAt = base.now - CAPS.perPlacementCooldownMs;
      const lastAnyShownAt = base.now - (CAPS.globalFloorMs + DAY_MS);
      expect(decidePlacement({ ...base, lastShownAt, lastAnyShownAt }).show).toBe(true);
    });
  });

  it('cap order: dismissal suppression is reported before the global floor', () => {
    // Both windows active → the earlier-checked (longer, more protective) dismissal rule wins.
    const d = decidePlacement({
      ...base,
      lastDismissedAt: base.now - DAY_MS,
      lastAnyShownAt: base.now - DAY_MS,
    });
    expect(d.reason).toBe('post-dismiss-suppression');
  });

  describe('adversarial clock / timestamps (fail-safe-suppress)', () => {
    it('fails CLOSED on a non-finite now (NaN/Infinity must not bypass the caps)', () => {
      for (const now of [NaN, Infinity, -Infinity]) {
        const d = decidePlacement({ ...base, now });
        expect(d.show).toBe(false);
        expect(d.reason).toBe('invalid-now');
      }
    });

    it('treats a FUTURE timestamp (clock skew) as still in-window → suppress', () => {
      const future = base.now + DAY_MS;
      expect(decidePlacement({ ...base, lastDismissedAt: future }).reason).toBe('post-dismiss-suppression');
      expect(decidePlacement({ ...base, lastAnyShownAt: future }).reason).toBe('global-floor');
      // global floor cleared (far past) so the per-placement cooldown is the one in play.
      expect(
        decidePlacement({ ...base, lastShownAt: future, lastAnyShownAt: base.now - (CAPS.globalFloorMs + DAY_MS) }).reason,
      ).toBe('per-placement-cooldown');
    });

    it('treats a non-finite stored timestamp as in-window → suppress (never leaks)', () => {
      expect(decidePlacement({ ...base, lastDismissedAt: NaN }).reason).toBe('post-dismiss-suppression');
      expect(decidePlacement({ ...base, lastAnyShownAt: Infinity }).reason).toBe('global-floor');
    });
  });
});
