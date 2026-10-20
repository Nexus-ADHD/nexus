import { haptic } from '@/src/utils/haptics';
import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import tokens from '@/src/theme/tokens';
import type { PillSize } from './pill-metrics';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SecondaryButtonProps = {
  children: React.ReactNode;
  onPress: () => void;
  variant?: 'outline' | 'gold-outline';
  disabled?: boolean;
  size?: PillSize;
  /** @deprecated use size="compact" — kept as an alias so existing call sites don't break. */
  compact?: boolean;
  leftIcon?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_MS     = tokens.motion.quick.duration; // 140ms
const QUICK_EASING = Easing.bezier(0.4, 0, 0.2, 1);

// Ghost-D recipe (docs/design/explorations/2026-08-06-button-background-marriage-v2.md
// §D): light-top gradient fill with a faint bottom bounce, 1pt top rim, the
// card edge token as border, and a CONTACT SHADOW instead of a glow (unlit =
// secondary, but unlit must not mean unattached). Non-token rgba values are
// local consts (no token equivalents).
const GHOST_FILL         = ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.035)', 'rgba(255,255,255,0.06)'] as const;
const GHOST_FILL_PRESSED = ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0.10)'] as const;
const GHOST_FILL_LOCS    = [0, 0.55, 1] as const;
const GHOST_RIM          = 'rgba(255,255,255,0.22)';
const GHOST_RIM_PRESSED  = 'rgba(255,255,255,0.34)';
const GHOST_BORDER_PRESS = 'rgba(255,255,255,0.40)'; // = Card's BORDER_PRESS
const GHOST_CONTACT_SHADOW = Platform.select<ViewStyle>({
  ios: {
    shadowColor:   'rgba(0,0,0,0.35)',
    shadowRadius:  12,
    shadowOffset:  { width: 0, height: 4 },
    shadowOpacity: 1,
  },
  android: { elevation: 2 },
}) as ViewStyle;

// Gold-outline keeps its legacy press retones (brighter gold on press).
const GOLD_OUTLINE_BG_PRESS  = 'rgba(229,186,110,0.10)';

// ─── Component ────────────────────────────────────────────────────────────────

export function SecondaryButton({
  children,
  onPress,
  variant = 'outline',
  disabled = false,
  size,
  compact = false,
  leftIcon,
  style,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: SecondaryButtonProps) {
  const isGold = variant === 'gold-outline';
  const isCompact = (size ?? (compact ? 'compact' : 'default')) === 'compact';

  // ── Press state ──────────────────────────────────────────────────────────
  const pressProgress = useSharedValue(0); // 0 = rest, 1 = pressed

  // Gold-outline: legacy flat press (bg + border swap + scale 0.98).
  const goldAnimatedStyle = useAnimatedStyle(() => {
    const p = pressProgress.value;
    return {
      backgroundColor: p > 0 ? GOLD_OUTLINE_BG_PRESS : 'transparent',
      borderColor:     p > 0 ? tokens.color.goldBright : tokens.color.gold,
      transform:       [{ scale: 1 - 0.02 * p }],
    };
  });

  // Ghost (outline): border lifts to Card's press edge + scale 0.98. The fill
  // brightens via the pressed-gradient crossfade below.
  const ghostAnimatedStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      pressProgress.value, [0, 1], [tokens.color.luminousEdge, GHOST_BORDER_PRESS],
    ),
    transform: [{ scale: interpolate(pressProgress.value, [0, 1], [1, 0.98]) }],
  }));
  const ghostFillPressedAnim = useAnimatedStyle(() => ({
    opacity: pressProgress.value,
  }));
  const ghostRimAnim = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressProgress.value, [0, 1], [GHOST_RIM, GHOST_RIM_PRESSED],
    ),
  }));

  // ── Press handlers ───────────────────────────────────────────────────────

  function handlePressIn() {
    if (disabled) return;
    pressProgress.value = withTiming(1, { duration: QUICK_MS, easing: QUICK_EASING });
    haptic('buttonSecondary');
  }

  function handlePressOut() {
    if (disabled) return;
    pressProgress.value = withTiming(0, { duration: QUICK_MS, easing: QUICK_EASING });
  }

  // ── Resolved values ──────────────────────────────────────────────────────

  const labelColor = isGold ? tokens.color.gold : tokens.color.text;
  const height     = isCompact ? 44 : 52;
  const paddingH   = isCompact ? tokens.spacing.md : tokens.spacing.lg; // 16pt or 24pt

  const a11yLabel =
    accessibilityLabel ??
    (typeof children === 'string' ? children : undefined);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={a11yLabel}
      accessibilityHint={accessibilityHint}
      testID={testID}
      style={[
        styles.pressable,
        // Ghost carries a contact shadow (not a glow) so it stays attached to
        // the page over bright nebula bands. Gold-outline stays unlit.
        !isGold && !disabled && GHOST_CONTACT_SHADOW,
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.button,
          { height, paddingHorizontal: paddingH },
          isGold ? styles.goldOutlineBorder : styles.ghostBorder,
          disabled && styles.disabled,
          !disabled && (isGold ? goldAnimatedStyle : ghostAnimatedStyle),
        ]}
      >
        {!isGold && (
          <>
            {/* Fill: light-top gradient with a faint bottom bounce. */}
            <LinearGradient
              colors={GHOST_FILL}
              locations={GHOST_FILL_LOCS}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {!disabled && (
              <Animated.View
                style={[StyleSheet.absoluteFill, ghostFillPressedAnim]}
                pointerEvents="none"
              >
                <LinearGradient
                  colors={GHOST_FILL_PRESSED}
                  locations={GHOST_FILL_LOCS}
                  start={{ x: 0.5, y: 0 }}
                  end={{ x: 0.5, y: 1 }}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
              </Animated.View>
            )}
            {/* 1pt inner top rim. */}
            <Animated.View
              style={[
                styles.ghostRim,
                disabled ? { backgroundColor: GHOST_RIM } : ghostRimAnim,
              ]}
              pointerEvents="none"
            />
          </>
        )}
        {leftIcon && (
          <View style={[styles.iconWrap, { marginRight: tokens.spacing.xs }]}>
            {leftIcon}
          </View>
        )}
        <Text
          style={[styles.label, { color: labelColor }]}
          numberOfLines={1}
          maxFontSizeMultiplier={1.3}
        >
          {children}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  pressable: {
    borderRadius: tokens.radii.full,
    alignSelf:    'center',
  },

  button: {
    borderRadius:  tokens.radii.full,
    borderWidth:   1,
    overflow:      'hidden', // clips the gradient fill + rim to the pill shape
    flexDirection: 'row',
    alignItems:    'center',
    justifyContent:'center',
  },

  ghostBorder: {
    borderColor:     tokens.color.luminousEdge, // the card edge token (was ad-hoc 0.22)
    backgroundColor: 'transparent',
  },

  ghostRim: {
    position: 'absolute',
    top:      0,
    left:     1, // inset 1, inside the border
    right:    1,
    height:   1,
  },

  goldOutlineBorder: {
    borderColor:     tokens.color.gold,
    backgroundColor: 'transparent',
  },

  label: {
    ...tokens.type.buttonTracked,
  },

  iconWrap: {
    width:          16,
    height:         16,
    alignItems:     'center',
    justifyContent: 'center',
  },

  disabled: {
    opacity: 0.4,
  },
});
