// Pure-logic tests for the adaptive-layout breakpoints. The module also
// exports the useBreakpoints() hook, so 'react-native' is mocked before
// import (the vitest environment is node-only by design — see vitest.config.ts).
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
}));

import {
  breakpointsForWidth,
  CONTENT_GUTTER,
  CONTENT_MAX_WIDTH,
  WIDE_BREAKPOINT,
} from '../layout';

describe('breakpointsForWidth', () => {
  it('treats a phone-width viewport as compact with no column constraint', () => {
    expect(breakpointsForWidth(393)).toEqual({ isWide: false, contentMaxWidth: 393 });
  });

  it('is compact just below the breakpoint', () => {
    const bp = breakpointsForWidth(WIDE_BREAKPOINT - 1);
    expect(bp.isWide).toBe(false);
    expect(bp.contentMaxWidth).toBe(WIDE_BREAKPOINT - 1);
  });

  it('flips to wide at exactly the breakpoint (iPad mini portrait)', () => {
    const bp = breakpointsForWidth(WIDE_BREAKPOINT);
    expect(bp.isWide).toBe(true);
    expect(bp.contentMaxWidth).toBe(WIDE_BREAKPOINT);
  });

  // Growing the viewport must never shrink the content. Applying both gutters
  // the instant we crossed the breakpoint pulled the column INWARD by 63pt as
  // the window grew by 1pt — visible as a jump while resizing.
  it('does not contract as the viewport crosses the breakpoint', () => {
    const below = breakpointsForWidth(WIDE_BREAKPOINT - 1).contentMaxWidth;
    const at = breakpointsForWidth(WIDE_BREAKPOINT).contentMaxWidth;
    expect(at).toBeGreaterThanOrEqual(below);
  });

  it('is monotonic: the column never shrinks as the canvas grows', () => {
    let prev = 0;
    for (let w = 320; w <= 1600; w += 1) {
      const { contentMaxWidth } = breakpointsForWidth(w);
      expect(contentMaxWidth).toBeGreaterThanOrEqual(prev);
      prev = contentMaxWidth;
    }
  });

  // THE COMPLAINT. The column used to be pinned at a flat 680pt — the phone
  // measure — so a 1024pt iPad filled two thirds of its screen and left ~170pt
  // dead on each side. "The background is wide, but everything else looks like
  // it's on an iPhone."
  it('fills a 1024pt iPad portrait instead of sitting at phone width', () => {
    const bp = breakpointsForWidth(1024);
    expect(bp.contentMaxWidth).toBe(960);
    expect(bp.contentMaxWidth).toBeGreaterThan(680);           // the old flat cap
    expect(bp.contentMaxWidth / 1024).toBeGreaterThan(0.9);    // and it now fills
  });

  it('still caps on a very wide canvas so a single column is not stretched thin', () => {
    const bp = breakpointsForWidth(1366);
    expect(bp.isWide).toBe(true);
    expect(bp.contentMaxWidth).toBe(CONTENT_MAX_WIDTH);
  });

  // The invariants, stated independently of the arithmetic.
  it('never exceeds the viewport or the ceiling, at any width', () => {
    for (let w = 320; w <= 2000; w += 7) {
      const { contentMaxWidth } = breakpointsForWidth(w);
      expect(contentMaxWidth).toBeLessThanOrEqual(w);
      expect(contentMaxWidth).toBeLessThanOrEqual(CONTENT_MAX_WIDTH);
    }
  });

  // The full gutter applies once the canvas can afford it. Below that the
  // continuity floor wins — deliberately, and unreachably: with Split View off
  // the lowest wide width any device produces is 834.
  it('leaves the full gutter once the canvas can afford it', () => {
    for (const w of [834, 1024, 1133, 1194, 1366, 2000]) {
      const { contentMaxWidth } = breakpointsForWidth(w);
      expect(contentMaxWidth).toBeLessThanOrEqual(w - CONTENT_GUTTER * 2);
    }
  });

  // Every width a real device can actually present, since requireFullScreen
  // rules out Split View / Stage Manager sizes.
  it('gives every real iPad size a wide column, and phones none', () => {
    expect(breakpointsForWidth(744).isWide).toBe(false);   // iPad mini portrait
    expect(breakpointsForWidth(834).contentMaxWidth).toBe(770);
    expect(breakpointsForWidth(1024).contentMaxWidth).toBe(960);
    expect(breakpointsForWidth(1133).contentMaxWidth).toBe(1069);
    expect(breakpointsForWidth(1194).contentMaxWidth).toBe(1100);
    expect(breakpointsForWidth(1366).contentMaxWidth).toBe(1100);
    expect(breakpointsForWidth(393).isWide).toBe(false);   // iPhone
  });

  it('grows with the canvas rather than staying fixed', () => {
    const a = breakpointsForWidth(834).contentMaxWidth;
    const b = breakpointsForWidth(1024).contentMaxWidth;
    expect(b).toBeGreaterThan(a);
  });
});
