/**
 * Star-field optics — the parameter math, split out so vitest (node env)
 * covers it. StarField.tsx imports react-native and Skia and can't load under
 * the node runner. This module imports ONLY tokens.ts, which is a plain object
 * with no react-native imports, so it still loads under the node runner.
 *
 * WHY THIS EXISTS
 * Measured against the shipped field, the sky failed on optics, not on taste:
 *   - every star sat at opacity >= 0.40, so all 80 read as roughly equally
 *     bright — the visual signature of a particle emitter, not a sky
 *   - all 80 were #FFFFFF; nothing real is one hue
 *   - the glow was 1.6x the core on three LINEAR stops, which reads as an
 *     anti-aliased dot rather than as light
 * Real point sources are power-law distributed in brightness, span blue-white
 * to amber, and have a tiny blazing core with a wide, steeply decaying halo.
 * Every function here encodes one of those facts.
 */

import tokens from '@/src/theme/tokens';

// ── Distribution ──────────────────────────────────────────────────────────────

/** Faintest a star may sit at rest. Was 0.40 — the single highest-impact number. */
export const OPACITY_FLOOR = 0.06;
export const OPACITY_CEIL = 0.55;
/** Exponent > 1 pushes most stars toward the floor: many faint, few blazing. */
export const OPACITY_GAMMA = 1.8;

export const SIZE_MIN = 0.8;
export const SIZE_MAX = 4.5;
export const SIZE_GAMMA = 2.2;

/**
 * Resting brightness from a uniform random in [0,1).
 *
 * A real sky is mostly 6th-magnitude stars you can barely see plus a handful
 * of blazing ones. Uniform random gives a flat field; the gamma gives the
 * long faint tail that reads as depth.
 */
export function starOpacity(r: number): number {
  const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
  return OPACITY_FLOOR + (OPACITY_CEIL - OPACITY_FLOOR) * Math.pow(clamped, OPACITY_GAMMA);
}

/** Core size, power-law for the same reason. */
export function starSize(r: number): number {
  const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * Math.pow(clamped, SIZE_GAMMA);
}

