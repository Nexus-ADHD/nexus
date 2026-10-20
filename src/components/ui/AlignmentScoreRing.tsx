import Svg, {
  Circle as SvgCircle,
  Defs,
  RadialGradient as SvgRadialGradient,
  Stop,
} from 'react-native-svg';
import { haptic } from '@/src/utils/haptics';
import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import tokens from '@/src/theme/tokens';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { OuroborosSerpent } from './OuroborosSerpent';
import { SERPENT_BOX_SCALE } from './ouroboros-frames';


// ─── Types ────────────────────────────────────────────────────────────────────

export type AlignmentScoreRingProps = {
  score: number;
  qualitativeWord?: string;
  label?: string;
  size?: number;
  milestone?: boolean;
  supportingLine?: string;
  /**
   * NEX-121: when false, render the arc/geometry ONLY — hide the numeral +
   * qualitative word + supporting line, and DON'T expose the numeric score to
   * VoiceOver. Used by the locked "paywall as content" preview, where the score
   * VALUE is premium-gated and must not leak (visually or via screen reader);
   * only the arc SHAPE shows. Default true (all existing call sites unchanged).
   */
  showValue?: boolean;
  onPress?: () => void;
  testID?: string;
  style?: ViewStyle;
};

// ─── Constants ────────────────────────────────────────────────────────────────

// Bumped from 180 → 216 to give the bold gold arc + count-up numeral the room
// the designer's "Paper Cosmic Ring" handoff assumes (ring radius ≈ 0.73× the
// numeral height in the source comp).
const DEFAULT_SIZE = 264;

const EASE_OUT       = Easing.bezier(0.2, 0, 0, 1);
const EASE_IN_OUT    = Easing.bezier(0.4, 0, 0.6, 1);

// Designer count-up: 1400ms, ease-out cubic (1 - (1-t)^3).
const COUNT_UP_MS = 1400;

// §5.5: hero display numerals honor Dynamic Type but clamp (never shrink, never
// blow out of the fixed-size ring). The ring is a fixed `size`×`size` circle, so
// the whole stacked composition (eyebrow + numeral + word + sub) shares one
// clamp. 1.5 keeps even a 3-digit "100" (mono, ~1.8em wide) inside the ring;
// §5.5 names accessibility2 (~1.88) but that overflows the circle here, so we
// clamp slightly tighter — the geometric constraint wins over the nominal stop.
const HERO_MAX_FONT_SCALE = 1.5;
const RESCORE_MS  = 700;

// Ring content spacing (NEX-157 addendum, 2026-06-07 device check). Equal gaps
// above and below the numeral (one constant so they can't drift), plus an
// optical-centering nudge: with equal gaps the only remaining asymmetry is the
// flanking line heights (word 30 vs eyebrow 16), so the numeral would sit
// (30−16)/2 = 7pt above the ring centre. Shift the content block down by that
// to land the numeral on the ring's horizontal diameter.
const CONTENT_GAP          = 12;
const EYEBROW_LINE_HEIGHT  = tokens.type.labelTrackedLg.lineHeight; // 16
const WORD_LINE_HEIGHT     = 30;
const CONTENT_OPTICAL_SHIFT = (WORD_LINE_HEIGHT - EYEBROW_LINE_HEIGHT) / 2; // 7pt down

// Bloom motion (NEX-157). The glow is now a radially-symmetric SVG "horizon
// bloom" hugging the gold arc, not a captured multicolor shader frame. A
// radially symmetric bloom makes rotation invisible, so the old 25s spin is
// gone (see header note); only the sanctioned one-time bloom-in + slow ambient
// breath remain (CLAUDE.md §1.4 ring exception). HALO_BLOOM_MS is the initial
// fade-in; BLOOM_SETTLE_MS is the delay AFTER the fade-in before the breath
// begins (so the bloom settles first); BREATHE_HALF_MS is half a breath cycle.
const HALO_BLOOM_MS    = 600;   // initial bloom fade-in (0 → 0.8)
const BLOOM_SETTLE_MS  = 1800;  // delay after fade-in before the breath starts
const BREATHE_HALF_MS  = 2500;  // half of one breath cycle (in / out)

