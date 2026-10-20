/**
 * OnboardingOverlay — renders the dim cutout + tooltip card around the
 * current step's target. Designed to be mounted once near the root tree
 * (sibling of <Stack/>), above all screens.
 *
 *   <OnboardingProvider>
 *     <Stack ... />
 *     <OnboardingOverlay />
 *   </OnboardingProvider>
 *
 * Behavior contract:
 *   - Renders nothing when no flow is active.
 *   - When a step has no targetKey, or the target never registers / can't be
 *     measured, logs a dev warning and auto-advances to the next step. Never
 *     renders broken.
 *   - Cutout = 4 dim rectangles around the measured rect. The hole
 *     itself is uncovered, so taps pass through to the live component.
 *   - Tooltip floats above or below the hole per step.placement.
 *   - Tap on any dim rectangle (i.e. outside the cutout and tooltip)
 *     dismisses the flow.
 *   - Re-measures on viewport size changes and target registration changes.
 *   - Reanimated v4 fades the whole overlay in (300ms) on step change.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSegments } from 'expo-router';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import tokens from '../theme/tokens';
import { PrimaryPill } from '../components/ui/PrimaryPill';
import { useOnboarding } from './onboarding-context';
import type { OnboardingPlacement, OnboardingStep, TabRoute } from './onboarding-flows';
import { shouldRenderStepForScreen } from './screen-gate';

// NEX-36: tab names the overlay can gate against. Mirrors the
// app/(tabs) routes. Must stay in sync with TabRoute in
// onboarding-flows.ts.
const KNOWN_TAB_ROUTES: readonly TabRoute[] = ['home', 'orbit', 'inbox', 'align', 'command'];

/**
 * Parse the active tab name from expo-router's segments. The segments
 * array reflects the current route stack — for tabs, the last segment
 * is the active tab's filename (e.g. 'home', 'orbit'). Returns null
 * when nothing in the segment array matches a known tab (e.g. during
 * onboarding, while the user is on the auth screen, or mid-transition).
 */
function resolveActiveTab(segments: string[]): TabRoute | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if ((KNOWN_TAB_ROUTES as readonly string[]).includes(seg)) {
      return seg as TabRoute;
    }
  }
  return null;
}

interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FADE_MS = 300;
const MISSING_TARGET_WARN_MS = 250;
const MAX_MEASURE_FRAMES = 10;
// NEX-169: for scrollIntoView steps, how many frames to keep re-measuring an
// off-viewport target while the host scrolls it on-screen before soft-failing.
// ~40 frames ≈ 650ms — enough for the host's measureInWindow callback to fire
// and run an instant scrollTo({ animated: false }) before the overlay gives up.
// Bounded so a genuinely off-screen target still soft-fails (NEX-27 preserved).
const MAX_SCROLL_FRAMES = 40;
const TOOLTIP_GUTTER = tokens.spacing.md;          // 16
const TOOLTIP_MAX_WIDTH = 320;
const SCRIM_COLOR = 'rgba(0, 0, 0, 0.72)';

// Loose typing for the registered target — only `measureInWindow` is required.
type Measurable = {
  measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
};

