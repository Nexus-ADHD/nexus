import { describe, expect, it } from 'vitest';
import {
  backdropMeetsResolution,
  driftOffset,
  DRIFT_AMPLITUDE,
  DRIFT_OVERSCAN,
  DRIFT_PERIOD_MS,
  effectiveGrainStrength,
  GRAIN_OVERLAY_OPACITY,
  GRAIN_TILE_PEAK_ALPHA,
  brightnessFraction,
  FAR_STAR_COUNT,
  GLOW_SCALE,
  glowStops,
  hasSpike,
  MIN_BACKDROP_HEIGHT,
  MIN_BACKDROP_WIDTH,
  NEAR_STAR_COUNT,
  OPACITY_CEIL,
  OPACITY_FLOOR,
  spikeGeometry,
  SPIKE_ASPECT,
  spikeLength,
  starChroma,
  starOpacity,
  starPeak,
  starSize,
  STAR_CHROMA,
  SPIKE_BRIGHTNESS_THRESHOLD,
} from '../starfield-optics';

/** Uniform samples across [0,1) — stands in for the per-star random. */
const SAMPLES = Array.from({ length: 2000 }, (_, i) => i / 2000);

describe('brightness distribution — many faint, few blazing', () => {
  it('spans the full range end to end', () => {
    expect(starOpacity(0)).toBeCloseTo(OPACITY_FLOOR, 5);
    expect(starOpacity(1)).toBeCloseTo(OPACITY_CEIL, 5);
  });

  it('clamps out-of-range input rather than extrapolating', () => {
    expect(starOpacity(-1)).toBeCloseTo(OPACITY_FLOOR, 5);
    expect(starOpacity(9)).toBeCloseTo(OPACITY_CEIL, 5);
  });

  it('is monotonic', () => {
    for (let i = 1; i < SAMPLES.length; i += 1) {
      expect(starOpacity(SAMPLES[i])).toBeGreaterThanOrEqual(starOpacity(SAMPLES[i - 1]));
    }
  });

  // The shipped field sat at >= 0.40 for every star, so all 80 read as roughly
  // equally bright — the signature of a particle emitter. A power law puts the
  // majority near the floor.
  it('puts most of the field in the faint half', () => {
    const mid = (OPACITY_FLOOR + OPACITY_CEIL) / 2;
    const faint = SAMPLES.filter((r) => starOpacity(r) < mid).length;
    expect(faint / SAMPLES.length).toBeGreaterThan(0.65);
  });

  it('reserves the top of the range for a small minority', () => {
    const bright = SAMPLES.filter((r) => brightnessFraction(starOpacity(r)) > 0.8).length;
    expect(bright / SAMPLES.length).toBeLessThan(0.2);
  });

  it('never returns a star dimmer than the floor or brighter than the ceiling', () => {
    for (const r of SAMPLES) {
      const o = starOpacity(r);
      expect(o).toBeGreaterThanOrEqual(OPACITY_FLOOR);
      expect(o).toBeLessThanOrEqual(OPACITY_CEIL);
    }
  });
});

describe('size distribution', () => {
  it('is power-law and monotonic across the range', () => {
    expect(starSize(0)).toBeCloseTo(0.8, 5);
    expect(starSize(1)).toBeCloseTo(4.5, 5);
    for (let i = 1; i < SAMPLES.length; i += 1) {
      expect(starSize(SAMPLES[i])).toBeGreaterThanOrEqual(starSize(SAMPLES[i - 1]));
    }
  });

  it('keeps most stars small — big ones are the exception', () => {
    const big = SAMPLES.filter((r) => starSize(r) > 2.5).length;
    expect(big / SAMPLES.length).toBeLessThan(0.3);
  });
});

describe('twinkle — only the bright ones visibly flicker', () => {
  it('amplitude is proportional, so a faint star flickers faintly', () => {
    const faintDelta = starPeak(OPACITY_FLOOR) - OPACITY_FLOOR;
    const brightDelta = starPeak(OPACITY_CEIL) - OPACITY_CEIL;
    expect(brightDelta).toBeGreaterThan(faintDelta * 3);
  });

  // The count was cut 128 -> 80 because everything popped at once. Density is
  // only safe if most of it stays near the floor through the whole cycle.
  it('a floor-resting star never becomes prominent', () => {
    expect(starPeak(OPACITY_FLOOR)).toBeLessThan(0.15);
  });

  it('never exceeds full opacity', () => {
    for (const r of SAMPLES) {
      expect(starPeak(starOpacity(r))).toBeLessThanOrEqual(1);
    }
  });

  it('peak is always at least the trough', () => {
    for (const r of SAMPLES) {
      const t = starOpacity(r);
      expect(starPeak(t)).toBeGreaterThanOrEqual(t);
    }
  });
});