// Horizon-bloom geometry (NEX-157). The bloom is ONE smooth radial-gradient
// disc behind the ring — a single soft glow that peaks just outside the arc and
// fades continuously outward (gold → faint teal → void) with no visible band
// edges — plus a radial inner-atmosphere disc inside the main ring Svg for the
// gap glow. (Earlier this layer was three discrete stroked circles; they read
// as separate rings, so they were merged into one gradient.)
//
// Bloom Svg/View box = size × this. Oversized so the glow's outer radius
// survives the milestone flare scale-up without clipping a square edge. Worst
// case must hold:  bloomOuterR · maxScale  <  bloomBox/2,  where
// maxScale ≈ 0.985 + 0.045 + flarePeak·0.26 (≈1.16 at flarePeak 0.5). At 1.4,
// LHS ≈ 0.561·size·1.16 ≈ 0.651·size vs RHS 0.70·size. (The outer edge is fully
// transparent regardless, so any overrun is invisible.) If you raise
// BLOOM_OUTER_MULT, the flare peak, or the scale coefficients, re-check this.

// The serpent is drawn into a box LARGER than the ring, and that is the only way
// it rides the halo instead of crowding the numeral. Its centreline sits at
// RING_FRAC = 0.38714 of whatever box it is given, while the halo's OUTER edge is
// arcRadius + arcStroke/2 = 0.44875*size.
//
// `SERPENT_BOX_SCALE` lives in `ouroboros-frames.ts` and is the ONLY sizing lever
// left. Under the rig it paired with a `BODY_THICKNESS` that drew the body at 0.7
// of the art's real silhouette, so box and thickness had to be read together;
// every score is authored art now, at native thickness, so the box moves the
// whole animal and nothing else does.
//
// It cannot both hug the halo and clear the card. The art's inner:outer ratio is
// fixed, so pinning the inner edge to the halo would put the outer edge at
// 0.672*size — further out than the 1.36 box that was already overlapping
// TODAY'S WIN. Shrinking necessarily pulls both edges inward. 1.24 is chosen for
// the card (see the constant's own note); if the track ever peeks out from under
// the body's inner edge, the fix is a small `arcRadius` reduction, not a bigger box.
const BLOOM_BOX_SCALE   = 1.4;
const BLOOM_OUTER_MULT  = 5.5;  // bloom outer radius = arcRadius + arcStroke × this
const BLOOM_OP_PEAK     = 0.30; // gold glow peak opacity (just outside the arc)
const BLOOM_OP_MID      = 0.12; // gold mid-falloff opacity
const BLOOM_OP_TEAL     = 0.05; // faint teal hint near the outer edge
const BLOOM_ATMO_OP     = 0.10; // inner-atmosphere gold peak opacity

const TRACK_COLOR  = 'rgba(229,186,110,0.18)'; // app gold (tokens.color.gold) @18% — no rgba token at this alpha

// Qualitative word bands — CLAUDE.md §18.4
const SCORE_BANDS = [
  { min: 90, word: 'Rising'   },
  { min: 75, word: 'Steady'   },
  { min: 60, word: 'Holding'  },
  { min: 45, word: 'Drifting' },
  { min: 0,  word: 'Quiet'    },
] as const;

function resolveWord(clamped: number): string {
  return SCORE_BANDS.find(b => clamped >= b.min)?.word ?? 'Quiet';
}

// NEX-124: lowercase band key for analytics (`score_band` on
// first_alignment_score_seen). Reuses SCORE_BANDS so it can't drift from the
// displayed qualitative word.
export function scoreBandKey(score: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return (SCORE_BANDS.find(b => clamped >= b.min)?.word ?? 'Quiet').toLowerCase();
}

// NOTE: the in-ring Skia star-particulate shader was removed along with the
// Skia canvas. The global StarField already renders behind every screen, so the
// ring sat on "the same sky" regardless; the local copy was redundant.

