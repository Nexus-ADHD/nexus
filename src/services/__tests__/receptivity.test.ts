import { describe, expect, it } from 'vitest';
import {
  recordOpenHour,
  chooseReceptiveHour,
  OPEN_HISTORY_CAP,
  MIN_SAMPLES,
  WINDOW,
  MARGIN,
} from '../receptivity';

// NEX-212 (N-3): the launch-hour histogram + the conservative receptivity nudge.

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

/** Build a 24-slot histogram with the given {hour: count} entries. */
function hist(entries: Record<number, number>): number[] {
  const a = new Array<number>(24).fill(0);
  for (const [h, n] of Object.entries(entries)) a[Number(h)] = n;
  return a;
}

describe('recordOpenHour (NEX-212)', () => {
  it('increments the right slot and returns a 24-length array', () => {
    const out = recordOpenHour(undefined, 9);
    expect(out).toHaveLength(24);
    expect(out[9]).toBe(1);
    expect(sum(out)).toBe(1);
  });

  it('accumulates across calls', () => {
    let c: number[] = [];
    for (let i = 0; i < 5; i++) c = recordOpenHour(c, 8);
    expect(c[8]).toBe(5);
  });

  it('is a no-op for an out-of-range hour (returns normalized counts)', () => {
    expect(recordOpenHour(undefined, -1)[0]).toBe(0);
    expect(sum(recordOpenHour(undefined, 24))).toBe(0);
    expect(sum(recordOpenHour(undefined, NaN as any))).toBe(0);
  });

  it('normalizes a malformed input (NaN / null / string slots, wrong length)', () => {
    const messy = [NaN, null, 'x', -4, 3.9, undefined] as any;
    const out = recordOpenHour(messy, 0);
    expect(out).toHaveLength(24);
    // 3.9 at index 4 floors to 3; negatives/NaN/null -> 0; index 0 incremented.
    expect(out[4]).toBe(3);
    expect(out[0]).toBe(1);
    expect(out.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
  });

  it('halves only when total exceeds the cap, and post-halve total stays well below it', () => {
    // Just under the cap: no halving, normal increment.
    const justUnder = hist({ 8: OPEN_HISTORY_CAP - 1 });
    const a = recordOpenHour(justUnder, 8);
    expect(a[8]).toBe(OPEN_HISTORY_CAP); // incremented, not halved

    // Over the cap: halve fires before the increment.
    const over = hist({ 8: OPEN_HISTORY_CAP + 10 });
    const b = recordOpenHour(over, 8);
    expect(b[8]).toBe(Math.floor((OPEN_HISTORY_CAP + 10) / 2) + 1);
    expect(sum(b)).toBeLessThan(OPEN_HISTORY_CAP); // can't oscillate
  });
});

describe('chooseReceptiveHour (NEX-212)', () => {
  it('returns the configured hour when forced (Smart timing off)', () => {
    const c = hist({ 10: 100 }); // strong peak that WOULD nudge
    expect(chooseReceptiveHour(8, c, { forced: true })).toBe(8);
  });

  it('returns the configured hour below MIN_SAMPLES (not enough signal)', () => {
    const c = hist({ 9: MIN_SAMPLES - 1 });
    expect(chooseReceptiveHour(8, c)).toBe(8);
  });

  it('nudges to a clear in-window peak once there is enough signal', () => {
    const c = hist({ 8: 2, 9: 2 + MARGIN + MIN_SAMPLES });
    expect(chooseReceptiveHour(8, c)).toBe(9);
  });

  it('never wraps across midnight — a peak outside the window is ignored', () => {
    // Configured 8am, dense activity at 22:00 (outside ±WINDOW) -> stays 8.
    const c = hist({ 22: 100, 8: 1 });
    expect(chooseReceptiveHour(8, c)).toBe(8);
  });

  it('clamps the window at the day boundaries without wrapping', () => {
    // configuredHour=1, W=2 -> floor 0, never negative; peak at 23 ignored.
    const early = hist({ 0: MIN_SAMPLES + MARGIN, 23: 100 });
    expect(chooseReceptiveHour(1, early)).toBe(0);
    // configuredHour=23 -> ceil 23, never 24/0; peak at 0 ignored.
    const late = hist({ 22: MIN_SAMPLES + MARGIN, 0: 100, 23: 1 });
    expect(chooseReceptiveHour(23, late)).toBe(22);
  });

  it('does not move on an insufficient lead (margin not met)', () => {
    // Winner beats configured by MARGIN-1 -> stays.
    const thin = hist({ 8: MIN_SAMPLES, 9: MIN_SAMPLES + MARGIN - 1 });
    expect(chooseReceptiveHour(8, thin)).toBe(8);
  });

  it('does not move when a candidate only ties the configured hour', () => {
    // c[9] equals the configured hour's own count -> configured wins (never
    // moves off the configured hour without a strict MARGIN lead).
    const tie = hist({ 8: MIN_SAMPLES, 9: MIN_SAMPLES });
    expect(chooseReceptiveHour(8, tie)).toBe(8);
  });

  it('returns the configured hour for malformed counts', () => {
    expect(chooseReceptiveHour(8, null)).toBe(8);
    expect(chooseReceptiveHour(8, [NaN, 'x', null] as any)).toBe(8);
    expect(chooseReceptiveHour(8, undefined)).toBe(8);
  });

  it('clamps an out-of-range configured hour', () => {
    expect(chooseReceptiveHour(99, [])).toBe(23);
    expect(chooseReceptiveHour(-5, [])).toBe(0);
  });
});
