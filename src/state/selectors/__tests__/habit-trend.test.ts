import { describe, expect, it } from 'vitest';
import { EMPTY_PAUSE_MODE, type PauseModeState } from '@/src/state/pause-mode';
import { MAX_POINTS } from '@/src/components/ui/score-trend-chart-helpers';
import {
  TREND_WINDOW_DAYS,
  buildHabitLogIndex,
  defaultRangeForCadence,
  habitDailySeries,
} from '../habit-trend';

const noPause: PauseModeState = { ...EMPTY_PAUSE_MODE };

// 2026-08-25 is a Tuesday. The whole file anchors to it so weekday math is
// checkable by hand: Sun 23, Mon 24, Tue 25.
const END = '2026-08-25';

/** Epoch ms for a local YYYY-MM-DD at noon (no UTC drift). */
const at = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
};

const log = (habitTitle: string, dateKey: string) => ({ habitTitle, dateKey });

/** `n` consecutive day-keys ending at `end`, oldest first. */
const daysEndingAt = (end: string, n: number): string[] => {
  const [y, m, d] = end.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const dt = new Date(y, m - 1, d - i, 12, 0, 0, 0);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
  }
  return out;
};

const DAILY = [0, 1, 2, 3, 4, 5, 6];

describe('buildHabitLogIndex', () => {
  it('buckets by normalized title and day, counting repeats', () => {
    const index = buildHabitLogIndex([
      log('Read', '2026-08-24'),
      log('  read  ', '2026-08-24'),
      log('READ', '2026-08-25'),
    ]);
    expect(index.get('read')?.get('2026-08-24')).toBe(2);
    expect(index.get('read')?.get('2026-08-25')).toBe(1);
  });

  it('keeps emoji titles distinct — the canonical key is emoji-sensitive', () => {
    const index = buildHabitLogIndex([log('Run', '2026-08-25'), log('Run 🏃', '2026-08-25')]);
    expect(index.get('run')?.get('2026-08-25')).toBe(1);
    expect(index.get('run 🏃')?.get('2026-08-25')).toBe(1);
  });

  it('is a total function on malformed input', () => {
    expect(buildHabitLogIndex(null).size).toBe(0);
    expect(buildHabitLogIndex(undefined).size).toBe(0);
    expect(buildHabitLogIndex('nope' as any).size).toBe(0);
    const index = buildHabitLogIndex([
      null as any,
      { dateKey: 'garbage', habitTitle: 'Read' },
      { habitTitle: 'Read' },
      { dateKey: '2026-08-25' }, // no title → no key
      log('Read', '2026-08-25'),
    ]);
    expect(index.size).toBe(1);
    expect(index.get('read')?.size).toBe(1);
  });
});

describe('habitDailySeries — a daily habit', () => {
  const rule = { id: 'r1', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: at('2026-08-01') };

  it('reads 100 for a perfect trailing week and 0 for an empty one', () => {
    const perfect = buildHabitLogIndex(daysEndingAt(END, 30).map((k) => log('Read', k)));
    expect(habitDailySeries(rule, perfect, noPause, END)[END]).toBe(100);

    const none = buildHabitLogIndex([]);
    expect(habitDailySeries(rule, none, noPause, END)[END]).toBe(0);
  });

  it('is a trailing SEVEN-day rate, not a same-day flag', () => {
    // Logged on 4 of the last 7 days → 57%. The day itself is unlogged, so a
    // same-day series would say 0 and a lifetime one would say something else.
    const index = buildHabitLogIndex(
      daysEndingAt(END, TREND_WINDOW_DAYS).slice(0, 4).map((k) => log('Read', k)),
    );
    expect(habitDailySeries(rule, index, noPause, END)[END]).toBe(Math.round((4 / 7) * 100));
  });

  it('emits one point per calendar day up to and including endKey', () => {
    const series = habitDailySeries(rule, buildHabitLogIndex([]), noPause, END);
    const keys = Object.keys(series).sort();
    expect(keys[0]).toBe('2026-08-01'); // createdAt day, not earlier
    expect(keys[keys.length - 1]).toBe(END);
    expect(keys).toHaveLength(25);
  });

  it('anchors to endKey, so a past period never runs to today', () => {
    const series = habitDailySeries(rule, buildHabitLogIndex([]), noPause, '2026-08-10');
    const keys = Object.keys(series).sort();
    expect(keys[keys.length - 1]).toBe('2026-08-10');
    expect(series[END]).toBeUndefined();
  });
});

