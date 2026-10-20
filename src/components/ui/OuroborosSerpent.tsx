/**
 * Ouroboros hero — the serpent.
 *
 * NEX-332 built it, NEX-338 rebuilt it on authored frames, NEX-339 gave it
 * continuous growth, and this rewrite makes it ONE IMAGE and gives it a pulse.
 *
 * WHAT CHANGED, AND WHY. The previous version drew TWO layers: a body clipped
 * back to `arc - NECK_DEG`, and a separately-authored head ROTATED into place on
 * top. That join is invisible only when the rotation is zero, which happens at
 * exactly ten scores. Everywhere else the head sprite arrived with its own
 * straight edge and its scale lattice offset from the body's by up to 34 degrees
 * (half the widest authored gap — a bound the old `poseForScore` test asserted
 * without anyone reading it as a seam budget). The owner's report was "you can
 * clearly tell where the head and the body are two separate images," which was a
 * literal description of the renderer. Rendering the same art at rotation 0 and
 * at -15.6 confirmed it: seamless at zero, visibly two pieces at -15.6.
 *
 * A second defect died with it. The head sprite was drawn UNCLIPPED, so any
 * stray pixel elsewhere in its 1024px frame landed on screen wherever the
 * rotation carried it — the detached gold fleck visible near the tail at score
 * 62.
 *
 * So: rotate the WHOLE authored frame until its head lands on the target arc,
 * then clip the surplus off the TAIL. Head and body cannot disagree because they
 * were never separated. `framePoseForScore` decides which frame and how far;
 * this file transforms, it does not compute.
 *
 * WHAT THE TAIL PAYS. The tail is now a cut rather than the authored point. That
 * is the deliberate trade: the body is thinnest there — 21px against 157px at
 * the neck, measured on frame-060 — and it sits at the twelve o'clock anchor
 * where an end is expected. A lattice offset at a rotated neck could not have
 * been feathered away at all; a tail cut can.
 *
 * WHAT THIS DELETED. `OUROBOROS_HEAD_FULL/PROXY`, the `lastPair` head/body
 * coherence cache, `fullResMatchesPose`, and the two staleness windows they
 * guarded. With one image there is no pairing to get wrong, which is the entire
 * class of bug NEX-339 paid three rounds for. Dropping the head proxy set also
 * returns ~5.3MB of resident memory.
 *
 * THE AMBIENT WAVE (design-system §1 principle 4, amended 2026-08-15).
 * A travelling wave runs down the body with the score at rest: 1% of the box,
 * one wave every 7s, deform-only. Three runtime facts govern how it is driven,
 * each of which cost a wrong implementation first:
 *
 *   - `withRepeat(withTiming(...))` DOES NOT RUN on this runtime. Proven by
 *     driving a Group's opacity from the same phase and watching mean luminance
 *     hold flat while it should have swung 0.15 to 1.0. StarField and MatrixRain
 *     both say so in their headers and both use a plain interval.
 *   - Skia's `useClock` wraps `useFrameCallback`, the same broken path.
 *   - `<Vertices vertices={...}>` does not update from a worklet. Not from
 *     `useDerivedValue`, and not from `usePointBuffer` either. It updates when
 *     REACT re-renders, so the phase is React state on an interval.
 *
 * A note for whoever measures this next: on Home the StarField's twinkling
 * swamps the serpent in any naive pixel diff — the waveless build once measured
 * HIGHER than the wave build. Run a negative control, or mask to the animal's
 * warm gold.
 */
import {
  Canvas,
  Group,
  ImageShader,
  Skia,
  Vertices,
  type SkImage,
  type SkPath,
  useImage,
} from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { ornamentMayAnimate } from '@/src/utils/reduce-motion-policy';

