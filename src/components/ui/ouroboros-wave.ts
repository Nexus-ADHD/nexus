/**
 * A0 SPIKE — travelling-wave deformation of the authored serpent frame.
 *
 * THIS IS THROWAWAY CODE until the spike's kill criteria are answered. It is
 * written as a pure module anyway, because that rule predates the spike and has
 * earned itself: every bug this seam has shipped lived in the COMPONENT, with a
 * correct geometry module handing values to a renderer that transformed them
 * wrongly, and no test could see it because each half was fine alone.
 *
 * WHAT THIS DOES. It displaces the authored body frame RADIALLY by a sine wave
 * that travels along the arc, so the animal undulates the way a snake does. It
 * never synthesises a serpent. Every pixel drawn is the shipped WebP; only where
 * those pixels land moves. That distinction is the whole reason NEX-338 deleted
 * the previous mesh rig, whose generated bodies did not match the authored bite
 * frame ("two completely different snakes").
 *
 * THREE CONSTRAINTS THAT SHAPED THE MATH, none of them obvious:
 *
 *   1. RADIAL, NEVER CARTESIAN. Offsetting each vertex's `y` warps the ring into
 *      an oval and makes the body thicker at the sides than at the top. The
 *      offset has to be applied to the vertex's RADIUS about the hero centre.
 *
 *   2. ZERO AT BOTH ENDS, AND THE FAR END MOVES. The tail is anchored at twelve
 *      o'clock and the head is a separate sprite that can only ROTATE about the
 *      box centre -- it physically cannot follow a radial displacement. So the
 *      wave must taper to nothing at the neck, making the join a stationary
 *      node the head never has to track. And the neck is not at a fixed angle:
 *      it travels from 82 to 360 degrees as the score rises, so the taper is
 *      parameterised by `neckDeg` rather than baked in. A fixed taper would
 *      undulate the neck at low scores and tear the join open.
 *
 *   3. THE DISPLACEMENT MUST DIE BEFORE THE IMAGE EDGE. Vertices carry UVs into
 *      the source bitmap; moving a vertex that sits on the box boundary samples
 *      outside the texture. `radialProfile` falls to zero well inside the frame,
 *      which also keeps the transform local to the body instead of shearing the
 *      whole square.
 */

/**
 * Radius, as a fraction of the box, out to which the body moves at full strength.
 *
 * MEASURED, NOT CHOSEN. Opening the shipped WebPs and taking the radial extent
 * of every pixel with alpha > 12:
 *
 *     frame-020   0.3248 .. 0.4509
 *     frame-060   0.2882 .. 0.4676
 *     frame-100   0.2198 .. 0.4936
 *
 * Two things fall out of that table, and the second one reshaped this module.
 *
 * First, the art is NOT a thin band around the centreline. By the finale it
 * spans a quarter of the box radially, because the head curls inward to reach
 * the tail. So a plateau sized to some assumed body thickness would shear the
 * animal; the plateau has to cover everything the art can occupy.
 *
 * Second, and the reason `GEOMETRY_INSET_PER_AMPLITUDE` exists: at score 100 the
 * outermost gold sits at 0.4936 of the box, which is six thousandths from the
 * frame edge. THERE IS NO ROOM TO DISPLACE OUTWARD. A radial wave applied to the
 * frame as drawn would push the finale's outer edge past the boundary, and a
 * vertex outside the frame samples off-texture -- a torn edge, on the one score
 * that is a ceremony. (This module's own grid test caught it on the first run,
 * which is the argument for keeping the maths out of the component.)
 */
const BAND_PLATEAU = 0.52;

/** Width of the fade from full displacement to none, as a fraction of the box. */
const BAND_FALLOFF = 0.13;

/**
 * How far the drawn image is shrunk per unit of amplitude.
 *
 * The wave then oscillates INSIDE the silhouette the serpent already occupies,
 * so the animal never grows past the envelope the gold budget was measured
 * against. Shrinking is budget-positive (gold area goes as the square of the
 * scale), so this direction can only ever reduce the §19 figure, never raise it.
 *
 * THE VALUE IS FORCED, not chosen. A point at radius R rests at `R(1 - k·a)` and
 * peaks at `R(1 - k·a) + a`, so staying inside the authored envelope needs
 * `k >= 1/R`. The outermost gold measures R = 0.4936 of the box, giving
 * k >= 2.026 -- and the obvious round number, 2, is NOT enough. It fails by
 * about a ten-thousandth of the box, which is invisible in a screenshot and
 * exactly the sort of thing that ships. 2.1 carries the margin.
 */
export const GEOMETRY_INSET_PER_AMPLITUDE = 2.1;

/** Nominal angular width of the ramp at each end of the wave, in degrees. */
const TAPER_DEG = 40;

/** Arc length of one full wave, in degrees. */
export const WAVELENGTH_DEG = 120;

export type Pt = { x: number; y: number };

