/**
 * Ouroboros hero — the ornament's geometry (NEX-329).
 *
 * The instrument the serpent sits in: concentric orbits, a dial of fine ticks,
 * four cardinal marks and a compass rose behind the numeral. Everything here is
 * a fraction of the hero's size, so the layer is resolution- and size-agnostic
 * and a change of ring size costs nothing.
 *
 * Pure: no React, no SVG. `OuroborosOrnament.tsx` draws what this describes.
 *
 * Every emitter takes `size` and returns ABSOLUTE pixel coordinates, already
 * centred. That is deliberate: the first cut returned centre-relative points and
 * left the component to translate them, which it did with `<G x y>` — not a
 * translation in react-native-svg, so the whole ornament rendered clipped into
 * the top-left corner. Centring here means there is no transform left to get
 * wrong, and the centring itself is covered by tests that can run in Node.
 *
 * WHY SO LITTLE OF IT IS GOLD. §4.4 makes gold a seal rather than a stroke, and
 * §19 caps gold elements per screen — so the orbits and the dial are the
 * luminous white hairline the system already uses, the rose is teal, and only
 * the ONE origin cardinal is gold. `scripts/ouroboros/gold_budget.py` prices it:
 * the seal is 2.5 pt², 0.0008% of the screen, against a whole-hero 2.73% at
 * score 100 and a cap of 5%. Drawing the rings in gold would have been the
 * obvious choice and the wrong one.
 */

/** Radii as fractions of the hero's width. The serpent's own spine sits at
 *  0.351, measured by the bake, so the orbits are placed around it. */
export const R_SPINE = 0.351;
export const R_DIAL = 0.408;
export const R_ORBIT = 0.436;
export const R_ORBIT_OUTER = 0.477;
export const R_INNER = 0.243;

/** Ticks on the dial, every sixth one long. 72 divides the circle into fives,
 *  which reads as an instrument rather than as decoration. */
export const DIAL_TICKS = 72;
export const DIAL_MAJOR_EVERY = 6;
export const TICK_LEN = 0.006;
export const TICK_LEN_MAJOR = 0.011;

export const ROSE_RAYS = 16;
export const ROSE_MAJOR_EVERY = 4;

/** Alphas, 0-255. Low by intent: this is the frame, not the subject. */
export const ALPHA = {
  orbit: 44,
  orbitOuter: 16,
  inner: 32,
  tick: 40,
  tickMajor: 78,
  /** The three quiet quarters: white hairline, a little brighter than the rings
   *  so they still register as marks. */
  cardinal: 120,
  /** The one gold seal, at twelve o'clock. */
  cardinalOrigin: 190,
  rose: 26,
  roseMajor: 52,
} as const;

export type Tick = {
  /** Unit-circle endpoints, relative to the centre, in fractions of size. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  major: boolean;
};

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;

/** The hero's centre in its own pixel space. */
export function centre(size: number): { cx: number; cy: number } {
  return { cx: size / 2, cy: size / 2 };
}

/** The three orbit radii in px, largest last. */
export function ringRadii(size: number): { inner: number; orbit: number; outer: number } {
  return { inner: R_INNER * size, orbit: R_ORBIT * size, outer: R_ORBIT_OUTER * size };
}

/** The dial's ticks, in absolute px. `rotation` turns the instrument, in degrees. */
export function dialTicks(size: number, rotation = 0): Tick[] {
  const { cx, cy } = centre(size);
  const out: Tick[] = [];
  for (let i = 0; i < DIAL_TICKS; i += 1) {
    const a = rad(rotation + (i * 360) / DIAL_TICKS);
    const major = i % DIAL_MAJOR_EVERY === 0;
    const r1 = R_DIAL * size;
    const r2 = (R_DIAL + (major ? TICK_LEN_MAJOR : TICK_LEN)) * size;
    out.push({
      x1: cx + r1 * Math.cos(a),
      y1: cy + r1 * Math.sin(a),
      x2: cx + r2 * Math.cos(a),
      y2: cy + r2 * Math.sin(a),
      major,
    });
  }
  return out;
}

export type Cardinal = { x: number; y: number; r: number; origin: boolean };

/**
 * The four quarter marks. Only twelve o'clock is gold, and it is a FILLED dot
 * rather than an outline: §4.4 makes gold something placed, not stroked, and a
 * ring drawn in gold is a stroke however small it is. It is also where the
 * serpent's tail is pinned, so a single seal there reads as the origin of the
 * whole dial rather than as one of four identical decorations.
 */
export function cardinals(size: number, rotation = 0): Cardinal[] {
  const { cx, cy } = centre(size);
  return [0, 1, 2, 3].map((k) => {
    const a = rad(rotation + k * 90);
    const r = (R_ORBIT + 0.019) * size;
    const origin = k === 0;
    return {
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
      // the gold seal is a filled dot, so it reads at a smaller radius than the
      // three open marks
      r: size * (origin ? 0.0055 * 0.62 : 0.0055),
      origin,
    };
  });
}

export type Ray = { x1: number; y1: number; x2: number; y2: number; major: boolean };

/** The compass rose behind the numeral. Turns at half the dial's rate, so the
 *  two never lock into a single rigid object. */
export function roseRays(size: number, rotation = 0): Ray[] {
  const { cx, cy } = centre(size);
  const out: Ray[] = [];
  for (let i = 0; i < ROSE_RAYS; i += 1) {
    const a = rad(rotation * 0.5 + (i * 360) / ROSE_RAYS);
    const major = i % ROSE_MAJOR_EVERY === 0;
    const r1 = (major ? 0.055 : 0.1) * size;
    const r2 = (R_INNER - 0.012) * size;
    out.push({
      x1: cx + r1 * Math.cos(a),
      y1: cy + r1 * Math.sin(a),
      x2: cx + r2 * Math.cos(a),
      y2: cy + r2 * Math.sin(a),
      major,
    });
  }
  return out;
}

/** Hairline width in px for a given hero size, floored so it never vanishes. */
export function hairline(size: number): number {
  return Math.max(1, Math.round(size * 0.0012));
}
