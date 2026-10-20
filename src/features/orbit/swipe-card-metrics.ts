/**
 * Pure geometry for the Orbit timeline's swipe-to-action row, split out so
 * vitest (node env) covers it — orbit.tsx is @ts-nocheck, imports react-native
 * and can't load under the node runner. Import-free on purpose, mirroring
 * pill-metrics.ts / list-row-metrics.ts.
 *
 * WHY THIS EXISTS (iPad, 2026-08-27). The card width used to be
 * `Dimensions.get('window').width - 125`, read at MODULE SCOPE. Two bugs:
 *
 *  1. Frozen at import — it never updated on rotation or resize.
 *  2. It is a WINDOW width, but the row renders inside AdaptiveScreen's
 *     centred content column. On a 13" iPad that
 *     computed 1366 - 125 = 1241pt of card inside a ~1100pt column, so the card
 *     overflowed its container. That was broken on iPad before any rotation.
 *
 * The row's layout is:
 *
 *   [ timeColumn 72pt ][ flex:1 → swipeWrapper → horizontal ScrollView ]
 *                                                 ├─ card      (this width)
 *                                                 └─ actionBtn (ACTION_WIDTH)
 *
 * The card fills the ScrollView's VIEWPORT (== the measured wrapper width) and
 * the action button sits BEYOND it in the scroll content, off-screen at rest
 * and revealed by scrolling ACTION_WIDTH. So the action width is NOT carved
 * out of the card — subtracting it would leave the action permanently
 * half-visible and break `snapToOffsets={[0, ACTION_WIDTH]}`.
 *
 * The old `- 125` was an eyeballed approximation of that wrapper width from
 * the screen width: timeColumn 72 + the list's paddingHorizontal 25 x 2 = 122.
 * Measuring the wrapper makes the constant unnecessary and correct at any
 * container width — including a narrowed one, which is why this function takes
 * the MEASURED width only and must never reference CONTENT_MAX_WIDTH. (If it
 * did, it would silently re-break the day a wider expanded column lands.)
 */

/** Width of the revealed action button. Mirrors styles.actionBtn.width. */
export const ORBIT_ACTION_WIDTH = 80;

/**
 * Chrome between the window edge and the swipe wrapper on a phone:
 * timeColumn (72) + the day list's paddingHorizontal (25 x 2). Used ONLY to
 * seed the first frame from the window width, before onLayout has measured
 * the real wrapper. It is an estimate, not the layout — never use it as the
 * card width past the first frame, which is the bug this module replaced.
 */
export const ORBIT_ROW_CHROME = 122;

export type OrbitSwipeMetrics = {
  /** Width of the card itself — the ScrollView's viewport. */
  cardWidth: number;
  /** Total scrollable content width: card + action. */
  contentWidth: number;
  /** Scroll offset that fully reveals the action. Feeds snapToOffsets. */
  actionRevealOffset: number;
  /** True only once onLayout has reported a real wrapper width. */
  measured: boolean;
  /** True when there is any usable width — measured OR first-frame seed. */
  hasWidth: boolean;
};

/**
 * `wrapperWidth` is the onLayout-measured width of the swipe wrapper. Before
 * the first layout pass it is 0 (or NaN from a malformed event), and we report
 * measured:false so the caller can omit an explicit width and let the card lay
 * out naturally for one frame rather than flashing at 0pt.
 */
export function orbitSwipeMetrics(
  wrapperWidth: number,
  /**
   * Window width, used only to estimate the first frame. Without it the card
   * renders with no width for one frame and shrink-wraps to its content, which
   * reads as a visible flash on every row. The wrapper clips (overflow:
   * 'hidden'), so an over-estimate is invisible rather than an overflow.
   */
  windowWidth?: number
): OrbitSwipeMetrics {
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;

  const measured = ok(wrapperWidth);
  const seeded = !measured && ok(windowWidth)
    ? Math.max(0, windowWidth - ORBIT_ROW_CHROME)
    : 0;
  const cardWidth = measured ? wrapperWidth : seeded;

  return {
    cardWidth,
    contentWidth: cardWidth + ORBIT_ACTION_WIDTH,
    actionRevealOffset: ORBIT_ACTION_WIDTH,
    measured,
    /** True once there is any width to render — measured OR seeded. */
    hasWidth: cardWidth > 0,
  };
}
