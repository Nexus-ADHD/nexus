import React, { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import tokens from '@/src/theme/tokens';

// ─── Shimmer ────────────────────────────────────────────────────────────────
//
// A quiet, on-brand skeleton loader: placeholder bars that breathe in opacity
// (~0.35 ↔ ~0.7), NOT a bright moving sweep. Follows the StarField / Alignment
// ring motion register (§1.4 / §7) — a transient loading affordance, allowed
// like the ambient breathe. Reanimated withTiming + ease, no withSpring.
//
// One shared value drives every bar (per-bar useAnimatedStyle reads it) so the
// field survives Fast Refresh — never give each bar its own withRepeat (repo
// memory: per-component withRepeat desyncs on hot-reload).
//
// Reduce Motion: gated on the resolved RM pref; when reduced, the bars hold at a
// static mid opacity (no animation). Decorative, so hidden from accessibility.

// Symmetric ease-in-out for the opacity breathe. Mirrors AlignmentScoreRing's
// breathe curve verbatim (the §7 ambient register) — Reanimated's `easing` needs
// an Easing function, but tokens.motion stores CSS cubic-bezier STRINGS for the
// 250ms transition system (§7.2), which Reanimated can't consume, and none of
// them is this symmetric breathe curve. So, like the ring, it's a local const.
const EASE_IN_OUT = Easing.bezier(0.4, 0, 0.6, 1);
const TROUGH = 0.35;
const PEAK = 0.7;
const STATIC = (TROUGH + PEAK) / 2;
const HALF_MS = 700;

export type ShimmerBar = {
  width?: ViewStyle['width'];
  height?: number;
  /** Gap above this bar (ignored for the first bar). */
  marginTop?: number;
};

export type ShimmerProps = {
  bars: ShimmerBar[];
  /** Bar fill color. Defaults to a soft starlight tint. */
  color?: string;
};

function ShimmerBar({
  breathe,
  bar,
  isFirst,
  color,
}: {
  breathe: SharedValue<number>;
  bar: ShimmerBar;
  isFirst: boolean;
  color: string;
}) {
  const animStyle = useAnimatedStyle(() => ({ opacity: breathe.value }));
  return (
    <Animated.View
      style={[
        styles.bar,
        {
          width: bar.width ?? '100%',
          height: bar.height ?? 14,
          marginTop: isFirst ? 0 : bar.marginTop ?? 12,
          backgroundColor: color,
        },
        animStyle,
      ]}
    />
  );
}

export function Shimmer({ bars, color = tokens.color.textDisabled }: ShimmerProps) {
  const { reduceMotion, resolved } = useReduceMotion();
  const breathe = useSharedValue(reduceMotion ? STATIC : TROUGH);

  useEffect(() => {
    if (!resolved) return; // wait until the RM pref is known (avoids a motion flash)
    if (reduceMotion) {
      breathe.value = STATIC; // static dimmed placeholder, no animation
      return;
    }
    breathe.value = withRepeat(
      withSequence(
        withTiming(PEAK, { duration: HALF_MS, easing: EASE_IN_OUT }),
        withTiming(TROUGH, { duration: HALF_MS, easing: EASE_IN_OUT })
      ),
      -1,
      false
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, resolved]);

  return (
    <View accessibilityElementsHidden importantForAccessibility="no">
      {bars.map((bar, i) => (
        <ShimmerBar key={i} breathe={breathe} bar={bar} isFirst={i === 0} color={color} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: 6 },
});
