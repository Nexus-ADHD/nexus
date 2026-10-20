import { describe, it, expect } from 'vitest';
import { subscriptionDateLabel } from '../subscription-label';

const base = { isTrial: false, willRenew: true, unsubscribeDetectedAt: null, billingIssueDetectedAt: null };

describe('subscriptionDateLabel (NEX-231 — honest post-cancel state)', () => {
  it('active paid that will renew → "Renews"', () => {
    expect(subscriptionDateLabel(base)).toBe('Renews');
  });

  it('cancelled but still in the paid period → "Access until" (the core honest state)', () => {
    expect(
      subscriptionDateLabel({ ...base, willRenew: false, unsubscribeDetectedAt: '2026-07-18T00:00:00Z' }),
    ).toBe('Access until');
  });

  it('billing retry / grace (willRenew false but NOT cancelled) → "Renewal pending", not "Access until"', () => {
    expect(
      subscriptionDateLabel({ ...base, willRenew: false, billingIssueDetectedAt: '2026-07-01T00:00:00Z' }),
    ).toBe('Renewal pending');
  });

  it('active trial, not cancelled → "Free until" (a trial converts, it does not renew)', () => {
    expect(subscriptionDateLabel({ ...base, isTrial: true })).toBe('Free until');
  });

  it('cancel takes precedence over a concurrent billing issue (explicit user action wins)', () => {
    expect(
      subscriptionDateLabel({
        isTrial: true,
        willRenew: false,
        unsubscribeDetectedAt: '2026-07-18T00:00:00Z',
        billingIssueDetectedAt: '2026-07-01T00:00:00Z',
      }),
    ).toBe('Access until');
  });

  it('a cancelled trial reads "Access until", not "Free until"', () => {
    expect(
      subscriptionDateLabel({ ...base, isTrial: true, willRenew: false, unsubscribeDetectedAt: '2026-06-25T00:00:00Z' }),
    ).toBe('Access until');
  });

  it('active but non-renewing (willRenew false, no cancel/billing/trial signal) → "Access until", never "Renews"', () => {
    expect(subscriptionDateLabel({ ...base, willRenew: false })).toBe('Access until');
  });
});
