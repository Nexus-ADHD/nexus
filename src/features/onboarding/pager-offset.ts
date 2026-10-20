/**
 * Pure pager arithmetic for the onboarding review carousel, split out so
 * vitest (node env) covers it — review-screen.tsx imports react-native.
 *
 * WHY THIS EXISTS (iPad, 2026-08-27). The pager sizes its pages to a MEASURED
 * width and re-measures on rotation. That half was already fixed. What was
 * missing: when the width changes, the ScrollView's contentOffset is still the
 * OLD pixel offset, which is no longer a multiple of the new page width. The
 * pager then rests visually between two pages, and pageIndexForOffset rounds
 * to the wrong index — so the dots and the page disagree after every rotation.
 *
 * The caller must re-anchor to `pagerOffsetFor(currentPage, newWidth)` whenever
 * the width changes.
 */

/** Scroll offset that puts `page` flush in the viewport. */
export function pagerOffsetFor(page: number, width: number): number {
  if (!Number.isFinite(page) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.round(page)) * width;
}

/**
 * Page index resting at scroll offset `x`. Guards width <= 0 (pre-layout),
 * where the naive `x / width` is Infinity or NaN and Math.round propagates it
 * straight into setState.
 */
export function pageIndexForOffset(x: number, width: number, pageCount?: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  const idx = Math.round(x / width);
  const clampedLow = Math.max(0, idx);
  if (typeof pageCount === 'number' && pageCount > 0) {
    return Math.min(clampedLow, pageCount - 1);
  }
  return clampedLow;
}
