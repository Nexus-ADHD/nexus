import { describe, it, expect } from 'vitest';
import { decideReoffer, parseReofferState, REOFFER_CAPS, DAY_MS, type ReofferInput } from '../reoffer-logic';

const NOW = Date.UTC(2026, 9, 11, 15, 0, 0);
const base: ReofferInput = {
  now: NOW,
  isSubscribed: false,
  isLegacyFree: false,
  launchGateDismissed: true,
  activatedDate: new Date(NOW - 2 * DAY_MS).toISOString(),
  firstWin: true,
  state: { count: 0, lastShownAt: null },
  shownThisSession: false,
  blocked: false,
};

describe('decideReoffer', () => {
  it('shows after a first win once a day has passed since the launch gate', () => {
    expect(decideReoffer(base)).toEqual({ show: true, trigger: 'first_win', reason: 'show' });
  });
  it('falls back to day 3 of use when there is no first win', () => {
    const r = decideReoffer({ ...base, firstWin: false, activatedDate: new Date(NOW - 3 * DAY_MS).toISOString() });
    expect(r).toEqual({ show: true, trigger: 'day_3', reason: 'show' });
  });
  it('waits when no first win and before day 3', () => {
    expect(decideReoffer({ ...base, firstWin: false }).reason).toBe('no-trigger-yet');
  });
  it('does not re-offer inside the first day, even right after the first win', () => {
    const r = decideReoffer({ ...base, activatedDate: new Date(NOW - 5 * 60_000).toISOString() });
    expect(r.reason).toBe('too-soon-after-launch-gate');
  });
  it('never shows to subscribers/trialists, grandfathered full-access users, or while the launch gate is still pending', () => {
    expect(decideReoffer({ ...base, isSubscribed: true }).reason).toBe('subscribed');
    expect(decideReoffer({ ...base, launchGateDismissed: false }).reason).toBe('launch-gate-pending');
    expect(decideReoffer({ ...base, isLegacyFree: true }).reason).toBe('legacy-free');
    expect(decideReoffer({ ...base, launchGateDismissed: false, isLegacyFree: true }).show).toBe(false);
  });
  it('fails closed when blocked, once per session, and on a bad clock', () => {
    expect(decideReoffer({ ...base, blocked: true }).show).toBe(false);
    expect(decideReoffer({ ...base, shownThisSession: true }).reason).toBe('already-shown-this-session');
    expect(decideReoffer({ ...base, now: NaN }).reason).toBe('invalid-now');
    expect(decideReoffer({ ...base, activatedDate: null }).reason).toBe('not-activated');
  });
  it('enforces the 7-day gap and the lifetime cap', () => {
    const recent = { count: 1, lastShownAt: NOW - 6 * DAY_MS };
    expect(decideReoffer({ ...base, state: recent }).reason).toBe('min-gap');
    const ok = { count: 1, lastShownAt: NOW - REOFFER_CAPS.minGapMs };
    expect(decideReoffer({ ...base, state: ok }).show).toBe(true);
    expect(decideReoffer({ ...base, state: { count: 3, lastShownAt: NOW - 30 * DAY_MS } }).reason).toBe('lifetime-cap');
  });
  it('treats a future lastShownAt as in-window', () => {
    expect(decideReoffer({ ...base, state: { count: 1, lastShownAt: NOW + DAY_MS } }).reason).toBe('min-gap');
  });
});

describe('parseReofferState', () => {
  it('parses a good record', () => {
    expect(parseReofferState('{"count":2,"lastShownAt":5}')).toEqual({ count: 2, lastShownAt: 5 });
  });
  it('defaults when empty, and fails closed (capped) when corrupt', () => {
    expect(parseReofferState(null)).toEqual({ count: 0, lastShownAt: null });
    expect(parseReofferState('{nope').count).toBe(REOFFER_CAPS.maxLifetime);
  });
});
