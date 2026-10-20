/**
 * CornerGlows — opt-in luminous corner accents for primary card surfaces.
 * (NEX-158, CLAUDE.md §6.2)
 *
 * Four small SVGs, one anchored at each corner of the parent, each tracing that
 * corner's rounded edge (straight → arc → straight) so the card's border appears
 * to "light up" at the corners. The light is brightest at the corner and fades
 * along both edges, via a per-corner radial gradient centered on the corner
 * apex. Two stroked paths per corner: a soft 3pt glow under a crisp 1px edge.
 *
 * Design notes:
 *  - WHITE, not gold — corner glows don't eat the ≤5% gold budget (§4.4).
 *  - Static. No shimmer, no animation (§1.4 "stone doesn't bounce").
 *  - Mount as an absolute overlay in a NON-clipping wrapper (Card's glowWrapper),
 *    NOT inside an `overflow:'hidden'` box — otherwise the soft glow's outer half
 *    is clipped and it reads as an inward sheen instead of the border glowing.
 *  - Each corner SVG is padded by PAD on every side and the traced path is
 *    inset by PAD, so the soft glow's outer half (which sits OUTSIDE the traced
 *    line) stays inside the SVG viewport and bleeds outward past the border
 *    instead of being clipped at x=0/y=0.
 *  - `radius` is REQUIRED and must equal the card's actual borderRadius, or the
 *    arc visibly misaligns with the rounded corner.
 *  - `suppressLeft` skips the two left corners (used when a left accent bar is
 *    present, so the glow doesn't compete with the gold bar).
 *
 * Geometry: `edge = edgeLength + radius` is the traced extent from the apex; the
 * SVG box is `edge + 2·PAD` square. The apex (radial-gradient center) is the
 * corner's outer point, inset by PAD: TL(PAD,PAD), TR(PAD+edge,PAD),
 * BR(PAD+edge,PAD+edge), BL(PAD,PAD+edge). The box is positioned -PAD past the
 * card corner so the traced line still lands exactly on the card edge. The path
 * never passes through the apex (the arc is the nearest point), so the gradient
 * holds a plateau out to offset 0.5 (covering the whole arc, which ends ≈0.44·edge
 * from the apex) before fading to 0 at offset 1 (distance `edge`), keeping the
 * full arc at apexOpacity.
 */

import React, { useId } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, Path, RadialGradient, Stop } from 'react-native-svg';
import tokens from '@/src/theme/tokens';

const { edgeLength: E, apexOpacity, glowOpacity, strokeWidth, glowStrokeWidth } =
  tokens.material.cornerGlow;

// Outward margin so the soft glow stroke's outer half isn't clipped by the SVG
// viewport. Must be ≥ glowStrokeWidth / 2; use the full width for clean margin.
const PAD = glowStrokeWidth;

type Corner = 'tl' | 'tr' | 'br' | 'bl';

export type CornerGlowsProps = {
  /** Must equal the card's borderRadius, or the arc misaligns. */
  radius: number;
  /** Skip the two left corners (e.g. when a left accent bar is present). */
  suppressLeft?: boolean;
};

// Per-corner anchor position within the absolute-fill overlay. Offset by -PAD so
// the (padded) SVG's traced line still lands on the card's corner.
const CORNER_POS: Record<Corner, ViewStyle> = {
  tl: { top: -PAD, left: -PAD },
  tr: { top: -PAD, right: -PAD },
  br: { bottom: -PAD, right: -PAD },
  bl: { bottom: -PAD, left: -PAD },
};

// Build the trace path (straight → arc → straight) and the gradient apex center
// for a corner. `r` = radius, `edge` = edgeLength + r. All coords are offset by
// PAD into a (edge + 2·PAD) box; arcs sweep clockwise (flag 1) around the card's
// actual corner center.
function cornerGeometry(corner: Corner, r: number, edge: number): { d: string; cx: number; cy: number } {
  const o = PAD;
  switch (corner) {
    case 'tl':
      return { d: `M ${o} ${o + r + E} L ${o} ${o + r} A ${r} ${r} 0 0 1 ${o + r} ${o} L ${o + r + E} ${o}`, cx: o, cy: o };
    case 'tr':
      return { d: `M ${o + edge - r - E} ${o} L ${o + edge - r} ${o} A ${r} ${r} 0 0 1 ${o + edge} ${o + r} L ${o + edge} ${o + r + E}`, cx: o + edge, cy: o };
    case 'br':
      return { d: `M ${o + edge} ${o + edge - r - E} L ${o + edge} ${o + edge - r} A ${r} ${r} 0 0 1 ${o + edge - r} ${o + edge} L ${o + edge - r - E} ${o + edge}`, cx: o + edge, cy: o + edge };
    case 'bl':
      return { d: `M ${o + r + E} ${o + edge} L ${o + r} ${o + edge} A ${r} ${r} 0 0 1 ${o} ${o + edge - r} L ${o} ${o + edge - r - E}`, cx: o, cy: o + edge };
  }
}

function CornerGlow({ corner, radius: r, gradId }: {
  corner: Corner;
  radius: number;
  gradId: string;
}) {
  const edge = E + r;
  const box = edge + 2 * PAD;
  const { d, cx, cy } = cornerGeometry(corner, r, edge);
  return (
    <Svg
      width={box}
      height={box}
      style={[styles.corner, CORNER_POS[corner]]}
      pointerEvents="none"
    >
      <Defs>
        {/* Radial gradient centered on the apex. The traced arc spans roughly
            0.41·r → r from the apex (≈0.18 → 0.44 of `edge` at r=16), so the
            plateau runs to 0.5 to keep the WHOLE arc at full strength, then
            fades to 0 along the straight tails, reaching 0 at the edge ends
            (distance `edge` from apex). */}
        <RadialGradient id={gradId} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} fx={cx} fy={cy} r={edge}>
          <Stop offset={0} stopColor="white" stopOpacity={1} />
          <Stop offset={0.5} stopColor="white" stopOpacity={1} />
          <Stop offset={1} stopColor="white" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* Soft glow (wide, faint) beneath the crisp edge. Effective alpha =
          gradient stop-opacity × strokeOpacity, so the falloff shape comes from
          the gradient and the tier strength from strokeOpacity. */}
      <Path d={d} fill="none" stroke={`url(#${gradId})`} strokeOpacity={glowOpacity} strokeWidth={glowStrokeWidth} strokeLinecap="round" />
      {/* Crisp apex edge. */}
      <Path d={d} fill="none" stroke={`url(#${gradId})`} strokeOpacity={apexOpacity} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

export function CornerGlows({ radius, suppressLeft = false }: CornerGlowsProps) {
  // useId guarantees uniqueness across multiple cards on a screen, but not
  // URL-fragment-safe syntax (can contain ':'), which would break url(#id).
  // Sanitize to a safe id charset.
  const safeId = `cornerGlow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const corners: Corner[] = suppressLeft ? ['tr', 'br'] : ['tl', 'tr', 'br', 'bl'];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {corners.map(c => (
        <CornerGlow key={c} corner={c} radius={radius} gradId={`${safeId}-${c}`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  corner: {
    position: 'absolute',
  },
});
