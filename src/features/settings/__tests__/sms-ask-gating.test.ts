import { describe, expect, it } from 'vitest';
import { shouldShowSmsAsk } from '../sms-ask-gating';

const base = {
  isActivated: true,
  demonstratedValue: true,
  dismissed: false,
  emailConsent: 'granted' as const,
  emailDecisionDayKey: '2026-09-03',
  todayKey: '2026-09-04',
  serverStatus: null as string | null,
};

describe('shouldShowSmsAsk', () => {
  it('returns false when the user is not activated', () => {
    expect(shouldShowSmsAsk({ ...base, isActivated: false })).toBe(false);
  });

  it('returns false before demonstrated value', () => {
    expect(shouldShowSmsAsk({ ...base, demonstratedValue: false })).toBe(false);
  });

  it('waits until a later day than the separate email choice', () => {
    expect(shouldShowSmsAsk({ ...base, emailConsent: 'unset' })).toBe(false);
    expect(shouldShowSmsAsk({ ...base, todayKey: '2026-09-03' })).toBe(false);
  });

  it('returns false when the ask was dismissed', () => {
    expect(shouldShowSmsAsk({ ...base, dismissed: true })).toBe(false);
  });

  it('returns false when the server status is pending', () => {
    expect(shouldShowSmsAsk({ ...base, serverStatus: 'pending' })).toBe(false);
  });

  it('returns false when the server status is confirmed', () => {
    expect(shouldShowSmsAsk({ ...base, serverStatus: 'confirmed' })).toBe(false);
  });

  it('returns true when the server status is null (no opt-in row)', () => {
    expect(shouldShowSmsAsk({ ...base, serverStatus: null })).toBe(true);
  });

  it('returns true when the server status is stopped', () => {
    expect(shouldShowSmsAsk({ ...base, serverStatus: 'stopped' })).toBe(true);
  });

  it('returns true when the server status is expired', () => {
    expect(shouldShowSmsAsk({ ...base, serverStatus: 'expired' })).toBe(true);
  });
});
