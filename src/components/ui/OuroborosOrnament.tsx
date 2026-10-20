/**
 * Ouroboros hero — the ornament layer (NEX-329).
 *
 * The instrument the serpent sits in. Drawn with react-native-svg, which is the
 * incumbent stack for this hero's chrome and composites transparently over the
 * StarField, so the cosmos shows through the whole frame.
 *
 * NO TRANSFORMS. Every coordinate arrives from `ouroboros-ornament-geometry`
 * already absolute and already centred. The first cut wrapped the children in
 * `<G x={c} y={c}>` — which is not a translation in react-native-svg, so the
 * entire ornament rendered clipped into the top-left corner. Keeping the maths
 * in the pure module means there is no transform left to get wrong, and the
 * centring is covered by tests that run in Node.
 *
 * Decorative in full: it carries no state and no meaning the numeral does not
 * already carry, so it is hidden from the accessibility tree rather than
 * announced. §1.5 UF-01 — a decorative visual is never the only carrier of a
 * state, and this one carries none.
 */
import React, { memo, useMemo } from 'react';
import Svg, { Circle, Line } from 'react-native-svg';
import type { ViewStyle } from 'react-native';
import tokens from '@/src/theme/tokens';
import {
  ALPHA,
  cardinals,
  centre,
  dialTicks,
  hairline,
  ringRadii,
  roseRays,
} from './ouroboros-ornament-geometry';

const GOLD = tokens.color.gold;
const TEAL = tokens.color.teal;
/** The canonical white, not a literal, so a palette change reaches the orbits. */
const HAIRLINE = tokens.color.text;

export type OuroborosOrnamentProps = {
  /** Width and height in px. Every radius is a fraction of this. */
  size: number;
  /** Turns the dial and the cardinal marks together, in degrees. */
  rotation?: number;
  /** The compass rose sits behind the score numeral; the locked paywall preview
   *  hides it so nothing competes with the blurred value. */
  rose?: boolean;
  style?: ViewStyle;
};

function OuroborosOrnamentBase({
  size,
  rotation = 0,
  rose = true,
  style,
}: OuroborosOrnamentProps) {
  const w = hairline(size);
  const { cx, cy } = centre(size);
  const rings = ringRadii(size);
  const { ticks, marks, rays } = useMemo(
    () => ({
      ticks: dialTicks(size, rotation),
      marks: cardinals(size, rotation),
      rays: roseRays(size, rotation),
    }),
    [size, rotation],
  );

  return (
    <Svg
      width={size}
      height={size}
      style={style}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {rose &&
        rays.map((r, i) => (
          <Line
            key={`rose-${i}`}
            x1={r.x1}
            y1={r.y1}
            x2={r.x2}
            y2={r.y2}
            stroke={TEAL}
            strokeOpacity={(r.major ? ALPHA.roseMajor : ALPHA.rose) / 255}
            strokeWidth={w}
          />
        ))}

      <Circle
        cx={cx}
        cy={cy}
        r={rings.inner}
        stroke={HAIRLINE}
        strokeOpacity={ALPHA.inner / 255}
        strokeWidth={w}
        fill="none"
      />
      <Circle
        cx={cx}
        cy={cy}
        r={rings.orbit}
        stroke={HAIRLINE}
        strokeOpacity={ALPHA.orbit / 255}
        strokeWidth={w}
        fill="none"
      />
      <Circle
        cx={cx}
        cy={cy}
        r={rings.outer}
        stroke={HAIRLINE}
        strokeOpacity={ALPHA.orbitOuter / 255}
        strokeWidth={w}
        fill="none"
      />

      {ticks.map((t, i) => (
        <Line
          key={`tick-${i}`}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          stroke={HAIRLINE}
          strokeOpacity={(t.major ? ALPHA.tickMajor : ALPHA.tick) / 255}
          strokeWidth={w}
        />
      ))}

      {/* Gold appears exactly once, as a filled dot at the origin: PLACED, in
          the §4.4 sense, rather than stroked. The other three quarters are the
          same white hairline as the rings, so the eye reads one seal and three
          quiet marks instead of four competing gold objects. */}
      {marks.map((m, i) =>
        m.origin ? (
          <Circle
            key={`mark-${i}`}
            cx={m.x}
            cy={m.y}
            r={m.r}
            fill={GOLD}
            fillOpacity={ALPHA.cardinalOrigin / 255}
          />
        ) : (
          <Circle
            key={`mark-${i}`}
            cx={m.x}
            cy={m.y}
            r={m.r}
            fill="none"
            stroke={HAIRLINE}
            strokeOpacity={ALPHA.cardinal / 255}
            strokeWidth={w}
          />
        ),
      )}
    </Svg>
  );
}

/** Memoised: it redraws only when size or rotation changes, so it costs nothing
 *  on the score updates that re-render the hero around it. */
export const OuroborosOrnament = memo(OuroborosOrnamentBase);
