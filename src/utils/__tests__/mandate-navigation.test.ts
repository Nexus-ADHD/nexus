import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pushToMandateDetail,
  releaseMandateDetailNavigationGuard,
  resetMandateDetailNavigationGuardForTest,
} from '../mandate-navigation';

describe('pushToMandateDetail', () => {
  beforeEach(() => {
    resetMandateDetailNavigationGuardForTest();
  });

  it('allows only one push while mandate-detail navigation is in flight', () => {
    const router = { push: vi.fn() };

    for (let i = 0; i < 10; i += 1) {
      pushToMandateDetail(router, 'pillar-1');
    }

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/mandate/pillar-1');
  });

  it('allows another push after the destination route releases the guard', () => {
    const router = { push: vi.fn() };

    expect(pushToMandateDetail(router, 'pillar-1')).toBe(true);
    expect(pushToMandateDetail(router, 'pillar-1')).toBe(false);

    releaseMandateDetailNavigationGuard('pillar-1');

    expect(pushToMandateDetail(router, 'pillar-2')).toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenLastCalledWith('/mandate/pillar-2');
  });

  it('resets the guard when router.push throws', () => {
    const failingRouter = {
      push: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const router = { push: vi.fn() };

    expect(() => pushToMandateDetail(failingRouter, 'pillar-1')).toThrow('boom');
    expect(pushToMandateDetail(router, 'pillar-1')).toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});

describe('pushToMandateDetail fallback timeout', () => {
  beforeEach(() => {
    resetMandateDetailNavigationGuardForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMandateDetailNavigationGuardForTest();
  });

  it('auto-releases the guard after 1500ms when focus never fires', () => {
    const router = { push: vi.fn() };

    expect(pushToMandateDetail(router, 'pillar-1')).toBe(true);
    // Without the fallback, this second push would be blocked indefinitely.
    expect(pushToMandateDetail(router, 'pillar-2')).toBe(false);

    vi.advanceTimersByTime(1500);

    expect(pushToMandateDetail(router, 'pillar-2')).toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenNthCalledWith(1, '/mandate/pillar-1');
    expect(router.push).toHaveBeenNthCalledWith(2, '/mandate/pillar-2');
  });

  it('normal release cancels the stale timer so it does not clear a fresh guard', () => {
    const router = { push: vi.fn() };

    // t=0: push pillar-1, timer T1 scheduled to auto-release at t=1500.
    expect(pushToMandateDetail(router, 'pillar-1')).toBe(true);
    // Focus-driven release immediately. T1 must be cancelled here.
    releaseMandateDetailNavigationGuard('pillar-1');

    // Skip ahead 100ms so pillar-2's own fallback (scheduled at the
    // moment of push) fires AFTER pillar-1's original would-fire-at.
    vi.advanceTimersByTime(100);

    // t=100: push pillar-2, timer T2 scheduled to auto-release at t=1600.
    expect(pushToMandateDetail(router, 'pillar-2')).toBe(true);

    // Advance to t=1599: well past pillar-1's original fire instant
    // (t=1500) but still 1ms short of pillar-2's own window. If T1
    // had leaked, the guard would have been cleared at t=1500.
    vi.advanceTimersByTime(1499);

    // pillar-2's guard MUST still be held — a subsequent push fails.
    expect(pushToMandateDetail(router, 'pillar-3')).toBe(false);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenLastCalledWith('/mandate/pillar-2');
  });
});
