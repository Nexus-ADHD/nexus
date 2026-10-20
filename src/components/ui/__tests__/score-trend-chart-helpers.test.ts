import { describe, expect, it } from 'vitest';
import tokens from '@/src/theme/tokens';
import { EMPTY_PAUSE_MODE, type PauseModeState } from '@/src/state/pause-mode';
import {
  DEFAULT_RANGE_KEYS,
  MAX_POINTS,
  RANGES,
  RANGE_A11Y_LABEL,
  RANGE_KEYS,
  buildLineSegments,
  formatDayKeyLabel,
  formatPointLabel,
  pointA11yLabel,
  scoreTargetDaysAbove,
  scoredValues,
  scrubIndex,
  trendColor,
  trendDelta,
  trendDirection,
  windowScores,
  yDomain,
  type ScorePoint,
} from '../score-trend-chart-helpers';

const TODAY = '2026-08-25';
const noPause: PauseModeState = { ...EMPTY_PAUSE_MODE };

const pt = (dateKey: string, score: number | null, paused = false): ScorePoint => ({ dateKey, score, paused });

describe('RANGES', () => {
  it('exposes every window in pill order, with ALL unbounded', () => {
    expect(RANGE_KEYS).toEqual(['1W', '1M', '3M', '6M', '1Y', 'ALL']);
    expect(RANGES['1W']).toBe(7);
    expect(RANGES['1M']).toBe(30);
    expect(RANGES['3M']).toBe(91);
    expect(RANGES['6M']).toBe(182);
    expect(RANGES['1Y']).toBe(365);
    expect(RANGES.ALL).toBeNull();
  });

  it('keeps the SHIPPED surfaces on their original five pills — 3M is opt-in', () => {
    // Home's card and /this-week render DEFAULT_RANGE_KEYS. A sixth pill there
    // would re-space a laid-out, reviewed row; only the Horizon review (which
    // needs a quarterly window) passes the full set.
    expect(DEFAULT_RANGE_KEYS).toEqual(['1W', '1M', '6M', '1Y', 'ALL']);
    expect(DEFAULT_RANGE_KEYS).not.toContain('3M');
  });

  it('gives every window a spoken label', () => {
    for (const key of RANGE_KEYS) expect(RANGE_A11Y_LABEL[key]).toBeTruthy();
    expect(RANGE_A11Y_LABEL['3M']).toBe('Three months');
  });
});

