import { describe, expect, it } from 'vitest';
import {
  ORBIT_ACTION_WIDTH,
  ORBIT_ROW_CHROME,
  orbitSwipeMetrics,
} from '../swipe-card-metrics';

describe('orbitSwipeMetrics', () => {
  it('fills the measured wrapper — the card IS the viewport', () => {
    expect(orbitSwipeMetrics(268).cardWidth).toBe(268);
  });

  // The invariant that the old `- 125` constant was really protecting: the
  // action button must be exactly one ACTION_WIDTH off-screen at rest, so
  // snapToOffsets={[0, ACTION_WIDTH]} lands it flush. If the card ever
  // subtracts the action width, the action sits permanently half-visible.
  it('keeps the action exactly one ACTION_WIDTH beyond the viewport', () => {
    for (const w of [268, 320, 555, 1241]) {
      const m = orbitSwipeMetrics(w);
      expect(m.contentWidth - m.cardWidth).toBe(ORBIT_ACTION_WIDTH);
      expect(m.actionRevealOffset).toBe(ORBIT_ACTION_WIDTH);
    }
  });

  // Regression: the module-scope `Dimensions.get('window').width - 125` read.
  // On a 13" iPad (1366pt window) inside AdaptiveScreen's 680pt content
  // column, the old formula produced a 1241pt card in a ~555pt wrapper.
  it('never exceeds its container on a 13" iPad (the overflow regression)', () => {
    const wrapperInsideContentColumn = 680 - 72 - 25 * 2; // 558
    const m = orbitSwipeMetrics(wrapperInsideContentColumn);

    expect(m.cardWidth).toBe(558);
    expect(m.cardWidth).toBeLessThanOrEqual(wrapperInsideContentColumn);

    const legacy = 1366 - 125;
    expect(legacy).toBeGreaterThan(wrapperInsideContentColumn); // 1241 > 558
  });

  it('tracks the container rather than the window, at any width', () => {
    // Same window, three container widths (phone, split pane, wide column):
    // the card follows the container every time.
    expect(orbitSwipeMetrics(268).cardWidth).toBe(268);
    expect(orbitSwipeMetrics(400).cardWidth).toBe(400);
    expect(orbitSwipeMetrics(770).cardWidth).toBe(770);
  });

  it('reports unmeasured before the first layout pass', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = orbitSwipeMetrics(bad);
      expect(m.measured).toBe(false);
      expect(m.cardWidth).toBe(0);
      expect(m.hasWidth).toBe(false);
    }
    expect(orbitSwipeMetrics(1).measured).toBe(true);
  });

  // First frame: onLayout has not fired, so seed from the window so the card
  // doesn't shrink-wrap to its content for a frame and flash.
  it('seeds the first frame from the window width', () => {
    const m = orbitSwipeMetrics(0, 393);
    expect(m.measured).toBe(false);       // still not a real measurement
    expect(m.hasWidth).toBe(true);        // but renderable
    expect(m.cardWidth).toBe(393 - ORBIT_ROW_CHROME);
    // matches the phone geometry the old hard-coded `- 125` approximated
    expect(Math.abs(m.cardWidth - (393 - 125))).toBeLessThanOrEqual(3);
  });

  it('prefers the measurement over the seed as soon as it arrives', () => {
    // 13" iPad window, but the row lives in a 558pt column: the seed would be
    // 1244pt. The measurement must win the moment it exists.
    expect(orbitSwipeMetrics(0, 1366).cardWidth).toBe(1366 - ORBIT_ROW_CHROME);
    expect(orbitSwipeMetrics(558, 1366).cardWidth).toBe(558);
  });

  it('keeps the peek invariant while seeded', () => {
    const m = orbitSwipeMetrics(0, 393);
    expect(m.contentWidth - m.cardWidth).toBe(ORBIT_ACTION_WIDTH);
  });
});
