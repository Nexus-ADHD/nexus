// Pure helpers for the Score Trend chart (`ScoreTrendChart.tsx`) — the
// Robinhood-style interactive line chart of the daily alignment score that
// replaces Home's 7-bar mini chart and anchors the /this-week screen.
//
// Pure (no RN imports) so every bit of the windowing / scaling / path math is
// unit-testable in the Node vitest suite, exactly like its sibling
// `weekly-debrief-chart-helpers.ts`. The component owns pixels and gestures;
// this file owns the numbers.
//
// Two standing rules are enforced HERE so they can't drift at a render site:
//   - Law C: a DOWN trend is never red. `trendColor` returns textMuted for
//     down, teal for up, gold for flat. There is no red branch.
//   - A paused day is not a low day: `windowScores` yields `score: null` +
//     `paused: true`, which breaks the line into segments rather than drawing
//     a dip to zero.
import tokens from '@/src/theme/tokens';
import { addDaysToKey } from '@/src/state/lead-time-types';
import { isPausedOn, type PauseModeState } from '@/src/state/pause-mode';

// ── Ranges ────────────────────────────────────────────────────────────────────

/** Selectable windows, in calendar days back from the window end. `null` = all history. */
export const RANGES = {
  '1W': 7,
  '1M': 30,
  '3M': 91,
  '6M': 182,
  '1Y': 365,
  ALL: null,
} as const;

export type ScoreRangeKey = keyof typeof RANGES;

/** Every window this module knows, in pill order left to right. */
export const RANGE_KEYS: ScoreRangeKey[] = ['1W', '1M', '3M', '6M', '1Y', 'ALL'];

/**
 * The five pills the shipped surfaces draw (Home's card, /this-week). 3M was
 * added for the Horizon review's quarterly cadence and must NOT appear on those
 * two — a sixth pill would re-space a row that is already laid out and reviewed.
 * `ScoreTrendChart` defaults to this set; only a caller that explicitly passes
 * `ranges` gets anything else.
 */
export const DEFAULT_RANGE_KEYS: ScoreRangeKey[] = ['1W', '1M', '6M', '1Y', 'ALL'];

/** Spoken form for VoiceOver — the pill glyphs read badly letter by letter. */
export const RANGE_A11Y_LABEL: Record<ScoreRangeKey, string> = {
  '1W': 'One week',
  '1M': 'One month',
  '3M': 'Three months',
  '6M': 'Six months',
  '1Y': 'One year',
  ALL: 'All time',
};

/**
 * Hard ceiling on rendered points (~4 years of daily keys). History is
 * unbounded by design (the 30-key prune was removed in `recordDailyScore`), so
 * ALL needs a floor under its worst case: one Path per run and one x per day is
 * cheap, but it is not free, and a decade of keys should degrade to "the last
 * four years" rather than to a stutter.
 */
export const MAX_POINTS = 1461;

/** Minimum vertical span of the y-axis, in score points. */
export const MIN_Y_SPAN = 10;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Types ─────────────────────────────────────────────────────────────────────

/** One calendar day in the window. `score` is null when paused or unrecorded. */
export interface ScorePoint {
  dateKey: string;
  score: number | null;
  paused: boolean;
}