describe('windowScores', () => {
  it('returns chronological days, oldest first, inclusive of today', () => {
    const history = { '2026-08-19': 65, '2026-08-24': 80, '2026-08-25': 90 };
    const points = windowScores(history, noPause, TODAY, '1W');
    expect(points).toHaveLength(7);
    expect(points[0].dateKey).toBe('2026-08-19');
    expect(points[points.length - 1].dateKey).toBe(TODAY);
    // Sorted ascending — the source day-key helper returns today-FIRST.
    expect([...points].map((p) => p.dateKey).sort()).toEqual(points.map((p) => p.dateKey));
  });

  it('emits null for unrecorded days inside the window (a gap, not a zero)', () => {
    const points = windowScores({ '2026-08-19': 65, '2026-08-25': 90 }, noPause, TODAY, '1W');
    expect(points).toHaveLength(7);
    expect(points.filter((p) => p.score === null)).toHaveLength(5);
    expect(points[6]).toMatchObject({ dateKey: TODAY, score: 90, paused: false });
  });

  it('never starts before the first recorded day, on short ranges too', () => {
    // Otherwise a two-day-old account draws five empty slots then a stub at the
    // right edge — the same failure the long ranges have, just smaller.
    const points = windowScores({ '2026-08-24': 80, '2026-08-25': 90 }, noPause, TODAY, '1W');
    expect(points).toHaveLength(2);
    expect(points[0].dateKey).toBe('2026-08-24');
  });

  it('marks paused days as paused with no score, even if one was recorded', () => {
    const pm: PauseModeState = {
      active: false,
      since: null,
      plannedUntil: null,
      history: [{ since: '2026-08-21', endedOn: '2026-08-22' }],
    };
    const history = { '2026-08-21': 44, '2026-08-22': 51, '2026-08-25': 90 };
    const points = windowScores(history, pm, TODAY, '1W');
    const byKey = Object.fromEntries(points.map((p) => [p.dateKey, p]));
    expect(byKey['2026-08-21']).toMatchObject({ score: null, paused: true });
    expect(byKey['2026-08-22']).toMatchObject({ score: null, paused: true });
    expect(byKey['2026-08-25']).toMatchObject({ score: 90, paused: false });
  });

  it('starts a sparse long range at the first recorded day, not the range start', () => {
    const history = { '2026-08-20': 60, '2026-08-25': 90 };
    const points = windowScores(history, noPause, TODAY, '1Y');
    expect(points[0].dateKey).toBe('2026-08-20');
    expect(points).toHaveLength(6);
  });

  it('honors the range start when history reaches further back', () => {
    const history = { '2024-01-01': 50, '2026-08-25': 90 };
    const points = windowScores(history, noPause, TODAY, '1M');
    expect(points[0].dateKey).toBe('2026-07-27'); // 30 days inclusive
    expect(points).toHaveLength(30);
  });

  it('ALL spans from the first recorded day to today', () => {
    const history = { '2026-08-01': 50, '2026-08-25': 90 };
    const points = windowScores(history, noPause, TODAY, 'ALL');
    expect(points[0].dateKey).toBe('2026-08-01');
    expect(points).toHaveLength(25);
  });

  it('ALL with no history yields today alone', () => {
    expect(windowScores({}, noPause, TODAY, 'ALL')).toEqual([
      { dateKey: TODAY, score: null, paused: false },
    ]);
  });

  it('caps ALL at MAX_POINTS for a very old account', () => {
    const points = windowScores({ '2000-01-01': 50, [TODAY]: 90 }, noPause, TODAY, 'ALL');
    expect(points).toHaveLength(MAX_POINTS);
    expect(points[points.length - 1].dateKey).toBe(TODAY);
  });

  it('clamps out-of-range and non-finite scores instead of plotting them', () => {
    const history = { '2026-08-23': 140, '2026-08-24': -20, '2026-08-25': NaN } as any;
    const points = windowScores(history, noPause, TODAY, '1W');
    const byKey = Object.fromEntries(points.map((p) => [p.dateKey, p.score]));
    expect(byKey['2026-08-23']).toBe(100);
    expect(byKey['2026-08-24']).toBe(0);
    expect(byKey['2026-08-25']).toBeNull();
  });

  it('ignores malformed keys and bad inputs', () => {
    expect(windowScores({ garbage: 90 } as any, noPause, TODAY, 'ALL')).toHaveLength(1);
    expect(windowScores(null, noPause, TODAY, '1W')).toHaveLength(7);
    expect(windowScores({}, noPause, 'not-a-day', '1W')).toEqual([]);
  });

  it('spans 91 days for 3M', () => {
    const history = { '2024-01-01': 50, [TODAY]: 90 };
    const points = windowScores(history, noPause, TODAY, '3M');
    expect(points).toHaveLength(91);
    expect(points[0].dateKey).toBe('2026-05-27'); // 91 days inclusive
  });
});

