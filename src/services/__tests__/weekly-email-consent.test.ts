import { describe, expect, it } from 'vitest';
import {
  resolveConsentedWeeklyEmailRecipient,
  weeklyEmailConsentAllowsDelivery,
} from '../../../supabase/functions/_shared/weekly-email-consent';

describe('weekly email delivery consent', () => {
  it('requires both the enabled preference and explicit granted consent', () => {
    expect(weeklyEmailConsentAllowsDelivery({ weeklyEmailEnabled: true })).toBe(false);
    expect(weeklyEmailConsentAllowsDelivery({ weeklyEmailEnabled: true, weeklyEmailConsent: 'denied' })).toBe(false);
    expect(weeklyEmailConsentAllowsDelivery({ weeklyEmailEnabled: false, weeklyEmailConsent: 'granted' })).toBe(false);
    expect(weeklyEmailConsentAllowsDelivery({ weeklyEmailEnabled: true, weeklyEmailConsent: 'granted' })).toBe(true);
  });

  it('uses only a server-owned address after consent', () => {
    const granted = { weeklyEmailEnabled: true, weeklyEmailConsent: 'granted' };
    expect(resolveConsentedWeeklyEmailRecipient({
      stateData: granted,
      profileEmail: ' profile@example.com ',
      authEmail: 'auth@example.com',
    })).toBe('profile@example.com');
    expect(resolveConsentedWeeklyEmailRecipient({
      stateData: granted,
      authEmail: 'auth@example.com',
    })).toBe('auth@example.com');
    expect(resolveConsentedWeeklyEmailRecipient({
      stateData: { weeklyEmailEnabled: true, weeklyEmailConsent: 'denied' },
      profileEmail: 'profile@example.com',
    })).toBeNull();
  });
});