export interface YDomain {
  min: number;
  max: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface ChartLayout {
  /** One entry per input point, null where there is no score (gap in the line). */
  coords: (Point2D | null)[];
  /** SVG path `d` strings, one per unbroken run of 2+ scored days. */
  segments: string[];
  /** Closed area paths under each segment, for the gradient fill. */
  areas: string[];
  /** Isolated scored days (a run of exactly 1) — drawn as dots, not lines. */
  dots: Point2D[];
}

export interface TrendDelta {
  first: number | null;
  last: number | null;
  /** last − first. Null when the window holds fewer than 2 scored days. */
  delta: number | null;
  /** Percent change. Null when there's no delta or the baseline is 0. */
  pct: number | null;
}

export type TrendDirection = 'up' | 'flat' | 'down';

// ── Internals ─────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A finite score clamped into 0–100, or null for anything else. */
function normalizeScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function sortedDayKeys(history: Record<string, unknown> | null | undefined): string[] {
  if (!history || typeof history !== 'object' || Array.isArray(history)) return [];
  return Object.keys(history)
    .filter((k) => DAY_KEY_RE.test(k))
    .sort();
}

// ── Windowing ─────────────────────────────────────────────────────────────────

/**
 * The chronologically ordered days to plot for `range`, oldest first.
 *
 * Two shaping decisions, both deliberate:
 *  - The window STARTS at the later of the range start and the first day ever
 *    recorded, so a sparse 1Y on a two-week-old account draws across the card
 *    instead of pinning a stub to the right edge of an empty year.
 *  - Every calendar day between start and the window end is emitted, scored or
 *    not, so the x-axis is real time. A missing or paused day is `score: null`
 *    and breaks the line (see `buildLineSegments`) rather than being skipped,
 *    which would silently compress a gap into a straight line.
 *
 * `endKey` is the RIGHT EDGE of the window and defaults to `todayKey`, so every
 * existing caller is unchanged. The Horizon review passes `min(today, period
 * end)` instead: that modal reviews the last COMPLETED period and supports
 * back-fills, so a line running to today under a "March 2026" header would be
 * describing a different span than the cards beside it. Anchoring the window to
 * the period makes the range pills mean "1W/1M/… ending at the period under
 * review".
 */
export function windowScores(
  scoreHistory: Record<string, number> | null | undefined,
  pauseMode: PauseModeState | null | undefined,
  todayKey: string,
  range: ScoreRangeKey,
  endKey?: string,
): ScorePoint[] {
  const rightEdge = endKey != null && DAY_KEY_RE.test(endKey) ? endKey : todayKey;
  if (!DAY_KEY_RE.test(rightEdge)) return [];
  const history = (scoreHistory && typeof scoreHistory === 'object' && !Array.isArray(scoreHistory))
    ? (scoreHistory as Record<string, unknown>)
    : {};
  const keys = sortedDayKeys(history);
  const firstRecorded = keys.length > 0 ? keys[0] : null;

  const days = RANGES[range];
  let startKey: string;
  if (days == null) {
    startKey = firstRecorded ?? rightEdge;
  } else {
    const rangeStart = addDaysToKey(rightEdge, -(days - 1));
    startKey = firstRecorded && firstRecorded > rangeStart ? firstRecorded : rangeStart;
  }
  if (startKey > rightEdge) startKey = rightEdge;
  // Cap the span before walking it (see MAX_POINTS).
  const capStart = addDaysToKey(rightEdge, -(MAX_POINTS - 1));
  if (startKey < capStart) startKey = capStart;

  const out: ScorePoint[] = [];
  let cursor = startKey;
  while (cursor <= rightEdge && out.length < MAX_POINTS) {
    const paused = isPausedOn(cursor, pauseMode);
    out.push({
      dateKey: cursor,
      // A paused day has no score even if one was recorded before the pause
      // started (Law C — a planned break is not a low day).
      score: paused ? null : normalizeScore(history[cursor]),
      paused,
    });
    const next = addDaysToKey(cursor, 1);
    if (next <= cursor) break; // defensive: never loop on a malformed key
    cursor = next;
  }
  return out;
}

/** The scored (non-null) values of a window, in order. */
export function scoredValues(points: ScorePoint[]): number[] {
  if (!Array.isArray(points)) return [];
  return points.map((p) => p?.score).filter((s): s is number => typeof s === 'number');
}

// ── Scaling ───────────────────────────────────────────────────────────────────

/**
 * Auto-scaled y-range with headroom, clamped to 0–100 and never narrower than
 * MIN_Y_SPAN. Auto-scale is what makes a real trend legible; the minimum span
 * is what stops a three-point wobble from being drawn as a cliff.
 * Empty input falls back to the full 0–100 axis.
 */
export function yDomain(points: ScorePoint[]): YDomain {
  const values = scoredValues(points);
  if (values.length === 0) return { min: 0, max: 100 };

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const target = Math.max(span * 1.25, MIN_Y_SPAN);
  const center = (lo + hi) / 2;

  let min = center - target / 2;
  let max = center + target / 2;
  if (min < 0) { max += -min; min = 0; }
  if (max > 100) { min -= max - 100; max = 100; }
  if (min < 0) min = 0;

  return { min: Math.floor(min), max: Math.ceil(max) };
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Project the window into SVG space: per-point coords, one path per unbroken
 * run of scored days, a closed area path under each, and dots for runs of one.
 *
 * An isolated scored day surrounded by gaps has nothing to connect to — without
 * the dot it would render as literally nothing, which reads as "no data" for a
 * day that has data.
 */
export function buildLineSegments(
  points: ScorePoint[],
  opts: {
    width: number;
    height: number;
    domain: YDomain;
    topPad?: number;
    bottomPad?: number;
  },
): ChartLayout {
  const empty: ChartLayout = { coords: [], segments: [], areas: [], dots: [] };
  if (!Array.isArray(points) || points.length === 0) return empty;

  const { width, height, domain } = opts;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return empty;

  const topPad = opts.topPad ?? 0;
  const bottomPad = opts.bottomPad ?? 0;
  const plotHeight = Math.max(1, height - topPad - bottomPad);
  const span = Math.max(1e-6, domain.max - domain.min);
  const count = points.length;

  const xAt = (i: number): number => (count > 1 ? (i / (count - 1)) * width : width / 2);
  const yAt = (v: number): number => {
    const t = (v - domain.min) / span;
    return topPad + (1 - Math.max(0, Math.min(1, t))) * plotHeight;
  };

  const coords: (Point2D | null)[] = points.map((p, i) =>
    typeof p?.score === 'number'
      ? { x: round2(xAt(i)), y: round2(yAt(p.score)) }
      : null,
  );

  const segments: string[] = [];
  const areas: string[] = [];
  const dots: Point2D[] = [];
  const baseY = round2(height);

  let run: Point2D[] = [];
  const flush = () => {
    if (run.length === 1) {
      dots.push(run[0]);
    } else if (run.length > 1) {
      segments.push(`M ${run[0].x} ${run[0].y}` + run.slice(1).map((c) => ` L ${c.x} ${c.y}`).join(''));
      const last = run[run.length - 1];
      areas.push(
        `M ${run[0].x} ${baseY} L ${run[0].x} ${run[0].y}` +
        run.slice(1).map((c) => ` L ${c.x} ${c.y}`).join('') +
        ` L ${last.x} ${baseY} Z`,
      );
    }
    run = [];
  };
  coords.forEach((c) => { if (c) run.push(c); else flush(); });
  flush();

  return { coords, segments, areas, dots };
}

// ── Trend ─────────────────────────────────────────────────────────────────────

/**
 * First vs last scored day of the window. `pct` is omitted when the baseline is
 * 0 — a rise from a zero day is not "+Infinity%", it's just a rise in points.
 */
export function trendDelta(points: ScorePoint[]): TrendDelta {
  const values = scoredValues(points);
  if (values.length === 0) return { first: null, last: null, delta: null, pct: null };
  const first = values[0];
  const last = values[values.length - 1];
  if (values.length === 1) return { first, last, delta: null, pct: null };
  const delta = last - first;
  const pct = first === 0 ? null : Math.round((delta / first) * 100);
  return { first, last, delta, pct };
}

/** Sign of the delta. No delta (or exactly 0) reads flat, never down. */
export function trendDirection(delta: number | null | undefined): TrendDirection {
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

/**
 * Line / delta color by direction. Down is `textMuted` — quiet, not alarmed.
 * There is deliberately no red branch here (Law C, and §19 bans state-red for
 * a low value); a reviewer changing this is changing a product law.
 */
export function trendColor(delta: number | null | undefined): string {
  const dir = trendDirection(delta);
  if (dir === 'up') return tokens.color.teal;
  if (dir === 'down') return tokens.color.textMuted;
  return tokens.color.gold;
}

// ── Scrubbing ─────────────────────────────────────────────────────────────────

/** Nearest point index for a finger at `x` across `width`. Clamped in-range. */
export function scrubIndex(x: number, width: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return count - 1;
  if (count === 1) return 0;
  const t = Math.max(0, Math.min(1, x / width));
  return Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
}

export type PointLabelKind = 'score' | 'paused' | 'empty';

export interface PointLabel {
  kind: PointLabelKind;
  /** What the big header numeral shows: the score, or a word. */
  value: string;
}

/**
 * The readout for a scrubbed day. A paused day and an unrecorded day must NOT
 * both read as a blank or a zero — one is a planned break, the other is a day
 * the app never scored, and conflating them is how a break starts reading as
 * lost data.
 *
 * `noun` names what the number IS, and defaults to 'score' so the alignment-score
 * chart is unchanged. A chart plotting something else (a habit's completion rate)
 * passes its own noun rather than claiming the day had no *score*, which would be
 * true and irrelevant.
 */
export function formatPointLabel(
  point: ScorePoint | null | undefined,
  noun = 'score',
): PointLabel {
  const none = `No ${noun}`;
  if (!point) return { kind: 'empty', value: none };
  if (typeof point.score === 'number') return { kind: 'score', value: String(Math.round(point.score)) };
  if (point.paused) return { kind: 'paused', value: 'Paused' };
  return { kind: 'empty', value: none };
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Aug 25", or "Aug 25, 2025" when the day falls outside today's year. Parsed
 * from the key's parts — never `new Date(iso)`, which shifts a local day-key
 * backwards in western timezones.
 */
export function formatDayKeyLabel(dateKey: string, todayKey?: string): string {
  if (!DAY_KEY_RE.test(dateKey)) return '';
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const name = MONTHS_SHORT[month - 1] ?? '';
  const base = `${name} ${day}`;
  if (todayKey && DAY_KEY_RE.test(todayKey) && todayKey.slice(0, 4) !== dateKey.slice(0, 4)) {
    return `${base}, ${year}`;
  }
  return base;
}

/** One VoiceOver sentence for a scrubbed day. `noun` defaults to 'score'. */
export function pointA11yLabel(
  point: ScorePoint | null | undefined,
  todayKey?: string,
  noun = 'score',
): string {
  if (!point) return 'No data';
  const date = formatDayKeyLabel(point.dateKey, todayKey);
  const label = formatPointLabel(point, noun);
  if (label.kind === 'score') return `${date}, ${noun} ${label.value}`;
  if (label.kind === 'paused') return `${date}, paused`;
  return `${date}, no ${noun}`;
}

// ── Challenge scoping ─────────────────────────────────────────────────────────

/**
 * Days at or above `threshold` among the most recent `windowDays` recorded
 * day-keys — the `score_target` challenge counter.
 *
 * This window used to be implicit: `recordDailyScore` hard-pruned scoreHistory
 * to the newest 30 keys, so "count every value in history" WAS "count the last
 * 30 days". History is unbounded now, so the window has to be explicit or a
 * long-lived account would complete "score 80+ for N days" off years of old
 * days. Behavior is otherwise identical to the pre-unbounded counter.
 */
export function scoreTargetDaysAbove(
  history: Record<string, number> | null | undefined,
  threshold: number,
  windowDays = 30,
): number {
  const keys = sortedDayKeys(history as Record<string, unknown>);
  if (keys.length === 0) return 0;
  const window = windowDays > 0 ? keys.slice(Math.max(0, keys.length - windowDays)) : keys;
  let count = 0;
  for (const k of window) {
    const v = (history as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= threshold) count += 1;
  }
  return count;
}
