/**
 * NEX-43 v9: Galaxy backdrop + Reanimated-derived twinkling field.
 *
 * Architecture pivot (v8 → v9): per-star withRepeat(withSequence(...))
 * animations were fragile across Fast Refresh. Every code edit to this
 * file (or the surrounding tree) caused stars to stop twinkling — the
 * worklet registrations from the previous module instance would drift and
 * the new useEffect would either fail to start a fresh animation or start
 * one that immediately stalled. User repeatedly observed "stars stop
 * twinkling after every edit." Full app reload always fixed it; Fast
 * Refresh broke it.
 *
 * Root cause: per-component animation lifecycles (useEffect setting up
 * withRepeat) are brittle in dev when the bundle hot-swaps. Reanimated 4
 * doesn't reliably tear down the previous worklet's repeat state.
 *
 * Fix: collapse to a SINGLE driving ticker at parent level.
 *   - StarField runs one setInterval (~60fps) that writes a monotonic
 *     `time` SharedValue.
 *   - Each TwinkleDot reads `time` inside useAnimatedStyle and computes
 *     its opacity purely as a function of (time, delay, period,
 *     riseRatio, peak, trough). No useEffect, no withRepeat, no
 *     per-component animation state.
 *
 * (v9.2 fix: started with useFrameCallback, but its time values weren't
 * propagating to the worklets on this Reanimated 4 / Expo SDK 54
 * runtime — stars stayed pinned at trough. Plain JS setInterval driving
 * the SharedValue directly works reliably; cost is one JS→UI bridge
 * crossing per frame which is negligible for opacity-only worklets.)
 *
 * Because each star is a pure derivation of `time`, Fast Refresh tearing
 * down and remounting does the right thing automatically: the new mount
 * starts a fresh setInterval ticker, the derivations recompute, animation
 * resumes without any orphaned state.
 *
 * Layer cake (v10.1):
 *  1. Root view's tokens.color.void background (fallback)
 *  2. expo-image full-bleed quiet night-sky photo (was galaxy/nebula in
 *     v3-v9; swapped in v10 so the app's hero objects — Cosmic Ring on
 *     Home, Eye of God on Command — own the cosmic chroma instead of
 *     fighting a chromatic backdrop)
 *  2.5. Top-chrome scrim — vertical gradient covering only the top
 *     ~280pt of the screen, fades to transparent below. Dims the busy
 *     stars behind status bar + sticky tab headers so chrome controls
 *     have a clean backdrop. Content area (below ~280pt) stays
 *     fully transparent.
 *  3. <TwinkleDot/> children (one per star) — opacity derived from `time`
 *  4. Stack screen content above
 *
 * Performance:
 *  - 1 plain-JS setInterval ticker driving `time` at ~60fps (v9.2 —
 *    useFrameCallback is the known-broken path on this runtime, see above).
 *  - 80 useAnimatedStyle worklets that read time and do ~10 lines of
 *    math each. Cheaper than 80 withRepeat lifecycles.
 *  - iOS suspends Reanimated worklets when backgrounded, so power
 *    management is automatic.
 *
 * IMPORTANT (memory: reanimated_hook_aliases_break_worklets):
 *   Reanimated hook names must NOT be renamed on import. The Babel plugin
 *   detects useFrameCallback / useAnimatedStyle / useSharedValue by exact
 *   identifier name to wrap them into worklets. Renaming → silent crash
 *   at scheduleOnUI.
 */

import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import Svg, {
  Circle as SvgCircle,
  Defs,
  Path,
  RadialGradient as SvgRadialGradient,
  Stop,
} from 'react-native-svg';
import tokens from '@/src/theme/tokens';
import {
  brightnessFraction,
  GLOW_SCALE as OPTICS_GLOW_SCALE,
  glowStops,
  hasSpike,
  spikeGeometry,
  starChroma,
  starOpacity,
  starPeak,
  starSize,
  DRIFT_AMPLITUDE,
  DRIFT_OVERSCAN,
  DRIFT_PERIOD_MS,
  DRIFT_Y_RATE,
} from './starfield-optics';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { FROZEN_TIME_MS, tickerActive } from './starfield-motion';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

