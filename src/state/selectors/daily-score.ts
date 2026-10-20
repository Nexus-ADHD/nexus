/**
 * Home daily score ("Alignment score") — THE canonical formula.
 *
 * Extracted from home-screen.tsx's `scoreBreakdown` memo (same pattern as
 * today-rollup.ts: one module, one set of predicates, no drift) so the
 * formula has ONE executable source of truth, pinned by vitest fixtures.
 *
 * TWO consumers must stay in lockstep with this file:
 *   - Home's score ring + breakdown modal (home-screen.tsx — calls this)
 *   - The iOS widget's Swift port in deriveTodayView
 *     (native-targets/NexusWidget/NexusWidget.swift — hand-ported; the
 *     fixtures in __tests__/daily-score.test.ts are its spec)
 *
 * KNOWN DIVERGENCE (accepted, 2026-08): the Apple Watch's disciplineScore
 * uses `computeDailyScore` (app-state.ts), whose habit factor is BINARY per
 * rule (a 3x/day habit with 1 rep counts full 33). This selector is
 * REP-WEIGHTED (min(req, count)/required), matching what the user sees on
 * Home. The widget follows Home, not the Watch.
 */

import { normalize } from '../../utils/text';
import { dowFromDateKey, isScheduledOn, selectTodayTaskRollup } from './today-rollup';

export interface HomeDailyScore {
  total: number;
  intentionPts: number;
  habitPts: number;
  taskPts: number;
  habitsCompleted: number;
  habitsRequired: number;
  scoredHabitCount: number;
  tasksCompleted: number;
  tasksTotal: number;
}

/**
 * The Home score: 33 intention + 33 habits + 34 tasks, capped at 100.
 * "Nothing due today" (no scored habits AND no tasks) is not penalized —
 * the task factor falls to the flat-34 branch.
 */
export function computeHomeDailyScore(params: {
  rules: any[]; // recurringRules
  habitLog: any[]; // FULL log (entries with dateKey + habitTitle); filtered here
  recurringToDos: any[];
  dailyTasksForDay: any[]; // dailyTasks[dateKey] ?? []
  intentionSet: boolean; // morningIntentionDate === dateKey && !!morningIntention
  dateKey: string; // YYYY-MM-DD (local)
}): HomeDailyScore {
  const { rules, habitLog, recurringToDos, dailyTasksForDay, intentionSet, dateKey } = params;

  const dow = dowFromDateKey(dateKey);
  const allRules = Array.isArray(rules) ? rules : [];
  const activeRules = allRules.filter((r: any) => !r?.archived);
  const scoredHabits = activeRules.filter(
    (r: any) => isScheduledOn(r, dow) && !r?.excludedFromScore,
  );

  const todayLogEntries = Array.isArray(habitLog)
    ? habitLog.filter((e: any) => e?.dateKey === dateKey)
    : [];

  let habitsRequired = 0;
  let habitsCompleted = 0;
  scoredHabits.forEach((r: any) => {
    const key = normalize(r?.title);
    const req = r?.timesPerDay || 1;
    const count = todayLogEntries.filter(
      (e: any) => normalize(e?.habitTitle) === key,
    ).length;
    habitsRequired += req;
    habitsCompleted += Math.min(req, count);
  });

  const taskRollup = selectTodayTaskRollup(recurringToDos, dailyTasksForDay, dateKey);

  const intentionPts = intentionSet ? 33 : 0;
  const habitPts = habitsRequired > 0 ? Math.round((habitsCompleted / habitsRequired) * 33) : 0;
  const taskPts =
    taskRollup.total > 0
      ? Math.round((taskRollup.completed / taskRollup.total) * 34)
      : scoredHabits.length === 0
        ? 34
        : 0;

  return {
    total: Math.min(100, intentionPts + habitPts + taskPts),
    intentionPts,
    habitPts,
    taskPts,
    habitsCompleted,
    habitsRequired,
    scoredHabitCount: scoredHabits.length,
    tasksCompleted: taskRollup.completed,
    tasksTotal: taskRollup.total,
  };
}

/**
 * §18.4 Alignment score qualitative words (locked — "All in Fraunces Light
 * Italic. No others."). The widget renders the same word in system serif
 * italic (Fraunces isn't available to a WidgetKit extension).
 */
export function scoreQualitativeWord(score: number): string {
  if (score >= 90) return 'Rising';
  if (score >= 75) return 'Steady';
  if (score >= 60) return 'Holding';
  if (score >= 45) return 'Drifting';
  return 'Quiet';
}
