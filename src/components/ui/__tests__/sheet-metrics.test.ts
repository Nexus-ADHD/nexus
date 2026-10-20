import { describe, expect, it } from 'vitest';

import {
  animationTypeFor,
  overlayPaddingHorizontal,
  handleShown,
  overlayJustify,
  sheetCorners,
  sheetSurface,
} from '../sheet-metrics';

const palette = { surfaceElevated: 'SE', surfaceElevatedOpaque: 'SEO' };

describe('sheetSurface', () => {
  it('translucent: elevated tint with a blur behind it', () => {
    expect(sheetSurface(false, palette)).toEqual({ tint: 'SE', blur: true });
  });

  it('reduce-transparency: opaque tint and NO blur', () => {
    expect(sheetSurface(true, palette)).toEqual({ tint: 'SEO', blur: false });
  });

  it('never pairs a translucent tint with a removed blur', () => {
    // The regression this guards: dropping the BlurView while keeping the
    // translucent tint leaves the cosmos bleeding through a surface meant to
    // be readable.
    const { tint, blur } = sheetSurface(true, palette);
    expect(blur).toBe(false);
    expect(tint).not.toBe(palette.surfaceElevated);
  });
});

describe('animationTypeFor', () => {
  it('slides a bottom sheet and fades a centred dialog', () => {
    expect(animationTypeFor('bottom', 'default', false)).toBe('slide');
    expect(animationTypeFor('center', 'default', false)).toBe('fade');
  });

  it('cross-fades under Reduce Motion rather than appearing instantly', () => {
    // What iOS itself does for modal presentation. An instant appearance reads
    // as a glitch, not as calm.
    expect(animationTypeFor('bottom', 'default', true)).toBe('fade');
    expect(animationTypeFor('center', 'default', true)).toBe('fade');
  });

  it("honours animation='none' even when motion is allowed", () => {
    // A caller passing 'none' is driving its own animation; a second one fights it.
    expect(animationTypeFor('bottom', 'none', false)).toBe('none');
    expect(animationTypeFor('center', 'none', true)).toBe('none');
  });

  it('never returns slide under Reduce Motion, for any variant', () => {
    for (const v of ['bottom', 'center'] as const) {
      expect(animationTypeFor(v, 'default', true)).not.toBe('slide');
    }
  });
});

describe('overlayJustify', () => {
  it('pins a bottom sheet to the bottom and centres a dialog', () => {
    expect(overlayJustify('bottom')).toBe('flex-end');
    expect(overlayJustify('center')).toBe('center');
  });
});

describe('sheetCorners', () => {
  it('rounds only the top of a bottom sheet', () => {
    // Rounding the bottom leaves two slivers of scrim below the sheet that
    // read as a rendering bug. Five call sites override this by hand today.
    expect(sheetCorners('bottom', 28, 16)).toEqual({
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    });
  });

  it('rounds all four corners of a centred dialog, at the card radius', () => {
    expect(sheetCorners('center', 28, 16)).toEqual({
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderBottomLeftRadius: 16,
      borderBottomRightRadius: 16,
    });
  });
});

describe('handleShown', () => {
  it('draws a handle on a bottom sheet but not on a dialog', () => {
    // A handle on a dialog promises a drag gesture that does not exist.
    expect(handleShown('bottom')).toBe(true);
    expect(handleShown('center')).toBe(false);
  });

  it('lets the caller override either way', () => {
    expect(handleShown('bottom', false)).toBe(false);
    expect(handleShown('center', true)).toBe(true);
  });
});

describe('overlayPaddingHorizontal', () => {
  it('insets a centred dialog from the parent, not the sheet', () => {
    // The bug this pins: expressing the inset as the sheet's own margin makes
    // the card 100% of the FULL overlay plus two margins, so its borders and
    // corners render off-screen on every phone.
    expect(overlayPaddingHorizontal('center', 24)).toBe(24);
  });

  it('leaves a bottom sheet edge-to-edge', () => {
    expect(overlayPaddingHorizontal('bottom', 24)).toBe(0);
  });
});
