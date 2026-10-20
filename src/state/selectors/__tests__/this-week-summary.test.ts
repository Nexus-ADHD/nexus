import { describe, it, expect } from 'vitest';
import { weeklyAdditiveSummary, parseWeeklyReflectionFocus } from '../this-week-summary';

const range = { startKey: '2026-06-14', endKey: '2026-06-20' }; // a Sun→Sat calendar week

function log(habitTitle: string, dateKey: string) {
  return { habitTitle, dateKey };
}

describe('weeklyAdditiveSummary (NEX-217 — additive, no rates, no verdict)', () => {
  it('counts every completion in range as a rep (a miss subtracts nothing)', () => {
    const rules = [{ title: 'Meditate' }, { title: 'Read' }];
    const habitLog = [
      log('Meditate', '2026-06-14'),
      log('Meditate', '2026-06-15'),
      log('Read', '2026-06-16'),
    ];
    expect(weeklyAdditiveSummary({ habitLog, rules, weeklyWins: [], range })).toEqual({
      reps: 3,
      habitsHeld: 2,
      wins: 0,
    });
  });

  it('excludes logs outside the calendar-week range (the rolling-window trap)', () => {
    const rules = [{ title: 'Meditate' }];
    const habitLog = [
      log('Meditate', '2026-06-11'), // before range (last week)
      log('Meditate', '2026-06-14'), // in range
      log('Meditate', '2026-06-21'), // after range (next week)
    ];
    expect(weeklyAdditiveSummary({ habitLog, rules, weeklyWins: [], range })).toMatchObject({ reps: 1, habitsHeld: 1 });
  });

  it('habitsHeld folds case/space (normalize), the same emoji-sensitive key computeLifetimeReps uses', () => {
    const rules = [{ title: '🧘 Meditate' }];
    const habitLog = [
      log('🧘 Meditate', '2026-06-14'),
      log('🧘  Meditate ', '2026-06-15'), // same habit, different casing/spacing
    ];
    const out = weeklyAdditiveSummary({ habitLog, rules, weeklyWins: [], range });
    expect(out.reps).toBe(2);
    expect(out.habitsHeld).toBe(1);
  });

  it('keeps two habits that differ only by emoji DISTINCT (emoji is part of the identity)', () => {
    const rules = [{ title: '🧘 Meditate' }, { title: '🏃 Meditate' }];
    const habitLog = [log('🧘 Meditate', '2026-06-14'), log('🏃 Meditate', '2026-06-15')];
    expect(weeklyAdditiveSummary({ habitLog, rules, weeklyWins: [], range })).toMatchObject({
      reps: 2,
      habitsHeld: 2,
    });
  });

  it('orphaned logs (no active rule) count as reps but not habitsHeld', () => {
    const rules = [{ title: 'Meditate' }];
    const habitLog = [log('Meditate', '2026-06-14'), log('Deleted Habit', '2026-06-15')];
    expect(weeklyAdditiveSummary({ habitLog, rules, weeklyWins: [], range })).toMatchObject({ reps: 2, habitsHeld: 1 });
  });

  it('archived / excluded rules do not count toward habitsHeld', () => {
    const rules = [
      { title: 'Meditate', archived: true },
      { title: 'Read', excludedFromScore: true },
      { title: 'Walk' },
    ];
    const habitLog = [log('Meditate', '2026-06-14'), log('Read', '2026-06-15'), log('Walk', '2026-06-16')];
    const out = weeklyAdditiveSummary({ habitLog, rules, weeklyWins: [], range });
    expect(out.reps).toBe(3); // every rep still counts
    expect(out.habitsHeld).toBe(1); // only Walk is an active rule
  });

  it('wins counts only non-empty entries', () => {
    expect(
      weeklyAdditiveSummary({ habitLog: [], rules: [], weeklyWins: ['Ship it', '', '  '], range }).wins,
    ).toBe(1);
  });

  it('an all-zero week returns zeros (caller shows a calm forward line, never "0 missed")', () => {
    expect(weeklyAdditiveSummary({ habitLog: [], rules: [{ title: 'Walk' }], weeklyWins: [], range })).toEqual({
      reps: 0,
      habitsHeld: 0,
      wins: 0,
    });
  });

  it('tolerates null/undefined inputs', () => {
    expect(weeklyAdditiveSummary({ habitLog: null, rules: undefined, weeklyWins: null, range })).toEqual({
      reps: 0,
      habitsHeld: 0,
      wins: 0,
    });
  });
});

describe('parseWeeklyReflectionFocus', () => {
  it('extracts the trimmed focus line from valid reflection JSON', () => {
    expect(parseWeeklyReflectionFocus(JSON.stringify({ focus: '  Protect mornings.  ', hard: 'x' }))).toBe(
      'Protect mornings.',
    );
  });

  it('returns empty string for missing focus, non-string, or unparseable input', () => {
    expect(parseWeeklyReflectionFocus(JSON.stringify({ well: 'x' }))).toBe('');
    expect(parseWeeklyReflectionFocus('not json')).toBe('');
    expect(parseWeeklyReflectionFocus(null)).toBe('');
    expect(parseWeeklyReflectionFocus(42)).toBe('');
  });
});