import { OUROBOROS_FRAME_FULL, OUROBOROS_FRAME_PROXY } from './ouroboros-frame-sources';
import {
  FINALE_INDEX,
  FRAME_HEAD_DEG,
  coherentPaint,
  framePoseForScore,
  fullResFrameUsable,
  type FramePose,
  type PaintGeometry,
} from './ouroboros-frames';
import { buildBaseGrid, displaceGrid, type Pt } from './ouroboros-wave';

export type OuroborosSerpentProps = {
  /** 0-100. Anything outside that, or not a number, draws nothing. */
  score: number;
  /** Width and height of the square the ring is inscribed in, in points. */
  size: number;
};

/**
 * How long the score must hold still before the full-res frames are fetched.
 * Shorter than the 700ms re-score curve, so a settled hero sharpens promptly
 * without decoding through a count-up.
 */
const SETTLE_MS = 150;

/** Wedge radius as a multiple of the box, so the clip covers the corners. */
const WEDGE_RADIUS_SCALE = 1.6;

/** Ambient wave, per the §1 principle 4 amendment. Both numbers are owner-set. */
const WAVE_AMPLITUDE = 0.01;
const WAVE_PERIOD_MS = 7000;

/**
 * Phase tick. 33ms is ~30Hz, deliberately not 60: each tick re-renders this
 * component, and at a 7s period nobody can see the difference between 30 and 60
 * samples of a wave this slow.
 */
const WAVE_TICK_MS = 33;

/** Mesh resolution per axis. 32 gives 1089 vertices and 2048 triangles. */
const GRID_N = 32;

/** A pie slice from twelve o'clock, sweeping `sweepDeg` clockwise. */
function wedge(size: number, sweepDeg: number): SkPath {
  const c = size / 2;
  const r = size * WEDGE_RADIUS_SCALE;
  const path = Skia.Path.Make();
  path.moveTo(c, c);
  // Skia measures from three o'clock and sweeps clockwise, so twelve is -90.
  path.arcToOval(Skia.XYWHRect(c - r, c - r, r * 2, r * 2), -90, sweepDeg, false);
  path.close();
  return path;
}

/**
 * The proxy set, decoded once and held for the session.
 *
 * Ten `useImage` calls, one per authored frame. The list is frozen and
 * constant-length, so the hook ORDER is identical on every render, which is the
 * actual rule — `rules-of-hooks` only knows it cannot prove that statically. The
 * alternative it would prefer, `useImage(PROXY[idx])`, is the bug: `useImage`
 * returns null while it decodes and the ring re-sets the score on every rAF
 * tick, so a per-tick source change would blank the hero through a whole
 * count-up.
 *
 * **+590KB resident per proxy.** Ten is ~5.9MB. It was ~11.2MB before the head
 * set went; that halving is what paid for the tenth frame.
 */
function useProxySet(sources: readonly number[]): (SkImage | null)[] {
  return sources.map((src) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useImage(src, (e) => console.warn(`[ouroboros] proxy failed: ${e.message}`)),
  );
}

type MeshProps = {
  size: number;
  image: SkImage;
  /** Degrees to rotate the whole frame. Always <= 0. */
  rotationDeg: number;
  /** Wave band in FRAME space: the arc that survives the clip. */
  lo: number;
  hi: number;
  phase: number;
  amplitude: number;
  base: { points: Pt[]; indices: number[] };
  centre: { x: number; y: number };
  opacity?: number;
};

/**
 * One authored frame: rotated, wave-deformed, painted through an ImageShader.
 *
 * `<Vertices>` has no image prop, so the frame is drawn as a triangle mesh with
 * hand-rolled UVs. A vertex's UV is where it came FROM, so the texture list is
 * the undeformed grid and only the geometry moves.
 */
