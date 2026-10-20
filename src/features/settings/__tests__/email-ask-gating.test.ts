import { describe, expect, it } from 'vitest';
import { shouldShowEmailAsk } from '../email-ask-gating';

const habitLog = [
  '2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02',
  '2026-09-03', '2026-09-03', '2026-09-03',
].map((dateKey, index) => ({ id: String(index), habitTitle: 'read', goalIds: [], dateKey, timestamp: index }));

const base = {
  isActivated: true,
  analyticsConsent: 'granted' as const,
  emailConsent: 'unset' as const,
  habitLog,
  reviewAttempt: {
    status: 'attempted' as const,
    appVersion: '2.1',
    dayKey: '2026-09-03',
    attemptedAt: 1,
  },
  todayKey: '2026-09-04',
};

describe('email invitation gating', () => {
  it('shows only on a later day than the review attempt', () => {
    expect(shouldShowEmailAsk(base)).toBe(true);
    expect(shouldShowEmailAsk({ ...base, todayKey: '2026-09-03' })).toBe(false);
  });

  it('stays hidden until analytics is decided and value is demonstrated', () => {
    expect(shouldShowEmailAsk({ ...base, analyticsConsent: 'unset' })).toBe(false);
    expect(shouldShowEmailAsk({ ...base, habitLog: habitLog.slice(0, 6) })).toBe(false);
  });

  it('never re-asks after either explicit choice', () => {
    expect(shouldShowEmailAsk({ ...base, emailConsent: 'granted' })).toBe(false);
    expect(shouldShowEmailAsk({ ...base, emailConsent: 'denied' })).toBe(false);
  });
});
