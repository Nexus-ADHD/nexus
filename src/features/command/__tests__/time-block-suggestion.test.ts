import { describe, expect, it } from 'vitest';
import {
  buildTimeBlockSuggestion,
  timeBlockForHour,
} from '../command-executor';
import type { ProposedAction } from '../command-types';

// NEX-206 (Or-3): the pure decision behind the confirmation ledger's "offer a
// time" affordance. A bare time-less habit that lands on Today gets a suggested
// wide block (the current daypart); anything already anchored, or off Today, or
// not a habit, gets no offer.

describe('timeBlockForHour (NEX-206)', () => {
  it('maps hours to blocks aligned with TIME_BLOCK_DEFAULTS', () => {
    expect(timeBlockForHour(5)).toBe('morning');
    expect(timeBlockForHour(9)).toBe('morning');
    expect(timeBlockForHour(11)).toBe('morning');
    expect(timeBlockForHour(12)).toBe('afternoon');
    expect(timeBlockForHour(13)).toBe('afternoon');
    expect(timeBlockForHour(16)).toBe('afternoon');
    expect(timeBlockForHour(17)).toBe('evening');
    expect(timeBlockForHour(19)).toBe('evening');
    expect(timeBlockForHour(20)).toBe('night');
    expect(timeBlockForHour(23)).toBe('night');
  });

  it('wraps past midnight into night', () => {
    expect(timeBlockForHour(0)).toBe('night');
    expect(timeBlockForHour(4)).toBe('night');
  });
});

describe('buildTimeBlockSuggestion (NEX-206)', () => {
  const at = (hour: number) => new Date(2026, 5, 19, hour, 0, 0);
  const habit = (extra: Partial<ProposedAction> = {}): ProposedAction => ({
    type: 'recurring_add',
    title: 'Meditate',
    ...extra,
  });

  it('offers the current daypart for a bare time-less habit on Today', () => {
    expect(buildTimeBlockSuggestion(habit(), 'home_today', at(13))).toBe('afternoon');
    expect(buildTimeBlockSuggestion(habit(), 'home_today', at(8))).toBe('morning');
    expect(buildTimeBlockSuggestion(habit(), 'home_today', at(21))).toBe('night');
  });

  it('offers even when the habit carries a timesPerDay frequency (still time-less)', () => {
    expect(
      buildTimeBlockSuggestion(habit({ timesPerDay: 2 }), 'home_today', at(13)),
    ).toBe('afternoon');
  });

  it('does NOT offer when the habit already has a clock time', () => {
    expect(buildTimeBlockSuggestion(habit({ time: '07:00' }), 'home_today', at(13))).toBeNull();
  });

  it('does NOT offer when the habit already has a preferredTimeBlock', () => {
    expect(
      buildTimeBlockSuggestion(habit({ preferredTimeBlock: 'morning' }), 'home_today', at(13)),
    ).toBeNull();
  });

  it('does NOT offer off the Today surface', () => {
    expect(buildTimeBlockSuggestion(habit(), 'orbit', at(13))).toBeNull();
    expect(buildTimeBlockSuggestion(habit(), 'inbox', at(13))).toBeNull();
    expect(buildTimeBlockSuggestion(habit(), undefined, at(13))).toBeNull();
  });

  it('does NOT offer for non-habit action types', () => {
    expect(
      buildTimeBlockSuggestion(
        { type: 'todo_add', title: 'Call mom' } as ProposedAction,
        'home_today',
        at(13),
      ),
    ).toBeNull();
  });
});
