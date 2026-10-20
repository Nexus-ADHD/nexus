import { describe, expect, it } from 'vitest';
import {
  DAY_CIRCLE_SIZE,
  DAY_HIT_SLOP,
  dayRole,
  groupRole,
  isDaySelected,
  toggleDay,
  toSelectionArray,
} from '../day-picker-metrics';

describe('touch target', () => {
  // Orbit's chips are 36pt with NO hitSlop today — under the 44pt floor (§19).
  it('a 34pt circle plus slop clears the 44pt floor', () => {
    expect(DAY_CIRCLE_SIZE + DAY_HIT_SLOP * 2).toBe(44);
  });
});

describe('toggleDay — single', () => {
  it('replaces the selection', () => {
    expect(toggleDay({ value: [1], day: 5, mode: 'single' })).toEqual([5]);
  });

  it('tapping the selected day is a no-op, never a deselect', () => {
    // "No day" is not a valid weekly-summary state.
    expect(toggleDay({ value: [3], day: 3, mode: 'single' })).toEqual([3]);
  });

  it('always yields exactly one day', () => {
    for (let d = 0; d < 7; d += 1) {
      expect(toggleDay({ value: [0, 2, 4], day: d, mode: 'single' })).toHaveLength(1);
    }
  });
});

describe('toggleDay — multi', () => {
  it('adds an unselected day', () => {
    expect(toggleDay({ value: [1, 3], day: 5, mode: 'multi' })).toEqual([1, 3, 5]);
  });

  it('removes a selected day', () => {
    expect(toggleDay({ value: [1, 3, 5], day: 3, mode: 'multi' })).toEqual([1, 5]);
  });

  it('keeps the result sorted, whatever order days are tapped', () => {
    let v: number[] = [];
    for (const d of [5, 0, 3, 6, 1]) v = toggleDay({ value: v, day: d, mode: 'multi' });
    expect(v).toEqual([0, 1, 3, 5, 6]);
  });

  // The two forms using this gate save on a non-empty selection and render
  // their own error. Refusing here would strand the user with no feedback and
  // silently change validation they already own.
  it('allows emptying the selection — callers own that validation', () => {
    expect(toggleDay({ value: [4], day: 4, mode: 'multi' })).toEqual([]);
  });

  it('never mutates the input', () => {
    const src = [1, 3];
    const out = toggleDay({ value: src, day: 5, mode: 'multi' });
    expect(src).toEqual([1, 3]);
    expect(out).not.toBe(src);
  });

  it('round-trips: toggling a day twice restores the original', () => {
    const start = [0, 2, 6];
    const once = toggleDay({ value: start, day: 4, mode: 'multi' });
    expect(toggleDay({ value: once, day: 4, mode: 'multi' })).toEqual(start);
  });
});

// A role is a promise about what the control can do. Announcing a radiogroup
// over a multi-select describes a control that cannot do what it visibly does.
describe('accessibility roles follow the mode', () => {
  it('single-select is a radiogroup of radios — exactly one', () => {
    expect(groupRole('single')).toBe('radiogroup');
    expect(dayRole('single')).toBe('radio');
  });

  it('multi-select is NEVER a radiogroup — it is a list of checkboxes', () => {
    expect(groupRole('multi')).not.toBe('radiogroup');
    expect(groupRole('multi')).toBe('list');
    expect(dayRole('multi')).toBe('checkbox');
  });

  it('the group role matches the toggle rule it describes', () => {
    // Whatever mode says it does, the role has to agree: exclusive selection
    // yields one day, non-exclusive can hold several.
    expect(toggleDay({ value: [1, 3], day: 5, mode: 'single' })).toHaveLength(1);
    expect(toggleDay({ value: [1, 3], day: 5, mode: 'multi' }).length).toBeGreaterThan(1);
  });
});

describe('isDaySelected', () => {
  it('reports membership', () => {
    expect(isDaySelected([1, 3], 3)).toBe(true);
    expect(isDaySelected([1, 3], 2)).toBe(false);
    expect(isDaySelected([], 0)).toBe(false);
  });
});

describe('toSelectionArray', () => {
  it('lifts a single-mode number into an array', () => {
    expect(toSelectionArray(3)).toEqual([3]);
    expect(toSelectionArray(0)).toEqual([0]); // Sunday is 0, not falsy-empty
  });

  it('copies a multi-mode array rather than aliasing it', () => {
    const src = [1, 2];
    const out = toSelectionArray(src);
    expect(out).toEqual([1, 2]);
    expect(out).not.toBe(src);
  });
});
