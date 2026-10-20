import { describe, expect, it, vi, beforeEach } from 'vitest';

// AsyncStorage is pulled in transitively by analytics.ts, which the
// tracker imports. Tests run in pure Node — stub the native module so
// the import graph resolves.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));


vi.mock('../analytics', () => ({
  trackEvent: vi.fn(async () => undefined),
  getActivationFiredAt: vi.fn(async () => null),
  markActivationFired: vi.fn(async () => undefined),
  recordBaselineActivation: vi.fn(async () => undefined),
}));
import {
  computeQualifyingDays,
  hasThreeConsecutive,
} from '../activation-tracker';

// Build a fixed-anchor activation date so the trial window contains
// every fixture date used below. Using "noon" avoids any DST hairs.
const ACTIVATED_AT = '2026-05-01T12:00:00.000Z';

describe('hasThreeConsecutive', () => {
  it('returns false for fewer than 3 days', () => {
    expect(hasThreeConsecutive([])).toBe(false);
    expect(hasThreeConsecutive(['2026-05-01'])).toBe(false);
    expect(hasThreeConsecutive(['2026-05-01', '2026-05-02'])).toBe(false);
  });

  it('returns true when three calendar-adjacent days are present', () => {
    expect(hasThreeConsecutive(['2026-05-01', '2026-05-02', '2026-05-03'])).toBe(true);
  });

  it('returns false when three non-adjacent days are present', () => {
    expect(hasThreeConsecutive(['2026-05-01', '2026-05-03', '2026-05-05'])).toBe(false);
  });

  it('detects a run anywhere in a longer sequence', () => {
    expect(
      hasThreeConsecutive([
        '2026-05-01',
        '2026-05-03',
        '2026-05-04',
        '2026-05-05',
      ]),
    ).toBe(true);
  });

  it('handles unsorted input', () => {
    expect(
      hasThreeConsecutive(['2026-05-03', '2026-05-01', '2026-05-02']),
    ).toBe(true);
  });

  it('handles cross-month adjacency', () => {
    // Apr 30 → May 1 → May 2 — calendar-adjacent across month boundary.
    expect(
      hasThreeConsecutive(['2026-04-30', '2026-05-01', '2026-05-02']),
    ).toBe(true);
  });
});