describe('windowScores — endKey anchoring (the Horizon review reads a past period)', () => {
  const history = { '2026-06-10': 40, '2026-06-14': 70, '2026-06-15': 80, [TODAY]: 95 };

  it('defaults endKey to todayKey, so every shipped caller is unchanged', () => {
    expect(windowScores(history, noPause, TODAY, '1W'))
      .toEqual(windowScores(history, noPause, TODAY, '1W', TODAY));
    expect(windowScores(history, noPause, TODAY, 'ALL', undefined))
      .toEqual(windowScores(history, noPause, TODAY, 'ALL'));
  });

  it('ends the window at endKey and excludes everything after it', () => {
    const points = windowScores(history, noPause, TODAY, '1W', '2026-06-15');
    // The 1W window would open 2026-06-09, but the "never start before the first
    // recorded day" rule still applies — it just applies against endKey now.
    expect(points).toHaveLength(6);
    expect(points[0].dateKey).toBe('2026-06-10');
    expect(points[points.length - 1]).toMatchObject({ dateKey: '2026-06-15', score: 80 });
    expect(points.some((p) => p.dateKey === TODAY)).toBe(false);
  });

  it('ends ALL at endKey too, not at today', () => {
    const points = windowScores(history, noPause, TODAY, 'ALL', '2026-06-14');
    expect(points[0].dateKey).toBe('2026-06-10');
    expect(points[points.length - 1].dateKey).toBe('2026-06-14');
  });

  it('yields an empty window when endKey precedes the first recorded day', () => {
    const points = windowScores(history, noPause, TODAY, 'ALL', '2026-01-01');
    expect(points).toEqual([{ dateKey: '2026-01-01', score: null, paused: false }]);
  });

  it('falls back to todayKey for a malformed endKey rather than returning nothing', () => {
    expect(windowScores(history, noPause, TODAY, '1W', 'not-a-day'))
      .toEqual(windowScores(history, noPause, TODAY, '1W'));
  });
});

describe('yDomain', () => {
  it('falls back to the full axis with no scored days', () => {
    expect(yDomain([])).toEqual({ min: 0, max: 100 });
    expect(yDomain([pt('2026-08-25', null)])).toEqual({ min: 0, max: 100 });
  });

  it('keeps a minimum span of 10 so a small wobble is not a cliff', () => {
    const d = yDomain([pt('2026-08-24', 70), pt('2026-08-25', 73)]);
    expect(d.max - d.min).toBeGreaterThanOrEqual(10);
    expect(d.min).toBeLessThanOrEqual(70);
    expect(d.max).toBeGreaterThanOrEqual(73);
  });

  it('pads a real spread and stays inside 0-100', () => {
    const d = yDomain([pt('2026-08-24', 40), pt('2026-08-25', 90)]);
    expect(d.min).toBeGreaterThanOrEqual(0);
    expect(d.max).toBeLessThanOrEqual(100);
    expect(d.min).toBeLessThan(40);
    expect(d.max).toBeGreaterThan(90);
  });

  it('does not run off the top or bottom for extreme values', () => {
    expect(yDomain([pt('2026-08-25', 100)])).toEqual({ min: 90, max: 100 });
    expect(yDomain([pt('2026-08-25', 0)])).toEqual({ min: 0, max: 10 });
  });
});

describe('buildLineSegments', () => {
  const opts = { width: 100, height: 50, domain: { min: 0, max: 100 } };

  it('draws one path for an unbroken run', () => {
    const points = [pt('2026-08-23', 0), pt('2026-08-24', 50), pt('2026-08-25', 100)];
    const layout = buildLineSegments(points, opts);
    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0]).toBe('M 0 50 L 50 25 L 100 0');
    expect(layout.dots).toHaveLength(0);
    expect(layout.areas[0]).toContain('Z');
    expect(layout.coords).toEqual([
      { x: 0, y: 50 },
      { x: 50, y: 25 },
      { x: 100, y: 0 },
    ]);
  });

  it('breaks the line at gaps and paused days', () => {
    const points = [
      pt('2026-08-21', 80),
      pt('2026-08-22', 60),
      pt('2026-08-23', null, true),
      pt('2026-08-24', 70),
      pt('2026-08-25', 90),
    ];
    const layout = buildLineSegments(points, opts);
    expect(layout.segments).toHaveLength(2);
    expect(layout.areas).toHaveLength(2);
    expect(layout.coords[2]).toBeNull();
  });

  it('renders an isolated scored day as a dot, never as nothing', () => {
    const points = [pt('2026-08-23', null), pt('2026-08-24', 75), pt('2026-08-25', null)];
    const layout = buildLineSegments(points, opts);
    expect(layout.segments).toHaveLength(0);
    expect(layout.dots).toEqual([{ x: 50, y: 12.5 }]);
  });

  it('centers a single-point window', () => {
    const layout = buildLineSegments([pt('2026-08-25', 50)], opts);
    expect(layout.dots).toEqual([{ x: 50, y: 25 }]);
  });

  it('returns an empty layout for degenerate sizes', () => {
    expect(buildLineSegments([pt('2026-08-25', 50)], { ...opts, width: 0 }).coords).toEqual([]);
    expect(buildLineSegments([], opts).segments).toEqual([]);
  });

  it('respects vertical padding so the line does not touch the edges', () => {
    const layout = buildLineSegments(
      [pt('2026-08-24', 0), pt('2026-08-25', 100)],
      { ...opts, topPad: 5, bottomPad: 5 },
    );
    expect(layout.coords[0]).toEqual({ x: 0, y: 45 });
    expect(layout.coords[1]).toEqual({ x: 100, y: 5 });
  });
});

