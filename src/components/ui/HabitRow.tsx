// NEX-? — HabitRow redesign. Per-row layout:
//   - Left: 56pt gold progress ring (no icon, no number inside)
//   - Center: habit name + tracked-caps sub-label
//   - Right: small gold mono streak numeral (no chip, no flame)
//
// Reference aesthetic: Any Distance Goals — premium dark, generous
// spacing, ring-as-icon. Restrained: the gold ring IS the visual hero.
// Stripped of: emojis in titles (regex-filtered at render time),
// StreakChip (replaced with raw numeral), gamified pill backgrounds.
//
// Multi-count habits (timesPerDay > 1) are driven by new optional
// `count` + `target` props. Without them the row falls back to binary
// completion based on `completed`.

import {
  Canvas,
  Circle,
} from '@shopify/react-native-skia';
import { haptic } from '@/src/utils/haptics';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { StreakBadge } from './StreakBadge';
import { StreakChip } from './StreakChip';
import { stripEmoji } from '@/src/utils/text';
import { LONG_PRESS_MS, isLongPress } from './habit-row-press';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import tokens from '@/src/theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type HabitRowProps = {
  title: string;
  meta?: string;
  emoji?: string;
  /** Breakable day-streak — rendered ONLY in Soft Mode (NEX-190). */
  streak?: number;
  /**
   * NEX-190 default surface: cumulative, non-resetting progress label
   * (e.g. "2× this wk", "1 of 3", "NEW"). Shown instead of the breakable
   * streak unless `softMode` is on. A miss never lowers what's earned.
   */
  progressLabel?: string;
  /** Opt-in Soft Mode: show the breakable <StreakBadge/> instead of the chip. */
  softMode?: boolean;
  completed: boolean;
  /**
   * For multi-count habits (timesPerDay > 1), the current count.
   * When provided alongside `target`, drives proportional ring fill
   * and the "N / T TODAY" sub-label. If omitted, binary completion
   * via `completed`.
   */
  count?: number;
  /** Required completions for full ring. Default 1 (binary). */
  target?: number;
  onComplete: () => void;
  onLongPress?: () => void;
  /** @deprecated rows are individual cards now — no internal dividers. */
  showBottomDivider?: boolean;
  testID?: string;
  style?: ViewStyle;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const RING_SIZE   = 28;                 // visible ring diameter
const RING_STROKE = 1.25;
// Skia Canvas needs extra room beyond the visible ring so the outer
// glow strokes don't clip. Outer glow centerline sits 3pt past the
// main ring; with a 3pt stroke, outermost pixel = baseRadius+4.5.
// Canvas size 36 = visible 28 + ~4pt padding on each side.
const CANVAS_SIZE = 36;
const CANVAS_CENTER = CANVAS_SIZE / 2;
const RING_RADIUS = RING_SIZE / 2 - RING_STROKE / 2;
// Glow layer radii (stroke centerlines). Opacity is binary — low on
// incomplete / partial states, high on complete — so the ring pops
// once the count hits target.
const GLOW_OUTER_RADIUS    = RING_RADIUS + 3;
const GLOW_OUTER_STROKE    = 3;
const GLOW_OUTER_OPACITY_LOW  = 0.10;
const GLOW_OUTER_OPACITY_HIGH = 0.25;
const GLOW_MID_RADIUS      = RING_RADIUS + 1.5;
const GLOW_MID_STROKE      = 2;
const GLOW_MID_OPACITY_LOW   = 0.18;
const GLOW_MID_OPACITY_HIGH  = 0.40;

// Solid inner disc (drawn only when complete). Sits just inside the
// main ring stroke so the two don't overlap. fillOpacity is animated
// 0 → 0.85 on completion.
const INNER_FILL_RADIUS = RING_RADIUS - RING_STROKE / 2;
const INNER_FILL_OPACITY_COMPLETE = 0.85;

const ROW_MIN_HEIGHT  = 68;
const ROW_RADIUS      = 20;
const ROW_PAD_V       = 14;
const ROW_PAD_H       = 20;
// Gap reduced from 16 → 12 because the ring wrap is now 36pt to
// accommodate the glow margin; the visible 28pt ring sits centered
// inside, so visual gap = 4 (wrap margin) + 12 = 16, matching prior.
const GAP_CENTER      = 12;