// ── Star generation ──────────────────────────────────────────────────────────
// Deterministic seeded RNG so the same {width, height} gives the same field
// layout. Avoids stars jumping on every render.
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

type StarConfig = {
  id: number;
  left: number;
  top: number;
  size: number;
  /** Larger star that renders a 4-point sparkle on top of the glow. */
  spiked: boolean;
  /** Per-star spectral colour — blue-white through amber. */
  color: string;
  /** Full cycle ms — time between flickers for this star. */
  period: number;
  /** Initial offset so stars don't share a phase. */
  delay: number;
  /**
   * Position in the cycle (0-1) where this star's brief flicker begins.
   * Real stars sit steady most of the time and have *discrete* flicker
   * events, not continuous smooth pulses. The flicker window is fixed
   * at FLICKER_WIDTH of the cycle; everything outside it sits at trough.
   * Randomized per star so flicker timing is uncorrelated across the
   * field.
   */
  flickerStart: number;
  /** Brightness at flicker peak. */
  peak: number;
  /** Brightness at rest (most of the cycle). */
  trough: number;
};

// FIXME(nex-56): off-scale star counts — no token, design review.
// Two-pass distribution:
//   1) STAR_COUNT_BASE stars laid out in a jittered grid across the whole
//      usable area — guarantees no big empty patches.
//   2) STAR_COUNT_MID_FILL extra stars dropped via uniform random into the
//      vertical middle band so that section reads denser. The bottom of
//      the screen is covered by the opaque tab bar and the top has the
//      greeting/header chrome eating visible sky, so without this fill
//      the visible middle reads as sparser than the visible edges.
// v3.4: dialed back ~40% from (96+32=128) to (60+20=80). After the
// asymmetric-twinkle landed (v3.3), 128 stars all popping at once read as
// busy/aggressive instead of contemplative. Fewer stars + slower periods =
// closer to "alive but at rest" rather than "field full of activity."
const STAR_COUNT_BASE = 60;
const STAR_COUNT_MID_FILL = 20;
const STAR_COUNT = STAR_COUNT_BASE + STAR_COUNT_MID_FILL;
// Middle band vertical extent — 30% to 70% of usable height. Catches the
// "right middle" zone the user flagged as sparse.
const MID_BAND_TOP_FRAC = 0.3;
const MID_BAND_BOTTOM_FRAC = 0.7;
// NEX-156: two-tier star sizing. Plain "dot" stars (the majority) get the
// smaller range; the SPIKED_STAR_RATIO subset get the larger range and a
// 4-point sparkle so the field reads as actual stars, not uniform dots.
// FIXME(nex-56): off-scale star sizes — no token, design review.
// v4 OPTICS (starfield-optics.ts is the source of truth, vitest-covered).
// The old block was flat by construction: every star sat at opacity >= 0.40
// and was #FFFFFF, so all 80 read as roughly equally bright — the visual
// signature of a particle emitter rather than a sky. Size, brightness, colour
// and spikes are now all derived from power-law draws instead of flat ranges.
// Soft glow radius as a multiple of the core diameter.
// 1.6x the core on three linear stops read as an anti-aliased dot, not light.
const GLOW_SCALE = OPTICS_GLOW_SCALE; // 4.5
// v9.3: lengthened to 4.5-11s. Each star sits at trough for most of its
// cycle, then has a brief flicker event. Period = time between flickers
// for one star. With per-star randomization here, flickers across the
// field are uncorrelated — at any moment some stars are flickering,
// most are resting.
// FIXME(nex-56): off-scale twinkle periods — design review
const PERIOD_MIN_MS = 4500;
const PERIOD_MAX_MS = 11000;
// Fraction of each cycle spent in the flicker event (rise + fall back to
// trough). The rest of the cycle the star sits at trough. 12% feels like
// a discrete "wink" rather than a continuous pulse — at a 7s period that's
// ~840ms of flicker per ~6160ms of rest.
const FLICKER_WIDTH = 0.12;
// Within the flicker window, fraction spent rising vs falling. 25/75 keeps
// the rise sharp (the "snap" of a real twinkle) and the fall gentler.
const FLICKER_RISE_RATIO = 0.25;
// FIXME(nex-56): pure-white star color — intentional deviation from
// tokens.color.text (#F5EFDC). Real stars read as pure-white emission
// sources; cream stars read as "off-color paper dots" on a cosmic ground.
// User-directed override.
// Per-star spectral colour now (starChroma). This stays as the core-render
// fallback only; nothing real is one hue.
const STAR_COLOR = tokens.color.text;
// Precomputed once — the shape never varies per star, only the colour does.
const GLOW_STOPS = glowStops(0.55);
// Small safe-area buffer so stars don't get clipped by the device's
// physical edges. The opaque tab bar will still cover the bottom band;
// that's fine — we want field coverage where it's actually visible.
const EDGE_MARGIN = 24;
// Opacity floor of 0.40 keeps every star always faintly visible against
// the galaxy backdrop; ceiling at 1.0 gives the twinkle real "snap."
// Trough/peak are derived per star (starOpacity / starPeak). Twinkle amplitude
// is PROPORTIONAL, so only the brightest handful visibly flicker — which is why
// a denser field can stay contemplative rather than going busy the way the
// 128-star version did.

