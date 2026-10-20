import { describe, it, expect } from 'vitest';
import { computeHomeDailyScore, scoreQualitativeWord } from '../daily-score';

// ───────────────────────────────────────────────────────────────────────
// Executable spec for the Home daily score. The iOS widget's Swift port
// (native-targets/NexusWidget/NexusWidget.swift deriveTodayView) must
// reproduce these numbers from the same raw inputs — if you change a
// fixture here, change the Swift side too.
//
// 2026-08-06 is a Thursday (dow 4); the Sunday of its week is 2026-08-02.
// ───────────────────────────────────────────────────────────────────────

const DOW_ALL = [0, 1, 2, 3, 4, 5, 6];
const DAY = '2026-08-06';

function habit(id: string, title: string, extra: object = {}) {
  return { id, title, timesPerDay: 1, daysOfWeek: DOW_ALL, archived: false, ...extra };
}

function base(over: object = {}) {
  return {
    rules: [],
    habitLog: [],
    recurringToDos: [],
    dailyTasksForDay: [],
    intentionSet: false,
    dateKey: DAY,
    ...over,
  };
}

describe('computeHomeDailyScore', () => {
  it('intention only = 33 (habits/tasks fall to the nothing-due branch)', () => {
    const out = computeHomeDailyScore(base({ intentionSet: true }));
    expect(out.intentionPts).toBe(33);
    expect(out.taskPts).toBe(34); // no scored habits + no tasks = not penalized
    expect(out.total).toBe(67);
  });

  it('rep-weighting: a 3x/day habit with 1 rep earns 11, not 33 (Home ≠ Watch)', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run', { timesPerDay: 3 })],
        habitLog: [{ dateKey: DAY, habitTitle: 'Run' }],
      }),
    );
    expect(out.habitPts).toBe(11); // round(1/3 * 33)
    expect(out.habitsCompleted).toBe(1);
    expect(out.habitsRequired).toBe(3);
  });

  it('perfect day caps at 100', () => {
    const out = computeHomeDailyScore(
      base({
        intentionSet: true,
        rules: [habit('h1', 'Run')],
        habitLog: [{ dateKey: DAY, habitTitle: 'run ' }], // normalize() match
        dailyTasksForDay: [{ id: 'one', title: 'Call mom', completed: true }],
      }),
    );
    expect(out.total).toBe(100);
    expect(out.habitPts).toBe(33);
    expect(out.taskPts).toBe(34);
  });

  it('habit title matching is normalize()-based (case/whitespace-insensitive)', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Morning  Meditation')],
        habitLog: [{ dateKey: DAY, habitTitle: '  morning meditation' }],
      }),
    );
    expect(out.habitPts).toBe(33);
  });

  it('log entries from other days do not count', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run')],
        habitLog: [{ dateKey: '2026-08-05', habitTitle: 'Run' }],
      }),
    );
    expect(out.habitPts).toBe(0);
    expect(out.total).toBe(0);
  });

  it('excludedFromScore drops a habit from the denominator entirely', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run', { excludedFromScore: true })],
      }),
    );
    expect(out.scoredHabitCount).toBe(0);
    // No scored habits + no tasks → the flat-34 "nothing due" branch.
    expect(out.taskPts).toBe(34);
    expect(out.total).toBe(34);
  });

  it('a habit not scheduled today is out of the denominator', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run', { daysOfWeek: [0] })], // Sundays only
      }),
    );
    expect(out.scoredHabitCount).toBe(0);
    expect(out.habitPts).toBe(0);
  });

  it('recurring to-do checked via the ${id}-auto override counts completed', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run')], // keep the flat-34 branch out of play
        recurringToDos: [{ id: 't1', title: 'Breakfast', daysOfWeek: DOW_ALL, interval: 1 }],
        dailyTasksForDay: [{ id: 't1-auto', title: 'Breakfast', completed: true }],
      }),
    );
    expect(out.tasksTotal).toBe(1);
    expect(out.tasksCompleted).toBe(1);
    expect(out.taskPts).toBe(34);
  });

  it('recurring to-do not yet materialized counts as incomplete', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run')],
        recurringToDos: [{ id: 't1', title: 'Breakfast', daysOfWeek: DOW_ALL, interval: 1 }],
      }),
    );
    expect(out.tasksTotal).toBe(1);
    expect(out.tasksCompleted).toBe(0);
    expect(out.taskPts).toBe(0);
  });

  it('biweekly recurring to-do fires only on its interval week', () => {
    const todo = {
      id: 't1',
      title: 'Meal prep',
      daysOfWeek: DOW_ALL,
      interval: 2,
      intervalAnchorDate: '2026-08-02T12:00:00', // Sunday of DAY's week
    };
    const onWeek = computeHomeDailyScore(base({ recurringToDos: [todo] }));
    expect(onWeek.tasksTotal).toBe(1);
    const offWeek = computeHomeDailyScore(
      base({ recurringToDos: [todo], dateKey: '2026-08-13' }),
    );
    expect(offWeek.tasksTotal).toBe(0);
    const nextOnWeek = computeHomeDailyScore(
      base({ recurringToDos: [todo], dateKey: '2026-08-20' }),
    );
    expect(nextOnWeek.tasksTotal).toBe(1);
  });

  it('half-done habits + half-done tasks land mid-scale', () => {
    const out = computeHomeDailyScore(
      base({
        rules: [habit('h1', 'Run'), habit('h2', 'Read')],
        habitLog: [{ dateKey: DAY, habitTitle: 'Run' }],
        dailyTasksForDay: [
          { id: 'a', title: 'A', completed: true },
          { id: 'b', title: 'B', completed: false },
        ],
      }),
    );
    expect(out.habitPts).toBe(17); // round(1/2 * 33)
    expect(out.taskPts).toBe(17); // round(1/2 * 34)
    expect(out.total).toBe(34);
  });
});

describe('scoreQualitativeWord (§18.4 locked bands)', () => {
  it('band edges', () => {
    expect(scoreQualitativeWord(100)).toBe('Rising');
    expect(scoreQualitativeWord(90)).toBe('Rising');
    expect(scoreQualitativeWord(89)).toBe('Steady');
    expect(scoreQualitativeWord(75)).toBe('Steady');
    expect(scoreQualitativeWord(74)).toBe('Holding');
    expect(scoreQualitativeWord(60)).toBe('Holding');
    expect(scoreQualitativeWord(59)).toBe('Drifting');
    expect(scoreQualitativeWord(45)).toBe('Drifting');
    expect(scoreQualitativeWord(44)).toBe('Quiet');
    expect(scoreQualitativeWord(0)).toBe('Quiet');
  });
});