export function OnboardingOverlay() {
  const {
    currentStep,
    currentFlowId,
    getTarget,
    nextStep,
    dismissFlow,
    targetsRevision,
  } = useOnboarding();

  // NEX-36: subscribe to expo-router's segments so the render gate
  // re-evaluates on tab change. resolveActiveTab returns null during
  // mid-navigation / non-tab routes — shouldRenderStepForScreen treats
  // null as "render" to avoid flicker during transitions.
  const segments = useSegments();
  const activeTab = useMemo(() => resolveActiveTab(segments as unknown as string[]), [segments]);

  const [rect, setRect] = useState<MeasuredRect | null>(null);
  const [rectStepId, setRectStepId] = useState<string | null>(null);
  // Viewport size, reactive to rotation / resize. Memoised so the object
  // identity only changes when the numbers do — several effects below list
  // `windowSize` in their dependency arrays (notably the target-rect measure
  // effect, which MUST re-run on resize or the spotlight ring keeps pointing
  // at the pre-rotation position).
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const windowSize = useMemo(
    () => ({ width: viewportWidth, height: viewportHeight }),
    [viewportWidth, viewportHeight]
  );

  // Used to suppress repeated auto-advance when we can't measure. One
  // warning per (flow, step) is plenty.
  const skippedStepKeyRef = useRef<string | null>(null);

  const opacity = useSharedValue(0);

  // ── Fade in/out as the active step changes ───────────────────────────────
  useEffect(() => {
    if (currentStep) {
      opacity.value = withTiming(1, { duration: FADE_MS, easing: Easing.out(Easing.cubic) });
    } else {
      opacity.value = withTiming(0, { duration: FADE_MS, easing: Easing.in(Easing.cubic) });
    }
  }, [currentStep, opacity]);

  // ── Measure the target rect on step / target / window changes ────────────
  useEffect(() => {
    if (!currentStep) {
      setRect(null);
      setRectStepId(null);
      skippedStepKeyRef.current = null;
      return;
    }

    // NEX-36: bail out of measurement entirely when the step's screen
    // doesn't match the focused tab. Without this, the overlay could
    // measure Home-anchored targets while the user is on Orbit and flash
    // over the wrong tab.
    if (!shouldRenderStepForScreen(currentStep, activeTab)) {
      setRect(null);
      setRectStepId(null);
      return;
    }

    const stepKey = `${currentFlowId ?? '?'}::${currentStep.id}`;
    const targetKey = currentStep.targetKey;

    // Step has no anchor — skip it. (One warn per step.)
    if (!targetKey) {
      if (skippedStepKeyRef.current !== stepKey) {
        skippedStepKeyRef.current = stepKey;
        if (__DEV__) {
          console.warn(
            `[Onboarding] step "${currentStep.id}" has no targetKey — auto-advancing.`
          );
        }
        nextStep();
      }
      return;
    }

    let cancelled = false;
    let missingTimer: ReturnType<typeof setTimeout> | null = null;
    let frameHandle: ReturnType<typeof requestAnimationFrame> | null = null;
    let measureFrames = 0;
    let scrollFrames = 0;
    let advanced = false;

    const warnAndAdvance = (message: string) => {
      if (cancelled || advanced) return;
      advanced = true;
      if (skippedStepKeyRef.current !== stepKey) {
        skippedStepKeyRef.current = stepKey;
        if (__DEV__) {
          console.warn(message);
        }
        nextStep();
      }
    };

    const node = getTarget(targetKey) as Measurable | null;

    if (!node || typeof node.measureInWindow !== 'function') {
      // Registration-driven missing-anchor handling: do not poll and do
      // not render a stale overlay. If a late-mounting anchor registers,
      // targetsRevision changes and this timer is cancelled before it
      // auto-skips.
      setRect(null);
      missingTimer = setTimeout(() => {
        warnAndAdvance(
          `[Onboarding] step "${currentStep.id}" target "${targetKey}" did not register within ${MISSING_TARGET_WARN_MS}ms — auto-advancing.`
        );
      }, MISSING_TARGET_WARN_MS);

      return () => {
        cancelled = true;
        if (missingTimer) clearTimeout(missingTimer);
      };
    }

    const measure = () => {
      if (cancelled || advanced) return;
      node.measureInWindow((x, y, w, h) => {
        if (cancelled || advanced) return;
        if (!w || !h) {
          // The ref is registered, but layout may not have committed yet.
          // Retry on animation frames briefly; this avoids the old 100ms
          // missing-ref polling window while still giving RN layout a chance
          // to produce a real rect.
          measureFrames += 1;
          if (measureFrames > MAX_MEASURE_FRAMES) {
            warnAndAdvance(
              `[Onboarding] step "${currentStep.id}" target "${targetKey}" registered but did not measure after ${MAX_MEASURE_FRAMES} frames — auto-advancing.`
            );
            return;
          }
          frameHandle = requestAnimationFrame(measure);
          return;
        }
        // NEX-27: soft-fail off-viewport anchors so the scrim doesn't inflate into a stuck black screen.
        if (y < 0 || y + h > windowSize.height) {
          // NEX-169: scrollIntoView steps get a bounded grace window — the host
          // is scrolling this anchor on-screen, so retry rather than skip. Falls
          // through to the NEX-27 soft-fail once the window is exhausted.
          if (currentStep.scrollIntoView && scrollFrames < MAX_SCROLL_FRAMES) {
            scrollFrames += 1;
            frameHandle = requestAnimationFrame(measure);
            return;
          }
          warnAndAdvance(
            `[Onboarding] step "${currentStep.id}" target "${targetKey}" measured off-viewport (y=${y}, h=${h}, vh=${windowSize.height}) — auto-advancing.`
          );
          return;
        }
        setRect((prev) => {
          if (
            prev &&
            prev.x === x &&
            prev.y === y &&
            prev.width === w &&
            prev.height === h
          ) {
            return prev;
          }
          return { x, y, width: w, height: h };
        });
        setRectStepId(currentStep.id);
      });
    };

    measure();

    return () => {
      cancelled = true;
      if (missingTimer) clearTimeout(missingTimer);
      if (frameHandle) cancelAnimationFrame(frameHandle);
    };
    // targetsRevision intentionally in deps so target registration /
    // unregistration drives measurement and missing-anchor auto-skip.
    // activeTab in deps (NEX-36) so the gate re-evaluates on tab change.
  }, [currentStep, currentFlowId, getTarget, nextStep, targetsRevision, windowSize, activeTab]);

  // ── Reset measured rect on step change ───────────────────────────────────
  useEffect(() => {
    setRect(null);
    setRectStepId(null);
  }, [currentStep?.id]);

  const tooltipPos = useMemo(
    () => computeTooltipPosition(rect, currentStep?.placement ?? 'below', windowSize),
    [rect, currentStep, windowSize]
  );

  const animatedScrimStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (!currentStep || !rect || rectStepId !== currentStep.id) return null;
  // NEX-36: belt-and-suspenders render gate. The measurement effect
  // already clears `rect` when the gate trips, but if state hasn't
  // flushed yet on a fast tab swap, this catches it before the scrim
  // paints over the new tab.
  if (!shouldRenderStepForScreen(currentStep, activeTab)) return null;

  const holeX = rect.x;
  const holeY = rect.y;
  const holeW = rect.width;
  const holeH = rect.height;
  const W = windowSize.width;
  const H = windowSize.height;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, animatedScrimStyle]}
    >
      {/* Top dim band */}
      <Pressable
        onPress={dismissFlow}
        style={[styles.scrim, { left: 0, top: 0, width: W, height: holeY }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {/* Bottom dim band */}
      <Pressable
        onPress={dismissFlow}
        style={[
          styles.scrim,
          { left: 0, top: holeY + holeH, width: W, height: Math.max(0, H - (holeY + holeH)) },
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {/* Left dim strip (alongside the hole) */}
      <Pressable
        onPress={dismissFlow}
        style={[styles.scrim, { left: 0, top: holeY, width: holeX, height: holeH }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {/* Right dim strip (alongside the hole) */}
      <Pressable
        onPress={dismissFlow}
        style={[
          styles.scrim,
          {
            left: holeX + holeW,
            top: holeY,
            width: Math.max(0, W - (holeX + holeW)),
            height: holeH,
          },
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />

      {/* Tooltip card — sits above or below the hole. Doesn't intercept
          taps outside its body, so the dim bands still receive them. */}
      <View
        pointerEvents="box-none"
        style={[
          styles.tooltipWrap,
          { left: tooltipPos.x, top: tooltipPos.y, width: tooltipPos.width },
        ]}
        accessibilityViewIsModal
      >
        <TooltipCard step={currentStep} onCta={nextStep} />
      </View>
    </Animated.View>
  );
}

function TooltipCard({ step, onCta }: { step: OnboardingStep; onCta: () => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{step.title}</Text>
      <Text style={styles.body}>{step.body}</Text>
      <PrimaryPill
        size="compact"
        onPress={onCta}
        style={{ alignSelf: 'flex-end' }}
      >
        {step.cta}
      </PrimaryPill>
    </View>
  );
}

// ── Tooltip placement geometry ─────────────────────────────────────────────
function computeTooltipPosition(
  rect: MeasuredRect | null,
  placement: OnboardingPlacement,
  windowSize: { width: number; height: number }
): { x: number; y: number; width: number } {
  if (!rect) return { x: 0, y: 0, width: 0 };
  const sideMargin = tokens.spacing.md; // 16
  const maxWidth = Math.min(TOOLTIP_MAX_WIDTH, windowSize.width - sideMargin * 2);
  // Center horizontally on the cutout, then clamp to viewport.
  const desiredCenterX = rect.x + rect.width / 2;
  let x = desiredCenterX - maxWidth / 2;
  if (x < sideMargin) x = sideMargin;
  if (x + maxWidth > windowSize.width - sideMargin) {
    x = windowSize.width - sideMargin - maxWidth;
  }
  // Vertical: above or below the cutout.
  // We don't know the rendered height of the tooltip ahead of time, so
  // we anchor with `top` and let the card's intrinsic height grow downward
  // (placement: 'below') or use a translateY-equivalent via top math
  // (placement: 'above') by anchoring to a known offset above the rect.
  const y =
    placement === 'above'
      ? Math.max(sideMargin, rect.y - TOOLTIP_GUTTER - 160) // 160 = soft cap on tooltip card height
      : rect.y + rect.height + TOOLTIP_GUTTER;
  return { x, y, width: maxWidth };
}

// ── Styles ────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    backgroundColor: SCRIM_COLOR,
  },
  tooltipWrap: {
    position: 'absolute',
  },
  card: {
    backgroundColor: tokens.color.surfaceElevated,
    borderRadius: tokens.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.color.goldHairline,
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.md,
    shadowColor: tokens.color.textInverse,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  title: {
    ...tokens.type.titleCard,
    color: tokens.color.text,
    marginBottom: tokens.spacing.xs,
  },
  body: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
    marginBottom: tokens.spacing.md,
  },
});
