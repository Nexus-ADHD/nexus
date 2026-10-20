// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  TextInput, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useAppState } from '@/src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import { buildAIContext, AI_PERSONA } from '@/src/utils/ai-context';
import { buildReviewSuffix } from '@/src/ai/prompts';
import { chatCompletion } from '@/src/utils/ai-client';
import { MODELS } from '@/src/utils/ai-models';
import { useLiveTranscription } from '@/src/features/command/use-live-transcription';
import type { ReviewCadence, HorizonReview, NextWeekRuleOverride, LeveragePointSnapshot } from '@/src/state/app-state';
import {
  computeLeveragePoints,
  buildLeverageSuggestion,
  buildGraduateSuggestion,
  type LeverageSuggestion,
} from '@/src/utils/leverage';
import { computeHabitProgress } from '@/src/state/selectors/habit-rollup';
import {
  buildHabitLogIndex,
  defaultRangeForCadence,
  habitDailySeries,
} from '@/src/state/selectors/habit-trend';
import { normalize, stripEmoji } from '@/src/utils/text';
import { StreakBadge } from '@/src/components/ui/StreakBadge';
import { ScoreTrendChart } from '@/src/components/ui/ScoreTrendChart';
import { TrendSparkline } from '@/src/components/ui/TrendSparkline';
import { RANGE_KEYS } from '@/src/components/ui/score-trend-chart-helpers';
import tokens from '@/src/theme/tokens';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';
import { WeekAheadStepContainer } from './week-ahead-step';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
// FIXME(nex-56): neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline here)
const BORDER = tokens.color.goldHairline;
const TEXT_COLOR = tokens.color.text;
// FIXME(nex-56): off-scale gray; map to textMuted or design review
const MUTED = tokens.color.textMuted;
const GOLD = tokens.color.gold;
// FIXME(nex-56): no token for green; design review needed (CLAUDE.md uses teal for success)
const GREEN = tokens.color.teal;
// FIXME(nex-56): no token for red; consider tokens.color.stateError or design review

// ─── helpers ────────────────────────────────────────────────────────────────

function getLocalDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Date key of the upcoming Monday (today if today is Monday → 7 days out;
// otherwise the next Monday in the calendar).
function getNextMondayKey(d = new Date()) {
  const dow = d.getDay();
  let offset = (8 - dow) % 7;
  if (offset === 0) offset = 7;
  const target = new Date(d);
  target.setDate(d.getDate() + offset);
  return getLocalDateKey(target);
}

function getWeekKey(d = new Date()) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
function getMonthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function getQuarterKey(d = new Date()) { return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; }
function getHalfKey(d = new Date()) { return `${d.getFullYear()}-H${d.getMonth() < 6 ? 1 : 2}`; }
function getYearKey(d = new Date()) { return `${d.getFullYear()}`; }

function getPeriodLabel(cadence: ReviewCadence, d = new Date()): string {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (cadence === 'weekly') return `Week of ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  if (cadence === 'monthly') return `${months[d.getMonth()]} ${d.getFullYear()}`;
  if (cadence === 'quarterly') return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
  if (cadence === 'semiannual') return d.getMonth() < 6 ? `H1 ${d.getFullYear()}` : `H2 ${d.getFullYear()}`;
  return `${d.getFullYear()}`;
}

/**
 * NEX-305: route each review to the tier its synthesis depth actually warrants.
 * These calls used to pass no model and ride the shared default, so an annual
 * review — the deepest reflection the app performs, once a year — ran on the
 * same model as a weekly one. Quarterly and longer are rare enough to be
 * cost-insensitive; weekly and monthly stay on the mid tier.
 */
function modelForCadence(cadence: ReviewCadence): string {
  if (cadence === 'weekly') return MODELS.WEEKLY_REVIEW;
  if (cadence === 'monthly') return MODELS.MONTHLY_REVIEW;
  // quarterly | semiannual | annual
  return MODELS.DEEP_REVIEW;
}

function getCadenceTitle(cadence: ReviewCadence): string {
  return {
    weekly: 'WEEKLY REVIEW',
    monthly: 'MONTHLY REVIEW',
    quarterly: 'QUARTERLY REVIEW',
    semiannual: 'SEMI-ANNUAL REVIEW',
    annual: 'ANNUAL REVIEW',
  }[cadence];
}

export function getPeriodKey(cadence: ReviewCadence, d = new Date()): string {
  if (cadence === 'weekly') return getWeekKey(d);
  if (cadence === 'monthly') return getMonthKey(d);
  if (cadence === 'quarterly') return getQuarterKey(d);
  if (cadence === 'semiannual') return getHalfKey(d);
  return getYearKey(d);
}

// ─── date range for each cadence ─────────────────────────────────────────────
// Returns the period CONTAINING d. Pair with `defaultReflectionDate` so the
// label / key / range stay consistent: if reviewDate is "in April", all three
// describe April. Old behavior shifted range to the prior period while label
// described d's containing period — produced "April 2026" data under a "May
// 2026" header.

function getPeriodRange(cadence: ReviewCadence, d = new Date()): { start: Date; end: Date } {
  const s = new Date(d);
  const e = new Date(d);
  if (cadence === 'weekly') {
    // Sunday-to-Saturday calendar week containing d. Apple Calendar
    // semantics — the period stretches from Sunday at 00:00 to
    // Saturday at 23:59, and on early-week views it includes future
    // days that haven't happened yet. computeHabitProgress counts
    // those future days toward `expected` (correctly: they're
    // scheduled) but they can't be `completed` until the day arrives,
    // so the displayed % rises through the week. The Home weekly
    // debrief uses a rolling 7d window for the daily-snapshot
    // surface (see home-screen.tsx weeklyStats) — two surfaces, two
    // windows by design.
    s.setDate(s.getDate() - s.getDay()); // Sunday of d's week
    e.setTime(s.getTime());
    e.setDate(e.getDate() + 6);          // Saturday of d's week
  } else if (cadence === 'monthly') {
    s.setDate(1);
    e.setMonth(e.getMonth() + 1); e.setDate(0); // last day of d's month
  } else if (cadence === 'quarterly') {
    const q = Math.floor(d.getMonth() / 3);
    s.setMonth(q * 3); s.setDate(1);
    e.setMonth(q * 3 + 3); e.setDate(0);
  } else if (cadence === 'semiannual') {
    if (d.getMonth() < 6) {
      s.setMonth(0); s.setDate(1);
      e.setMonth(5); e.setDate(30);
    } else {
      s.setMonth(6); s.setDate(1);
      e.setMonth(11); e.setDate(31);
    }
  } else {
    s.setMonth(0); s.setDate(1);
    e.setMonth(11); e.setDate(31);
  }
  s.setHours(0,0,0,0);
  e.setHours(23,59,59,999);
  return { start: s, end: e };
}

// Reverse of getPeriodLabel — derives a date IN the period a saved review
// covers. Used when loading a past review for editing. Falls back to dateKey
// if the label format isn't recognized (legacy / future label changes).
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function parseReviewPeriodDate(cadence: ReviewCadence, periodLabel: string, fallbackDateKey: string): Date {
  try {
    if (cadence === 'monthly') {
      const m = periodLabel.match(/^(\w+) (\d{4})$/);
      if (m) {
        const monthIdx = MONTHS.indexOf(m[1]);
        if (monthIdx >= 0) return new Date(parseInt(m[2], 10), monthIdx, 1);
      }
    } else if (cadence === 'quarterly') {
      const m = periodLabel.match(/^Q(\d) (\d{4})$/);
      if (m) return new Date(parseInt(m[2], 10), (parseInt(m[1], 10) - 1) * 3, 1);
    } else if (cadence === 'semiannual') {
      const m = periodLabel.match(/^H(\d) (\d{4})$/);
      if (m) return new Date(parseInt(m[2], 10), (parseInt(m[1], 10) - 1) * 6, 1);
    } else if (cadence === 'annual') {
      const m = periodLabel.match(/^(\d{4})$/);
      if (m) return new Date(parseInt(m[1], 10), 0, 1);
    } else if (cadence === 'weekly') {
      const m = periodLabel.match(/^Week of (\w+) (\d+), (\d{4})$/);
      if (m) {
        const monthIdx = MONTHS.indexOf(m[1]);
        if (monthIdx >= 0) return new Date(parseInt(m[3], 10), monthIdx, parseInt(m[2], 10));
      }
    }
  } catch {}
  const [y, mo, da] = (fallbackDateKey || '').split('-').map(Number);
  if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(da)) {
    return new Date(y, mo - 1, da);
  }
  return new Date();
}

// Returns a date IN the last *completed* period for the given cadence — the
// default reflection target. On May 1, 2026: monthly → April 1 (April just
// ended), quarterly → January 1 (Q1 just ended), weekly → April 24 (last
// completed week containing this date). The auto-trigger fires on the first
// day of a new period, so this matches user expectation: open a review,
// reflect on the period that just ended.
function defaultReflectionDate(cadence: ReviewCadence, now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (cadence === 'weekly') {
    d.setDate(d.getDate() - 7);
  } else if (cadence === 'monthly') {
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
  } else if (cadence === 'quarterly') {
    const currentQ = Math.floor(now.getMonth() / 3);
    const prevQStartMonth = (currentQ - 1) * 3;
    if (prevQStartMonth < 0) {
      d.setFullYear(d.getFullYear() - 1);
      d.setMonth(prevQStartMonth + 12);
    } else {
      d.setMonth(prevQStartMonth);
    }
    d.setDate(1);
  } else if (cadence === 'semiannual') {
    const currentH = now.getMonth() < 6 ? 0 : 6;
    const prevHStartMonth = currentH - 6;
    if (prevHStartMonth < 0) {
      d.setFullYear(d.getFullYear() - 1);
      d.setMonth(prevHStartMonth + 12);
    } else {
      d.setMonth(prevHStartMonth);
    }
    d.setDate(1);
  } else {
    d.setFullYear(d.getFullYear() - 1);
    d.setMonth(0);
    d.setDate(1);
  }
  return d;
}

// ─── habit stats ─────────────────────────────────────────────────────────────

interface HabitStat {
  title: string;
  required: number;
  completed: number;
  totalDays: number;
  rate: number | null;
  status: 'new' | 'ready';
  streak: number;
  bestDay: string;
  // The rule this row was derived from, carried through so the ticker can build
  // its series without re-finding the rule by title. `computeHabitStats` maps
  // `recurringRules`, so an archived rule never reaches a row in the first place.
  rule: any;
  // True only when the rule was created within/after this reviewed period. "NEW"
  // renders only when status==='new' AND this is true — so a habit set up long ago
  // but never completed shows its (0×) count, not a misleading "NEW" badge.
  createdWithinPeriod: boolean;
}

function computeHabitStats(
  habitLog: any[],
  recurringRules: any[],
  habitStreaks: Record<string, number>,
  range: { start: Date; end: Date },
  pauseMode?: any // NEX-207: passed through to computeHabitProgress so paused days drop from expected
): { habits: HabitStat[]; totalDaysInPeriod: number; activeDays: number } {
  const startKey = getLocalDateKey(range.start);
  const endKey = getLocalDateKey(range.end);

  const periodLogs = (habitLog || []).filter((e: any) => e.dateKey >= startKey && e.dateKey <= endKey);

  // Count days in period
  const dayMs = 86400000;
  const totalDaysInPeriod = Math.max(1, Math.ceil((range.end.getTime() - range.start.getTime()) / dayMs) + 1);

  // Active days = unique dateKeys with any log
  const activeDays = new Set(periodLogs.map((e: any) => e.dateKey)).size;

  // Scheduled-so-far for the rate denominator. For an in-progress period
  // getPeriodRange returns the FULL period end (e.g. this week's Saturday),
  // which would count not-yet-due days toward `expected` and deflate the
  // displayed % into a shame-y "21%" mid-week (Law C guard). Clamp the rate's
  // period end to now so the % reads against what's actually been scheduled.
  // A past (completed) period is unaffected — end is already < now.
  const nowMs = Date.now();
  const rateRange = range.end.getTime() > nowMs ? { start: range.start, end: new Date(nowMs) } : range;

  // Per-habit stats — schedule-aware via shared selector.
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const habits: HabitStat[] = (recurringRules || []).map((rule: any) => {
    const key = normalize(rule.title);
    const required = rule.timesPerDay || 1;
    const progress = computeHabitProgress(rule, rateRange, habitLog, pauseMode);

    // Best day of week — kept off the helper since the helper doesn't
    // need to know UI concerns. Uses periodLogs (any logs in period,
    // not just scheduled) so an off-schedule log can still show as the
    // best day if that's the user's actual rhythm.
    const logs = periodLogs.filter((e: any) => normalize(e.habitTitle) === key);
    const byDay = [0,0,0,0,0,0,0];
    logs.forEach((e: any) => {
      const dow = new Date(e.dateKey + 'T12:00:00').getDay();
      byDay[dow]++;
    });
    const bestDayIdx = byDay.indexOf(Math.max(...byDay));

    return {
      title: rule.title,
      rule,
      required,
      completed: progress.completed,
      totalDays: totalDaysInPeriod,
      rate: progress.pct,
      status: progress.status,
      // Keep the rolling all-time streak from habitStreaks for this UI;
      // the per-period streak from progress.streak is a separate concept
      // surfaced elsewhere.
      streak: habitStreaks[key] || 0,
      bestDay: byDay[bestDayIdx] > 0 ? dayNames[bestDayIdx] : '—',
      // Created DURING this reviewed period? "NEW" only makes sense for a habit
      // that was actually born in the window under review — an older habit reads
      // its count, and a habit created after the window (e.g. reviewing a past
      // week) didn't exist then, so it isn't "new" to it either. (createdAt === 0
      // is the v14 "dawn of time" sentinel → treat as pre-existing.)
      createdWithinPeriod:
        typeof rule.createdAt === 'number' &&
        rule.createdAt > 0 &&
        getLocalDateKey(new Date(rule.createdAt)) >= startKey &&
        getLocalDateKey(new Date(rule.createdAt)) <= endKey,
    };
  });

  return { habits, totalDaysInPeriod, activeDays };
}

// Secondary completion-rate signal under a habit row's title — a proportional
// bar + percentage. Owner-requested §1.5 Law-C exception (see
// docs/plans/weekly-review-completion-rate.md): the reps count stays the
// primary number elsewhere in the row; this is the lighter "of what I
// scheduled" cue. Renders nothing for a new habit / null rate, so there is
// never a bare "0%" from a degenerate denominator. Positive-only color
// (teal/muted, never state.error red), even on a low week.
function HabitRateBar({ rate, status }: { rate: number | null; status: 'new' | 'ready' }) {
  if (status === 'new' || rate == null) return null;
  const pct = Math.max(0, Math.min(100, rate));
  return (
    <View style={styles.rateRow}>
      <View style={styles.rateTrack}>
        <View style={[styles.rateFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.ratePct}>{pct}%</Text>
    </View>
  );
}

// The accessibility suffix for a habit row — count-first, no absence language
// (Law C). Empty when there's no rate to announce.
function habitRateA11y(rate: number | null, status: 'new' | 'ready'): string {
  if (status === 'new' || rate == null) return '';
  return `, ${Math.max(0, Math.min(100, rate))} percent of scheduled so far`;
}

/**
 * A silent boundary around the ticker charts.
 *
 * This modal's whole render sits in a try/catch that falls back to `onDismiss()`
 * — so an exception anywhere under it does not show an error, it CLOSES the
 * review the user just opened, losing whatever they had typed. That catch also
 * cannot see a child's render throw (a child renders during reconciliation, not
 * during the parent's function call), so charts need their own guard and it has
 * to be a real error boundary.
 *
 * On a throw this renders nothing and the review carries on without its charts.
 * The charts are an addition to a screen that worked without them; none of them
 * is worth the reflection.
 */
class ChartBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: any) {
    console.warn('[HorizonReview] chart render failed, continuing without it:', error);
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

// Leverage analysis lives in src/utils/leverage.ts (shared with the home tab).

// ─── prompts per cadence ─────────────────────────────────────────────────────

function getPrompts(cadence: ReviewCadence): { key: string; label: string; placeholder: string }[] {
  if (cadence === 'weekly') return [
    { key: 'wins', label: 'What were your wins this week?', placeholder: 'What did you actually accomplish...' },
    { key: 'missed', label: 'What fell off?', placeholder: 'What slipped through the cracks...' },
    { key: 'next_focus', label: 'What is your #1 focus for next week?', placeholder: 'One thing that would make the week a success...' },
  ];
  if (cadence === 'monthly') return [
    { key: 'wins', label: 'What were your biggest wins this month?', placeholder: 'What actually moved the needle...' },
    { key: 'missed', label: 'What did you miss or avoid?', placeholder: 'Be honest...' },
    { key: 'energy', label: 'What drained your energy most?', placeholder: 'People, tasks, habits...' },
    { key: 'next_focus', label: 'What is the #1 focus for next month?', placeholder: 'One thing only...' },
  ];
  if (cadence === 'quarterly') return [
    { key: 'wins', label: 'Top wins of the quarter?', placeholder: 'What actually moved the needle...' },
    { key: 'missed', label: 'What did you miss or avoid?', placeholder: 'Be honest...' },
    { key: 'goal_progress', label: 'How did your goals progress?', placeholder: 'Which moved, which stalled...' },
    { key: 'next_priorities', label: 'Top 3 priorities for next quarter?', placeholder: 'Be specific...' },
  ];
  if (cadence === 'semiannual') return [
    { key: 'wins', label: 'Biggest wins of the last 6 months?', placeholder: 'What actually happened...' },
    { key: 'vision_alignment', label: 'Are your daily habits pointing toward your 5-year vision?', placeholder: 'Honest answer...' },
    { key: 'drop_or_commit', label: 'What needs to be cut or fully committed to?', placeholder: 'No more half-measures...' },
    { key: 'next_half', label: 'What will define the next 6 months?', placeholder: 'Your north star...' },
  ];
  return [
    { key: 'identity', label: 'How did you grow as a person this year?', placeholder: 'Who you became...' },
    { key: 'wins', label: 'Top 3 wins of the year?', placeholder: 'Real ones...' },
    { key: 'regrets', label: 'What do you wish you had done differently?', placeholder: 'No judgment...' },
    { key: 'vision_check', label: 'Is your vision still the right vision?', placeholder: 'Adjust if needed...' },
    { key: 'mandates', label: 'What are your mandates for next year?', placeholder: 'How you will show up...' },
  ];
}

const CADENCES: ReviewCadence[] = ['weekly', 'monthly', 'quarterly', 'semiannual', 'annual'];
const CADENCE_LABELS: Record<ReviewCadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Semi-Annual',
  annual: 'Annual',
};

// ─── due review check ────────────────────────────────────────────────────────

export function getDueReview(lastReviewDates: Record<string, string>): ReviewCadence | null {
  const now = new Date();
  const d = now.getDate();
  const m = now.getMonth();
  const dow = now.getDay();

  const checks: { cadence: ReviewCadence; periodKey: string; due: boolean }[] = [
    { cadence: 'annual',     periodKey: getYearKey(now),    due: d === 1 && m === 0 },
    { cadence: 'semiannual', periodKey: getHalfKey(now),    due: d === 1 && [0, 6].includes(m) },
    { cadence: 'quarterly',  periodKey: getQuarterKey(now), due: d === 1 && [0, 3, 6, 9].includes(m) },
    { cadence: 'monthly',    periodKey: getMonthKey(now),   due: d === 1 },
    { cadence: 'weekly',     periodKey: getWeekKey(now),    due: dow === 0 }, // Sunday
  ];

  for (const c of checks) {
    if (c.due && lastReviewDates[c.cadence] !== c.periodKey) {
      return c.cadence;
    }
  }
  return null;
}

// ─── past periods for back-fill ──────────────────────────────────────────────

function getPastPeriods(cadence: ReviewCadence, count = 12): { label: string; periodKey: string; date: Date }[] {
  const now = new Date();
  const periods = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    if (cadence === 'weekly') {
      d.setDate(d.getDate() - i * 7);
    } else if (cadence === 'monthly') {
      d.setMonth(d.getMonth() - i); d.setDate(1);
    } else if (cadence === 'quarterly') {
      const q = Math.floor(now.getMonth() / 3);
      d.setMonth((q - i) * 3); d.setDate(1);
    } else if (cadence === 'semiannual') {
      const h = now.getMonth() < 6 ? 0 : 6;
      d.setMonth(h - i * 6); d.setDate(1);
    } else {
      d.setFullYear(d.getFullYear() - i); d.setMonth(0); d.setDate(1);
    }
    periods.push({ label: getPeriodLabel(cadence, d), periodKey: getPeriodKey(cadence, d), date: new Date(d) });
  }
  return periods;
}

// ─── component ───────────────────────────────────────────────────────────────

interface Props {
  initialCadence: ReviewCadence;
  onDismiss: () => void;
}

export function HorizonReviewModal({ initialCadence, onDismiss }: Props) {
  const {
    addHorizonReview, updateHorizonReview, deleteHorizonReview, setLastReviewDate, habitStreaks, habitLog,
    softMode,
    scoreHistory, // the index line at the top of YOUR DATA
    pauseMode, // NEX-207
    recurringRules, goals, pillars, horizonReviews,
    goalHabitMap, setNextWeekRuleOverride, removeNextWeekRuleOverride,
    setPendingMondayIntention,
  } = useAppState(
    useShallow((s: any) => ({
      addHorizonReview: s.addHorizonReview,
      updateHorizonReview: s.updateHorizonReview,
      deleteHorizonReview: s.deleteHorizonReview,
      setLastReviewDate: s.setLastReviewDate,
      habitStreaks: s.habitStreaks,
      habitLog: s.habitLog,
      softMode: s.softMode,
      scoreHistory: s.scoreHistory,
      pauseMode: s.pauseMode,
      recurringRules: s.recurringRules,
      goals: s.goals,
      pillars: s.pillars,
      horizonReviews: s.horizonReviews,
      goalHabitMap: s.goalHabitMap,
      setNextWeekRuleOverride: s.setNextWeekRuleOverride,
      removeNextWeekRuleOverride: s.removeNextWeekRuleOverride,
      setPendingMondayIntention: s.setPendingMondayIntention,
    })),
  );

  const [activeCadence, setActiveCadence] = useState<ReviewCadence>(initialCadence);
  const [view, setView] = useState<'form' | 'generating' | 'summary' | 'leverage' | 'history' | 'period-picker' | 'week-ahead'>('form');
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState('');
  const [reviewDate, setReviewDate] = useState<Date>(() => defaultReflectionDate(initialCadence));
  // NEX-80: recordingKey serves as activeField for the live-transcription
  // hook below. Old expo-av Audio.Recording + Whisper path retired in
  // favor of useLiveTranscription (same SFSpeechRecognizer pipeline the
  // orb uses on Command + onboarding + mandate notes).
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [leverageSuggestions, setLeverageSuggestions] = useState<LeverageSuggestion[]>([]);
  const [appliedRuleIds, setAppliedRuleIds] = useState<string[]>([]);
  // When set, save path overwrites the existing review (preserving id +
  // dateKey) instead of creating a new row. Cleared by switchCadence,
  // period-picker selection, and the explicit Cancel-edit affordance.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which habit's full chart is open. Accordion — one at a time, so the card
  // never becomes a wall of charts to scroll past to reach the prompts.
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  // NEX-163: was the just-saved review an edit? generateSummary clears editingId
  // before the summary renders, so capture it here for the week-ahead gate below.
  const wasEditRef = useRef(false);

  // NEX-163: after an affirmative completion of the NORMAL weekly review (the
  // default last-completed-week target, not a backfill or a history edit), route
  // to the forward-scan step instead of dismissing. NOT the PendingMondayIntention
  // period-equality gate — reviewDate defaults to last week, so that would be false
  // on every normal review. Header/sheet raw-close keeps calling onDismiss directly.
  const finishReview = () => {
    const isNormalWeekly =
      activeCadence === 'weekly' &&
      !wasEditRef.current &&
      getWeekKey(reviewDate) === getWeekKey(defaultReflectionDate('weekly'));
    if (isNormalWeekly) setView('week-ahead');
    else onDismiss();
  };

  const loadReviewForEdit = (r: any) => {
    if (!r) return;
    setEditingId(r.id);
    setActiveCadence(r.cadence);
    setReviewDate(parseReviewPeriodDate(r.cadence, r.periodLabel || '', r.dateKey || ''));
    setResponses({ ...(r.responses || {}) });
    setSummary(r.summary || '');
    setLeverageSuggestions([]);
    setAppliedRuleIds([]);
    setExpandedRuleId(null);
    setView('form');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setResponses({});
    setSummary('');
    setReviewDate(defaultReflectionDate(activeCadence));
  };

  // Mirrors handleLongPress in align.tsx — long-press the history card,
  // confirm in an Alert, then delete via the new app-state action. If
  // the deleted row was loaded for edit, drop the edit state too.
  const handleHistoryLongPress = (r: any) => {
    if (!r) return;
    haptic('longPressStart');
    Alert.alert(
      'Delete review?',
      `${String(r.cadence || '').toUpperCase()} · ${r.periodLabel || ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (typeof deleteHorizonReview === 'function') {
              deleteHorizonReview(r.id);
            }
            if (editingId === r.id) cancelEdit();
          },
        },
      ],
    );
  };

  // NEX-80: single live-transcription recognizer shared across the
  // prompt fields. activeField is tracked via recordingKey.
  //
  // Transcript model (rewritten 2026-06-01): in continuous mode iOS returns
  // the FULL cumulative session transcript in every 'result' event — both
  // interim and final — NOT a per-pause segment. This is the same behavior
  // the working orb relies on (app/(tabs)/index.tsx replaces with
  // `final || interim`, never appends). The previous code here APPENDED each
  // "final" onto an accumulator, so cumulative-onto-cumulative produced
  // doubled text, and interim re-evaluation made words disappear. We now
  // mirror the orb: the field value is always
  //   baseRef (text typed before dictation began)  +  spokenRef (transcript).
  // baseRef captures the field's existing content at start; spokenRef tracks
  // the cumulative transcript and only grows (monotonic) so the live preview
  // never shrinks.
  const noteVoice = useLiveTranscription();
  const baseRef = useRef<string>('');
  const spokenRef = useRef<string>('');
  const micPulse = useSharedValue(1);

  useEffect(() => {
    if (noteVoice.isRecognizing) {
      micPulse.value = withRepeat(
        withTiming(0.5, { duration: 400, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      micPulse.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });
    }
  }, [noteVoice.isRecognizing, micPulse]);

  const micAnimStyle = useAnimatedStyle(() => ({
    opacity: micPulse.value,
  }));

  // Compose the field value from base + spoken, inserting a space only when
  // the typed base doesn't already end with whitespace.
  const composeField = useCallback((base: string, spoken: string): string => {
    const sep = base.length > 0 && spoken.length > 0 && !base.endsWith(' ') ? ' ' : '';
    return base + (spoken ? sep + spoken : '');
  }, []);

  // Stream the live transcript into the ACTIVE field only. Take the longer
  // of (final, interim) — both are cumulative — and keep spokenRef monotonic
  // so a momentary interim re-eval can't delete already-shown words.
  useEffect(() => {
    if (!noteVoice.isRecognizing || !recordingKey) return;
    const interim = noteVoice.interimTranscript;
    const fin = noteVoice.finalTranscript;
    const latest = fin.length >= interim.length ? fin : interim;
    if (latest.length > spokenRef.current.length) {
      spokenRef.current = latest;
    }
    setResponses(r => ({ ...r, [recordingKey]: composeField(baseRef.current, spokenRef.current) }));
  }, [noteVoice.interimTranscript, noteVoice.finalTranscript, noteVoice.isRecognizing, recordingKey, composeField]);

  // Commit the definitive transcript into a field on stop. After stop()
  // resolves, getLastFinal() (a ref) holds iOS's clean, punctuated, full
  // transcript. Prefer it whenever it exists — even if it's SHORTER than
  // the last interim preview (iOS may drop a trailing partial or correct a
  // misrecognition on finalization). Only fall back to the monotonic live
  // preview when no final fired at all.
  const commitField = useCallback((field: string) => {
    const fin = noteVoice.getLastFinal();
    const spoken = fin.trim().length > 0 ? fin : spokenRef.current;
    // Snapshot base BEFORE setResponses: the updater closure runs at React's
    // flush time, which is AFTER handleMicTap has already reassigned
    // baseRef.current (to '' on stop, or the next field's text on switch).
    // Reading the ref lazily inside the closure would drop the user's
    // pre-dictation typed text, or prepend the wrong field's base.
    const capturedBase = baseRef.current;
    setResponses(r => ({ ...r, [field]: composeField(capturedBase, spoken) }));
  }, [noteVoice, composeField]);

  const handleMicTap = useCallback(async (field: string) => {
    // Same field, currently listening → stop + commit.
    if (noteVoice.isRecognizing && recordingKey === field) {
      await noteVoice.stop();
      commitField(field);
      baseRef.current = '';
      spokenRef.current = '';
      setRecordingKey(null);
      noteVoice.reset();
      return;
    }

    // Different field active → stop current, commit into the OLD field,
    // then start a fresh recognizer for the NEW field.
    if (noteVoice.isRecognizing && recordingKey && recordingKey !== field) {
      await noteVoice.stop();
      commitField(recordingKey);
      noteVoice.reset();
    }

    // Idle (or just-stopped) → start for the new field. Capture the field's
    // current text as the base so dictation appends to what's already typed.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    baseRef.current = responses[field] ?? '';
    spokenRef.current = '';
    // continuous: true — review prompts are paragraph-length and the
    // user will pause between thoughts. Without this iOS auto-stops
    // on the first natural breath and surfaces "No speech detected."
    const ok = await noteVoice.start({ continuous: true });
    if (ok) {
      setRecordingKey(field);
    } else {
      baseRef.current = '';
      spokenRef.current = '';
      setRecordingKey(null);
    }
  }, [noteVoice, recordingKey, responses, commitField]);

  const prompts = getPrompts(activeCadence);
  const period = getPeriodLabel(activeCadence, reviewDate);
  const allAnswered = prompts.every(p => responses[p.key]?.trim());

  // Compute habit stats for the period
  const range = useMemo(() => getPeriodRange(activeCadence, reviewDate), [activeCadence, reviewDate]);
  const stats = useMemo(
    () => computeHabitStats(habitLog, recurringRules, habitStreaks, range, pauseMode),
    [habitLog, recurringRules, habitStreaks, range, pauseMode]
  );

  // NEX-226: the graded "average daily score" was removed from the weekly review
  // (no score-on-worth verdict). The look-back is additive only (reps held).

  // ─── ticker charts ────────────────────────────────────────────────────────
  // Right edge of every chart in this modal. The review reads the last COMPLETED
  // period and supports back-fills, so a line running to today under a "March
  // 2026" header would be describing a different span than the numbers beside
  // it. min(today, period end) keeps the two agreeing, and still lets an
  // in-progress period run to today rather than into the future.
  const chartEndKey = useMemo(() => {
    const todayKey = getLocalDateKey();
    const periodEndKey = getLocalDateKey(range.end);
    return periodEndKey < todayKey ? periodEndKey : todayKey;
  }, [range]);

  // Every rule's series, built from ONE pass over the habit log. Per-row
  // derivation would re-scan the whole log once per habit, inside a modal the
  // user is waiting on.
  const habitSeries = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    try {
      const index = buildHabitLogIndex(habitLog);
      for (const h of stats.habits) {
        if (!h.rule || h.status !== 'ready') continue;
        const id = String(h.rule.id ?? normalize(h.title));
        out[id] = habitDailySeries(h.rule, index, pauseMode, chartEndKey);
      }
    } catch {
      return {};
    }
    return out;
  }, [habitLog, pauseMode, chartEndKey, stats.habits]);

  // The window a chart opens on, matched to the period under review.
  const chartRange = defaultRangeForCadence(activeCadence);

  // Quiet selection tick, not a primary-action thump — this is a disclosure.
  const toggleHabitChart = (id: string) => {
    haptic('buttonSecondary');
    setExpandedRuleId((prev) => (prev === id ? null : id));
  };

  const switchCadence = (c: ReviewCadence) => {
    setActiveCadence(c);
    setView('form');
    setResponses({});
    setSummary('');
    setReviewDate(defaultReflectionDate(c));
    setLeverageSuggestions([]);
    setAppliedRuleIds([]);
    setEditingId(null);
    setExpandedRuleId(null);
  };

  const generateSummary = async () => {
    setView('generating');

    // Phase-1: compute leverage points + suggestions for weekly reviews only.
    // Other cadences keep their current behavior.
    let suggestions: LeverageSuggestion[] = [];
    let leverageSnapshot: LeveragePointSnapshot[] = [];
    if (activeCadence === 'weekly') {
      const { leverage, graduates } = computeLeveragePoints({
        recurringRules,
        habitLog,
        pillars,
        goalHabitMap: (goalHabitMap && typeof goalHabitMap === 'object') ? goalHabitMap : {},
        range,
      });
      suggestions = [
        ...leverage.map(buildLeverageSuggestion),
        ...graduates.map(buildGraduateSuggestion),
      ];
      const toSnapshot = (p: any, kind: 'leverage' | 'graduate'): LeveragePointSnapshot => ({
        ruleId: p.ruleId,
        title: p.title,
        rate: p.rate,
        kind,
        targetTimesPerDay: p.currentTimesPerDay,
        targetDaysOfWeek: p.currentDaysOfWeek,
      });
      leverageSnapshot = [
        ...leverage.map((l) => toSnapshot(l, 'leverage')),
        ...graduates.map((g) => toSnapshot(g, 'graduate')),
      ];
    }
    setLeverageSuggestions(suggestions);
    setAppliedRuleIds([]);

    // Build the review record. When editing, preserve the original id +
    // dateKey so the row updates in place (not a duplicate).
    const isEdit = !!editingId;
    const existing = isEdit
      ? (Array.isArray(horizonReviews) ? horizonReviews.find((r: any) => r.id === editingId) : null)
      : null;
    const review: HorizonReview = {
      id: existing?.id ?? `review-${Date.now()}`,
      cadence: activeCadence,
      dateKey: existing?.dateKey ?? getLocalDateKey(),
      summary: '',
      responses,
      periodLabel: period,
      ...(leverageSnapshot.length > 0 ? { leverage: leverageSnapshot } : {}),
    };

    try {
      // NEX-221: de-streak the review prompt (Law B) — drop the breakable top-streak
      // and per-habit "streak: Nd"; the cumulative "(N logs)" already conveys activity.
      const activeGoals = Array.isArray(pillars) ? pillars.map((p: any) => `${p.title} (${p.category})`).join(', ') : '';
      const habitStatsText = stats.habits.map(h =>
        `${h.title}: ${h.status === 'new' ? 'NEW' : `${h.completed} reps held`}`
      ).join(', ');
      const responsesText = prompts.map(p => `${p.label}: ${responses[p.key] || '(skipped)'}`).join('. ');

      const text = await chatCompletion([
        {
          role: 'system',
          content: AI_PERSONA + buildReviewSuffix(activeCadence),
        },
        {
          role: 'user',
          content: `${period}. Mandates: ${activeGoals || 'none'}. Habits: ${habitStatsText || 'early stage'}. Their words: ${responsesText}. Write the summary.`,
        },
      ], { model: modelForCadence(activeCadence) });
      review.summary = text?.trim() || 'Your responses have been saved.';
      setSummary(review.summary);
    } catch {
      review.summary = 'Your responses have been saved — summary will generate on next review.';
      setSummary(review.summary);
    }

    // Save: update-in-place when editing, otherwise create.
    if (isEdit && typeof updateHorizonReview === 'function') {
      const patch: any = {
        responses: review.responses,
        summary: review.summary,
        periodLabel: review.periodLabel,
      };
      if (review.leverage) patch.leverage = review.leverage;
      updateHorizonReview(review.id, patch);
    } else {
      addHorizonReview(review);
    }
    const currentPeriodKey = getPeriodKey(activeCadence, new Date());
    const thisPeriodKey = getPeriodKey(activeCadence, reviewDate);
    if (thisPeriodKey === currentPeriodKey) {
      setLastReviewDate(activeCadence, thisPeriodKey);
    }

    // Stage Monday's pre-filled focus from the weekly review's next_focus
    // answer. Only on a current-period weekly review (back-fills shouldn't
    // overwrite a fresh intention). Home consumes it Monday morning. Skip
    // when editing — the user is correcting a past entry, not setting next
    // week's intention.
    if (
      !isEdit &&
      activeCadence === 'weekly' &&
      thisPeriodKey === currentPeriodKey &&
      typeof setPendingMondayIntention === 'function'
    ) {
      const nextFocus = (responses.next_focus || '').trim();
      if (nextFocus) {
        setPendingMondayIntention(nextFocus, getNextMondayKey());
      }
    }

    wasEditRef.current = isEdit;
    setEditingId(null);
    setView('summary');
  };

  const pastReviews = Array.isArray(horizonReviews) ? horizonReviews : [];

  // Format a daysOfWeek array as a compact human label (e.g. [1,2,3,4,5] → "Wkdy",
  // [0,1,2,3,4,5,6] → "Daily", others → "M·W·F").
  const fmtDays = (days: number[]): string => {
    if (!Array.isArray(days) || days.length === 0) return '—';
    if (days.length === 7) return 'Daily';
    const sorted = [...days].sort();
    const isWeekdays = sorted.length === 5 && sorted.every((d, i) => d === i + 1);
    if (isWeekdays) return 'Wkdy';
    const isWeekends = sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6;
    if (isWeekends) return 'Wknd';
    const labels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    return sorted.map((d) => labels[d]).join('·');
  };

  const fmtCadence = (c: { daysOfWeek: number[]; timesPerDay: number }) =>
    `${c.timesPerDay}×/day · ${fmtDays(c.daysOfWeek)}`;

  const toggleLeverageSuggestion = (s: LeverageSuggestion) => {
    if (s.noChange) return;
    const sundayKey = getLocalDateKey();
    const isApplied = appliedRuleIds.includes(s.ruleId);
    if (isApplied) {
      // Undo — pull the override back out and unlock the row.
      if (typeof removeNextWeekRuleOverride === 'function') {
        removeNextWeekRuleOverride(sundayKey, s.ruleId);
      }
      setAppliedRuleIds((prev) => prev.filter((id) => id !== s.ruleId));
      return;
    }
    const override: NextWeekRuleOverride = {
      ruleId: s.ruleId,
      title: s.title,
      reason: s.reason,
      before: s.before,
      after: s.after,
      appliedAt: Date.now(),
    };
    if (typeof setNextWeekRuleOverride === 'function') {
      setNextWeekRuleOverride(sundayKey, override);
    }
    setAppliedRuleIds((prev) => (prev.includes(s.ruleId) ? prev : [...prev, s.ruleId]));
  };

  const showLeverageStep = activeCadence === 'weekly' && leverageSuggestions.length > 0;

  try {
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onDismiss}>
      <View style={styles.container}>

        {/* Header */}
        <View style={styles.header}>
          {/* Explicit close affordance — iOS formSheet's swipe-down is
              competing with the inner ScrollView, and the drag bar
              below is only a tap target (Pressable, no pan gesture).
              The ✕ in the corner guarantees a reliable tap path out. */}
          <Pressable
            onPress={onDismiss}
            hitSlop={12}
            accessibilityLabel="Close review"
            accessibilityRole="button"
            style={styles.closeBtn}
          >
            <Ionicons name="close" size={22} color={tokens.color.text} />
          </Pressable>
          <Pressable onPress={onDismiss} style={styles.dismissBtn}>
            <View style={styles.dismissBar} />
          </Pressable>
          {/* Cadence tabs — horizontal scroll for 5 tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
            {CADENCES.map(c => (
              <Pressable key={c} onPress={() => switchCadence(c)} style={[styles.tab, activeCadence === c && styles.tabActive]}>
                <Text style={[styles.tabText, activeCadence === c && styles.tabTextActive]}>{CADENCE_LABELS[c]}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: tokens.spacing.md, marginTop: tokens.spacing.xs }}>
            <Pressable onPress={() => setView(v => v === 'period-picker' ? 'form' : 'period-picker')} style={styles.historyBtn}>
              <Text style={styles.historyBtnText}>{view === 'period-picker' ? 'BACK' : 'BACK-FILL'}</Text>
            </Pressable>
            <Pressable onPress={() => setView(v => v === 'history' ? 'form' : 'history')} style={styles.historyBtn}>
              <Text style={styles.historyBtnText}>{view === 'history' ? 'BACK' : 'HISTORY'}</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets={true}>

          <Text style={styles.cadenceLabel}>{getCadenceTitle(activeCadence)}</Text>
          <Text style={styles.periodLabel}>{period}</Text>

          {/* ─── HABIT STATS DASHBOARD ─────────────────────────── */}
          {view === 'form' && stats.habits.length > 0 && (
            <View style={styles.statsCard}>
              <Text style={styles.statsTitle}>YOUR DATA</Text>

              {/* ── YOUR INDEX — the alignment score as a ticker ──
                  The same chart Home and /this-week draw, anchored to the
                  reviewed period rather than to today, and opening on the range
                  that matches the cadence (a weekly review opens on 1W, an
                  annual on 1Y). Auto-scaled, like everywhere else: the index is
                  a relative read, and its shape is the point.

                  key={activeCadence} because `initialRange` is a mount-only
                  default — without the remount, switching to the Annual tab
                  would leave the chart sitting on the weekly window. */}
              <ChartBoundary>
                <View style={styles.indexBlock}>
                  <Text style={styles.indexTitle}>YOUR INDEX</Text>
                  <ScoreTrendChart
                    key={activeCadence}
                    scoreHistory={scoreHistory}
                    pauseMode={pauseMode}
                    todayKey={getLocalDateKey()}
                    endKey={chartEndKey}
                    initialRange={chartRange}
                    ranges={RANGE_KEYS}
                    height={120}
                  />
                </View>
              </ChartBoundary>

              {/* Overview row */}
              {/* NEX-226: additive only — what was held, never a graded score or missed-day denominator (Law B/C). */}
              <View style={styles.statsOverview}>
                <View style={styles.statBox}>
                  <Text style={[styles.statNum, { color: GREEN }]}>{stats.habits.reduce((sum, h) => sum + (h.completed || 0), 0)}</Text>
                  <Text style={styles.statLabel}>REPS HELD</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statNum}>{stats.activeDays}</Text>
                  <Text style={styles.statLabel}>DAYS SHOWED UP</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statNum}>{stats.habits.filter((h) => (h.completed || 0) > 0).length}</Text>
                  <Text style={styles.statLabel}>HABITS HELD</Text>
                </View>
              </View>

              {/* Per-habit breakdown — reps held stays the primary number; the
                  rate + proportional bar are a secondary, glanceable "of what I
                  scheduled" signal (owner-requested, documented Law-C exception
                  in docs/plans/weekly-review-completion-rate.md). Positive-only
                  color (teal/muted, never red); scheduled-so-far denominator. */}
              {stats.habits.map((h) => {
                const ruleId = h.rule ? String(h.rule.id ?? normalize(h.title)) : null;
                const series = ruleId ? habitSeries[ruleId] : null;
                // A row gets a ticker only when there is a real series behind it.
                // `habitSeries` already skips status 'new' (mirroring HabitRateBar
                // — a habit with no completions has no trend to draw), and a rule
                // with no scheduled weekdays has no denominator, so it has no price.
                const hasTicker = !!series && Object.keys(series).length > 0;
                const expanded = hasTicker && expandedRuleId === ruleId;
                // Kimi #8: this label is unchanged, character for character. The
                // button hint is APPENDED — a row that gained a chart must not
                // change what VoiceOver already says about the numbers.
                const rowLabel = `${stripEmoji(h.title)}, ${h.completed} held${habitRateA11y(h.rate, h.status)}`;
                const rowContent = (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.habitStatTitle}>{stripEmoji(h.title)}</Text>
                      <HabitRateBar rate={h.rate} status={h.status} />
                    </View>
                    {hasTicker && (
                      <ChartBoundary>
                        <TrendSparkline
                          series={series}
                          pauseMode={pauseMode}
                          endKey={chartEndKey}
                          range={chartRange}
                        />
                      </ChartBoundary>
                    )}
                    <View style={styles.habitStatMeta}>
                      {h.status === 'new' && h.createdWithinPeriod ? (
                        <Text style={[styles.habitStatPct, { color: MUTED }]}>NEW</Text>
                      ) : (
                        <Text
                          style={[
                            styles.habitStatPct,
                            { color: h.completed > 0 ? GREEN : MUTED },
                          ]}
                        >
                          {h.completed}×
                        </Text>
                      )}
                      {/* NEX-190: the breakable streak shows only in opt-in Soft Mode. */}
                      {softMode && h.streak > 0 ? (
                        <StreakBadge streak={h.streak as number} bestDay={h.bestDay} />
                      ) : (
                        <Text style={styles.habitStatBest}>{h.bestDay}</Text>
                      )}
                    </View>
                  </>
                );
                return (
                  <View key={h.title}>
                    {hasTicker ? (
                      <Pressable
                        onPress={() => toggleHabitChart(ruleId as string)}
                        // minHeight is on the Pressable, not the shared row style:
                        // only the TAPPABLE rows need the §19 44pt floor, and rows
                        // without a ticker keep their existing spacing exactly.
                        style={({ pressed }) => [
                          styles.habitStatRow,
                          { minHeight: 44 },
                          pressed ? { opacity: 0.72 } : null,
                        ]}
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={rowLabel}
                        accessibilityHint="Double-tap for this habit's trend chart"
                        accessibilityState={{ expanded }}
                      >
                        {rowContent}
                      </Pressable>
                    ) : (
                      <View style={styles.habitStatRow} accessible accessibilityLabel={rowLabel}>
                        {rowContent}
                      </View>
                    )}

                    {/* The habit's own ticker, on a PINNED 0–100 axis. A
                        completion rate is an absolute scale: auto-zoom would draw
                        a 78→82 wobble as a crash, and would give every habit its
                        own invisible ruler. Keyed by cadence + rule so the chart
                        re-opens on the new cadence's range. */}
                    {expanded && (
                      <ChartBoundary>
                        <View style={styles.habitChartBlock}>
                          <ScoreTrendChart
                            key={`${activeCadence}-${ruleId}`}
                            scoreHistory={series}
                            pauseMode={pauseMode}
                            todayKey={getLocalDateKey()}
                            endKey={chartEndKey}
                            initialRange={chartRange}
                            ranges={RANGE_KEYS}
                            fixedDomain
                            height={110}
                            chartLabel={`${stripEmoji(h.title)} trend`}
                            a11yNoun={stripEmoji(h.title)}
                          />
                          <Text style={styles.habitChartCaption}>
                            Share of scheduled reps held, over the trailing week.
                          </Text>
                        </View>
                      </ChartBoundary>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {/* Period picker */}
          {view === 'period-picker' && (
            <>
              <Text style={[styles.subtitle, { marginBottom: tokens.spacing.md }]}>Select a past period to reflect on:</Text>
              {getPastPeriods(activeCadence, 12).map((p) => (
                <Pressable
                  key={p.periodKey}
                  style={[styles.periodPickerRow, reviewDate.getTime() === p.date.getTime() && styles.periodPickerRowActive]}
                  onPress={() => { setReviewDate(p.date); setView('form'); setResponses({}); setSummary(''); setEditingId(null); setExpandedRuleId(null); }}
                >
                  <Text style={styles.periodPickerLabel}>{p.label}</Text>
                  <Text style={styles.periodPickerMeta}>{p.periodKey}</Text>
                </Pressable>
              ))}
            </>
          )}

          {/* History */}
          {view === 'history' && (
            <>
              {pastReviews.length === 0 ? (
                <Text style={[styles.subtitle, { marginTop: tokens.spacing.lg }]}>No reviews completed yet.</Text>
              ) : (
                pastReviews.filter((r: any) => r.cadence === activeCadence).map((r: any) => (
                  <Pressable
                    key={r.id}
                    style={styles.historyCard}
                    onPress={() => loadReviewForEdit(r)}
                    onLongPress={() => handleHistoryLongPress(r)}
                    delayLongPress={350}
                  >
                    <Text style={styles.historyMeta} numberOfLines={1}>{r.cadence.toUpperCase()}  ·  {r.periodLabel}  ·  {r.dateKey}</Text>
                    <Text style={styles.historyEditHint}>TAP EDIT · HOLD DELETE</Text>
                    {r.summary ? <Text style={styles.historyText}>{r.summary}</Text> : null}
                    {Object.entries(r.responses || {}).map(([k, v]: any) => (
                      <View key={k} style={styles.historyResponse}>
                        <Text style={styles.historyQ}>{k}</Text>
                        <Text style={styles.historyA}>{v}</Text>
                      </View>
                    ))}
                  </Pressable>
                ))
              )}
            </>
          )}

          {/* Form */}
          {view === 'form' && (
            <>
              {editingId && (
                <View style={styles.editBanner}>
                  <Text style={styles.editBannerLabel}>EDITING SAVED REVIEW</Text>
                  <Pressable onPress={cancelEdit} hitSlop={tokens.icon.hitTarget.linkSlop} accessibilityRole="button" accessibilityLabel="Cancel editing review">
                    <Text style={styles.editBannerCancel}>CANCEL</Text>
                  </Pressable>
                </View>
              )}
              {/* Pre-filled data insights */}
              {stats.habits.length > 0 && (
                // FIXME(nex-56): tokens.color.goldWash amber-dark tint, no token — design review
                // FIXME(nex-56): 'rgba(229,186,110,0.25)' yellow-dark tint, no token — design review
                <View style={{ backgroundColor: tokens.color.goldWash, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(229,186,110,0.25)', padding: tokens.spacing.md, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ }}>
                  {/* FIXME(nex-56): off-scale fontSize 8, design review */}
                  <Text style={{ color: GOLD, fontSize: 8, fontWeight: '900', letterSpacing: 2, marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}>YOUR {period.toUpperCase()} DATA</Text>
                  {/* NEX-226: additive only — no graded score, no missed-day denominator, no rate %. */}
                  {/* FIXME(nex-56): off-scale fontSize 14, design review */}
                  <Text style={{ color: TEXT_COLOR, fontSize: 14, lineHeight: 22, marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */ }}>
                    Showed up <Text style={{ fontWeight: '700' }}>{stats.activeDays}</Text> {stats.activeDays === 1 ? 'day' : 'days'}
                  </Text>
                  {stats.habits.slice(0, 5).map((h) => {
                    // Same gate as the YOUR DATA rows: "NEW" only for a habit
                    // genuinely new to this period, never for an established one.
                    const showNew = h.status === 'new' && h.createdWithinPeriod;
                    return (
                    <View key={h.title} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: tokens.spacing.xxs }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: showNew || h.completed === 0 ? MUTED : GREEN, marginRight: tokens.spacing.xs }} />
                      {/* FIXME(nex-56): tokens.color.textSecondary off-scale gray — design review */}
                      {/* FIXME(nex-56): fontSize 13 matches caption size but fontWeight default ≠ token '500' — design review */}
                      <Text style={{ color: tokens.color.textSecondary, fontSize: 13 }}>
                        {stripEmoji(h.title)}: {showNew
                          ? <Text style={{ color: MUTED, fontWeight: '700' }}>NEW</Text>
                          : <Text style={{ color: TEXT_COLOR, fontWeight: '700' }}>{h.completed}× held</Text>}
                        {softMode && h.streak >= 3 ? ` · ▲ ${h.streak}` : ''}
                      </Text>
                    </View>
                    );
                  })}
                </View>
              )}

              {prompts.map((prompt, i) => (
                <View key={prompt.key} style={styles.promptBlock}>
                  <Text style={styles.promptNum}>{String(i + 1).padStart(2, '0')}</Text>
                  <Text style={styles.promptLabel}>{prompt.label}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.xs }}>
                    <TextInput
                      style={[styles.promptInput, { flex: 1 }]}
                      placeholder={prompt.placeholder}
                      placeholderTextColor={MUTED}
                      value={responses[prompt.key] || ''}
                      onChangeText={(t) => setResponses(r => ({ ...r, [prompt.key]: t }))}
                      multiline
                      numberOfLines={3}
                    />
                    <Pressable
                      onPress={() => handleMicTap(prompt.key)}
                      hitSlop={10}
                      style={({ pressed }) => [
                        styles.horizonMicBtn,
                        pressed && { opacity: 0.6 },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={
                        recordingKey === prompt.key ? 'Stop dictating' : 'Dictate'
                      }
                    >
                      {/* Pulse only the field that's actually recording —
                          micAnimStyle is one shared value, so applying it to
                          every mic made them all blink in unison. */}
                      <Animated.View style={recordingKey === prompt.key ? micAnimStyle : undefined}>
                        <Ionicons
                          name={recordingKey === prompt.key ? 'mic' : 'mic-outline'}
                          size={18}
                          color={GOLD}
                        />
                      </Animated.View>
                    </Pressable>
                  </View>
                </View>
              ))}
              {/* Tap-to-speak / tap-when-done affordance (consistent with the
                  Command tab + onboarding): the active field's mic pulses; this
                  tells the user a second tap ends the dictation. */}
              {noteVoice.isRecognizing && recordingKey && (
                <Text style={styles.horizonMicHint}>TAP WHEN DONE</Text>
              )}
              {/* NEX-80: dictation error caption. Surfaces inline below
                  the prompt block when useLiveTranscription's errorMessage
                  is non-null (mic permission denied, recognizer init
                  failure, etc.). Same pattern as the mandate notes mic. */}
              {noteVoice.errorMessage && (
                <Text style={styles.horizonMicError}>{noteVoice.errorMessage}</Text>
              )}
              <PrimaryPill fullWidth style={{ marginTop: tokens.spacing.md }} disabled={!allAnswered} onPress={generateSummary}>
                GENERATE REVIEW →
              </PrimaryPill>
              <Pressable style={styles.skipBtn} onPress={() => {
                setLastReviewDate(activeCadence, getPeriodKey(activeCadence, new Date()));
                onDismiss();
              }}>
                <Text style={styles.skipText}>SKIP THIS REVIEW</Text>
              </Pressable>
            </>
          )}

          {/* Generating */}
          {view === 'generating' && (
            <View style={styles.generatingContainer}>
              <ActivityIndicator color={GOLD} size="large" />
              <Text style={styles.generatingText}>Synthesizing your {period} review...</Text>
            </View>
          )}

          {/* Summary */}
          {view === 'summary' && (
            <>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>YOUR {period.toUpperCase()} SUMMARY</Text>
                <Text style={styles.summaryText}>{summary}</Text>
              </View>

              {/* Habits held in summary view — reps held primary + the same
                  secondary rate bar as YOUR DATA (positive-only, scheduled-so-far). */}
              {stats.habits.length > 0 && (
                <View style={styles.statsCard}>
                  <Text style={styles.statsTitle}>HABITS HELD</Text>
                  {stats.habits.map((h) => (
                    <View
                      key={h.title}
                      style={styles.habitStatRow}
                      accessible
                      accessibilityLabel={`${stripEmoji(h.title)}, ${h.completed} held${habitRateA11y(h.rate, h.status)}`}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.habitStatTitle}>{stripEmoji(h.title)}</Text>
                        <HabitRateBar rate={h.rate} status={h.status} />
                      </View>
                      {h.status === 'new' ? (
                        <Text style={[styles.habitStatPct, { color: MUTED }]}>NEW</Text>
                      ) : (
                        <Text style={[styles.habitStatPct, { color: GREEN }]}>
                          {h.completed}×
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.recapCard}>
                <Text style={styles.recapTitle}>YOUR RESPONSES</Text>
                {prompts.map(p => responses[p.key] ? (
                  <View key={p.key} style={styles.recapRow}>
                    <Text style={styles.recapQ}>{p.label}</Text>
                    <Text style={styles.recapA}>{responses[p.key]}</Text>
                  </View>
                ) : null)}
              </View>
              {showLeverageStep ? (
                <PrimaryPill fullWidth style={{ marginTop: tokens.spacing.md }} onPress={() => setView('leverage')}>
                  ADJUST FOR NEXT WEEK →
                </PrimaryPill>
              ) : (
                <PrimaryPill fullWidth style={{ marginTop: tokens.spacing.md }} onPress={finishReview}>
                  CLOSE & CONTINUE →
                </PrimaryPill>
              )}
            </>
          )}

          {/* Leverage adjustments — weekly only */}
          {view === 'leverage' && (
            <>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>NEXT WEEK</Text>
                <Text style={styles.summaryText}>
                  Based on last week, here are the adjustments worth making. Apply only what you'll actually keep. Overrides take effect Monday.
                </Text>
              </View>

              {leverageSuggestions.map((s) => {
                const applied = appliedRuleIds.includes(s.ruleId);
                const isLeverage = s.kind === 'leverage';
                return (
                  <View
                    key={s.ruleId}
                    style={[
                      styles.leverageCard,
                      applied && styles.leverageCardApplied,
                      s.noChange && { opacity: 0.55 },
                    ]}
                  >
                    <Text style={[styles.leverageKind, { color: isLeverage ? GOLD : GREEN }]}>
                      {isLeverage ? 'ADJUST' : 'GRADUATE'}
                    </Text>
                    <Text style={styles.leverageTitle}>{stripEmoji(s.title)}</Text>
                    <Text style={styles.leverageReason}>{s.reason}</Text>
                    {!s.noChange && (
                      <Text style={styles.leverageDelta}>
                        {fmtCadence(s.before)}  →  <Text style={{ color: GOLD, fontWeight: '900' }}>{fmtCadence(s.after)}</Text>
                      </Text>
                    )}
                    <Pressable
                      onPress={() => toggleLeverageSuggestion(s)}
                      disabled={s.noChange}
                      style={[
                        styles.leverageApplyBtn,
                        applied && styles.leverageApplyBtnApplied,
                        s.noChange && { opacity: 0.4 },
                      ]}
                    >
                      <Text style={[styles.leverageApplyText, applied && { color: GREEN }]}>
                        {applied ? 'APPLIED ✓ — TAP TO UNDO' : s.noChange ? 'NO CHANGE' : 'APPLY →'}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}

              <PrimaryPill fullWidth style={{ marginTop: tokens.spacing.md }} onPress={finishReview}>
                DONE →
              </PrimaryPill>
              <Pressable style={styles.skipBtn} onPress={finishReview}>
                <Text style={styles.skipText}>SKIP — DON'T ADJUST</Text>
              </Pressable>
            </>
          )}

          {view === 'week-ahead' && <WeekAheadStepContainer onDone={onDismiss} />}
        </ScrollView>
        <StatusBarScrim />
      </View>
    </Modal>
  );
  } catch {
    onDismiss();
    return null;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: { paddingTop: tokens.spacing.md, paddingHorizontal: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, paddingBottom: tokens.spacing.sm, borderBottomWidth: 1, borderBottomColor: BORDER },
  dismissBtn: { alignItems: 'center', paddingBottom: tokens.spacing.sm },
  closeBtn: {
    position: 'absolute',
    top: tokens.spacing.sm,
    right: tokens.spacing.md,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray; map to textMuted or design review
  dismissBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens.color.textDisabled },
  tabRow: { flexDirection: 'row', gap: 6 /* FIXME(nex-56): off-scale spacing 6 — review */, paddingRight: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  tab: { paddingHorizontal: tokens.spacing.sm, paddingVertical: tokens.spacing.xs, borderRadius: 8, borderWidth: 1, borderColor: BORDER, alignItems: 'center' },
  tabActive: { backgroundColor: GOLD, borderColor: GOLD },
  // FIXME(nex-56): off-scale fontSize 9, design review
  tabText: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  tabTextActive: { color: tokens.color.textInverse },
  historyBtn: { alignSelf: 'flex-end' },
  // FIXME(nex-56): off-scale fontSize 10, design review
  historyBtnText: { color: MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  scroll: { padding: tokens.spacing.lg, paddingBottom: 80 /* FIXME(nex-56): off-scale spacing 80 — between xxxl(72) and huge(96), review */ },
  // FIXME(nex-56): off-scale fontSize 10, design review
  cadenceLabel: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */ },
  // FIXME(nex-56): fontSize 28 matches titleScreen size but fontWeight '800' ≠ token '600' — design review (no bulk weight shift per migration rule)
  periodLabel: { color: TEXT_COLOR, fontSize: 28, fontWeight: '800', letterSpacing: -1, marginBottom: tokens.spacing.md },
  subtitle: { color: MUTED, fontSize: 13, lineHeight: 20, marginBottom: 28 /* FIXME(nex-56): off-scale spacing 28 — between lg(24) and xl(32), review */ },

  // Stats dashboard
  statsCard: { backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: 18 /* FIXME(nex-56): off-scale spacing 18 — between md(16) and lg(24), review */, marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale fontSize 9, design review
  statsTitle: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  statsOverview: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, paddingBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, borderBottomWidth: 1, borderBottomColor: BORDER },
  statBox: { alignItems: 'center' },
  // FIXME(nex-56): fontSize 28 matches titleScreen size but fontWeight '900' ≠ token '600' — design review (no bulk weight shift per migration rule)
  statNum: { color: TEXT_COLOR, fontSize: 28, fontWeight: '900', lineHeight: 32 },
  // FIXME(nex-56): off-scale fontSize 8, design review
  statLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 1.5, marginTop: tokens.spacing.xxs },
  habitStatRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, gap: tokens.spacing.sm },

  // YOUR INDEX — the alignment-score ticker at the head of the card. Sits above
  // the overview row and is separated from it by the same hairline the overview
  // uses below itself, so the card reads index → totals → habits.
  indexBlock: { marginBottom: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, paddingBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, borderBottomWidth: 1, borderBottomColor: BORDER },
  // FIXME(nex-56): off-scale fontSize 8, design review — matches statLabel
  indexTitle: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 1.5, marginBottom: tokens.spacing.sm },

  // Expanded per-habit chart, inset under its row.
  habitChartBlock: { marginBottom: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, paddingLeft: tokens.spacing.xs },
  // FIXME(nex-56): off-scale fontSize 10, design review
  habitChartCaption: { color: MUTED, fontSize: 10, lineHeight: 15, marginTop: tokens.spacing.xs },
  // FIXME(nex-56): fontSize 13 matches caption size but fontWeight '600' ≠ token '500' — design review (no bulk weight shift per migration rule)
  habitStatTitle: { color: TEXT_COLOR, fontSize: 13, fontWeight: '600', marginBottom: tokens.spacing.xxs },
  // NEX-226: habitStatBar / habitStatFill (the graded width:rate% verdict bars) removed with the de-verdict.
  habitStatMeta: { alignItems: 'flex-end', gap: 2 /* FIXME(nex-56): off-scale spacing 2 — review */, minWidth: 50 },
  // FIXME(nex-56): off-scale fontSize 16 (buttonPrimary is 16 but Inter-SemiBold/600; this is weight '900') — design review
  habitStatPct: { fontSize: 16, fontWeight: '900' },
  // FIXME(nex-56): off-scale fontSize 10, design review
  habitStatStreak: { fontSize: 10, color: MUTED },
  // FIXME(nex-56): off-scale fontSize 8, design review
  habitStatBest: { fontSize: 8, color: MUTED, fontWeight: '700', letterSpacing: 1 },

  // Rate bar — secondary "of scheduled" signal under each habit title.
  // Count stays primary on the right; this is the glanceable supporting cue.
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.xs, marginTop: tokens.spacing.xxs, paddingRight: tokens.spacing.sm },
  rateTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: tokens.color.goldHairline, overflow: 'hidden' },
  // Positive-only fill — teal, never state.error red, even on a low week (Law-C exception guardrail).
  rateFill: { height: '100%', borderRadius: 2, backgroundColor: GREEN },
  ratePct: { fontSize: 11, color: MUTED, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 30, textAlign: 'right' },

  // Prompts
  promptBlock: { marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale fontSize 10, design review
  promptNum: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): fontSize 15 (bodyMd) but fontWeight '600' ≠ token '400' (matches bodyMdEmphasis '500' but still mismatch) — design review
  promptLabel: { color: TEXT_COLOR, fontSize: 15, fontWeight: '600', marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, lineHeight: 22 },
  promptInput: {
    backgroundColor: SURFACE, borderRadius: 12, borderWidth: 1, borderColor: BORDER,
    // FIXME(nex-56): off-scale fontSize 14, design review
    color: TEXT_COLOR, fontSize: 14, padding: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, lineHeight: 20, minHeight: 80, textAlignVertical: 'top',
  },
  // NEX-80: 36pt circular mic affordance, same as the NEX-77 mandate
  // notes button. Quiet input affordance — gold icon on surface with
  // a gold-hairline border. Vertically centered against the full
  // TextInput height by the parent row's alignItems: 'center'.
  horizonMicBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // NEX-80: dictation error caption. Mirrors the mandate notes error
  // pattern (red, small, sits below the field).
  horizonMicError: {
    color: tokens.color.stateError,
    fontSize: 12,
    marginTop: 4,
    marginBottom: tokens.spacing.sm,
  },
  horizonMicHint: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.teal,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: tokens.spacing.sm,
  },
  skipBtn: { alignItems: 'center', paddingVertical: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  // FIXME(nex-56): off-scale fontSize 10, design review
  skipText: { color: MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  generatingContainer: { alignItems: 'center', paddingTop: 80 /* FIXME(nex-56): off-scale spacing 80 — between xxxl(72) and huge(96), review */, gap: tokens.spacing.lg },
  // FIXME(nex-56): off-scale fontSize 14, design review
  generatingText: { color: MUTED, fontSize: 14, letterSpacing: 0.5 },
  // FIXME(nex-56): tokens.color.goldWash amber-dark tint, no token — design review
  // FIXME(nex-56): 'rgba(229,186,110,0.25)' yellow-dark tint, no token — design review
  summaryCard: { backgroundColor: tokens.color.goldWash, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(229,186,110,0.25)', padding: tokens.spacing.lg, marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale fontSize 9, design review
  summaryTitle: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): fontSize 15 (bodyMd) but lineHeight 24 ≠ token 22 — design review
  summaryText: { color: TEXT_COLOR, fontSize: 15, lineHeight: 24 },
  recapCard: { backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: tokens.spacing.lg, marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale fontSize 9, design review
  recapTitle: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.md },
  recapRow: { marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  // FIXME(nex-56): off-scale fontSize 11 (labelTrackedSm is 11 but uppercase + tracked '600'; this is regular '700') — design review
  recapQ: { color: MUTED, fontSize: 11, fontWeight: '700', marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale fontSize 14, design review
  recapA: { color: TEXT_COLOR, fontSize: 14, lineHeight: 20 },
  historyCard: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: tokens.spacing.md, marginBottom: tokens.spacing.md },
  // FIXME(nex-56): off-scale fontSize 9, design review
  historyMeta: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 1.5, marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale fontSize 8, design review
  historyEditHint: { color: MUTED, fontSize: 8, fontWeight: '900', letterSpacing: 1.5, marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  // FIXME(nex-56): off-scale fontSize 14, design review
  historyText: { color: TEXT_COLOR, fontSize: 14, lineHeight: 22, marginBottom: tokens.spacing.sm },
  historyResponse: { marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  // FIXME(nex-56): tokens.color.goldWash yellow-dark tint, no token — design review
  editBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: tokens.color.goldWash, borderWidth: 1, borderColor: GOLD, borderRadius: 10, paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, marginBottom: tokens.spacing.md },
  // FIXME(nex-56): off-scale fontSize 9, design review
  editBannerLabel: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): off-scale fontSize 9, design review
  editBannerCancel: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): off-scale fontSize 11, design review
  historyQ: { color: MUTED, fontSize: 11, fontWeight: '700', marginBottom: 2 /* FIXME(nex-56): off-scale spacing 2 — review */ },
  // FIXME(nex-56): fontSize 13 matches caption size but fontWeight default ≠ token '500'; lineHeight 20 ≠ token 18 — design review
  historyA: { color: TEXT_COLOR, fontSize: 13, lineHeight: 20 },
  periodPickerRow: { backgroundColor: SURFACE, borderRadius: 12, borderWidth: 1, borderColor: BORDER, padding: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  periodPickerRowActive: { borderColor: GOLD },
  // FIXME(nex-56): fontSize 15 (bodyMd) but fontWeight '600' ≠ token '400' — design review
  periodPickerLabel: { color: TEXT_COLOR, fontSize: 15, fontWeight: '600' },
  // FIXME(nex-56): off-scale fontSize 11, design review
  periodPickerMeta: { color: MUTED, fontSize: 11 },

  // Leverage adjustments
  leverageCard: { backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.luminousEdge, padding: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  // FIXME(nex-56): tokens.color.tealWash green tint, no token — design review
  leverageCardApplied: { borderColor: GREEN, backgroundColor: tokens.color.tealWash },
  // FIXME(nex-56): off-scale fontSize 9, design review
  leverageKind: { fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */ },
  // FIXME(nex-56): fontSize 17 matches bodyLg size but fontWeight '700' ≠ token '400' — design review
  leverageTitle: { color: TEXT_COLOR, fontSize: 17, fontWeight: '700', marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */ },
  // FIXME(nex-56): tokens.color.textSecondary off-scale gray — design review
  // FIXME(nex-56): fontSize 13 matches caption size but lineHeight 19 ≠ token 18, fontWeight default ≠ token '500' — design review
  leverageReason: { color: tokens.color.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale fontSize 12, design review
  leverageDelta: { color: MUTED, fontSize: 12, fontWeight: '600', marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  leverageApplyBtn: { backgroundColor: tokens.color.surfaceElevated, borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: tokens.spacing.sm, alignItems: 'center' },
  // FIXME(nex-56): tokens.color.tealWash green tint, no token — design review
  leverageApplyBtnApplied: { backgroundColor: tokens.color.tealWash, borderColor: GREEN },
  // FIXME(nex-56): off-scale fontSize 11, design review
  leverageApplyText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
});
