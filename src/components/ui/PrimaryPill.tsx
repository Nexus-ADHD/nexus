import {
  Canvas,
  Path,
  Skia,
} from '@shopify/react-native-skia';
import { haptic } from '@/src/utils/haptics';
import React, { useEffect } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import tokens from '@/src/theme/tokens';
import { useReduceTransparency } from '@/hooks/use-reduce-transparency';
import { resolvePillMetrics, type PillSize } from './pill-metrics';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PrimaryPillProps = {
  children: React.ReactNode;
  onPress: () => void;
  leftIcon?: React.ReactNode;
  /**
   * 'opal' (default, owner pick 2026-08-06) — glass pill with the quieted
   * v2.1 iridescent bloom sweep. 'cream' / 'gold' are the legacy solid fills,
   * kept for existing call sites.
   */
  variant?: 'cream' | 'gold' | 'opal';
  size?: PillSize;
  /** Stretches the painted pill body to the container (drops the 200pt minWidth floor; outer + inner both fill width). */
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_MS       = tokens.motion.quick.duration; // 140ms
const QUICK_EASING   = Easing.bezier(0.4, 0, 0.2, 1);
const SPINNER_SIZE   = 18;
const SPINNER_STROKE = 2;

// Edge-case pressed/disabled values not represented in tokens.
// v3 stellar: cream-family pressed/disabled retones from warm cream to pure
// white (slightly dimmed for press state); gold-family retones to new
// brighter gold; void-tinted label disabled matches new cool void.
// FIXME(nex-56): no token equivalents — design review can add
// tokens.color.textPressed / tokens.color.textDisabled tints.
const CREAM_PRESSED  = '#EBEDF2'; // ~5% dimmed pure white, slight cool cast
const CREAM_DISABLED = 'rgba(255,255,255,0.25)';
const GOLD_DISABLED  = 'rgba(229,186,110,0.25)';
const LABEL_DISABLED = 'rgba(6,6,12,0.35)';

// ─── OPAL recipe (quieted v2.1 — source of truth: app/redesign/button-lab.tsx,
//     docs/design/explorations/2026-08-06-opal-button-study.md) ───────────────
// Dim gold → warm-gleam → teal horizontal bloom over BlurView 45 + surface
// tint. Hue does the work; luminance stays near the background. Non-token
// rgba values are local consts (no token equivalents).
const OPAL_SWEEP = [
  'rgba(229,186,110,0)',
  'rgba(229,186,110,0.11)',
  'rgba(255,246,230,0.20)',
  'rgba(255,250,240,0.28)', // warm gleam @50% — dim, not white-hot
  'rgba(214,247,251,0.17)',
  'rgba(95,224,234,0.10)',
  'rgba(95,224,234,0)',
] as const;
const OPAL_SWEEP_LOCS = [0, 0.18, 0.38, 0.5, 0.62, 0.82, 1] as const;
// Pressed: the gleam lifts slightly (+~0.05), geometry unchanged.
const OPAL_SWEEP_PRESSED = [
  'rgba(229,186,110,0)',
  'rgba(229,186,110,0.15)',
  'rgba(255,246,230,0.25)',
  'rgba(255,250,240,0.34)',
  'rgba(214,247,251,0.21)',
  'rgba(95,224,234,0.13)',
  'rgba(95,224,234,0)',
] as const;
const OPAL_SWEEP_PRESSED_LOCS = [0, 0.16, 0.37, 0.5, 0.63, 0.84, 1] as const;
// Disabled: same sweep drained to neutral gray, geometry untouched.
const OPAL_SWEEP_DISABLED = [
  'rgba(255,255,255,0)',
  'rgba(255,255,255,0.06)',
  'rgba(255,255,255,0.12)',
  'rgba(255,255,255,0.15)',
  'rgba(255,255,255,0.11)',
  'rgba(255,255,255,0.06)',
  'rgba(255,255,255,0)',
] as const;
// Quiet light: halo alphas well under the card's ambientGlow (0.28) so the
// button sits calm on the field.
const OPAL_HALO_WIDE = Platform.select<ViewStyle>({
  ios: {
    shadowColor:   'rgba(229,186,110,0.13)',
    shadowRadius:  28,
    shadowOffset:  { width: 0, height: 6 },
    shadowOpacity: 1,
  },
  android: { elevation: 4 },
}) as ViewStyle;
const OPAL_HALO_TIGHT = Platform.select<ViewStyle>({
  ios: {
    shadowColor:   'rgba(229,186,110,0.09)',
    shadowRadius:  8,
    shadowOffset:  { width: 0, height: 2 },
    shadowOpacity: 1,
  },
  android: { elevation: 2 },
}) as ViewStyle;
const HALO_OFF = Platform.select<ViewStyle>({
  ios:     { shadowOpacity: 0 },
  android: { elevation: 0 },
}) as ViewStyle;
const OPAL_BORDER_REST     = 'rgba(229,186,110,0.32)';
const OPAL_BORDER_PRESSED  = 'rgba(242,208,138,0.50)'; // goldBright @ 50%
const OPAL_BORDER_DISABLED = 'rgba(255,255,255,0.12)';
const OPAL_RIM             = 'rgba(255,255,255,0.18)';
const OPAL_RIM_PRESSED     = 'rgba(255,255,255,0.28)';
const OPAL_RIM_DISABLED    = 'rgba(255,255,255,0.10)';
const OPAL_FLOOR           = 'rgba(0,0,0,0.16)';
const OPAL_FLOOR_HEIGHT    = 16;
const OPAL_LABEL_DISABLED  = 'rgba(255,255,255,0.32)';
// Reduce Transparency base (mirrors Card): drop the BlurView, one opaque tint.
const OPAL_OPAQUE_TINT     = 'rgba(20,17,12,0.96)';
// Blur intensity shared with Card's BLUR_INTENSITY_DEFAULT — button and card
// frost at the identical rate.
const OPAL_BLUR_INTENSITY  = 45;

// ─── Spinner path (lazy singleton, created on first use) ─────────────────────
// Was a module-level `Skia.Path.Make()`, which throws at IMPORT time when the
// Skia JSI binding is unavailable — "Cannot read properties of undefined
// (reading 'Path')" (Sentry 7633369776) — taking down every screen that
// imports PrimaryPill, even non-spinner variants. Lazy creation confines the
// failure to the loading render path that genuinely needs Skia.

let spinnerPath: ReturnType<typeof Skia.Path.Make> | null = null;

function getSpinnerPath(): ReturnType<typeof Skia.Path.Make> {
  if (!spinnerPath) {
    const path = Skia.Path.Make();
    path.addArc(
      {
        x:      SPINNER_STROKE / 2,
        y:      SPINNER_STROKE / 2,
        width:  SPINNER_SIZE - SPINNER_STROKE,
        height: SPINNER_SIZE - SPINNER_STROKE,
      },
      -90,  // start at 12 o'clock
      270,  // 270° arc (3/4 circle, clockwise)
    );
    spinnerPath = path;
  }
  return spinnerPath;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PrimaryPill({
  children,
  onPress,
  leftIcon,
  variant = 'opal',
  size = 'default',
  fullWidth = false,
  disabled = false,
  loading = false,
  style,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: PrimaryPillProps) {
  const isDisabled = disabled || loading;
  const isOpal = variant === 'opal';
  const isCompact = size === 'compact';

  // Reduce Transparency (§17.4, mirrors Card): opal drops its BlurView and
  // paints a near-opaque tint so the cosmos doesn't bleed through. Treat
  // "not yet resolved" as opaque so an RT user never sees a one-frame blur
  // flash before the async read resolves.
  const { reduceTransparency, resolved } = useReduceTransparency();
  const opaque = !resolved || reduceTransparency;

  // ── Geometry ────────────────────────────────────────────────────────────
  const metrics = resolvePillMetrics(size, fullWidth);

  // ── Press state (background + scale) ────────────────────────────────────
  const pressProgress = useSharedValue(0); // 0 = rest, 1 = pressed

  const restBg    = variant === 'gold' ? tokens.color.gold     : tokens.color.text;
  const pressedBg = variant === 'gold' ? tokens.color.goldDeep : CREAM_PRESSED;

  // Solid variants (cream/gold): fill color + scale.
  const pillAnimStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(pressProgress.value, [0, 1], [restBg, pressedBg]),
    transform: [{ scale: interpolate(pressProgress.value, [0, 1], [1, 0.97]) }],
  }));

  // Opal: border brightens + scale (the glass catches more light on press).
  const opalAnimStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      pressProgress.value, [0, 1], [OPAL_BORDER_REST, OPAL_BORDER_PRESSED],
    ),
    transform: [{ scale: interpolate(pressProgress.value, [0, 1], [1, 0.97]) }],
  }));
  // Pressed sweep crossfades in over the rest sweep (same gradient, lifted).
  const opalSweepPressedAnim = useAnimatedStyle(() => ({
    opacity: pressProgress.value,
  }));
  const opalRimAnim = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressProgress.value, [0, 1], [OPAL_RIM, OPAL_RIM_PRESSED],
    ),
  }));

  // ── Spinner rotation ─────────────────────────────────────────────────────
  const rotAnim = useSharedValue(0);

  useEffect(() => {
    if (loading) {
      rotAnim.value = 0;
      rotAnim.value = withRepeat(
        withTiming(Math.PI * 2, { duration: 1100, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      cancelAnimation(rotAnim);
      rotAnim.value = 0;
    }
  }, [loading, rotAnim]);

  // Rotation string for Animated.View wrapping the static Canvas
  const spinnerRotateStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${(rotAnim.value / (Math.PI * 2)) * 360}deg` }],
  }));

  // ── Press handlers ───────────────────────────────────────────────────────

  function handlePressIn() {
    if (isDisabled) return;
    pressProgress.value = withTiming(1, { duration: QUICK_MS, easing: QUICK_EASING });
    haptic('buttonPrimary');
  }

  function handlePressOut() {
    if (isDisabled) return;
    pressProgress.value = withTiming(0, { duration: QUICK_MS, easing: QUICK_EASING });
  }

  // ── Platform shadows ─────────────────────────────────────────────────────

  // v3 stellar: shadows retoned to new gold (#E5BA6E) and pure white.
  // The white shadow on cream pills is now a luminous "starlight halo"
  // instead of warm-cream paper-glow. Opal carries the quieted v2.1 halo.
  const shadowStyle = Platform.select({
    ios: variant === 'gold'
      ? {
          shadowColor:   'rgba(229,186,110,0.18)',
          shadowRadius:  24,
          shadowOffset:  { width: 0, height: 0 },
          shadowOpacity: 1,
        }
      : variant === 'cream'
        ? {
            shadowColor:   'rgba(255,255,255,0.14)',
            shadowRadius:  20,
            shadowOffset:  { width: 0, height: 0 },
            shadowOpacity: 1,
          }
        : (OPAL_HALO_WIDE as ViewStyle),
    android: { elevation: 4 },
  });

  // ── Accessibility ────────────────────────────────────────────────────────

  const a11yLabel =
    accessibilityLabel ??
    (typeof children === 'string' ? children : undefined);

  // ── Render ───────────────────────────────────────────────────────────────

  const bgDisabled = variant === 'gold' ? GOLD_DISABLED : CREAM_DISABLED;

  const labelContent = loading ? (
    <Animated.View style={[styles.spinnerCanvas, spinnerRotateStyle]}>
      <Canvas style={styles.spinnerCanvas}>
        <Path
          path={getSpinnerPath()}
          color={isOpal ? tokens.color.text : tokens.color.textInverse}
          style="stroke"
          strokeWidth={SPINNER_STROKE}
          strokeCap="round"
        />
      </Canvas>
    </Animated.View>
  ) : (
    <>
      {leftIcon && (
        <View style={styles.iconWrap}>
          {leftIcon}
        </View>
      )}
      <Text
        style={[
          isCompact ? styles.labelCompact : styles.label,
          isOpal
            ? {
                color: isDisabled
                  ? OPAL_LABEL_DISABLED
                  : isCompact
                    ? tokens.color.gold // opal compact: tracked-caps in gold
                    : tokens.color.text,
              }
            : { color: isDisabled ? LABEL_DISABLED : tokens.color.textInverse },
        ]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
      >
        {children}
      </Text>
    </>
  );

  const metricsStyle: ViewStyle = {
    height: metrics.height,
    paddingHorizontal: metrics.paddingHorizontal,
    ...(metrics.minWidth ? { minWidth: metrics.minWidth } : null),
  };
  // fullWidth stretches the PAINTED body to the container, not just the
  // outer Pressable — visual body == touch target.
  const fillStyle: ViewStyle | null = metrics.fillWidth
    ? { alignSelf: 'stretch', width: '100%' }
    : null;

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={a11yLabel}
      accessibilityHint={accessibilityHint}
      testID={testID}
      style={[
        styles.pressable,
        metrics.fillWidth && styles.pressableFill,
        isOpal && isDisabled ? HALO_OFF : shadowStyle,
        style,
      ]}
    >
      {isOpal ? (
        // Opal layer stack (v2.1): outer Pressable (wide halo, no clip)
        // → middle View (tight halo) → inner Animated.View (clipped, 1px
        // border) → blur → surface tint → sweep → rim → floor → label.
        <View style={[styles.opalMiddle, fillStyle, isDisabled && HALO_OFF]}>
          <Animated.View
            style={[
              styles.pill,
              styles.opalInner,
              metricsStyle,
              fillStyle,
              isDisabled
                ? { borderColor: OPAL_BORDER_DISABLED }
                : opalAnimStyle,
            ]}
          >
            {/* Render budget (§10.4 addendum): compact pills in long lists
                skip the BlurView entirely — each one is a live
                UIVisualEffectView. The plain surface tint stays (NOT the
                opaque RT tint); rim/floor/sweep unchanged. */}
            {!opaque && !isCompact && (
              <BlurView
                intensity={OPAL_BLUR_INTENSITY}
                tint="dark"
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
            )}
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: opaque ? OPAL_OPAQUE_TINT : tokens.color.surface },
              ]}
              pointerEvents="none"
            />
            <LinearGradient
              colors={isDisabled ? OPAL_SWEEP_DISABLED : OPAL_SWEEP}
              locations={OPAL_SWEEP_LOCS}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {!isDisabled && (
              <Animated.View
                style={[StyleSheet.absoluteFill, opalSweepPressedAnim]}
                pointerEvents="none"
              >
                <LinearGradient
                  colors={OPAL_SWEEP_PRESSED}
                  locations={OPAL_SWEEP_PRESSED_LOCS}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
              </Animated.View>
            )}
            <Animated.View
              style={[
                styles.opalRim,
                isDisabled ? { backgroundColor: OPAL_RIM_DISABLED } : opalRimAnim,
              ]}
              pointerEvents="none"
            />
            <LinearGradient
              colors={['transparent', OPAL_FLOOR]}
              locations={[0, 1]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.opalFloor}
              pointerEvents="none"
            />
            {labelContent}
          </Animated.View>
        </View>
      ) : (
        <Animated.View
          style={[
            styles.pill,
            metricsStyle,
            fillStyle,
            isDisabled
              ? { backgroundColor: bgDisabled }
              : pillAnimStyle,
          ]}
        >
          {labelContent}
        </Animated.View>
      )}
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  pressable: {
    borderRadius: tokens.radii.full,
    alignSelf:    'center',
  },

  pressableFill: {
    alignSelf: 'stretch',
  },

  pill: {
    borderRadius:      tokens.radii.full,
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
  },

  // Opal middle wrapper: carries the tight halo, must not clip.
  opalMiddle: {
    borderRadius: tokens.radii.full,
    ...OPAL_HALO_TIGHT,
  },

  // Opal inner body: clips the glass layers to the pill shape.
  opalInner: {
    borderWidth: 1,
    overflow:    'hidden',
  },

  opalRim: {
    position: 'absolute',
    top:      0,
    left:     1, // inset 1, inside the border
    right:    1,
    height:   1,
  },

  opalFloor: {
    position: 'absolute',
    left:     0,
    right:    0,
    bottom:   0,
    height:   OPAL_FLOOR_HEIGHT,
  },

  label: {
    ...tokens.type.buttonPrimary,
  },

  labelCompact: {
    ...tokens.type.buttonTracked,
  },

  iconWrap: {
    width:       18,
    height:      18,
    alignItems:  'center',
    justifyContent: 'center',
    marginRight: tokens.spacing.xs, // 8pt
  },

  spinnerCanvas: {
    width:  SPINNER_SIZE,
    height: SPINNER_SIZE,
  },
});
