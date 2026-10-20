// NEX-122 — trial-copy pure helper coverage.
import { describe, it, expect } from 'vitest';
import {
  formatTrialPeriod,
  buildTrialDisclosure,
  resolveEffectiveTrialPeriod,
  type IntroOffer,
} from '../trial-copy';

const intro = (o: Partial<IntroOffer>): IntroOffer => ({
  price: 0,
  periodUnit: 'DAY',
  periodNumberOfUnits: 7,
  ...o,
});

describe('formatTrialPeriod', () => {
  it('formats a standard 7-day free trial', () => {
    expect(formatTrialPeriod(intro({ periodUnit: 'DAY', periodNumberOfUnits: 7 }))).toBe('7 days');
  });

  it('singularizes a one-week trial', () => {
    expect(formatTrialPeriod(intro({ periodUnit: 'WEEK', periodNumberOfUnits: 1 }))).toBe('1 week');
  });

  it('states the single subscription period (multi-unit)', () => {
    expect(formatTrialPeriod(intro({ periodUnit: 'MONTH', periodNumberOfUnits: 1 }))).toBe('1 month');
    expect(formatTrialPeriod(intro({ periodUnit: 'WEEK', periodNumberOfUnits: 2 }))).toBe('2 weeks');
  });

  it('ignores cycles — never over-states the free length', () => {
    // A free trial is a single period; an unexpected cycles>1 must NOT inflate it.
    expect(formatTrialPeriod({ price: 0, periodUnit: 'MONTH', periodNumberOfUnits: 1, cycles: 3 } as any)).toBe('1 month');
  });

  it('normalizes unit casing', () => {
    expect(formatTrialPeriod(intro({ periodUnit: 'year', periodNumberOfUnits: 1 }))).toBe('1 year');
  });

  it('returns null for a paid intro offer (not a free trial)', () => {
    expect(formatTrialPeriod(intro({ price: 4.99 }))).toBeNull();
  });

  it('returns null for null/undefined intro', () => {
    expect(formatTrialPeriod(null)).toBeNull();
    expect(formatTrialPeriod(undefined)).toBeNull();
  });

  it('returns null for an unknown period unit', () => {
    expect(formatTrialPeriod(intro({ periodUnit: 'FORTNIGHT' }))).toBeNull();
    expect(formatTrialPeriod(intro({ periodUnit: '' }))).toBeNull();
  });

  it('returns null for non-positive / non-finite period counts', () => {
    expect(formatTrialPeriod(intro({ periodNumberOfUnits: 0 }))).toBeNull();
    expect(formatTrialPeriod(intro({ periodNumberOfUnits: -7 }))).toBeNull();
    expect(formatTrialPeriod(intro({ periodNumberOfUnits: Number.NaN }))).toBeNull();
  });
});

describe('buildTrialDisclosure', () => {
  it('states the trial length and conditional first charge when both are known', () => {
    expect(
      buildTrialDisclosure({ productLoaded: true, trialPeriod: '7 days', priceLabel: '$99.99/yr' }),
    ).toBe('Free for 7 days. Then $99.99/yr unless cancelled. Cancel anytime in Settings.');
  });

  it('falls back to generic billing when the trial is known but the price is not', () => {
    expect(
      buildTrialDisclosure({ productLoaded: true, trialPeriod: '7 days', priceLabel: null }),
    ).toBe('Free for 7 days. Then billed automatically unless cancelled. Cancel anytime in Settings.');
  });

  it('never claims a trial when a loaded product has none', () => {
    expect(
      buildTrialDisclosure({ productLoaded: true, trialPeriod: null, priceLabel: '$14.99/mo' }),
    ).toBe('$14.99/mo, renews until cancelled. Cancel anytime in Settings.');
    expect(
      buildTrialDisclosure({ productLoaded: true, trialPeriod: null, priceLabel: null }),
    ).toBe('Renews until cancelled. Cancel anytime in Settings.');
  });

  it('defers to the App Store when no product is loaded', () => {
    expect(
      buildTrialDisclosure({ productLoaded: false, trialPeriod: null, priceLabel: null }),
    ).toBe('The App Store confirms the trial length and price before purchase. Cancel anytime in Settings.');
  });
});

describe('resolveEffectiveTrialPeriod', () => {
  it('suppresses the trial ONLY when the user is explicitly ineligible', () => {
    expect(resolveEffectiveTrialPeriod('7 days', false)).toBeNull();
  });

  it('keeps the trial for eligible / unknown / not-yet-fetched users (fail-safe)', () => {
    expect(resolveEffectiveTrialPeriod('7 days', true)).toBe('7 days');
    expect(resolveEffectiveTrialPeriod('7 days', null)).toBe('7 days');
    expect(resolveEffectiveTrialPeriod('7 days', undefined)).toBe('7 days');
  });

  it('never conjures a trial when the product has none, regardless of eligibility', () => {
    expect(resolveEffectiveTrialPeriod(null, true)).toBeNull();
    expect(resolveEffectiveTrialPeriod(null, null)).toBeNull();
    expect(resolveEffectiveTrialPeriod(null, false)).toBeNull();
  });
});

describe('buildTrialDisclosure voice', () => {
  it('emits no §18-banned characters in any branch', () => {
    const samples = [
      buildTrialDisclosure({ productLoaded: true, trialPeriod: '7 days', priceLabel: '$99.99/yr' }),
      buildTrialDisclosure({ productLoaded: true, trialPeriod: '7 days', priceLabel: null }),
      buildTrialDisclosure({ productLoaded: true, trialPeriod: null, priceLabel: '$14.99/mo' }),
      buildTrialDisclosure({ productLoaded: true, trialPeriod: null, priceLabel: null }),
      buildTrialDisclosure({ productLoaded: false, trialPeriod: null, priceLabel: null }),
    ];
    for (const s of samples) {
      expect(s).not.toMatch(/[—!🎉✓]/); // no em dash, exclamation, emoji/checkmark
    }
  });
});
