import React from 'react';
import { Path, Svg } from 'react-native-svg';
import tokens from '@/src/theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FlameGlyphProps = {
  size?: number;
  color?: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

// Stylized single-flame: narrow base, pointed tip, gentle S-curve on both sides.
// ViewBox 12×16; the path traces the outer silhouette clockwise and closes.
const FLAME_PATH =
  'M 6 1 Q 2 4 2.5 8.5 Q 3 13 6 15 Q 9 13 9.5 8.5 Q 10 4 6 1 Z';

export function FlameGlyph({ size = 10, color = tokens.color.gold }: FlameGlyphProps) {
  return (
    <Svg
      width={size}
      height={(size * 16) / 12} // preserve 12×16 aspect ratio
      viewBox="0 0 12 16"
    >
      <Path
        d={FLAME_PATH}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="butt"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