describe('trendDelta', () => {
  it('measures first vs last scored day', () => {
    const points = [pt('a', 40), pt('b', null), pt('c', 60)];
    expect(trendDelta(points)).toEqual({ first: 40, last: 60, delta: 20, pct: 50 });
  });

  it('omits pct when the baseline is zero (never Infinity%)', () => {
    expect(trendDelta([pt('a', 0), pt('b', 40)])).toEqual({ first: 0, last: 40, delta: 40, pct: null });
  });

  it('has no delta with fewer than two scored days', () => {
    expect(trendDelta([pt('a', 55), pt('b', null)])).toEqual({ first: 55, last: 55, delta: null, pct: null });
    expect(trendDelta([])).toEqual({ first: null, last: null, delta: null, pct: null });
  });
});

describe('trendDirection / trendColor (Law C — never red)', () => {
  it('classifies direction, treating zero and missing as flat', () => {
    expect(trendDirection(5)).toBe('up');
    expect(trendDirection(-5)).toBe('down');
    expect(trendDirection(0)).toBe('flat');
    expect(trendDirection(null)).toBe('flat');
  });

  it('colors down as textMuted, never the error red', () => {
    expect(trendColor(12)).toBe(tokens.color.teal);
    expect(trendColor(0)).toBe(tokens.color.gold);
    expect(trendColor(-12)).toBe(tokens.color.textMuted);
    expect(trendColor(-12)).not.toBe(tokens.color.stateError);
  });
});

describe('scrubIndex', () => {
  it('snaps to the nearest slot and clamps at both ends', () => {
    expect(scrubIndex(0, 100, 5)).toBe(0);
    expect(scrubIndex(100, 100, 5)).toBe(4);
    expect(scrubIndex(51, 100, 5)).toBe(2);
    expect(scrubIndex(-40, 100, 5)).toBe(0);
    expect(scrubIndex(400, 100, 5)).toBe(4);
  });

  it('is safe for degenerate counts and widths', () => {
    expect(scrubIndex(10, 100, 1)).toBe(0);
    expect(scrubIndex(10, 100, 0)).toBe(0);
    expect(scrubIndex(10, 0, 5)).toBe(4);
  });
});

