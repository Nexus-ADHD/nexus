import { describe, expect, it } from 'vitest';
import { FROZEN_TIME_MS, tickerActive } from '../starfield-motion';

describe('starfield-motion', () => {
  it('FROZEN_TIME_MS is a positive static frame', () => {
    expect(FROZEN_TIME_MS).toBeGreaterThan(0);
  });

  it('runs the ticker only when the pref has resolved and reduce-motion is off', () => {
    expect(tickerActive(false, true)).toBe(true);
  });

  it('stays frozen until the async pref resolves (no first-frame twinkle)', () => {
    expect(tickerActive(false, false)).toBe(false);
  });

  it('stays frozen whenever reduce-motion is on, resolved or not', () => {
    expect(tickerActive(true, true)).toBe(false);
    expect(tickerActive(true, false)).toBe(false);
  });
});
