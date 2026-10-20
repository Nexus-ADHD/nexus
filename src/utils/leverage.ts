// Leverage analysis — shared between the weekly review modal and (in a
// follow-up) the home tab's "THIS WEEK'S LEVERAGE" card. Pure functions: all
// inputs explicit, no Zustand reads, no Date.now() side-effects beyond the
// supplied `range`.

import { computeHabitProgress, computeHabitStrength, computeAnchorAdherence } from '@/src/state/selectors/habit-rollup';
import { normalize } from '@/src/utils/text';

export interface LeveragePoint {
  ruleId: string;
  title: string;
  rate: number;                 // 0–100 schedule-aware completion rate over `range`
  completed: number;            // log entries in `range`, capped at timesPerDay per scheduled day
  target: number;               // scheduled completions in `range` (scheduledDays × timesPerDay)
  gap: number;                  // missed completions vs scheduled target
  gapScore: number;             // gap × pillar-linkage weight (1.0 / 1.5 / 2.0…)
  pillarLinkCount: number;
  currentDaysOfWeek: number[];
  currentTimesPerDay: number;
  bestDay: string;              // day-of-week label with the most logs ('Mon', '—', etc.)
}

export interface LeverageSuggestion {
  ruleId: string;
  title: string;
  kind: 'leverage' | 'graduate';
  reason: string;
  before: { daysOfWeek: number[]; timesPerDay: number };
  after: { daysOfWeek: number[]; timesPerDay: number };
  noChange: boolean;            // true when there's no sane up/down move
}

export interface ComputeLeverageOptions {
  recurringRules: Array<{
    id: string;
    title: string;
    daysOfWeek?: number[];
    timesPerDay?: number;
    createdAt?: number;
  }>;
  habitLog: Array<{
    habitTitle?: string;
    dateKey?: string;
  }>;
  pillars: Array<{ id: string }>;
  goalHabitMap: Record<string, string[]>;
  range: { start: Date; end: Date };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function computeLeveragePoints(
  opts: ComputeLeverageOptions
): { leverage: LeveragePoint[]; graduates: LeveragePoint[] } {
  const { recurringRules, habitLog, pillars, goalHabitMap, range } = opts;

  const startKey = localDateKey(range.start);
  const endKey = localDateKey(range.end);
  const periodLogs = (habitLog || []).filter(
    (e) => typeof e.dateKey === 'string' && e.dateKey >= startKey && e.dateKey <= endKey
  );

  const activePillarIds = new Set((pillars || []).map((p) => p.id));

  const points: LeveragePoint[] = (recurringRules || [])
    .map((rule): LeveragePoint | null => {
      const key = normalize(rule.title);
      const ruleDays: number[] =
        Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length
          ? rule.daysOfWeek
          : [0, 1, 2, 3, 4, 5, 6];
      const timesPerDay = rule.timesPerDay || 1;

      // Schedule-aware progress via shared selector. rate, completed,
      // and target (= expected) all come from one source — previously
      // rate used calendar days while target used scheduled days, so a
      // 3x/week habit at 100% schedule-completion read as 43% rate.
      const progress = computeHabitProgress(rule, range, habitLog || []);
      // Brand-new habits don't participate in leverage analysis — too few
      // scheduled chances for an honest signal. `pct` can also be null on a
      // 'ready' habit when nothing was expected this window (a degenerate
      // once-weekly schedule); skip those too so `rate` is never NaN.
      if (progress.status === 'new' || progress.pct == null) return null;
      const completed = progress.completed;
      const target = progress.expected;
      const rate = progress.pct;
      const gap = Math.max(0, target - completed);

      const linkedIds = (goalHabitMap?.[key] ?? []) as string[];
      const activeLinks = linkedIds.filter((pid) => activePillarIds.has(pid)).length;
      const linkageWeight = 1 + activeLinks * 0.5;

      // Best day — uses raw period logs (any logs, not just scheduled),
      // so an off-schedule rhythm still surfaces the user's true pattern.
      const logs = periodLogs.filter((e) => normalize(e.habitTitle) === key);
      const byDay = [0, 0, 0, 0, 0, 0, 0];
      logs.forEach((e) => {
        if (typeof e.dateKey === 'string') {
          const dow = new Date(`${e.dateKey}T12:00:00`).getDay();
          byDay[dow] += 1;
        }
      });
      const bestDayIdx = byDay.indexOf(Math.max(...byDay));
      const bestDay = byDay[bestDayIdx] > 0 ? DAY_NAMES[bestDayIdx] : '—';

      return {
        ruleId: rule.id,
        title: rule.title,
        rate,
        completed,
        target,
        gap,
        gapScore: gap * linkageWeight,
        pillarLinkCount: activeLinks,
        currentDaysOfWeek: ruleDays,
        currentTimesPerDay: timesPerDay,
        bestDay,
      };
    })
    .filter((p): p is LeveragePoint => p !== null);

  const leverage = points
    .filter((p) => p.rate < 70 && p.gap > 0)
    .sort((a, b) => b.gapScore - a.gapScore)
    .slice(0, 2);

  const graduates = points
    .filter((p) => p.rate >= 90)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 2);