describe('chroma — nothing real is one hue', () => {
  it('the ramp weights sum to 1', () => {
    const total = STAR_CHROMA.reduce((s, b) => s + b.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('returns a colour from the ramp for every input', () => {
    const allowed = new Set(STAR_CHROMA.map((b) => b.hex));
    for (const r of SAMPLES) expect(allowed.has(starChroma(r))).toBe(true);
  });

  it('actually spreads across the ramp rather than collapsing to white', () => {
    const seen = new Set(SAMPLES.map((r) => starChroma(r)));
    expect(seen.size).toBe(STAR_CHROMA.length);
  });

  it('biases the brightest stars bluer', () => {
    // Same random draw, different brightness: bright must land at or before
    // the dim one in the ramp (ramp is ordered blue -> amber).
    const order = STAR_CHROMA.map((b) => b.hex);
    let strictlyBluerSomewhere = false;
    for (const r of SAMPLES) {
      const dim = order.indexOf(starChroma(r, 0));
      const bright = order.indexOf(starChroma(r, 1));
      expect(bright).toBeLessThanOrEqual(dim);
      if (bright < dim) strictlyBluerSomewhere = true;
    }
    expect(strictlyBluerSomewhere).toBe(true);
  });
});

describe('falloff — light, not a circle with a soft edge', () => {
  it('reaches well beyond the core', () => {
    expect(GLOW_SCALE).toBeGreaterThan(4);
  });

  it('spends most of its alpha in the first fifth of the radius', () => {
    const stops = glowStops(1);
    const atCore = stops[0].alpha;
    const at18 = stops[1].alpha;
    expect(at18).toBeLessThan(atCore * 0.3);
  });

  it('decays monotonically to fully transparent', () => {
    const stops = glowStops(0.8);
    for (let i = 1; i < stops.length; i += 1) {
      expect(stops[i].alpha).toBeLessThanOrEqual(stops[i - 1].alpha);
      expect(stops[i].offset).toBeGreaterThan(stops[i - 1].offset);
    }
    expect(stops[stops.length - 1].alpha).toBe(0);
  });

  it('scales with the star it belongs to', () => {
    expect(glowStops(0.5)[0].alpha).toBeCloseTo(0.5, 6);
    expect(glowStops(0.1)[1].alpha).toBeLessThan(glowStops(0.9)[1].alpha);
  });
});

describe('diffraction spikes follow brightness, not size', () => {
  // Spikes are OFF (owner call): at the old 0.9 threshold five sparkles crossed
  // the field, the longest 24.8pt, and they read as ornaments rather than
  // distant suns. This asserts the intended state rather than a bound.
  //
  // The previous assertion was `spiked / SAMPLES < 0.15`, which passes at ZERO —
  // it could never have distinguished "top decile" from "none", so it would not
  // have caught spikes disappearing by accident either.
  it('no star spikes while the threshold is above the brightness range', () => {
    const spiked = SAMPLES.filter((r) => hasSpike(brightnessFraction(starOpacity(r)))).length;
    expect(spiked).toBe(0);
    // and the threshold is genuinely unreachable, not merely un-hit by this sample
    expect(SPIKE_BRIGHTNESS_THRESHOLD).toBeGreaterThan(1);
  });

  it('the faintest stars never spike', () => {
    expect(hasSpike(brightnessFraction(OPACITY_FLOOR))).toBe(false);
  });

  it('length grows with brightness at a fixed core size', () => {
    expect(spikeLength(2, 1)).toBeGreaterThan(spikeLength(2, 0));
  });

  // The bug this encodes (Greptile #407 P1): the container was sized from
  // brightness-scaled geometry while the SVG path was drawn from the old
  // size-only constants, leaving the box ~2.5x larger than the sparkle in it.
  // Both must come from one call.
  it('the drawn sparkle matches the length the container is sized for', () => {
    for (const size of [0.8, 2, 4.5]) {
      for (const b of [0.9, 0.95, 1]) {
        expect(spikeGeometry(size, b).vertical).toBeCloseTo(spikeLength(size, b), 10);
      }
    }
  });

  it('stays taller than it is wide, so it reads as diffraction not a plus sign', () => {
    const g = spikeGeometry(3, 1);
    expect(g.horizontal).toBeLessThan(g.vertical);
    expect(g.horizontal / g.vertical).toBeCloseTo(SPIKE_ASPECT, 10);
  });

  it('both axes scale together with brightness', () => {
    const dim = spikeGeometry(2, 0.9);
    const bright = spikeGeometry(2, 1);
    expect(bright.vertical).toBeGreaterThan(dim.vertical);
    expect(bright.horizontal).toBeGreaterThan(dim.horizontal);
  });
});

describe('field composition + the resolution guard', () => {
  it('density lives in the baked far field, which costs nothing at runtime', () => {
    expect(FAR_STAR_COUNT).toBeGreaterThan(NEAR_STAR_COUNT * 3);
  });

  // The shipped backdrop was 941x1672 rendering at ~65% of native — soft,
  // JPEG-mushed stars sitting under a crisp vector layer.
  it('rejects the resolution that shipped', () => {
    expect(backdropMeetsResolution(941, 1672)).toBe(false);
  });

  it('accepts an asset at or above the largest phone', () => {
    expect(backdropMeetsResolution(MIN_BACKDROP_WIDTH, MIN_BACKDROP_HEIGHT)).toBe(true);
    expect(backdropMeetsResolution(1290, 2796)).toBe(true);
  });

  it('rejects an asset short on either axis', () => {
    expect(backdropMeetsResolution(MIN_BACKDROP_WIDTH - 1, MIN_BACKDROP_HEIGHT)).toBe(false);
    expect(backdropMeetsResolution(MIN_BACKDROP_WIDTH, MIN_BACKDROP_HEIGHT - 1)).toBe(false);
  });
});

describe('film grain — dither, not texture', () => {
  // Below ~1.5% the 8-bit banding on near-black survives; above ~2% the grain
  // stops reading as film and starts reading as noise.
  it('lands inside the 1.5-2% band at its strongest', () => {
    const strength = effectiveGrainStrength();
    expect(strength).toBeGreaterThanOrEqual(0.015);
    expect(strength).toBeLessThanOrEqual(0.02);
  });

  it('the typical speckle is gentler than the peak', () => {
    // Tile alpha is |uniform(-1,1)| * peak, so the mean is about half.
    expect(effectiveGrainStrength() * 0.5).toBeLessThan(0.012);
  });

  it('is composed of the tile alpha and the layer opacity', () => {
    expect(effectiveGrainStrength()).toBeCloseTo(
      GRAIN_TILE_PEAK_ALPHA * GRAIN_OVERLAY_OPACITY,
      10,
    );
  });
});

describe('slow drift — a place, not wallpaper', () => {
  it('stays within bounds on both axes', () => {
    for (let t = 0; t < DRIFT_PERIOD_MS * 3; t += 997) {
      const { x, y } = driftOffset(t);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
  });

  // A single sine on both axes reads as a pendulum swinging on one line.
  it('traces a path rather than a line', () => {
    const ratios = new Set<string>();
    for (let t = 0; t < DRIFT_PERIOD_MS; t += DRIFT_PERIOD_MS / 40) {
      const { x, y } = driftOffset(t);
      ratios.add((Math.round((x - y) * 20) / 20).toFixed(2));
    }
    expect(ratios.size).toBeGreaterThan(10);
  });

  // Overscan has to cover the drift or the image edge walks into frame.
  it('the overscan covers the amplitude', () => {
    expect(DRIFT_OVERSCAN).toBeGreaterThan(1 + DRIFT_AMPLITUDE);
  });

  it('is slow enough to be felt rather than seen', () => {
    expect(DRIFT_PERIOD_MS).toBeGreaterThanOrEqual(60_000);
  });

  // Reduce Motion freezes the shared clock, so a frozen input must be static.
  it('a frozen clock yields a fixed offset', () => {
    expect(driftOffset(1234)).toEqual(driftOffset(1234));
  });
});
