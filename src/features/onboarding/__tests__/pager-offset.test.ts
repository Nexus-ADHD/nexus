import { describe, expect, it } from 'vitest';
import { pageIndexForOffset, pagerOffsetFor } from '../pager-offset';

describe('pagerOffsetFor', () => {
  it('anchors each page flush to the viewport', () => {
    expect(pagerOffsetFor(0, 393)).toBe(0);
    expect(pagerOffsetFor(2, 393)).toBe(786);
  });

  it('returns 0 before the first layout pass', () => {
    for (const w of [0, -1, Number.NaN]) expect(pagerOffsetFor(3, w)).toBe(0);
  });
});

describe('pageIndexForOffset', () => {
  it('resolves the resting page', () => {
    expect(pageIndexForOffset(0, 393)).toBe(0);
    expect(pageIndexForOffset(786, 393)).toBe(2);
  });

  // The rotation bug this module exists for: the pager is on page 2 of a
  // 393pt-wide phone (offset 786). Rotating to a 1024pt iPad column resizes
  // the pages but leaves contentOffset at 786 — which is 0.77 of a page,
  // so it rounds to page 1. The dots say 1, the content shows a sliver of 0
  // and a sliver of 1. Re-anchoring to pagerOffsetFor(2, 1024) fixes it.
  it('mis-pages when the width changes without re-anchoring', () => {
    const staleOffset = pagerOffsetFor(2, 393); // 786
    expect(pageIndexForOffset(staleOffset, 1024)).toBe(1); // wrong page

    const reanchored = pagerOffsetFor(2, 1024);
    expect(pageIndexForOffset(reanchored, 1024)).toBe(2); // correct again
  });

  it('never returns a negative or NaN index', () => {
    expect(pageIndexForOffset(-40, 393)).toBe(0);
    expect(pageIndexForOffset(100, 0)).toBe(0);
    expect(pageIndexForOffset(Number.NaN, 393)).toBe(0);
    expect(Number.isNaN(pageIndexForOffset(10, Number.NaN))).toBe(false);
  });

  it('clamps to the last page when a page count is given', () => {
    expect(pageIndexForOffset(9999, 393, 3)).toBe(2);
  });
});

describe('resize re-anchor rules', () => {
  const PAGES = 4;

  // Idle resize: the settled offset is still trustworthy, but it was captured
  // at the OLD width. Resolving it against the NEW width picks the wrong page,
  // which is why the anchor resolves against the width it was measured at.
  it('resolves the settled offset against the width it was captured at', () => {
    const settledAtOldWidth = pagerOffsetFor(2, 393); // 786

    // wrong: interpreting an old-width offset with the new width
    expect(pageIndexForOffset(settledAtOldWidth, 1024, PAGES)).toBe(1);
    // right: interpret with the width it came from, THEN snap at the new one
    const page = pageIndexForOffset(settledAtOldWidth, 393, PAGES);
    expect(page).toBe(2);
    expect(pagerOffsetFor(page, 1024)).toBe(2048);
  });

  // Resize mid-drag: `currentPage` still holds the PREVIOUS settled page,
  // because it only advances on momentum end. Anchoring to it would fight the
  // swipe. Anchoring to the real offset once the gesture settles does not.
  it('does not send an in-flight swipe back to the previously settled page', () => {
    const previouslySettledPage = 1;
    // user has swiped on to page 2; the native offset says so, state does not
    const liveOffsetAfterSettle = pagerOffsetFor(2, 1024);

    const fromStaleState = pagerOffsetFor(previouslySettledPage, 1024);
    const fromLiveOffset = pagerOffsetFor(
      pageIndexForOffset(liveOffsetAfterSettle, 1024, PAGES),
      1024
    );

    expect(fromStaleState).toBe(1024);   // the regression: yanked back a page
    expect(fromLiveOffset).toBe(2048);   // the fix: stays where the user put it
    expect(fromLiveOffset).not.toBe(fromStaleState);
  });
});
