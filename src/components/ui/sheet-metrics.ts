/**
 * Pure Sheet geometry and surface selection, split out so vitest (node env)
 * covers it — Sheet.tsx imports react-native and cannot load under the node
 * runner. Import-free on purpose (takes tokens as parameters), so the test
 * never transitively pulls RN. Mirrors card-surface.ts.
 */

export type SheetVariant = 'bottom' | 'center';
export type SheetAnimation = 'default' | 'none';
export type ModalAnimationType = 'slide' | 'fade' | 'none';

export type SheetPalette = {
  surfaceElevated: string;
  surfaceElevatedOpaque: string;
};

/**
 * The sheet's tint, and whether a BlurView should be drawn behind it.
 *
 * Same rule as cardSurface: under Reduce Transparency the blur is removed and
 * the tint must be near-opaque, or the cosmos bleeds through a surface that is
 * meant to be a reading sanctuary. "Not yet resolved" counts as reduce, so an
 * RT user never sees a one-frame blur flash while the async read settles.
 */
export function sheetSurface(reduceTransparency: boolean, p: SheetPalette) {
  return reduceTransparency
    ? { tint: p.surfaceElevatedOpaque, blur: false }
    : { tint: p.surfaceElevated, blur: true };
}

/**
 * Which RN Modal animation to use.
 *
 * Reduce Motion cross-fades rather than removing the transition entirely: that
 * is what iOS itself does for modal presentation, and an instant appearance
 * reads as a glitch rather than as calm. `animation: 'none'` still means none,
 * because a caller passing it is driving its own animation and a second one
 * would fight it.
 */
export function animationTypeFor(
  variant: SheetVariant,
  animation: SheetAnimation,
  reduceMotion: boolean,
): ModalAnimationType {
  if (animation === 'none') return 'none';
  if (reduceMotion) return 'fade';
  return variant === 'bottom' ? 'slide' : 'fade';
}

/** Where the sheet sits in the overlay. */
export function overlayJustify(variant: SheetVariant): 'flex-end' | 'center' {
  return variant === 'bottom' ? 'flex-end' : 'center';
}

/**
 * Corner radii per variant.
 *
 * A bottom sheet rounds only its top corners — it is flush with the bottom
 * edge of the screen, so rounding the bottom leaves two slivers of scrim that
 * read as a rendering bug. Five call sites today override a centred card's
 * radius to achieve this by hand.
 */
export function sheetCorners(variant: SheetVariant, sheetRadius: number, cardRadius: number) {
  if (variant === 'bottom') {
    return {
      borderTopLeftRadius: sheetRadius,
      borderTopRightRadius: sheetRadius,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    };
  }
  return {
    borderTopLeftRadius: cardRadius,
    borderTopRightRadius: cardRadius,
    borderBottomLeftRadius: cardRadius,
    borderBottomRightRadius: cardRadius,
  };
}

/**
 * Is the drag handle drawn? Bottom sheets get one, centred dialogs do not —
 * a handle on a dialog promises a drag gesture that does not exist.
 */
export function handleShown(variant: SheetVariant, showHandle?: boolean): boolean {
  return showHandle ?? variant === 'bottom';
}

/**
 * Horizontal inset on the OVERLAY, not on the sheet.
 *
 * A centred dialog is `width: '100%'` of whatever contains it, so the inset has
 * to be the parent's padding. Expressing it as the sheet's own margin makes the
 * card 100% of the FULL overlay plus two margins, and the borders and corners
 * render off-screen on every phone. The shipped consent dialog had this right;
 * lifting it into the primitive is where it broke.
 *
 * A bottom sheet is edge-to-edge by design, so it gets none.
 */
export function overlayPaddingHorizontal(variant: SheetVariant, gutter: number): number {
  return variant === 'center' ? gutter : 0;
}