function SerpentMesh({
  size,
  image,
  rotationDeg,
  lo,
  hi,
  phase,
  amplitude,
  base,
  centre,
  opacity,
}: MeshProps) {
  const vertices = useMemo(() => {
    const out: Pt[] = new Array(base.points.length);
    return displaceGrid(base.points, out, size, lo, hi, phase, amplitude);
  }, [base.points, size, lo, hi, phase, amplitude]);

  const spin = useMemo(
    () => [{ rotate: (rotationDeg * Math.PI) / 180 }],
    [rotationDeg],
  );
  const rect = useMemo(() => ({ x: 0, y: 0, width: size, height: size }), [size]);

  return (
    <Group transform={spin} origin={centre} opacity={opacity}>
      <Vertices
        vertices={vertices}
        textures={base.points}
        indices={base.indices}
        mode="triangles"
      >
        <ImageShader image={image} fit="contain" rect={rect} tx="clamp" ty="clamp" />
      </Vertices>
    </Group>
  );
}

/**
 * Full-resolution loader for ONE settled frame.
 *
 * **Separate so it can be REMOUNTED, and that is load-bearing.** `useImage`
 * never clears its result when its source changes: `useLoading` holds the
 * decoded image in state and only calls `setData` when a load *resolves*
 * (`@shopify/react-native-skia/src/skia/core/Data.ts`). A source change
 * therefore leaves the PREVIOUS image in hand for the whole decode of the next
 * one, and drawing that with the CURRENT rotation and clip is a frame of the
 * wrong length. Keying this on the frame index means a change remounts it,
 * `useImage` starts from null, and the proxy covers the gap.
 */
function FullResFrame({
  frame,
  src,
  onLoaded,
}: {
  /** The frame this loader was mounted for, reported back with its pixels. */
  frame: number;
  src: number;
  onLoaded: (frame: number, image: SkImage | null) => void;
}) {
  const image = useImage(src, (e) =>
    console.warn(`[ouroboros] full frame failed: ${e.message}`),
  );
  useEffect(() => {
    onLoaded(frame, image);
  }, [frame, image, onLoaded]);
  return null;
}

