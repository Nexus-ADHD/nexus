import { describe, expect, it } from 'vitest';
import { validateProposedAction, type ProposedAction } from '../recurrence';
import { defaultDaysOfWeek } from '../../features/command/scheduling-default';

// NEX-194 (save-and-surface): the today-only default in command-executor.ts
// was unreachable because validateProposedAction REJECTED a recurring_add with
// empty/missing days before the executor ran. These tests pin the new contract:
// a habit (recurring_add) with empty days now VALIDATES, and the executor then
// defaults it to today-only so it surfaces on Home's Today's Habits the same day.

describe('validateProposedAction — recurring_add empty days (NEX-194)', () => {
  it('ACCEPTS a recurring_add with empty daysOfWeek (defaulted to today by the executor)', () => {
    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Call mom',
      daysOfWeek: [],
      timesPerDay: 1, // satisfies the separate "needs a time/block/frequency" check
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(true);
    expect(result.missingFields).not.toContain('daysOfWeek');
  });

  it('ACCEPTS a recurring_add with missing daysOfWeek', () => {
    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Meditate',
      preferredTimeBlock: 'morning',
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(true);
    expect(result.missingFields).not.toContain('daysOfWeek');
  });

  it('still REJECTS a recurring_todo_add with empty days (out of scope, NEX-197)', () => {
    const action: ProposedAction = {
      type: 'recurring_todo_add',
      title: 'Check in with Sean',
      daysOfWeek: [],
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('daysOfWeek');
  });

  it('still REJECTS a recurring_add missing time / block / frequency', () => {
    // Empty days no longer fails, but a habit with no time, no block, and no
    // timesPerDay is still invalid (the separate frequency check is unchanged).
    // NEX-206 (Or-3) intentionally does NOT relax this: a bare time-less habit
    // is defaulted to timesPerDay:1 by prepareAction (confidence-tier) before
    // execution, so it reaches the executor's time-less branch and gets the
    // one-tap block offer there — the validator gate stays as-is.
    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Vague habit',
      daysOfWeek: [],
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('time');
    expect(result.missingFields).not.toContain('daysOfWeek');
  });

  it('preserves explicit days when present', () => {
    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Yoga',
      daysOfWeek: [1, 3, 5],
      time: '07:00',
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(true);
  });

  it('end-to-end: an accepted empty-days habit executes with today-only days', () => {
    // The validation gate now passes the capture through; the executor then
    // applies the today-only default. Proven together here on pure logic.
    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Call mom',
      daysOfWeek: [],
      timesPerDay: 1,
    };
    expect(validateProposedAction(action).valid).toBe(true);
    expect(defaultDaysOfWeek(action.daysOfWeek, 0)).toEqual([0]);
  });
});
