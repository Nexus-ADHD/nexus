import { describe, expect, it } from 'vitest';
import {
  isOffGrid,
  pad2,
  spokenTime,
  stepValue,
  to12Hour,
  nextStepperTime,
} from '../stepper-metrics';
import type { StepperTime } from '../stepper-metrics';

describe('stepValue — wraps, never clamps', () => {
  it('steps forward and back within range', () => {
    expect(stepValue({ value: 7, dir: 1, wrap: 24 })).toBe(8);
    expect(stepValue({ value: 7, dir: -1, wrap: 24 })).toBe(6);
  });

  it('wraps the hour 23 -> 0 and 0 -> 23 (what clamping cannot do)', () => {
    expect(stepValue({ value: 23, dir: 1, wrap: 24 })).toBe(0);
    expect(stepValue({ value: 0, dir: -1, wrap: 24 })).toBe(23);
  });

  it('wraps the minute 55 -> 0 and 0 -> 55 at step 5', () => {
    expect(stepValue({ value: 55, dir: 1, step: 5, wrap: 60 })).toBe(0);
    expect(stepValue({ value: 0, dir: -1, step: 5, wrap: 60 })).toBe(55);
  });

  it('never returns a negative (modulo is corrected)', () => {
    for (let v = 0; v < 60; v += 5) {
      expect(stepValue({ value: v, dir: -1, step: 5, wrap: 60 })).toBeGreaterThanOrEqual(0);
    }
  });
});

// The bug this encodes: minutes are contracted 0-59 and arrive from cloud sync
// unnormalized. Blind addition strands an off-grid value FOREVER — from 7 with
// step 5 the cycle is 7,12,...,57,2,7 and NEVER reaches 0, so a user could not
// set an on-the-hour reminder.
describe('stepValue — snaps an off-grid value onto the step grid', () => {
  it('pulls a stray minute onto the grid on the very first press', () => {
    expect(stepValue({ value: 7, dir: 1, step: 5, wrap: 60 })).toBe(10);
    expect(stepValue({ value: 7, dir: -1, step: 5, wrap: 60 })).toBe(5);
  });

  it('an off-grid value can always reach 0', () => {
    // Walk down from a stray value; it must land exactly on 0, not skip it.
    let v = 7;
    const seen: number[] = [];
    for (let i = 0; i < 20 && !seen.includes(v); i += 1) {
      seen.push(v);
      v = stepValue({ value: v, dir: -1, step: 5, wrap: 60 });
    }
    expect(seen).toContain(0);
  });

  it('stays on the grid once snapped', () => {
    let v = stepValue({ value: 23, dir: 1, step: 5, wrap: 60 });
    for (let i = 0; i < 15; i += 1) {
      expect(v % 5).toBe(0);
      v = stepValue({ value: v, dir: 1, step: 5, wrap: 60 });
    }
  });

  it('isOffGrid identifies the values that need snapping', () => {
    expect(isOffGrid(7, 5)).toBe(true);
    expect(isOffGrid(10, 5)).toBe(false);
    expect(isOffGrid(0, 5)).toBe(false);
  });
});

describe('to12Hour — the two boundaries people get wrong', () => {
  it('midnight is 12 AM, not 0 AM', () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, meridiem: 'AM' });
  });

  it('noon is 12 PM, not 0 PM', () => {
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: 'PM' });
  });

  it('crosses 11 AM -> 12 PM -> 1 PM correctly', () => {
    expect(to12Hour(11)).toEqual({ hour12: 11, meridiem: 'AM' });
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: 'PM' });
    expect(to12Hour(13)).toEqual({ hour12: 1, meridiem: 'PM' });
  });

  it('crosses 11 PM -> 12 AM correctly', () => {
    expect(to12Hour(23)).toEqual({ hour12: 11, meridiem: 'PM' });
    expect(to12Hour(stepValue({ value: 23, dir: 1, wrap: 24 }))).toEqual({
      hour12: 12,
      meridiem: 'AM',
    });
  });

  it('every hour maps to a 1-12 display', () => {
    for (let h = 0; h < 24; h += 1) {
      const { hour12 } = to12Hour(h);
      expect(hour12).toBeGreaterThanOrEqual(1);
      expect(hour12).toBeLessThanOrEqual(12);
    }
  });
});

describe('pad2 / spokenTime', () => {
  it('pads minutes to two digits', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(5)).toBe('05');
    expect(pad2(45)).toBe('45');
  });

  // VoiceOver announcing a bare "11" on an adjustable control leaves the user
  // without the one thing that makes a reminder time meaningful.
  it('speaks a time with its meridiem', () => {
    expect(spokenTime(7, 15)).toBe('7:15 AM');
    expect(spokenTime(19, 0)).toBe('7:00 PM');
    expect(spokenTime(0, 5)).toBe('12:05 AM');
    expect(spokenTime(12, 30)).toBe('12:30 PM');
  });
});

describe('stepper — two controls editing one time', () => {
  // #422 P1, reproduced: hour then minute inside one commit dropped the hour.

  it('patches the shown time when nothing is pending', () => {
    expect(nextStepperTime(null, { hour: 8, minute: 0 }, { hour: 9 })).toEqual({ hour: 9, minute: 0 });
    expect(nextStepperTime(null, { hour: 8, minute: 0 }, { minute: 5 })).toEqual({ hour: 8, minute: 5 });
  });

  it('keeps the earlier press when the second lands before a rerender', () => {
    // the exact sequence from the finding: 08:00 -> 09:00 -> 08:05 was the bug
    const afterHour = nextStepperTime(null, { hour: 8, minute: 0 }, { hour: 9 });
    // `shown` is deliberately STALE here — that is what a pre-rerender press sees
    const afterMinute = nextStepperTime(afterHour, { hour: 8, minute: 0 }, { minute: 5 });
    expect(afterMinute).toEqual({ hour: 9, minute: 5 });
    expect(afterMinute.hour).not.toBe(8); // the regression, named
  });

  it('composes any number of presses without a rerender', () => {
    let pending: StepperTime | null = null;
    const stale = { hour: 8, minute: 0 };
    for (const patch of [{ hour: 9 }, { minute: 5 }, { minute: 10 }, { hour: 11 }]) {
      pending = nextStepperTime(pending, stale, patch);
    }
    expect(pending).toEqual({ hour: 11, minute: 10 });
  });
});
