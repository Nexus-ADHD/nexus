import { describe, expect, it } from 'vitest';
import {
  selectTodaysHabits,
  selectTodaysCompletionCounts,
  isHabitCompleteToday,
  habitCompletionKey,
  TODAYS_HABITS_CAP,
} from '../todays-habits';

// NEX-199: cap the Today's Habits list, but only ever hide COMPLETED rows.
// Natural order preserved (no completion sort); stickiness = hold position.

type Rule = { id: string; done?: boolean };
const isComplete = (r: Rule) => r.done === true;
const rules = (...specs: Array<[string, boolean]>): Rule[] =>
  specs.map(([id, done]) => ({ id, done }));

describe('selectTodaysHabits (NEX-199)', () => {
  it('shows everything when at or below the cap', () => {
    const r = rules(['a', false], ['b', true], ['c', false]);
    const { visible, hiddenCount } = selectTodaysHabits(r, { isComplete });
    expect(visible.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(hiddenCount).toBe(0);
  });

  it('caps at 5 and hides only completed overflow (3 incomplete + 4 done)', () => {
    const r = rules(
      ['i1', false], ['d1', true], ['i2', false], ['d2', true],
      ['i3', false], ['d3', true], ['d4', true],
    );
    const { visible, hiddenCount } = selectTodaysHabits(r, { isComplete });
    // all 3 incomplete + the first 2 completed fill the cap of 5; 2 done hidden
    expect(visible.map((x) => x.id)).toEqual(['i1', 'd1', 'i2', 'd2', 'i3']);
    expect(hiddenCount).toBe(2);
    // everything hidden is completed
    const hiddenIds = r.filter((x) => !visible.includes(x)).map((x) => x.id);
    expect(hiddenIds.every((id) => r.find((x) => x.id === id)!.done)).toBe(true);
  });

  it('never hides a live row — 8 incomplete all show, none hidden', () => {
    const r = rules(...Array.from({ length: 8 }, (_, i): [string, boolean] => [`i${i}`, false]));
    const { visible, hiddenCount } = selectTodaysHabits(r, { isComplete });
    expect(visible).toHaveLength(8);
    expect(hiddenCount).toBe(0);
  });

  it('keeps a completed row visible when it is sticky (hold position, no vanish)', () => {
    // 6 live + the just-completed "x" which is sticky → x must stay visible
    // even though the 6 live rows already exceed the cap.
    const r = rules(
      ['i1', false], ['i2', false], ['i3', false],
      ['x', true], // completed this session, but sticky
      ['i4', false], ['i5', false], ['i6', false],
    );
    const sticky = new Set(['x']);
    const { visible, hiddenCount } = selectTodaysHabits(r, { isComplete, sticky });
    expect(visible.map((v) => v.id)).toContain('x');
    expect(hiddenCount).toBe(0);
  });

  it('without stickiness, completed overflow past the cap collapses', () => {
    const r = rules(
      ['i1', false], ['i2', false], ['i3', false], ['i4', false], ['i5', false],
      ['x', true],
    );
    const { visible, hiddenCount } = selectTodaysHabits(r, { isComplete });
    expect(visible.map((v) => v.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(hiddenCount).toBe(1);
    // but with x sticky it stays
    const stuck = selectTodaysHabits(r, { isComplete, sticky: new Set(['x']) });
    expect(stuck.visible.map((v) => v.id)).toContain('x');
    expect(stuck.hiddenCount).toBe(0);
  });

  it('preserves natural order within the visible set', () => {
    const r = rules(['z', false], ['a', true], ['m', false]);
    const { visible } = selectTodaysHabits(r, { isComplete });
    expect(visible.map((v) => v.id)).toEqual(['z', 'a', 'm']);
  });

  it('honors a custom cap', () => {
    const r = rules(['d1', true], ['d2', true], ['d3', true]);
    const { visible, hiddenCount } = selectTodaysHabits(r, { isComplete, cap: 2 });
    expect(visible.map((v) => v.id)).toEqual(['d1', 'd2']);
    expect(hiddenCount).toBe(1);
  });

  it('returns empty for empty / non-array input', () => {
    expect(selectTodaysHabits([], { isComplete })).toEqual({ visible: [], hiddenCount: 0 });
    expect(selectTodaysHabits(null, { isComplete })).toEqual({ visible: [], hiddenCount: 0 });
    expect(selectTodaysHabits(undefined, { isComplete })).toEqual({ visible: [], hiddenCount: 0 });
  });

  it('exposes the default cap of 5', () => {
    expect(TODAYS_HABITS_CAP).toBe(5);
  });
});

// NEX-199 / Greptile #214 — the completion key is emoji-SENSITIVE normalize(title),
// the same convention as the write path (logHabit stores normalize(rawTitle)) and
// the score (scoreBreakdown). An earlier revision stripped emoji here, which made
// "Run" and "Run 🏃" share a `run` key (logging one marked both done) and disagreed
// with the score. These tests pin the convention so it can't silently regress.
describe('selectTodaysCompletionCounts / isHabitCompleteToday (NEX-199, Greptile #214)', () => {
  const log = (habitTitle: string) => ({ habitTitle });

  it('counts logs by emoji-sensitive normalize(title)', () => {
    const counts = selectTodaysCompletionCounts([log('Meditate'), log('meditate'), log('Read')]);
    // "Meditate" and "meditate" fold together (case/whitespace), "Read" is separate
    expect(counts).toEqual({ meditate: 2, read: 1 });
  });

  it('keeps "Run" and "Run 🏃" as DISTINCT keys (no emoji collision)', () => {
    const counts = selectTodaysCompletionCounts([log('Run'), log('Run 🏃'), log('Run 🏃')]);
    expect(counts[habitCompletionKey('Run')]).toBe(1);
    expect(counts[habitCompletionKey('Run 🏃')]).toBe(2);
    expect(habitCompletionKey('Run')).not.toBe(habitCompletionKey('Run 🏃'));
  });

  it('logging "Run 🏃" does NOT complete the separate "Run" habit', () => {
    const counts = selectTodaysCompletionCounts([log('Run 🏃')]);
    expect(isHabitCompleteToday({ title: 'Run' }, counts)).toBe(false);
    expect(isHabitCompleteToday({ title: 'Run 🏃' }, counts)).toBe(true);
  });

  it('respects timesPerDay (needs all reps to read complete)', () => {
    const counts = selectTodaysCompletionCounts([log('Pushups')]);
    expect(isHabitCompleteToday({ title: 'Pushups', timesPerDay: 2 }, counts)).toBe(false);
    const counts2 = selectTodaysCompletionCounts([log('Pushups'), log('Pushups')]);
    expect(isHabitCompleteToday({ title: 'Pushups', timesPerDay: 2 }, counts2)).toBe(true);
  });

  it('a legacy emoji-less log is uncounted for a since-emojified rule — consistent with the score', () => {
    // Accepted, app-wide behavior: scoreBreakdown keys the same way, so the row and
    // the score ring agree. This is the deliberate trade for collision-safety above.
    const counts = selectTodaysCompletionCounts([log('meditate')]);
    expect(isHabitCompleteToday({ title: 'Meditate 🧘' }, counts)).toBe(false);
  });

  it('is null/undefined safe', () => {
    expect(selectTodaysCompletionCounts(null)).toEqual({});
    expect(selectTodaysCompletionCounts(undefined)).toEqual({});
    expect(selectTodaysCompletionCounts([{ habitTitle: null }, {}])).toEqual({});
    expect(isHabitCompleteToday(null, {})).toBe(false);
  });
});