describe('computeQualifyingDays', () => {
  beforeEach(() => {
    // Pin "now" so the trial-window upper bound is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
  });

  it('returns empty when not yet activated', () => {
    expect(
      computeQualifyingDays({
        activatedDate: null,
        habitLog: [{ dateKey: '2026-05-02' }],
        dailyTasks: { '2026-05-02': [{ completed: true }] },
      }),
    ).toEqual([]);
  });

  it('credits only days with BOTH a habit log AND a to-do clear', () => {
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [
        { dateKey: '2026-05-02' },
        { dateKey: '2026-05-03' },
        { dateKey: '2026-05-04' },
      ],
      // Only 5-02 and 5-04 have a cleared to-do — 5-03 logs habit but
      // clears no to-do, so it must not qualify.
      dailyTasks: {
        '2026-05-02': [{ completed: true }],
        '2026-05-03': [{ completed: false }],
        '2026-05-04': [{ completed: true }, { completed: false }],
      },
    });
    expect(result).toEqual(['2026-05-02', '2026-05-04']);
  });

  it('credits an inbox completion against its completedAt day (NEX-26 phase F.5)', () => {
    const completedAt = new Date('2026-05-05T09:00:00').getTime();
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [{ dateKey: '2026-05-05' }],
      inbox: [{ completed: true, completedAt }],
    });
    expect(result).toEqual(['2026-05-05']);
  });

  it('skips inbox completions that lack completedAt (legacy / Apple-sync)', () => {
    // Pre-NEX-26 inbox items have createdAt but no completedAt. The
    // tracker SKIPS them rather than guessing — better to under-credit
    // than to silently mis-credit. Without completedAt this day cannot
    // qualify, even though both habit-log and "completed" are true.
    const createdAt = new Date('2026-05-05T09:00:00').getTime();
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [{ dateKey: '2026-05-05' }],
      inbox: [{ completed: true, createdAt }] as any,
    });
    expect(result).toEqual([]);
  });

  it('credits the clear day, not the createdAt day, when both are present', () => {
    // The exact scenario NEX-26 introduced: to-dos seeded on activation
    // day and cleared on different later days. createdAt is the same
    // for all (activation day); completedAt differs. The tracker must
    // credit the clear days.
    const createdAt = new Date('2026-05-02T08:00:00').getTime();   // activation day
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [
        { dateKey: '2026-05-03' },
        { dateKey: '2026-05-04' },
        { dateKey: '2026-05-05' },
      ],
      inbox: [
        { completed: true, createdAt, completedAt: new Date('2026-05-03T20:00:00').getTime() },
        { completed: true, createdAt, completedAt: new Date('2026-05-04T20:00:00').getTime() },
        { completed: true, createdAt, completedAt: new Date('2026-05-05T20:00:00').getTime() },
      ],
    });
    expect(result).toEqual(['2026-05-03', '2026-05-04', '2026-05-05']);
  });



  it('credits a daily-task completion against completedAt day when present (v22)', () => {
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [{ dateKey: '2026-05-03' }],
      dailyTasks: {
        // Task lives under activation-day bucket but was completed later.
        '2026-05-01': [{ completed: true, completedAt: new Date('2026-05-03T18:00:00').getTime() }],
      },
    });
    expect(result).toEqual(['2026-05-03']);
  });

  it('falls back to daily-task bucket key when completedAt is absent (pre-v22)', () => {
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [{ dateKey: '2026-05-03' }],
      dailyTasks: {
        '2026-05-03': [{ completed: true }],
      },
    });
    expect(result).toEqual(['2026-05-03']);
  });

  it('excludes days outside the trial window', () => {
    // Trial = ACTIVATED_AT (2026-05-01) + 14 days = 2026-05-15. A log
    // dated 2026-04-30 (before activation) must NOT count even though
    // both sources have it.
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [{ dateKey: '2026-04-30' }, { dateKey: '2026-05-02' }],
      dailyTasks: {
        '2026-04-30': [{ completed: true }],
        '2026-05-02': [{ completed: true }],
      },
    });
    expect(result).toEqual(['2026-05-02']);
  });

  it('returns days sorted ascending', () => {
    const result = computeQualifyingDays({
      activatedDate: ACTIVATED_AT,
      habitLog: [
        { dateKey: '2026-05-04' },
        { dateKey: '2026-05-02' },
        { dateKey: '2026-05-03' },
      ],
      dailyTasks: {
        '2026-05-04': [{ completed: true }],
        '2026-05-02': [{ completed: true }],
        '2026-05-03': [{ completed: true }],
      },
    });
    expect(result).toEqual(['2026-05-02', '2026-05-03', '2026-05-04']);
  });
});

describe('startActivationTracker: qualifying-day emission is once per day across launches', () => {
  it('does not re-emit days already reported by an earlier launch', async () => {
    vi.useRealTimers();
    vi.resetModules();
    const store = new Map<string, string>();
    vi.doMock('@react-native-async-storage/async-storage', () => ({
      default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
        removeItem: async (k: string) => { store.delete(k); },
      },
    }));
    const trackEvent = vi.fn(async () => undefined);
    vi.doMock('../analytics', () => ({
      trackEvent,
      getActivationFiredAt: async () => null,
      markActivationFired: async () => undefined,
      recordBaselineActivation: async () => undefined,
    }));
    const today = new Date();
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const act = new Date(today.getTime() - 2 * 86400000);
    const state: any = {
      isActivated: true,
      activatedDate: act.toISOString(),
      habitLog: [{ dateKey: key(act) }, { dateKey: key(today) }],
      inbox: [],
      dailyTasks: {
        [key(act)]: [{ completed: true, completedAt: act.getTime() }],
        [key(today)]: [{ completed: true, completedAt: today.getTime() }],
      },
    };
    const mockStore = { getState: () => state, subscribe: () => () => undefined };
    const mod = await import('../activation-tracker');

    mod.startActivationTracker(mockStore);
    await new Promise((r) => setTimeout(r, 20));
    const firstLaunch = trackEvent.mock.calls.filter((c: any[]) => c[0] === 'activation_qualifying_day').length;
    expect(firstLaunch).toBe(2);

    // Simulated cold relaunch: module state resets, persisted storage survives.
    mod.__resetForTests();
    mod.startActivationTracker(mockStore);
    await new Promise((r) => setTimeout(r, 20));
    const total = trackEvent.mock.calls.filter((c: any[]) => c[0] === 'activation_qualifying_day').length;
    expect(total).toBe(2); // would be 4 before the fix
    mod.__resetForTests();
  });
});