  return { leverage, graduates };
}

export function buildLeverageSuggestion(p: LeveragePoint): LeverageSuggestion {
  // Lower the bar: cut timesPerDay before trimming days. Identity habits hurt
  // more on a missed day than a halved count.
  if (p.currentTimesPerDay > 1) {
    const next = p.currentTimesPerDay - 1;
    return {
      ruleId: p.ruleId,
      title: p.title,
      kind: 'leverage',
      reason: `Drop to ${next}×/day to rebuild momentum.`,
      before: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
      after: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: next },
      noChange: false,
    };
  }
  if (p.currentDaysOfWeek.length > 4) {
    const after = [1, 2, 3, 4, 5];
    return {
      ruleId: p.ruleId,
      title: p.title,
      kind: 'leverage',
      reason: `Trim to weekdays only to make it easier to hold.`,
      before: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
      after: { daysOfWeek: after, timesPerDay: p.currentTimesPerDay },
      noChange: false,
    };
  }
  return {
    ruleId: p.ruleId,
    title: p.title,
    kind: 'leverage',
    reason: `Already at the floor. Hold the line.`,
    before: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
    after: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
    noChange: true,
  };
}

export function buildGraduateSuggestion(p: LeveragePoint): LeverageSuggestion {
  // Raise the bar: expand daysOfWeek before bumping timesPerDay. Broader week
  // coverage is a stronger identity signal than more reps/day.
  if (p.currentDaysOfWeek.length < 7) {
    const after = [0, 1, 2, 3, 4, 5, 6];
    return {
      ruleId: p.ruleId,
      title: p.title,
      kind: 'graduate',
      reason: `Consistent lately. Expand to every day.`,
      before: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
      after: { daysOfWeek: after, timesPerDay: p.currentTimesPerDay },
      noChange: false,
    };
  }
  if (p.currentTimesPerDay < 3) {
    const next = p.currentTimesPerDay + 1;
    return {
      ruleId: p.ruleId,
      title: p.title,
      kind: 'graduate',
      reason: `Ready to level up to ${next}×/day.`,
      before: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
      after: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: next },
      noChange: false,
    };
  }
  return {
    ruleId: p.ruleId,
    title: p.title,
    kind: 'graduate',
    reason: `Fully graduated. Stay the course.`,
    before: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
    after: { daysOfWeek: p.currentDaysOfWeek, timesPerDay: p.currentTimesPerDay },
    noChange: true,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Phase 0 — scoring redesign: ranked-blend leverage picker.
// New export. Coexists with buildLeverageSuggestion / buildGraduateSuggestion
// above so existing horizon-review consumers keep working unchanged.
// ───────────────────────────────────────────────────────────────────────

export type LeverageRank =
  | 'at-risk-strong'   // currently slipping, was historically strong
  | 'anchor-drift'     // top-3 habit whose anchor timing has drifted
  | 'mandate-weak'     // weakest habit linked to user's #1 mandate
  | 'default';         // fallback: lowest-strength habit with streak ≥3

export interface LeveragePick {
  habitId: string;
  habitTitle: string;
  reason: string;
  rank: LeverageRank;
}

interface LeveragePickState {
  recurringRules?: Array<{
    id: string;
    title: string;
    daysOfWeek?: number[];
    timesPerDay?: number;
    createdAt?: number;
    anchor?: string | null;
  }>;
  habitLog?: Array<{ habitTitle?: string; dateKey?: string; timestamp?: number }>;
  habitStreaks?: Record<string, number>;
  pillars?: Array<{ id: string; title: string }>;
  goalHabitMap?: Record<string, string[]>;
  /**
   * Optional override for "now" — pure-function escape hatch for tests.
   * Production callers omit; the picker uses new Date().
   */
  now?: Date;
}

const LEVERAGE_HISTORICAL_WINDOW_DAYS = 30;
const LEVERAGE_HISTORICAL_STRENGTH_THRESHOLD = 70;
const LEVERAGE_TOP_N = 3;
const LEVERAGE_DEFAULT_MIN_STREAK = 3;

/**
 * Picks the single most important habit to surface this week.
 *
 * Ranks (first match wins):
 *   1. at-risk-strong — at-risk/faded *and* historically ≥70 strength
 *      in the prior 30-day window (days 31–60 ago). Tie-break: highest
 *      historical strength.
 *   2. anchor-drift — anchor != null, drift === true, and currently in
 *      the top 3 by strength.
 *   3. mandate-weak — lowest-strength habit linked to state.pillars[0]
 *      via goalHabitMap.
 *   4. default — lowest-strength habit with current streak ≥3.
 *
 * Returns null when no rank fires (e.g. zero habits, or no habits with
 * streak ≥3 and no other ranks match). Per spec: contract is "always
 * one pick" *unless* the user has nothing to pick from.
 */
export function computeLeveragePick(state: LeveragePickState): LeveragePick | null {
  const rules = Array.isArray(state.recurringRules) ? state.recurringRules : [];
  if (rules.length === 0) return null;

  const habitLog = Array.isArray(state.habitLog) ? state.habitLog : [];
  const streaks = state.habitStreaks ?? {};
  const pillars = Array.isArray(state.pillars) ? state.pillars : [];
  const goalHabitMap = state.goalHabitMap ?? {};
  const now = state.now ?? new Date();

  // Snapshot every rule's current strength + recovery state once.
  const snapshots = rules.map((rule) => {
    const current = computeHabitStrength(rule, habitLog, now);
    const anchor = computeAnchorAdherence(rule, habitLog);
    const ruleKey = String(rule.title ?? '').toLowerCase();
    const streak = streaks[ruleKey] ?? 0;
    return { rule, current, anchor, streak, ruleKey };
  });

  // ── Rank 1: at-risk-strong ─────────────────────────────────────────
  // For each rule currently 'at-risk' or 'faded', compute strength in
  // the prior 30-day window (days 31–60 ago). Pick the one with the
  // highest historical strength, if any cross the threshold.
  const priorEnd = new Date(now.getTime() - LEVERAGE_HISTORICAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const atRiskCandidates = snapshots
    .filter((s) => s.current.status === 'at-risk' || s.current.status === 'faded')
    .map((s) => {
      const historical = computeHabitStrength(s.rule, habitLog, priorEnd);
      return { ...s, historical };
    })
    .filter((s) =>
      s.historical.strength !== null &&
      s.historical.strength >= LEVERAGE_HISTORICAL_STRENGTH_THRESHOLD,
    )
    .sort((a, b) => (b.historical.strength as number) - (a.historical.strength as number));

  if (atRiskCandidates.length > 0) {
    const pick = atRiskCandidates[0];
    return {
      habitId: pick.rule.id,
      habitTitle: pick.rule.title,
      rank: 'at-risk-strong',
      reason: `${pick.rule.title} — your strongest discipline, and it's slipping.`,
    };
  }

  // ── Rank 2: anchor-drift on a top-3 habit ──────────────────────────
  const ranked = [...snapshots]
    .filter((s) => s.current.strength !== null)
    .sort((a, b) => (b.current.strength as number) - (a.current.strength as number));
  const top3Ids = new Set(ranked.slice(0, LEVERAGE_TOP_N).map((s) => s.rule.id));

  const anchorDriftPick = snapshots.find((s) =>
    s.rule.anchor !== null &&
    s.rule.anchor !== undefined &&
    s.anchor.drift &&
    top3Ids.has(s.rule.id),
  );
  if (anchorDriftPick) {
    return {
      habitId: anchorDriftPick.rule.id,
      habitTitle: anchorDriftPick.rule.title,
      rank: 'anchor-drift',
      reason: `${anchorDriftPick.rule.title} — your timing is drifting. The anchor was: ${anchorDriftPick.rule.anchor}.`,
    };
  }

  // ── Rank 3: mandate-weak ───────────────────────────────────────────
  const topMandate = pillars[0];
  if (topMandate) {
    const linkedKeys = Object.entries(goalHabitMap)
      .filter(([, pillarIds]) => Array.isArray(pillarIds) && pillarIds.includes(topMandate.id))
      .map(([habitKey]) => habitKey);
    if (linkedKeys.length > 0) {
      const linkedSet = new Set(linkedKeys);
      const linkedSnapshots = snapshots.filter(
        (s) => linkedSet.has(s.ruleKey) && s.current.strength !== null,
      );
      if (linkedSnapshots.length > 0) {
        linkedSnapshots.sort(
          (a, b) => (a.current.strength as number) - (b.current.strength as number),
        );
        const pick = linkedSnapshots[0];
        return {
          habitId: pick.rule.id,
          habitTitle: pick.rule.title,
          rank: 'mandate-weak',
          reason: `${pick.rule.title} — your weakest habit on ${topMandate.title}, your #1 mandate.`,
        };
      }
    }
  }

  // ── Rank 4: default ────────────────────────────────────────────────
  const defaultCandidates = snapshots
    .filter((s) => s.current.strength !== null && s.streak >= LEVERAGE_DEFAULT_MIN_STREAK)
    .sort((a, b) => (a.current.strength as number) - (b.current.strength as number));
  if (defaultCandidates.length > 0) {
    const pick = defaultCandidates[0];
    return {
      habitId: pick.rule.id,
      habitTitle: pick.rule.title,
      rank: 'default',
      reason: `${pick.rule.title} — building, don't let it slip.`,
    };
  }

  return null;
}