describe('habitDailySeries — schedule awareness', () => {
  // Mon / Wed / Fri. In the week ending Tue Aug 25 the scheduled days are
  // Wed 19, Fri 21, Mon 24 — three occurrences, and Tue 25 is not one of them.
  const mwf = { id: 'r2', title: 'Lift', daysOfWeek: [1, 3, 5], timesPerDay: 1, createdAt: at('2026-07-01') };

  it('counts only scheduled occurrences in the denominator', () => {
    const index = buildHabitLogIndex([log('Lift', '2026-08-19'), log('Lift', '2026-08-24')]);
    expect(habitDailySeries(mwf, index, noPause, END)[END]).toBe(Math.round((2 / 3) * 100));
  });

  it('ignores off-schedule logs entirely — they are not rate credit', () => {
    const index = buildHabitLogIndex([
      log('Lift', '2026-08-19'),
      log('Lift', '2026-08-24'),
      log('Lift', '2026-08-25'), // Tuesday, not scheduled
      log('Lift', '2026-08-23'), // Sunday, not scheduled
    ]);
    expect(habitDailySeries(mwf, index, noPause, END)[END]).toBe(Math.round((2 / 3) * 100));
  });

  it('gives partial credit for timesPerDay > 1 and caps over-completion at 100', () => {
    const twice = { id: 'r3', title: 'Water', daysOfWeek: DAILY, timesPerDay: 2, createdAt: at('2026-08-01') };
    const week = daysEndingAt(END, TREND_WINDOW_DAYS);

    // One of two reps every day → exactly half.
    const half = buildHabitLogIndex(week.map((k) => log('Water', k)));
    expect(habitDailySeries(twice, half, noPause, END)[END]).toBe(50);

    // Five reps a day, every day — the per-day cap holds the rate at 100.
    const flood = buildHabitLogIndex(week.flatMap((k) => Array.from({ length: 5 }, () => log('Water', k))));
    expect(habitDailySeries(twice, flood, noPause, END)[END]).toBe(100);
  });

  it('returns an empty series for a rule with no scheduled weekdays', () => {
    const unscheduled = { id: 'r4', title: 'Read', daysOfWeek: [], timesPerDay: 1, createdAt: at('2026-08-01') };
    expect(habitDailySeries(unscheduled, buildHabitLogIndex([]), noPause, END)).toEqual({});
  });
});

describe('habitDailySeries — pause is not a miss', () => {
  const rule = { id: 'r5', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: at('2026-08-01') };

  it('drops paused days from the denominator rather than scoring them zero', () => {
    // Paused Wed 19 – Fri 21. Of the remaining four days in the trailing week
    // (22, 23, 24, 25) two are logged → 50, not 2/7.
    const pm: PauseModeState = {
      active: false,
      since: null,
      plannedUntil: null,
      history: [{ since: '2026-08-19', endedOn: '2026-08-21' }],
    };
    const index = buildHabitLogIndex([log('Read', '2026-08-24'), log('Read', '2026-08-25')]);
    expect(habitDailySeries(rule, index, pm, END)[END]).toBe(50);
  });

  it('emits NOTHING — a gap, never a zero — when a pause empties the window', () => {
    const pm: PauseModeState = {
      active: false,
      since: null,
      plannedUntil: null,
      history: [{ since: '2026-08-01', endedOn: END }],
    };
    expect(habitDailySeries(rule, buildHabitLogIndex([]), pm, END)).toEqual({});
  });
});