/** Smooth 0->1 with zero derivative at both ends. Cheaper than a cosine here. */
function smoothstep(t: number): number {
  'worklet';
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Angle of a point measured clockwise from twelve o'clock, in degrees [0,360).
 *
 * Screen y grows DOWNWARD, so twelve o'clock is -y and clockwise is the
 * direction of increasing x. `atan2(dx, -dy)` gives exactly that, which is the
 * same convention `FRAME_HEAD_DEG` is measured in.
 */
export function angleFromTwelve(dx: number, dy: number): number {
  'worklet';
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * How much of the wave survives at this angle: 0 at the tail, 0 at the neck.
 *
 * When the serpent is short the two ramps would overlap and the wave would
 * never reach full strength -- or worse, the ramps would cross and produce a
 * negative weight. Halving the ramp width whenever `neckDeg` is too small to
 * hold two of them keeps the shape continuous at every score, at the cost of a
 * quieter wave on a short animal. That is the right trade: a short serpent is a
 * struggling day, and a violently thrashing one would be the wrong register.
 */
export function angularTaper(deg: number, loDeg: number, hiDeg: number): number {
  'worklet';
  const span = hiDeg - loDeg;
  if (!(span > 0)) return 0;
  const d = deg - loDeg;
  if (d <= 0 || d >= span) return 0;
  const ramp = Math.min(TAPER_DEG, span / 2);
  if (ramp <= 0) return 0;
  const rise = smoothstep(d / ramp);
  const fall = smoothstep((span - d) / ramp);
  return Math.min(rise, fall);
}

/**
 * How much of the wave survives at this radius: 1 across the body, 0 by the edge.
 */
export function radialProfile(r: number, size: number): number {
  'worklet';
  const plateau = BAND_PLATEAU * size;
  if (r <= plateau) return 1;
  return 1 - smoothstep((r - plateau) / (BAND_FALLOFF * size));
}

/**
 * The radial offset, in points, for one point of the mesh.
 *
 * `phase` is in radians and is the only thing that changes between frames, so
 * the caller can advance it from a single clock and keep everything else fixed.
 */
export function waveOffsetAt(
  x: number,
  y: number,
  size: number,
  loDeg: number,
  hiDeg: number,
  phase: number,
  amplitudeFrac: number,
): number {
  'worklet';
  if (amplitudeFrac === 0) return 0;
  const c = size / 2;
  const dx = x - c;
  const dy = y - c;
  const r = Math.hypot(dx, dy);
  if (r === 0) return 0;

  const taper = angularTaper(angleFromTwelve(dx, dy), loDeg, hiDeg);
  if (taper === 0) return 0;
  const profile = radialProfile(r, size);
  if (profile === 0) return 0;

  const wave = Math.sin((angleFromTwelve(dx, dy) / WAVELENGTH_DEG) * 2 * Math.PI - phase);
  return amplitudeFrac * size * taper * profile * wave;
}

/**
 * The undeformed grid and its triangle list.
 *
 * Built once per size and reused every frame -- the texture coordinates ARE
 * these points, because a vertex's UV is where it came FROM, not where the wave
 * puts it. Rebuilding this per frame would be the easiest way to make the spike
 * look slower than it is.
 */
export function buildBaseGrid(
  size: number,
  n: number,
): { points: Pt[]; indices: number[] } {
  const points: Pt[] = [];
  const step = size / n;
  for (let row = 0; row <= n; row++) {
    for (let col = 0; col <= n; col++) {
      points.push({ x: col * step, y: row * step });
    }
  }
  const indices: number[] = [];
  const stride = n + 1;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const tl = row * stride + col;
      const tr = tl + 1;
      const bl = tl + stride;
      const br = bl + 1;
      indices.push(tl, tr, bl, tr, br, bl);
    }
  }
  return { points, indices };
}

/**
 * Where the mesh sits with the wave at rest: the texture grid, shrunk to make
 * room for the displacement. See `GEOMETRY_INSET_PER_AMPLITUDE`.
 */
export function restScale(amplitudeFrac: number): number {
  'worklet';
  return 1 - GEOMETRY_INSET_PER_AMPLITUDE * amplitudeFrac;
}

/**
 * Where one base point lands. The whole displacement, for a single vertex.
 *
 * Extracted so the per-vertex path the device runs and the whole-grid path the
 * Node tests cover are the SAME arithmetic. Skia animates a point array by
 * mutating a stable buffer one entry at a time (`usePointBuffer`), not by
 * swapping in a new array, so the renderer needs a per-point entry point.
 */
export function displacePoint(
  bx: number,
  by: number,
  size: number,
  loDeg: number,
  hiDeg: number,
  phase: number,
  amplitudeFrac: number,
): Pt {
  'worklet';
  const c = size / 2;
  const scale = restScale(amplitudeFrac);
  const dx = (bx - c) * scale;
  const dy = (by - c) * scale;
  // Sampled at the UNSCALED position so a vertex's phase does not shift as the
  // amplitude changes -- otherwise comparing amplitudes compares two waves.
  const off = waveOffsetAt(bx, by, size, loDeg, hiDeg, phase, amplitudeFrac);
  const r = Math.hypot(dx, dy);
  if (off === 0 || r === 0) return { x: c + dx, y: c + dy };
  const k = (r + off) / r;
  return { x: c + dx * k, y: c + dy * k };
}

/**
 * Displace the base grid. Writes into `out` so the render loop can reuse one
 * array across frames rather than allocating a few thousand points per tick.
 *
 * `base` is the TEXTURE grid, in unscaled frame coordinates. The geometry is
 * that grid shrunk by `restScale` and then pushed radially by the wave, so a
 * vertex's UV stays where it came from while its position moves.
 */
export function displaceGrid(
  base: readonly Pt[],
  out: Pt[],
  size: number,
  loDeg: number,
  hiDeg: number,
  phase: number,
  amplitudeFrac: number,
): Pt[] {
  'worklet';
  for (let i = 0; i < base.length; i++) {
    const p = base[i];
    out[i] = displacePoint(p.x, p.y, size, loDeg, hiDeg, phase, amplitudeFrac);
  }
  return out;
}