// ── Per-star twinkle component ───────────────────────────────────────────────
// Each star owns its own SharedValue + worklet loop. By making this a child
// component (not a hook called N times inside StarField), we satisfy React's
// rules-of-hooks while still scaling to many simultaneous animations.

type TwinkleDotProps = StarConfig & {
  /** Shared frame-clock value (ms since the setInterval ticker started). */
  time: SharedValue<number>;
};

// Memoized: props are stable per dimension (time is a stable SharedValue ref),
// so this only ever needs to render once per star — guards the per-instance
// geometry/path string-building against future parent re-renders.
const TwinkleDot = React.memo(function TwinkleDot({ id, left, top, size, spiked, color, period, delay, flickerStart, peak, trough, time }: TwinkleDotProps) {
  // Pure derivation: opacity is a function of (time, this star's params).
  // No useEffect, no withRepeat — Fast Refresh can't desync what isn't
  // stateful. The worklet captures the JS-side numeric props by value
  // at first render; they don't change (stars memo is stable per
  // dimension), so capture is correct.
  //
  // v9.5 cycle shape: TWO motions running simultaneously.
  //   1. Always-on micro-scintillation. Each star has a continuous,
  //      low-amplitude chaotic wobble around trough (sum of two sines at
  //      different per-star frequencies — non-periodic-looking, never
  //      reads as a smooth pulse). Means every star is always visibly
  //      twinkling. ~15% of (peak-trough) range.
  //   2. Discrete flicker events. Once per cycle, a sharp brightening
  //      from the wobbling base up to peak and gently back down. This
  //      is the "snap" of a real twinkle, layered ON TOP of the
  //      continuous wobble.
  //
  // Result: every star is always moving, but with the chaotic feel of
  // real atmospheric scintillation, plus occasional brighter winks.
  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    const elapsed = time.value - delay;
    const tSec = Math.max(0, elapsed) / 1000;

    // ── Layer 1: always-on micro-scintillation ──────────────────────────
    // Two sines at different per-star frequencies, summed and normalized
    // to [0..1]. The non-integer ratio between frequencies means the
    // combined wave is quasi-periodic — never looks like a clean pulse.
    const freqA = 0.45 + flickerStart * 0.55;     // 0.45-1.0 Hz per star
    const freqB = 1.10 + (delay / 5000) * 0.8;    // 1.10-1.90 Hz per star
    const phaseA = delay * 0.003;
    const phaseB = flickerStart * 6.28;
    const waveA = Math.sin(tSec * freqA * 2 * Math.PI + phaseA);
    const waveB = Math.sin(tSec * freqB * 2 * Math.PI + phaseB);
    // Weighted sum keeps the lower frequency dominant — feels like
    // a slow breath with faster chitter on top.
    const combined = waveA * 0.65 + waveB * 0.35; // [-1..1]
    const microNorm = (combined + 1) * 0.5;       // [0..1]
    // Micro-amplitude: 18% of the peak-trough range.
    const microRange = (peak - trough) * 0.18;
    let op = trough + microRange * microNorm;

    // NEX-156: during the discrete flicker the whole star scales up a touch
    // so the wink reads as the spikes/glow flaring outward. Hoisted here
    // because flickerAmt is block-scoped inside the flicker window below.
    let scale = 1;

    // ── Layer 2: discrete flicker event ────────────────────────────────
    if (elapsed >= 0) {
      const cyclePos = (elapsed % period) / period;
      if (cyclePos >= flickerStart && cyclePos < flickerStart + FLICKER_WIDTH) {
        const flickerPos = (cyclePos - flickerStart) / FLICKER_WIDTH;
        let flickerAmt: number;
        if (flickerPos < FLICKER_RISE_RATIO) {
          // Sharp rise — ease-out cubic
          const t = flickerPos / FLICKER_RISE_RATIO;
          flickerAmt = 1 - Math.pow(1 - t, 3);
        } else {
          // Gentler fall — ease-in quadratic
          const t = (flickerPos - FLICKER_RISE_RATIO) / (1 - FLICKER_RISE_RATIO);
          flickerAmt = 1 - t * t;
        }
        // Pull op toward peak by flickerAmt. At flickerAmt=1 we hit
        // peak; at flickerAmt=0 we stay at the micro-wobble level.
        op = op + (peak - op) * flickerAmt;
        // Spiked stars flare more (bigger sparkle); dots barely scale.
        scale = 1 + flickerAmt * (spiked ? 0.22 : 0.1);
      }
    }

    return { opacity: op, transform: [{ scale }] };
  });

  // ── Geometry ───────────────────────────────────────────────────────────────
  // `reach` is the content radius from center (longer vertical spike for spiked
  // stars, else the glow radius). `half` pads that by the flicker flare factor
  // so the scale-up wink (transform below) flares *outward* to the box edge
  // instead of getting clipped at it — the box is center-anchored and the
  // transform scales about the center.
  const glowR = GLOW_SCALE * size;
  const coreR = size / 2;
  // Spike length scales with BRIGHTNESS (spikeLength), not with the core —
  // a big dim star should not out-sparkle a small blazing one.
  const spike = spiked ? spikeGeometry(size, brightnessFraction(trough)) : null;
  const reach = spike ? Math.max(spike.vertical, glowR) : glowR;
  const maxFlare = 1 + (spiked ? 0.22 : 0.1);
  const half = reach * maxFlare;
  const box = 2 * half;
  // The laid-out left/top is the core's top-left corner. Shift the (larger,
  // center-anchored) box so the core stays exactly where makeStar placed it.
  // Box center sits at `half`; the core center should sit at size/2 from the
  // original left/top, so the box's top-left moves back by (half - size/2).
  const wrapperLeft = left - (half - coreR);
  const wrapperTop = top - (half - coreR);
  const gradId = `star-glow-${id}`;

  // ── 4-point sparkle path (spiked stars only) ─────────────────────────────────
  // Built from interpolated numbers (ASCII '-'). Each side is a quadratic with
  // its control point at the center, so the sides bow inward → concave-sided ✦
  // with sharp tips. Vertical tips (V) longer than horizontal (H). Only the
  // spiked top decile render the <Path>, so skip the string build for plain dots.
  let sparkleD: string | null = null;
  if (spike) {
    const c = half;
    // Same geometry that sized `reach` above — one source, so the box can
    // never be drawn larger than what it contains.
    const V = spike.vertical;
    const H = spike.horizontal;
    sparkleD = `M ${c},${c - V} Q ${c},${c} ${c + H},${c} Q ${c},${c} ${c},${c + V} Q ${c},${c} ${c - H},${c} Q ${c},${c} ${c},${c - V} Z`;
  }

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: wrapperLeft,
          top: wrapperTop,
          width: box,
          height: box,
        },
        animatedStyle,
      ]}
    >
      <Svg width={box} height={box}>
        <Defs>
          <SvgRadialGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            cx={half}
            cy={half}
            fx={half}
            fy={half}
            r={glowR}
          >
            {/* Gamma falloff (glowStops): blazing core, steep decay, long
                tail — ~75% of the alpha is gone by 18% of the radius. Three
                LINEAR stops read as a circle with a soft edge, not as light. */}
            {GLOW_STOPS.map((stop) => (
              <Stop
                key={stop.offset}
                offset={String(stop.offset)}
                stopColor={color}
                stopOpacity={stop.alpha}
              />
            ))}
          </SvgRadialGradient>
        </Defs>
        <SvgCircle cx={half} cy={half} r={glowR} fill={`url(#${gradId})`} />
        {sparkleD ? <Path d={sparkleD} fill={color} fillOpacity={0.85} /> : null}
        <SvgCircle cx={half} cy={half} r={coreR} fill={color} />
      </Svg>
    </Animated.View>
  );
});

