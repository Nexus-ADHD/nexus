import { describe, it, expect } from 'vitest';
import {
  computeBillingReminder,
  billingReminderContent,
  formatChargeDate,
  WINDOW_TRIAL_MS,
  WINDOW_RENEWAL_MS,
  type BillingReminderInfo,
} from '../billing-reminder-types';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

function info(over: Partial<BillingReminderInfo>): BillingReminderInfo {
  return {
    periodType: 'TRIAL',
    expirationMs: NOW + 10 * DAY,
    willRenew: true,
    plan: 'annual',
    familyShared: false,
    ...over,
  };
}

describe('computeBillingReminder', () => {
  it('null info → null', () => {
    expect(computeBillingReminder(null, NOW)).toBeNull();
  });

  it('trial converting → fires WINDOW_TRIAL before expiration', () => {
    const exp = NOW + 10 * DAY;
    const r = computeBillingReminder(info({ periodType: 'TRIAL', expirationMs: exp }), NOW);
    expect(r).toEqual({ kind: 'trial', fireAtMs: exp - WINDOW_TRIAL_MS, chargeMs: exp });
  });

  it('intro period is treated like a trial (also converts to a charge)', () => {
    const exp = NOW + 10 * DAY;
    const r = computeBillingReminder(info({ periodType: 'INTRO', expirationMs: exp }), NOW);
    expect(r?.kind).toBe('trial');
    expect(r?.fireAtMs).toBe(exp - WINDOW_TRIAL_MS);
  });

  it('cancelled-but-active trial (willRenew=false) → null (no upcoming charge)', () => {
    expect(computeBillingReminder(info({ periodType: 'TRIAL', willRenew: false }), NOW)).toBeNull();
  });

  it('annual renewal → fires WINDOW_RENEWAL before expiration', () => {
    const exp = NOW + 200 * DAY; // ~a year out, still scheduled directly
    const r = computeBillingReminder(info({ periodType: 'NORMAL', plan: 'annual', expirationMs: exp }), NOW);
    expect(r).toEqual({ kind: 'renewal', fireAtMs: exp - WINDOW_RENEWAL_MS, chargeMs: exp });
  });

  it('monthly renewal → null (out of scope)', () => {
    expect(computeBillingReminder(info({ periodType: 'NORMAL', plan: 'monthly', expirationMs: NOW + 20 * DAY }), NOW)).toBeNull();
  });

  it('annual renewal with willRenew=false → null', () => {
    expect(computeBillingReminder(info({ periodType: 'NORMAL', plan: 'annual', willRenew: false }), NOW)).toBeNull();
  });

  it('prepaid → null', () => {
    expect(computeBillingReminder(info({ periodType: 'PREPAID', expirationMs: NOW + 20 * DAY }), NOW)).toBeNull();
  });

  it('family-shared entitlement → null (this user is not the payer)', () => {
    expect(computeBillingReminder(info({ familyShared: true }), NOW)).toBeNull();
  });

  it('null / non-finite expiration → null (lifetime / unknown)', () => {
    expect(computeBillingReminder(info({ expirationMs: null }), NOW)).toBeNull();
    expect(computeBillingReminder(info({ expirationMs: NaN }), NOW)).toBeNull();
  });

  it('expiration already passed → null', () => {
    expect(computeBillingReminder(info({ expirationMs: NOW - DAY }), NOW)).toBeNull();
  });

  it('first observed already inside the window → null (no immediate catch-up)', () => {
    // trial expiring in 12h, window is 24h → fireAt would be in the past.
    const exp = NOW + 12 * 60 * 60 * 1000;
    expect(computeBillingReminder(info({ periodType: 'TRIAL', expirationMs: exp }), NOW)).toBeNull();
  });

  it('every non-null result fires strictly before the charge', () => {
    const cases: BillingReminderInfo[] = [
      info({ periodType: 'TRIAL', expirationMs: NOW + 5 * DAY }),
      info({ periodType: 'NORMAL', plan: 'annual', expirationMs: NOW + 300 * DAY }),
    ];
    for (const c of cases) {
      const r = computeBillingReminder(c, NOW);
      expect(r).not.toBeNull();
      expect(r!.fireAtMs).toBeGreaterThan(NOW);
      expect(r!.fireAtMs).toBeLessThan(r!.chargeMs);
    }
  });

  it('periodType casing is normalized', () => {
    expect(computeBillingReminder(info({ periodType: 'trial' }), NOW)?.kind).toBe('trial');
    expect(computeBillingReminder(info({ periodType: 'Normal', plan: 'annual', expirationMs: NOW + 100 * DAY }), NOW)?.kind).toBe('renewal');
  });
});

describe('billingReminderContent / formatChargeDate', () => {
  it('copy is warm and §18-clean (no em dash, no exclamation), price omitted', () => {
    for (const kind of ['trial', 'renewal'] as const) {
      const { title, body } = billingReminderContent(kind, NOW + 3 * DAY);
      expect(title).not.toMatch(/[—!]/);
      expect(body).not.toMatch(/[—!]/);
      expect(body).toMatch(/Manage anytime\./);
      expect(body).not.toMatch(/\$|\d+\.\d{2}/); // no price asserted
    }
  });

  it('trial vs renewal copy differ and name the charge date', () => {
    const ms = Date.UTC(2026, 5, 21, 9, 0, 0);
    const trial = billingReminderContent('trial', ms);
    const renew = billingReminderContent('renewal', ms);
    expect(trial.title).not.toBe(renew.title);
    // Local date string; assert it contains the day number to avoid tz-month flake.
    expect(trial.body).toContain(String(new Date(ms).getDate()));
  });

  it('formatChargeDate renders a local "Month D"', () => {
    const ms = Date.UTC(2026, 0, 15, 12, 0, 0);
    const s = formatChargeDate(ms);
    expect(s).toMatch(/^[A-Z][a-z]+ \d{1,2}$/);
  });
});
