import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, isLongPress } from '../habit-row-press';

// The HabitRow "every-other-tap opened the menu" fix: the tap-vs-long-press
// decision is a pure function of the hold duration, so a quick tap can never
// be misclassified as a long-press by timer ordering.

describe('isLongPress', () => {
  it('treats a hold at or beyond the threshold as a long-press', () => {
    expect(isLongPress(LONG_PRESS_MS)).toBe(true);
    expect(isLongPress(LONG_PRESS_MS + 1)).toBe(true);
    expect(isLongPress(5000)).toBe(true);
  });

  it('treats a quick tap below the threshold as a tap (not a long-press)', () => {
    expect(isLongPress(0)).toBe(false);
    expect(isLongPress(120)).toBe(false);
    expect(isLongPress(LONG_PRESS_MS - 1)).toBe(false);
  });

  it('never treats an unmeasured / bogus elapsed as a long-press (a tap always completes)', () => {
    expect(isLongPress(-1)).toBe(false);
    expect(isLongPress(NaN)).toBe(false);
    expect(isLongPress(Infinity)).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(isLongPress(300, 250)).toBe(true);
    expect(isLongPress(200, 250)).toBe(false);
  });
});
