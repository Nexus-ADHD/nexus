import { describe, expect, it } from 'vitest';
import { isGenuineDismiss, resolvePaywallMode } from '../remote-paywall-logic';

describe('isGenuineDismiss', () => {
  it('is true only when nothing completed (a real close → NEX-234 free tier)', () => {
    expect(isGenuineDismiss({ purchaseCompleted: false, restoreCompleted: false })).toBe(true);
  });
  it('is false after a purchase (RC fires onDismiss on purchase too → unlock, not dismiss)', () => {
    expect(isGenuineDismiss({ purchaseCompleted: true, restoreCompleted: false })).toBe(false);
  });
  it('is false after a restore', () => {
    expect(isGenuineDismiss({ purchaseCompleted: false, restoreCompleted: true })).toBe(false);
  });
});

describe('resolvePaywallMode (NEX-121 A/B arm selection)', () => {
  it('renders the RC remote template when offerings load and variant is standard', () => {
    expect(resolvePaywallMode({ hasOffering: true, variant: 'standard' })).toBe('remote');
  });
  it('falls back to the in-bundle screen when offerings do not load', () => {
    expect(resolvePaywallMode({ hasOffering: false, variant: 'standard' })).toBe('fallback');
  });
  it('forces the in-bundle fallback for data_preview EVEN when offerings load (custom layout, not an RC template)', () => {
    expect(resolvePaywallMode({ hasOffering: true, variant: 'data_preview' })).toBe('fallback');
    expect(resolvePaywallMode({ hasOffering: false, variant: 'data_preview' })).toBe('fallback');
  });
});