// ── StarField ────────────────────────────────────────────────────────────────

export function StarField() {
  const { width, height } = useWindowDimensions();

  // ── Global frame clock ─────────────────────────────────────────────────────
  // One SharedValue, written from a plain JS setInterval. Every TwinkleDot
  // reads from this to derive its opacity. Replacing 80 per-star withRepeat
  // lifecycles with one shared ticker is what makes the field survive Fast
  // Refresh — there's no per-star animation state to desync when the
  // module hot-swaps.
  //
  // v9.0 used useFrameCallback. v9.1 switched its property from
  // info.timestamp to info.timeSinceFirstFrame. Both failed to drive
  // time.value on this Reanimated 4 / Expo SDK 54 runtime — twinkle
  // stayed pinned at trough. Replacing the Reanimated frame API with
  // a plain JS setInterval driving the SharedValue directly is
  // bulletproof: it doesn't rely on worklet auto-wrapping, the UI
  // thread frame loop, or any Reanimated-specific frame primitive.
  // Cost: time updates cross JS→UI every 16ms instead of being UI-
  // native. Negligible for 80 dots running opacity-only worklets.
  // Reduce Motion (§6.6): freeze the twinkle field. Init the clock at the
  // frozen frame so a reduce-motion user (or the brief pre-resolve window)
  // never sees a first-frame twinkle.
  const { reduceMotion, resolved } = useReduceMotion();
  const time = useSharedValue(FROZEN_TIME_MS);

  // Very slow drift on the baked layer. Macro movement is what separates a
  // place from wallpaper, and it needs no scroll plumbing — deriving it from
  // the SAME clock the stars read means Reduce Motion, which freezes that
  // ticker, makes this static for free. Two different periods give a Lissajous
  // path so the motion never visibly repeats; DRIFT_OVERSCAN covers the travel
  // so the image edge can't walk into frame.
  const backdropDriftStyle = useAnimatedStyle(() => {
    const phase = (time.value % DRIFT_PERIOD_MS) / DRIFT_PERIOD_MS;
    const tau = Math.PI * 2;
    const dx = Math.sin(phase * tau) * DRIFT_AMPLITUDE * width;
    const dy = Math.cos(phase * tau * DRIFT_Y_RATE) * DRIFT_AMPLITUDE * height;
    // TS widens a mixed transform array into a union it can't match against
    // ViewStyle['transform']; the shape is correct at runtime. Same friction
    // every RN codebase hits with multi-op transforms.
    return {
      transform: [
        { scale: DRIFT_OVERSCAN },
        { translateX: dx },
        { translateY: dy },
      ] as unknown as ViewStyle['transform'],
    };
  });
  useEffect(() => {
    // Freeze: stop the ticker and leave `time` at its CURRENT value, so
    // toggling Reduce Motion on while the field is animating holds the exact
    // frame the user was seeing instead of jumping to the FROZEN_TIME_MS phase.
    // The cold-start / pre-resolve frozen frame comes from the useSharedValue
    // init above (never written here, so there's nothing to jump).
    if (!tickerActive(reduceMotion, resolved)) return;
    // Resume from the current phase, not 0 — otherwise toggling Reduce Motion
    // off lurches the field back to the start of the cycle.
    const start = Date.now() - time.value;
    const id = setInterval(() => {
      time.value = Date.now() - start;
    }, 16); // ~60fps
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- time is a stable SharedValue
  }, [reduceMotion, resolved]);

  // Stable star positions for this dimension. Two-pass distribution
  // (see STAR_COUNT_BASE / STAR_COUNT_MID_FILL comments above for why).
  const stars = useMemo<StarConfig[]>(() => {
    const rand = seededRandom(Math.floor(width * 31 + height));
    const usableW = Math.max(1, width - EDGE_MARGIN * 2);
    const usableH = Math.max(1, height - EDGE_MARGIN * 2);

    const result: StarConfig[] = [];
    let id = 0;

    // Per-star randomization, broken out so both passes reuse it.
    const makeStar = (left: number, top: number): StarConfig => {
      const starId = id++;
      // NEX-156: derive `spiked` from a hash of the id, NOT from rand().
      // Pulling a rand() here would shift the shared seeded stream and move
      // every subsequent star's position. A Knuth-multiplicative hash of the
      // id gives a ~25% split decorrelated from creation order while leaving
      // the rand() call-count (and therefore positions + twinkle character)
      // byte-identical to the pre-NEX-156 field.
      // Brightness is the star's identity now: it drives peak, colour and
      // whether it earns a diffraction spike. Spikes are an artefact of BRIGHT
      // sources, so they follow brightness rather than a flat 25% of the field.
      const trough = starOpacity(rand());
      const bright = brightnessFraction(trough);
      const spiked = hasSpike(bright);
      // Proportional amplitude: a faint star flickers faintly, a bright one
      // snaps. Physically right, and it keeps the field at rest.
      const peak = starPeak(trough);
      // size: one rand() draw (same position in the stream as before), mapped
      // into the matching tier so the stream stays aligned.
      const size = starSize(rand());
      const color = starChroma(rand(), bright);
      return {
        id: starId,
        left,
        top,
        size,
        spiked,
        color,
        period: PERIOD_MIN_MS + Math.floor(rand() * (PERIOD_MAX_MS - PERIOD_MIN_MS)),
        // Larger delay range (0-5s, was 0-2s) since cycles are longer now.
        // Spreads first-flicker times further apart on initial mount.
        delay: Math.floor(rand() * 5000),
        // flickerStart in 0.10-0.78 — keeps the flicker window
        // (flickerStart..flickerStart+FLICKER_WIDTH = 0.12) inside the
        // [0,1] cycle without wrap.
        flickerStart: 0.10 + rand() * 0.78,
        peak,
        trough,
      };
    };

    // ── Pass 1: jittered grid across whole usable area ─────────────────
    // Cells proportional to screen aspect ratio so spacing isn't squashed.
    const aspect = usableW / usableH;
    const rows = Math.max(2, Math.round(Math.sqrt(STAR_COUNT_BASE / aspect)));
    const cols = Math.max(2, Math.ceil(STAR_COUNT_BASE / rows));
    const cellW = usableW / cols;
    const cellH = usableH / rows;

    for (let r = 0; r < rows && id < STAR_COUNT_BASE; r++) {
      for (let c = 0; c < cols && id < STAR_COUNT_BASE; c++) {
        // Wider jitter range (10%-90%) than before — stars can land
        // closer to cell boundaries, breaking up any grid artifact.
        const jx = 0.1 + rand() * 0.8;
        const jy = 0.1 + rand() * 0.8;
        result.push(
          makeStar(EDGE_MARGIN + (c + jx) * cellW, EDGE_MARGIN + (r + jy) * cellH),
        );
      }
    }

    // ── Pass 2: middle-band fill ───────────────────────────────────────
    // Uniform random inside the vertical middle band. The horizontal range
    // is the full usable width, so this also picks up the "right middle"
    // gap the user flagged.
    const midBandTop = EDGE_MARGIN + usableH * MID_BAND_TOP_FRAC;
    const midBandHeight = usableH * (MID_BAND_BOTTOM_FRAC - MID_BAND_TOP_FRAC);
    for (let i = 0; i < STAR_COUNT_MID_FILL; i++) {
      result.push(
        makeStar(EDGE_MARGIN + rand() * usableW, midBandTop + rand() * midBandHeight),
      );
    }

    return result;
  }, [width, height]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* Layer 1: full-bleed quiet night-sky photo.
          v10: swapped from the galaxy/nebula image to a dark sky with
          stars. Reasoning — the app's two hero objects (Cosmic Ring on
          Home, Eye of God on Command) both carry their own cosmic
          chroma. Stacking them on a colorful nebula backdrop drowns
          them out. A quiet dark sky lets the heroes pop and ditches
          the legibility fight we had against bright nebula peaks. */}
      <Animated.View style={[StyleSheet.absoluteFill, backdropDriftStyle]}>
      <Image
        source={require('../../../assets/images/cosmic-field-bg.png')}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        contentPosition="center"
        cachePolicy="memory-disk"
        transition={0}
        priority="high"
      />
      </Animated.View>
      {/* Layer 1.5: TOP CHROME SCRIM. v10.1 reintroduces a focused
          top-down gradient — only the top ~280pt of the screen, fading
          to transparent below. Purpose: dim the busy stars *behind*
          status bar + sticky tab headers (ALL/BUSINESS/VISION/PERSONAL
          on Align, ACTIVE/ARCHIVED + input on Inbox, etc.) so the
          chrome controls have a clean backdrop. The lower portion of
          the screen — where content cards live — stays fully transparent
          so the night sky reads at full brightness behind them.
          Unlike v3.2's mid-band scrim (which dimmed bright nebula
          peaks), this scrim is localized to the chrome zone and doesn't
          touch the cosmic field around content. */}
      <LinearGradient
        colors={[
          'rgba(2, 2, 8, 0.85)',
          'rgba(2, 2, 8, 0.55)',
          'rgba(2, 2, 8, 0.00)',
        ]}
        locations={[0, 0.55, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 280,
        }}
        pointerEvents="none"
      />
      {/* Layer 2: animated twinkle dots. One <TwinkleDot/> per star, each
          running its own Reanimated worklet on the UI thread. */}
      {stars.map((s) => (
        <TwinkleDot
          key={s.id}
          id={s.id}
          color={s.color}
          left={s.left}
          top={s.top}
          size={s.size}
          spiked={s.spiked}
          period={s.period}
          delay={s.delay}
          flickerStart={s.flickerStart}
          peak={s.peak}
          trough={s.trough}
          time={time}
        />
      ))}
    </View>
  );
}
