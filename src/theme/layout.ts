// NEXUS ADAPTIVE LAYOUT — breakpoints for wide viewports (iPad / desktop-class
// via "Designed for iPad"). The app is phone-first: on wide screens CONTENT is
// constrained to a centered column so it reads as a composed layout rather than
// stretched edge-to-edge. Backdrops and absolute overlays (StarField, the
// Command screen's layers) stay full-bleed — only content is constrained.
//
// The column TRACKS the canvas (width - gutters, up to a ceiling). It used to
// be pinned at a flat 680pt — the phone measure — which on an iPad filled two
// thirds of the screen and read as a phone app centred on a tablet.
//
// The pure logic (breakpointsForWidth) is kept free of React Native imports
// in spirit, but this module also exports the useBreakpoints() hook, so tests
// mock 'react-native' before importing (see __tests__/layout.test.ts).
import { useWindowDimensions } from 'react-native';

// Logical-point width at which the layout switches to the adaptive column.
// Matches the iPad portrait boundary (iPad mini is 744pt, all other iPads
// are >= 768pt wide in portrait; every iPhone is below 768 in portrait).
export const WIDE_BREAKPOINT = 768;

// Breathing room left either side of the content column on a wide screen.
export const CONTENT_GUTTER = 32;

// Ceiling for the content column. The column normally tracks the viewport
// (width - gutters); this only bites on very wide canvases, where a single
// column of cards stretched to 1300pt+ reads as thin and sparse rather than
// spacious.
//
// This was a FLAT 680 — the phone measure, pinned regardless of canvas. On a
// 1024pt iPad in portrait that filled 66% of the screen and left ~170pt dead
// on each side: the founder's words were "the background is wide, but
// everything else looks like it's on an iPhone", which is exactly what a
// phone-width column centred on a tablet is. The cap was protecting against
// edge-to-edge stretch and overcorrected into a letterbox of its own.
export const CONTENT_MAX_WIDTH = 1100;

export interface Breakpoints {
  // True when the viewport is wide enough that full-bleed content would
  // read as stretched (tablets, desktop windows).
  isWide: boolean;
  // Max width the content column should occupy. On compact screens this is
  // simply the viewport width (i.e. no constraint).
  contentMaxWidth: number;
}

// Pure decision — the unit-tested half. `width` is a logical-point viewport
// width (useWindowDimensions().width).
export function breakpointsForWidth(width: number): Breakpoints {
  const isWide = width >= WIDE_BREAKPOINT;
  if (!isWide) return { isWide, contentMaxWidth: width };
  // Track the canvas, minus gutters, up to the ceiling — but never return LESS
  // than the breakpoint itself.
  //
  // That floor is what keeps the transition continuous. Below the breakpoint
  // the column is unconstrained (= the full viewport), so applying both
  // gutters the instant we cross it made the content JUMP INWARD by 63pt as
  // the viewport grew by 1pt: 767 -> 767 wide, 768 -> 704. Growing the window
  // must never shrink the content.
  //
  // With the floor the column is monotonic: it holds at 768 until the canvas
  // is wide enough to afford both gutters (832pt), then tracks upward.
  //    767pt -> 767  (compact, unconstrained)
  //    768pt -> 768  (floor; would have been 704 — the shrink)
  //    832pt -> 768  (gutters now fully afforded)
  //   1024pt -> 960
  //   1366pt -> 1100 (ceiling)
  //
  // Reachable widths, for context: requireFullScreen is true, so Split View and
  // Stage Manager are off and the app only ever sees full-screen sizes —
  //   iPad mini  744 portrait (COMPACT, below the breakpoint) / 1133 landscape
  //   iPad 11in  834 / 1194
  //   iPad 13in 1024 / 1366
  // The lowest WIDE width any device produces is therefore 834, so the
  // 768..832 band above — where the floor leaves no gutter — is not reachable
  // today. The floor is there so this stays correct if requireFullScreen is
  // ever dropped (it is deprecated), not because a device sits in that band.
  return {
    isWide,
    contentMaxWidth: Math.min(
      Math.max(WIDE_BREAKPOINT, width - CONTENT_GUTTER * 2),
      CONTENT_MAX_WIDTH,
    ),
  };
}

// Reactive hook — re-resolves on rotation / resize / Split-View-class width
// changes. Never read Dimensions.get('window') at module scope for this: a
// static read never updates on resize.
export function useBreakpoints(): Breakpoints {
  const { width } = useWindowDimensions();
  return breakpointsForWidth(width);
}