/** 0 = faintest star in the field, 1 = brightest. Drives chroma and spikes. */
export function brightnessFraction(opacity: number): number {
  const t = (opacity - OPACITY_FLOOR) / (OPACITY_CEIL - OPACITY_FLOOR);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ── Twinkle ───────────────────────────────────────────────────────────────────

/**
 * Peak brightness for a star resting at `trough`.
 *
 * Amplitude is PROPORTIONAL, so a faint star flickers faintly and only the
 * brightest handful visibly twinkle. That is both physically right and the
 * thing that keeps a denser field contemplative rather than busy — the reason
 * the count was cut 128 -> 80 in the first place was that everything popped at
 * once. Density is safe when most of it sits near the floor.
 */
export const TWINKLE_PEAK_RATIO = 1.9;

export function starPeak(trough: number): number {
  const peak = trough * TWINKLE_PEAK_RATIO;
  return peak > 1 ? 1 : peak;
}

// ── Chroma ────────────────────────────────────────────────────────────────────

/**
 * Spectral ramp. Weights approximate a real field's colour distribution;
 * brighter stars bias bluer, which is true of hot stars and also just looks
 * right against a warm nebula.
 */
export const STAR_CHROMA: ReadonlyArray<{ hex: string; weight: number }> = [
  { hex: tokens.color.starBlue, weight: 0.15 },      // hot blue-white
  { hex: tokens.color.starBlueWhite, weight: 0.25 },
  { hex: tokens.color.starWhite, weight: 0.30 },
  { hex: tokens.color.starWarmWhite, weight: 0.20 },
  { hex: tokens.color.starAmber, weight: 0.10 },     // cool stellar white
];

/** Bias strength toward the blue end of the ramp for the brightest stars. */
export const CHROMA_BLUE_BIAS = 0.25;

export function starChroma(r: number, brightness = 0): string {
  const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
  const b = brightness < 0 ? 0 : brightness > 1 ? 1 : brightness;
  const t = clamped * (1 - CHROMA_BLUE_BIAS * b);
  let acc = 0;
  for (const band of STAR_CHROMA) {
    acc += band.weight;
    if (t <= acc) return band.hex;
  }
  return STAR_CHROMA[STAR_CHROMA.length - 1].hex;
}

// ── Falloff ───────────────────────────────────────────────────────────────────

/**
 * Glow radius as a multiple of the core diameter. Was 1.6 — too tight and too
 * linear to read as light. A point source through a lens has a wide halo with
 * most of its alpha spent in the first fifth.
 */
export const GLOW_SCALE = 4.5;

export type GlowStop = { offset: number; alpha: number };

/**
 * Gamma-shaped falloff: blazing core, steep decay, long tail. The shape is
 * what separates "light" from "a circle with a soft edge" — four stops rather
 * than three, weighted so ~75% of the alpha is gone by 18% of the radius.
 */
export function glowStops(peakAlpha: number): GlowStop[] {
  return [
    { offset: 0.00, alpha: peakAlpha },
    { offset: 0.18, alpha: peakAlpha * 0.25 },
    { offset: 0.45, alpha: peakAlpha * 0.055 },
    { offset: 1.00, alpha: 0 },
  ];
}

// ── Diffraction spikes ────────────────────────────────────────────────────────

/**
 * Spikes are an optical artefact of BRIGHT sources, so they follow brightness,
 * not size. Was a flat 25% of stars regardless — which is why the old field
 * read decorative. Top decile only.
 *
 * TURNED OFF (owner call, on device): at 0.9 this gave five sparkles across the
 * field with the longest spike reaching 24.8pt, and against a quiet screen they
 * read as two or three conspicuous ornaments rather than distant suns — "big-ass
 * random stars". A threshold above 1 is unreachable, since `brightnessFraction`
 * is normalised to 0..1, so no star spikes.
 *
 * The machinery below is deliberately KEPT rather than deleted: it is measured,
 * vitest-covered, and the optics are right — it is the prominence that was
 * wrong. Lower this back toward 0.9 to bring them back, or to something like
 * 0.97 for a much rarer, subtler version.
 */
export const SPIKE_BRIGHTNESS_THRESHOLD = 1.01;

export function hasSpike(brightness: number): boolean {
  return brightness >= SPIKE_BRIGHTNESS_THRESHOLD;
}

/** Spike length scales with brightness, not with core size. */
export function spikeLength(coreSize: number, brightness: number): number {
  return coreSize * (2.5 + brightness * 3.0);
}

/**
 * Horizontal spike as a fraction of the vertical one. Vertical longer than
 * horizontal is what makes the sparkle read as optical diffraction rather than
 * as a "+" glyph.
 */
export const SPIKE_ASPECT = 1.5 / 2.1;

/**
 * The DRAWN sparkle geometry, derived from the same spikeLength that sizes the
 * container. These have to come from one source: sizing the box from
 * brightness-scaled geometry while drawing the path from size-scaled constants
 * leaves the box 2.5x larger than what it contains (Greptile #407 P1).
 */
export function spikeGeometry(coreSize: number, brightness: number): {
  vertical: number;
  horizontal: number;
} {
  const vertical = spikeLength(coreSize, brightness);
  return { vertical, horizontal: vertical * SPIKE_ASPECT };
}

// ── Field composition ─────────────────────────────────────────────────────────

/**
 * The near field animates; the far field is baked into the backdrop asset.
 * Density comes from the baked half, which costs nothing at runtime.
 */
export const NEAR_STAR_COUNT = 130;
export const FAR_STAR_COUNT = 600;

/**
 * Any photographic/baked backdrop must meet the largest phone's native
 * resolution. The shipped asset was 941x1672 rendering at ~65% of native,
 * which made every star inside it a soft blob under a crisp vector layer —
 * two optical worlds stacked. Enforced by scripts/check-backdrop-resolution.mjs.
 */
export const MIN_BACKDROP_WIDTH = 1290;
export const MIN_BACKDROP_HEIGHT = 2796;

export function backdropMeetsResolution(width: number, height: number): boolean {
  return width >= MIN_BACKDROP_WIDTH && height >= MIN_BACKDROP_HEIGHT;
}

// ── Film grain ────────────────────────────────────────────────────────────────

/**
 * Peak alpha carried by a single pixel of the baked grain tile, as a fraction.
 * Mirrors GRAIN_TILE_PEAK_ALPHA (26/255) in scripts/bake-starfield.py.
 */
export const GRAIN_TILE_PEAK_ALPHA = 26 / 255;

/**
 * Opacity of the global grain layer. Chosen so the strongest speckle lands
 * inside the 1.5-2% band: below that, 8-bit banding on near-black survives;
 * above it, the grain stops reading as film and starts reading as noise.
 */
export const GRAIN_OVERLAY_OPACITY = 0.18;

/** Effective peak grain strength as seen on screen. */
export function effectiveGrainStrength(): number {
  return GRAIN_TILE_PEAK_ALPHA * GRAIN_OVERLAY_OPACITY;
}

// ── Slow drift ────────────────────────────────────────────────────────────────

/**
 * The sky drifts, very slowly.
 *
 * Macro movement is what separates "a place" from "wallpaper" — it is the
 * cheapest premium trick available, and unlike scroll-linked parallax it needs
 * no scroll plumbing. (Scroll parallax was costed and rejected for now: there
 * is no shared scroll value anywhere in the app, so it would mean converting
 * 35 ScrollViews before StarField could read anything.)
 *
 * Two different periods on the two axes give a Lissajous path, so the motion
 * never visibly repeats — a single sine on both axes reads as a pendulum.
 */
export const DRIFT_PERIOD_MS = 75_000;
/** Second axis runs slower, deliberately not a harmonic of the first. */
export const DRIFT_Y_RATE = 0.61;
/** Peak offset as a fraction of the screen's larger dimension. */
export const DRIFT_AMPLITUDE = 0.012;
/**
 * Backdrop scale. Must exceed 1 + DRIFT_AMPLITUDE or the drift walks the
 * image edge into frame.
 */
export const DRIFT_OVERSCAN = 1.05;

/** Normalized drift offset in [-1, 1] on each axis. */
export function driftOffset(timeMs: number): { x: number; y: number } {
  const phase = (timeMs % DRIFT_PERIOD_MS) / DRIFT_PERIOD_MS;
  const tau = Math.PI * 2;
  return {
    x: Math.sin(phase * tau),
    y: Math.cos(phase * tau * DRIFT_Y_RATE),
  };
}
