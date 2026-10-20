import { haptic } from '@/src/utils/haptics';
import React from 'react';
import {
  Pressable,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import tokens from '@/src/theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IconButtonProps = {
  icon: React.ReactNode;
  onPress: () => void;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'ghost';
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
  accessibilityLabel: string; // required — icon buttons need explicit labels
};

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_MS     = tokens.motion.quick.duration; // 140ms
const QUICK_EASING = Easing.bezier(0.4, 0, 0.2, 1);

// v3 stellar: retoned from warm cream rgba(245,239,220,...) to pure white.
const DEFAULT_BG_REST  = 'rgba(255,255,255,0.05)';
// Uses tokens.color.luminousEdgeSoft (rgba(255,255,255,0.12)) — value-identical to the
// previous literal. Note this token is shared: it also defines the frosted tab-bar
// hairline, so editing it in tokens.ts shifts IconButton's pressed background too.
const DEFAULT_BG_PRESS = tokens.color.luminousEdgeSoft;

const SIZE_MAP = {
  sm: { hit: 40, visible: 36, icon: 16 },
  md: { hit: 44, visible: 40, icon: 18 },
  lg: { hit: 48, visible: 44, icon: 20 },
} as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function IconButton({
  icon,
  onPress,
  size = 'md',
  variant = 'default',
  disabled = false,
  style,
  testID,
  accessibilityLabel,
}: IconButtonProps) {
  const { hit, visible } = SIZE_MAP[size];
  const isDefault = variant === 'default';

  // ── Press state ──────────────────────────────────────────────────────────
  const pressProgress = useSharedValue(0); // 0 = rest, 1 = pressed

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: pressProgress.value > 0
      ? DEFAULT_BG_PRESS
      : isDefault ? DEFAULT_BG_REST : 'transparent',
    transform: [{ scale: 1 - 0.06 * pressProgress.value }],
  }));

  // ── Press handlers ───────────────────────────────────────────────────────

  function handlePressIn() {
    if (disabled) return;
    pressProgress.value = withTiming(1, { duration: QUICK_MS, easing: QUICK_EASING });
    haptic('iconButton');
  }

  function handlePressOut() {
    if (disabled) return;
    pressProgress.value = withTiming(0, { duration: QUICK_MS, easing: QUICK_EASING });
  }

  // ── hitSlop: expand tap target to `hit` size regardless of visible size ──
  const hitExpand = (hit - visible) / 2;
  const hitSlop   = { top: hitExpand, bottom: hitExpand, left: hitExpand, right: hitExpand };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={style}
    >
      <Animated.View
        style={[
          styles.circle,
          {
            width:        visible,
            height:       visible,
            borderRadius: visible / 2,
          },
          isDefault ? styles.defaultVariant : styles.ghostVariant,
          disabled && styles.disabled,
          !disabled && animatedStyle,
        ]}
      >
        {icon}
      </Animated.View>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  circle: {
    alignItems:     'center',
    justifyContent: 'center',
  },

  defaultVariant: {
    backgroundColor: DEFAULT_BG_REST,
    borderWidth:     StyleSheet.hairlineWidth,
    borderColor:     tokens.color.goldHairline,
  },

  ghostVariant: {
    backgroundColor: 'transparent',
  },

  disabled: {
    opacity: 0.35,
  },
});