// LONG_PRESS_MS lives in ./habit-row-press (shared with the pure unit test).

const EASE_OUT = Easing.bezier(0.2, 0, 0, 1);

// Emoji stripping moved to src/utils/text.ts so both HabitRow and the
// horizon-review row share one source of truth.

// Binary ring state: the ring is either hollow (count < target) or
// has a solid gold inner fill (count >= target). No arc-percentage
// rendering — the sub-label carries the partial count "1 / 2 TODAY"
// instead.

// ─── Component ────────────────────────────────────────────────────────────────

export function HabitRow({
  title,
  meta,
  streak,
  progressLabel,
  softMode = false,
  completed,
  count,
  target,
  onComplete,
  onLongPress,
  testID,
  style,
}: HabitRowProps) {
  // Reactive Reduce Motion. Treat "not yet resolved" the same as reduce motion:
  // never schedule a withTiming before the async OS preference is known (cold
  // start with RM on).
  const { reduceMotion: reduceMotionValue, resolved: rmResolved } = useReduceMotion();
  const suppressMotion     = !rmResolved || reduceMotionValue;
  // Mirror into a ref DURING render (not a passive effect) so the imperative
  // press handlers (handlePressIn/Out) never read a stale value in the window
  // between a toggle/resolve and an effect commit.
  const reduceMotion       = useRef(suppressMotion);
  reduceMotion.current     = suppressMotion;
  const longPressTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Press timing for the deterministic tap-vs-long-press decision (made on
  // release in handlePress from the measured hold duration). Fixes the
  // "every-other-tap opened the menu" misfire: the menu is no longer opened by
  // a free-running timer that could fire after a quick tap.
  const pressStartedAt     = useRef(0);
  const pressActive        = useRef(false);

  // Derived progress in [0,1]. If count+target provided, that wins;
  // otherwise binary based on completed.
  const progress = useMemo(() => {
    if (typeof count === 'number' && typeof target === 'number' && target > 0) {
      return Math.max(0, Math.min(1, count / target));
    }
    return completed ? 1 : 0;
  }, [count, target, completed]);

  const isComplete = progress >= 1;

  // Reanimated values for press-feedback, completion glow + inner fill.
  const scaleAnim   = useSharedValue(1);
  const glowOpacity = useSharedValue(isComplete ? 1 : 0);
  const dimOpacity  = useSharedValue(isComplete ? 0.5 : 1);
  // Inner solid disc opacity. Tweens 0 → 0.85 on completion for the
  // subtle satisfaction beat ("the ring fills in").
  const fillOpacity = useSharedValue(isComplete ? INNER_FILL_OPACITY_COMPLETE : 0);

  // Drive glow + dim + fill from completion state. Depends on suppressMotion so
  // flipping Reduce Motion on (or a completion that lands before the pref
  // resolves) snaps a settled row to its final state (and resets any in-flight
  // pressed scale) rather than scheduling/leaving motion mid-flight.
  useEffect(() => {
    if (suppressMotion) {
      glowOpacity.value = isComplete ? 1 : 0;
      dimOpacity.value = isComplete ? 0.5 : 1;
      fillOpacity.value = isComplete ? INNER_FILL_OPACITY_COMPLETE : 0;
      scaleAnim.value = 1;
      return;
    }
    glowOpacity.value = withTiming(isComplete ? 1 : 0, { duration: 280, easing: EASE_OUT });
    dimOpacity.value = withTiming(isComplete ? 0.5 : 1, { duration: 240, easing: EASE_OUT });
    fillOpacity.value = withTiming(
      isComplete ? INNER_FILL_OPACITY_COMPLETE : 0,
      { duration: 250, easing: EASE_OUT },
    );
  }, [isComplete, suppressMotion, glowOpacity, dimOpacity, fillOpacity, scaleAnim]);

  // ── Press handlers ────────────────────────────────────────────────────────

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handlePressIn = useCallback(() => {
    pressStartedAt.current = Date.now();
    pressActive.current = true;
    // Timer delivers the long-press HAPTIC cue while the finger is still down;
    // it no longer opens the menu (that decision is made on release). Guarded by
    // pressActive so it can't buzz after the finger has lifted.
    clearLongPressTimer();
    longPressTimer.current = setTimeout(() => {
      if (!pressActive.current) return;
      haptic('longPressStart');
    }, LONG_PRESS_MS);

    // Subtle press-down scale for tactile feedback.
    if (!reduceMotion.current) {
      scaleAnim.value = withTiming(0.97, { duration: 80, easing: EASE_OUT });
    }
  }, [clearLongPressTimer, scaleAnim]);

  const handlePressOut = useCallback(() => {
    pressActive.current = false;
    clearLongPressTimer();
    if (!reduceMotion.current) {
      scaleAnim.value = withTiming(1, { duration: 140, easing: EASE_OUT });
    }
  }, [clearLongPressTimer, scaleAnim]);

  const handlePress = useCallback(() => {
    // onPress fires on release. Stop the cue timer and decide tap-vs-menu from
    // the measured hold duration — a long hold opens the menu, a tap completes.
    // Deterministic: nothing else can open the menu, so a quick tap can never
    // misfire into it (NEX: every-other-tap menu bug).
    pressActive.current = false;
    clearLongPressTimer();
    if (isLongPress(Date.now() - pressStartedAt.current)) {
      onLongPress?.();
      return;
    }
    // One tap = one increment (or toggle for binary). Parent owns
    // count/target state — we just notify.
    haptic(isComplete ? 'tabChange' : 'habitPressIn');
    onComplete();
  }, [isComplete, onComplete, onLongPress, clearLongPressTimer]);

  // Cancel any pending cue timer on unmount so it can't fire on a gone row.
  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  // ── Animated styles ───────────────────────────────────────────────────────

  const rowAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scaleAnim.value }],
  }));

  const glowAnimStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const dimAnimStyle = useAnimatedStyle(() => ({
    opacity: dimOpacity.value,
  }));

  // ── Display strings ───────────────────────────────────────────────────────

  const displayTitle = stripEmoji(title);

  const subLabel = useMemo(() => {
    if (typeof count === 'number' && typeof target === 'number' && target > 1) {
      return `${count} / ${target} TODAY`;
    }
    return (meta ?? 'DAILY').toUpperCase();
  }, [count, target, meta]);

  // Soft Mode shows the breakable streak badge; default shows the cumulative chip.
  const showSoftStreak = softMode && typeof streak === 'number' && streak > 0;
  const showProgress   = !softMode && typeof progressLabel === 'string' && progressLabel.length > 0;

  // ── Accessibility ─────────────────────────────────────────────────────────

  const a11yLabel = [
    displayTitle,
    showSoftStreak ? `, ${streak}-day streak` : showProgress ? `, ${progressLabel}` : '',
    isComplete ? ', complete' : ', not complete',
  ].join('');

  const a11yHint = isComplete
    ? onLongPress
      ? 'Double-tap to uncheck. Long press for options.'
      : 'Double-tap to uncheck.'
    : onLongPress
    ? 'Double-tap to complete. Long press for options.'
    : 'Double-tap to complete.';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Animated.View style={[rowAnimStyle, style]}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isComplete }}
        accessibilityLabel={a11yLabel}
        accessibilityHint={a11yHint}
        testID={testID}
        style={styles.row}
      >
        {/* Ambient gold glow on completion — beneath the card, subtle. */}
        <Animated.View
          style={[styles.completionGlow, glowAnimStyle]}
          pointerEvents="none"
        />

        {/* ── Ring ── */}
        {/* Binary state ring: hollow when partial/incomplete, filled
            solid when complete. Glow stack intensity ramps up on
            completion so the row pops. Two wider concentric strokes
            sit behind the main ring to fake a warm halo at the SVG
            layer (iOS shadow doesn't bleed through Skia children). */}
        <View style={styles.ringWrap} pointerEvents="none">
          <Canvas style={styles.ringCanvas}>
            {/* Outer glow — widest, dimmest. Opacity steps up on complete. */}
            <Circle
              cx={CANVAS_CENTER}
              cy={CANVAS_CENTER}
              r={GLOW_OUTER_RADIUS}
              color={tokens.color.gold}
              style="stroke"
              strokeWidth={GLOW_OUTER_STROKE}
              opacity={isComplete ? GLOW_OUTER_OPACITY_HIGH : GLOW_OUTER_OPACITY_LOW}
            />
            {/* Middle glow — narrower, brighter. */}
            <Circle
              cx={CANVAS_CENTER}
              cy={CANVAS_CENTER}
              r={GLOW_MID_RADIUS}
              color={tokens.color.gold}
              style="stroke"
              strokeWidth={GLOW_MID_STROKE}
              opacity={isComplete ? GLOW_MID_OPACITY_HIGH : GLOW_MID_OPACITY_LOW}
            />
            {/* Main ring — full-opacity gold outline, always visible. */}
            <Circle
              cx={CANVAS_CENTER}
              cy={CANVAS_CENTER}
              r={RING_RADIUS}
              color={tokens.color.gold}
              style="stroke"
              strokeWidth={RING_STROKE}
            />
            {/* Inner solid fill — only visible when complete. Reanimated
                opacity tween (0 → 0.85, 250ms) gives the satisfaction
                beat on the completing tap. */}
            <Circle
              cx={CANVAS_CENTER}
              cy={CANVAS_CENTER}
              r={INNER_FILL_RADIUS}
              color={tokens.color.gold}
              opacity={fillOpacity}
            />
          </Canvas>
        </View>

        {/* ── Text column (dimmed on completion) ── */}
        <Animated.View style={[styles.textCol, dimAnimStyle]}>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {displayTitle}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {subLabel}
          </Text>
        </Animated.View>

        {/* ── Right slot — NEX-190 ──
            Default: cumulative progress chip ("2× this wk" / "1 of 3"), never
            breakable, never red. Soft Mode (opt-in): the breakable day-streak
            <StreakBadge/>. */}
        {showSoftStreak ? (
          <View style={styles.streakWrap}>
            <StreakBadge streak={streak as number} />
          </View>
        ) : showProgress ? (
          <View style={styles.streakWrap}>
            <StreakChip text={progressLabel as string} showFlame={false} />
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  row: {
    minHeight:         ROW_MIN_HEIGHT,
    paddingHorizontal: ROW_PAD_H,
    paddingVertical:   ROW_PAD_V,
    flexDirection:     'row',
    // Centered so the small (28pt) ring's center y-axis aligns to the
    // midpoint between the title baseline and the sub-label baseline.
    alignItems:        'center',
    backgroundColor:   tokens.color.surface,
    borderRadius:      ROW_RADIUS,
  },

  completionGlow: {
    position:        'absolute',
    top:             0, left: 0, right: 0, bottom: 0,
    borderRadius:    ROW_RADIUS,
    // Subtle gold ambient glow when the habit is fully complete.
    // shadow* on the row View itself; opacity is animated.
    shadowColor:     tokens.color.gold,
    shadowOpacity:   0.18,
    shadowRadius:    16,
    shadowOffset:    { width: 0, height: 0 },
  },

  ringWrap: {
    width:  CANVAS_SIZE,
    height: CANVAS_SIZE,
    // No shadow* here — iOS shadow on a View wrapping a Skia Canvas
    // doesn't reliably bleed through to the SVG-style children below.
    // The glow is now drawn inside the Canvas as two extra concentric
    // strokes (outer + middle). See render block.
  },
  ringCanvas: {
    width:  CANVAS_SIZE,
    height: CANVAS_SIZE,
  },

  textCol: {
    flex:           1,
    justifyContent: 'center',
    marginLeft:     GAP_CENTER,
  },

  title: {
    ...tokens.type.titleCard,
    color: tokens.color.text,
  },

  meta: {
    ...tokens.type.labelTrackedSm,
    color:     tokens.color.textMuted,
    marginTop: 4,
  },

  streakWrap: {
    marginLeft: tokens.spacing.sm,
  },
});