// Layer 2 — Horizon bloom (NEX-157). SUPERSEDES the captured-halo PNG.
// Until NEX-157 this layer was `assets/images/cosmic-halo.png`: the designer's
// web-only WebGL shader (@paper-design PulsingBorder) rendered headless and
// screenshotted to a frozen frame, composited behind the ring at 1.46× and
// rotated 25s/turn so its multicolor lobes swept the ring. Against the v10
// quiet night-sky backdrop those magenta/red lobes read as noise (designer:
// "not quite there"). Approved direction (Cowork 2026-06-07): replace it with
// an SVG "horizon bloom" built into the ring's own Svg stack — warm gold core
// hugging the arc, fading through a faint teal hint into void, the way a planet
// horizon glows. It is radially symmetric, so the 25s rotation it depended on
// is gone (rotation of a symmetric bloom is invisible); only the sanctioned
// one-time bloom-in + slow ambient breath remain. See the bloom geometry
// constants above and the bloom layer in the subtree below.

// ─── Component ────────────────────────────────────────────────────────────────

export function AlignmentScoreRing({
  score,
  qualitativeWord,
  label = "TODAY'S ALIGNMENT",
  size = DEFAULT_SIZE,
  milestone = false,
  supportingLine,
  showValue = true,
  onPress,
  testID,
  style,
}: AlignmentScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, score));
  const word    = qualitativeWord ?? resolveWord(clamped);

  // ── Shared values ─────────────────────────────────────────────────────────

  const haloBreatheAnim    = useSharedValue(0);   // blooms to 0.8 on mount, then breathes
  const haloFlareAnim      = useSharedValue(0);   // additive boost during milestone
  const contentOpacityAnim = useSharedValue(0);
  const scaleAnim          = useSharedValue(1);

  // Count-up numeral lives on the JS side (RN <Text/> can't animate its
  // children on the UI thread). Since NEX-334 the serpent is driven from the
  // SAME rAF tick, so the two are frame-locked to each other by construction
  // rather than being two timers sharing a curve — the drift the arc used to be
  // able to develop under heavy JS load is gone with the arc. Initialised to the
  // real score so still frames (snapshots, the reduce-motion path) never show
  // "0"; the mount animation explicitly counts up from 0.
  const [displayScore, setDisplayScore] = useState(() => Math.round(clamped));
  const displayScoreRef = useRef(Math.round(clamped)); // mirrors displayScore without re-triggering effects
  // The serpent follows a FRACTIONAL score while the numeral shows a rounded
  // one. They share the same curve and the same tick, so they stay in step, but
  // the numeral only needs to change when its integer does while the serpent
  // would visibly stair-step if it did the same: on a re-score of a few points
  // the head would jump once per point instead of travelling. Measured at
  // 0.2ms per rebuild, so a rebuild per frame is affordable for a one-shot.
  // Starts at ZERO, not at the score, and that is load-bearing. Both writers
  // below early-return until `rmResolved`, so whatever this is initialised to is
  // what paints during the async reduce-motion read. Initialised to `clamped`,
  // the serpent painted at FULL LENGTH and then snapped backwards to near-zero
  // on the first frame of the count-up. Zero draws nothing at all
  // (`serpentPlan(0).layers` is empty), which is the correct still frame — the
  // numeral beside it still carries the score, so nothing is lost. (NEX-334.)
  const [serpentScore, setSerpentScore] = useState(() => 0);

  // Reactive reduce-motion (shared hook). `rmResolved` gates the mount ceremony
  // + count-up so reduce-motion users never get an animation scheduled before
  // the async pref is known; `rm` re-renders on a live Settings toggle.
  const { reduceMotion: rm, resolved: rmResolved } = useReduceMotion();
  const isFirstRender = useRef(true);
  // True once the entrance bloom-in has played. A live Reduce-Motion-off toggle
  // re-runs the mount-sequence effect; on that resume we skip the bloom-in +
  // settle delay and start the breath immediately.
  const hasEnteredRef = useRef(false);

  // ── Geometry ──────────────────────────────────────────────────────────────

  const cx = size / 2;
  const cy = size / 2;

  // Geometry matched to the designer's client source (canvas 800, ring r=350,
  // stroke=18, seed-dot Ø68). Ratios: arcRadius 350/800=0.4375, arcStroke
  // 18/800=0.0225, dot core 34/800=0.0425. The previous arcStroke (0.045) was
  // exactly DOUBLE the designer's — that thick band was the heavy white annulus
  // on the TestFlight build. These restore the thin gold ring from the comp.
  const arcRadius  = size * 0.4375;        // 350/800 — ring centreline radius
  const arcStroke  = size * 0.0225;        // 18/800  — thin gold stroke (was 2× too thick)
  const wellRadius = arcRadius - arcStroke / 2 - 4; // dark inner well

  // Viewport padding so the seed dot's glow (sitting ON the arc at 12/6 o'clock,
  // i.e. cy ± arcRadius) isn't clipped by the Svg viewport at the top and bottom
  // of the ring. The main ring Svg's box is exactly size×size, but dotGlowR pushes
  // the glow ~0.0125·size past that edge; pad every side by >= dotGlowR. Interior
  // coordinates stay in 0..size space (the viewBox is offset by -RING_PAD), so the
  // ring renders identically — it just gains room on every edge.
  const RING_PAD = Math.ceil(size * 0.075) + 2; // >= dotGlowR

  // Horizon-bloom geometry (NEX-157). The bloom lives in its own oversized Svg
  // (BLOOM_BOX_SCALE) so the widest stroke + the milestone flare scale-up never
  // clip a square edge; its circles are centered at the oversized box's center
  // with radius = arcRadius, and the box is inset (negative) to sit centered
  // over the ring, so the bloom hugs the arc.
  // Serpent box — oversized so the animal orbits ON the ring track rather than
  // inside it, and inset (negative) so the bigger box stays centred on the ring.
  // Same device as the bloom box below.
  const serpentBox   = size * SERPENT_BOX_SCALE;
  const serpentInset = (size - serpentBox) / 2;

  const bloomBox    = size * BLOOM_BOX_SCALE;
  const bloomC      = bloomBox / 2;
  const bloomInset  = (size - bloomBox) / 2; // negative — centers the bigger box
  // Single-gradient bloom. The glow peaks just outside the arc (track outer
  // edge) and fades both inward (to nothing, so it never washes the well) and
  // outward through a faint teal hint to fully transparent. Stop offsets are
  // fractions of bloomOuterR, derived from the real radii so the ramp tracks
  // any size — strictly ascending: 0 < fInner < fPeak < fMid < fTeal < 1.
  const bloomOuterR = arcRadius + arcStroke * BLOOM_OUTER_MULT;
  const fInner      = (arcRadius - arcStroke * 2) / bloomOuterR;   // inner fade start
  const fPeak       = (arcRadius + arcStroke * 0.5) / bloomOuterR; // peak at track outer edge
  const fMid        = (arcRadius + arcStroke * 2.5) / bloomOuterR; // gold mid falloff
  const fTeal       = (arcRadius + arcStroke * 4) / bloomOuterR;   // teal hint
  // Inner-atmosphere disc (drawn in the MAIN Svg, between well and track). Gold
  // is confined to the well↔track gap by deriving the gradient's inner stop from
  // the real radii, so it never hazes the well interior (Codex must-fix).
  const atmoRadius = arcRadius - arcStroke / 2; // = track inner edge
  const atmoStopIn = wellRadius / atmoRadius;   // where gold starts (~0.96)

  // ── Reduce motion detection + snap ────────────────────────────────────────

  useEffect(() => {
    if (!rmResolved || !rm) return;
    // Reduce motion (initial OR a live toggle on): cancel any running motion and
    // snap to the resting state. cancelAnimation is required — a bare value
    // write would be overwritten on the next frame by the breath's withRepeat
    // or the count-up's withTiming.
    cancelAnimation(haloBreatheAnim);
    cancelAnimation(haloFlareAnim);
    cancelAnimation(contentOpacityAnim);
    haloBreatheAnim.value    = 0.8;
    haloFlareAnim.value      = 0;
    contentOpacityAnim.value = 1;
    displayScoreRef.current  = Math.round(clamped);
    setSerpentScore(clamped);
    setDisplayScore(Math.round(clamped));
    // The snap leaves the ring in its settled (post-entrance) state, so a later
    // Reduce-Motion-off toggle should resume the breath immediately rather than
    // replay the bloom-in + settle. Mark entered here too (not only in the bloom
    // path) so a cold-start-with-RM-on user gets an immediate resume.
    hasEnteredRef.current = true;
  }, [rmResolved, rm]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount sequence (halo + stars + content fade) ──────────────────────────

  useEffect(() => {
    if (!rmResolved) return;   // wait until reduce-motion pref is known
    if (rm) return;            // reduce motion: snap handled by the effect above

    // The breath: the repeat starts with the EXHALE (→0.6) so every cycle spans
    // the same 0.6 ↔ 1.0 amplitude (opening on the inhale would make the first
    // swell half-range from the 0.8 bloom rest). Factored so the entrance and a
    // live resume share one definition.
    const breath = withRepeat(
      withSequence(
        withTiming(0.6, { duration: BREATHE_HALF_MS, easing: EASE_IN_OUT }),
        withTiming(1.0, { duration: BREATHE_HALF_MS, easing: EASE_IN_OUT }),
      ),
      -1,
      false,
    );

    if (hasEnteredRef.current) {
      // Live Reduce-Motion-off resume: the bloom already bloomed (the snap left
      // haloBreatheAnim at 0.8 / content at 1), so start the breath immediately
      // instead of replaying the ~2.4s bloom-in (600ms) + settle (1800ms).
      haloBreatheAnim.value = breath;
      contentOpacityAnim.value = 1;
      return;
    }
    hasEnteredRef.current = true;

    // First entrance: bloom in (0→0.8 over 600ms), hold while it settles, then
    // breathe forever.
    haloBreatheAnim.value = withSequence(
      withTiming(0.8, { duration: HALO_BLOOM_MS, easing: EASE_OUT }),
      withDelay(BLOOM_SETTLE_MS, breath),
    );
    contentOpacityAnim.value = withTiming(1, { duration: 500, easing: EASE_OUT });
  }, [rmResolved, rm]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Count-up: arc (UI thread) + numeral (JS), gated on reduce-motion ──────

  useEffect(() => {
    // Wait until the reduce-motion preference is known before animating, so
    // reduce-motion users never get a count-up scheduled (the check above
    // resolves asynchronously).
    if (!rmResolved) return;

    const wasFirst = isFirstRender.current;
    isFirstRender.current = false;
    const duration   = wasFirst ? COUNT_UP_MS : RESCORE_MS;

    // Reduce motion: snap arc + numeral to the final value, no animation.
    if (rm) {
      displayScoreRef.current = Math.round(clamped);
      setDisplayScore(Math.round(clamped));
      setSerpentScore(clamped);   // the serpent snaps too; it never travels here
      return;
    }


    // Numeral counts up on the JS thread with the same curve so it stays in
    // step with the arc. Pure setState — no shared-value writes, no Skia calls.
    // First mount counts from 0 (the designer's intent); a later re-score
    // counts from whatever is currently displayed.
    const fromScore = wasFirst ? 0 : displayScoreRef.current;
    const toScore   = Math.round(clamped);
    const startedAt = Date.now();
    let raf = 0;
    let lastShown = -1;

    const tick = () => {
      const t     = Math.min((Date.now() - startedAt) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic (matches handoff)
      const exact = fromScore + (toScore - fromScore) * eased;
      const shown = Math.round(exact);
      // Every frame for the serpent, only on a change for the numeral. React
      // batches the two into one render, so this costs a mesh rebuild, not a
      // second pass.
      setSerpentScore(exact);
      if (shown !== lastShown) {
        lastShown = shown;
        displayScoreRef.current = shown;
        setDisplayScore(shown);
      }
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        displayScoreRef.current = toScore;
        setDisplayScore(toScore);
        // land on the real score, not the rounded one the numeral shows
        setSerpentScore(clamped);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clamped, rmResolved, rm]);

  // ── Milestone ceremony (halo flare) ───────────────────────────────────────

  useEffect(() => {
    if (!rmResolved) return;   // wait until reduce-motion pref is known
    if (!milestone) return;
    if (rm) return;            // reduce motion: no flare
    haloFlareAnim.value = withSequence(
      withTiming(0,   { duration: 200, easing: EASE_OUT }),
      withTiming(0.5, { duration: 300, easing: EASE_OUT }),
      withTiming(0,   { duration: 900, easing: EASE_OUT }),
    );
  }, [milestone, rmResolved, rm]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Press handlers ────────────────────────────────────────────────────────

  const handlePressIn  = () => { scaleAnim.value = withTiming(0.98, { duration: 120, easing: EASE_OUT }); };
  const handlePressOut = () => { scaleAnim.value = withTiming(1.0,  { duration: 120, easing: EASE_OUT }); };
  const handlePress    = () => { haptic('tabChange'); onPress?.(); };

  // Bloom container animation (NEX-157). The same shared values that drove the
  // old halo image now drive the SVG horizon-bloom <Animated.View> opacity +
  // scale (rotation is gone — a radially symmetric bloom can't show it):
  //   • haloBreatheAnim — blooms to 0.8, then breathes 0.6↔1.0 forever. Mapped
  //     to opacity, plus a faint scale swell (0.985↔1.03) so the glow reads as
  //     gently inhaling, not just brightening.
  //   • haloFlareAnim   — milestone ceremony surge (peaks ~0.5). A view's
  //     opacity is hard-capped at 1.0, so the flare is routed mostly to SCALE,
  //     which has headroom, plus a small opacity lift toward full. The flare
  //     therefore reads as the bloom surging outward + brightening, not
  //     clipping. (The bloom box is oversized so this surge never hits a square
  //     edge — see BLOOM_BOX_SCALE.)
  const haloAnimStyle = useAnimatedStyle(() => {
    const breathe = haloBreatheAnim.value;
    const flare   = haloFlareAnim.value;
    return {
      // Breath carries opacity; the flare nudges it the rest of the way to full.
      opacity: Math.min(1, breathe + flare * 0.4),
      // Breath swell (0.985↔1.03) + flare surge (flare 0.5 → +0.13 scale).
      transform: [
        { scale: 0.985 + breathe * 0.045 + flare * 0.26 },
      ] as ViewStyle['transform'],
    };
  });

  // ── Progress arc (SVG stroke-dash) ────────────────────────────────────────

  // A full stroked circle, revealed by animating strokeDashoffset from full
  // circumference (hidden) to (1-progress)×circumference (progress shown). The
  // circle is rotated -90° (via the SVG element) so it starts at 12 o'clock and
  // sweeps clockwise — matching the designer's source exactly.

  // ── RN-side animated styles ───────────────────────────────────────────────

  const ringAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scaleAnim.value }],
  }));

  const contentAnimStyle = useAnimatedStyle(() => ({
    opacity: contentOpacityAnim.value,
  }));

  // ── Typography ────────────────────────────────────────────────────────────

  // Score numeral stays IBM Plex Mono per the locked rule "numerals are always
  // Plex Mono" (§5.6 / §19). The designer's Fraunces-italic treatment is
  // honoured on the qualitative word directly below instead.
  const numeralFontSize = Math.round(size * 0.34);
  const numeralStyles: TextStyle = {
    fontFamily:       'IBMPlexMono-Medium',
    fontSize:         numeralFontSize,
    lineHeight:       numeralFontSize,
    letterSpacing:    -0.04 * numeralFontSize,
    fontVariant:      ['tabular-nums'],
    color:            tokens.color.text,
    textAlign:        'center',
    // Warm gold inner-glow on the numeral — matches the handoff's
    // textShadow:#9F7731 and keeps the score reading as an emission source.
    textShadowColor:  'rgba(159,119,49,0.55)',
    textShadowRadius: 16,
    textShadowOffset: { width: 0, height: 0 },
  };

  const wordStyles: TextStyle = {
    fontFamily: 'Fraunces-LightItalic',
    fontSize:   24,
    lineHeight: WORD_LINE_HEIGHT,
    color:      tokens.color.gold,
    marginTop:  CONTENT_GAP,
    textAlign:  'center',
  };

  // ── Accessibility ─────────────────────────────────────────────────────────

  // NEX-121: in the locked preview (showValue=false) the score is premium-gated,
  // so never announce the number/word — that would leak it via VoiceOver.
  const a11yLabel = showValue
    ? `Alignment score ${Math.round(clamped)}, ${word}`
    : 'Alignment preview, locked';

  // ── Subtree ───────────────────────────────────────────────────────────────

  const subtree = (
    <Animated.View
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        ringAnimStyle,
      ]}
      testID={testID}
    >
      {/* Layer 0 — horizon bloom (NEX-157). ONE smooth radial-gradient disc
          behind the ring: a single soft glow peaking just outside the arc and
          fading continuously outward (gold → faint teal → void), so it reads as
          one planet-horizon glow, not stacked rings. Breathes + flares via
          haloAnimStyle. Box oversized (BLOOM_BOX_SCALE) so the glow's outer
          radius and the milestone flare never clip a square edge. pointerEvents
          none so taps pass to the ring. */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: bloomBox,
            height: bloomBox,
            left: bloomInset,
            top: bloomInset,
          },
          haloAnimStyle,
        ]}
      >
        <Svg width={bloomBox} height={bloomBox}>
          <Defs>
            <SvgRadialGradient
              id="ring-bloom"
              gradientUnits="userSpaceOnUse"
              cx={bloomC}
              cy={bloomC}
              fx={bloomC}
              fy={bloomC}
              r={bloomOuterR}
            >
              <Stop offset={0} stopColor={tokens.color.gold} stopOpacity={0} />
              <Stop offset={fInner} stopColor={tokens.color.gold} stopOpacity={0} />
              <Stop offset={fPeak} stopColor={tokens.color.goldBright} stopOpacity={BLOOM_OP_PEAK} />
              <Stop offset={fMid} stopColor={tokens.color.gold} stopOpacity={BLOOM_OP_MID} />
              <Stop offset={fTeal} stopColor={tokens.color.teal} stopOpacity={BLOOM_OP_TEAL} />
              <Stop offset={1} stopColor={tokens.color.teal} stopOpacity={0} />
            </SvgRadialGradient>
          </Defs>
          <SvgCircle cx={bloomC} cy={bloomC} r={bloomOuterR} fill="url(#ring-bloom)" />
        </Svg>
      </Animated.View>

      {/* The ring — drawn with SVG (NOT Skia). The previous Skia canvas painted
          an opaque white disc that covered the halo and read as a thick white
          ring; SVG composites transparently, so the designer's glow shows
          through. This mirrors the designer's own source, which uses SVG. */}
      <Svg
        width={size + RING_PAD * 2}
        height={size + RING_PAD * 2}
        viewBox={`${-RING_PAD} ${-RING_PAD} ${size + RING_PAD * 2} ${size + RING_PAD * 2}`}
        style={{ position: 'absolute', left: -RING_PAD, top: -RING_PAD }}
        pointerEvents="none"
      >
        <Defs>
          <SvgRadialGradient id="ring-well" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={tokens.color.void} stopOpacity={0.92} />
            <Stop offset="100%" stopColor={tokens.color.voidDeep} stopOpacity={0.92} />
          </SvgRadialGradient>
          {/* Inner-atmosphere gold haze, confined to the well↔track gap. The
              inner stop is derived from the real radii so gold never bleeds into
              the well interior (NEX-157). */}
          <SvgRadialGradient id="ring-bloom-atmo" cx="50%" cy="50%" r="50%">
            <Stop offset={0} stopColor={tokens.color.gold} stopOpacity={0} />
            <Stop offset={atmoStopIn} stopColor={tokens.color.gold} stopOpacity={0} />
            <Stop offset={1} stopColor={tokens.color.gold} stopOpacity={BLOOM_ATMO_OP} />
          </SvgRadialGradient>
        </Defs>

        {/* Dark inner well so the numeral sits on void, not on raw cosmos */}
        <SvgCircle cx={cx} cy={cy} r={wellRadius} fill="url(#ring-well)" />

        {/* Inner atmosphere — faint gold haze in the well↔track gap (NEX-157),
            drawn over the well edge, under the track. Does not breathe (it sits
            inside the static well/track layering); the outer bloom strokes carry
            the breath, which is where the eye reads it. */}
        <SvgCircle cx={cx} cy={cy} r={atmoRadius} fill="url(#ring-bloom-atmo)" />

        {/* Faint full-circle track (designer: #D0AF35 @18%) */}
        <SvgCircle
          cx={cx}
          cy={cy}
          r={arcRadius}
          fill="none"
          stroke={TRACK_COLOR}
          strokeWidth={arcStroke}
        />

        {/* The gold gradient arc and its seed dot used to sit here. The
            serpent below is the progress indicator now and its head is the
            terminus, so a stroke underneath it would read as a second one.
            The faint full-circle track stays: it is what gives a short body
            something to be short against. (NEX-334.) */}
      </Svg>

      {/* Layer 6 — the ouroboros (NEX-330/332/333). A Skia canvas, so it cannot
          live inside the Svg above and sits over it instead. It draws only the
          animal; the numeral and band word below still carry the score on their
          own, which is what lets §1.5 UF-01 be satisfied without it. */}
      <View
        style={{
          position: 'absolute',
          width:    serpentBox,
          height:   serpentBox,
          left:     serpentInset,
          top:      serpentInset,
        }}
        pointerEvents="none"
      >
        <OuroborosSerpent score={serpentScore} size={serpentBox} />
      </View>

      {/* Layer 7 — eyebrow + numeral + word (RN text overlay, centred).
          NEX-121: omitted entirely when showValue=false (locked preview) so the
          value never renders (no leak) and contentOpacityAnim doesn't fade an
          empty box — only the arc geometry above shows. */}
      {showValue ? (
        <Animated.View
          style={[styles.ringContent, contentAnimStyle]}
          pointerEvents="none"
        >
          <Text style={styles.eyebrow} numberOfLines={1} maxFontSizeMultiplier={HERO_MAX_FONT_SCALE}>
            {label}
          </Text>
          <Text style={numeralStyles} numberOfLines={1} maxFontSizeMultiplier={HERO_MAX_FONT_SCALE}>
            {displayScore.toString()}
          </Text>
          <Text style={wordStyles} numberOfLines={1} maxFontSizeMultiplier={HERO_MAX_FONT_SCALE}>
            {word}
          </Text>
          {supportingLine ? (
            <Text style={styles.sub} numberOfLines={2} maxFontSizeMultiplier={HERO_MAX_FONT_SCALE}>
              {supportingLine}
            </Text>
          ) : null}
        </Animated.View>
      ) : null}
    </Animated.View>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  if (onPress) {
    return (
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint="Double-tap for alignment details"
        style={[styles.outer, style]}
      >
        {subtree}
      </Pressable>
    );
  }

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={a11yLabel}
      // NEX-121: omit the numeric value in the locked preview so VoiceOver can't
      // read the gated score; the neutral a11yLabel carries the locked state.
      accessibilityValue={showValue ? { now: clamped, min: 0, max: 100 } : undefined}
      style={[styles.outer, style]}
    >
      {subtree}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  outer: {
    alignItems: 'center',
  },
  ringContent: {
    ...StyleSheet.absoluteFillObject,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 14,
    // Optical-centering nudge so the numeral lands on the ring's horizontal
    // diameter despite the asymmetric eyebrow/word line heights (NEX-157 addendum).
    transform: [{ translateY: CONTENT_OPTICAL_SHIFT }],
  },
  eyebrow: {
    ...tokens.type.labelTrackedLg,
    color:        tokens.color.textMuted,
    marginBottom: CONTENT_GAP,
    textAlign:    'center',
  },
  sub: {
    ...tokens.type.labelTrackedSm,
    color:     tokens.color.textMuted,
    marginTop: 8,
    textAlign: 'center',
  },
});