export const OuroborosSerpent = React.memo(function OuroborosSerpent({
  score,
  size,
}: OuroborosSerpentProps) {
  // THE SCORE IS THE GROWTH. `AlignmentScoreRing` runs the count-up and pushes a
  // fractional score every frame, so the pose is a pure function of the score
  // and this component owns no clock for it. The wave below is a SEPARATE,
  // independent loop for a quantity nothing else animates — which is why it may
  // use an interval where NEX-339's flipbook could not.
  const pose: FramePose | null = framePoseForScore(score);

  const proxies = useProxySet(OUROBOROS_FRAME_PROXY);

  // Ornament fails toward stillness: off until the preference is CONFIRMED, not
  // merely resolved. A failed accessibility read leaves `confirmed` false.
  const waveOn = ornamentMayAnimate(useReduceMotion());
  const amplitude = waveOn ? WAVE_AMPLITUDE : 0;

  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!waveOn) {
      setPhase(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => {
      setPhase(((Date.now() - t0) / WAVE_PERIOD_MS) * 2 * Math.PI);
    }, WAVE_TICK_MS);
    return () => clearInterval(id);
  }, [waveOn]);

  const primaryFrame = pose?.frame ?? null;

  // Full resolution is for REST, so it waits for the score to stop moving — and
  // it settles on the FRAME INDEX, not the pose. The rotation changes every
  // rAF by design; the index changes a handful of times in a whole count-up,
  // and keying the decode on it keeps a multi-MB fetch off the hot path.
  const [settled, setSettled] = useState<number | null>(pose ? pose.frame : null);
  useEffect(() => {
    if (primaryFrame === null) {
      setSettled(null);
      return;
    }
    const id = setTimeout(() => setSettled(primaryFrame), SETTLE_MS);
    return () => clearTimeout(id);
  }, [primaryFrame]);

  // Tagged with the frame whose loader produced it. Without that tag, a settle
  // that advances the frame leaves the PREVIOUS frame's pixels in this state
  // for one render, and an index comparison calls them fresh.
  const [full, setFull] = useState<{
    frame: number | null;
    image: SkImage | null;
  }>({ frame: null, image: null });
  const onLoaded = React.useCallback(
    (frame: number, image: SkImage | null) => setFull({ frame, image }),
    [],
  );

  const fullPrimaryUsable = fullResFrameUsable(settled, full.frame, primaryFrame);

  const base = useMemo(() => buildBaseGrid(size, GRID_N), [size]);
  const centre = useMemo(() => ({ x: size / 2, y: size / 2 }), [size]);

  // Last image actually painted, WITH the geometry it was painted at. The pose
  // is part of the cache entry, not read live beside it — see `coherentPaint`.
  const lastPainted = useRef<(PaintGeometry & { image: SkImage }) | null>(null);
  if (!pose) lastPainted.current = null;

  // Freshly available pixels for the frame the pose actually wants, or null
  // while one decodes.
  const fresh: SkImage | null =
    primaryFrame === null
      ? null
      : (fullPrimaryUsable && full.image) || proxies[primaryFrame] || null;

  const paint =
    pose && primaryFrame !== null
      ? coherentPaint(
          fresh,
          { frame: primaryFrame, rotationDeg: pose.rotationDeg, arcDeg: pose.arcDeg },
          lastPainted.current,
        )
      : null;
  if (fresh && paint) {
    lastPainted.current = { frame: paint.frame, rotationDeg: paint.rotationDeg, arcDeg: paint.arcDeg, image: fresh };
  }

  // Clipped to the arc THE PAINTED FRAME is authored for, not to the arc the
  // score currently wants — those differ only while a new frame decodes, and
  // that is exactly when they must not be mixed. Rebuilt when the cut moves by
  // half a degree, below what the eye can resolve at this radius.
  const arcKey = paint ? Math.round(paint.arcDeg * 2) : 0;
  const tailClip = useMemo(() => wedge(size, arcKey / 2), [size, arcKey]);

  if (!pose || paint === null) {
    return <View style={{ width: size, height: size }} />;
  }

  // Wave band in FRAME space. The mesh runs before the rotation is applied, so
  // the wave has to taper to nothing at the two ends of the arc that survives
  // the clip: the cut (at `-rotationDeg`) and the head. Both come off `paint`,
  // so a stale frame waves within its OWN body rather than a longer one's.
  const lo = -paint.rotationDeg;
  const hi = FRAME_HEAD_DEG[paint.frame];

  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      <Canvas style={{ width: size, height: size }}>
        {settled !== null ? (
          <FullResFrame
            // The key is the point: a settle must REMOUNT the loader, or
            // `useImage` hands back the previous frame while the next decodes.
            key={settled}
            frame={settled}
            src={OUROBOROS_FRAME_FULL[settled]}
            onLoaded={onLoaded}
          />
        ) : null}

        {/* The finale is the one frame drawn unclipped, and that must follow
            the frame ACTUALLY PAINTED, not the live score: at 100 with the
            finale still decoding, a cached 356-degree frame would otherwise be
            released from its own clip. */}
        <Group clip={paint.frame === FINALE_INDEX ? undefined : tailClip}>
          {/* ONE mesh, always at full opacity. There is no cross-fade — an
              opacity blend between two filigree plates ghosts (the first animal
              shows through the second's lattice gaps) and fades (neither
              covers the other's holes), which is the "two snakes, kind of
              faded" the owner kept naming scores for (63, 69, 87-89). Frame
              swaps are a straight cut; see FramePose in ouroboros-frames.ts. */}
          <SerpentMesh
            size={size}
            image={paint.image}
            rotationDeg={paint.rotationDeg}
            lo={lo}
            hi={hi}
            phase={phase}
            amplitude={amplitude}
            base={base}
            centre={centre}
          />
        </Group>
      </Canvas>
    </View>
  );
});

export default OuroborosSerpent;