describe('habitDailySeries — a habit has no price before its IPO', () => {
  it('emits nothing before createdAt, and does not judge the week before it existed', () => {
    const rule = { id: 'r6', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: at('2026-08-24') };
    const index = buildHabitLogIndex([log('Read', '2026-08-24'), log('Read', END)]);
    const series = habitDailySeries(rule, index, noPause, END);
    expect(Object.keys(series).sort()).toEqual(['2026-08-24', '2026-08-25']);
    // Both created-era days logged — the six pre-creation days are not misses.
    expect(series['2026-08-24']).toBe(100);
    expect(series[END]).toBe(100);
  });

  it('returns an empty series when the rule was created after the reviewed period', () => {
    const rule = { id: 'r7', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: at('2026-09-01') };
    expect(habitDailySeries(rule, buildHabitLogIndex([]), noPause, END)).toEqual({});
  });

  it('clamps the createdAt === 0 v14 sentinel to the point cap, never to 1970', () => {
    const dawn = { id: 'r8', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: 0 };
    const keys = Object.keys(habitDailySeries(dawn, buildHabitLogIndex([]), noPause, END)).sort();
    expect(keys).toHaveLength(MAX_POINTS);
    expect(keys[keys.length - 1]).toBe(END);
    expect(keys[0] > '2020-01-01').toBe(true);

    // A missing createdAt is the same sentinel by another name.
    const bare = { id: 'r9', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1 };
    expect(Object.keys(habitDailySeries(bare, buildHabitLogIndex([]), noPause, END, 40))).toHaveLength(40);
  });

  it('honors an explicit maxDays cap', () => {
    const rule = { id: 'r10', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: 0 };
    // 91 days is the 3M window the quarterly review opens on.
    expect(Object.keys(habitDailySeries(rule, buildHabitLogIndex([]), noPause, END, 91))).toHaveLength(91);
  });
});

describe('habitDailySeries — totality on malformed input', () => {
  const index = buildHabitLogIndex([log('Read', END)]);
  const rule = { id: 'r11', title: 'Read', daysOfWeek: DAILY, timesPerDay: 1, createdAt: at('2026-08-01') };

  it('never throws and returns {} for anything unusable', () => {
    expect(habitDailySeries(null, index, noPause, END)).toEqual({});
    expect(habitDailySeries(undefined, index, noPause, END)).toEqual({});
    expect(habitDailySeries(rule, index, noPause, 'not-a-day')).toEqual({});
    expect(habitDailySeries(rule, index, noPause, '')).toEqual({});
    expect(habitDailySeries(rule, null, noPause, END)[END]).toBe(0);
    expect(habitDailySeries(rule, index, null, END)[END]).toBe(Math.round((1 / 7) * 100));
    expect(habitDailySeries({ title: 'Read', daysOfWeek: 'nope' } as any, index, noPause, END)).toEqual({});
    expect(habitDailySeries(rule, index, noPause, END, 0 as any)).not.toEqual({}); // falls back to the cap
  });

  it('produces only 0-100 integers, whatever went in', () => {
    const messy = { id: 'r12', title: 'Read', daysOfWeek: [0, 1, 2, 3, 4, 5, 6, 9], timesPerDay: -3, createdAt: at('2026-08-10') };
    const values = Object.values(habitDailySeries(messy, index, noPause, END));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('defaultRangeForCadence', () => {
  it('matches the range to the period being reviewed', () => {
    expect(defaultRangeForCadence('weekly')).toBe('1W');
    expect(defaultRangeForCadence('monthly')).toBe('1M');
    expect(defaultRangeForCadence('quarterly')).toBe('3M');
    expect(defaultRangeForCadence('semiannual')).toBe('6M');
    expect(defaultRangeForCadence('annual')).toBe('1Y');
  });

  it('falls back to the chart default for anything else', () => {
    expect(defaultRangeForCadence('weird')).toBe('1M');
    expect(defaultRangeForCadence(null)).toBe('1M');
    expect(defaultRangeForCadence(undefined)).toBe('1M');
  });
});