describe('formatPointLabel / pointA11yLabel', () => {
  it('distinguishes a score, a planned break, and a day with no data', () => {
    expect(formatPointLabel(pt('2026-08-25', 87))).toEqual({ kind: 'score', value: '87' });
    expect(formatPointLabel(pt('2026-08-25', null, true))).toEqual({ kind: 'paused', value: 'Paused' });
    expect(formatPointLabel(pt('2026-08-25', null))).toEqual({ kind: 'empty', value: 'No score' });
    expect(formatPointLabel(null)).toEqual({ kind: 'empty', value: 'No score' });
  });

  it('speaks the day plus its state', () => {
    expect(pointA11yLabel(pt('2026-08-25', 87), TODAY)).toBe('Aug 25, score 87');
    expect(pointA11yLabel(pt('2026-08-25', null, true), TODAY)).toBe('Aug 25, paused');
    expect(pointA11yLabel(pt('2026-08-25', null), TODAY)).toBe('Aug 25, no score');
  });

  it('names what the number is when it is not a score, and defaults to "score"', () => {
    // A habit chart plots that habit's completion rate, not the alignment score.
    expect(formatPointLabel(pt('2026-08-25', null), 'Read')).toEqual({ kind: 'empty', value: 'No Read' });
    expect(formatPointLabel(null, 'Read')).toEqual({ kind: 'empty', value: 'No Read' });
    // A paused day is a planned break whatever is being plotted.
    expect(formatPointLabel(pt('2026-08-25', null, true), 'Read')).toEqual({ kind: 'paused', value: 'Paused' });
    expect(pointA11yLabel(pt('2026-08-25', 87), TODAY, 'Read')).toBe('Aug 25, Read 87');
    expect(pointA11yLabel(pt('2026-08-25', null), TODAY, 'Read')).toBe('Aug 25, no Read');
    // Omitting the noun keeps every shipped string byte-identical.
    expect(formatPointLabel(pt('2026-08-25', null))).toEqual(formatPointLabel(pt('2026-08-25', null), 'score'));
    expect(pointA11yLabel(pt('2026-08-25', 87), TODAY)).toBe(pointA11yLabel(pt('2026-08-25', 87), TODAY, 'score'));
  });
});

describe('formatDayKeyLabel', () => {
  it('adds the year only when it differs from today', () => {
    expect(formatDayKeyLabel('2026-08-25', TODAY)).toBe('Aug 25');
    expect(formatDayKeyLabel('2025-12-01', TODAY)).toBe('Dec 1, 2025');
    expect(formatDayKeyLabel('nope', TODAY)).toBe('');
  });
});

describe('scoredValues', () => {
  it('keeps order and drops the gaps', () => {
    expect(scoredValues([pt('a', 1), pt('b', null), pt('c', 3)])).toEqual([1, 3]);
    expect(scoredValues(null as any)).toEqual([]);
  });
});

describe('scoreTargetDaysAbove (preserves the pre-unbounded 30-day behavior)', () => {
  /** `n` consecutive recorded days starting 2026-01-01, all at `score`. */
  const buildHistory = (n: number, score: number): Record<string, number> => {
    const out: Record<string, number> = {};
    for (let i = 0; i < n; i += 1) {
      const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
      const day = String((i % 28) + 1).padStart(2, '0');
      out[`2026-${month}-${day}`] = score;
    }
    return out;
  };

  it('counts days at or above the threshold', () => {
    const history = { '2026-08-01': 90, '2026-08-02': 80, '2026-08-03': 79 };
    expect(scoreTargetDaysAbove(history, 80)).toBe(2);
    expect(scoreTargetDaysAbove(history, 90)).toBe(1);
  });

  it('counts only the most recent 30 recorded day-keys', () => {
    // 40 qualifying days, but only the newest 30 may count — history is
    // unbounded now, so an old run must not complete today's challenge.
    const history = buildHistory(40, 95);
    expect(Object.keys(history)).toHaveLength(40);
    expect(scoreTargetDaysAbove(history, 80)).toBe(30);
  });

  it('drops the oldest days from the window', () => {
    const history: Record<string, number> = {};
    // 30 old high days, then 5 recent low days → only 25 of the highs remain.
    for (let i = 1; i <= 30; i += 1) history[`2026-06-${String(i).padStart(2, '0')}`] = 95;
    for (let i = 1; i <= 5; i += 1) history[`2026-07-${String(i).padStart(2, '0')}`] = 10;
    expect(scoreTargetDaysAbove(history, 80)).toBe(25);
  });

  it('accepts a custom window and handles empty / malformed history', () => {
    const history = { '2026-08-01': 95, '2026-08-02': 95, '2026-08-03': 95 };
    expect(scoreTargetDaysAbove(history, 80, 2)).toBe(2);
    expect(scoreTargetDaysAbove({}, 80)).toBe(0);
    expect(scoreTargetDaysAbove(null, 80)).toBe(0);
    expect(scoreTargetDaysAbove({ '2026-08-01': 'nope' } as any, 80)).toBe(0);
  });
});
